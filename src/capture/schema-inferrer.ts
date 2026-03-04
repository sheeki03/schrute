import { getLogger } from '../core/logger.js';

const log = getLogger();

// ─── JSON Schema Types ───────────────────────────────────────────────

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  description?: string;
  additionalProperties?: boolean;
}

// ─── Public API ──────────────────────────────────────────────────────

export function inferSchema(samples: unknown[]): JsonSchema {
  if (samples.length === 0) {
    return {};
  }

  const schemas = samples.map(inferSingle);
  const merged = schemas.reduce(mergeSchemas);

  log.debug({ sampleCount: samples.length }, 'Inferred JSON schema');
  return merged;
}

// ─── Single Sample Inference ─────────────────────────────────────────

function inferSingle(value: unknown): JsonSchema {
  if (value === null || value === undefined) {
    return { type: 'null' };
  }

  if (typeof value === 'string') {
    return { type: 'string' };
  }

  if (typeof value === 'number') {
    return Number.isInteger(value) ? { type: 'integer' } : { type: 'number' };
  }

  if (typeof value === 'boolean') {
    return { type: 'boolean' };
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return { type: 'array', items: {} };
    }
    const itemSchemas = value.map(inferSingle);
    const mergedItems = itemSchemas.reduce(mergeSchemas);
    return { type: 'array', items: mergedItems };
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];

    for (const [key, val] of Object.entries(obj)) {
      properties[key] = inferSingle(val);
      required.push(key);
    }

    return {
      type: 'object',
      properties,
      required: required.sort(),
    };
  }

  return {};
}

// ─── Schema Merging ──────────────────────────────────────────────────

export function mergeSchemas(a: JsonSchema, b: JsonSchema): JsonSchema {
  const typeA = normalizeType(a.type);
  const typeB = normalizeType(b.type);

  // Merge type sets
  const allTypes = new Set([...typeA, ...typeB]);

  // If both objects, merge properties
  if (typeA.includes('object') && typeB.includes('object')) {
    const mergedProps: Record<string, JsonSchema> = {};
    const allKeys = new Set([
      ...Object.keys(a.properties ?? {}),
      ...Object.keys(b.properties ?? {}),
    ]);

    const reqA = new Set(a.required ?? []);
    const reqB = new Set(b.required ?? []);
    const required: string[] = [];

    for (const key of allKeys) {
      const propA = a.properties?.[key];
      const propB = b.properties?.[key];

      if (propA && propB) {
        mergedProps[key] = mergeSchemas(propA, propB);
        // Only required if required in both
        if (reqA.has(key) && reqB.has(key)) {
          required.push(key);
        }
      } else {
        mergedProps[key] = propA ?? propB!;
        // Not required since missing from one sample
      }
    }

    const result: JsonSchema = {
      type: allTypes.size === 1 ? [...allTypes][0] : [...allTypes],
      properties: mergedProps,
    };

    if (required.length > 0) {
      result.required = required.sort();
    }

    return result;
  }

  // If both arrays, merge items
  if (typeA.includes('array') && typeB.includes('array')) {
    const mergedItems = a.items && b.items
      ? mergeSchemas(a.items, b.items)
      : a.items ?? b.items ?? {};

    return {
      type: allTypes.size === 1 ? [...allTypes][0] : [...allTypes],
      items: mergedItems,
    };
  }

  // Simple type union
  if (allTypes.size === 1) {
    return { type: [...allTypes][0] };
  }

  // integer + number → number
  if (allTypes.has('integer') && allTypes.has('number')) {
    allTypes.delete('integer');
  }

  return { type: [...allTypes] };
}

function normalizeType(type: string | string[] | undefined): string[] {
  if (!type) return ['null'];
  if (Array.isArray(type)) return type;
  return [type];
}

