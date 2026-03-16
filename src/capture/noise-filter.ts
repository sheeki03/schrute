import * as crypto from 'node:crypto';
import {
  ANALYTICS_DOMAINS,
  AD_NETWORK_DOMAINS,
  CDN_INFRASTRUCTURE_DOMAINS,
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
const AD_NETWORK_SET = new Set(AD_NETWORK_DOMAINS);
const CDN_INFRA_SET = new Set(CDN_INFRASTRUCTURE_DOMAINS);
const FEATURE_FLAG_SET = new Set(FEATURE_FLAG_DOMAINS);
const STATIC_RESOURCE_TYPE_SET = buildStaticResourceTypeSet();

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
    const { classification } = classifyEntry(entry, overrideMap, pollingUrls);
    const bucket = classification === 'noise' ? noise : classification === 'ambiguous' ? ambiguous : signal;
    bucket.push(entry);
  }

  log.debug(
    { signal: signal.length, noise: noise.length, ambiguous: ambiguous.length },
    'Filtered requests',
  );

  return { signal, noise, ambiguous };
}

export function isObviousNoise(
  url: string,
  method: string,
  status: number,
  siteHost: string,
  resourceType?: string,
): { obvious: boolean; reason?: string } {
  const hostname = extractHostname(url);
  const urlPath = getUrlPath(url);

  if (hostname) {
    if (matchesDomainList(hostname, ANALYTICS_SET)) {
      return { obvious: true, reason: 'analytics' };
    }
    if (matchesDomainList(hostname, AD_NETWORK_SET)) {
      return { obvious: true, reason: 'ad_network' };
    }
    if (matchesDomainList(hostname, CDN_INFRA_SET)) {
      return { obvious: true, reason: 'cdn_infra' };
    }
  }

  if (isStaticAsset(urlPath)) {
    return { obvious: true, reason: 'static_asset' };
  }

  if (urlPath.toLowerCase().startsWith('/cdn-cgi/')) {
    return { obvious: true, reason: 'cdn_cgi' };
  }

  if (resourceType && STATIC_RESOURCE_TYPE_SET.has(resourceType.toLowerCase())) {
    return { obvious: true, reason: 'resource_type' };
  }

  if (hostname && siteHost && isCrossOriginNoise(hostname, siteHost)) {
    return { obvious: true, reason: 'cross_origin' };
  }

  return { obvious: false };
}

export function shouldCaptureResponseBody(
  url: string,
  method: string,
  status: number,
  contentType: string | undefined,
  siteHost: string,
  resourceType?: string,
): boolean {
  if (isObviousNoise(url, method, status, siteHost, resourceType).obvious) {
    return false;
  }

  if (status < 200 || status >= 300) {
    return false;
  }

  const normalized = (contentType ?? '').toLowerCase();
  return (
    normalized.includes('application/json') ||
    normalized.includes('+json') ||
    normalized.includes('text/json')
  );
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

    try {
      db.run(
        `INSERT OR IGNORE INTO action_frame_entries (frame_id, request_hash, classification, noise_reason, redaction_applied)
         VALUES (?, ?, ?, ?, ?)`,
        frameId,
        requestHash,
        classification,
        reason ?? null,
        0,
      );
    } catch (err) {
      log.warn({ frameId, requestHash, err }, 'Failed to insert action_frame_entry, skipping');
    }

    const bucket = classification === 'noise' ? noise : classification === 'ambiguous' ? ambiguous : signal;
    bucket.push(entry);
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

  if (matchesDomainList(hostname, AD_NETWORK_SET)) {
    return { classification: 'noise', reason: 'ad_network' };
  }

  if (matchesDomainList(hostname, CDN_INFRA_SET)) {
    return { classification: 'noise', reason: 'cdn_infra' };
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

  // Consent/tracking endpoint detection via response-shape heuristics
  if (isConsentOrTrackingEndpoint(entry)) {
    return { classification: 'noise', reason: 'tracking_endpoint' };
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

function buildStaticResourceTypeSet(): Set<string> {
  const resourceTypes = new Set<string>(['websocket', 'eventsource']);

  for (const ext of STATIC_ASSET_EXTENSIONS) {
    switch (ext) {
      case '.js':
      case '.map':
        resourceTypes.add('script');
        break;
      case '.css':
        resourceTypes.add('stylesheet');
        break;
      case '.png':
      case '.jpg':
      case '.jpeg':
      case '.gif':
      case '.svg':
      case '.ico':
        resourceTypes.add('image');
        break;
      case '.woff':
      case '.woff2':
      case '.ttf':
      case '.eot':
      case '.otf':
        resourceTypes.add('font');
        break;
      default:
        break;
    }
  }

  return resourceTypes;
}

function extractHostname(url: string): string | null {
  const schemeIdx = url.indexOf('://');
  if (schemeIdx >= 0) {
    const hostStart = schemeIdx + 3;
    let hostEnd = url.indexOf('/', hostStart);
    if (hostEnd === -1) hostEnd = url.length;
    const authEnd = url.lastIndexOf('@', hostEnd);
    const rawHost = url.slice(authEnd >= hostStart ? authEnd + 1 : hostStart, hostEnd);
    const host = rawHost.startsWith('[')
      ? rawHost.slice(0, rawHost.indexOf(']') + 1)
      : rawHost.split(':', 1)[0];
    if (host) return host.toLowerCase();
  }

  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function getUrlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function getRootDomain(hostname: string): string {
  const normalized = hostname.replace(/^\[|\]$/g, '');
  const parts = normalized.split('.').filter(Boolean);
  if (parts.length <= 2) return normalized.toLowerCase();
  return parts.slice(-2).join('.').toLowerCase();
}

function isStaticAsset(urlPath: string): boolean {
  const lowerPath = urlPath.toLowerCase();
  return STATIC_ASSET_EXTENSIONS.some(ext => lowerPath.endsWith(ext));
}

function isCrossOriginNoise(hostname: string, siteHost: string): boolean {
  const normalizedHost = hostname.toLowerCase();
  const normalizedSiteHost = siteHost.toLowerCase();

  if (
    normalizedHost === normalizedSiteHost ||
    normalizedHost.endsWith(`.${normalizedSiteHost}`) ||
    normalizedSiteHost.endsWith(`.${normalizedHost}`)
  ) {
    return false;
  }

  const hostRoot = getRootDomain(normalizedHost);
  const siteRoot = getRootDomain(normalizedSiteHost);
  if (hostRoot === siteRoot) {
    const hostPrefix = normalizedHost.slice(0, normalizedHost.length - hostRoot.length).replace(/\.$/, '');
    const sitePrefix = normalizedSiteHost.slice(0, normalizedSiteHost.length - siteRoot.length).replace(/\.$/, '');
    const allowedPrefixes = new Set(['', 'api', 'cdn', 'www']);
    if (allowedPrefixes.has(hostPrefix) || allowedPrefixes.has(sitePrefix)) {
      return false;
    }
  }

  return true;
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

function isConsentOrTrackingEndpoint(entry: HarEntry): boolean {
  const urlPath = getUrlPath(entry.request.url).toLowerCase();
  const status = entry.response.status;
  const bodySize = entry.response.content?.size ?? entry.response.bodySize ?? -1;

  // 1. Tracking pixel files (any domain, any method)
  const filename = urlPath.split('/').pop() ?? '';
  if (['pixel.gif', 'pixel.png', '1x1.gif'].includes(filename)) return true;

  // 2. Consent/decision endpoints: path contains consent-like segment
  //    AND response body is very small (< 256 bytes)
  const CONSENT_PATHS = ['/decision', '/consent', '/gdpr', '/cmp'];
  if (CONSENT_PATHS.some(p => urlPath.includes(p)) && bodySize >= 0 && bodySize < 256) {
    return true;
  }

  // 3. Empty 204 responses with tracking-like paths (any domain)
  if (status === 204) {
    const TRACKING_204_PATHS = ['/collect', '/track', '/beacon', '/ping', '/pixel'];
    if (TRACKING_204_PATHS.some(p => urlPath.includes(p))) return true;
  }

  return false;
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
