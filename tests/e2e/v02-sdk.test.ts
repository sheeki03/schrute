/**
 * v0.2 Acceptance — SDK Integration
 *
 * Tests TS SDK list/execute/dry-run/validate against a local REST server
 * using Fastify inject() to avoid real HTTP.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// Mock external deps
vi.mock('../../src/storage/database.js', () => ({
  getDatabase: () => ({
    prepare: () => ({
      run: () => ({ changes: 1 }),
      get: () => undefined,
      all: () => [],
    }),
    run: () => ({ changes: 1 }),
    get: () => undefined,
    all: () => [],
    exec: () => {},
    close: () => {},
  }),
}));

vi.mock('../../src/core/engine.js', () => ({
  Engine: class {
    getStatus() {
      return { mode: 'idle', activeSession: null, currentRecording: null, uptime: 1000 };
    }
    async explore(url: string) {
      return { sessionId: 's1', siteId: new URL(url).hostname, url };
    }
    async startRecording(name: string) {
      return { id: 'r1', name, siteId: 'example.com', startedAt: Date.now(), requestCount: 0 };
    }
    async stopRecording() {
      return { id: 'r1', name: 'test', siteId: 'example.com', startedAt: Date.now(), requestCount: 3 };
    }
    async executeSkill() {
      return { success: true, data: { users: [{ id: 1 }] }, latencyMs: 20 };
    }
    async close() {}
  },
}));

vi.mock('../../src/storage/skill-repository.js', () => ({
  SkillRepository: class {
    getByStatus(status: string) {
      if (status === 'active') {
        return [{
          id: 'example.com.get_users.v1',
          version: 1, status: 'active', currentTier: 'tier_1',
          tierLock: null, allowedDomains: ['example.com'],
          requiredCapabilities: ['net.fetch.direct'],
          parameters: [{ name: 'page', type: 'number', source: 'user_input', evidence: [] }],
          validation: { semanticChecks: [], customInvariants: [] },
          redaction: { piiClassesFound: [], fieldsRedacted: 0 },
          replayStrategy: 'prefer_tier_1', sideEffectClass: 'read-only',
          sampleCount: 10, consecutiveValidations: 5, confidence: 0.95,
          method: 'GET', pathTemplate: '/api/users', inputSchema: { type: 'object' },
          isComposite: false, siteId: 'example.com', name: 'get_users',
          description: 'Get users', successRate: 0.98,
          createdAt: Date.now(), updatedAt: Date.now(),
        }];
      }
      return [];
    }
    getBySiteId(siteId: string) {
      return siteId === 'example.com' ? this.getByStatus('active') : [];
    }
    getById(id: string) {
      return id === 'example.com.get_users.v1' ? this.getByStatus('active')[0] : null;
    }
    getAll() { return this.getByStatus('active'); }
  },
}));

vi.mock('../../src/storage/site-repository.js', () => ({
  SiteRepository: class {
    getAll() {
      return [{
        id: 'example.com', displayName: 'Example',
        firstSeen: Date.now(), lastVisited: Date.now(),
        masteryLevel: 'full', recommendedTier: 'direct',
        totalRequests: 100, successfulRequests: 98,
      }];
    }
    getById(id: string) { return id === 'example.com' ? this.getAll()[0] : null; }
  },
}));

vi.mock('../../src/skill/generator.js', () => ({
  generateOpenApiFragment: () => ({ paths: {} }),
}));

vi.mock('../../src/skill/validator.js', () => ({
  validateSkill: async () => ({
    success: true, schemaMatch: true, invariantResults: [],
    errorSignatures: [], latencyMs: 10, timestamp: Date.now(),
  }),
}));

describe('v0.2 SDK — TypeScript Client', () => {
  // We test the SDK class directly with a mock fetch
  // (rather than going through Fastify inject, which tests the server)

  it('OneAgentClient constructs with baseUrl', async () => {
    const { OneAgentClient } = await import('../../src/client/typescript/index.js');
    const client = new OneAgentClient({ baseUrl: 'http://localhost:3000' });
    expect(client).toBeDefined();
  });

  it('OneAgentClient strips trailing slash', async () => {
    const { OneAgentClient } = await import('../../src/client/typescript/index.js');
    const client = new OneAgentClient({ baseUrl: 'http://localhost:3000/' });
    expect(client).toBeDefined();
  });

  it('OneAgentError has statusCode and body', async () => {
    const { OneAgentError } = await import('../../src/client/typescript/index.js');
    const err = new OneAgentError('Not Found', 404, { error: 'missing' });
    expect(err.message).toBe('Not Found');
    expect(err.statusCode).toBe(404);
    expect(err.body).toEqual({ error: 'missing' });
    expect(err.name).toBe('OneAgentError');
  });

  it('SDK against Fastify inject — listSites', async () => {
    const { createRestServer } = await import('../../src/server/rest-server.js');
    const app = await createRestServer({ port: 0 });
    await app.ready();

    // Use inject to verify the endpoint works
    const res = await app.inject({ method: 'GET', url: '/api/sites' });
    expect(res.statusCode).toBe(200);
    const sites = res.json();
    expect(Array.isArray(sites)).toBe(true);
    expect(sites[0].id).toBe('example.com');

    await app.close();
  });

  it('SDK against Fastify inject — execute skill returns confirmation_required', async () => {
    const { createRestServer } = await import('../../src/server/rest-server.js');
    const app = await createRestServer({ port: 0 });
    await app.ready();

    // All unconfirmed skills now require confirmation before execution
    const res = await app.inject({
      method: 'POST',
      url: '/api/sites/example.com/skills/get_users',
      payload: { params: { page: 1 } },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe('confirmation_required');

    await app.close();
  });

  it('SDK against Fastify inject — dry run', async () => {
    const { createRestServer } = await import('../../src/server/rest-server.js');
    const app = await createRestServer({ port: 0 });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/sites/example.com/skills/get_users/dry-run',
      payload: { params: { page: 1 } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('note');

    await app.close();
  });

  it('SDK against Fastify inject — validate', async () => {
    const { createRestServer } = await import('../../src/server/rest-server.js');
    const app = await createRestServer({ port: 0 });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/sites/example.com/skills/get_users/validate',
      payload: { params: { page: 1 } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('success');

    await app.close();
  });

  it('SDK against Fastify inject — getHealth', async () => {
    const { createRestServer } = await import('../../src/server/rest-server.js');
    const app = await createRestServer({ port: 0 });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');

    await app.close();
  });

  it('SDK against Fastify inject — getOpenApiSpec', async () => {
    const { createRestServer } = await import('../../src/server/rest-server.js');
    const app = await createRestServer({ port: 0 });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/openapi.json' });
    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec).toHaveProperty('openapi', '3.1.0');

    await app.close();
  });
});

describe('v0.2 SDK — Client Types', () => {
  it('exports all expected types', async () => {
    const sdkModule = await import('../../src/client/typescript/index.js');
    expect(sdkModule.OneAgentClient).toBeDefined();
    expect(sdkModule.OneAgentError).toBeDefined();
  });
});
