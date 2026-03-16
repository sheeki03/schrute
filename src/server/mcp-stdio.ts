import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getLogger } from '../core/logger.js';
import { VERSION } from '../version.js';
import type { Engine } from '../core/engine.js';
import type { SkillRepository } from '../storage/skill-repository.js';
import type { SiteRepository } from '../storage/site-repository.js';
import type { ConfirmationManager } from './confirmation.js';
import type { SchruteConfig } from '../skill/types.js';
import { SkillStatus } from '../skill/types.js';
import { buildToolList, dispatchToolCall } from './tool-dispatch.js';
import { withTimeout } from '../core/utils.js';
import { createRouter } from './router.js';
import { registerResourceHandlers, registerPromptHandlers } from './mcp-handlers.js';
import { drainMcpNotifications } from '../healing/notification.js';

const log = getLogger();

/** Interval between tool list change polls (ms) */
const TOOL_LIST_POLL_INTERVAL_MS = 5_000;

// ─── MCP Stdio Dependencies ──────────────────────────────────────

export interface McpStdioDeps {
  engine: Engine;
  skillRepo: SkillRepository;
  siteRepo: SiteRepository;
  confirmation: ConfirmationManager;
  config: SchruteConfig;
}

// ─── MCP Server ──────────────────────────────────────────────────

export async function startMcpServer(deps: McpStdioDeps): Promise<{ close: () => Promise<void> }> {
  const { skillRepo } = deps;

  // Create a single shared router (avoids per-call allocation in dispatchToolCall)
  const router = createRouter(deps);
  const depsWithRouter = { ...deps, router };

  // Track which skills are currently exposed
  let lastActiveSkillIds: string[] = [];

  const server = new Server(
    {
      name: 'schrute',
      version: VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    },
  );

  // ─── Resource & Prompt Handlers ─────────────────────────────────
  registerResourceHandlers(server, depsWithRouter);
  registerPromptHandlers(server, depsWithRouter);

  // ─── List Tools Handler ───────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = buildToolList(depsWithRouter, 'stdio');

    // Track for change detection
    const activeSkills = skillRepo.getByStatus(SkillStatus.ACTIVE);
    const currentIds = activeSkills.map((s) => s.id).sort();
    if (JSON.stringify(currentIds) !== JSON.stringify(lastActiveSkillIds)) {
      lastActiveSkillIds = currentIds;
      // Notify that tools changed
      try {
        await server.notification({
          method: 'notifications/tools/list_changed',
        });
      } catch (err) {
        log.warn({ err }, 'Failed to send tool list change notification to MCP client');
      }
    }

    return { tools };
  });

  // ─── Call Tool Handler ────────────────────────────────────────

  const MCP_TOOL_CALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — safety net for hung tool calls

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return await withTimeout(
        dispatchToolCall(name, args as Record<string, unknown> | undefined, depsWithRouter, 'stdio'),
        MCP_TOOL_CALL_TIMEOUT_MS,
        `Tool call '${name}'`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('timed out')) {
        log.error({ tool: name }, msg);
        return { content: [{ type: 'text', text: `Error: ${msg}. The operation may still be running in the background.` }], isError: true };
      }
      throw err;
    }
  });

  // ─── Periodic Tool List Change Detection ──────────────────────

  let consecutivePollFailures = 0;

  const toolRefreshInterval = setInterval(async () => {
    try {
      const activeSkills = skillRepo.getByStatus(SkillStatus.ACTIVE);
      const currentIds = activeSkills.map((s) => s.id).sort();
      if (JSON.stringify(currentIds) !== JSON.stringify(lastActiveSkillIds)) {
        lastActiveSkillIds = currentIds;
        await server.notification({
          method: 'notifications/tools/list_changed',
        });
        log.info('Tool list changed, notified client');
      }
      consecutivePollFailures = 0; // reset on success

      // B4: Drain pending MCP notifications from healing system
      const pendingNotifications = drainMcpNotifications();
      for (const notification of pendingNotifications) {
        await server.notification(notification);
      }
    } catch (err) {
      consecutivePollFailures++;
      if (consecutivePollFailures >= 3) {
        log.error({ err, consecutiveFailures: consecutivePollFailures }, 'Persistent tool list poll failure');
      } else {
        log.warn({ err }, 'Tool list poll failed');
      }
    }
  }, TOOL_LIST_POLL_INTERVAL_MS);

  // ─── Start Server ─────────────────────────────────────────────

  const transport = new StdioServerTransport();

  log.info('Starting MCP stdio server');

  await server.connect(transport);

  return {
    async close() {
      clearInterval(toolRefreshInterval);
      await server.close();
      // Engine is shared — caller manages its lifecycle
    },
  };
}
