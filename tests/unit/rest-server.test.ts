import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock modules before importing rest-server
vi.mock('../../src/core/config.js', () => ({
  getConfig: () => ({
    dataDir: '/tmp/schrute-test',
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

vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
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
      explore: vi.fn().mockResolvedValue({ status: 'ready', sessionId: 's1', siteId: 'example.com', url: 'https://example.com' }),
      recoverExplore: vi.fn().mockResolvedValue({ status: 'ready', siteId: 'example.com', url: 'https://example.com', session: '__recovery' }),
      startRecording: vi.fn().mockResolvedValue({ id: 'r1', name: 'test', siteId: 'example.com', startedAt: Date.now(), requestCount: 0 }),
      stopRecording: vi.fn().mockResolvedValue({ id: 'r1', name: 'test', siteId: 'example.com', startedAt: Date.now(), requestCount: 5 }),
      executeSkill: vi.fn().mockResolvedValue({ success: true, data: { result: 'ok' }, latencyMs: 100 }),
      close: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

import { createRestServer } from '../../src/server/rest-server.js';

describe('rest-server', () => {
  let app: Awaited<ReturnType<typeof createRestServer>>;

  beforeEach(async () => {
    app = await createRestServer({ host: '127.0.0.1', port: 0 });
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /api/health', () => {
    it('returns health status', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/health',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe('ok');
      expect(typeof body.uptime).toBe('number');
    });
  });

  describe('GET /api/sites', () => {
    it('returns list of sites', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/sites',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body)).toBe(true);
    });
  });

  describe('GET /api/sites/:id', () => {
    it('returns 404 for unknown site', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/sites/unknown.com',
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /api/sites/:id/skills', () => {
    it('returns empty skills list', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/sites/example.com/skills',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body)).toBe(true);
    });
  });

  describe('POST /api/explore', () => {
    it('requires url in body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/explore',
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });

    it('starts exploration with valid url', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/explore',
        payload: { url: 'https://example.com' },
      });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('POST /api/record', () => {
    it('requires name in body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/record',
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });

    it('starts recording with valid name', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/record',
        payload: { name: 'test-recording' },
      });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('POST /api/recover-explore', () => {
    it('accepts a recovery token and returns recovery status', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/recover-explore',
        payload: { resumeToken: 'recover-token', waitMs: 5000 },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe('ready');
      expect(body.session).toBe('__recovery');
    });
  });

  describe('POST /api/stop', () => {
    it('stops recording', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/stop',
      });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('GET /api/openapi.json', () => {
    it('returns OpenAPI spec', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/openapi.json',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.openapi).toBe('3.1.0');
      expect(body.info).toBeDefined();
      expect(body.paths).toBeDefined();
    });
  });

  describe('GET /api/docs', () => {
    it('returns Swagger UI HTML', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/docs',
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('swagger-ui');
    });
  });

  describe('GET /api/audit', () => {
    it('returns audit log', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/audit',
      });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('GET /api/status', () => {
    it('returns engine status', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/status',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.mode).toBe('idle');
    });
  });
});
