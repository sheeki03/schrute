import { getLogger } from '../core/logger.js';
import { getSitePolicy } from '../core/policy.js';
import type { Engine } from '../core/engine.js';
import type { SkillRepository } from '../storage/skill-repository.js';
import type { SiteRepository } from '../storage/site-repository.js';
import { PlaywrightMcpAdapter } from '../browser/playwright-mcp-adapter.js';
import { getFlags } from '../browser/feature-flags.js';
import type { ConfirmationManager } from './confirmation.js';
import type { SkillSpec, OneAgentConfig } from '../skill/types.js';
import {
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
  const { skillRepo, config } = deps;

  const tools: ToolDefinition[] = [];

  // 1. Meta tools
  tools.push(...META_TOOLS);

  // 2. Browser tools (allowlisted)
  tools.push(...getBrowserToolDefinitions());

  // 3. Active skill tools
  const activeSkills = skillRepo.getByStatus(SkillStatus.ACTIVE);
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
        const result = await router.explore(url);
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
        // List all skills across sites
        const allSkills: SkillSpec[] = skillRepo.getAll();
        const summary = allSkills.map((s) => ({
          id: s.id,
          name: s.name,
          status: s.status,
          siteId: s.siteId,
          method: s.method,
          pathTemplate: s.pathTemplate,
          successRate: s.successRate,
          currentTier: s.currentTier,
        }));
        return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
      }

      case 'oneagent_status': {
        const result = router.getStatus();
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
    }

    // ─── Browser Tool Proxy ────────────────────────────────
    if ((ALLOWED_BROWSER_TOOLS as readonly string[]).includes(toolName)) {
      const status = engine.getStatus();
      if (!status.activeSession) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'No active browser session. Use oneagent_explore first.',
              tool: toolName,
            }),
          }],
          isError: true,
        };
      }

      const browserManager = engine.getSessionManager().getBrowserManager();
      const siteId = status.activeSession.siteId;

      if (!browserManager.hasContext(siteId)) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Browser context not available for this session.',
              tool: toolName,
            }),
          }],
          isError: true,
        };
      }

      const context = await browserManager.getOrCreateContext(siteId);
      const pages = context.pages();
      const page = pages[0] ?? await context.newPage();
      const policy = getSitePolicy(siteId, config);
      const domains = policy.domainAllowlist.length > 0
        ? policy.domainAllowlist
        : [siteId];
      const adapter = new PlaywrightMcpAdapter(page, domains, { flags: getFlags(config), capabilities: browserManager.getCapabilities() ?? undefined });
      const toolResult = await adapter.proxyTool(toolName, (args ?? {}) as Record<string, unknown>);

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

      // Gate ALL unconfirmed skills through confirmation, regardless of side-effect class
      const needsConfirmation = !confirmation.isSkillConfirmed(matchedSkill.id);

      if (needsConfirmation) {
        const token = await confirmation.generateToken(
          matchedSkill.id,
          params,
          matchedSkill.currentTier,
        );

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'confirmation_required',
              message: 'This skill has not been validated yet. Please confirm execution.',
              skillId: matchedSkill.id,
              confirmationToken: token.nonce,
              expiresAt: token.expiresAt,
              sideEffectClass: matchedSkill.sideEffectClass,
              method: matchedSkill.method,
              pathTemplate: matchedSkill.pathTemplate,
            }),
          }],
        };
      }

      // Execute the skill
      const result = await engine.executeSkill(matchedSkill.id, params);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      };
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
