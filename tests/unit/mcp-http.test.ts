import { describe, it, expect, vi } from 'vitest';
import { startMcpHttpServer } from '../../src/server/mcp-http.js';

// ─── Mock modules ────────────────────────────────────────────────

vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../src/core/config.js', () => ({
  getConfig: () => ({
    dataDir: '/tmp/oneagent-test',
    logLevel: 'silent',
    features: { webmcp: false, httpTransport: false },
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
    audit: { strictMode: true, rootHashExport: true },
    storage: { maxPerSiteMb: 500, maxGlobalMb: 5000, retentionDays: 90 },
    server: { network: false },
    tempTtlMs: 3600000,
    gcIntervalMs: 900000,
    confirmationTimeoutMs: 30000,
    confirmationExpiryMs: 60000,
    promotionConsecutivePasses: 5,
    promotionVolatilityThreshold: 0.2,
    maxToolsPerSite: 20,
    toolShortlistK: 10,
  }),
  ensureDirectories: vi.fn(),
  getDbPath: () => ':memory:',
}));

vi.mock('../../src/storage/database.js', () => {
  const mockDb = {
    run: vi.fn().mockReturnValue({ changes: 0 }),
    get: vi.fn().mockReturnValue(undefined),
    all: vi.fn().mockReturnValue([]),
    exec: vi.fn(),
    transaction: vi.fn((fn: () => unknown) => fn),
    open: vi.fn(),
    close: vi.fn(),
  };
  return {
    getDatabase: () => mockDb,
    AgentDatabase: vi.fn(() => mockDb),
  };
});

vi.mock('../../src/core/engine.js', () => {
  return {
    Engine: vi.fn().mockImplementation(() => ({
      getStatus: () => ({
        mode: 'idle',
        activeSession: null,
        currentRecording: null,
        uptime: 1000,
      }),
      explore: vi.fn().mockResolvedValue({ sessionId: 's1', siteId: 'example.com', url: 'https://example.com' }),
      startRecording: vi.fn().mockResolvedValue({ id: 'r1', name: 'test', siteId: 'example.com', startedAt: Date.now(), requestCount: 0 }),
      stopRecording: vi.fn().mockResolvedValue({ id: 'r1', name: 'test', siteId: 'example.com', startedAt: Date.now(), requestCount: 5 }),
      executeSkill: vi.fn().mockResolvedValue({ success: true, data: { result: 'ok' }, latencyMs: 100 }),
      close: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

// ─── Tests ────────────────────────────────────────────────────────

describe('mcp-http', () => {
  it('throws when server.network is false', async () => {
    await expect(startMcpHttpServer()).rejects.toThrow(
      'MCP HTTP transport is disabled',
    );
  });
});
