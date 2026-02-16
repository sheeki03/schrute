/**
 * v0.2 Acceptance — REST API full cycle
 *
 * Uses Fastify inject() for all REST route testing (no real HTTP).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Mock keychain to avoid real keytar calls (avoids 2s+ timeouts per call)
vi.mock('../../src/storage/secrets.js', () => ({
  store: vi.fn().mockResolvedValue(undefined),
  retrieve: vi.fn().mockResolvedValue(null),
  remove: vi.fn().mockResolvedValue(undefined),
}));

// Mock external deps BEFORE importing the server
vi.mock('../../src/storage/database.js', () => {
  const skills = new Map<string, any>();
  const sites = new Map<string, any>();
  return {
    getDatabase: () => ({
      prepare: (sql: string) => ({
        run: (...args: unknown[]) => ({ changes: 1 }),
        get: (...args: unknown[]) => undefined,
        all: (...args: unknown[]) => [],
      }),
      run: (...args: unknown[]) => ({ changes: 1 }),
      get: (...args: unknown[]) => undefined,
      all: (...args: unknown[]) => [],
      exec: () => {},
      close: () => {},
    }),
  };
});

vi.mock('../../src/core/engine.js', () => {
  return {
    Engine: class MockEngine {
      getStatus() {
        return {
          mode: 'idle',
          activeSession: null,
          currentRecording: null,
          uptime: 1000,
        };
      }
      async explore(url: string) {
        return { sessionId: 'sess-1', siteId: new URL(url).hostname, url };
      }
      async startRecording(name: string, inputs?: Record<string, string>) {
        return { id: 'rec-1', name, siteId: 'example.com', startedAt: Date.now(), requestCount: 0, inputs };
      }
      async stopRecording() {
        return { id: 'rec-1', name: 'test', siteId: 'example.com', startedAt: Date.now(), requestCount: 5 };
      }
      async executeSkill(skillId: string, params: Record<string, unknown>) {
        return { success: true, data: { result: 'ok' }, latencyMs: 42 };
      }
      async close() {}
    },
  };
});

vi.mock('../../src/storage/skill-repository.js', () => {
  return {
    SkillRepository: class MockSkillRepo {
      getByStatus(status: string) {
        if (status === 'active') {
          return [{
            id: 'example.com.get_users.v1',
            version: 1,
            status: 'active',
            currentTier: 'tier_1',
            tierLock: null,
            allowedDomains: ['example.com'],
            requiredCapabilities: ['net.fetch.direct'],
            parameters: [{ name: 'page', type: 'number', source: 'user_input', evidence: [] }],
            validation: { semanticChecks: [], customInvariants: [] },
            redaction: { piiClassesFound: [], fieldsRedacted: 0 },
            replayStrategy: 'prefer_tier_1',
            sideEffectClass: 'read-only',
            sampleCount: 10,
            consecutiveValidations: 5,
            confidence: 0.95,
            method: 'GET',
            pathTemplate: '/api/users',
            inputSchema: { type: 'object' },
            isComposite: false,
            siteId: 'example.com',
            name: 'get_users',
            description: 'Get users',
            successRate: 0.98,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }];
        }
        return [];
      }
      getBySiteId(siteId: string) {
        if (siteId === 'example.com') {
          return this.getByStatus('active');
        }
        return [];
      }
      getById(id: string) {
        if (id === 'example.com.get_users.v1') {
          return this.getByStatus('active')[0];
        }
        return null;
      }
      getAll() { return this.getByStatus('active'); }
    },
  };
});

vi.mock('../../src/storage/site-repository.js', () => {
  return {
    SiteRepository: class MockSiteRepo {
      getAll() {
        return [{
          id: 'example.com',
          displayName: 'Example',
          firstSeen: Date.now(),
          lastVisited: Date.now(),
          masteryLevel: 'full',
          recommendedTier: 'direct',
          totalRequests: 100,
          successfulRequests: 98,
        }];
      }
      getById(id: string) {
        if (id === 'example.com') return this.getAll()[0];
        return null;
      }
    },
  };
});

vi.mock('../../src/skill/generator.js', () => ({
  generateOpenApiFragment: () => ({ paths: {} }),
}));

vi.mock('../../src/skill/validator.js', () => ({
  validateSkill: async () => ({
    success: true,
    schemaMatch: true,
    invariantResults: [],
    errorSignatures: [],
    latencyMs: 10,
    timestamp: Date.now(),
  }),
}));

describe('v0.2 REST API', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { createRestServer } = await import('../../src/server/rest-server.js');
    app = await createRestServer({ host: '127.0.0.1', port: 0 });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  // ─── Health ───────────────────────────────────────────────────

  it('GET /api/health returns 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body).toHaveProperty('uptime');
  });

  // ─── Sites ────────────────────────────────────────────────────

  it('GET /api/sites returns list of sites', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sites' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]).toHaveProperty('id');
  });

  it('GET /api/sites/:id returns site manifest', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sites/example.com' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe('example.com');
  });

  it('GET /api/sites/:id returns 404 for unknown site', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sites/unknown.com' });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body).toHaveProperty('error');
  });

  // ─── Skills ───────────────────────────────────────────────────

  it('GET /api/sites/:id/skills returns skill list', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sites/example.com/skills' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  // ─── Execute Skill ────────────────────────────────────────────

  it('POST /api/sites/:id/skills/:name returns confirmation_required for unconfirmed skill', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sites/example.com/skills/get_users',
      payload: { params: { page: 1 } },
    });
    // All unconfirmed skills now require confirmation before execution
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe('confirmation_required');
  });

  it('POST /api/sites/:id/skills/:name returns 404 for unknown skill', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sites/example.com/skills/nonexistent',
      payload: { params: {} },
    });
    expect(res.statusCode).toBe(404);
  });

  // ─── Dry Run ──────────────────────────────────────────────────

  it('POST /api/sites/:id/skills/:name/dry-run returns preview', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sites/example.com/skills/get_users/dry-run',
      payload: { params: { page: 1 } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('note');
    expect(body.note).toContain('preview');
  });

  it('POST dry-run for unknown skill returns 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sites/example.com/skills/nonexistent/dry-run',
      payload: { params: {} },
    });
    expect(res.statusCode).toBe(404);
  });

  // ─── Validate ─────────────────────────────────────────────────

  it('POST /api/sites/:id/skills/:name/validate validates skill', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sites/example.com/skills/get_users/validate',
      payload: { params: { page: 1 } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('success');
  });

  // ─── Explore ──────────────────────────────────────────────────

  it('POST /api/explore starts exploration', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/explore',
      payload: { url: 'https://example.com' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('sessionId');
    expect(body).toHaveProperty('siteId');
  });

  it('POST /api/explore requires url', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/explore',
      payload: {},
    });
    // Fastify schema validation rejects it
    expect(res.statusCode).toBe(400);
  });

  // ─── Record ───────────────────────────────────────────────────

  it('POST /api/record starts recording', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/record',
      payload: { name: 'test_action' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('POST /api/record requires name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/record',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  // ─── Stop ─────────────────────────────────────────────────────

  it('POST /api/stop stops recording', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/stop',
    });
    expect(res.statusCode).toBe(200);
  });

  // ─── OpenAPI Spec ─────────────────────────────────────────────

  it('GET /api/openapi.json returns spec', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/openapi.json' });
    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec).toHaveProperty('openapi');
    expect(spec.openapi).toBe('3.1.0');
    expect(spec).toHaveProperty('info');
    expect(spec).toHaveProperty('paths');
  });

  // ─── Docs ─────────────────────────────────────────────────────

  it('GET /api/docs returns HTML', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/docs' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('swagger-ui');
  });

  // ─── Audit ────────────────────────────────────────────────────

  it('GET /api/audit returns audit data', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/audit' });
    expect(res.statusCode).toBe(200);
  });

  // ─── Status ───────────────────────────────────────────────────

  it('GET /api/status returns engine status', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('mode');
  });

  // ─── Error handling ───────────────────────────────────────────

  it('returns structured error for invalid JSON body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sites/example.com/skills/get_users',
      headers: { 'content-type': 'application/json' },
      payload: 'not json{{{',
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});
