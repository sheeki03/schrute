import * as crypto from 'node:crypto';
import {
  ANALYTICS_DOMAINS,
  FEATURE_FLAG_DOMAINS,
  STATIC_ASSET_EXTENSIONS,
  type RequestClassificationName,
} from '../skill/types.js';
import type { AgentDatabase } from '../storage/database.js';
import type { HarEntry } from './har-extractor.js';
import { getLogger } from '../core/logger.js';

const log = getLogger();

// ─── Domain Sets ─────────────────────────────────────────────────────

const ANALYTICS_SET = new Set(ANALYTICS_DOMAINS);
const FEATURE_FLAG_SET = new Set(FEATURE_FLAG_DOMAINS);

// ─── Filter Result ───────────────────────────────────────────────────

export interface FilterResult {
  signal: HarEntry[];
  noise: HarEntry[];
  ambiguous: HarEntry[];
}

export interface SiteOverride {
  domain: string;
  classification: RequestClassificationName;
}

// ─── Polling Detection ───────────────────────────────────────────────

interface RequestSignature {
  method: string;
  url: string;
  timestamps: number[];
}

/**
 * Detect polling/heartbeat patterns in a list of HAR entries.
 * Returns a Set of signature keys (method|url) that exhibit regular-interval
 * repetition (3+ requests with coefficient of variation < 0.3).
 */
function detectPollingPatterns(entries: HarEntry[]): Set<string> {
  // Build request signature map
  const sigMap = new Map<string, RequestSignature>();
  for (const entry of entries) {
    const key = `${entry.request.method}|${entry.request.url}`;
    let sig = sigMap.get(key);
    if (!sig) {
      sig = { method: entry.request.method, url: entry.request.url, timestamps: [] };
      sigMap.set(key, sig);
    }
    sig.timestamps.push(new Date(entry.startedDateTime).getTime());
  }

  // Detect polling signatures (3+ requests at roughly regular intervals)
  const pollingUrls = new Set<string>();
  for (const [key, sig] of sigMap) {
    if (sig.timestamps.length >= 3) {
      const sorted = sig.timestamps.sort((a, b) => a - b);
      const intervals: number[] = [];
      for (let i = 1; i < sorted.length; i++) {
        intervals.push(sorted[i] - sorted[i - 1]);
      }
      const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      if (mean > 0) {
        const variance = intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length;
        const cv = Math.sqrt(variance) / mean; // coefficient of variation
        if (cv < 0.3) {
          // Regular interval — likely polling/heartbeat
          pollingUrls.add(key);
        }
      }
    }
  }

  return pollingUrls;
}

// ─── Public API ──────────────────────────────────────────────────────

export function filterRequests(
  entries: HarEntry[],
  overrides: SiteOverride[] = [],
): FilterResult {
  const signal: HarEntry[] = [];
  const noise: HarEntry[] = [];
  const ambiguous: HarEntry[] = [];

  // Build override map: domain -> classification
  const overrideMap = new Map<string, RequestClassificationName>();
  for (const o of overrides) {
    overrideMap.set(o.domain.toLowerCase(), o.classification);
  }

  const pollingUrls = detectPollingPatterns(entries);

  for (const entry of entries) {
    const { classification, reason } = classifyEntry(entry, overrideMap, pollingUrls);

    if (classification === 'noise') {
      noise.push(entry);
    } else if (classification === 'ambiguous') {
      ambiguous.push(entry);
    } else {
      signal.push(entry);
    }
  }

  log.debug(
    { signal: signal.length, noise: noise.length, ambiguous: ambiguous.length },
    'Filtered requests',
  );

  return { signal, noise, ambiguous };
}

// ─── Record Entries to DB ────────────────────────────────────────────

export function recordFilteredEntries(
  db: AgentDatabase,
  frameId: string,
  entries: HarEntry[],
  overrides: SiteOverride[] = [],
): FilterResult {
  const overrideMap = new Map<string, RequestClassificationName>();
  for (const o of overrides) {
    overrideMap.set(o.domain.toLowerCase(), o.classification);
  }

  const pollingUrls = detectPollingPatterns(entries);

  const signal: HarEntry[] = [];
  const noise: HarEntry[] = [];
  const ambiguous: HarEntry[] = [];

  for (const entry of entries) {
    const { classification, reason } = classifyEntry(entry, overrideMap, pollingUrls);

    const requestHash = hashEntry(entry);

    db.run(
      `INSERT INTO action_frame_entries (frame_id, request_hash, classification, noise_reason, redaction_applied)
       VALUES (?, ?, ?, ?, ?)`,
      frameId,
      requestHash,
      classification,
      reason ?? null,
      0,
    );

    if (classification === 'noise') {
      noise.push(entry);
    } else if (classification === 'ambiguous') {
      ambiguous.push(entry);
    } else {
      signal.push(entry);
    }
  }

  return { signal, noise, ambiguous };
}

// ─── Classification Logic ────────────────────────────────────────────

interface ClassificationResult {
  classification: RequestClassificationName;
  reason?: string;
}

function classifyEntry(
  entry: HarEntry,
  overrideMap: Map<string, RequestClassificationName>,
  pollingUrls: Set<string>,
): ClassificationResult {
  let hostname: string;
  try {
    hostname = new URL(entry.request.url).hostname.toLowerCase();
  } catch {
    return { classification: 'ambiguous', reason: 'invalid_url' };
  }

  // Check site-specific overrides first
  const override = overrideMap.get(hostname);
  if (override) {
    return { classification: override, reason: 'site_override' };
  }

  // Analytics domains
  if (matchesDomainList(hostname, ANALYTICS_SET)) {
    return { classification: 'noise', reason: 'analytics' };
  }

  // Feature flag domains
  if (matchesDomainList(hostname, FEATURE_FLAG_SET)) {
    return { classification: 'noise', reason: 'feature_flag' };
  }

  // Static assets
  const urlPath = getUrlPath(entry.request.url);
  if (isStaticAsset(urlPath)) {
    return { classification: 'noise', reason: 'static_asset' };
  }

  // Beacon detection: sendBeacon-like requests (0-byte POST to tracking-like endpoints)
  if (isBeacon(entry)) {
    return { classification: 'noise', reason: 'beacon' };
  }

  // Polling/heartbeat detection
  const sigKey = `${entry.request.method}|${entry.request.url}`;
  if (pollingUrls.has(sigKey)) {
    return { classification: 'noise', reason: 'polling' };
  }

  // If we get here and the response is a non-API content type, mark ambiguous
  const contentType = getResponseContentType(entry);
  if (contentType && (contentType.includes('text/html') || contentType.includes('text/css'))) {
    return { classification: 'ambiguous', reason: 'non_api_content_type' };
  }

  return { classification: 'signal' };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function matchesDomainList(hostname: string, domainSet: Set<string>): boolean {
  if (domainSet.has(hostname)) return true;

  // Check if hostname is a subdomain of any listed domain
  for (const domain of domainSet) {
    if (hostname.endsWith(`.${domain}`)) return true;
  }
  return false;
}

function getUrlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function isStaticAsset(urlPath: string): boolean {
  const lowerPath = urlPath.toLowerCase();
  return STATIC_ASSET_EXTENSIONS.some(ext => lowerPath.endsWith(ext));
}

function isBeacon(entry: HarEntry): boolean {
  const method = entry.request.method.toUpperCase();
  if (method !== 'POST') return false;

  // 0-byte body or very small body
  const bodySize = entry.request.bodySize;
  const bodyText = entry.request.postData?.text;
  const hasEmptyBody = bodySize <= 0 && (!bodyText || bodyText.length === 0);

  if (!hasEmptyBody) return false;

  // Check if URL looks like a tracking endpoint
  const url = entry.request.url.toLowerCase();
  const trackingPatterns = [
    '/collect', '/beacon', '/track', '/event', '/pixel',
    '/analytics', '/log', '/ping', '/heartbeat',
  ];
  return trackingPatterns.some(p => url.includes(p));
}

function getResponseContentType(entry: HarEntry): string | undefined {
  const header = entry.response.headers.find(
    h => h.name.toLowerCase() === 'content-type',
  );
  return header?.value;
}

function hashEntry(entry: HarEntry): string {
  const content = `${entry.request.method}|${entry.request.url}|${entry.startedDateTime}`;
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}
