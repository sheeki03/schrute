import { getLogger } from '../core/logger.js';
import { resolveAndValidate } from '../core/policy.js';
import type { RobotsPolicy } from './robots.js';

const log = getLogger();

export interface SitemapScanResult {
  found: boolean;
  urls: string[];
  sitemapCount: number;
}

const MAX_SITEMAPS = 10;
const MAX_RECURSION_DEPTH = 2;
const MAX_URLS = 50_000;
const MAX_BODY_BYTES = 50 * 1024 * 1024; // 50 MB
const FETCH_TIMEOUT_MS = 10_000;

const LOC_RE = /<loc>\s*(.*?)\s*<\/loc>/gi;
const SITEMAP_INDEX_RE = /<sitemapindex/i;

/**
 * Discover URLs from sitemap.xml files.
 *
 * Collects sitemap locations from well-known paths and robotsPolicy.sitemapUrls,
 * fetches and parses them (with recursion for sitemap index files), and returns
 * a deduplicated list of discovered URLs.
 */
export async function scanSitemap(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
  robotsPolicy?: RobotsPolicy,
): Promise<SitemapScanResult> {
  const origin = new URL(baseUrl).origin;

  // Collect candidate sitemap locations
  const candidates = new Set<string>([
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
  ]);

  if (robotsPolicy?.sitemapUrls) {
    for (const url of robotsPolicy.sitemapUrls) {
      candidates.add(url);
    }
  }

  const allUrls = new Set<string>();
  let sitemapCount = 0;
  let sitemapsFetched = 0;

  async function fetchSitemap(url: string, depth: number): Promise<void> {
    if (sitemapsFetched >= MAX_SITEMAPS) return;
    if (allUrls.size >= MAX_URLS) return;

    // Same-origin check
    try {
      const parsed = new URL(url);
      if (parsed.origin !== origin) {
        log.debug({ url, origin }, 'Skipping cross-origin sitemap');
        return;
      }
    } catch {
      log.debug({ url }, 'Invalid sitemap URL');
      return;
    }

    // SSRF check
    try {
      const hostname = new URL(url).hostname;
      const ipCheck = await resolveAndValidate(hostname);
      if (!ipCheck.allowed) {
        log.debug({ url, ip: ipCheck.ip, category: ipCheck.category }, 'Skipping sitemap — private IP');
        return;
      }
    } catch {
      log.debug({ url }, 'Sitemap DNS resolution failed');
      return;
    }

    // robots.txt check
    if (robotsPolicy) {
      try {
        const path = new URL(url).pathname;
        if (!robotsPolicy.isAllowed(path)) {
          log.debug({ url }, 'Skipping sitemap — blocked by robots.txt');
          return;
        }
      } catch {
        // invalid URL already handled above
      }
    }

    // Fetch
    sitemapsFetched++;
    try {
      const resp = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!resp.ok) {
        log.debug({ url, status: resp.status }, 'Sitemap fetch returned non-OK status');
        return;
      }

      // Size check via Content-Length header
      const clHeader = resp.headers.get('content-length');
      if (clHeader && parseInt(clHeader, 10) > MAX_BODY_BYTES) {
        log.debug({ url, contentLength: clHeader }, 'Skipping sitemap — exceeds size limit');
        return;
      }

      const text = await resp.text();
      if (text.length > MAX_BODY_BYTES) {
        log.debug({ url, size: text.length }, 'Skipping sitemap — body exceeds size limit');
        return;
      }

      sitemapCount++;

      // Check if this is a sitemap index
      if (SITEMAP_INDEX_RE.test(text) && depth < MAX_RECURSION_DEPTH) {
        // Extract child sitemap URLs from the index
        const childLocs: string[] = [];
        const childLocRe = /<loc>\s*(.*?)\s*<\/loc>/gi;
        let match;
        while ((match = childLocRe.exec(text)) !== null) {
          childLocs.push(match[1].trim());
        }
        for (const childUrl of childLocs) {
          if (sitemapsFetched >= MAX_SITEMAPS) break;
          if (allUrls.size >= MAX_URLS) break;
          await fetchSitemap(childUrl, depth + 1);
        }
        return;
      }

      // Parse <loc> entries as page URLs
      LOC_RE.lastIndex = 0;
      let match;
      while ((match = LOC_RE.exec(text)) !== null) {
        if (allUrls.size >= MAX_URLS) break;
        const locUrl = match[1].trim();
        try {
          const parsed = new URL(locUrl);
          if (parsed.origin === origin) {
            allUrls.add(parsed.href);
          }
        } catch {
          // skip invalid URLs
        }
      }
    } catch (err) {
      log.debug({ err, url }, 'Sitemap fetch failed');
    }
  }

  // Fetch all candidate sitemaps
  for (const candidate of candidates) {
    if (sitemapsFetched >= MAX_SITEMAPS) break;
    if (allUrls.size >= MAX_URLS) break;
    await fetchSitemap(candidate, 0);
  }

  const urls = [...allUrls];

  log.debug(
    { origin, urlCount: urls.length, sitemapCount },
    'Sitemap scan complete',
  );

  return {
    found: sitemapCount > 0,
    urls,
    sitemapCount,
  };
}
