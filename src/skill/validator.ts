import { getLogger } from '../core/logger.js';
import type { SkillSpec, SealedFetchRequest, SealedFetchResponse } from './types.js';

const log = getLogger();

// ─── Types ──────────────────────────────────────────────────────

export interface ValidationResult {
  success: boolean;
  schemaMatch: boolean;
  invariantResults: InvariantResult[];
  errorSignatures: string[];
  responseStatus?: number;
  latencyMs: number;
  timestamp: number;
}

export interface InvariantResult {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface ValidationOptions {
  /** Override the default fetch to inject a test double or use browser-proxied fetch */
  fetchFn?: (req: SealedFetchRequest) => Promise<SealedFetchResponse>;
  /** Additional invariants beyond the skill's configured ones */
  extraInvariants?: CustomInvariant[];
}

export interface CustomInvariant {
  name: string;
  check: (body: unknown, headers: Record<string, string>) => InvariantResult;
}

// ─── Error Signatures ───────────────────────────────────────────

const ERROR_SIGNATURE_PATTERNS: Array<{ name: string; check: (body: string) => boolean }> = [
  {
    name: 'json_error_field',
    check: (body) => {
      try {
        const parsed = JSON.parse(body);
        return parsed != null && typeof parsed === 'object' && ('error' in parsed || 'errors' in parsed);
      } catch {
        return false;
      }
    },
  },
  {
    name: 'please_refresh',
    check: (body) => /please\s+refresh/i.test(body),
  },
  {
    name: 'session_expired',
    check: (body) => /session\s+expired/i.test(body),
  },
  {
    name: 'redirect_to_login',
    check: (body) => {
      // Detect meta-refresh or JS redirect to login pages
      return /(?:window\.location|location\.href|<meta\s+http-equiv="refresh").*(?:login|signin|sign-in|auth)/i.test(body);
    },
  },
];

// ─── Validate Skill ─────────────────────────────────────────────

export async function validateSkill(
  skill: SkillSpec,
  params: Record<string, unknown>,
  options?: ValidationOptions,
): Promise<ValidationResult> {
  const startTime = Date.now();
  const fetchFn = options?.fetchFn ?? defaultFetch;

  // Build the request from the skill spec + params
  const request = buildRequest(skill, params);

  let response: SealedFetchResponse;
  try {
    response = await fetchFn(request);
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    log.warn({ skillId: skill.id, err }, 'Validation fetch failed');
    return {
      success: false,
      schemaMatch: false,
      invariantResults: [],
      errorSignatures: ['fetch_error'],
      latencyMs,
      timestamp: Date.now(),
    };
  }

  const latencyMs = Date.now() - startTime;

  // Check error signatures in 200 responses
  const errorSignatures = detectErrorSignatures(response);

  // Schema match check
  const schemaMatch = checkSchemaMatch(skill, response);

  // Run invariants
  const invariantResults = runInvariants(skill, response, options?.extraInvariants);

  // Determine overall success
  const allInvariantsPassed = invariantResults.every((r) => r.passed);
  const success =
    response.status >= 200 &&
    response.status < 300 &&
    schemaMatch &&
    allInvariantsPassed &&
    errorSignatures.length === 0;

  log.debug(
    {
      skillId: skill.id,
      success,
      status: response.status,
      schemaMatch,
      errorSignatures,
      invariantsPassed: allInvariantsPassed,
      latencyMs,
    },
    'Validation result',
  );

  return {
    success,
    schemaMatch,
    invariantResults,
    errorSignatures,
    responseStatus: response.status,
    latencyMs,
    timestamp: Date.now(),
  };
}

// ─── Request Building ───────────────────────────────────────────

function buildRequest(
  skill: SkillSpec,
  params: Record<string, unknown>,
): SealedFetchRequest {
  // Resolve parameterized path
  let url = skill.pathTemplate;
  for (const [key, value] of Object.entries(params)) {
    url = url.replace(`{${key}}`, encodeURIComponent(String(value)));
  }

  // Ensure full URL
  if (!url.startsWith('http')) {
    const domain = skill.allowedDomains[0] ?? skill.siteId;
    url = `https://${domain}${url}`;
  }

  // Build headers
  const headers: Record<string, string> = {
    'accept': 'application/json',
    ...(skill.requiredHeaders ?? {}),
  };

  // Build body for POST/PUT/PATCH
  let body: string | undefined;
  const upperMethod = skill.method.toUpperCase();
  if (upperMethod === 'POST' || upperMethod === 'PUT' || upperMethod === 'PATCH') {
    // Filter out path params from body
    const pathParamNames = extractPathParams(skill.pathTemplate);
    const bodyParams: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (!pathParamNames.includes(key)) {
        bodyParams[key] = value;
      }
    }
    if (Object.keys(bodyParams).length > 0) {
      body = JSON.stringify(bodyParams);
      headers['content-type'] = 'application/json';
    }
  } else if (upperMethod === 'GET') {
    // Append query params for GET
    const pathParamNames = extractPathParams(skill.pathTemplate);
    const queryEntries: string[] = [];
    for (const [key, value] of Object.entries(params)) {
      if (!pathParamNames.includes(key)) {
        queryEntries.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
      }
    }
    if (queryEntries.length > 0) {
      const separator = url.includes('?') ? '&' : '?';
      url = `${url}${separator}${queryEntries.join('&')}`;
    }
  }

  return { url, method: skill.method, headers, body };
}

// ─── Error Signature Detection ──────────────────────────────────

function detectErrorSignatures(response: SealedFetchResponse): string[] {
  // Only check 200-range responses for hidden errors
  if (response.status < 200 || response.status >= 300) {
    return [];
  }

  const signatures: string[] = [];
  const body = response.body;

  for (const pattern of ERROR_SIGNATURE_PATTERNS) {
    if (pattern.check(body)) {
      signatures.push(pattern.name);
    }
  }

  return signatures;
}

// ─── Schema Match ───────────────────────────────────────────────

function checkSchemaMatch(
  skill: SkillSpec,
  response: SealedFetchResponse,
): boolean {
  if (!skill.outputSchema || Object.keys(skill.outputSchema).length === 0) {
    // No schema to match against — pass by default
    return true;
  }

  // Basic structural check: parse response and verify top-level keys match
  try {
    const parsed = JSON.parse(response.body);
    if (typeof parsed !== 'object' || parsed === null) {
      return false;
    }

    const schemaProps = (skill.outputSchema as Record<string, unknown>).properties as Record<string, unknown> | undefined;
    if (!schemaProps) {
      return true; // No properties defined in schema
    }

    const requiredKeys = ((skill.outputSchema as Record<string, unknown>).required ?? []) as string[];
    for (const key of requiredKeys) {
      if (!(key in parsed)) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

// ─── Invariant Checks ───────────────────────────────────────────

function runInvariants(
  skill: SkillSpec,
  response: SealedFetchResponse,
  extraInvariants?: CustomInvariant[],
): InvariantResult[] {
  const results: InvariantResult[] = [];

  // Default invariants from skill config
  for (const invariantName of skill.validation.semanticChecks) {
    if (invariantName === 'schema_match') {
      // Already handled separately
      continue;
    }
    if (invariantName === 'no_error_signatures') {
      const sigs = detectErrorSignatures(response);
      results.push({
        name: 'no_error_signatures',
        passed: sigs.length === 0,
        detail: sigs.length > 0 ? `Error signatures found: ${sigs.join(', ')}` : undefined,
      });
      continue;
    }
  }

  // Custom invariants from skill spec
  for (const invariant of skill.validation.customInvariants) {
    const result = evaluateCustomInvariant(invariant, response);
    results.push(result);
  }

  // Extra invariants passed via options
  if (extraInvariants) {
    for (const inv of extraInvariants) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        parsed = response.body;
      }
      results.push(inv.check(parsed, response.headers));
    }
  }

  return results;
}

function evaluateCustomInvariant(
  invariant: string,
  response: SealedFetchResponse,
): InvariantResult {
  // Parse invariant expressions like:
  // "must include field X" — check that field X exists in response
  // "must not contain marker Y" — check that string Y is not in response body
  // "field Y must be non-empty" — check that field Y exists and is non-empty

  const mustIncludeField = invariant.match(/^must include field (\w+)$/i);
  if (mustIncludeField) {
    const fieldName = mustIncludeField[1];
    try {
      const parsed = JSON.parse(response.body);
      const has = typeof parsed === 'object' && parsed !== null && fieldName in parsed;
      return {
        name: invariant,
        passed: has,
        detail: has ? undefined : `Field '${fieldName}' not found in response`,
      };
    } catch {
      return { name: invariant, passed: false, detail: 'Response is not valid JSON' };
    }
  }

  const mustNotContain = invariant.match(/^must not contain marker (.+)$/i);
  if (mustNotContain) {
    const marker = mustNotContain[1];
    const contains = response.body.includes(marker);
    return {
      name: invariant,
      passed: !contains,
      detail: contains ? `Marker '${marker}' found in response` : undefined,
    };
  }

  const fieldNonEmpty = invariant.match(/^field (\w+) must be non-empty$/i);
  if (fieldNonEmpty) {
    const fieldName = fieldNonEmpty[1];
    try {
      const parsed = JSON.parse(response.body) as Record<string, unknown>;
      const value = parsed[fieldName];
      const nonEmpty = value != null && value !== '' && !(Array.isArray(value) && value.length === 0);
      return {
        name: invariant,
        passed: nonEmpty,
        detail: nonEmpty ? undefined : `Field '${fieldName}' is empty or missing`,
      };
    } catch {
      return { name: invariant, passed: false, detail: 'Response is not valid JSON' };
    }
  }

  // Unknown invariant — pass by default with warning
  log.warn({ invariant }, 'Unknown custom invariant format, skipping');
  return {
    name: invariant,
    passed: true,
    detail: 'Unknown invariant format — skipped',
  };
}

// ─── Helpers ────────────────────────────────────────────────────

function extractPathParams(template: string): string[] {
  const matches = template.match(/\{(\w+)\}/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(1, -1));
}

async function defaultFetch(req: SealedFetchRequest): Promise<SealedFetchResponse> {
  const response = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
  });

  const body = await response.text();
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    status: response.status,
    headers,
    body,
  };
}
