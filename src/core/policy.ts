import * as dns from 'node:dns/promises';
import * as ipaddr from 'ipaddr.js';
import { getLogger } from './logger.js';
import { getConfig } from './config.js';
import { getDatabase } from '../storage/database.js';
import type {
  CapabilityName,
  SideEffectClassName,
  SitePolicy,
  OneAgentConfig,
} from '../skill/types.js';
import {
  V01_DEFAULT_CAPABILITIES,
  V01_DISABLED_CAPABILITIES,
  TIER1_ALLOWED_HEADERS,
  BLOCKED_HOP_BY_HOP_HEADERS,
  DESTRUCTIVE_GET_PATTERNS,
  DESTRUCTIVE_POST_PATTERNS,
  SideEffectClass,
} from '../skill/types.js';

// ─── Result Types ─────────────────────────────────────────────────

export interface PolicyResult {
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
  allowedMethods: ['GET', 'HEAD'],
  maxQps: 10,
  maxConcurrent: 3,
  readOnlyDefault: true,
  requireConfirmation: [],
  domainAllowlist: [],
  redactionRules: [],
  capabilities: [...V01_DEFAULT_CAPABILITIES],
};

const sitePolicies = new Map<string, SitePolicy>();

// ─── Policy Store ─────────────────────────────────────────────────

function loadPolicyFromDb(siteId: string): SitePolicy | null {
  try {
    const db = getDatabase();
    const row = db.get<{
      site_id: string;
      allowed_methods: string;
      max_qps: number;
      max_concurrent: number;
      read_only_default: number;
      require_confirmation: string;
      domain_allowlist: string | null;
      redaction_rules: string;
      capabilities: string;
    }>('SELECT * FROM policies WHERE site_id = ?', siteId);

    if (!row) return null;

    return {
      siteId: row.site_id,
      allowedMethods: JSON.parse(row.allowed_methods),
      maxQps: row.max_qps,
      maxConcurrent: row.max_concurrent,
      readOnlyDefault: row.read_only_default === 1,
      requireConfirmation: JSON.parse(row.require_confirmation),
      domainAllowlist: row.domain_allowlist ? JSON.parse(row.domain_allowlist) : [],
      redactionRules: JSON.parse(row.redaction_rules),
      capabilities: JSON.parse(row.capabilities),
    };
  } catch {
    return null;
  }
}

export function getSitePolicy(siteId: string): SitePolicy {
  const existing = sitePolicies.get(siteId);
  if (existing) return existing;

  // Try loading from DB
  const dbPolicy = loadPolicyFromDb(siteId);
  if (dbPolicy) {
    sitePolicies.set(siteId, dbPolicy); // cache it
    return dbPolicy;
  }

  return { siteId, ...DEFAULT_SITE_POLICY };
}

export function setSitePolicy(policy: SitePolicy): void {
  sitePolicies.set(policy.siteId, policy);
}

// ─── Capabilities ─────────────────────────────────────────────────

export function checkCapability(
  siteId: string,
  capability: CapabilityName,
): PolicyResult {
  if ((V01_DISABLED_CAPABILITIES as readonly string[]).includes(capability)) {
    return {
      allowed: false,
      rule: 'capability.v01_disabled',
      reason: `Capability '${capability}' is disabled in v0.1`,
    };
  }

  const policy = getSitePolicy(siteId);
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

function normalizeDomain(domain: string): string {
  let d = domain.toLowerCase();
  // Strip trailing dots
  while (d.endsWith('.')) {
    d = d.slice(0, -1);
  }
  // IDN/punycode: convert to ASCII form if needed
  try {
    const url = new URL(`http://${d}`);
    d = url.hostname;
  } catch {
    const log = getLogger();
    log.debug({ domain: d }, 'Domain normalization URL parse failed, using lowercase form');
  }
  return d;
}

export function enforceDomainAllowlist(
  siteId: string,
  targetDomain: string,
): PolicyResult {
  const policy = getSitePolicy(siteId);
  const normalizedTarget = normalizeDomain(targetDomain);

  if (policy.domainAllowlist.length === 0) {
    return {
      allowed: false,
      rule: 'domain.no_allowlist',
      reason: `No domains allowlisted for site '${siteId}'`,
    };
  }

  for (const allowed of policy.domainAllowlist) {
    const normalizedAllowed = normalizeDomain(allowed);
    if (
      normalizedTarget === normalizedAllowed ||
      normalizedTarget.endsWith('.' + normalizedAllowed)
    ) {
      return { allowed: true, rule: 'domain.allowlisted' };
    }
  }

  return {
    allowed: false,
    rule: 'domain.not_allowlisted',
    reason: `Domain '${normalizedTarget}' is not in allowlist for site '${siteId}'`,
  };
}

// ─── Private Network Egress Blocking ──────────────────────────────

const BLOCKED_IPV4_RANGES: string[] = [
  'private',
  'loopback',
  'linkLocal',
  'carrierGradeNat',
  'reserved',
  'benchmarking',
  'broadcast',
  'unspecified',
  'amt',
  'as112',
];

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
  } catch {
    return false;
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

const DNS_CACHE = new Map<string, { result: IpValidationResult; expiresAt: number }>();
const DNS_TTL_MS = 60_000; // 1 minute

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
      DNS_CACHE.set(hostname, { result, expiresAt: Date.now() + DNS_TTL_MS });
      return result;
    }

    const parsed = ipaddr.process(address);
    const range = parsed.range();
    const allowed = isPublicIp(address);

    if (!allowed) {
      log.warn({ hostname, ip: address, range }, 'Blocked private network egress');
    }

    const result: IpValidationResult = { ip: address, allowed, category: range };
    DNS_CACHE.set(hostname, { result, expiresAt: Date.now() + DNS_TTL_MS });
    return result;
  } catch (err) {
    log.error({ hostname, err }, 'DNS resolution failed');
    const result: IpValidationResult = { ip: '', allowed: false, category: 'dns_error' };
    DNS_CACHE.set(hostname, { result, expiresAt: Date.now() + DNS_TTL_MS });
    return result;
  }
}

// ─── Path Risk Heuristics ─────────────────────────────────────────

const pathAllowlist = new Set<string>();

export function addPathAllowlistEntry(path: string): void {
  pathAllowlist.add(path.toLowerCase());
}

export function removePathAllowlistEntry(path: string): void {
  pathAllowlist.delete(path.toLowerCase());
}

export function checkPathRisk(method: string, path: string): PathRiskResult {
  const normalizedPath = path.toLowerCase();

  // Check user-configured allowlist overrides
  if (pathAllowlist.has(normalizedPath)) {
    return { blocked: false };
  }

  const upperMethod = method.toUpperCase();

  if (upperMethod === 'GET' || upperMethod === 'HEAD') {
    for (const pattern of DESTRUCTIVE_GET_PATTERNS) {
      if (pattern.test(path)) {
        return {
          blocked: true,
          reason: `Destructive GET pattern detected: ${pattern.source} on path '${path}'`,
        };
      }
    }
  }

  if (upperMethod === 'POST') {
    for (const pattern of DESTRUCTIVE_POST_PATTERNS) {
      if (pattern.test(path)) {
        return {
          blocked: true,
          reason: `Destructive POST pattern detected: ${pattern.source} on path '${path}'`,
        };
      }
    }
  }

  return { blocked: false };
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
): boolean {
  const upperMethod = method.toUpperCase();
  const policy = getSitePolicy(siteId);

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
): PolicyResult {
  try {
    const url = new URL(targetUrl);
    return enforceDomainAllowlist(siteId, url.hostname);
  } catch {
    return {
      allowed: false,
      rule: 'redirect.invalid_url',
      reason: `Invalid redirect URL: '${targetUrl}'`,
    };
  }
}
