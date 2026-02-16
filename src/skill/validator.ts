import { getLogger } from '../core/logger.js';
import { defaultFetch, ERROR_SIGNATURE_PATTERNS } from '../core/utils.js';
import { resolveUrl, buildDefaultHeaders, buildBodyOrQuery } from '../replay/request-builder.js';
import { evaluateInvariant } from '../shared/invariant-utils.js';
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

// ─── Validate Skill ─────────────────────────────────────────────

export async function validateSkill(
  skill: SkillSpec,
  params: Record<string, unknown>,
  options?: ValidationOptions,
): Promise<ValidationResult> {
  const startTime = Date.now();
  const fetchFn = options?.fetchFn ?? defaultFetch;

  // Build the request from the skill spec + params
  const request = buildValidationRequest(skill, params);

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

function buildValidationRequest(
  skill: SkillSpec,
  params: Record<string, unknown>,
): SealedFetchRequest {
  const resolved = resolveUrl(skill.pathTemplate, params, skill.allowedDomains, skill.siteId);
  const headers = buildDefaultHeaders(skill.requiredHeaders);
  const bodyResult = buildBodyOrQuery(skill.method, resolved.url, params, resolved.pathParamNames, headers);

  return { url: bodyResult.url, method: skill.method, headers, body: bodyResult.body };
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

// Note: Similar checkSchemaMatch exists in replay/semantic-check.ts but with different validation depth.
// This version checks top-level required keys only (shallow structural match).
// See semantic-check.ts for recursive structural validation via validateStructure().
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
  } catch (err) {
    // Re-throw code bugs (TypeError, ReferenceError) so they surface during development.
    // Only swallow validation-related errors (e.g., JSON.parse failure on invalid body).
    if (err instanceof TypeError || err instanceof ReferenceError) {
      throw err;
    }
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
    const result = evaluateCustomInvariantForResponse(invariant, response);
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

function evaluateCustomInvariantForResponse(
  invariant: string,
  response: SealedFetchResponse,
): InvariantResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    parsed = response.body;
  }
  const result = evaluateInvariant(invariant, parsed, response.body);
  return {
    name: invariant,
    passed: result.passed,
    detail: result.reason || undefined,
  };
}

