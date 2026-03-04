import { getLogger } from '../core/logger.js';
import type { BrowserProvider, OneAgentConfig } from '../skill/types.js';
import type { AgentDatabase } from '../storage/database.js';
import { scanOpenApi } from './openapi-scanner.js';
import { scanGraphQL, graphqlToEndpoints } from './graphql-scanner.js';
import { detectPlatform, platformToEndpoints } from './platform-detector.js';
import { scanWebMcp } from './webmcp-scanner.js';
import type {
  DiscoveredEndpoint,
  DiscoveryResult,
  DiscoverySource,
  DiscoverySourceType,
} from './types.js';

const log = getLogger();

// ─── Trust Ranking ───────────────────────────────────────────────────

const TRUST_RANKING: Record<DiscoverySourceType, number> = {
  openapi: 5,
  graphql: 4,
  platform: 3,
  traffic: 2,
  webmcp: 1,
};

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Run all discovery scanners in parallel and merge results.
 *
 * Trust ranking determines endpoint priority when duplicates are found:
 * OpenAPI (5) > GraphQL (4) > Platform (3) > Traffic (2) > WebMCP (1)
 *
 * Site-declared sources (OpenAPI, WebMCP) are always preferred over
 * traffic-inferred. When both exist, declared wins; inferred supplements.
 */
export async function discoverSite(
  url: string,
  config: OneAgentConfig,
  browser?: BrowserProvider,
  db?: AgentDatabase,
  origin?: string,
): Promise<DiscoveryResult> {
  const siteId = extractSiteId(url);
  log.info({ siteId, url }, 'Starting cold-start discovery');

  // Build parallel scanner tasks
  const tasks: Promise<ScannerOutput>[] = [
    runOpenApiScanner(url),
    runGraphQLScanner(url),
    runPlatformScanner(url, browser),
  ];

  // WebMCP is feature-flagged
  if (config.features.webmcp && browser && db) {
    tasks.push(runWebMcpScanner(siteId, browser, db, origin));
  }

  // Run all scanners in parallel — failures don't block others
  const results = await Promise.allSettled(tasks);

  const sources: DiscoverySource[] = [];
  const allEndpoints: DiscoveredEndpoint[] = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      sources.push(result.value.source);
      allEndpoints.push(...result.value.endpoints);
    } else {
      log.warn({ error: result.reason }, 'Scanner failed');
    }
  }

  // Deduplicate and merge endpoints, preferring higher trust
  const endpoints = deduplicateEndpoints(allEndpoints);

  log.info(
    {
      siteId,
      sourceCount: sources.length,
      endpointCount: endpoints.length,
      foundSources: sources.filter(s => s.found).map(s => s.type),
    },
    'Cold-start discovery complete',
  );

  return {
    siteId,
    sources,
    endpoints,
    trustRanking: TRUST_RANKING,
  };
}

// ─── Scanner Wrappers ────────────────────────────────────────────────

interface ScannerOutput {
  source: DiscoverySource;
  endpoints: DiscoveredEndpoint[];
}

async function runOpenApiScanner(url: string): Promise<ScannerOutput> {
  const result = await scanOpenApi(url);
  return {
    source: {
      type: 'openapi',
      found: result.found,
      endpointCount: result.endpoints.length,
      metadata: result.specVersion ? { specVersion: result.specVersion } : undefined,
    },
    endpoints: result.endpoints,
  };
}

async function runGraphQLScanner(url: string): Promise<ScannerOutput> {
  const result = await scanGraphQL(url);
  const endpoints = graphqlToEndpoints(result);
  return {
    source: {
      type: 'graphql',
      found: result.found,
      endpointCount: endpoints.length,
      metadata: {
        queryCount: result.queries.length,
        mutationCount: result.mutations.length,
      },
    },
    endpoints,
  };
}

async function runPlatformScanner(
  url: string,
  browser?: BrowserProvider,
): Promise<ScannerOutput> {
  let html = '';
  let headers: Record<string, string> = {};

  if (browser) {
    try {
      const snapshot = await browser.snapshot();
      html = snapshot.content;
    } catch (err) {
      log.warn({ err, url }, 'Site unreachable during cold-start discovery');
    }
  }

  // If we have no HTML, attempt a fetch to get it
  if (!html) {
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
      });
      html = await resp.text();
      headers = Object.fromEntries(resp.headers.entries());
    } catch (err) {
      log.warn({ err, url }, 'Site unreachable during cold-start discovery');
    }
  }

  const result = detectPlatform(url, html, headers);
  if (result.platform === null) {
    log.info({ url }, 'No platform indicators detected');
  }
  const endpoints = platformToEndpoints(result);
  return {
    source: {
      type: 'platform',
      found: result.platform !== null,
      endpointCount: endpoints.length,
      metadata: result.platform
        ? { platform: result.platform, confidence: result.confidence }
        : undefined,
    },
    endpoints,
  };
}

async function runWebMcpScanner(
  siteId: string,
  browser: BrowserProvider,
  db: AgentDatabase,
  origin?: string,
): Promise<ScannerOutput> {
  const result = await scanWebMcp(siteId, browser, db, origin);
  const endpoints: DiscoveredEndpoint[] = result.tools.map(tool => ({
    method: 'WEBMCP',
    path: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    source: 'webmcp' as const,
    trustLevel: 1,
  }));

  return {
    source: {
      type: 'webmcp',
      found: result.available,
      endpointCount: endpoints.length,
    },
    endpoints,
  };
}

// ─── Deduplication ───────────────────────────────────────────────────

function deduplicateEndpoints(endpoints: DiscoveredEndpoint[]): DiscoveredEndpoint[] {
  // Group by method+path, keep highest trust
  const map = new Map<string, DiscoveredEndpoint>();

  // Sort by trust descending so highest trust gets inserted first
  const sorted = [...endpoints].sort((a, b) => b.trustLevel - a.trustLevel);

  for (const ep of sorted) {
    const key = `${ep.method}:${ep.path}`;
    if (!map.has(key)) {
      map.set(key, ep);
    }
    // Higher trust already in map, skip lower trust duplicate
  }

  return [...map.values()];
}

// ─── Helpers ─────────────────────────────────────────────────────────

function extractSiteId(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return url;
  }
}
