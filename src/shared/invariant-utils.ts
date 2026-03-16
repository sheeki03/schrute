import { getLogger } from '../core/logger.js';

const log = getLogger();

interface InvariantEvalResult {
  passed: boolean;
  reason: string;
}

// ─── Normalized Invariant ──────────────────────────────────────

type InvariantKind = 'must_include_field' | 'must_not_contain' | 'field_non_empty';

interface NormalizedInvariant {
  kind: InvariantKind;
  argument: string;
}

/**
 * Parse an invariant string into a normalized struct.
 * Supports both colon-delimited and natural-language formats.
 * Returns null for unrecognized formats.
 */
function parseInvariant(invariant: string): NormalizedInvariant | null {
  // Colon-delimited: "must_include_field:X"
  const includeColon = invariant.match(/^must_include_field:(\S+)$/);
  if (includeColon) return { kind: 'must_include_field', argument: includeColon[1] };

  // Colon-delimited: "must_not_contain:Y"
  const notContainColon = invariant.match(/^must_not_contain:(.+)$/);
  if (notContainColon) return { kind: 'must_not_contain', argument: notContainColon[1] };

  // Colon-delimited: "field_non_empty:X"
  const nonEmptyColon = invariant.match(/^field_non_empty:(\S+)$/);
  if (nonEmptyColon) return { kind: 'field_non_empty', argument: nonEmptyColon[1] };

  // Natural-language: "must include field X"
  const includeNL = invariant.match(/^must include field (\w+)$/i);
  if (includeNL) return { kind: 'must_include_field', argument: includeNL[1] };

  // Natural-language: "must not contain marker Y"
  const notContainNL = invariant.match(/^must not contain marker (.+)$/i);
  if (notContainNL) return { kind: 'must_not_contain', argument: notContainNL[1] };

  // Natural-language: "field Y must be non-empty"
  const nonEmptyNL = invariant.match(/^field (\w+) must be non-empty$/i);
  if (nonEmptyNL) return { kind: 'field_non_empty', argument: nonEmptyNL[1] };

  return null;
}

// ─── Evaluation ────────────────────────────────────────────────

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
  const normalized = parseInvariant(invariant);

  if (!normalized) {
    log.warn({ invariant }, 'Unknown custom invariant format');
    return { passed: true, reason: 'unknown invariant format (skipped)' };
  }

  switch (normalized.kind) {
    case 'must_include_field': {
      const fieldName = normalized.argument;
      const has = parsed != null && typeof parsed === 'object' && fieldName in (parsed as Record<string, unknown>);
      return {
        passed: has,
        reason: has ? '' : `field '${fieldName}' not found in response`,
      };
    }

    case 'must_not_contain': {
      const marker = normalized.argument;
      const contains = rawBody.includes(marker);
      return {
        passed: !contains,
        reason: contains ? `marker '${marker}' found in response` : '',
      };
    }

    case 'field_non_empty': {
      const fieldName = normalized.argument;
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
  }
}
