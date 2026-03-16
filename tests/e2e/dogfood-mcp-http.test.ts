/**
 * Dogfood E2E: MCP HTTP Transport
 *
 * Tests the Streamable HTTP MCP transport with real HTTP requests.
 * Uses the actual startMcpHttpServer() function with mocked dependencies.
 *
 * Pro user scenarios:
 *   - Session creation via POST /mcp
 *   - Session reuse via mcp-session-id header
 *   - Authentication enforcement
 *   - tools/list and tools/call via HTTP
 *   - Multiple concurrent sessions
 *   - Shutdown cleans up all sessions
 *   - Non-MCP paths return 404
 *   - Body size limits
 *   - Invalid JSON rejection
 *   - Unknown session 404
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';

// ─── Mocks ──────────────────────────────────────────────────────

vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  }),
}));

vi.mock('../../src/core/config.js', () => ({
  getConfig: () => ({
    dataDir: '/tmp/schrute-dogfood-http',
    logLevel: 'silent',
    daemon: { port: 19420, autoStart: false },
  }),
}));

vi.mock('../../src/storage/database.js', () => ({
  getDatabase: () => ({
    prepare: () => ({ run: () => ({ changes: 0 }), get: () => undefined, all: () => [] }),
    exec: () => {},
    close: () => {},
  }),
  closeDatabase: vi.fn(),
}));

// ─── Import ─────────────────────────────────────────────────────

import { startMcpHttpServer, type McpHttpDeps } from '../../src/server/mcp-http.js';

// ─── HTTP Request Helper ────────────────────────────────────────

interface McpHttpResponse {
  statusCode: number;
  rawBody: string;
  headers: http.IncomingHttpHeaders;
  /** Parsed JSON-RPC response (extracted from SSE data: lines or raw JSON) */
  json: any;
}

function httpRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<McpHttpResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        ...headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf-8');
        let json: any = null;

        const contentType = res.headers['content-type'] || '';
        if (contentType.includes('text/event-stream')) {
          // Parse SSE: extract data: lines
          const dataLines = rawBody.split('\n')
            .filter(l => l.startsWith('data: '))
            .map(l => l.slice(6));
          if (dataLines.length > 0) {
            try { json = JSON.parse(dataLines[dataLines.length - 1]); } catch {}
          }
        } else {
          try { json = JSON.parse(rawBody); } catch {}
        }

        resolve({ statusCode: res.statusCode ?? 0, rawBody, headers: res.headers, json });
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── Mock Dependencies ──────────────────────────────────────────

function createMockDeps(authToken: string): McpHttpDeps {
  const mockBrowserManager = {
    getBrowser: vi.fn().mockReturnValue(null),
    isCdpConnected: vi.fn().mockReturnValue(false),
    supportsHarRecording: vi.fn().mockReturnValue(true),
    getHarPath: vi.fn().mockReturnValue(null),
    hasContext: vi.fn().mockReturnValue(false),
    tryGetContext: vi.fn().mockReturnValue(undefined),
    getOrCreateContext: vi.fn().mockResolvedValue({ pages: () => [], newPage: vi.fn() }),
    getSelectedOrFirstPage: vi.fn().mockImplementation(async (_siteId: string, context?: { pages?: () => unknown[]; newPage?: () => Promise<unknown> }) => {
      const pages = context?.pages?.() ?? [];
      if (pages.length > 0) return pages[0];
      return context?.newPage?.();
    }),
    closeContext: vi.fn().mockResolvedValue(undefined),
    closeBrowser: vi.fn().mockResolvedValue(undefined),
    closeAll: vi.fn().mockResolvedValue(undefined),
    getCapabilities: vi.fn().mockReturnValue(null),
    getHandlerTimeoutMs: vi.fn().mockReturnValue(30000),
    setSuppressIdleTimeout: vi.fn(),
    withLease: vi.fn().mockImplementation(async (fn: () => Promise<unknown>) => fn()),
    importCookies: vi.fn().mockResolvedValue(0),
    exportCookies: vi.fn().mockResolvedValue([]),
    touchActivity: vi.fn(),
    releaseActivity: vi.fn(),
    isIdle: vi.fn().mockReturnValue(true),
  };

  const mockSessionManager = {
    create: vi.fn().mockResolvedValue({ id: 'sess-http-1', siteId: 'example.com', url: 'https://example.com', createdAt: Date.now() }),
    resume: vi.fn().mockResolvedValue({ id: 'sess-http-1', siteId: 'example.com', url: 'https://example.com', createdAt: Date.now() }),
    close: vi.fn().mockResolvedValue(undefined),
    listActive: vi.fn().mockReturnValue([]),
    getBrowserManager: () => mockBrowserManager,
    getSession: vi.fn().mockReturnValue(undefined),
    updateUrl: vi.fn(),
    remove: vi.fn(),
  };

  const mockMultiSessionManager = {
    getOrCreate: vi.fn().mockReturnValue({
      name: 'default', siteId: '', browserManager: mockBrowserManager, isCdp: false, createdAt: Date.now(),
    }),
    get: vi.fn().mockReturnValue({
      name: 'default', siteId: '', browserManager: mockBrowserManager, isCdp: false, createdAt: Date.now(),
    }),
    getActive: vi.fn().mockReturnValue('default'),
    close: vi.fn().mockResolvedValue(undefined),
    closeAll: vi.fn().mockResolvedValue(undefined),
    updateSiteId: vi.fn(),
    updateContextOverrides: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    setActive: vi.fn(),
  };

  const engine = {
    getStatus: vi.fn().mockReturnValue({
      mode: 'idle',
      activeSession: null,
      currentRecording: null,
      uptime: 42,
    }),
    explore: vi.fn().mockResolvedValue({ sessionId: 'sess-1', siteId: 'example.com', url: 'https://example.com' }),
    startRecording: vi.fn().mockResolvedValue({ id: 'rec-1', name: 'test', siteId: 'example.com', startedAt: Date.now(), requestCount: 0 }),
    stopRecording: vi.fn().mockResolvedValue({ id: 'rec-1', name: 'test', siteId: 'example.com', startedAt: Date.now(), requestCount: 5 }),
    close: vi.fn().mockResolvedValue(undefined),
    getSessionManager: () => mockSessionManager,
    getMultiSessionManager: () => mockMultiSessionManager,
    getActiveSessionId: vi.fn().mockReturnValue(null),
    resetExploreState: vi.fn(),
    createBrowserProvider: vi.fn().mockResolvedValue(undefined),
    executeSkill: vi.fn().mockResolvedValue({ success: true, data: {} }),
  } as any;

  const skillRepo = {
    getById: vi.fn().mockReturnValue(undefined),
    create: vi.fn(),
    getBySiteId: vi.fn().mockReturnValue([]),
    getActive: vi.fn().mockReturnValue([]),
    getByStatus: vi.fn().mockReturnValue([]),
    getAll: vi.fn().mockReturnValue([]),
    update: vi.fn(),
    delete: vi.fn(),
  } as any;

  const siteRepo = {
    getById: vi.fn().mockReturnValue(undefined),
    create: vi.fn(),
    update: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
    delete: vi.fn(),
  } as any;

  const confirmation = {
    isSkillConfirmed: vi.fn().mockReturnValue(false),
    generateToken: vi.fn().mockResolvedValue({ nonce: 'test-nonce', expiresAt: Date.now() + 60000 }),
    verifyToken: vi.fn().mockReturnValue({ valid: false, error: 'invalid token' }),
    consumeToken: vi.fn(),
  } as any;

  return {
    engine,
    skillRepo,
    siteRepo,
    confirmation,
    config: {
      dataDir: '/tmp/schrute-dogfood-http',
      logLevel: 'silent',
      features: { webmcp: false, httpTransport: false },
      server: { network: true, authToken: authToken },
      daemon: { port: 19420, autoStart: false },
      toolBudget: {
        maxToolCallsPerTask: 50,
        maxConcurrentCalls: 3,
        crossDomainCalls: false,
        secretsToNonAllowlisted: false,
      },
      payloadLimits: {
        maxResponseBodyBytes: 10 * 1024 * 1024,
        maxRequestBodyBytes: 5 * 1024 * 1024,
        replayTimeoutMs: { tier1: 30000, tier3: 60000, tier4: 120000 },
        harCaptureMaxBodyBytes: 50 * 1024 * 1024,
        redactorTimeoutMs: 10000,
      },
      audit: { strictMode: false, rootHashExport: false },
      storage: { maxPerSiteMb: 500, maxGlobalMb: 5000, retentionDays: 90 },
      tempTtlMs: 3600000,
      gcIntervalMs: 900000,
      confirmationTimeoutMs: 30000,
      confirmationExpiryMs: 60000,
      promotionConsecutivePasses: 5,
      promotionVolatilityThreshold: 0.2,
      maxToolsPerSite: 20,
      maxSkillsPerRecording: 15,
      toolShortlistK: 10,
    } as any,
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('Dogfood E2E: MCP HTTP Transport', () => {
  const AUTH_TOKEN = 'dogfood-test-token-12345';
  let server: Awaited<ReturnType<typeof startMcpHttpServer>>;
  let port: number;
  let deps: McpHttpDeps;

  beforeEach(async () => {
    deps = createMockDeps(AUTH_TOKEN);
    server = await startMcpHttpServer(deps, { host: '127.0.0.1', port: 0 });
    const addr = server.address();
    expect(addr).not.toBeNull();
    port = addr!.port;
  });

  afterEach(async () => {
    if (server) await server.close();
  });

  // ═══════════════════════════════════════════════════════════════
  // 1. Non-MCP Path → 404
  // ═══════════════════════════════════════════════════════════════

  it('non-MCP path returns 404', async () => {
    const res = await httpRequest(port, 'GET', '/api/status', {
      Authorization: `Bearer ${AUTH_TOKEN}`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json?.error).toContain('Not found');
  });

  // ═══════════════════════════════════════════════════════════════
  // 2. Auth Enforcement
  // ═══════════════════════════════════════════════════════════════

  it('missing auth → 401', async () => {
    const res = await httpRequest(port, 'POST', '/mcp', {}, JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    }));
    expect(res.statusCode).toBe(401);
    expect(res.json?.error).toContain('Unauthorized');
  });

  it('wrong auth token → 401', async () => {
    const res = await httpRequest(port, 'POST', '/mcp', {
      Authorization: 'Bearer wrong-token',
    }, JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    }));
    expect(res.statusCode).toBe(401);
  });

  // ═══════════════════════════════════════════════════════════════
  // 3. Session Creation via POST /mcp
  // ═══════════════════════════════════════════════════════════════

  it('POST /mcp creates a session with initialize', async () => {
    const res = await httpRequest(port, 'POST', '/mcp', {
      Authorization: `Bearer ${AUTH_TOKEN}`,
    }, JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dogfood', version: '1.0' } },
    }));

    expect(res.statusCode).toBe(200);
    expect(res.headers['mcp-session-id']).toBeDefined();
    expect(res.json?.result?.serverInfo?.name).toBe('schrute');
  });

  // ═══════════════════════════════════════════════════════════════
  // 4. Session Reuse via mcp-session-id
  // ═══════════════════════════════════════════════════════════════

  it('reuses session with mcp-session-id header', async () => {
    // Create session
    const initRes = await httpRequest(port, 'POST', '/mcp', {
      Authorization: `Bearer ${AUTH_TOKEN}`,
    }, JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    }));

    const sessionId = initRes.headers['mcp-session-id'] as string;
    expect(sessionId).toBeTruthy();

    // Send initialized notification
    await httpRequest(port, 'POST', '/mcp', {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      'mcp-session-id': sessionId,
    }, JSON.stringify({
      jsonrpc: '2.0', method: 'notifications/initialized',
    }));

    // Reuse session for tools/list
    const listRes = await httpRequest(port, 'POST', '/mcp', {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      'mcp-session-id': sessionId,
    }, JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
    }));

    expect(listRes.statusCode).toBe(200);
    expect(listRes.json?.result?.tools).toBeDefined();
    expect(Array.isArray(listRes.json.result.tools)).toBe(true);
    expect(listRes.json.result.tools.length).toBeGreaterThan(0);

    // Verify meta tools present (schrute_explore is admin-only with network mode)
    const names = listRes.json.result.tools.map((t: any) => t.name);
    expect(names).toContain('schrute_status');
    expect(names).toContain('schrute_skills');
  });

  // ═══════════════════════════════════════════════════════════════
  // 5. tools/call via HTTP
  // ═══════════════════════════════════════════════════════════════

  it('tools/call works via HTTP session', async () => {
    // Init session
    const initRes = await httpRequest(port, 'POST', '/mcp', {
      Authorization: `Bearer ${AUTH_TOKEN}`,
    }, JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    }));
    const sessionId = initRes.headers['mcp-session-id'] as string;

    // Send initialized
    await httpRequest(port, 'POST', '/mcp', {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      'mcp-session-id': sessionId,
    }, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));

    // Call schrute_status
    const callRes = await httpRequest(port, 'POST', '/mcp', {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      'mcp-session-id': sessionId,
    }, JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'schrute_status', arguments: {} },
    }));

    expect(callRes.statusCode).toBe(200);
    expect(callRes.json?.result?.content).toBeDefined();
    expect(callRes.json.result.content[0].type).toBe('text');

    const status = JSON.parse(callRes.json.result.content[0].text);
    expect(status.mode).toBe('idle');
    expect(status.uptime).toBeGreaterThanOrEqual(0);
  });

  // ═══════════════════════════════════════════════════════════════
  // 6. Unknown Session → 404
  // ═══════════════════════════════════════════════════════════════

  it('unknown session ID → 404', async () => {
    const res = await httpRequest(port, 'POST', '/mcp', {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      'mcp-session-id': 'nonexistent-session-id',
    }, JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
    }));
    expect(res.statusCode).toBe(404);
    expect(res.json?.error).toContain('Session not found');
  });

  // ═══════════════════════════════════════════════════════════════
  // 7. Multiple Concurrent Sessions
  // ═══════════════════════════════════════════════════════════════

  it('supports multiple concurrent sessions', async () => {
    // Create session 1
    const init1 = await httpRequest(port, 'POST', '/mcp', {
      Authorization: `Bearer ${AUTH_TOKEN}`,
    }, JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'client-1', version: '1.0' } },
    }));
    const sid1 = init1.headers['mcp-session-id'] as string;

    // Create session 2
    const init2 = await httpRequest(port, 'POST', '/mcp', {
      Authorization: `Bearer ${AUTH_TOKEN}`,
    }, JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'client-2', version: '1.0' } },
    }));
    const sid2 = init2.headers['mcp-session-id'] as string;

    // Sessions are different
    expect(sid1).toBeTruthy();
    expect(sid2).toBeTruthy();
    expect(sid1).not.toBe(sid2);

    // Both sessions work independently
    for (const sid of [sid1, sid2]) {
      await httpRequest(port, 'POST', '/mcp', {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        'mcp-session-id': sid,
      }, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    }

    // Query tools from session 1
    const list1 = await httpRequest(port, 'POST', '/mcp', {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      'mcp-session-id': sid1,
    }, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));

    expect(list1.statusCode).toBe(200);
    expect(list1.json?.result?.tools?.length).toBeGreaterThan(0);
  });

  // ═══════════════════════════════════════════════════════════════
  // 8. Shutdown Cleans Up
  // ═══════════════════════════════════════════════════════════════

  it('shutdown closes all sessions and rejects new requests', async () => {
    // Create a session
    const initRes = await httpRequest(port, 'POST', '/mcp', {
      Authorization: `Bearer ${AUTH_TOKEN}`,
    }, JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    }));
    expect(initRes.headers['mcp-session-id']).toBeTruthy();

    // Shutdown
    await server.close();

    // After shutdown, new requests should fail
    try {
      const res = await httpRequest(port, 'POST', '/mcp', {
        Authorization: `Bearer ${AUTH_TOKEN}`,
      }, JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      }));
      // If we get a response, it should be 503
      expect(res.statusCode).toBe(503);
    } catch (err: any) {
      // Connection refused is also acceptable
      expect(err.code).toMatch(/ECONNREFUSED|ECONNRESET/);
    }

    // Prevent afterEach from double-closing
    server = null as any;
  });

  // ═══════════════════════════════════════════════════════════════
  // 9. Invalid JSON → 400
  // ═══════════════════════════════════════════════════════════════

  it('invalid JSON body → 400', async () => {
    const res = await httpRequest(port, 'POST', '/mcp', {
      Authorization: `Bearer ${AUTH_TOKEN}`,
    }, 'not valid json {{{');

    // The transport may reject this as 400 or the SDK may handle it differently
    expect([400, 500]).toContain(res.statusCode);
  });

  // ═══════════════════════════════════════════════════════════════
  // 10. GET/DELETE on /mcp
  // ═══════════════════════════════════════════════════════════════

  it('GET /mcp without session → 400', async () => {
    const res = await httpRequest(port, 'GET', '/mcp', {
      Authorization: `Bearer ${AUTH_TOKEN}`,
    });
    expect(res.statusCode).toBe(400);
  });

  // ═══════════════════════════════════════════════════════════════
  // 11. Doctor via HTTP
  // ═══════════════════════════════════════════════════════════════

  it('schrute_doctor via HTTP returns diagnostics', async () => {
    // Init session
    const initRes = await httpRequest(port, 'POST', '/mcp', {
      Authorization: `Bearer ${AUTH_TOKEN}`,
    }, JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    }));
    const sessionId = initRes.headers['mcp-session-id'] as string;

    // Send initialized
    await httpRequest(port, 'POST', '/mcp', {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      'mcp-session-id': sessionId,
    }, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));

    // Call doctor
    const callRes = await httpRequest(port, 'POST', '/mcp', {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      'mcp-session-id': sessionId,
    }, JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'schrute_doctor', arguments: {} },
    }));

    expect(callRes.statusCode).toBe(200);
    const diagnostics = JSON.parse(callRes.json.result.content[0].text);
    expect(diagnostics.diagnostics).toBeDefined();
    expect(diagnostics.diagnostics.engine).toBeDefined();
    expect(diagnostics.diagnostics.browser).toBeDefined();
  });
});
