import { getLogger } from '../core/logger.js';
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

function checkSchemaMatch(parsed: unknown, skill: SkillSpec): boolean {
  if (!skill.outputSchema || Object.keys(skill.outputSchema).length === 0) {
    return true;
  }

  // Structural validation against JSON Schema
  return validateStructure(parsed, skill.outputSchema);
}

function validateStructure(
  data: unknown,
  schema: Record<string, unknown>,
): boolean {
  const schemaType = schema.type as string | undefined;

  if (schemaType === 'object') {
    if (data == null || typeof data !== 'object' || Array.isArray(data)) {
      return false;
    }

    const record = data as Record<string, unknown>;
    const required = (schema.required ?? []) as string[];

    for (const key of required) {
      if (!(key in record)) {
        return false;
      }
    }

    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    if (properties) {
      for (const [key, propSchema] of Object.entries(properties)) {
        if (key in record) {
          if (!validateStructure(record[key], propSchema)) {
            return false;
          }
        }
      }
    }

    return true;
  }

  if (schemaType === 'array') {
    if (!Array.isArray(data)) return false;
    const items = schema.items as Record<string, unknown> | undefined;
    if (items) {
      for (const item of data) {
        if (!validateStructure(item, items)) return false;
      }
    }
    return true;
  }

  if (schemaType === 'string') return typeof data === 'string';
  if (schemaType === 'number' || schemaType === 'integer') return typeof data === 'number';
  if (schemaType === 'boolean') return typeof data === 'boolean';
  if (schemaType === 'null') return data === null;

  // No type constraint — accept anything
  return true;
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

// ─── Custom Invariant Evaluation ────────────────────────────────

function evaluateInvariant(
  invariant: string,
  parsed: unknown,
  rawBody: string,
): { passed: boolean; reason: string } {
  // must_include_field:fieldName
  const includeMatch = invariant.match(/^must_include_field:(\S+)$/);
  if (includeMatch) {
    const fieldName = includeMatch[1];
    if (parsed != null && typeof parsed === 'object' && fieldName in (parsed as Record<string, unknown>)) {
      return { passed: true, reason: '' };
    }
    return { passed: false, reason: `field '${fieldName}' not found` };
  }

  // must_not_contain:marker
  const notContainMatch = invariant.match(/^must_not_contain:(.+)$/);
  if (notContainMatch) {
    const marker = notContainMatch[1];
    if (rawBody.includes(marker)) {
      return { passed: false, reason: `marker '${marker}' found in response` };
    }
    return { passed: true, reason: '' };
  }

  // field_non_empty:fieldName
  const nonEmptyMatch = invariant.match(/^field_non_empty:(\S+)$/);
  if (nonEmptyMatch) {
    const fieldName = nonEmptyMatch[1];
    if (parsed != null && typeof parsed === 'object') {
      const value = (parsed as Record<string, unknown>)[fieldName];
      if (value != null && value !== '' && !(Array.isArray(value) && value.length === 0)) {
        return { passed: true, reason: '' };
      }
    }
    return { passed: false, reason: `field '${fieldName}' is empty or missing` };
  }

  // Unknown invariant — pass with warning
  log.warn({ invariant }, 'Unknown custom invariant format');
  return { passed: true, reason: 'unknown invariant format (skipped)' };
}
