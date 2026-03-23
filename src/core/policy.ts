import * as dns from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { getLogger } from './logger.js';
import { getDatabase } from '../storage/database.js';
import { BoundedMap } from '../shared/bounded-map.js';
import { normalizeDomain, isDomainMatch } from '../shared/domain-utils.js';
// Re-export so existing consumers that imported from policy.ts still work
export { normalizeDomain, isDomainMatch };
import type {
  CapabilityName,
  HttpMethod,
  SideEffectClassName,
  SitePolicy,
  SchruteConfig,
} from '../skill/types.js';
import {
  Capability,
  V01_DEFAULT_CAPABILITIES,
  DISABLED_BY_DEFAULT_CAPABILITIES,
  TIER1_ALLOWED_HEADERS,
  BLOCKED_HOP_BY_HOP_HEADERS,
  SideEffectClass,
} from '../skill/types.js';
import {
  checkPathRisk as canonicalCheckPathRisk,
  addPathAllowlistEntry as canonicalAddPathAllowlistEntry,
  removePathAllowlistEntry as canonicalRemovePathAllowlistEntry,
} from '../skill/path-risk.js';

// ─── Result Types ─────────────────────────────────────────────────

interface PolicyResult {
  allowed: boolean;
  rule: string;
  reason?: string;
}

export interface IpValidationResult {
  ip: string;
  allowed: boolean;
  category: string;
}

export interface PathRiskResult {
  blocked: boolean;
  reason?: string;
}

// ─── Site Policy Defaults ─────────────────────────────────────────

const DEFAULT_SITE_POLICY: Omit<SitePolicy, 'siteId'> = {
  allowedMethods: ['GET', 'HEAD'] as HttpMethod[],
  maxQps: 10,
  maxConcurrent: 3,
  minGapMs: 100,
  readOnlyDefault: true,
  requireConfirmation: [],
  domainAllowlist: [],
  redactionRules: [],
  capabilities: [...V01_DEFAULT_CAPABILITIES],
  browserRequired: false,
};

const POLICY_CACHE_TTL_MS = 300_000; // 5 minutes
// Module-level singleton — intentional for process-scoped daemon state
// Cache key = "dataDir:siteId" to isolate policies across config contexts
const sitePolicies = new BoundedMap<string, SitePolicy>({ maxSize: 500, ttlMs: POLICY_CACHE_TTL_MS });

function policyCacheKey(siteId: string, config?: SchruteConfig): string {
  const dataDir = config?.dataDir ?? '';
  return dataDir ? `${dataDir}:${siteId}` : siteId;
}

// ─── Policy Store ─────────────────────────────────────────────────

function loadPolicyFromDb(siteId: string, config?: SchruteConfig): SitePolicy | null {
  try {
    const db = getDatabase(config);
    const row = db.get<{
      site_id: string;
      allowed_methods: string;
      max_qps: number;
      max_concurrent: number;
      min_gap_ms: number | null;
      read_only_default: number;
      require_confirmation: string;
      domain_allowlist: string | null;
      redaction_rules: string;
      capabilities: string;
      browser_required: number | null;
      execution_backend: string | null;
      execution_session_name: string | null;
    }>('SELECT * FROM policies WHERE site_id = ?', siteId);

    if (!row) return null;

    const VALID_HTTP_METHODS = new Set<string>(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
    const rawMethods: string[] = JSON.parse(row.allowed_methods);
    const allowedMethods = rawMethods.filter(m => VALID_HTTP_METHODS.has(m)) as HttpMethod[];
    if (allowedMethods.length !== rawMethods.length) {
      const log = getLogger();
      log.warn({ siteId, invalid: rawMethods.filter(m => !VALID_HTTP_METHODS.has(m)) }, 'Filtered invalid HTTP methods from persisted policy');
    }

    return normalizeSitePolicy({
      siteId: row.site_id,
      allowedMethods,
      maxQps: row.max_qps,
      maxConcurrent: row.max_concurrent,
      minGapMs: row.min_gap_ms ?? DEFAULT_SITE_POLICY.minGapMs,
      readOnlyDefault: row.read_only_default === 1,
      requireConfirmation: JSON.parse(row.require_confirmation),
      domainAllowlist: row.domain_allowlist ? JSON.parse(row.domain_allowlist) : [],
      redactionRules: JSON.parse(row.redaction_rules),
      capabilities: JSON.parse(row.capabilities),
      browserRequired: row.browser_required === 1,
      executionBackend: (row.execution_backend as SitePolicy['executionBackend']) ?? undefined,
      executionSessionName: row.execution_session_name ?? undefined,
    });
  } catch (err) {
    const policyLog = getLogger();
    policyLog.error(
      { siteId, err },
      'Failed to load site policy from database — falling back to restrictive defaults',
    );
    return null;
  }
}

const VALID_EXECUTION_BACKENDS = new Set<NonNullable<SitePolicy['executionBackend']>>([
  'playwright',
  'agent-browser',
  'live-chrome',
]);

function normalizeSitePolicy(policy: SitePolicy): SitePolicy {
  return {
    ...DEFAULT_SITE_POLICY,
    ...policy,
    browserRequired: policy.browserRequired === true,
  };
}

function validateSitePolicy(policy: SitePolicy): void {
  if (policy.minGapMs !== undefined && (!Number.isFinite(policy.minGapMs) || policy.minGapMs < 0)) {
    throw new Error(`minGapMs must be a finite number >= 0. Got '${policy.minGapMs}'.`);
  }

  if (policy.browserRequired !== undefined && typeof policy.browserRequired !== 'boolean') {
    throw new Error(`browserRequired must be boolean when provided. Got '${typeof policy.browserRequired}'.`);
  }

  if (policy.executionBackend !== undefined && !VALID_EXECUTION_BACKENDS.has(policy.executionBackend)) {
    throw new Error(
      `executionBackend must be one of: ${[...VALID_EXECUTION_BACKENDS].join(', ')}. ` +
      `Got executionBackend='${policy.executionBackend}'.`,
    );
  }

  if (policy.executionSessionName
      && policy.executionBackend !== 'playwright'
      && policy.executionBackend !== 'live-chrome') {
    throw new Error(
      `executionSessionName requires executionBackend='playwright' or 'live-chrome'. ` +
      `Got executionBackend='${policy.executionBackend ?? 'undefined'}'.`,
    );
  }
}

export function getSitePolicy(siteId: string, config?: SchruteConfig): SitePolicy {
  const key = policyCacheKey(siteId, config);
  const cached = sitePolicies.get(key);
  if (cached) {
    return cached;
  }

  // Try loading from DB
  const dbPolicy = loadPolicyFromDb(siteId, config);
  if (dbPolicy) {
    sitePolicies.set(key, dbPolicy);
    return dbPolicy;
  }

  return normalizeSitePolicy({ siteId, ...DEFAULT_SITE_POLICY });
}

export function setSitePolicy(policy: SitePolicy, config?: SchruteConfig): { persisted: boolean } {
  validateSitePolicy(policy);
  const normalized = normalizeSitePolicy(policy);

  const key = policyCacheKey(normalized.siteId, config);
  sitePolicies.set(key, normalized);

  try {
    const db = getDatabase(config);
    // Ensure site row exists for FK constraint
    // INSERT OR IGNORE: ensure site row exists for FK constraint.
    // Cannot use ON CONFLICT(id) DO UPDATE because it may conflict with
    // better-sqlite3 in some test environments. OR IGNORE is safe since
    // we only need the row to exist, not to update it.
    db.run(
      `INSERT OR IGNORE INTO sites (id, first_seen, last_visited) VALUES (?, ?, ?)`,
      normalized.siteId, Date.now(), Date.now(),
    );
    db.run(
      `INSERT OR REPLACE INTO policies (site_id, allowed_methods, max_qps, max_concurrent, min_gap_ms, read_only_default,
         require_confirmation, domain_allowlist, redaction_rules, capabilities,
         browser_required, execution_backend, execution_session_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      normalized.siteId, JSON.stringify(normalized.allowedMethods), normalized.maxQps, normalized.maxConcurrent,
      normalized.minGapMs ?? DEFAULT_SITE_POLICY.minGapMs, normalized.readOnlyDefault ? 1 : 0, JSON.stringify(normalized.requireConfirmation),
      JSON.stringify(normalized.domainAllowlist), JSON.stringify(normalized.redactionRules),
      JSON.stringify(normalized.capabilities), normalized.browserRequired ? 1 : 0,
      normalized.executionBackend ?? null, normalized.executionSessionName ?? null,
    );
    return { persisted: true };
  } catch (err) {
    const log = getLogger();
    log.warn({ siteId: normalized.siteId, err }, 'Failed to persist site policy to database');
    return { persisted: false };
  }
}

export function invalidatePolicyCache(siteId?: string, config?: SchruteConfig): void {
  if (siteId) {
    sitePolicies.delete(policyCacheKey(siteId, config));
  } else {
    sitePolicies.clear();
  }
}

export function mergeSitePolicy(
  siteId: string,
  overlay: Partial<Omit<SitePolicy, 'siteId'>>,
  config?: SchruteConfig,
): { merged: SitePolicy; prior: Partial<SitePolicy>; persisted: boolean } {
  const existing = getSitePolicy(siteId, config);
  const prior: Partial<SitePolicy> = {};
  for (const key of Object.keys(overlay) as (keyof typeof overlay)[]) {
    (prior as Record<string, unknown>)[key as string] = (existing as unknown as Record<string, unknown>)[key as string];
  }
  const merged = { ...existing, ...overlay };
  const { persisted } = setSitePolicy(merged, config);
  return { merged, prior, persisted };
}

// ─── Capabilities ─────────────────────────────────────────────────

// Capabilities that can be enabled via config.capabilities.enabled
const OPT_IN_ALLOWED: readonly string[] = [];

/**
 * Check if a capability is allowed for a site.
 *
 * Capabilities in DISABLED_BY_DEFAULT_CAPABILITIES are blocked unless they
 * appear in OPT_IN_ALLOWED AND the user has enabled them via
 * config.capabilities.enabled AND the site policy grants them.
 */
export function checkCapability(
  siteId: string,
  capability: CapabilityName,
  config?: SchruteConfig,
): PolicyResult {
  if ((DISABLED_BY_DEFAULT_CAPABILITIES as readonly string[]).includes(capability)) {
    if (OPT_IN_ALLOWED.includes(capability) && config?.capabilities?.enabled?.includes(capability)) {
      const policy = getSitePolicy(siteId, config);
      if (policy.capabilities.includes(capability)) {
        return { allowed: true, rule: 'capability.opted_in' };
      }
      return {
        allowed: false,
        rule: 'capability.not_granted',
        reason: `Capability '${capability}' is opted-in but not granted for site '${siteId}'`,
      };
    }
    return {
      allowed: false,
      rule: 'capability.disabled_by_default',
      reason: `Capability '${capability}' is disabled by default. Enable via config: capabilities.enabled=['${capability}']`,
    };
  }

  const policy = getSitePolicy(siteId, config);
  if (policy.capabilities.includes(capability)) {
    return { allowed: true, rule: 'capability.site_allowed' };
  }

  return {
    allowed: false,
    rule: 'capability.not_granted',
    reason: `Capability '${capability}' is not granted for site '${siteId}'`,
  };
}

// ─── Domain Allowlist ─────────────────────────────────────────────

export function enforceDomainAllowlist(
  siteId: string,
  targetDomain: string,
  config?: SchruteConfig,
): PolicyResult {
  const policy = getSitePolicy(siteId, config);

  if (policy.domainAllowlist.length === 0) {
    return {
      allowed: false,
      rule: 'domain.no_allowlist',
      reason: `No domains allowlisted for site '${siteId}'`,
    };
  }

  if (isDomainMatch(targetDomain, policy.domainAllowlist)) {
    return { allowed: true, rule: 'domain.allowlisted' };
  }

  return {
    allowed: false,
    rule: 'domain.not_allowlisted',
    reason: `Domain '${normalizeDomain(targetDomain)}' is not in allowlist for site '${siteId}'`,
  };
}

export function matchesDomainAllowlist(
  targetDomain: string,
  allowlist: string[],
): boolean {
  return isDomainMatch(targetDomain, allowlist);
}

export function sanitizeImplicitAllowlist(domains: string[]): string[] {
  return domains
    .filter(d => d && typeof d === 'string' && !d.includes('*'))
    .map(normalizeDomain);
}

// ─── Private Network Egress Blocking ──────────────────────────────
// Both IPv4 and IPv6 use whitelist approach — only 'unicast' range is ultimately allowed.
// IPv6 has additional defense-in-depth early-exit via BLOCKED_IPV6_RANGES.

const BLOCKED_IPV6_RANGES: string[] = [
  'loopback',
  'linkLocal',
  'uniqueLocal',
  'ipv4Mapped',
  'unspecified',
  'reserved',
  'benchmarking',
  'rfc6145',
  'rfc6052',
  '6to4',
  'teredo',
  'as112v6',
  'amt',
];

// Additional CIDR blocks not covered by ipaddr.js range() method
const EXTRA_BLOCKED_V4_CIDRS = [
  '100.64.0.0/10',   // CGNAT
  '192.0.2.0/24',    // Documentation (TEST-NET-1)
  '198.51.100.0/24', // Documentation (TEST-NET-2)
  '203.0.113.0/24',  // Documentation (TEST-NET-3)
  '198.18.0.0/15',   // Benchmarking
  '0.0.0.0/8',       // "This" network
];

const EXTRA_BLOCKED_V6_CIDRS = [
  '::ffff:0:0/96',   // IPv4-mapped
  '::/128',           // Unspecified
  '::1/128',         // Loopback
  'fc00::/7',        // Unique local
  'fe80::/10',       // Link-local
];

function matchesCidr(addr: ipaddr.IPv4 | ipaddr.IPv6, cidr: string): boolean {
  try {
    const [base, bits] = ipaddr.parseCIDR(cidr);
    return addr.match(base, bits);
  } catch (err) {
    const log = getLogger();
    log.error({ cidr, addr: addr.toString(), err }, 'CIDR match failed — treating as blocked for safety');
    return true;  // fail-closed: treat parse error as "matches blocked range"
  }
}

export function isPublicIp(ip: string): boolean {
  if (!ipaddr.isValid(ip)) {
    return false;
  }

  const parsed = ipaddr.process(ip);

  if (parsed.kind() === 'ipv4') {
    const range = parsed.range();
    if (range !== 'unicast') {
      return false;
    }
    // Check extra blocked CIDRs
    for (const cidr of EXTRA_BLOCKED_V4_CIDRS) {
      if (matchesCidr(parsed, cidr)) {
        return false;
      }
    }
    return true;
  }

  // IPv6
  const range = parsed.range();
  if (BLOCKED_IPV6_RANGES.includes(range)) {
    return false;
  }
  // Check if it's an IPv4-mapped address
  if ('isIPv4MappedAddress' in parsed && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    const v4 = (parsed as ipaddr.IPv6).toIPv4Address();
    return isPublicIp(v4.toString());
  }
  // Check extra blocked CIDRs
  for (const cidr of EXTRA_BLOCKED_V6_CIDRS) {
    if (matchesCidr(parsed, cidr)) {
      return false;
    }
  }

  return range === 'unicast';
}

const DNS_CACHE = new BoundedMap<string, { result: IpValidationResult; expiresAt: number }>({ maxSize: 2000 });
const DNS_CACHE_TTL_MS = 60_000;        // 60s for confirmed blocks
const DNS_FAILURE_CACHE_TTL_MS = 10_000; // 10s for resolution failures

/**
 * Resolve a hostname to an IP and validate it is not in a private range.
 *
 * Returns the resolved IP so callers can pin the connection to that exact address,
 * preventing DNS rebinding TOCTOU attacks where a second resolution could return
 * a different (private) IP.
 */
export async function resolveAndValidate(
  hostname: string,
): Promise<IpValidationResult> {
  const cached = DNS_CACHE.get(hostname);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const log = getLogger();

  try {
    const { address } = await dns.lookup(hostname, { family: 0 });

    if (!ipaddr.isValid(address)) {
      const result: IpValidationResult = { ip: address, allowed: false, category: 'invalid' };
      DNS_CACHE.set(hostname, { result, expiresAt: Date.now() + DNS_CACHE_TTL_MS });
      return result;
    }

    const parsed = ipaddr.process(address);
    const range = parsed.range();
    const allowed = isPublicIp(address);

    if (!allowed) {
      log.warn({ hostname, ip: address, range }, 'Blocked private network egress');
    }

    const result: IpValidationResult = { ip: address, allowed, category: range };
    DNS_CACHE.set(hostname, { result, expiresAt: Date.now() + DNS_CACHE_TTL_MS });
    return result;
  } catch (err) {
    log.error({ hostname, err }, 'DNS resolution failed');
    const result: IpValidationResult = { ip: '', allowed: false, category: 'dns_error' };
    // Use shorter TTL for DNS failures so transient issues resolve quickly
    DNS_CACHE.set(hostname, { result, expiresAt: Date.now() + DNS_FAILURE_CACHE_TTL_MS });
    return result;
  }
}

// ─── Path Risk Heuristics ─────────────────────────────────────────
// Canonical implementation lives in skill/path-risk.ts (supports per-site allowlists).
// This module delegates to it for backward compatibility.

export function addPathAllowlistEntry(path: string): void {
  // Legacy global API — routes to canonical per-site implementation with a global sentinel
  canonicalAddPathAllowlistEntry('__global__', path);
}

export function removePathAllowlistEntry(path: string): void {
  canonicalRemovePathAllowlistEntry('__global__', path);
}

export function checkPathRisk(method: string, path: string): PathRiskResult {
  return canonicalCheckPathRisk(method, path, '__global__');
}

// ─── Header Controls ──────────────────────────────────────────────

export function filterHeaders(
  headers: Record<string, string>,
  tier: number,
  allowlistedDomains: string[],
  requestDomain?: string,
): Record<string, string> {
  const filtered: Record<string, string> = {};
  const normalizedAllowlisted = allowlistedDomains.map(normalizeDomain);
  const normalizedRequest = requestDomain ? normalizeDomain(requestDomain) : '';
  const isDomainAllowlisted =
    normalizedRequest !== '' &&
    normalizedAllowlisted.some(
      (d) => normalizedRequest === d || normalizedRequest.endsWith('.' + d),
    );

  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();

    // Always block hop-by-hop headers
    if ((BLOCKED_HOP_BY_HOP_HEADERS as readonly string[]).includes(lowerKey)) {
      continue;
    }

    // Block proxy-* pattern (catch any we missed)
    if (lowerKey.startsWith('proxy-')) {
      continue;
    }

    // Never forward Content-Length (computed internally)
    if (lowerKey === 'content-length') {
      continue;
    }

    // Never replay Origin/Referer (derived at runtime)
    if (lowerKey === 'origin' || lowerKey === 'referer') {
      continue;
    }

    // Tier 1 header filtering
    if (tier === 1) {
      if (!(TIER1_ALLOWED_HEADERS as readonly string[]).includes(lowerKey)) {
        continue;
      }
      // Authorization and Cookie only if domain is allowlisted
      if (
        (lowerKey === 'authorization' || lowerKey === 'cookie') &&
        !isDomainAllowlisted
      ) {
        continue;
      }
    }

    filtered[key] = value;
  }

  return filtered;
}

// ─── Method Restrictions ──────────────────────────────────────────

export function checkMethodAllowed(
  siteId: string,
  method: string,
  sideEffectClass?: SideEffectClassName,
  config?: SchruteConfig,
): boolean {
  const upperMethod = method.toUpperCase();
  const policy = getSitePolicy(siteId, config);

  // GET and HEAD always allowed
  if (upperMethod === 'GET' || upperMethod === 'HEAD') {
    return true;
  }

  // Explicit method allowlist on the policy
  if (policy.allowedMethods.map((m) => m.toUpperCase()).includes(upperMethod)) {
    return true;
  }

  // POST allowed only if side-effect classifier labels read-only
  if (upperMethod === 'POST' && sideEffectClass === SideEffectClass.READ_ONLY) {
    return true;
  }

  return false;
}

// ─── Redirect Policy ─────────────────────────────────────────────

export function checkRedirectAllowed(
  siteId: string,
  targetUrl: string,
  baseUrl?: string,
  config?: SchruteConfig,
): PolicyResult {
  try {
    const url = baseUrl ? new URL(targetUrl, baseUrl) : new URL(targetUrl);
    return enforceDomainAllowlist(siteId, url.hostname, config);
  } catch {
    return {
      allowed: false,
      rule: 'redirect.invalid_url',
      reason: `Invalid redirect URL: '${targetUrl}'`,
    };
  }
}
