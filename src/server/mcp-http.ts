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
import { BoundedMap } from '../shared/bounded-map.js';
import { VERSION } from '../version.js';
import type { Engine } from '../core/engine.js';
import type { SkillRepository } from '../storage/skill-repository.js';
import type { SiteRepository } from '../storage/site-repository.js';
import type { ConfirmationManager } from './confirmation.js';
import type { SchruteConfig } from '../skill/types.js';
import { buildToolList, dispatchToolCall } from './tool-dispatch.js';
import { createRouter } from './router.js';
import { registerResourceHandlers, registerPromptHandlers } from './mcp-handlers.js';

const log = getLogger();

// ─── MCP HTTP Dependencies ───────────────────────────────────────

export interface McpHttpDeps {
  engine: Engine;
  skillRepo: SkillRepository;
  siteRepo: SiteRepository;
  confirmation: ConfirmationManager;
  config: SchruteConfig;
}

// ─── MCP HTTP Server ─────────────────────────────────────────────

export async function startMcpHttpServer(
  deps: McpHttpDeps,
  options?: { host?: string; port?: number },
): Promise<{ close: () => Promise<void>; address: () => { host: string; port: number } | null }> {
  const { config } = deps;

  if (!config.server.network) {
    throw new Error('MCP HTTP transport is disabled. Set config.server.network = true to enable.');
  }
  if (!config.server.authToken) {
    throw new Error('MCP HTTP transport requires config.server.authToken.');
  }

  const host = options?.host ?? '127.0.0.1';
  const port = options?.port ?? 3001;

  // Create a single shared router for all sessions (avoids per-call allocation)
  const router = createRouter(deps);
  const depsWithRouter = { ...deps, router };

  interface McpSession {
    transport: StreamableHTTPServerTransport;
    server: Server;
  }
  const sessions = new BoundedMap<string, McpSession>({
    maxSize: 100,
    onEvict: (_key, session) => {
      Promise.resolve()
        .then(() => session.transport.close())
        .then(() => session.server.close())
        .catch(e => log.warn({ e }, 'Session eviction cleanup failed'));
    },
  });
  let isShuttingDown = false;

  // Helper: register all MCP handlers on a server instance
  function registerAllHandlers(server: Server): void {
    registerResourceHandlers(server, depsWithRouter);
    registerPromptHandlers(server, depsWithRouter);

    server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
      const listCallerId = (extra as { sessionId?: string })?.sessionId ?? 'mcp-http-unknown';
      const tools = buildToolList(depsWithRouter, listCallerId);
      return { tools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args } = request.params;
      const toolCallerId = (extra as { sessionId?: string })?.sessionId ?? 'mcp-http-unknown';
      return dispatchToolCall(name, args as Record<string, unknown> | undefined, depsWithRouter, toolCallerId);
    });
  }

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

    if (!url.startsWith('/mcp')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found. MCP endpoint is at /mcp' }));
      return;
    }

    // Gate 1: Early rejection at request entry
    if (isShuttingDown) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server is shutting down' }));
      return;
    }

    // Authentication
    const authToken = config.server.authToken;
    if (authToken) {
      if (!verifyBearerToken(req, authToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    } else if (config.server.network) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server misconfigured: auth token required' }));
      return;
    }

    // Read body for POST
    let body: string | undefined;
    if (req.method === 'POST') {
      const MAX_BODY = 1024 * 1024;
      const chunks: Buffer[] = [];
      let size = 0;
      let overflow = false;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY) { overflow = true; break; }
        chunks.push(chunk as Buffer);
      }
      if (overflow) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large' }));
        return;
      }
      body = Buffer.concat(chunks).toString('utf-8');
    }

    // Get or create transport for session
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && sessions.has(sessionId)) {
      transport = sessions.get(sessionId)!.transport;
    } else if (req.method === 'POST' && !sessionId) {
      // Gate 2: Before creating new transport/session server
      // This catches in-flight requests that entered before shutdown
      // but reach session creation after isShuttingDown is set
      if (isShuttingDown) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Server is shutting down' }));
        return;
      }

      // Create new transport
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          if (!isShuttingDown) {
            // Normal close: this callback owns server cleanup
            const session = sessions.get(sid);
            session?.server.close().catch(e => log.warn({ e }, 'Session server close error in onclose'));
            sessions.deleteQuiet(sid);
          }
          // During shutdown: leave sessions intact — shutdown owns cleanup via
          // sessions.clear() (which does not fire onEvict). Calling delete here
          // would trigger onEvict and double-close the transport/server.
          log.debug({ sessionId: sid }, 'MCP HTTP session closed');
        }
      };

      // Create per-session server
      const sessionServer = new Server(
        { name: 'schrute', version: VERSION },
        { capabilities: { tools: {}, resources: {}, prompts: {} } },
      );
      registerAllHandlers(sessionServer);
      await sessionServer.connect(transport);

      // Gate 3: Re-check after connect() — close() may have snapshotted serversToClose
      // between Gate 2 and here, so this late session would be outside the shutdown snapshot.
      if (isShuttingDown) {
        await sessionServer.close().catch(e => log.warn({ e }, 'Late session server close'));
        await transport.close().catch(e => log.warn({ e }, 'Late transport close'));
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Server is shutting down' }));
        return;
      }

      // Note: transport.sessionId is NOT set yet — it gets set during handleRequest()
      // when the initialize request is processed. We register after handleRequest() below.

      log.info('New MCP HTTP session (pending initialization)');

      // Parse body before handleRequest
      let parsedBody: unknown;
      if (body) {
        try { parsedBody = JSON.parse(body); }
        catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }
      }

      await transport.handleRequest(req, res, parsedBody);

      // NOW sessionId is set — register the transport and server
      if (transport.sessionId) {
        sessions.set(transport.sessionId, { transport, server: sessionServer });
        log.info({ sessionId: transport.sessionId }, 'MCP HTTP session registered');
      }
      return;
    } else if (sessionId && !sessions.has(sessionId)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request' }));
      return;
    }

    // Parse and delegate (for existing sessions)
    let parsedBody: unknown;
    if (body) {
      try { parsedBody = JSON.parse(body); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
    }
    await transport.handleRequest(req, res, parsedBody);
  }

  return new Promise((resolve) => {
    httpServer.listen(port, host, () => {
      log.info({ host, port }, 'MCP HTTP server listening');

      resolve({
        address() {
          const addr = httpServer.address();
          if (addr && typeof addr === 'object') return { host: addr.address, port: addr.port };
          return null;
        },
        async close() {
          isShuttingDown = true;

          // Snapshot sessions before closing — onclose may mutate the map
          const snapshot = [...sessions.values()];

          // Phase 1: Close transports (frees active connections)
          await Promise.allSettled(
            snapshot.map(s => s.transport.close().catch(e => log.warn({ e }, 'Transport close error')))
          );

          // Phase 2: Close all session servers (sole owner — onclose skipped during shutdown)
          await Promise.allSettled(
            snapshot.map(s => s.server.close().catch(e => log.warn({ e }, 'Session server close error')))
          );
          sessions.clear();

          // Phase 3: Close HTTP server last
          await new Promise<void>((resolveClose, reject) => {
            httpServer.close((err) => (err ? reject(err) : resolveClose()));
          });

          log.info('MCP HTTP server closed');
        },
      });
    });
  });
}
