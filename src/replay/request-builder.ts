import { getLogger } from '../core/logger.js';
import { extractPathParams } from '../core/utils.js';
import { isDomainMatch } from '../shared/domain-utils.js';
import type {
  SkillSpec,
  ExecutionTierName,
  AuthRecipe,
  SealedFetchRequest,
} from '../skill/types.js';
import {
  ExecutionTier,
  TIER1_ALLOWED_HEADERS,
  BLOCKED_HOP_BY_HOP_HEADERS,
} from '../skill/types.js';

const log = getLogger();

// Tier 3 blocked headers: blocks hop-by-hop + proxy + security-sensitive
// headers that should not be forwarded through browser-proxied fetches.
// Less restrictive than Tier 1 (which uses an allowlist), but still filters
// dangerous headers.
const TIER3_BLOCKED_HEADERS: string[] = [
  // hop-by-hop (duplicates the global filter for defense-in-depth)
  'host', 'connection', 'transfer-encoding', 'upgrade', 'te', 'trailer',
  'keep-alive', 'via',
  // proxy headers
  'proxy-authorization', 'proxy-connection', 'proxy-authenticate',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip',
  // security-sensitive: do not leak internal routing / debug info
  'x-request-id', 'x-correlation-id', 'x-amzn-trace-id',
  'x-debug', 'x-debug-token', 'x-powered-by',
];

// ─── Types ──────────────────────────────────────────────────────

export interface BuildRequestResult {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

// ─── Build Request ──────────────────────────────────────────────

export function buildRequest(
  skill: SkillSpec,
  params: Record<string, unknown>,
  tier: ExecutionTierName,
  authRecipe?: AuthRecipe,
): BuildRequestResult {
  // Resolve parameterized URL
  const resolved = resolveUrl(skill.pathTemplate, params, skill.allowedDomains, skill.siteId);
  let url = resolved.url;
  const pathParamNames = resolved.pathParamNames;

  // Build base headers
  const headers = buildDefaultHeaders(skill.requiredHeaders);

  // Inject auth if skill has authType and recipe is provided
  if (skill.authType && authRecipe) {
    injectAuth(headers, authRecipe);
  }

  // Build body for write methods, or query params for GET/HEAD
  const bodyResult = buildBodyOrQuery(skill.method, url, params, pathParamNames, headers);
  url = bodyResult.url;
  const body = bodyResult.body;

  // Derive Origin/Referer from target domain at runtime (never from captures)
  const upperMethod = skill.method.toUpperCase();
  const targetDomain = extractDomain(url);
  if (targetDomain && (upperMethod === 'POST' || upperMethod === 'PUT' || upperMethod === 'PATCH')) {
    headers['origin'] = `https://${targetDomain}`;
    headers['referer'] = `https://${targetDomain}/`;
  }

  // Filter headers through tier-appropriate allowlist
  const filtered = filterHeadersForTier(headers, tier, skill.allowedDomains, targetDomain);

  // Content-Length: ALWAYS computed internally from body, never from captures
  if (body != null) {
    filtered['content-length'] = String(new TextEncoder().encode(body).byteLength);
  }

  log.debug(
    { skillId: skill.id, method: skill.method, url, tier },
    'Built request',
  );

  return {
    url,
    method: skill.method,
    headers: filtered,
    body,
  };
}

// ─── Auth Injection ─────────────────────────────────────────────

export function injectAuth(
  headers: Record<string, string>,
  recipe: AuthRecipe,
): void {
  if (recipe.injection.location === 'header') {
    const prefix = recipe.injection.prefix ?? '';
    // The actual secret value is populated by the secrets store at runtime.
    // We set the structure here; the caller fills in the credential.
    headers[recipe.injection.key.toLowerCase()] = `${prefix}{{SECRET}}`;
  } else if (recipe.injection.location === 'cookie') {
    const existing = headers['cookie'] ?? '';
    const separator = existing ? '; ' : '';
    headers['cookie'] = `${existing}${separator}${recipe.injection.key}={{SECRET}}`;
  } else if (recipe.injection.location === 'query') {
    // Query-based auth is handled by the caller adding it to the URL
  }
}

// ─── Header Filtering ───────────────────────────────────────────

function filterHeadersForTier(
  headers: Record<string, string>,
  tier: ExecutionTierName,
  allowedDomains: string[],
  requestDomain?: string,
): Record<string, string> {
  const filtered: Record<string, string> = {};
  const isDomainAllowlisted = requestDomain
    ? isDomainMatch(requestDomain, allowedDomains)
    : false;

  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();

    // Always block hop-by-hop headers
    if ((BLOCKED_HOP_BY_HOP_HEADERS as readonly string[]).includes(lowerKey)) {
      continue;
    }

    // Block proxy-* headers
    if (lowerKey.startsWith('proxy-')) {
      continue;
    }

    // Never forward Content-Length from captures (computed internally)
    if (lowerKey === 'content-length') {
      continue;
    }

    // Tier 1 specific filtering
    if (tier === ExecutionTier.DIRECT) {
      if (!(TIER1_ALLOWED_HEADERS as readonly string[]).includes(lowerKey)) {
        // Allow origin/referer we derived at runtime
        if (lowerKey !== 'origin' && lowerKey !== 'referer') {
          continue;
        }
      }
      // Authorization and Cookie only if domain is allowlisted
      if (
        (lowerKey === 'authorization' || lowerKey === 'cookie') &&
        !isDomainAllowlisted
      ) {
        continue;
      }
    }

    // Tier 3 specific filtering: less restrictive than Tier 1 but still
    // blocks hop-by-hop, proxy, and security-sensitive headers
    if (tier === ExecutionTier.BROWSER_PROXIED) {
      if (TIER3_BLOCKED_HEADERS.includes(lowerKey)) {
        continue;
      }
    }

    filtered[lowerKey] = value;
  }

  return filtered;
}

// ─── Shared Request Building Helpers ─────────────────────────────
// Used by compiler.ts and validator.ts to avoid duplicating URL resolution,
// header defaults, and body/query construction.

/**
 * Resolve a parameterized path template to a full URL.
 * Replaces {param} placeholders with URL-encoded values from params.
 * Prepends https://{domain} if the path is not already a full URL.
 */
export function resolveUrl(
  pathTemplate: string,
  params: Record<string, unknown>,
  allowedDomains: string[],
  siteId: string,
): { url: string; pathParamNames: string[] } {
  let url = pathTemplate;
  const pathParamNames = extractPathParams(pathTemplate);

  for (const paramName of pathParamNames) {
    if (paramName in params) {
      url = url.replace(
        `{${paramName}}`,
        encodeURIComponent(String(params[paramName])),
      );
    } else {
      log.warn({ paramName, pathTemplate }, 'Path parameter not provided — URL will contain unresolved placeholder');
    }
  }

  if (!url.startsWith('http')) {
    const domain = allowedDomains[0] ?? siteId;
    url = `https://${domain}${url}`;
  }

  return { url, pathParamNames };
}

/**
 * Build default headers for a request: accept + requiredHeaders from the skill.
 */
export function buildDefaultHeaders(
  requiredHeaders?: Record<string, string>,
): Record<string, string> {
  return {
    accept: 'application/json',
    ...(requiredHeaders ?? {}),
  };
}

/**
 * Build body (for POST/PUT/PATCH) or append query params (for GET/HEAD).
 * Excludes path parameters from the body/query.
 * Returns the potentially modified URL and optional body string.
 */
export function buildBodyOrQuery(
  method: string,
  url: string,
  params: Record<string, unknown>,
  pathParamNames: string[],
  headers: Record<string, string>,
): { url: string; body?: string } {
  const upperMethod = method.toUpperCase();

  if (upperMethod === 'POST' || upperMethod === 'PUT' || upperMethod === 'PATCH') {
    const bodyParams: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (!pathParamNames.includes(key)) {
        bodyParams[key] = value;
      }
    }
    if (Object.keys(bodyParams).length > 0) {
      const body = JSON.stringify(bodyParams);
      headers['content-type'] = headers['content-type'] ?? 'application/json';
      return { url, body };
    }
  } else if (upperMethod === 'GET' || upperMethod === 'HEAD') {
    const queryEntries: string[] = [];
    for (const [key, value] of Object.entries(params)) {
      if (!pathParamNames.includes(key)) {
        queryEntries.push(
          `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
        );
      }
    }
    if (queryEntries.length > 0) {
      const separator = url.includes('?') ? '&' : '?';
      return { url: `${url}${separator}${queryEntries.join('&')}` };
    }
  }

  return { url };
}

// ─── Helpers ────────────────────────────────────────────────────

export function extractDomain(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}
