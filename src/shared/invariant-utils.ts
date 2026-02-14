import { getLogger } from '../core/logger.js';

const log = getLogger();

export interface InvariantEvalResult {
  passed: boolean;
  reason: string;
}

/**
 * Evaluate a custom invariant against a parsed response body and raw body string.
 *
 * Supports two format families:
 *   - Colon-delimited: "must_include_field:X", "must_not_contain:Y", "field_non_empty:X"
 *   - Natural-language: "must include field X", "must not contain marker Y", "field Y must be non-empty"
 *
 * Unknown invariants pass by default with a warning.
 */
export function evaluateInvariant(
  invariant: string,
  parsed: unknown,
  rawBody: string,
): InvariantEvalResult {
  // ── Colon-delimited format ──

  const includeColonMatch = invariant.match(/^must_include_field:(\S+)$/);
  if (includeColonMatch) {
    const fieldName = includeColonMatch[1];
    if (parsed != null && typeof parsed === 'object' && fieldName in (parsed as Record<string, unknown>)) {
      return { passed: true, reason: '' };
    }
    return { passed: false, reason: `field '${fieldName}' not found` };
  }

  const notContainColonMatch = invariant.match(/^must_not_contain:(.+)$/);
  if (notContainColonMatch) {
    const marker = notContainColonMatch[1];
    if (rawBody.includes(marker)) {
      return { passed: false, reason: `marker '${marker}' found in response` };
    }
    return { passed: true, reason: '' };
  }

  const nonEmptyColonMatch = invariant.match(/^field_non_empty:(\S+)$/);
  if (nonEmptyColonMatch) {
    const fieldName = nonEmptyColonMatch[1];
    if (parsed != null && typeof parsed === 'object') {
      const value = (parsed as Record<string, unknown>)[fieldName];
      if (value != null && value !== '' && !(Array.isArray(value) && value.length === 0)) {
        return { passed: true, reason: '' };
      }
    }
    return { passed: false, reason: `field '${fieldName}' is empty or missing` };
  }

  // ── Natural-language format ──

  const mustIncludeField = invariant.match(/^must include field (\w+)$/i);
  if (mustIncludeField) {
    const fieldName = mustIncludeField[1];
    const has = parsed != null && typeof parsed === 'object' && fieldName in (parsed as Record<string, unknown>);
    return {
      passed: has,
      reason: has ? '' : `field '${fieldName}' not found in response`,
    };
  }

  const mustNotContain = invariant.match(/^must not contain marker (.+)$/i);
  if (mustNotContain) {
    const marker = mustNotContain[1];
    const contains = rawBody.includes(marker);
    return {
      passed: !contains,
      reason: contains ? `marker '${marker}' found in response` : '',
    };
  }

  const fieldNonEmpty = invariant.match(/^field (\w+) must be non-empty$/i);
  if (fieldNonEmpty) {
    const fieldName = fieldNonEmpty[1];
    if (parsed != null && typeof parsed === 'object') {
      const value = (parsed as Record<string, unknown>)[fieldName];
      const nonEmpty = value != null && value !== '' && !(Array.isArray(value) && value.length === 0);
      return {
        passed: nonEmpty,
        reason: nonEmpty ? '' : `field '${fieldName}' is empty or missing`,
      };
    }
    return { passed: false, reason: `field '${fieldName}' is empty or missing` };
  }

  // Unknown invariant -- pass by default with warning
  log.warn({ invariant }, 'Unknown custom invariant format');
  return { passed: true, reason: 'unknown invariant format (skipped)' };
}
