import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SchruteConfig, BrowserProvider } from '../../src/skill/types.js';

// ─── Mock modules before importing ───────────────────────────────────

vi.mock('../../src/discovery/openapi-scanner.js', () => ({
  scanOpenApi: vi.fn(),
}));

vi.mock('../../src/discovery/graphql-scanner.js', () => ({
  scanGraphQL: vi.fn(),
  graphqlToEndpoints: vi.fn(),
}));

vi.mock('../../src/discovery/platform-detector.js', () => ({
  detectPlatform: vi.fn(),
  platformToEndpoints: vi.fn(),
}));

vi.mock('../../src/discovery/webmcp-scanner.js', () => ({
  scanWebMcp: vi.fn(),
}));

// Import after mocks
import { discoverSite } from '../../src/discovery/cold-start.js';
import { scanOpenApi } from '../../src/discovery/openapi-scanner.js';
import { scanGraphQL, graphqlToEndpoints } from '../../src/discovery/graphql-scanner.js';
import { detectPlatform, platformToEndpoints } from '../../src/discovery/platform-detector.js';
import { scanWebMcp } from '../../src/discovery/webmcp-scanner.js';

// ─── Config ──────────────────────────────────────────────────────────

const baseConfig: SchruteConfig = {
  dataDir: '/tmp/test',
  logLevel: 'silent',
  features: { webmcp: false, httpTransport: false },
  toolBudget: { maxToolCallsPerTask: 50, maxConcurrentCalls: 3, crossDomainCalls: false, secretsToNonAllowlisted: false },
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
  daemon: { port: 19420, autoStart: false },
  tempTtlMs: 3600000,
  gcIntervalMs: 900000,
  confirmationTimeoutMs: 30000,
  confirmationExpiryMs: 60000,
  promotionConsecutivePasses: 5,
  promotionVolatilityThreshold: 0.2,
  maxToolsPerSite: 20,
  toolShortlistK: 10,
};

// ─── Tests ───────────────────────────────────────────────────────────

describe('cold-start', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: no scanners find anything
    vi.mocked(scanOpenApi).mockResolvedValue({ found: false, endpoints: [] });
    vi.mocked(scanGraphQL).mockResolvedValue({ found: false, queries: [], mutations: [] });
    vi.mocked(graphqlToEndpoints).mockReturnValue([]);
    vi.mocked(detectPlatform).mockReturnValue({ platform: null, confidence: 0, knownEndpoints: [] });
    vi.mocked(platformToEndpoints).mockReturnValue([]);
    vi.mocked(scanWebMcp).mockResolvedValue({ available: false, tools: [] });
  });

  it('returns siteId extracted from URL', async () => {
    const result = await discoverSite('https://api.example.com/path', baseConfig);

    expect(result.siteId).toBe('api.example.com');
  });

  it('runs OpenAPI, GraphQL, and platform scanners', async () => {
    await discoverSite('https://example.com', baseConfig);

    expect(scanOpenApi).toHaveBeenCalled();
    expect(scanGraphQL).toHaveBeenCalled();
    expect(detectPlatform).toHaveBeenCalled();
  });

  it('does not run WebMCP scanner when feature is disabled', async () => {
    await discoverSite('https://example.com', baseConfig);

    expect(scanWebMcp).not.toHaveBeenCalled();
  });

  it('runs WebMCP scanner when feature is enabled and browser/db provided', async () => {
    const config = { ...baseConfig, features: { ...baseConfig.features, webmcp: true } };
    const browser = { evaluateModelContext: vi.fn() } as unknown as BrowserProvider;
    const db = {} as any;

    await discoverSite('https://example.com', config, browser, db);

    expect(scanWebMcp).toHaveBeenCalled();
  });

  it('merges endpoints from multiple sources', async () => {
    vi.mocked(scanOpenApi).mockResolvedValue({
      found: true,
      specVersion: '3.0.0',
      endpoints: [
        { method: 'GET', path: '/users', source: 'openapi', trustLevel: 5 },
      ],
    });
    vi.mocked(scanGraphQL).mockResolvedValue({
      found: true,
      queries: [{ name: 'users', type: 'query', args: [], returnType: 'User' }],
      mutations: [],
    });
    vi.mocked(graphqlToEndpoints).mockReturnValue([
      { method: 'POST', path: '/graphql#query.users', source: 'graphql', trustLevel: 4 },
    ]);

    const result = await discoverSite('https://example.com', baseConfig);

    expect(result.endpoints).toHaveLength(2);
    expect(result.sources.some(s => s.type === 'openapi' && s.found)).toBe(true);
    expect(result.sources.some(s => s.type === 'graphql' && s.found)).toBe(true);
  });

  it('deduplicates endpoints preferring higher trust', async () => {
    vi.mocked(scanOpenApi).mockResolvedValue({
      found: true,
      specVersion: '3.0.0',
      endpoints: [
        { method: 'GET', path: '/users', source: 'openapi', trustLevel: 5, description: 'OpenAPI desc' },
      ],
    });
    vi.mocked(platformToEndpoints).mockReturnValue([
      { method: 'GET', path: '/users', source: 'platform', trustLevel: 3, description: 'Platform desc' },
    ]);

    const result = await discoverSite('https://example.com', baseConfig);

    const usersEndpoint = result.endpoints.find(e => e.method === 'GET' && e.path === '/users');
    expect(usersEndpoint).toBeDefined();
    expect(usersEndpoint!.source).toBe('openapi');
    expect(usersEndpoint!.trustLevel).toBe(5);
  });

  it('includes trust ranking in result', async () => {
    const result = await discoverSite('https://example.com', baseConfig);

    expect(result.trustRanking.openapi).toBe(5);
    expect(result.trustRanking.graphql).toBe(4);
    expect(result.trustRanking.platform).toBe(3);
    expect(result.trustRanking.traffic).toBe(2);
    expect(result.trustRanking.webmcp).toBe(1);
  });

  it('handles scanner failures gracefully via Promise.allSettled', async () => {
    vi.mocked(scanOpenApi).mockRejectedValue(new Error('OpenAPI crash'));
    vi.mocked(scanGraphQL).mockResolvedValue({
      found: true,
      queries: [{ name: 'test', type: 'query', args: [], returnType: 'String' }],
      mutations: [],
    });
    vi.mocked(graphqlToEndpoints).mockReturnValue([
      { method: 'POST', path: '/graphql#query.test', source: 'graphql', trustLevel: 4 },
    ]);

    const result = await discoverSite('https://example.com', baseConfig);

    // Should still get GraphQL results despite OpenAPI failure
    expect(result.endpoints.length).toBeGreaterThan(0);
    expect(result.endpoints[0].source).toBe('graphql');
  });

  it('returns empty endpoints when no scanners find anything', async () => {
    const result = await discoverSite('https://example.com', baseConfig);

    expect(result.endpoints).toEqual([]);
    expect(result.sources.every(s => !s.found)).toBe(true);
  });

  it('reports correct source metadata', async () => {
    vi.mocked(scanOpenApi).mockResolvedValue({
      found: true,
      specVersion: '3.1.0',
      endpoints: [
        { method: 'GET', path: '/health', source: 'openapi', trustLevel: 5 },
      ],
    });

    const result = await discoverSite('https://example.com', baseConfig);

    const openapiSource = result.sources.find(s => s.type === 'openapi');
    expect(openapiSource?.found).toBe(true);
    expect(openapiSource?.endpointCount).toBe(1);
    expect(openapiSource?.metadata?.specVersion).toBe('3.1.0');
  });
});
