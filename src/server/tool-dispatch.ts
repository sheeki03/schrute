import { getLogger } from '../core/logger.js';
import { getSitePolicy, checkCapability } from '../core/policy.js';
import type { Engine } from '../core/engine.js';
import type { SkillRepository } from '../storage/skill-repository.js';
import type { SiteRepository } from '../storage/site-repository.js';
import type { ConfirmationManager } from './confirmation.js';
import type { SkillSpec, OneAgentConfig, ProxyConfig, GeoEmulationConfig } from '../skill/types.js';
import type { ContextOverrides } from '../browser/manager.js';
import {
  Capability,
  SkillStatus,
  ALLOWED_BROWSER_TOOLS,
  BLOCKED_BROWSER_TOOLS,
} from '../skill/types.js';
import { dryRun } from '../replay/dry-run.js';
import {
  rankToolsByIntent,
  skillToToolName,
  skillToToolDefinition,
  getBrowserToolDefinitions,
  META_TOOLS,
} from './tool-registry.js';
import { createRouter } from './router.js';
import { sanitizeSiteId } from '../core/utils.js';
import { parseDomainEntries, setupCdpSitePolicy, validateProxyConfig, validateGeoConfig } from './shared-validation.js';

const log = getLogger();

// ─── Shared Dependencies ────────────────────────────────────────

export interface ToolDispatchDeps {
  engine: Engine;
  skillRepo: SkillRepository;
  siteRepo: SiteRepository;
  confirmation: ConfirmationManager;
  config: OneAgentConfig;
}

// ─── Tool Result Type ───────────────────────────────────────────

/**
 * Result returned from dispatching a tool call.
 * Compatible with the MCP SDK's CallToolResult (which uses an index signature).
 */
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

// ─── Tool Definition Type ───────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ─── Build Tool List ────────────────────────────────────────────

/**
 * Build the list of available MCP tools, including meta tools, browser tools,
 * and active skill tools (ranked and shortlisted).
 */
export function buildToolList(deps: ToolDispatchDeps): ToolDefinition[] {
  const { engine, skillRepo, config } = deps;

  const tools: ToolDefinition[] = [];

  // 1. Meta tools
  tools.push(...META_TOOLS);

  // 2. Browser tools (allowlisted)
  tools.push(...getBrowserToolDefinitions());

  // 3. Active skill tools — scoped to active named session's siteId
  const multiSession = engine.getMultiSessionManager();
  const activeName = multiSession.getActive();
  const activeNamed = multiSession.get(activeName);
  const activeSiteId = activeNamed?.siteId || undefined;

  const activeSkills = activeSiteId
    ? skillRepo.getActive(activeSiteId)
    : skillRepo.getByStatus(SkillStatus.ACTIVE);

  const shortlisted = rankToolsByIntent(
    activeSkills,
    undefined,
    config.toolShortlistK,
  );

  for (const skill of shortlisted) {
    tools.push(skillToToolDefinition(skill));
  }

  return tools;
}

// ─── Shared Skill Execution Helper ──────────────────────────────

async function executeSkillWithGating(
  skill: SkillSpec,
  params: Record<string, unknown>,
  deps: ToolDispatchDeps,
): Promise<ToolResult> {
  const { engine, confirmation } = deps;

  // Check skill is active
  if (skill.status !== SkillStatus.ACTIVE) {
    const hint = skill.status === SkillStatus.DRAFT
      ? ' Use oneagent_activate to manually activate it first.'
      : '';
    return {
      content: [{ type: 'text', text: `Error: skill '${skill.id}' is not active (status: ${skill.status}).${hint}` }],
      isError: true,
    };
  }

  // Confirmation gate
  const needsConfirmation = !confirmation.isSkillConfirmed(skill.id);
  if (needsConfirmation) {
    const token = await confirmation.generateToken(
      skill.id,
      params,
      skill.currentTier,
    );
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'confirmation_required',
          message: 'This skill has not been validated yet. Please confirm execution.',
          skillId: skill.id,
          confirmationToken: token.nonce,
          expiresAt: token.expiresAt,
          sideEffectClass: skill.sideEffectClass,
          method: skill.method,
          pathTemplate: skill.pathTemplate,
        }),
      }],
    };
  }

  // Execute
  const result = await engine.executeSkill(skill.id, params);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result, null, 2),
    }],
  };
}

// ─── Dispatch Tool Call ─────────────────────────────────────────

/**
 * Dispatch a tool call by name, routing to the appropriate handler.
 * Uses the router for core operations (explore, record, stop, sites, status,
 * confirm) to ensure consistent behavior across transports.
 */
export async function dispatchToolCall(
  toolName: string,
  args: Record<string, unknown> | undefined,
  deps: ToolDispatchDeps,
): Promise<ToolResult> {
  const { engine, skillRepo, siteRepo, confirmation, config } = deps;

  // Create the router for consistent routing
  const router = createRouter({ engine, skillRepo, siteRepo, config, confirmation });

  try {
    // ─── Meta Tools ────────────────────────────────────────
    switch (toolName) {
      case 'oneagent_explore': {
        const url = args?.url as string;
        if (!url) {
          return { content: [{ type: 'text', text: 'Error: url is required' }], isError: true };
        }

        // Extract and validate proxy overrides
        const rawProxy = args?.proxy;
        const rawGeo = args?.geo;

        let proxy: ProxyConfig | undefined;
        if (rawProxy !== undefined && rawProxy !== null) {
          if (typeof rawProxy !== 'object' || Array.isArray(rawProxy)) {
            return { content: [{ type: 'text', text: 'Error: proxy must be an object' }], isError: true };
          }
          try {
            proxy = validateProxyConfig(rawProxy);
          } catch (err) {
            return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
          }
        }

        let geo: GeoEmulationConfig | undefined;
        if (rawGeo !== undefined && rawGeo !== null) {
          if (typeof rawGeo !== 'object' || Array.isArray(rawGeo)) {
            return { content: [{ type: 'text', text: 'Error: geo must be an object' }], isError: true };
          }
          try {
            geo = validateGeoConfig(rawGeo);
          } catch (err) {
            return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
          }
        }

        const overrides: ContextOverrides | undefined = proxy || geo ? { proxy, geo } : undefined;
        const result = await router.explore(url, overrides);
        if (!result.success) {
          return { content: [{ type: 'text', text: result.error ?? 'Explore failed' }], isError: true };
        }
        return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
      }

      case 'oneagent_record': {
        const recordName = args?.name as string;
        if (!recordName) {
          return { content: [{ type: 'text', text: 'Error: name is required' }], isError: true };
        }
        const inputs = args?.inputs as Record<string, string> | undefined;
        const result = await router.startRecording(recordName, inputs);
        if (!result.success) {
          return { content: [{ type: 'text', text: result.error ?? 'Recording failed' }], isError: true };
        }
        return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
      }

      case 'oneagent_stop': {
        const result = await router.stopRecording();
        if (!result.success) {
          return { content: [{ type: 'text', text: result.error ?? 'Stop recording failed' }], isError: true };
        }
        return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
      }

      case 'oneagent_sites': {
        const result = router.listSites();
        return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
      }

      case 'oneagent_skills': {
        const siteId = args?.siteId as string | undefined;
        if (siteId) {
          const result = router.listSkills(siteId);
          return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
        }
        // List all skills grouped by site
        const allSkills: SkillSpec[] = skillRepo.getAll();
        const sites: Record<string, { count: number; skills: Array<Record<string, unknown>> }> = {};
        for (const s of allSkills) {
          if (!sites[s.siteId]) {
            sites[s.siteId] = { count: 0, skills: [] };
          }
          sites[s.siteId].count++;
          sites[s.siteId].skills.push({
            id: s.id,
            name: s.name,
            status: s.status,
            method: s.method,
            pathTemplate: s.pathTemplate,
            successRate: s.successRate,
            currentTier: s.currentTier,
          });
        }
        const grouped = { totalSkills: allSkills.length, sites };
        return { content: [{ type: 'text', text: JSON.stringify(grouped, null, 2) }] };
      }

      case 'oneagent_status': {
        const result = router.getStatus();

        // Add WebMCP status
        if (config.features.webmcp) {
          const multiSessionStatus = engine.getMultiSessionManager();
          const activeNameStatus = multiSessionStatus.getActive();
          const activeNamedStatus = multiSessionStatus.get(activeNameStatus);
          const activeSiteIdStatus = activeNamedStatus?.siteId;

          if (activeSiteIdStatus) {
            try {
              const { getDatabase } = await import('../storage/database.js');
              const { loadCachedTools } = await import('../discovery/webmcp-scanner.js');
              const db = getDatabase(config);

              // Derive origin from existing browser context (no lease, no context creation)
              let statusOrigin: string | undefined;
              if (activeNamedStatus) {
                const existingCtx = activeNamedStatus.browserManager.tryGetContext(activeSiteIdStatus);
                if (existingCtx) {
                  const pages = existingCtx.pages();
                  if (pages.length > 0) {
                    try { statusOrigin = new URL(pages[0].url()).origin; } catch { /* hostname fallback */ }
                  }
                }
              }

              const cachedTools = loadCachedTools(activeSiteIdStatus, db, statusOrigin);
              (result.data as Record<string, unknown>).webmcp = {
                enabled: true,
                toolCount: cachedTools.length,
                tools: cachedTools.map(t => t.name),
                note: cachedTools.length > 0 ? 'Tools cached by origin. Only tools on current page will execute.' : undefined,
              };
            } catch (err) {
              (result.data as Record<string, unknown>).webmcp = {
                enabled: true, toolCount: 0, tools: [],
                error: 'Failed to load WebMCP tools',
              };
            }
          } else {
            (result.data as Record<string, unknown>).webmcp = { enabled: true, toolCount: 0, tools: [] };
          }
        }

        return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
      }

      case 'oneagent_dry_run': {
        const skillId = args?.skillId as string;
        if (!skillId) {
          return { content: [{ type: 'text', text: 'Error: skillId is required' }], isError: true };
        }
        const skill = skillRepo.getById(skillId);
        if (!skill) {
          return { content: [{ type: 'text', text: `Error: skill '${skillId}' not found` }], isError: true };
        }
        const params = (args?.params ?? {}) as Record<string, unknown>;
        const mode = (args?.mode as string) === 'developer-debug' ? 'developer-debug' as const : 'agent-safe' as const;

        const preview = await dryRun(skill, params, mode);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ...preview,
              note: 'This is a preview only. No request was sent.',
            }, null, 2),
          }],
        };
      }

      case 'oneagent_confirm': {
        const confirmationToken = args?.confirmationToken as string;
        const approve = args?.approve as boolean;
        if (!confirmationToken) {
          return { content: [{ type: 'text', text: 'Error: confirmationToken is required' }], isError: true };
        }
        if (typeof approve !== 'boolean') {
          return { content: [{ type: 'text', text: 'Error: approve must be a boolean' }], isError: true };
        }
        const result = router.confirm(confirmationToken, approve);
        if (!result.success) {
          return { content: [{ type: 'text', text: result.error ?? 'Confirmation failed' }], isError: true };
        }
        return { content: [{ type: 'text', text: JSON.stringify(result.data) }] };
      }

      case 'oneagent_execute': {
        const skillId = args?.skillId as string;
        if (!skillId) {
          return { content: [{ type: 'text', text: 'Error: skillId is required' }], isError: true };
        }
        const skill = skillRepo.getById(skillId);
        if (!skill) {
          return { content: [{ type: 'text', text: `Error: skill '${skillId}' not found` }], isError: true };
        }
        const params = (args?.params ?? {}) as Record<string, unknown>;
        return executeSkillWithGating(skill, params, deps);
      }

      case 'oneagent_activate': {
        const skillId = args?.skillId as string;
        if (!skillId) return { content: [{ type: 'text', text: 'Error: skillId is required' }], isError: true };
        const skill = skillRepo.getById(skillId);
        if (!skill) return { content: [{ type: 'text', text: `Error: skill '${skillId}' not found` }], isError: true };
        const { forcePromote } = await import('../core/promotion.js');
        const result = forcePromote(skill);
        skillRepo.update(skill.id, {
          status: result.newStatus,
          updatedAt: result.timestamp,
          lastVerified: result.timestamp,
          confidence: 0.5,
        });
        return { content: [{ type: 'text', text: JSON.stringify({ activated: true, skillId: result.skillId, previousStatus: result.previousStatus, newStatus: result.newStatus, note: 'First execution will require confirmation.' }, null, 2) }] };
      }

      case 'oneagent_doctor': {
        const diagnostics: Record<string, unknown> = {};

        // Check engine status
        diagnostics.engine = engine.getStatus();

        // Check browser
        const bm = engine.getSessionManager().getBrowserManager();
        diagnostics.browser = {
          hasInstance: bm.getBrowser() !== null,
          isCdp: bm.isCdpConnected(),
          supportsHar: bm.supportsHarRecording(),
        };

        // Check sessions
        const multiSessionDoctor = engine.getMultiSessionManager();
        diagnostics.sessions = multiSessionDoctor.list().map(s => ({
          name: s.name,
          siteId: s.siteId,
          isCdp: s.isCdp,
        }));

        // Check skills
        const allDoctorSkills = skillRepo.getAll();
        diagnostics.skills = {
          total: allDoctorSkills.length,
          active: allDoctorSkills.filter(s => s.status === SkillStatus.ACTIVE).length,
          draft: allDoctorSkills.filter(s => s.status === SkillStatus.DRAFT).length,
        };

        return { content: [{ type: 'text', text: JSON.stringify({ diagnostics }, null, 2) }] };
      }

      case 'oneagent_export_cookies': {
        const exportSiteId = args?.siteId as string;
        if (!exportSiteId) {
          return { content: [{ type: 'text', text: 'Error: siteId is required' }], isError: true };
        }
        const sanitizedExportSiteId = sanitizeSiteId(exportSiteId);
        const browserManagerExport = engine.getSessionManager().getBrowserManager();
        const cookies = await browserManagerExport.exportCookies(sanitizedExportSiteId);
        return { content: [{ type: 'text', text: JSON.stringify({ cookies, count: cookies.length }, null, 2) }] };
      }
    }

    // ─── New Meta Tools (sessions, CDP, cookies) ───────────
    switch (toolName) {
      case 'oneagent_connect_cdp': {
        const rawCdpName = args?.name;
        if (!rawCdpName || typeof rawCdpName !== 'string') {
          return { content: [{ type: 'text', text: 'Error: name is required and must be a string' }], isError: true };
        }
        const name = rawCdpName;
        if (name === 'default') {
          return { content: [{ type: 'text', text: 'Error: Cannot use "default" for CDP sessions. The default session is reserved for launch-based browser automation.' }], isError: true };
        }

        const rawPort = args?.port;
        if (rawPort !== undefined && (typeof rawPort !== 'number' || !Number.isInteger(rawPort))) {
          return { content: [{ type: 'text', text: 'Error: port must be an integer' }], isError: true };
        }
        const port = rawPort as number | undefined;

        const rawWsEndpoint = args?.wsEndpoint;
        if (rawWsEndpoint !== undefined && typeof rawWsEndpoint !== 'string') {
          return { content: [{ type: 'text', text: 'Error: wsEndpoint must be a string' }], isError: true };
        }
        const wsEndpoint = rawWsEndpoint as string | undefined;

        const rawHost = args?.host;
        if (rawHost !== undefined && typeof rawHost !== 'string') {
          return { content: [{ type: 'text', text: 'Error: host must be a string' }], isError: true };
        }
        const host = rawHost as string | undefined;

        const rawUserSiteId = args?.siteId;
        if (rawUserSiteId !== undefined && typeof rawUserSiteId !== 'string') {
          return { content: [{ type: 'text', text: 'Error: siteId must be a string' }], isError: true };
        }
        const userSiteId = rawUserSiteId as string | undefined;

        const rawUserDomains = args?.domains;
        if (rawUserDomains !== undefined) {
          if (!Array.isArray(rawUserDomains)) {
            return { content: [{ type: 'text', text: 'Error: domains must be an array' }], isError: true };
          }
          if (!rawUserDomains.every((d: unknown) => typeof d === 'string')) {
            return { content: [{ type: 'text', text: 'Error: domains must be an array of strings' }], isError: true };
          }
        }
        const userDomains = rawUserDomains as string[] | undefined;

        const rawAutoDiscover = args?.autoDiscover;
        if (rawAutoDiscover !== undefined && typeof rawAutoDiscover !== 'boolean') {
          return { content: [{ type: 'text', text: 'Error: autoDiscover must be a boolean' }], isError: true };
        }
        const autoDiscover = rawAutoDiscover === true;

        const siteId = sanitizeSiteId(userSiteId ?? `cdp-${name}`);
        const multiSession = engine.getMultiSessionManager();

        // Validate/sanitize domains BEFORE creating the CDP session.
        // This prevents an orphaned session if domain validation throws.
        setupCdpSitePolicy(siteId, userDomains, config);

        const session = await multiSession.connectCDP(
          name, { port, wsEndpoint, host, autoDiscover }, siteId,
        );

        const policy = (await import('../core/policy.js')).getSitePolicy(siteId, config);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              session: name,
              siteId: session.siteId,
              status: 'connected',
              domains: policy.domainAllowlist,
            }, null, 2),
          }],
        };
      }

      case 'oneagent_sessions': {
        const multiSession = engine.getMultiSessionManager();
        const sessions = multiSession.list().map(s => ({
          name: s.name,
          siteId: s.siteId,
          isCdp: s.isCdp,
          active: s.name === multiSession.getActive(),
        }));
        return { content: [{ type: 'text', text: JSON.stringify(sessions, null, 2) }] };
      }

      case 'oneagent_close_session': {
        const name = args?.name as string;
        if (!name) {
          return { content: [{ type: 'text', text: 'Error: name is required' }], isError: true };
        }
        const rawForce = args?.force;
        if (rawForce !== undefined && typeof rawForce !== 'boolean') {
          return { content: [{ type: 'text', text: 'Error: force must be a boolean' }], isError: true };
        }
        const force = rawForce === true;
        const multiSession = engine.getMultiSessionManager();
        const expectedId = name === 'default' && force
          ? engine.getActiveSessionId()
          : null;
        await multiSession.close(name, { engineMode: engine.getStatus().mode, force });
        if (name === 'default' && force) {
          engine.resetExploreState(expectedId);
        }
        return { content: [{ type: 'text', text: JSON.stringify({ closed: name }) }] };
      }

      case 'oneagent_switch_session': {
        const name = args?.name as string;
        if (!name) {
          return { content: [{ type: 'text', text: 'Error: name is required' }], isError: true };
        }
        const multiSession = engine.getMultiSessionManager();
        multiSession.setActive(name);
        return { content: [{ type: 'text', text: JSON.stringify({ active: name }) }] };
      }

      case 'oneagent_import_cookies': {
        const siteId = args?.siteId as string;
        const cookieFile = args?.cookieFile as string;
        if (!siteId || !cookieFile) {
          return { content: [{ type: 'text', text: 'Error: siteId and cookieFile are required' }], isError: true };
        }
        const sanitizedSiteId = sanitizeSiteId(siteId);
        const browserManager = engine.getSessionManager().getBrowserManager();
        const count = await browserManager.importCookies(sanitizedSiteId, cookieFile);
        return { content: [{ type: 'text', text: JSON.stringify({ imported: count, siteId: sanitizedSiteId }) }] };
      }

      case 'oneagent_webmcp_call': {
        if (!config.features.webmcp) {
          return { content: [{ type: 'text', text: 'WebMCP is disabled. Set features.webmcp=true to enable.' }], isError: true };
        }

        const msm = engine.getMultiSessionManager();
        const activeName = msm.getActive();
        const session = msm.get(activeName);
        if (!session) {
          return { content: [{ type: 'text', text: 'No active browser session. Use oneagent_explore first.' }], isError: true };
        }
        const webmcpSiteId = session.siteId;

        const capCheck = checkCapability(webmcpSiteId, Capability.BROWSER_MODEL_CONTEXT, config);
        if (!capCheck.allowed) {
          return { content: [{ type: 'text', text: `WebMCP blocked: ${capCheck.reason}` }], isError: true };
        }

        const webmcpBrowserManager = session.browserManager;
        const webmcpResult = await webmcpBrowserManager.withLease(async () => {
          const policy = getSitePolicy(webmcpSiteId, config);
          const domains = policy.domainAllowlist.length > 0
            ? policy.domainAllowlist
            : [webmcpSiteId];
          const adapter = await engine.createBrowserProvider(webmcpSiteId, domains, {
            browserManager: webmcpBrowserManager,
            lazy: true,
            overrides: session.contextOverrides,
          });
          if (!adapter) {
            return { content: [{ type: 'text', text: 'Browser context not available' }], isError: true };
          }

          // Origin binding
          const currentUrl = adapter.getCurrentUrl();
          let parsed: URL;
          try {
            parsed = new URL(currentUrl);
          } catch {
            return {
              content: [{ type: 'text', text: `Cannot call WebMCP tools: page URL '${currentUrl}' is not a valid HTTP origin. Navigate to the target site first.` }],
              isError: true,
            };
          }
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return {
              content: [{ type: 'text', text: `Cannot call WebMCP tools: page protocol '${parsed.protocol}' is not HTTP(S). Navigate to the target site first.` }],
              isError: true,
            };
          }
          const currentHostname = parsed.hostname;
          if (currentHostname !== webmcpSiteId && !currentHostname.endsWith('.' + webmcpSiteId)) {
            return {
              content: [{ type: 'text', text: `Origin mismatch: page is on ${currentHostname} but session site is ${webmcpSiteId}. Navigate back to the correct site before calling WebMCP tools.` }],
              isError: true,
            };
          }

          const { getDatabase } = await import('../storage/database.js');
          const { loadCachedTools } = await import('../discovery/webmcp-scanner.js');
          const { executeWebMcpTool } = await import('../browser/webmcp-bridge.js');

          // Derive origin from live page URL for port-scoped enforcement
          const currentOrigin = parsed.origin;

          const db = getDatabase(config);
          const allowedTools = loadCachedTools(webmcpSiteId, db, currentOrigin);
          const toolName = args?.toolName;
          if (typeof toolName !== 'string' || toolName.length === 0) {
            return { content: [{ type: 'text', text: 'toolName is required and must be a non-empty string.' }], isError: true };
          }
          const toolArgs = (args?.args as Record<string, unknown>) ?? {};

          const bridgeResult = await executeWebMcpTool({ toolName, args: toolArgs }, adapter, allowedTools.map(t => t.name));
          if (bridgeResult.error) {
            return { content: [{ type: 'text', text: bridgeResult.error }], isError: true };
          }
          return { content: [{ type: 'text', text: typeof bridgeResult.result === 'string' ? bridgeResult.result : JSON.stringify(bridgeResult.result) }] };
        });
        return webmcpResult;
      }
    }

    // ─── Browser Tool Proxy ────────────────────────────────
    if ((ALLOWED_BROWSER_TOOLS as readonly string[]).includes(toolName)) {
      const multiSession = engine.getMultiSessionManager();

      // Determine session name
      let sessionName: string;
      const explicitSession = args?.session as string | undefined;

      // During recording, force default session
      if (engine.getStatus().mode === 'recording') {
        sessionName = 'default';
      } else if (explicitSession) {
        sessionName = explicitSession;
      } else {
        sessionName = multiSession.getActive();
      }

      // Resolve session
      let session;
      if (explicitSession && sessionName !== 'default') {
        session = multiSession.get(sessionName);
        if (!session) {
          return {
            content: [{ type: 'text', text: `Error: Session '${sessionName}' not found. Use oneagent_connect_cdp or oneagent_explore to create it.` }],
            isError: true,
          };
        }
      } else {
        session = multiSession.getOrCreate(sessionName);
      }

      const siteId = session.siteId;
      if (!siteId) {
        return {
          content: [{ type: 'text', text: 'Error: Session has no siteId. Use oneagent_explore or oneagent_connect_cdp first.' }],
          isError: true,
        };
      }

      const policy = getSitePolicy(siteId, config);
      const domains = policy.domainAllowlist.length > 0
        ? policy.domainAllowlist
        : [siteId];

      const resolvedManager = session.browserManager;

      // Lease wraps the ENTIRE provider creation + tool execution.
      // This prevents idle shutdown from closing the context/page between
      // getOrCreateContext() and proxyTool().
      const toolResult = await resolvedManager.withLease(async () => {
        const adapter = await engine.createBrowserProvider(siteId, domains, {
          browserManager: resolvedManager,
          lazy: true,
          overrides: session.contextOverrides,
        });

        if (!adapter) {
          throw new Error('Browser context not available for this session.');
        }

        return adapter.proxyTool(toolName, (args ?? {}) as Record<string, unknown>);
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(toolResult, null, 2),
        }],
      };
    }

    // ─── Blocked Browser Tools ─────────────────────────────
    if ((BLOCKED_BROWSER_TOOLS as readonly string[]).includes(toolName)) {
      return {
        content: [{
          type: 'text',
          text: `BLOCKED: Tool "${toolName}" is explicitly blocked for security.`,
        }],
        isError: true,
      };
    }

    // ─── Skill Execution ──────────────────────────────────
    const activeSkills = skillRepo.getByStatus(SkillStatus.ACTIVE);
    const matchedSkill = activeSkills.find(
      (s) => skillToToolName(s) === toolName,
    );

    if (matchedSkill) {
      const params = (args ?? {}) as Record<string, unknown>;
      return executeSkillWithGating(matchedSkill, params, deps);
    }

    // ─── Unknown Tool ─────────────────────────────────────
    return {
      content: [{
        type: 'text',
        text: `Unknown tool: ${toolName}`,
      }],
      isError: true,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ tool: toolName, err }, 'Tool execution error');
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
}
