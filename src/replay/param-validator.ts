import { extractPathParams } from '../core/utils.js';
import { isParamRequired } from '../skill/types.js';
import { sanitizeParamKey } from '../server/tool-registry.js';
import type { SkillSpec, ParamLimits } from '../skill/types.js';

// ─── Interfaces ─────────────────────────────────────────────────────

interface ParamValidationResult {
  valid: boolean;
  errors: string[];
}

// ─── Schema Builder ─────────────────────────────────────────────────

export function buildExecutionSchema(skill: SkillSpec): {
  properties: Record<string, { type: string }>;
  required: string[];
} {
  const pathParams = extractPathParams(skill.pathTemplate ?? '');
  const pathParamEntries: [string, { type: string }][] = pathParams.map((pp) => [
    pp,
    { type: 'string' },
  ]);

  const params = skill.parameters ?? [];
  const skillParamEntries: [string, { type: string }][] = params.map((p) => [
    sanitizeParamKey(p.name),
    { type: p.type },
  ]);

  const properties = Object.fromEntries([...pathParamEntries, ...skillParamEntries]);

  const requiredFromPath = pathParams;
  const requiredFromSkill = params
    .filter(isParamRequired)
    .map((p) => sanitizeParamKey(p.name));
  const required = [...new Set([...requiredFromPath, ...requiredFromSkill])];

  return { properties, required };
}

// ─── Helpers ────────────────────────────────────────────────────────

function getDepth(value: unknown, current = 0): number {
  if (value === null || value === undefined || typeof value !== 'object') {
    return current;
  }
  if (Array.isArray(value)) {
    let max = current + 1;
    for (const item of value) {
      const d = getDepth(item, current + 1);
      if (d > max) max = d;
    }
    return max;
  }
  let max = current + 1;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const d = getDepth((value as Record<string, unknown>)[key], current + 1);
    if (d > max) max = d;
  }
  return max;
}

function checkStringLengths(value: unknown, maxLen: number, path = ''): string[] {
  const errors: string[] = [];
  if (typeof value === 'string') {
    if (value.length > maxLen) {
      errors.push(`String at '${path || 'root'}' exceeds max length ${maxLen} (got ${value.length})`);
    }
    return errors;
  }
  if (value === null || value === undefined || typeof value !== 'object') {
    return errors;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      errors.push(...checkStringLengths(value[i], maxLen, `${path}[${i}]`));
    }
    return errors;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    errors.push(...checkStringLengths((value as Record<string, unknown>)[key], maxLen, childPath));
  }
  return errors;
}

function checkType(value: unknown, expectedType: string): boolean {
  switch (expectedType) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    default:
      // Unknown type — accept any value
      return true;
  }
}

// ─── Validator ──────────────────────────────────────────────────────

export function validateParams(
  params: Record<string, unknown>,
  skill: SkillSpec,
  limits?: Partial<ParamLimits>,
): ParamValidationResult {
  const maxStringLength = limits?.maxStringLength ?? 10_000;
  const maxDepth = limits?.maxDepth ?? 5;
  const maxProperties = limits?.maxProperties ?? 50;

  const errors: string[] = [];
  const schema = buildExecutionSchema(skill);

  // (a) Total property count
  const keys = Object.keys(params);
  if (keys.length > maxProperties) {
    errors.push(`Too many properties: ${keys.length} exceeds limit of ${maxProperties}`);
  }

  // (b) Reject unknown keys
  for (const key of keys) {
    if (!(key in schema.properties)) {
      errors.push(`Unknown parameter: '${key}'`);
    }
  }

  // (c) Required fields present
  for (const req of schema.required) {
    if (!(req in params) || params[req] === undefined) {
      errors.push(`Missing required parameter: '${req}'`);
    }
  }

  // (d) Type checking
  for (const key of keys) {
    if (key in schema.properties) {
      const expected = schema.properties[key].type;
      const value = params[key];
      if (value !== undefined && value !== null && !checkType(value, expected)) {
        errors.push(`Type mismatch for '${key}': expected ${expected}, got ${typeof value}`);
      }
    }
  }

  // (e) String length check (recursive)
  errors.push(...checkStringLengths(params, maxStringLength));

  // (f) Nesting depth check
  const depth = getDepth(params);
  if (depth > maxDepth) {
    errors.push(`Object nesting depth ${depth} exceeds limit of ${maxDepth}`);
  }

  return { valid: errors.length === 0, errors };
}
