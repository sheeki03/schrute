import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { verifyBearerToken } from '../shared/auth-utils.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
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
import type { OneAgentConfig } from '../skill/types.js';
import { buildToolList, dispatchToolCall } from './tool-dispatch.js';
import { registerResourceHandlers, registerPromptHandlers } from './mcp-handlers.js';

const log = getLogger();

// ─── MCP HTTP Dependencies ───────────────────────────────────────

export interface McpHttpDeps {
  engine: Engine;
  skillRepo: SkillRepository;
  siteRepo: SiteRepository;
  confirmation: ConfirmationManager;
  config: OneAgentConfig;
}

// ─── MCP HTTP Server ─────────────────────────────────────────────

export async function startMcpHttpServer(
  deps: McpHttpDeps,
  options?: { host?: string; port?: number },
): Promise<{ close: () => Promise<void> }> {
  const { config } = deps;

  // Require explicit opt-in
  if (!config.server.network) {
    throw new Error(
      'MCP HTTP transport is disabled. Set config.server.network = true to enable.',
    );
  }

  // Require auth token for HTTP transport
  if (!config.server.authToken) {
    throw new Error(
      'MCP HTTP transport requires config.server.authToken. ' +
      'Set it with: oneagent config set server.authToken <your-secret-token>',
    );
  }

  const host = options?.host ?? '127.0.0.1';
  const port = options?.port ?? 3001;

  // Track active transports per session
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const mcpServer = new Server(
    {
      name: 'oneagent',
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

  // ─── Resource & Prompt Handlers ─────────────────────────
  // Resource/prompt handlers run within authenticated MCP sessions.
  // Auth was enforced at the HTTP request level before reaching MCP transport.
  registerResourceHandlers(mcpServer, deps);
  registerPromptHandlers(mcpServer, deps);

  // ─── List Tools Handler ─────────────────────────────────
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = buildToolList(deps);
    return { tools };
  });

  // ─── Call Tool Handler ──────────────────────────────────
  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return dispatchToolCall(name, args as Record<string, unknown> | undefined, deps);
  });

  // ─── HTTP Server ────────────────────────────────────────
  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    handleMcpRequest(req, res).catch((err) => {
      log.error({ err }, 'Unhandled MCP HTTP request error');
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });
  });

  async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';

    // Auth policy: /mcp paths require Bearer auth (fail-closed: missing/invalid → 401).
    // Non-/mcp paths return 404 (no auth check — path doesn't exist, nothing to protect).
    // This is intentional: 401 on unknown paths leaks server existence.
    if (!url.startsWith('/mcp')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found. MCP endpoint is at /mcp' }));
      return;
    }

    // ─── Authentication ─────────────────────────────────────
    const authToken = config.server.authToken;
    if (authToken) {
      if (!verifyBearerToken(req, authToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized. Provide Authorization: Bearer <token>' }));
        return;
      }
    } else if (config.server.network) {
      // Network mode without auth token = reject
      log.error('MCP HTTP server requires config.server.authToken when network=true');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server misconfigured: auth token required for network mode' }));
      return;
    }
    // ────────────────────────────────────────────────────────

    // Read the body for POST requests (capped at 1MB)
    let body: string | undefined;
    if (req.method === 'POST') {
      const MAX_BODY = 1024 * 1024; // 1MB
      const chunks: Buffer[] = [];
      let size = 0;
      let overflow = false;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY) {
          overflow = true;
          break;
        }
        chunks.push(chunk as Buffer);
      }
      if (overflow) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large' }));
        return;
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
    let parsedBody: unknown;
    if (body) {
      try {
        parsedBody = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON in request body' }));
        return;
      }
    }
    await transport.handleRequest(req, res, parsedBody);
  }

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
          await mcpServer.close();
          await new Promise<void>((resolveClose) => {
            httpServer.close(() => resolveClose());
          });
          // Engine is shared — caller manages its lifecycle
          log.info('MCP HTTP server closed');
        },
      });
    });
  });
}
