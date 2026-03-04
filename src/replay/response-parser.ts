import { getLogger } from '../core/logger.js';
import { ERROR_SIGNATURE_PATTERNS } from '../core/utils.js';
import { validateJsonSchema } from '../shared/schema-validation.js';
import type { SkillSpec } from '../skill/types.js';

const log = getLogger();

// ─── Types ──────────────────────────────────────────────────────

export interface ParsedResponse {
  data: unknown;
  schemaMatch: boolean;
  errors: ResponseError[];
}

export interface ResponseError {
  type: 'schema_mismatch' | 'error_signature' | 'parse_error';
  message: string;
  detail?: string;
}

// ─── Parse Response ─────────────────────────────────────────────

export function parseResponse(
  response: { status: number; headers: Record<string, string>; body: string },
  skill: SkillSpec,
): ParsedResponse {
  const errors: ResponseError[] = [];

  // Try parsing the body
  let data: unknown;
  try {
    data = JSON.parse(response.body);
  } catch {
    data = response.body;
    if (skill.outputSchema && Object.keys(skill.outputSchema).length > 0) {
      errors.push({
        type: 'parse_error',
        message: 'Response body is not valid JSON',
      });
    }
  }

  // Detect error signatures in 200-range responses
  if (response.status >= 200 && response.status < 300) {
    for (const sig of ERROR_SIGNATURE_PATTERNS) {
      if (sig.check(response.body)) {
        errors.push({
          type: 'error_signature',
          message: `Error signature detected: ${sig.name}`,
          detail: sig.name,
        });
      }
    }
  }

  // Validate against stored JSON Schema (structural validation)
  let schemaMatch = true;
  if (skill.outputSchema && Object.keys(skill.outputSchema).length > 0) {
    const schemaErrors = validateJsonSchema(data, skill.outputSchema, '/');
    if (schemaErrors.length > 0) {
      schemaMatch = false;
      for (const se of schemaErrors) {
        errors.push({
          type: 'schema_mismatch',
          message: se,
        });
      }
    }
  }

  log.debug(
    { skillId: skill.id, schemaMatch, errorCount: errors.length },
    'Parsed response',
  );

  return { data, schemaMatch, errors };
}

