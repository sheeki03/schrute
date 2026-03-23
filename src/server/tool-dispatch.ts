import { getLogger } from '../core/logger.js';
import { getSitePolicy, checkCapability } from '../core/policy.js';
import type { Engine } from '../core/engine.js';
import type { SkillRepository } from '../storage/skill-repository.js';
import type { SiteRepository } from '../storage/site-repository.js';
import type { ConfirmationManager } from './confirmation.js';
import type { SkillSpec, SchruteConfig, ProxyConfig, GeoEmulationConfig } from '../skill/types.js';
import type { ContextOverrides } from '../browser/manager.js';
import { DEFAULT_SESSION_NAME } from '../browser/multi-session.js';
import {
  Capability,
  SkillStatus,
  ALLOWED_BROWSER_TOOLS,
  BLOCKED_BROWSER_TOOLS,
} from '../skill/types.js';
import { getSkillExecutability, shouldAutoConfirm, searchAndProjectSkills } from './skill-helpers.js';
import { dryRun } from '../replay/dry-run.js';
import {
  rankToolsByIntent,
  skillToToolName,
  skillToToolDefinition,
  getBrowserToolDefinitions,
  META_TOOLS,
} from './tool-registry.js';
import { createRouter } from './router.js';
import type { Router } from './router.js';
import { sanitizeSiteId } from '../core/utils.js';
import { setupCdpSitePolicy, validateProxyConfig, validateGeoConfig } from './shared-validation.js';
import { isAdminCaller } from '../shared/admin-auth.js';
import { getShapedStatus } from './status-response.js';
import { validateImportableSkill } from '../storage/import-validator.js';

const log = getLogger();

// Admin-only tool names — used in both buildToolList() and dispatchToolCall()
const ADMIN_ONLY_TOOL_NAMES = new Set([
  'schrute_explore', 'schrute_record', 'schrute_stop', 'schrute_pipeline_status',
  'schrute_import_cookies', 'schrute_export_cookies',
  'schrute_connect_cdp', 'schrute_recover_explore', 'schrute_webmcp_call',
  'schrute_delete_skill', 'schrute_set_transform', 'schrute_export_skill', 'schrute_create_workflow',
]);

// ─── Shared Dependencies ────────────────────────────────────────

export interface ToolDispatchDeps {
  engine: Engine;
  skillRepo: SkillRepository;
  siteRepo: SiteRepository;
  confirmation: ConfirmationManager;
  config: SchruteConfig;
  router?: Router;
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
 * Build the list of available MCP tools, including active learned skills.
 *
 * In multi-user mode, dynamic skill tools are still admin-scoped so non-admin
 * callers discover skills via schrute_search_skills and invoke them via
 * schrute_execute.
 */
export function buildToolList(deps: ToolDispatchDeps, callerId?: string): ToolDefinition[] {
  const { engine, skillRepo, config } = deps;
  const isAdmin = isAdminCaller(callerId, config);

  // Slim mode: expose minimal tool surface
  if (config.slimMode) {
    return META_TOOLS.filter(t => ['schrute_execute', 'schrute_search_skills', 'schrute_status'].includes(t.name)) as unknown as ToolDefinition[];
  }

  const tools: ToolDefinition[] = [];

  // 1. Meta tools — filter admin-only in multi-user mode
  if (isAdmin) {
    tools.push(...META_TOOLS.filter(t => t.name !== 'schrute_recover_explore' || !config.server.network));
  } else {
    tools.push(...META_TOOLS.filter(t => !ADMIN_ONLY_TOOL_NAMES.has(t.name)));
  }

  // 2. Browser tools — admin-only in multi-user mode
  if (isAdmin) {
    tools.push(...getBrowserToolDefinitions());
  }

  // 3. Dynamic skill tools — admin only in multi-user mode.
  if (isAdmin) {
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
      tools.push(skillToToolDefinition(skill, { maxDescriptionLength: 200 }));
    }
  }

  return tools;
}

// ─── Shared Skill Execution Helper ──────────────────────────────

async function executeSkillWithGating(
  skill: SkillSpec,
  params: Record<string, unknown>,
  deps: ToolDispatchDeps,
  callerId?: string,
  options?: { skipMetrics?: boolean },
): Promise<ToolResult> {
  const { engine, confirmation } = deps;

  // Check skill is active
  if (skill.status !== SkillStatus.ACTIVE) {
    const hint = skill.status === SkillStatus.DRAFT || skill.status === SkillStatus.BROKEN
      ? ' Use schrute_activate to manually activate it first.'
      : '';
    return {
      content: [{ type: 'text', text: `Error: skill '${skill.id}' is not active (status: ${skill.status}).${hint}` }],
      isError: true,
    };
  }

  // P2-8: Auto-confirm read-only GET/HEAD skills
  const autoConfirm = shouldAutoConfirm(skill);

  // Confirmation gate
  const needsConfirmation = !autoConfirm && !confirmation.isSkillConfirmed(skill.id);
  if (needsConfirmation) {
    const token = await confirmation.generateToken(
      skill.id,
      params,
      skill.currentTier,
    );
    return {
      isError: true,
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'confirmation_required',
          message: 'Call schrute_confirm with the token below.',
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

  // Execute with callerId for per-user rate limiting
  const result = await engine.executeSkill(skill.id, params, callerId, options);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result, null, 2),
    }],
    ...(result.success === false && result.status !== 'browser_handoff_required' ? { isError: true } : {}),
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
  callerId?: string,
): Promise<ToolResult> {
  const { engine, skillRepo, siteRepo, confirmation, config } = deps;

  // Use injected router if available, otherwise create one (fallback for tests / direct callers)
  const router = deps.router ?? createRouter({ engine, skillRepo, siteRepo, config, confirmation });

  try {
    // ─── Admin Gate ──────────────────────────────────────────
    // In multi-user mode, admin-only tools are restricted to trusted callers (CLI/daemon)
    if (ADMIN_ONLY_TOOL_NAMES.has(toolName) && !isAdminCaller(callerId, config)) {
      return {
        content: [{ type: 'text', text: 'Error: This operation is only available to admin clients (CLI/daemon). Use schrute_execute to run skills.' }],
        isError: true,
      };
    }

    // ─── Meta Tools ────────────────────────────────────────
    switch (toolName) {
      case 'schrute_explore': {
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

      case 'schrute_record': {
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

      case 'schrute_stop': {
        const result = await router.stopRecording();
        if (!result.success) {
          return { content: [{ type: 'text', text: result.error ?? 'Stop recording failed' }], isError: true };
        }
        return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
      }

      case 'schrute_pipeline_status': {
        const jobId = args?.jobId as string | undefined;
        if (!jobId) {
          return { content: [{ type: 'text', text: 'Error: jobId is required' }], isError: true };
        }
        const result = router.getPipelineStatus(jobId);
        if (!result.success) {
          return { content: [{ type: 'text', text: result.error ?? 'Pipeline status failed' }], isError: true };
        }
        return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
      }

      case 'schrute_sites': {
        const result = router.listSites();
        return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
      }

      case 'schrute_skills': {
        const siteId = args?.siteId as string | undefined;
        const allSkills: SkillSpec[] = siteId
          ? skillRepo.getBySiteId(siteId)
          : skillRepo.getAll();
        const browserManager = engine.getSessionManager().getBrowserManager();
        const metricsRepoSkills = engine.getMetricsRepo();
        const sites: Record<string, { count: number; skills: Array<Record<string, unknown>> }> = {};
        for (const s of allSkills) {
          if (!sites[s.siteId]) {
            sites[s.siteId] = { count: 0, skills: [] };
          }
          const execInfo = getSkillExecutability(s, browserManager);
          const skillEntry: Record<string, unknown> = {
            id: s.id,
            name: s.name,
            status: s.status,
            method: s.method,
            pathTemplate: s.pathTemplate,
            successRate: s.successRate,
            currentTier: s.currentTier,
            executable: execInfo.executable,
            ...(execInfo.blockedReason ? { blockedReason: execInfo.blockedReason } : {}),
          };
          // Include lastFailureReason for broken skills
          if (s.status === SkillStatus.BROKEN) {
            const recentMetrics = metricsRepoSkills.getRecentBySkillId(s.id, 5);
            const lastFailure = recentMetrics.find(m => !m.success);
            if (lastFailure?.errorType) {
              skillEntry.lastFailureReason = lastFailure.errorType;
            }
          }
          sites[s.siteId].count++;
          sites[s.siteId].skills.push(skillEntry);
        }
        const grouped = { totalSkills: allSkills.length, sites };
        return { content: [{ type: 'text', text: JSON.stringify(grouped, null, 2) }] };
      }

      case 'schrute_status': {
        const statusData = await getShapedStatus(engine, config, callerId);
        return { content: [{ type: 'text', text: JSON.stringify(statusData, null, 2) }] };
      }

      case 'schrute_dry_run': {
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

      case 'schrute_set_transform': {
        const skillId = args?.skillId as string;
        if (!skillId) {
          return { content: [{ type: 'text', text: 'Error: skillId is required' }], isError: true };
        }
        const skill = skillRepo.getById(skillId);
        if (!skill) {
          return { content: [{ type: 'text', text: `Error: skill '${skillId}' not found` }], isError: true };
        }

        const clear = args?.clear === true;
        const transform = args?.transform;
        const responseContentType = args?.responseContentType as string | undefined;

        if (clear && transform !== undefined) {
          return { content: [{ type: 'text', text: 'Error: clear cannot be combined with transform' }], isError: true };
        }
        if (!clear && transform === undefined && responseContentType === undefined) {
          return { content: [{ type: 'text', text: 'Error: provide transform, responseContentType, or clear=true' }], isError: true };
        }

        const candidate: SkillSpec = {
          ...skill,
          ...(clear ? { outputTransform: undefined } : {}),
          ...(transform !== undefined ? { outputTransform: transform as SkillSpec['outputTransform'] } : {}),
          ...(responseContentType !== undefined ? { responseContentType } : {}),
        };
        const validation = validateImportableSkill(candidate);
        if (!validation.valid) {
          return { content: [{ type: 'text', text: `Error: ${validation.errors.join('; ')}` }], isError: true };
        }

        skillRepo.update(skill.id, {
          ...(clear ? { outputTransform: null as unknown as SkillSpec['outputTransform'] } : {}),
          ...(transform !== undefined ? { outputTransform: transform as SkillSpec['outputTransform'] } : {}),
          ...(responseContentType !== undefined ? { responseContentType } : {}),
        });

        const updated = skillRepo.getById(skill.id);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              updated: true,
              skillId: skill.id,
              outputTransform: updated?.outputTransform,
              responseContentType: updated?.responseContentType,
            }, null, 2),
          }],
        };
      }

      case 'schrute_export_skill': {
        const skillId = args?.skillId as string;
        const format = args?.format as 'curl' | 'fetch.ts' | 'requests.py' | 'playwright.ts';
        if (!skillId) {
          return { content: [{ type: 'text', text: 'Error: skillId is required' }], isError: true };
        }
        if (!format || !['curl', 'fetch.ts', 'requests.py', 'playwright.ts'].includes(format)) {
          return { content: [{ type: 'text', text: 'Error: format must be one of curl, fetch.ts, requests.py, playwright.ts' }], isError: true };
        }
        const skill = skillRepo.getById(skillId);
        if (!skill) {
          return { content: [{ type: 'text', text: `Error: skill '${skillId}' not found` }], isError: true };
        }
        const { generateExport } = await import('../skill/generator.js');
        const code = generateExport(skill, format, (args?.params ?? undefined) as Record<string, unknown> | undefined);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ skillId, format, code }, null, 2),
          }],
        };
      }

      case 'schrute_create_workflow': {
        const siteId = args?.siteId as string;
        const name = args?.name as string;
        const workflowSpec = args?.workflowSpec as SkillSpec['workflowSpec'];
        const description = args?.description as string | undefined;
        const outputTransform = args?.outputTransform as SkillSpec['outputTransform'];

        if (!siteId || !name || !workflowSpec) {
          return { content: [{ type: 'text', text: 'Error: siteId, name, and workflowSpec are required' }], isError: true };
        }
        if (!siteRepo.getById(siteId)) {
          return { content: [{ type: 'text', text: `Error: site '${siteId}' not found` }], isError: true };
        }

        const { generateWorkflowSkill } = await import('../skill/generator.js');
        const workflowSkill = generateWorkflowSkill(siteId, name, workflowSpec, {
          description,
          outputTransform,
        });

        if (skillRepo.getById(workflowSkill.id)) {
          return { content: [{ type: 'text', text: `Error: skill '${workflowSkill.id}' already exists` }], isError: true };
        }

        const validation = validateImportableSkill(workflowSkill);
        if (!validation.valid) {
          return { content: [{ type: 'text', text: `Error: ${validation.errors.join('; ')}` }], isError: true };
        }

        skillRepo.create(workflowSkill);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              created: true,
              skillId: workflowSkill.id,
              status: workflowSkill.status,
              workflowSpec: workflowSkill.workflowSpec,
            }, null, 2),
          }],
        };
      }

      case 'schrute_confirm': {
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

      case 'schrute_execute': {
        const skillId = args?.skillId as string;
        if (!skillId) {
          return { content: [{ type: 'text', text: 'Error: skillId is required' }], isError: true };
        }
        const skill = skillRepo.getById(skillId);
        if (!skill) {
          return { content: [{ type: 'text', text: `Error: skill '${skillId}' not found` }], isError: true };
        }
        const params = (args?.params ?? {}) as Record<string, unknown>;
        const testMode = args?.testMode === true;
        return executeSkillWithGating(skill, params, deps, callerId, { skipMetrics: testMode });
      }

      case 'schrute_activate': {
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

      case 'schrute_revoke': {
        const skillId = args?.skillId as string;
        if (!skillId) return { content: [{ type: 'text', text: 'Error: skillId is required' }], isError: true };
        const skill = skillRepo.getById(skillId);
        if (!skill) return { content: [{ type: 'text', text: `Error: skill '${skillId}' not found` }], isError: true };
        confirmation.revokeApproval(skillId);
        return { content: [{ type: 'text', text: JSON.stringify({ revoked: true, skillId, message: 'Approval revoked. Next execution will require confirmation.' }, null, 2) }] };
      }

      case 'schrute_delete_skill': {
        const skillId = args?.skillId as string;
        if (!skillId) {
          return { content: [{ type: 'text', text: 'Error: skillId is required' }], isError: true };
        }
        const skill = skillRepo.getById(skillId);
        if (!skill) {
          return { content: [{ type: 'text', text: `Error: skill '${skillId}' not found` }], isError: true };
        }
        skillRepo.delete(skillId);
        return { content: [{ type: 'text', text: JSON.stringify({ deleted: true, skillId, name: skill.name }) }] };
      }

      case 'schrute_amendments': {
        const skillId = args?.skillId as string;
        if (!skillId) {
          return { content: [{ type: 'text', text: 'Error: skillId is required' }], isError: true };
        }
        const amendmentRepo = engine.getAmendmentRepo();
        if (!amendmentRepo) {
          return { content: [{ type: 'text', text: 'Amendment tracking not available' }], isError: true };
        }
        const amendments = amendmentRepo.getBySkillId(skillId);
        const parsed = amendments.map(a => {
          let snapshotFields: unknown = (a as unknown as Record<string, unknown>).snapshotFields;
          if (typeof snapshotFields === 'string') {
            try { snapshotFields = JSON.parse(snapshotFields); } catch { /* keep raw string */ }
          }
          return { ...a, snapshotFields };
        });
        return { content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }] };
      }

      case 'schrute_optimize': {
        const skillId = args?.skillId as string;
        if (!skillId) {
          return { content: [{ type: 'text', text: 'Error: skillId is required' }], isError: true };
        }
        const skill = skillRepo.getById(skillId);
        if (!skill) {
          return { content: [{ type: 'text', text: `Error: skill '${skillId}' not found` }], isError: true };
        }
        const { GepaEngine } = await import('../healing/gepa.js');
        const optimizeAmendmentRepo = engine.getAmendmentRepo();
        const optimizeExemplarRepo = engine.getExemplarRepo();
        if (!optimizeAmendmentRepo) {
          return { content: [{ type: 'text', text: 'Error: Amendment tracking not available' }], isError: true };
        }
        const { AmendmentEngine } = await import('../healing/amendment.js');
        const optimizeMetricsRepo = engine.getMetricsRepo();
        const amendmentEngine = new AmendmentEngine(optimizeAmendmentRepo, skillRepo, optimizeMetricsRepo);
        const gepa = new GepaEngine(skillRepo, optimizeAmendmentRepo, optimizeExemplarRepo, amendmentEngine);
        const result = await gepa.optimize(skillId);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'schrute_search_skills': {
        const query = args?.query as string | undefined;
        const limit = (args?.limit as number) ?? 10;
        const siteId = args?.siteId as string | undefined;
        const includeInactive = args?.includeInactive as boolean | undefined;
        const browserManagerSearch = engine.getSessionManager().getBrowserManager();

        const response = searchAndProjectSkills(skillRepo, browserManagerSearch, {
          query, siteId, limit, includeInactive: includeInactive ?? false,
        });

        return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
      }

      case 'schrute_doctor': {
        // Full doctor runs comprehensive checks (browser, keychain, TLS, WAL) — admin only
        if (args?.full === true) {
          if (!isAdminCaller(callerId, config)) {
            return { content: [{ type: 'text', text: 'Error: Full diagnostic checks require admin access.' }], isError: true };
          }
          const { runDoctor } = await import('../doctor.js');
          const report = await runDoctor(config);
          return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
        }

        // Lightweight diagnostics for all callers
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

      case 'schrute_export_cookies': {
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
      case 'schrute_connect_cdp': {
        const rawCdpName = args?.name;
        if (!rawCdpName || typeof rawCdpName !== 'string') {
          return { content: [{ type: 'text', text: 'Error: name is required and must be a string' }], isError: true };
        }
        const name = rawCdpName;
        if (name === DEFAULT_SESSION_NAME) {
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

        // Parse tab selection args
        const rawTabUrl = args?.tabUrl;
        const tabUrl = typeof rawTabUrl === 'string' ? rawTabUrl : undefined;
        const rawTabTitle = args?.tabTitle;
        const tabTitle = typeof rawTabTitle === 'string' ? rawTabTitle : undefined;

        const multiSession = engine.getMultiSessionManager();

        // Step 1: Always connect under a throwaway synthetic ID so we never
        // clobber a real site's policy with setupCdpSitePolicy().
        const tmpSiteId = sanitizeSiteId(`cdp-tmp-${name}`);
        let policyPersisted = setupCdpSitePolicy(tmpSiteId, userDomains, config).persisted;

        let session;
        try {
          session = await multiSession.connectCDP(
            name, { port, wsEndpoint, host, autoDiscover }, tmpSiteId, callerId,
          );
        } catch (connectErr) {
          // Clean up temporary policy on failed connect
          (await import('../core/policy.js')).invalidatePolicyCache(tmpSiteId, config);
          try {
            const { getDatabase } = await import('../storage/database.js');
            getDatabase(config).run('DELETE FROM policies WHERE site_id = ?', tmpSiteId);
          } catch { /* best effort */ }
          throw connectErr;
        }

        // Step 2: Determine the final siteId:
        //   - If user provided explicit siteId, use it
        //   - Otherwise, derive from the browser's active page hostname
        //   - Last resort: keep the synthetic ID
        let finalSiteId = userSiteId ? sanitizeSiteId(userSiteId) : tmpSiteId;
        try {
          const bm = session.browserManager;
          const browser = bm.getBrowser();
          if (browser) {
            let targetPage: { url(): string; title(): Promise<string> } | undefined;
            for (const ctx of browser.contexts()) {
              for (const page of ctx.pages()) {
                const pageUrl = page.url();
                const pageTitle = await page.title();
                if (tabUrl && pageUrl.startsWith(tabUrl)) {
                  targetPage = page;
                  bm.selectPage(session.siteId, pageUrl);
                  break;
                }
                if (tabTitle && pageTitle.includes(tabTitle)) {
                  targetPage = page;
                  bm.selectPage(session.siteId, pageUrl);
                  break;
                }
                if (!targetPage && pageUrl !== 'about:blank') {
                  targetPage = page;
                }
              }
              if (targetPage) break;
            }
            if (targetPage && !userSiteId) {
              const pageUrl = targetPage.url();
              if (pageUrl && pageUrl !== 'about:blank') {
                try {
                  const derivedHost = new URL(pageUrl).hostname;
                  if (derivedHost) finalSiteId = sanitizeSiteId(derivedHost);
                } catch { /* keep current */ }
              }
            }
          }
        } catch (err) {
          log.debug({ err }, 'Tab inspection during CDP connect failed (non-blocking)');
        }

        // Step 3: Capture the REAL site's pre-connect policy (before any overlay)
        const { mergeSitePolicy, invalidatePolicyCache, sanitizeImplicitAllowlist } = await import('../core/policy.js');
        const priorPolicy = getSitePolicy(finalSiteId, config);
        const priorSnapshot: Record<string, unknown> = {
          domainAllowlist: priorPolicy.domainAllowlist,
          executionBackend: priorPolicy.executionBackend,
          executionSessionName: priorPolicy.executionSessionName,
        };

        // Step 4: Overlay CDP-specific fields onto the real site's policy
        const mergeResult = mergeSitePolicy(finalSiteId, {
          domainAllowlist: [...new Set([
            ...priorPolicy.domainAllowlist,
            '127.0.0.1', 'localhost', '[::1]',
            ...(userDomains ? sanitizeImplicitAllowlist(userDomains) : []),
          ])],
          executionBackend: 'live-chrome' as const,
          executionSessionName: name,
        }, config);
        if (!mergeResult.persisted) policyPersisted = false;
        session.cdpPriorPolicyState = priorSnapshot;

        // Step 5: Rebind from synthetic to final ID and clean up synthetic policy.
        // Only when we actually derived/selected a different ID — if the synthetic
        // ID IS the final ID (no page hostname found), it's the live session's policy.
        if (finalSiteId !== tmpSiteId) {
          multiSession.updateSiteId(name, finalSiteId);
          session.browserManager.rebindSiteId(tmpSiteId, finalSiteId);

          // Clean up temporary synthetic policy — cache AND database
          invalidatePolicyCache(tmpSiteId, config);
          try {
            const { getDatabase } = await import('../storage/database.js');
            const db = getDatabase(config);
            db.run('DELETE FROM policies WHERE site_id = ?', tmpSiteId);
          } catch (cleanupErr) {
            log.debug({ err: cleanupErr, tmpSiteId }, 'Failed to clean up temporary policy DB row');
          }
        }

        const finalPolicy = getSitePolicy(finalSiteId, config);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              session: name,
              siteId: finalSiteId,
              ...(!userSiteId && finalSiteId !== tmpSiteId ? { derivedFrom: 'active page URL' } : {}),
              status: 'connected',
              domains: finalPolicy.domainAllowlist,
              ...(!policyPersisted ? { warning: 'Policy applied in-memory but failed to persist to database' } : {}),
            }, null, 2),
          }],
        };
      }

      case 'schrute_recover_explore': {
        if (config.server.network) {
          return {
            content: [{ type: 'text', text: 'Error: Automatic Chrome handoff is only supported in local desktop mode. Use schrute_connect_cdp manually on the local machine.' }],
            isError: true,
          };
        }
        const resumeToken = args?.resumeToken as string | undefined;
        const waitMs = args?.waitMs as number | undefined;
        if (!resumeToken) {
          return { content: [{ type: 'text', text: 'Error: resumeToken is required' }], isError: true };
        }
        if (waitMs !== undefined && (!Number.isInteger(waitMs) || waitMs < 1000)) {
          return { content: [{ type: 'text', text: 'Error: waitMs must be an integer >= 1000' }], isError: true };
        }
        const result = await engine.recoverExplore(resumeToken, waitMs);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          ...(result.status === 'failed' ? { isError: true } : {}),
        };
      }

      case 'schrute_sessions': {
        const multiSession = engine.getMultiSessionManager();
        const sessions = multiSession.list(callerId, config, { includeInternal: false }).map(s => ({
          name: s.name,
          siteId: s.siteId,
          isCdp: s.isCdp,
          active: s.name === multiSession.getActive(),
        }));
        return { content: [{ type: 'text', text: JSON.stringify(sessions, null, 2) }] };
      }

      case 'schrute_close_session': {
        const name = args?.name as string;
        if (!name) {
          return { content: [{ type: 'text', text: 'Error: name is required' }], isError: true };
        }
        // Default session is admin-only in multi-user mode
        if (name === DEFAULT_SESSION_NAME && !isAdminCaller(callerId, config)) {
          return { content: [{ type: 'text', text: 'Error: Cannot close default session. Admin access required.' }], isError: true };
        }
        const rawForce = args?.force;
        if (rawForce !== undefined && typeof rawForce !== 'boolean') {
          return { content: [{ type: 'text', text: 'Error: force must be a boolean' }], isError: true };
        }
        const force = rawForce === true;
        const multiSession = engine.getMultiSessionManager();
        // Ownership check for non-default sessions
        multiSession.assertOwnership(name, callerId);
        const expectedId = name === DEFAULT_SESSION_NAME && force
          ? engine.getActiveSessionId()
          : null;
        await multiSession.close(name, { engineMode: engine.getMode(), force });
        if (name === DEFAULT_SESSION_NAME && force) {
          engine.resetExploreState(expectedId);
        }
        return { content: [{ type: 'text', text: JSON.stringify({ closed: name }) }] };
      }

      case 'schrute_switch_session': {
        const name = args?.name as string;
        if (!name) {
          return { content: [{ type: 'text', text: 'Error: name is required' }], isError: true };
        }
        // Default session switch is admin-only in multi-user mode
        if (name === DEFAULT_SESSION_NAME && !isAdminCaller(callerId, config)) {
          return { content: [{ type: 'text', text: 'Error: Cannot switch to default session. Admin access required.' }], isError: true };
        }
        const multiSession = engine.getMultiSessionManager();
        multiSession.setActive(name, config);
        return { content: [{ type: 'text', text: JSON.stringify({ active: name }) }] };
      }

      case 'schrute_import_cookies': {
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

      case 'schrute_webmcp_call': {
        if (!config.features.webmcp) {
          return { content: [{ type: 'text', text: 'WebMCP is disabled. Set features.webmcp=true to enable.' }], isError: true };
        }

        const msm = engine.getMultiSessionManager();
        const activeName = msm.getActive();
        const session = msm.get(activeName);
        if (!session) {
          return { content: [{ type: 'text', text: 'No active browser session. Use schrute_explore first.' }], isError: true };
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

          // Refresh WebMCP tools if requested
          if (args?.refresh === true) {
            const { refreshWebMcpTools } = await import('../discovery/webmcp-scanner.js');
            const diff = await refreshWebMcpTools(webmcpSiteId, adapter, db, currentOrigin);
            if (diff.added.length > 0 || diff.removed.length > 0) {
              const { notify, createEvent } = await import('../healing/notification.js');
              for (const t of diff.added) {
                await notify(createEvent('webmcp_tool_added', `webmcp:${t.name}`, webmcpSiteId, { toolName: t.name }), config);
              }
              for (const removedName of diff.removed) {
                await notify(createEvent('webmcp_tool_removed', `webmcp:${removedName}`, webmcpSiteId, { toolName: removedName }), config);
              }
            }
          }

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

      case 'schrute_list_tabs': {
        const msm = engine.getMultiSessionManager();
        const sessionName = (args?.session as string) || msm.getActive();
        const session = msm.get(sessionName);
        if (!session) return { content: [{ type: 'text', text: 'No active session' }], isError: true };
        const bm = session.browserManager;
        const browser = bm.getBrowser();
        if (!browser) return { content: [{ type: 'text', text: 'No browser connected' }], isError: true };
        const tabs: Array<{ url: string; title: string }> = [];
        for (const ctx of browser.contexts()) {
          for (const page of ctx.pages()) {
            tabs.push({ url: page.url(), title: await page.title() });
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify(tabs, null, 2) }] };
      }

      case 'schrute_select_tab': {
        const msm = engine.getMultiSessionManager();
        const sessionName = (args?.session as string) || msm.getActive();
        const tabUrl = args?.tabUrl as string | undefined;
        const tabTitle = args?.tabTitle as string | undefined;
        if (!tabUrl && !tabTitle) return { content: [{ type: 'text', text: 'Error: tabUrl or tabTitle required' }], isError: true };
        const session = msm.get(sessionName);
        if (!session) return { content: [{ type: 'text', text: 'Session not found' }], isError: true };
        const bm = session.browserManager;
        const browser = bm.getBrowser();
        if (!browser) return { content: [{ type: 'text', text: 'No browser connected' }], isError: true };
        for (const ctx of browser.contexts()) {
          for (const page of ctx.pages()) {
            const url = page.url();
            const title = await page.title();
            if ((tabUrl && url.startsWith(tabUrl)) || (tabTitle && title.includes(tabTitle))) {
              bm.selectPage(session.siteId, url);
              return { content: [{ type: 'text', text: JSON.stringify({ selected: url, title }) }] };
            }
          }
        }
        return { content: [{ type: 'text', text: 'No matching tab found' }], isError: true };
      }

      case 'schrute_webmcp_directory': {
        const query = args?.query as string | undefined;
        const { getDatabase } = await import('../storage/database.js');
        const db = getDatabase(config);
        const pattern = query ? `%${query}%` : '%';
        const rows = db.all<{ site_id: string; tool_name: string; description: string | null; last_verified: number }>(
          'SELECT site_id, tool_name, description, last_verified FROM webmcp_tools WHERE tool_name LIKE ? OR description LIKE ? ORDER BY last_verified DESC LIMIT 20',
          pattern, pattern,
        );
        return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
      }

      case 'schrute_capture_recent': {
        const captureName = args?.name as string;
        if (!captureName) return { content: [{ type: 'text', text: 'Error: name is required' }], isError: true };
        const minutes = Math.min((args?.minutes as number) ?? 5, 10);

        const msm = engine.getMultiSessionManager();
        const activeName = msm.getActive();
        const session = msm.get(activeName);
        if (!session) return { content: [{ type: 'text', text: 'No active session. Use schrute_explore first.' }], isError: true };

        const bm = session.browserManager;
        const ringBuffer = bm.getNetworkRingBuffer?.();
        if (!ringBuffer) {
          return { content: [{ type: 'text', text: 'No network history available. Network ring buffer requires a CDP-connected session.' }], isError: true };
        }

        const entries = ringBuffer.snapshot(minutes * 60 * 1000);
        if (entries.length === 0) {
          return { content: [{ type: 'text', text: JSON.stringify({ captured: 0, message: `No network activity in the last ${minutes} minutes` }) }] };
        }

        // Convert network entries to HAR format and feed into capture pipeline
        // For now, return a summary of captured entries
        const summary = entries.map(e => ({
          method: e.method,
          url: e.url,
          status: e.status,
        }));

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              captured: entries.length,
              name: captureName,
              minutes,
              entries: summary.slice(0, 20),
              note: entries.length > 20 ? `Showing 20 of ${entries.length} entries` : undefined,
            }, null, 2),
          }],
        };
      }

      case 'schrute_performance_trace': {
        const traceAction = args?.action as string;
        if (!traceAction || !['start', 'stop'].includes(traceAction)) {
          return { content: [{ type: 'text', text: 'Error: action must be "start" or "stop"' }], isError: true };
        }

        const msm = engine.getMultiSessionManager();
        const session = msm.get(msm.getActive());
        if (!session) return { content: [{ type: 'text', text: 'No active session' }], isError: true };
        if (!session.isCdp) return { content: [{ type: 'text', text: 'Performance tracing requires a CDP-connected session. Use schrute_connect_cdp first.' }], isError: true };

        const bm = session.browserManager;
        const browser = bm.getBrowser();
        if (!browser) return { content: [{ type: 'text', text: 'No browser connected' }], isError: true };

        try {
          const cdpSession = await browser.contexts()[0]?.pages()[0]?.context()?.newCDPSession(browser.contexts()[0].pages()[0]);
          if (!cdpSession) return { content: [{ type: 'text', text: 'Failed to create CDP session for tracing' }], isError: true };

          if (traceAction === 'start') {
            await cdpSession.send('Tracing.start', {
              categories: '-*,devtools.timeline,v8.execute,disabled-by-default-devtools.timeline',
              transferMode: 'ReturnAsStream',
            });
            return { content: [{ type: 'text', text: JSON.stringify({ tracing: 'started', note: 'Use action: "stop" to end tracing and get results' }) }] };
          } else {
            await cdpSession.send('Tracing.end');
            return { content: [{ type: 'text', text: JSON.stringify({ tracing: 'stopped', note: 'Trace data captured via CDP Tracing domain' }) }] };
          }
        } catch (err) {
          return { content: [{ type: 'text', text: `Tracing error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      }

      case 'schrute_test_webmcp': {
        const testToolName = args?.toolName as string;
        if (!testToolName) return { content: [{ type: 'text', text: 'Error: toolName required' }], isError: true };
        const testArgs = (args?.testArgs ?? {}) as Record<string, unknown>;
        return dispatchToolCall('schrute_webmcp_call', { toolName: testToolName, args: testArgs }, deps, callerId);
      }

      case 'schrute_batch_execute': {
        const actions = args?.actions as Array<{ skillId: string; params?: Record<string, unknown> }>;
        if (!Array.isArray(actions) || actions.length === 0) {
          return { content: [{ type: 'text', text: 'Error: actions array required' }], isError: true };
        }
        if (actions.length > 50) {
          return { content: [{ type: 'text', text: 'Error: max 50 actions per batch' }], isError: true };
        }
        const results = await engine.executeBatch(actions, callerId);
        return { content: [{ type: 'text', text: JSON.stringify({ batch: true, count: results.length, results }, null, 2) }] };
      }
    }

    // ─── Browser Tool Proxy ────────────────────────────────
    if ((ALLOWED_BROWSER_TOOLS as readonly string[]).includes(toolName)) {
      // Admin gate: browser tools operate on the shared active session's browser context
      if (!isAdminCaller(callerId, config)) {
        return {
          content: [{ type: 'text', text: 'Error: Browser tools are only available to admin clients (CLI/daemon) in multi-user mode. Use schrute_execute to run skills.' }],
          isError: true,
        };
      }
      const multiSession = engine.getMultiSessionManager();

      // Determine session name
      let sessionName: string;
      const explicitSession = args?.session as string | undefined;

      // During recording, force default session
      if (engine.getMode() === 'recording') {
        sessionName = engine.getRecordingSessionName() ?? DEFAULT_SESSION_NAME;
      } else if (engine.getMode() === 'exploring') {
        sessionName = explicitSession ?? engine.getExploreSessionName();
      } else if (explicitSession) {
        sessionName = explicitSession;
      } else {
        sessionName = multiSession.getActive();
      }

      // Resolve session
      let session;
      if (explicitSession && sessionName !== DEFAULT_SESSION_NAME) {
        session = multiSession.get(sessionName);
        if (!session) {
          return {
            content: [{ type: 'text', text: `Error: Session '${sessionName}' not found. Use schrute_connect_cdp or schrute_explore to create it.` }],
            isError: true,
          };
        }
      } else {
        session = multiSession.getOrCreate(sessionName);
      }

      const siteId = session.siteId;
      if (!siteId) {
        return {
          content: [{ type: 'text', text: 'Error: Session has no siteId. Use schrute_explore or schrute_connect_cdp first.' }],
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

      // Snapshot auth after browser interaction (non-blocking)
      resolvedManager.snapshotAuth(siteId).catch(err =>
        log.debug({ err, siteId }, 'Auth snapshot after browser tool failed (non-blocking)')
      );

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
      return executeSkillWithGating(matchedSkill, params, deps, callerId);
    }

    // ─── Unknown Tool ─────────────────────────────────────
    // Check if it matches a non-active skill
    const allSkillsForLookup = skillRepo.getAll();
    const matchedInactive = allSkillsForLookup.find(s => skillToToolName(s) === toolName);
    if (matchedInactive) {
      return {
        content: [{
          type: 'text',
          text: `Skill '${matchedInactive.id}' is '${matchedInactive.status}' (not active). Use schrute_activate to reactivate.`,
        }],
        isError: true,
      };
    }

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
