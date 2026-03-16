import { getLogger } from '../core/logger.js';
import { isParamRequired, type BrowserProvider, type SchruteConfig, type SkillParameter } from '../skill/types.js';
import type { AgentDatabase } from '../storage/database.js';
import { scanOpenApi, PROBE_PATHS } from './openapi-scanner.js';
import { scanGraphQL, graphqlToEndpoints, GRAPHQL_PATHS } from './graphql-scanner.js';
import { detectPlatform, platformToEndpoints } from './platform-detector.js';
import { scanWebMcp } from './webmcp-scanner.js';
import type { SkillRepository } from '../storage/skill-repository.js';
import { generateSkill, generateActionName } from '../skill/generator.js';
import { extractDocument } from '../capture/document-extractor.js';
import { extractUrlsFromHtml } from './html-url-extractor.js';
import type {
  DiscoveredEndpoint,
  DiscoveryResult,
  DiscoverySource,
  DiscoverySourceType,
} from './types.js';
import type { CrawledPage } from './managed-crawl.js';
import type { RobotsPolicy } from './robots.js';
import { scanSitemap } from './sitemap-scanner.js';

/**
 * Optional factory for creating a scrape-optimized browser context.
 * When provided, used to render pages that may require JavaScript execution.
 * Typically backed by BrowserManager.createScrapeContext().
 */
type ScrapeContextFactory = (siteId: string) => Promise<{
  context: {
    newPage(): Promise<{
      goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
      content(): Promise<string>;
      close(): Promise<void>;
    }>;
  };
  close(): Promise<void>;
}>;

const log = getLogger();

// ─── Trust Ranking ───────────────────────────────────────────────────

const TRUST_RANKING: Record<DiscoverySourceType, number> = {
  openapi: 5,
  graphql: 4,
  platform: 3,
  traffic: 2,
  sitemap: 2,
  webmcp: 1,
  'devtools-mcp': 1,
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
  config: SchruteConfig,
  browser?: BrowserProvider,
  db?: AgentDatabase,
  origin?: string,
  scrapeContextFactory?: ScrapeContextFactory,
): Promise<DiscoveryResult> {
  const siteId = extractSiteId(url);
  log.info({ siteId, url }, 'Starting cold-start discovery');

  // robots.txt integration
  let robotsPolicy: RobotsPolicy | undefined;
  if (config.features.respectRobotsTxt) {
    try {
      const { fetchRobotsPolicy } = await import('./robots.js');
      robotsPolicy = await fetchRobotsPolicy(url);
      if (robotsPolicy.crawlDelay) {
        log.info({ siteId, crawlDelay: robotsPolicy.crawlDelay }, 'robots.txt crawl-delay detected');
      }
    } catch (err) {
      log.debug({ err }, 'robots.txt fetch failed — allowing all');
    }
  }

  // Build parallel scanner tasks — respect robots.txt per probe path
  const tasks: Promise<ScannerOutput>[] = [];
  const robotsFilter = robotsPolicy ? (p: string) => robotsPolicy!.isAllowed(p) : undefined;

  // OpenAPI scanner — pass robots filter so each PROBE_PATH is individually checked
  if (!robotsFilter || PROBE_PATHS.some(robotsFilter)) {
    tasks.push(runOpenApiScanner(url, robotsFilter));
  } else {
    log.info({ siteId }, 'Skipping OpenAPI scanner — all probe paths blocked by robots.txt');
  }

  // GraphQL scanner — pass robots filter so each GRAPHQL_PATH is individually checked
  if (!robotsFilter || GRAPHQL_PATHS.some(robotsFilter)) {
    tasks.push(runGraphQLScanner(url, robotsFilter));
  } else {
    log.info({ siteId }, 'Skipping GraphQL scanner — all probe paths blocked by robots.txt');
  }

  // Platform scanner fetches the base URL — check that path
  const basePath = new URL(url).pathname || '/';
  if (!robotsPolicy || robotsPolicy.isAllowed(basePath)) {
    tasks.push(runPlatformScanner(url, browser));
  } else {
    log.info({ siteId }, 'Skipping platform scanner — base path blocked by robots.txt');
  }

  // WebMCP is feature-flagged
  if (config.features.webmcp && browser && db) {
    tasks.push(runWebMcpScanner(siteId, browser, db, origin));
  }

  // Sitemap scanner — discovers URLs for second-stage probing
  if (config.features.sitemapDiscovery) {
    tasks.push(runSitemapScanner(url, robotsPolicy));
  }

  // Run all scanners in parallel — failures don't block others
  const results = await Promise.allSettled(tasks);

  const sources: DiscoverySource[] = [];
  const allEndpoints: DiscoveredEndpoint[] = [];

  const allSeedUrls: string[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      sources.push(result.value.source);
      allEndpoints.push(...result.value.endpoints);
      if (result.value.seedUrls) allSeedUrls.push(...result.value.seedUrls);
    } else {
      log.warn({ error: result.reason }, 'Scanner failed');
    }
  }

  // Second-stage probing from seed URLs (HTML extraction, sitemap)
  if (allSeedUrls.length > 0) {
    const { scanOpenApiAt } = await import('./openapi-scanner.js');
    const { scanGraphQLAt } = await import('./graphql-scanner.js');

    const specUrls: string[] = [];
    const graphqlUrls: string[] = [];
    for (const seedUrl of [...new Set(allSeedUrls)]) {
      if (/\/(openapi|swagger|api-docs)\b.*\.(json|ya?ml)$/i.test(seedUrl)) {
        specUrls.push(seedUrl);
      } else if (/\/graphi?ql\b|\/gql\b/i.test(seedUrl)) {
        graphqlUrls.push(seedUrl);
      }
    }

    const siteOriginForSeed = new URL(url).origin;

    for (const specUrl of specUrls) {
      try {
        const specPath = new URL(specUrl).pathname;
        if (robotsPolicy && !robotsPolicy.isAllowed(specPath)) {
          log.debug({ specUrl }, 'Skipping seed spec URL — blocked by robots.txt');
          continue;
        }
        const specResult = await scanOpenApiAt(specUrl, siteOriginForSeed);
        if (specResult.found) {
          // Deduplicate: only add endpoints not already discovered by primary scanner
          const existingPaths = new Set(allEndpoints.map(ep => `${ep.method}:${ep.path}`));
          const newEndpoints = specResult.endpoints.filter(ep => !existingPaths.has(`${ep.method}:${ep.path}`));
          allEndpoints.push(...newEndpoints);
          // Create or update source entry
          const openapiSource = sources.find(s => s.type === 'openapi');
          if (openapiSource) {
            openapiSource.found = true;
            openapiSource.endpointCount += newEndpoints.length;
          } else {
            sources.push({ type: 'openapi', found: true, endpointCount: newEndpoints.length, metadata: { seedDiscovered: true } });
          }
          log.info({ specUrl, count: newEndpoints.length }, 'Seed URL yielded OpenAPI spec');
        }
      } catch (err) {
        log.debug({ err, specUrl }, 'Seed spec URL probe failed');
      }
    }

    for (const gqlUrl of graphqlUrls) {
      try {
        const gqlPath = new URL(gqlUrl).pathname;
        if (robotsPolicy && !robotsPolicy.isAllowed(gqlPath)) {
          log.debug({ gqlUrl }, 'Skipping seed GraphQL URL — blocked by robots.txt');
          continue;
        }
        const gqlResult = await scanGraphQLAt(gqlUrl, siteOriginForSeed);
        if (gqlResult.found) {
          const gqlEndpoints = graphqlToEndpoints(gqlResult);
          // Deduplicate: only add endpoints not already discovered by primary scanner
          const existingPaths = new Set(allEndpoints.map(ep => `${ep.method}:${ep.path}`));
          const newGqlEndpoints = gqlEndpoints.filter(ep => !existingPaths.has(`${ep.method}:${ep.path}`));
          allEndpoints.push(...newGqlEndpoints);
          // Create or update source entry
          const graphqlSource = sources.find(s => s.type === 'graphql');
          if (graphqlSource) {
            graphqlSource.found = true;
            graphqlSource.endpointCount += newGqlEndpoints.length;
          } else {
            sources.push({ type: 'graphql', found: true, endpointCount: newGqlEndpoints.length, metadata: { seedDiscovered: true } });
          }
          log.info({ gqlUrl, count: newGqlEndpoints.length }, 'Seed URL yielded GraphQL endpoint');
        }
      } catch (err) {
        log.debug({ err, gqlUrl }, 'Seed GraphQL URL probe failed');
      }
    }
  }

  // Managed crawl integration (if configured)
  const delayMs = robotsPolicy?.crawlDelay ? robotsPolicy.crawlDelay * 1000 : 0;
  const delay = (ms: number) => ms > 0 ? new Promise<void>(r => setTimeout(r, ms)) : Promise.resolve();

  let discoveredDocs: { markdown: string; sourceUrl: string }[] = [];
  if (config.managedCrawl) {
    try {
      const { CloudflareCrawlProvider, pollUntilComplete } = await import('./managed-crawl.js');
      const { scanOpenApiAt, parseOpenApiSpec } = await import('./openapi-scanner.js');
      const { scanGraphQLAt } = await import('./graphql-scanner.js');
      const provider = new CloudflareCrawlProvider(config.managedCrawl);
      const siteOrigin = new URL(url).origin;
      const jobId = await provider.startCrawl(url, { maxPages: config.managedCrawl.maxPages });
      const job = await pollUntilComplete(provider, jobId);
      if (job.status === 'completed' && job.pages) {
        const discovered = await extractDiscoveryFromPages(job.pages, siteOrigin, robotsPolicy, delayMs);
        // Pass spec URLs to scanOpenApiAt (respect robots.txt)
        for (const specUrl of discovered.specUrls) {
          try {
            const specPath = new URL(specUrl).pathname;
            if (robotsPolicy && !robotsPolicy.isAllowed(specPath)) {
              log.debug({ specUrl }, 'Skipping spec URL — blocked by robots.txt');
              continue;
            }
            await delay(delayMs);
            const specResult = await scanOpenApiAt(specUrl, siteOrigin);
            if (specResult.found) {
              allEndpoints.push(...specResult.endpoints);
            }
          } catch (err) {
            log.debug({ err, specUrl }, 'scanOpenApiAt failed');
          }
        }
        // Pass inline specs to parseOpenApiSpec
        for (const spec of discovered.inlineSpecs) {
          try {
            const specResult = parseOpenApiSpec(spec);
            if (specResult.found) {
              allEndpoints.push(...specResult.endpoints);
            }
          } catch (err) { log.debug({ err }, 'inline spec parse failed'); }
        }
        // Pass GraphQL URLs to scanGraphQLAt (respect robots.txt)
        for (const gqlUrl of discovered.graphqlUrls) {
          try {
            const gqlPath = new URL(gqlUrl).pathname;
            if (robotsPolicy && !robotsPolicy.isAllowed(gqlPath)) {
              log.debug({ gqlUrl }, 'Skipping GraphQL URL — blocked by robots.txt');
              continue;
            }
            await delay(delayMs);
            const gqlResult = await scanGraphQLAt(gqlUrl, siteOrigin);
            if (gqlResult.found) {
              const gqlEndpoints = graphqlToEndpoints(gqlResult);
              allEndpoints.push(...gqlEndpoints);
            }
          } catch (err) {
            log.debug({ err, gqlUrl }, 'scanGraphQLAt failed');
          }
        }
        // Collect docs (extractDiscoveryFromPages already ran extractDocument)
        discoveredDocs = discovered.docs;

        // Use scrape context for pages that need JS rendering but lack HTML
        if (scrapeContextFactory) {
          const pagesWithoutContent = job.pages.filter(p => !p.html && !p.markdown && p.statusCode === 200);
          if (pagesWithoutContent.length > 0) {
            try {
              const scrape = await scrapeContextFactory(siteId);
              try {
                for (const page of pagesWithoutContent) {
                  try {
                    await delay(delayMs);
                    const scrapeTab = await scrape.context.newPage();
                    await scrapeTab.goto(page.url, { waitUntil: 'networkidle', timeout: 15_000 });
                    const html = await scrapeTab.content();
                    await scrapeTab.close();
                    if (html) {
                      const docResult = await extractDocument({ type: 'html', content: html });
                      if (docResult.markdown) {
                        discoveredDocs.push({ markdown: docResult.markdown, sourceUrl: page.url });
                      }
                    }
                  } catch (err) {
                    log.debug({ err, url: page.url }, 'Scrape context page render failed');
                  }
                }
              } finally {
                await scrape.close();
              }
            } catch (err) {
              log.debug({ err }, 'Scrape context creation failed');
            }
          }
        }
      }
    } catch (err) {
      log.warn({ err }, 'Managed crawl failed, falling back to local discovery');
    }
  }

  // Filter endpoints blocked by robots.txt
  if (robotsPolicy) {
    const before = allEndpoints.length;
    const filtered = allEndpoints.filter(ep => robotsPolicy!.isAllowed(ep.path));
    const blocked = before - filtered.length;
    if (blocked > 0) {
      log.info({ siteId, blocked }, 'Filtered endpoints blocked by robots.txt');
    }
    allEndpoints.length = 0;
    allEndpoints.push(...filtered);
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
    ...(discoveredDocs.length > 0 ? { docs: discoveredDocs } : {}),
  };
}

// ─── Scanner Wrappers ────────────────────────────────────────────────

interface ScannerOutput {
  source: DiscoverySource;
  endpoints: DiscoveredEndpoint[];
  seedUrls?: string[];
}

async function runOpenApiScanner(url: string, pathFilter?: (path: string) => boolean): Promise<ScannerOutput> {
  const result = await scanOpenApi(url, fetch, pathFilter);
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

async function runGraphQLScanner(url: string, pathFilter?: (path: string) => boolean): Promise<ScannerOutput> {
  const result = await scanGraphQL(url, undefined, fetch, pathFilter);
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
  let snapshotContent = '';   // for platform detection (may be accessibility tree)
  let realHtml = '';          // for URL extraction (must be actual HTML)
  let headers: Record<string, string> = {};

  // Platform detection: use browser snapshot if available (includes JS-rendered content)
  if (browser) {
    try {
      const snapshot = await browser.snapshot();
      snapshotContent = snapshot.content;
    } catch (err) {
      log.warn({ err, url }, 'Site unreachable during cold-start discovery');
    }
  }

  // HTML fetch: always attempt for URL extraction (with SSRF guard)
  try {
    const { resolveAndValidate } = await import('../core/policy.js');
    const parsed = new URL(url);
    const ipCheck = await resolveAndValidate(parsed.hostname);
    if (ipCheck.allowed) {
      const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      realHtml = await resp.text();
      headers = Object.fromEntries(resp.headers.entries());
    }
  } catch (err) {
    log.debug({ err, url }, 'HTML fetch for URL extraction failed');
  }

  // Use best available content for platform detection
  const platformInput = snapshotContent || realHtml;
  const result = detectPlatform(url, platformInput, headers);
  if (result.platform === null) {
    log.info({ url }, 'No platform indicators detected');
  }
  const endpoints = platformToEndpoints(result);

  // F4: Extract URLs from real HTML (not snapshot)
  const seedUrls: string[] = [];
  if (realHtml) {
    const extracted = extractUrlsFromHtml(realHtml, url);
    for (const entry of extracted) {
      seedUrls.push(entry.url);
    }
  }

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
    seedUrls,
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

async function runSitemapScanner(url: string, robotsPolicy?: RobotsPolicy): Promise<ScannerOutput> {
  const result = await scanSitemap(url, fetch, robotsPolicy);
  return {
    source: {
      type: 'sitemap',
      found: result.found,
      endpointCount: 0,
      metadata: { urlCount: result.urls.length, sitemapCount: result.sitemapCount },
    },
    endpoints: [],
    seedUrls: result.urls,
  };
}

// ─── Page-Based Discovery Adapter ─────────────────────────────────────

async function extractDiscoveryFromPages(
  pages: CrawledPage[],
  siteOrigin?: string,
  robotsPolicy?: RobotsPolicy,
  crawlDelayMs = 0,
): Promise<{
  specUrls: string[];
  graphqlUrls: string[];
  inlineSpecs: Record<string, unknown>[];
  docs: { markdown: string; sourceUrl: string }[];
}> {
  const specUrls: string[] = [];
  const graphqlUrls: string[] = [];
  const inlineSpecs: Record<string, unknown>[] = [];
  const docs: { markdown: string; sourceUrl: string }[] = [];

  for (const page of pages) {
    // If the crawl provider already produced markdown, use it directly
    if (page.markdown) {
      docs.push({ markdown: page.markdown, sourceUrl: page.url });
    } else if (page.html) {
      // Convert HTML to markdown via extractDocument when the provider didn't
      try {
        const docResult = await extractDocument({ type: 'html', content: page.html });
        if (docResult.markdown) {
          docs.push({ markdown: docResult.markdown, sourceUrl: page.url });
        }
      } catch (err) {
        log.debug({ err, url: page.url }, 'extractDocument failed for crawled page');
      }
    }
    if (!page.html) continue;

    // F4: Extract URLs from all HTML attributes (replaces simple href regex)
    const extractedUrls = extractUrlsFromHtml(page.html, page.url);
    const pdfUrls: string[] = [];
    let match;
    for (const entry of extractedUrls) {
      const resolved = entry.url;
      if (/\/(openapi|swagger|api-docs)\b.*\.(json|ya?ml)$/i.test(resolved) ||
          /\.(json|ya?ml)$/i.test(resolved) && /(openapi|swagger|api-doc)/i.test(resolved)) {
        specUrls.push(resolved);
      }
      if (/\/graphi?ql\b/i.test(resolved) || /\/gql\b/i.test(resolved)) {
        graphqlUrls.push(resolved);
      }
      if (/\.pdf$/i.test(resolved)) {
        pdfUrls.push(resolved);
      }
    }

    // Fetch and extract discovered PDFs with SSRF guard + robots check
    const MAX_PDFS = 5;
    for (const pdfUrl of pdfUrls.slice(0, MAX_PDFS)) {
      try {
        const parsedPdf = new URL(pdfUrl);
        // SSRF guard: same-origin restriction
        if (siteOrigin && parsedPdf.origin !== siteOrigin) {
          log.debug({ pdfUrl, siteOrigin }, 'Skipping cross-origin PDF');
          continue;
        }
        // SSRF guard: public-IP validation
        const { resolveAndValidate } = await import('../core/policy.js');
        const ipCheck = await resolveAndValidate(parsedPdf.hostname);
        if (!ipCheck.allowed) {
          log.debug({ pdfUrl }, 'Skipping PDF — private/internal IP');
          continue;
        }
        // robots.txt check
        if (robotsPolicy && !robotsPolicy.isAllowed(parsedPdf.pathname)) {
          log.debug({ pdfUrl }, 'Skipping PDF — blocked by robots.txt');
          continue;
        }
        // Respect crawl-delay between fetches
        if (crawlDelayMs > 0) {
          await new Promise<void>(r => setTimeout(r, crawlDelayMs));
        }
        const MAX_PDF_BYTES = 20 * 1024 * 1024; // 20 MB
        const resp = await fetch(pdfUrl, { signal: AbortSignal.timeout(15_000) });
        if (resp.ok && resp.headers.get('content-type')?.includes('pdf')) {
          // Pre-flight size check via Content-Length
          const clHeader = resp.headers.get('content-length');
          if (clHeader && parseInt(clHeader, 10) > MAX_PDF_BYTES) {
            log.debug({ pdfUrl, contentLength: clHeader }, 'Skipping PDF — exceeds size limit');
            continue;
          }
          // Streamed byte-limited read for cases without Content-Length
          const reader = resp.body?.getReader();
          if (!reader) continue;
          const chunks: Uint8Array[] = [];
          let totalBytes = 0;
          let oversized = false;
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            if (totalBytes > MAX_PDF_BYTES) {
              oversized = true;
              reader.cancel();
              break;
            }
            chunks.push(value);
          }
          if (oversized) {
            log.debug({ pdfUrl, totalBytes }, 'Skipping PDF — exceeds size limit during streaming');
            continue;
          }
          const buffer = Buffer.concat(chunks);
          const docResult = await extractDocument({ type: 'pdf', buffer });
          if (docResult.markdown) {
            docs.push({ markdown: docResult.markdown, sourceUrl: pdfUrl });
          }
        }
      } catch (err) {
        log.debug({ err, pdfUrl }, 'PDF fetch/extraction failed');
      }
    }

    // Scan for inline spec <script> blocks
    const scriptRe = /<script\s+type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi;
    while ((match = scriptRe.exec(page.html)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed && typeof parsed === 'object') {
          inlineSpecs.push(parsed as Record<string, unknown>);
        }
      } catch { /* not valid JSON */ }
    }

    // Scan for GraphQL endpoint clues
    if (/graphql|\/gql\b/i.test(page.html)) {
      const gqlEndpointRe = /["'](https?:\/\/[^"']*\/graphi?ql[^"']*?)["']/gi;
      while ((match = gqlEndpointRe.exec(page.html)) !== null) {
        try {
          const resolved = new URL(match[1], page.url).href;
          graphqlUrls.push(resolved);
        } catch { /* invalid URL */ }
      }
    }
  }

  return {
    specUrls: [...new Set(specUrls)],
    graphqlUrls: [...new Set(graphqlUrls)],
    inlineSpecs,
    docs,
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

// ─── Discovery Import Bridge ─────────────────────────────────────────

const PARAM_KEY_PATTERN = /^[a-zA-Z0-9_.-]{1,64}$/;

function isRepresentable(endpoint: DiscoveredEndpoint): boolean {
  const method = endpoint.method.toUpperCase();
  const params = endpoint.parameters ?? [];

  // Reject header, cookie, formData params
  if (params.some(p => p.in === 'header' || p.in === 'cookie' || p.in === 'formData')) return false;

  // Reject non-MCP-safe param names
  if (params.some(p => !PARAM_KEY_PATTERN.test(p.name))) return false;

  // Reject non-scalar path/query params
  const NON_SCALAR = new Set(['array', 'object']);
  if (params.some(p => (p.in === 'path' || p.in === 'query') && NON_SCALAR.has(p.type))) return false;

  // POST/PUT/PATCH with query params → misplaced by replay
  if (['POST', 'PUT', 'PATCH'].includes(method) && params.some(p => p.in === 'query')) return false;

  // DELETE/OPTIONS with non-path params → silently dropped
  if (['DELETE', 'OPTIONS'].includes(method) && params.some(p => p.in !== 'path')) return false;

  // GET/HEAD with inputSchema → replay can't emit body
  if (['GET', 'HEAD'].includes(method) && endpoint.inputSchema) return false;

  // DELETE/OPTIONS with inputSchema → no handling
  if (['DELETE', 'OPTIONS'].includes(method) && endpoint.inputSchema) return false;

  // Non-JSON body
  if (endpoint._hasNonJsonBody) return false;

  // Unresolved $ref/allOf/anyOf/oneOf
  if (endpoint._hasUnresolvedRefs) return false;

  // Validate inputSchema shape
  if (endpoint.inputSchema) {
    const schema = endpoint.inputSchema;
    // Reject array bodies
    if (schema.type === 'array') return false;
    // Reject scalar bodies
    if (['string', 'number', 'integer', 'boolean'].includes(schema.type as string)) return false;
    // Reject schemas with no properties
    if (!schema.properties || typeof schema.properties !== 'object') return false;
    // Validate property names
    const props = schema.properties as Record<string, unknown>;
    if (Object.keys(props).some(k => !PARAM_KEY_PATTERN.test(k))) return false;
  }

  return true;
}

function endpointParamsToSkillParams(endpoint: DiscoveredEndpoint): SkillParameter[] {
  const params: SkillParameter[] = [];
  const seen = new Set<string>();

  // From endpoint.parameters
  if (endpoint.parameters) {
    for (const p of endpoint.parameters) {
      if (p.in === 'header' || p.in === 'cookie') continue;
      seen.add(p.name);
      const sp: SkillParameter = {
        name: p.name,
        type: p.type || 'string',
        source: 'user_input',
        evidence: [],
        required: p.in === 'path' ? true : (p.required ?? false),
      };
      // Normalize via isParamRequired to stay consistent with the rest of the codebase
      sp.required = isParamRequired(sp);
      params.push(sp);
    }
  }

  // From inputSchema.properties
  if (endpoint.inputSchema?.properties && typeof endpoint.inputSchema.properties === 'object') {
    const props = endpoint.inputSchema.properties as Record<string, Record<string, unknown>>;
    const requiredList = Array.isArray(endpoint.inputSchema.required)
      ? (endpoint.inputSchema.required as string[])
      : [];
    for (const [name, schema] of Object.entries(props)) {
      if (seen.has(name)) continue;
      const sp: SkillParameter = {
        name,
        type: (schema?.type as string) ?? 'string',
        source: 'user_input',
        evidence: [],
        required: requiredList.includes(name),
      };
      sp.required = isParamRequired(sp);
      params.push(sp);
    }
  }

  return params;
}

export function discoveredEndpointsToSkills(
  siteId: string,
  endpoints: DiscoveredEndpoint[],
  skillRepo: SkillRepository,
): { imported: number; skipped: number; skillIds: string[] } {
  // Pre-filter to openapi source only
  const eligible = endpoints
    .filter(ep => ep.source === 'openapi')
    .filter(isRepresentable);

  let imported = 0;
  let skipped = 0;
  const skillIds: string[] = [];

  for (const endpoint of eligible) {
    const actionName = generateActionName(endpoint.method, endpoint.path);
    const clusterInfo = {
      method: endpoint.method,
      pathTemplate: endpoint.path,
      actionName,
      description: endpoint.description,
      inputSchema: endpoint.inputSchema ?? {},
      sampleCount: 0,
    };

    const skill = generateSkill(siteId, clusterInfo);

    // Override parameters with schema-derived params
    skill.parameters = endpointParamsToSkillParams(endpoint);

    // Skip duplicates
    if (skillRepo.getById(skill.id)) {
      skipped++;
      continue;
    }

    skillRepo.create(skill);
    imported++;
    skillIds.push(skill.id);
  }

  return { imported, skipped, skillIds };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function extractSiteId(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    log.debug({ url }, 'extractSiteId: URL parse failed');
    return url.replace(/[^a-zA-Z0-9.-]/g, '_').slice(0, 100);
  }
}
