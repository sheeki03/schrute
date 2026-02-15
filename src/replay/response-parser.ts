import { getLogger } from '../core/logger.js';
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

// ─── Error Signature Patterns ────────────────────────────────────

const ERROR_SIGNATURES: Array<{ name: string; check: (body: string) => boolean }> = [
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
    name: 'session_expired',
    check: (body) => /session\s+expired/i.test(body),
  },
  {
    name: 'please_refresh',
    check: (body) => /please\s+refresh/i.test(body),
  },
  {
    name: 'redirect_to_login',
    check: (body) =>
      /(?:window\.location|location\.href|<meta\s+http-equiv="refresh").*(?:login|signin|sign-in|auth)/i.test(body),
  },
];

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
    for (const sig of ERROR_SIGNATURES) {
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

// ─── Structural JSON Schema Validation ──────────────────────────

function validateJsonSchema(
  data: unknown,
  schema: Record<string, unknown>,
  path: string,
): string[] {
  const errors: string[] = [];
  const schemaType = schema.type as string | undefined;

  if (schemaType === 'object') {
    if (data == null || typeof data !== 'object' || Array.isArray(data)) {
      errors.push(`${path}: expected object, got ${typeOf(data)}`);
      return errors;
    }

    const record = data as Record<string, unknown>;
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    const required = (schema.required ?? []) as string[];

    // Check required keys
    for (const key of required) {
      if (!(key in record)) {
        errors.push(`${path}: missing required field '${key}'`);
      }
    }

    // Validate property types if defined
    if (properties) {
      for (const [key, propSchema] of Object.entries(properties)) {
        if (key in record) {
          const propErrors = validateJsonSchema(record[key], propSchema, `${path}${key}/`);
          errors.push(...propErrors);
        }
      }
    }
  } else if (schemaType === 'array') {
    if (!Array.isArray(data)) {
      errors.push(`${path}: expected array, got ${typeOf(data)}`);
      return errors;
    }
    const items = schema.items as Record<string, unknown> | undefined;
    if (items) {
      for (let i = 0; i < data.length; i++) {
        const itemErrors = validateJsonSchema(data[i], items, `${path}[${i}]/`);
        errors.push(...itemErrors);
      }
    }
  } else if (schemaType === 'string') {
    if (typeof data !== 'string') {
      errors.push(`${path}: expected string, got ${typeOf(data)}`);
    }
  } else if (schemaType === 'number' || schemaType === 'integer') {
    if (typeof data !== 'number') {
      errors.push(`${path}: expected number, got ${typeOf(data)}`);
    }
  } else if (schemaType === 'boolean') {
    if (typeof data !== 'boolean') {
      errors.push(`${path}: expected boolean, got ${typeOf(data)}`);
    }
  } else if (schemaType === 'null') {
    if (data !== null) {
      errors.push(`${path}: expected null, got ${typeOf(data)}`);
    }
  }
  // If no type specified, accept anything

  return errors;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
