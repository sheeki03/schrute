import { getLogger } from '../core/logger.js';
import { evaluateInvariant } from '../shared/invariant-utils.js';
import { validateJsonSchema } from '../shared/schema-validation.js';
import type { SkillSpec } from '../skill/types.js';

const log = getLogger();

// ─── Types ──────────────────────────────────────────────────────

export interface SemanticCheckResult {
  pass: boolean;
  details: string[];
}

// ─── Semantic Check ─────────────────────────────────────────────

export function checkSemantic(
  response: { status: number; headers: Record<string, string>; body: string },
  skill: SkillSpec,
): SemanticCheckResult {
  const details: string[] = [];
  let pass = true;

  // Parse body once
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    parsed = response.body;
  }

  // Default checks from skill.validation.semanticChecks
  for (const check of skill.validation.semanticChecks) {
    if (check === 'schema_match') {
      const schemaOk = checkSchemaMatch(parsed, skill);
      if (!schemaOk) {
        pass = false;
        details.push('schema_match: response does not match stored JSON Schema');
      } else {
        details.push('schema_match: OK');
      }
      continue;
    }

    if (check === 'no_error_signatures') {
      const errorSigs = checkErrorSignatures(response.body);
      if (errorSigs.length > 0) {
        pass = false;
        details.push(`no_error_signatures: found [${errorSigs.join(', ')}]`);
      } else {
        details.push('no_error_signatures: OK');
      }
      continue;
    }

    // Unknown default check — skip with warning
    log.warn({ check, skillId: skill.id }, 'Unknown semantic check, skipping');
    details.push(`${check}: skipped (unknown)`);
  }

  // Per-skill configurable invariants
  for (const invariant of skill.validation.customInvariants) {
    const result = evaluateInvariant(invariant, parsed, response.body);
    if (!result.passed) {
      pass = false;
    }
    details.push(`${invariant}: ${result.passed ? 'OK' : result.reason}`);
  }

  log.debug(
    { skillId: skill.id, pass, detailCount: details.length },
    'Semantic check complete',
  );

  return { pass, details };
}

// ─── Schema Match ───────────────────────────────────────────────

// Uses the shared validateJsonSchema for recursive structural validation.
// Returns boolean (no errors = match).
function checkSchemaMatch(parsed: unknown, skill: SkillSpec): boolean {
  if (!skill.outputSchema || Object.keys(skill.outputSchema).length === 0) {
    return true;
  }

  const errors = validateJsonSchema(parsed, skill.outputSchema, '/');
  return errors.length === 0;
}

// ─── Error Signature Detection ──────────────────────────────────

function checkErrorSignatures(body: string): string[] {
  const found: string[] = [];

  try {
    const parsed = JSON.parse(body);
    if (parsed != null && typeof parsed === 'object') {
      if ('error' in parsed) found.push('error_field');
      if ('errors' in parsed) found.push('errors_field');
    }
  } catch {
    // not JSON, skip
  }

  if (/session\s+expired/i.test(body)) found.push('session_expired');
  if (/please\s+refresh/i.test(body)) found.push('please_refresh');

  return found;
}

// evaluateInvariant imported from shared/invariant-utils.ts
// Supports both colon-delimited and natural-language invariant formats.
