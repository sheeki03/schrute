import { describe, it, expect } from 'vitest';
import { scanGraphQL, graphqlToEndpoints } from '../../src/discovery/graphql-scanner.js';

// ─── Mock Introspection Response ─────────────────────────────────────

const INTROSPECTION_RESPONSE = {
  data: {
    __schema: {
      queryType: { name: 'Query' },
      mutationType: { name: 'Mutation' },
      types: [
        {
          kind: 'OBJECT',
          name: 'Query',
          fields: [
            {
              name: 'users',
              description: 'List all users',
              args: [
                { name: 'limit', type: { kind: 'SCALAR', name: 'Int', ofType: null } },
                { name: 'offset', type: { kind: 'SCALAR', name: 'Int', ofType: null } },
              ],
              type: {
                kind: 'LIST',
                name: null,
                ofType: { kind: 'OBJECT', name: 'User', ofType: null },
              },
            },
            {
              name: 'user',
              args: [
                {
                  name: 'id',
                  type: {
                    kind: 'NON_NULL',
                    name: null,
                    ofType: { kind: 'SCALAR', name: 'ID', ofType: null },
                  },
                },
              ],
              type: { kind: 'OBJECT', name: 'User', ofType: null },
            },
          ],
        },
        {
          kind: 'OBJECT',
          name: 'Mutation',
          fields: [
            {
              name: 'createUser',
              args: [
                { name: 'name', type: { kind: 'SCALAR', name: 'String', ofType: null } },
                { name: 'email', type: { kind: 'SCALAR', name: 'String', ofType: null } },
              ],
              type: { kind: 'OBJECT', name: 'User', ofType: null },
            },
            {
              name: 'deleteUser',
              args: [
                {
                  name: 'id',
                  type: {
                    kind: 'NON_NULL',
                    name: null,
                    ofType: { kind: 'SCALAR', name: 'ID', ofType: null },
                  },
                },
              ],
              type: { kind: 'SCALAR', name: 'Boolean', ofType: null },
            },
          ],
        },
        {
          kind: 'OBJECT',
          name: 'User',
          fields: [
            { name: 'id', args: [], type: { kind: 'SCALAR', name: 'ID', ofType: null } },
            { name: 'name', args: [], type: { kind: 'SCALAR', name: 'String', ofType: null } },
          ],
        },
      ],
    },
  },
};

// ─── Helper ──────────────────────────────────────────────────────────

function mockGraphQLFetch(
  responses: Record<string, { ok: boolean; body: unknown }>,
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const pathname = new URL(url).pathname;
    const match = responses[pathname];

    if (!match) {
      return { ok: false, status: 404 } as Response;
    }

    return {
      ok: match.ok,
      status: match.ok ? 200 : 400,
      json: async () => match.body,
    } as Response;
  }) as typeof fetch;
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('graphql-scanner', () => {
  it('discovers GraphQL at /graphql', async () => {
    const fetchFn = mockGraphQLFetch({
      '/graphql': { ok: true, body: INTROSPECTION_RESPONSE },
    });

    const result = await scanGraphQL('https://api.example.com', undefined, fetchFn);

    expect(result.found).toBe(true);
  });

  it('extracts queries from introspection', async () => {
    const fetchFn = mockGraphQLFetch({
      '/graphql': { ok: true, body: INTROSPECTION_RESPONSE },
    });

    const result = await scanGraphQL('https://api.example.com', undefined, fetchFn);

    expect(result.queries).toHaveLength(2);
    expect(result.queries[0].name).toBe('users');
    expect(result.queries[0].type).toBe('query');
    expect(result.queries[0].args).toHaveLength(2);
    expect(result.queries[0].args[0].name).toBe('limit');
  });

  it('extracts mutations from introspection', async () => {
    const fetchFn = mockGraphQLFetch({
      '/graphql': { ok: true, body: INTROSPECTION_RESPONSE },
    });

    const result = await scanGraphQL('https://api.example.com', undefined, fetchFn);

    expect(result.mutations).toHaveLength(2);
    expect(result.mutations[0].name).toBe('createUser');
    expect(result.mutations[0].type).toBe('mutation');
  });

  it('resolves NON_NULL type wrappers', async () => {
    const fetchFn = mockGraphQLFetch({
      '/graphql': { ok: true, body: INTROSPECTION_RESPONSE },
    });

    const result = await scanGraphQL('https://api.example.com', undefined, fetchFn);

    const userQuery = result.queries.find(q => q.name === 'user');
    expect(userQuery?.args[0].type).toBe('ID!');
  });

  it('resolves LIST type wrappers', async () => {
    const fetchFn = mockGraphQLFetch({
      '/graphql': { ok: true, body: INTROSPECTION_RESPONSE },
    });

    const result = await scanGraphQL('https://api.example.com', undefined, fetchFn);

    const usersQuery = result.queries.find(q => q.name === 'users');
    expect(usersQuery?.returnType).toBe('[User]');
  });

  it('discovers GraphQL at alternate paths', async () => {
    const fetchFn = mockGraphQLFetch({
      '/api/graphql': { ok: true, body: INTROSPECTION_RESPONSE },
    });

    const result = await scanGraphQL('https://api.example.com', undefined, fetchFn);

    expect(result.found).toBe(true);
    expect(result.queries.length).toBeGreaterThan(0);
  });

  it('passes custom headers to introspection request', async () => {
    let capturedHeaders: Record<string, string> = {};

    const fetchFn = (async (_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>;
      return {
        ok: true,
        json: async () => INTROSPECTION_RESPONSE,
      } as Response;
    }) as typeof fetch;

    await scanGraphQL('https://api.example.com', { authorization: 'Bearer token' }, fetchFn);

    expect(capturedHeaders.authorization).toBe('Bearer token');
  });

  it('returns not found when introspection fails', async () => {
    const fetchFn = mockGraphQLFetch({});

    const result = await scanGraphQL('https://api.example.com', undefined, fetchFn);

    expect(result.found).toBe(false);
    expect(result.queries).toEqual([]);
    expect(result.mutations).toEqual([]);
  });

  it('handles fetch errors gracefully', async () => {
    const fetchFn = (async () => {
      throw new Error('Network error');
    }) as typeof fetch;

    const result = await scanGraphQL('https://api.example.com', undefined, fetchFn);

    expect(result.found).toBe(false);
  });

  describe('graphqlToEndpoints', () => {
    it('converts scan result to DiscoveredEndpoint format', async () => {
      const fetchFn = mockGraphQLFetch({
        '/graphql': { ok: true, body: INTROSPECTION_RESPONSE },
      });

      const result = await scanGraphQL('https://api.example.com', undefined, fetchFn);
      const endpoints = graphqlToEndpoints(result);

      expect(endpoints.length).toBe(4); // 2 queries + 2 mutations
      for (const ep of endpoints) {
        expect(ep.method).toBe('POST');
        expect(ep.source).toBe('graphql');
        expect(ep.trustLevel).toBe(4);
      }
    });

    it('returns empty array for not-found result', () => {
      const endpoints = graphqlToEndpoints({ found: false, queries: [], mutations: [] });
      expect(endpoints).toEqual([]);
    });

    it('includes operation type in path', async () => {
      const fetchFn = mockGraphQLFetch({
        '/graphql': { ok: true, body: INTROSPECTION_RESPONSE },
      });

      const result = await scanGraphQL('https://api.example.com', undefined, fetchFn);
      const endpoints = graphqlToEndpoints(result);

      const paths = endpoints.map(e => e.path);
      expect(paths).toContain('/graphql#query.users');
      expect(paths).toContain('/graphql#mutation.createUser');
    });
  });
});
