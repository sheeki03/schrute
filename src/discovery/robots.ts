import { getLogger } from '../core/logger.js';
import { BoundedMap } from '../shared/bounded-map.js';

const log = getLogger();

interface RobotsRule {
  userAgent: string;
  allow: string[];
  disallow: string[];
  crawlDelay?: number;
}

export interface RobotsPolicy {
  isAllowed(path: string, userAgent?: string): boolean;
  crawlDelay?: number;
  sitemapUrls: string[];
}

function parseRobotsTxt(text: string): { rules: RobotsRule[]; sitemapUrls: string[] } {
  const rules: RobotsRule[] = [];
  const sitemapUrls: string[] = [];
  let current: RobotsRule | null = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim().split('#')[0].trim();

    if (key === 'sitemap') {
      if (value) sitemapUrls.push(value);
      continue;
    }

    if (key === 'user-agent') {
      current = { userAgent: value.toLowerCase(), allow: [], disallow: [] };
      rules.push(current);
    } else if (current) {
      if (key === 'allow') current.allow.push(value);
      else if (key === 'disallow') current.disallow.push(value);
      else if (key === 'crawl-delay') {
        const delay = Number(value);
        if (!isNaN(delay) && delay >= 0) current.crawlDelay = delay;
      }
    }
  }
  return { rules, sitemapUrls };
}

function pathMatches(pattern: string, path: string): boolean {
  if (!pattern) return false;
  // Simple prefix matching (covers most real robots.txt rules)
  if (pattern.endsWith('*')) {
    return path.startsWith(pattern.slice(0, -1));
  }
  if (pattern.endsWith('$')) {
    return path === pattern.slice(0, -1);
  }
  return path.startsWith(pattern);
}

function buildPolicy(rules: RobotsRule[], sitemapUrls: string[] = []): RobotsPolicy {
  // Find most specific matching rule (prefer exact user-agent match, fall back to *)
  const crawlDelay = rules.find(r => r.userAgent === '*')?.crawlDelay;

  return {
    crawlDelay,
    sitemapUrls,
    isAllowed(path: string, userAgent?: string): boolean {
      const ua = (userAgent ?? '*').toLowerCase();
      // Find rules for this user agent, fall back to *
      const matching = rules.filter(r => r.userAgent === ua || r.userAgent === '*');
      if (matching.length === 0) return true;

      // Check all rules — most specific path match wins
      let bestMatch = '';
      let allowed = true;

      for (const rule of matching) {
        for (const pattern of rule.disallow) {
          if (pathMatches(pattern, path) && pattern.length > bestMatch.length) {
            bestMatch = pattern;
            allowed = false;
          }
        }
        for (const pattern of rule.allow) {
          if (pathMatches(pattern, path) && pattern.length >= bestMatch.length) {
            bestMatch = pattern;
            allowed = true;
          }
        }
      }
      return allowed;
    },
  };
}

// --- Cache ------------------------------------------------------------------

const policyCache = new BoundedMap<string, RobotsPolicy>({ maxSize: 1000, ttlMs: 3600_000 });

export async function fetchRobotsPolicy(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<RobotsPolicy> {
  const origin = new URL(baseUrl).origin;
  const cached = policyCache.get(origin);
  if (cached) return cached;

  try {
    const resp = await fetchFn(`${origin}/robots.txt`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) {
      const allowAll = buildPolicy([], []);
      policyCache.set(origin, allowAll);
      return allowAll;
    }
    const text = await resp.text();
    const { rules, sitemapUrls } = parseRobotsTxt(text);
    const policy = buildPolicy(rules, sitemapUrls);
    policyCache.set(origin, policy);
    log.debug({ origin, ruleCount: rules.length, sitemapCount: sitemapUrls.length }, 'Parsed robots.txt');
    return policy;
  } catch (err) {
    log.warn({ err, origin }, 'Failed to fetch robots.txt — allowing all');
    const allowAll = buildPolicy([], []);
    policyCache.set(origin, allowAll);
    return allowAll;
  }
}

/** Clear the policy cache (useful for testing) */
export function clearRobotsPolicyCache(): void {
  policyCache.clear();
}
