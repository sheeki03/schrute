import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getLogger } from '../core/logger.js';
import { getConfig } from '../core/config.js';
import { Engine } from '../core/engine.js';
import { getDatabase } from '../storage/database.js';
import { SkillRepository } from '../storage/skill-repository.js';
import { SiteRepository } from '../storage/site-repository.js';
import { PlaywrightMcpAdapter } from '../browser/playwright-mcp-adapter.js';
import { ConfirmationManager } from './confirmation.js';
import {
  rankToolsByIntent,
  skillToToolName,
  skillToToolDefinition,
  getBrowserToolDefinitions,
  META_TOOLS,
} from './tool-registry.js';
import { createRouter, type Router } from './router.js';
import type {
  SkillSpec,
} from '../skill/types.js';
import {
  SkillStatus,
  ALLOWED_BROWSER_TOOLS,
  BLOCKED_BROWSER_TOOLS,
} from '../skill/types.js';
import { dryRun } from '../replay/dry-run.js';

const log = getLogger();

// ─── MCP HTTP Server ─────────────────────────────────────────────

export async function startMcpHttpServer(options?: {
  host?: string;
  port?: number;
}): Promise<{ close: () => Promise<void> }> {
  const config = getConfig();

  // Require explicit opt-in
  if (!config.server.network) {
    throw new Error(
      'MCP HTTP transport is disabled. Set config.server.network = true to enable.',
    );
  }

  const engine = new Engine(config);
  const db = getDatabase(config);
  const skillRepo = new SkillRepository(db);
  const siteRepo = new SiteRepository(db);
  const confirmation = new ConfirmationManager(db, config);
  const router = createRouter({ engine, skillRepo, siteRepo, config, confirmation });

  const host = options?.host ?? '127.0.0.1';
  const port = options?.port ?? 3001;

  // Track active transports per session
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const mcpServer = new Server(
    {
      name: 'oneagent',
      version: '0.2.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // ─── List Tools Handler ─────────────────────────────────
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }> = [];

    tools.push(...META_TOOLS);
    tools.push(...getBrowserToolDefinitions());

    const activeSkills = skillRepo.getByStatus(SkillStatus.ACTIVE);
    const shortlisted = rankToolsByIntent(
      activeSkills,
      undefined,
      config.toolShortlistK,
    );

    for (const skill of shortlisted) {
      tools.push(skillToToolDefinition(skill));
    }

    return { tools };
  });

  // ─── Call Tool Handler ──────────────────────────────────
  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'oneagent_explore': {
          const url = args?.url as string;
          if (!url) {
            return { content: [{ type: 'text', text: 'Error: url is required' }], isError: true };
          }
          const result = await router.explore(url);
          return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
        }

        case 'oneagent_record': {
          const recordName = args?.name as string;
          if (!recordName) {
            return { content: [{ type: 'text', text: 'Error: name is required' }], isError: true };
          }
          const inputs = args?.inputs as Record<string, string> | undefined;
          const result = await router.startRecording(recordName, inputs);
          return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
        }

        case 'oneagent_stop': {
          const result = await router.stopRecording();
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
          const allSkills = [
            ...skillRepo.getByStatus(SkillStatus.ACTIVE),
            ...skillRepo.getByStatus(SkillStatus.DRAFT),
            ...skillRepo.getByStatus(SkillStatus.STALE),
            ...skillRepo.getByStatus(SkillStatus.BROKEN),
          ];
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

      // ─── Browser Tool Proxy ──────────────────────────────
      if ((ALLOWED_BROWSER_TOOLS as readonly string[]).includes(name)) {
        const status = engine.getStatus();
        if (!status.activeSession) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: 'No active browser session. Use oneagent_explore first.',
                tool: name,
              }),
            }],
            isError: true,
          };
        }

        // Get the browser manager and execute the tool
        const browserManager = engine.getSessionManager().getBrowserManager();
        const siteId = status.activeSession.siteId;

        if (!browserManager.hasContext(siteId)) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: 'Browser context not available for this session.',
                tool: name,
              }),
            }],
            isError: true,
          };
        }

        const context = await browserManager.getOrCreateContext(siteId);
        const pages = context.pages();
        const page = pages[0] ?? await context.newPage();
        const adapter = new PlaywrightMcpAdapter(page, [siteId]);
        const toolResult = await adapter.proxyTool(name, (args ?? {}) as Record<string, unknown>);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify(toolResult, null, 2),
          }],
        };
      }

      // ─── Blocked Browser Tools ───────────────────────────
      if ((BLOCKED_BROWSER_TOOLS as readonly string[]).includes(name)) {
        return {
          content: [{
            type: 'text',
            text: `BLOCKED: Tool "${name}" is explicitly blocked for security.`,
          }],
          isError: true,
        };
      }

      // ─── Skill Execution ─────────────────────────────────
      const activeSkills = skillRepo.getByStatus(SkillStatus.ACTIVE);
      const matchedSkill = activeSkills.find(
        (s) => skillToToolName(s) === name,
      );

      if (matchedSkill) {
        const params = (args ?? {}) as Record<string, unknown>;

        // Require first-run confirmation for non-idempotent skills unless globally confirmed
        const needsConfirmation =
          matchedSkill.sideEffectClass !== 'read-only' &&
          !confirmation.isSkillConfirmed(matchedSkill.id);

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

        const result = await engine.executeSkill(matchedSkill.id, params);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        };
      }

      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ tool: name, err }, 'MCP HTTP tool execution error');
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  // ─── HTTP Server ────────────────────────────────────────
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';

    // Only handle /mcp path
    if (!url.startsWith('/mcp')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found. MCP endpoint is at /mcp' }));
      return;
    }

    // Read the body for POST requests
    let body: string | undefined;
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      body = Buffer.concat(chunks).toString('utf-8');
    }

    // Get or create transport for this session
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!;
    } else if (req.method === 'POST' && !sessionId) {
      // New session - create transport
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          transports.delete(sid);
          log.debug({ sessionId: sid }, 'MCP HTTP session closed');
        }
      };

      await mcpServer.connect(transport);

      if (transport.sessionId) {
        transports.set(transport.sessionId, transport);
      }

      log.info({ sessionId: transport.sessionId }, 'New MCP HTTP session');
    } else if (sessionId && !transports.has(sessionId)) {
      // Client provided an unknown session ID — reject
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found. Start a new session with a POST without session ID.' }));
      return;
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request' }));
      return;
    }

    // Delegate to the transport
    const parsedBody = body ? JSON.parse(body) : undefined;
    await transport.handleRequest(req, res, parsedBody);
  });

  return new Promise((resolve) => {
    httpServer.listen(port, host, () => {
      log.info({ host, port }, 'MCP HTTP server listening');

      resolve({
        async close() {
          // Close all transports
          for (const [, transport] of transports) {
            await transport.close();
          }
          transports.clear();
          await engine.close();
          await mcpServer.close();
          httpServer.close();
          log.info('MCP HTTP server closed');
        },
      });
    });
  });
}
