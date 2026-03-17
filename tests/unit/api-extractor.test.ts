import { describe, it, expect } from 'vitest';
import {
  parameterizePath,
  clusterEndpoints,
  scoreAndRankClusters,
  type EndpointCluster,
} from '../../src/capture/api-extractor.js';
import { generateActionName } from '../../src/skill/generator.js';
import type { StructuredRecord } from '../../src/capture/har-extractor.js';

// ─── Helpers ──────────────────────────────────────────────────────

function makeRecord(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  queryParams: Record<string, string> = {},
  body?: string,
): StructuredRecord {
  return {
    request: {
      method,
      url,
      headers,
      body,
      contentType: body ? 'application/json' : undefined,
      queryParams,
    },
    response: {
      status: 200,
      statusText: 'OK',
      headers: {},
      body: undefined,
      contentType: undefined,
    },
    startedAt: Date.now(),
    duration: 50,
  };
}

// ─── Tests ────────────────────────────────────────────────────────

describe('api-extractor', () => {
  describe('parameterizePath', () => {
    it('replaces numeric IDs with {id}', () => {
      expect(parameterizePath('/users/123')).toBe('/users/{id}');
    });

    it('replaces UUIDs with {uuid}', () => {
      expect(parameterizePath('/items/550e8400-e29b-41d4-a716-446655440000'))
        .toBe('/items/{uuid}');
    });

    it('replaces hex hashes with {hash}', () => {
      expect(parameterizePath('/blobs/abcdef1234567890abcdef'))
        .toBe('/blobs/{hash}');
    });

    it('replaces long base64 IDs with {id}', () => {
      // 24-char base64 string
      expect(parameterizePath('/docs/YWJjZGVmZ2hpamtsbW5vcHFy'))
        .toBe('/docs/{id}');
    });

    it('preserves non-ID segments', () => {
      expect(parameterizePath('/api/v2/users')).toBe('/api/v2/users');
    });

    it('handles multiple parameterized segments', () => {
      expect(parameterizePath('/orgs/42/users/99/posts'))
        .toBe('/orgs/{id}/users/{id}/posts');
    });

    it('handles empty path segments', () => {
      expect(parameterizePath('//double//slash')).toBe('//double//slash');
    });

    it('preserves root path', () => {
      expect(parameterizePath('/')).toBe('/');
    });
  });

  describe('clusterEndpoints', () => {
    it('clusters requests with the same method and parameterized path', () => {
      const records = [
        makeRecord('GET', 'https://api.example.com/users/1'),
        makeRecord('GET', 'https://api.example.com/users/2'),
        makeRecord('GET', 'https://api.example.com/users/3'),
      ];

      const clusters = clusterEndpoints(records);
      expect(clusters).toHaveLength(1);
      expect(clusters[0].method).toBe('GET');
      expect(clusters[0].pathTemplate).toBe('/users/{id}');
      expect(clusters[0].requests).toHaveLength(3);
    });

    it('separates different HTTP methods into distinct clusters', () => {
      const records = [
        makeRecord('GET', 'https://api.example.com/users/1'),
        makeRecord('POST', 'https://api.example.com/users/1'),
      ];

      const clusters = clusterEndpoints(records);
      expect(clusters).toHaveLength(2);
      const methods = clusters.map(c => c.method).sort();
      expect(methods).toEqual(['GET', 'POST']);
    });

    it('separates different path templates into distinct clusters', () => {
      const records = [
        makeRecord('GET', 'https://api.example.com/users/1'),
        makeRecord('GET', 'https://api.example.com/posts/1'),
      ];

      const clusters = clusterEndpoints(records);
      expect(clusters).toHaveLength(2);
      const templates = clusters.map(c => c.pathTemplate).sort();
      expect(templates).toEqual(['/posts/{id}', '/users/{id}']);
    });

    it('extracts common headers across all requests in a cluster', () => {
      const records = [
        makeRecord('GET', 'https://api.example.com/users/1', { 'x-custom': 'val', accept: 'application/json' }),
        makeRecord('GET', 'https://api.example.com/users/2', { 'x-custom': 'val', accept: 'application/json' }),
      ];

      const clusters = clusterEndpoints(records);
      expect(clusters[0].commonHeaders).toHaveProperty('x-custom', 'val');
      expect(clusters[0].commonHeaders).toHaveProperty('accept', 'application/json');
    });

    it('does not include skip-listed headers in common headers', () => {
      const records = [
        makeRecord('GET', 'https://api.example.com/users/1', { 'user-agent': 'Mozilla/5.0', 'x-custom': 'val' }),
        makeRecord('GET', 'https://api.example.com/users/2', { 'user-agent': 'Mozilla/5.0', 'x-custom': 'val' }),
      ];

      const clusters = clusterEndpoints(records);
      expect(clusters[0].commonHeaders).not.toHaveProperty('user-agent');
      expect(clusters[0].commonHeaders).toHaveProperty('x-custom', 'val');
    });

    it('extracts common query params', () => {
      const records = [
        makeRecord('GET', 'https://api.example.com/search', {}, { q: 'foo', page: '1' }),
        makeRecord('GET', 'https://api.example.com/search', {}, { q: 'bar', page: '2' }),
      ];

      const clusters = clusterEndpoints(records);
      expect(clusters[0].commonQueryParams).toContain('q');
      expect(clusters[0].commonQueryParams).toContain('page');
    });

    it('infers body shape from JSON bodies', () => {
      const records = [
        makeRecord('POST', 'https://api.example.com/users', {}, {}, JSON.stringify({ name: 'Alice', age: 30 })),
        makeRecord('POST', 'https://api.example.com/users', {}, {}, JSON.stringify({ name: 'Bob', age: 25 })),
      ];

      const clusters = clusterEndpoints(records);
      expect(clusters[0].bodyShape).toEqual({ name: 'string', age: 'number' });
    });

    it('returns empty clusters for empty input', () => {
      expect(clusterEndpoints([])).toEqual([]);
    });

    it('skips records with invalid URLs', () => {
      const records = [
        makeRecord('GET', 'not-a-url'),
        makeRecord('GET', 'https://api.example.com/users/1'),
      ];

      const clusters = clusterEndpoints(records);
      expect(clusters).toHaveLength(1);
      expect(clusters[0].requests).toHaveLength(1);
    });

    it('separates same path template on different hosts into distinct clusters', () => {
      const records = [
        makeRecord('GET', 'https://api.coingecko.com/api/v3/coins/bitcoin'),
        makeRecord('GET', 'https://www.coingecko.com/api/v3/coins/ethereum'),
      ];

      const clusters = clusterEndpoints(records);
      expect(clusters).toHaveLength(2);
      const hosts = clusters.map(c => c.canonicalHost).sort();
      expect(hosts).toEqual(['api.coingecko.com', 'www.coingecko.com']);
    });

    it('clusters include canonicalHost field matching the request hostname', () => {
      const records = [
        makeRecord('GET', 'https://api.example.com/users/1'),
        makeRecord('GET', 'https://api.example.com/users/2'),
      ];

      const clusters = clusterEndpoints(records);
      expect(clusters).toHaveLength(1);
      expect(clusters[0].canonicalHost).toBe('api.example.com');
    });

    it('produces distinct clusters for api.eu and api.us subdomains', () => {
      const records = [
        makeRecord('GET', 'https://api.eu.example.com/data/123'),
        makeRecord('GET', 'https://api.us.example.com/data/456'),
      ];

      const clusters = clusterEndpoints(records);
      expect(clusters).toHaveLength(2);
      const hosts = clusters.map(c => c.canonicalHost).sort();
      expect(hosts).toEqual(['api.eu.example.com', 'api.us.example.com']);
    });
  });

  describe('generateActionName host disambiguation', () => {
    it('returns base name when canonicalHost matches siteId', () => {
      expect(generateActionName('GET', '/coins/{id}', 'www.coingecko.com', 'www.coingecko.com'))
        .toBe('get_coins');
    });

    it('prefixes with subdomain when canonicalHost differs from siteId', () => {
      expect(generateActionName('GET', '/coins/{id}', 'api.coingecko.com', 'www.coingecko.com'))
        .toBe('api_get_coins');
    });

    it('handles multi-level subdomain disambiguation', () => {
      expect(generateActionName('GET', '/data', 'api.eu.example.com', 'www.example.com'))
        .toBe('api_eu_get_data');
      expect(generateActionName('GET', '/data', 'api.us.example.com', 'www.example.com'))
        .toBe('api_us_get_data');
    });

    it('produces distinct names for api.eu vs api.us', () => {
      const euName = generateActionName('GET', '/data', 'api.eu.example.com', 'www.example.com');
      const usName = generateActionName('GET', '/data', 'api.us.example.com', 'www.example.com');
      expect(euName).not.toBe(usName);
    });

    it('returns base name when no canonicalHost provided', () => {
      expect(generateActionName('GET', '/users/{id}')).toBe('get_users');
    });
  });

  describe('scoreAndRankClusters', () => {
    it('returns the top N clusters sorted by utility score', () => {
      const clusters: EndpointCluster[] = [
        {
          method: 'GET',
          pathTemplate: '/coins/bitcoin',
          canonicalHost: 'api.example.com',
          requests: [
            makeRecord('GET', 'https://api.example.com/coins/bitcoin', { authorization: 'Bearer token' }),
          ],
          commonHeaders: { authorization: 'Bearer token' },
          commonQueryParams: [],
        },
        {
          method: 'POST',
          pathTemplate: '/user/preferences',
          canonicalHost: 'api.example.com',
          requests: [
            makeRecord('POST', 'https://api.example.com/user/preferences', {}, {}, JSON.stringify({ theme: 'dark', locale: 'en' })),
            makeRecord('POST', 'https://api.example.com/user/preferences', {}, {}, JSON.stringify({ theme: 'light', locale: 'fr' })),
          ],
          commonHeaders: {},
          commonQueryParams: [],
          bodyShape: { theme: 'string', locale: 'string' },
        },
        {
          method: 'HEAD',
          pathTemplate: '/health',
          canonicalHost: 'api.example.com',
          requests: [
            makeRecord('HEAD', 'https://api.example.com/health'),
          ],
          commonHeaders: {},
          commonQueryParams: [],
        },
      ];

      const ranked = scoreAndRankClusters(clusters, 2);

      expect(ranked).toHaveLength(2);
      expect(ranked[0].utilityScore).toBeGreaterThanOrEqual(ranked[1].utilityScore);
      expect(ranked.map(cluster => cluster.pathTemplate)).toEqual([
        '/user/preferences',
        '/coins/bitcoin',
      ]);
    });

    it('applies a penalty to garbage terminal segments', () => {
      const useful: EndpointCluster = {
        method: 'GET',
        pathTemplate: '/coins/markets',
        canonicalHost: 'api.example.com',
        requests: [makeRecord('GET', 'https://api.example.com/coins/markets')],
        commonHeaders: {},
        commonQueryParams: [],
      };
      const garbage: EndpointCluster = {
        method: 'GET',
        pathTemplate: '/get_b3djqiyguqx6fumTOKENVALUE',
        canonicalHost: 'api.example.com',
        requests: [makeRecord('GET', 'https://api.example.com/get_b3djqiyguqx6fumTOKENVALUE')],
        commonHeaders: {},
        commonQueryParams: [],
      };

      const [usefulRank, garbageRank] = scoreAndRankClusters([useful, garbage], 2);

      expect(usefulRank.pathTemplate).toBe('/coins/markets');
      expect(garbageRank.pathTemplate).toBe('/get_b3djqiyguqx6fumTOKENVALUE');
      expect(usefulRank.utilityScore).toBeGreaterThan(garbageRank.utilityScore);
    });

    it('returns deterministic ordering when scores tie', () => {
      const clusters: EndpointCluster[] = [
        {
          method: 'GET',
          pathTemplate: '/zeta',
          canonicalHost: 'api.example.com',
          requests: [makeRecord('GET', 'https://api.example.com/zeta')],
          commonHeaders: {},
          commonQueryParams: [],
        },
        {
          method: 'GET',
          pathTemplate: '/alpha',
          canonicalHost: 'api.example.com',
          requests: [makeRecord('GET', 'https://api.example.com/alpha')],
          commonHeaders: {},
          commonQueryParams: [],
        },
      ];

      const ranked = scoreAndRankClusters(clusters, 2);

      expect(ranked.map(cluster => cluster.pathTemplate)).toEqual(['/alpha', '/zeta']);
    });

    it('preserves canonicalHost through scoring', () => {
      const clusters: EndpointCluster[] = [
        {
          method: 'GET',
          pathTemplate: '/coins/{id}',
          canonicalHost: 'api.coingecko.com',
          requests: [makeRecord('GET', 'https://api.coingecko.com/coins/bitcoin')],
          commonHeaders: {},
          commonQueryParams: [],
        },
        {
          method: 'GET',
          pathTemplate: '/coins/{id}',
          canonicalHost: 'pro-api.coingecko.com',
          requests: [makeRecord('GET', 'https://pro-api.coingecko.com/coins/bitcoin', { authorization: 'Bearer token' })],
          commonHeaders: { authorization: 'Bearer token' },
          commonQueryParams: [],
        },
      ];

      const ranked = scoreAndRankClusters(clusters, 2);
      expect(ranked).toHaveLength(2);
      const hosts = ranked.map(c => c.canonicalHost).sort();
      expect(hosts).toEqual(['api.coingecko.com', 'pro-api.coingecko.com']);
    });
  });
});
