import { describe, it, expect, vi } from 'vitest';
import { scanOpenApi } from '../../src/discovery/openapi-scanner.js';

// ─── Mock Specs ──────────────────────────────────────────────────────

const OPENAPI_3_SPEC = {
  openapi: '3.0.3',
  info: { title: 'Test API', version: '1.0.0' },
  paths: {
    '/users': {
      get: {
        summary: 'List users',
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
        ],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: { type: 'array', items: { type: 'object' } },
              },
            },
          },
        },
      },
      post: {
        summary: 'Create user',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { name: { type: 'string' }, email: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          '201': {
            content: {
              'application/json': {
                schema: { type: 'object' },
              },
            },
          },
        },
      },
    },
    '/users/{id}': {
      get: {
        summary: 'Get user by ID',
        parameters: [{ name: 'id', in: 'path', schema: { type: 'string' } }],
        responses: { '200': {} },
      },
      delete: {
        summary: 'Delete user',
        responses: { '204': {} },
      },
    },
  },
};

const SWAGGER_2_SPEC = {
  swagger: '2.0',
  info: { title: 'Legacy API', version: '1.0.0' },
  basePath: '/api/v1',
  paths: {
    '/items': {
      get: {
        summary: 'List items',
        parameters: [
          { name: 'q', in: 'query', type: 'string' },
        ],
        responses: {
          '200': { schema: { type: 'array' } },
        },
      },
      post: {
        summary: 'Create item',
        parameters: [
          { name: 'body', in: 'body', schema: { type: 'object' } },
        ],
        responses: {
          '201': { schema: { type: 'object' } },
        },
      },
    },
  },
};

// ─── Helper ──────────────────────────────────────────────────────────

function mockFetch(responses: Record<string, { ok: boolean; body: unknown }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const pathname = new URL(url).pathname;
    const match = responses[pathname];

    if (!match) {
      return { ok: false, status: 404, text: async () => 'Not Found' } as Response;
    }

    return {
      ok: match.ok,
      status: match.ok ? 200 : 404,
      text: async () => JSON.stringify(match.body),
      json: async () => match.body,
    } as Response;
  }) as typeof fetch;
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('openapi-scanner', () => {
  it('discovers OpenAPI 3.x spec at /openapi.json', async () => {
    const fetchFn = mockFetch({
      '/openapi.json': { ok: true, body: OPENAPI_3_SPEC },
    });

    const result = await scanOpenApi('https://api.example.com', fetchFn);

    expect(result.found).toBe(true);
    expect(result.specVersion).toBe('3.0.3');
    expect(result.endpoints.length).toBeGreaterThan(0);
  });

  it('extracts endpoints with correct methods from OpenAPI 3.x', async () => {
    const fetchFn = mockFetch({
      '/openapi.json': { ok: true, body: OPENAPI_3_SPEC },
    });

    const result = await scanOpenApi('https://api.example.com', fetchFn);

    const methods = result.endpoints.map(e => `${e.method} ${e.path}`);
    expect(methods).toContain('GET /users');
    expect(methods).toContain('POST /users');
    expect(methods).toContain('GET /users/{id}');
    expect(methods).toContain('DELETE /users/{id}');
  });

  it('extracts parameters from OpenAPI 3.x', async () => {
    const fetchFn = mockFetch({
      '/openapi.json': { ok: true, body: OPENAPI_3_SPEC },
    });

    const result = await scanOpenApi('https://api.example.com', fetchFn);

    const listUsers = result.endpoints.find(e => e.method === 'GET' && e.path === '/users');
    expect(listUsers?.parameters).toBeDefined();
    expect(listUsers!.parameters).toHaveLength(2);
    expect(listUsers!.parameters![0].name).toBe('page');
    expect(listUsers!.parameters![0].in).toBe('query');
  });

  it('extracts inputSchema from OpenAPI 3.x requestBody', async () => {
    const fetchFn = mockFetch({
      '/openapi.json': { ok: true, body: OPENAPI_3_SPEC },
    });

    const result = await scanOpenApi('https://api.example.com', fetchFn);

    const createUser = result.endpoints.find(e => e.method === 'POST' && e.path === '/users');
    expect(createUser?.inputSchema).toBeDefined();
    expect(createUser!.inputSchema!.type).toBe('object');
  });

  it('sets trustLevel=5 for OpenAPI endpoints', async () => {
    const fetchFn = mockFetch({
      '/openapi.json': { ok: true, body: OPENAPI_3_SPEC },
    });

    const result = await scanOpenApi('https://api.example.com', fetchFn);

    for (const ep of result.endpoints) {
      expect(ep.trustLevel).toBe(5);
      expect(ep.source).toBe('openapi');
    }
  });

  it('discovers Swagger 2.0 spec with basePath', async () => {
    const fetchFn = mockFetch({
      '/swagger.json': { ok: true, body: SWAGGER_2_SPEC },
    });

    const result = await scanOpenApi('https://api.example.com', fetchFn);

    expect(result.found).toBe(true);
    expect(result.specVersion).toBe('2.0');

    const paths = result.endpoints.map(e => e.path);
    expect(paths).toContain('/api/v1/items');
  });

  it('extracts body schema from Swagger 2.0', async () => {
    const fetchFn = mockFetch({
      '/swagger.json': { ok: true, body: SWAGGER_2_SPEC },
    });

    const result = await scanOpenApi('https://api.example.com', fetchFn);

    const createItem = result.endpoints.find(e => e.method === 'POST');
    expect(createItem?.inputSchema).toBeDefined();
  });

  it('probes multiple paths and returns first match', async () => {
    const fetchFn = mockFetch({
      '/v3/api-docs': { ok: true, body: OPENAPI_3_SPEC },
    });

    const result = await scanOpenApi('https://api.example.com', fetchFn);

    expect(result.found).toBe(true);
    expect(result.specVersion).toBe('3.0.3');
  });

  it('returns not found when no spec is available', async () => {
    const fetchFn = mockFetch({});

    const result = await scanOpenApi('https://api.example.com', fetchFn);

    expect(result.found).toBe(false);
    expect(result.endpoints).toEqual([]);
  });

  it('handles fetch errors gracefully', async () => {
    const fetchFn = (async () => {
      throw new Error('Network error');
    }) as typeof fetch;

    const result = await scanOpenApi('https://api.example.com', fetchFn);

    expect(result.found).toBe(false);
    expect(result.endpoints).toEqual([]);
  });

  it('skips non-JSON responses', async () => {
    const fetchFn = (async () => ({
      ok: true,
      text: async () => '<html>Not a spec</html>',
    })) as typeof fetch;

    const result = await scanOpenApi('https://api.example.com', fetchFn);

    expect(result.found).toBe(false);
  });

  it('handles trailing slashes in baseUrl', async () => {
    const fetchFn = mockFetch({
      '/openapi.json': { ok: true, body: OPENAPI_3_SPEC },
    });

    const result = await scanOpenApi('https://api.example.com/', fetchFn);

    expect(result.found).toBe(true);
  });
});
