import { describe, it, expect } from 'vitest';
import {
  isGraphQL,
  extractGraphQLInfo,
  clusterByOperation,
  canReplayPersistedQuery,
} from '../../src/capture/graphql-extractor.js';
import type { StructuredRequest, StructuredRecord } from '../../src/capture/har-extractor.js';

// ─── Helpers ──────────────────────────────────────────────────────

function makeRequest(overrides: Partial<StructuredRequest> = {}): StructuredRequest {
  return {
    method: 'POST',
    url: 'https://api.example.com/graphql',
    headers: { 'content-type': 'application/json' },
    queryParams: {},
    ...overrides,
  };
}

function makeRecord(request: StructuredRequest): StructuredRecord {
  return {
    request,
    response: { status: 200, statusText: 'OK', headers: {}, contentType: undefined },
    startedAt: Date.now(),
    duration: 50,
  };
}

// ─── Tests ────────────────────────────────────────────────────────

describe('graphql-extractor', () => {
  describe('isGraphQL', () => {
    it('detects GraphQL by URL ending in /graphql', () => {
      expect(isGraphQL(makeRequest())).toBe(true);
    });

    it('detects GraphQL by URL ending in /gql', () => {
      expect(isGraphQL(makeRequest({ url: 'https://api.example.com/gql' }))).toBe(true);
    });

    it('detects GraphQL by application/graphql content type', () => {
      expect(isGraphQL(makeRequest({
        url: 'https://api.example.com/api',
        contentType: 'application/graphql',
      }))).toBe(true);
    });

    it('detects GraphQL by body with query field', () => {
      expect(isGraphQL(makeRequest({
        url: 'https://api.example.com/api',
        body: JSON.stringify({ query: '{ user { name } }' }),
      }))).toBe(true);
    });

    it('detects GraphQL by body with operationName field', () => {
      expect(isGraphQL(makeRequest({
        url: 'https://api.example.com/api',
        body: JSON.stringify({ operationName: 'GetUser' }),
      }))).toBe(true);
    });

    it('returns false for non-GraphQL request', () => {
      expect(isGraphQL(makeRequest({
        url: 'https://api.example.com/rest/users',
        body: JSON.stringify({ name: 'Alice' }),
      }))).toBe(false);
    });
  });

  describe('extractGraphQLInfo', () => {
    it('extracts operationName from body', () => {
      const req = makeRequest({
        body: JSON.stringify({
          operationName: 'GetUser',
          query: 'query GetUser($id: ID!) { user(id: $id) { name } }',
        }),
      });
      const info = extractGraphQLInfo(req);
      expect(info.operationName).toBe('GetUser');
      expect(info.operationType).toBe('query');
    });

    it('extracts mutation operation type', () => {
      const req = makeRequest({
        body: JSON.stringify({
          query: 'mutation CreateUser($input: UserInput!) { createUser(input: $input) { id } }',
        }),
      });
      const info = extractGraphQLInfo(req);
      expect(info.operationType).toBe('mutation');
      expect(info.operationName).toBe('CreateUser');
    });

    it('extracts variables', () => {
      const req = makeRequest({
        body: JSON.stringify({
          query: 'query GetUser($id: ID!) { user(id: $id) { name } }',
          variables: { id: '123' },
        }),
      });
      const info = extractGraphQLInfo(req);
      expect(info.variables).toEqual({ id: '123' });
    });

    it('detects persisted query with sha256Hash', () => {
      const req = makeRequest({
        body: JSON.stringify({
          operationName: 'GetUser',
          extensions: {
            persistedQuery: {
              version: 1,
              sha256Hash: 'abc123def456',
            },
          },
        }),
      });
      const info = extractGraphQLInfo(req);
      expect(info.isPersistedQuery).toBe(true);
      expect(info.persistedQueryHash).toBe('abc123def456');
    });

    it('returns defaults for request without body', () => {
      const info = extractGraphQLInfo(makeRequest());
      expect(info.operationName).toBeNull();
      expect(info.operationType).toBeNull();
      expect(info.query).toBeNull();
      expect(info.isPersistedQuery).toBe(false);
    });

    it('returns defaults for non-JSON body', () => {
      const info = extractGraphQLInfo(makeRequest({ body: 'not-json' }));
      expect(info.operationName).toBeNull();
    });

    it('detects implicit query type when body starts with {', () => {
      const req = makeRequest({
        body: JSON.stringify({ query: '{ user { name } }' }),
      });
      const info = extractGraphQLInfo(req);
      expect(info.operationType).toBe('query');
    });
  });

  describe('clusterByOperation', () => {
    it('clusters requests by operationName', () => {
      const records = [
        makeRecord(makeRequest({
          body: JSON.stringify({ operationName: 'GetUser', query: 'query GetUser { user { name } }' }),
        })),
        makeRecord(makeRequest({
          body: JSON.stringify({ operationName: 'GetUser', query: 'query GetUser { user { name } }' }),
        })),
        makeRecord(makeRequest({
          body: JSON.stringify({ operationName: 'ListPosts', query: 'query ListPosts { posts { title } }' }),
        })),
      ];

      const clusters = clusterByOperation(records, 'example.com');
      expect(clusters).toHaveLength(2);

      const userCluster = clusters.find(c => c.operationName === 'GetUser');
      expect(userCluster).toBeDefined();
      expect(userCluster!.requests).toHaveLength(2);
      expect(userCluster!.skillName).toContain('gql');
    });

    it('skips non-GraphQL requests', () => {
      const records = [
        makeRecord(makeRequest({
          url: 'https://api.example.com/rest/users',
          body: JSON.stringify({ name: 'Alice' }),
        })),
      ];

      const clusters = clusterByOperation(records, 'example.com');
      expect(clusters).toHaveLength(0);
    });

    it('infers variable shape across cluster', () => {
      const records = [
        makeRecord(makeRequest({
          body: JSON.stringify({
            operationName: 'GetUser',
            query: 'query GetUser($id: ID!) { user(id: $id) { name } }',
            variables: { id: '123' },
          }),
        })),
        makeRecord(makeRequest({
          body: JSON.stringify({
            operationName: 'GetUser',
            query: 'query GetUser($id: ID!) { user(id: $id) { name } }',
            variables: { id: '456' },
          }),
        })),
      ];

      const clusters = clusterByOperation(records, 'example.com');
      expect(clusters[0].variableShape).toEqual({ id: 'string' });
    });
  });

  describe('canReplayPersistedQuery', () => {
    it('allows replay when query text is present', () => {
      expect(canReplayPersistedQuery({
        operationName: 'GetUser',
        operationType: 'query',
        variables: null,
        query: 'query GetUser { user { name } }',
        isPersistedQuery: true,
        persistedQueryHash: 'abc123',
      })).toBe(true);
    });

    it('blocks replay for persisted query without query text', () => {
      expect(canReplayPersistedQuery({
        operationName: 'GetUser',
        operationType: null,
        variables: null,
        query: null,
        isPersistedQuery: true,
        persistedQueryHash: 'abc123',
      })).toBe(false);
    });

    it('allows replay for non-persisted query without text', () => {
      expect(canReplayPersistedQuery({
        operationName: null,
        operationType: null,
        variables: null,
        query: null,
        isPersistedQuery: false,
      })).toBe(true);
    });
  });
});
