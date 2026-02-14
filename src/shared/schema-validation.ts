import { typeOf } from '../core/utils.js';

/**
 * Structural JSON Schema validation that returns a list of error messages.
 * Recursively checks type, required fields, properties, and array items.
 *
 * Used by both response-parser.ts and semantic-check.ts.
 */
export function validateJsonSchema(
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

    for (const key of required) {
      if (!(key in record)) {
        errors.push(`${path}: missing required field '${key}'`);
      }
    }

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
