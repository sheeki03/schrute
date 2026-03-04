import { describe, it, expect } from 'vitest';
import { validateJsonSchema } from '../../src/shared/schema-validation.js';

describe('validateJsonSchema', () => {
  // ─── Basic type matching ──────────────────────────────────────

  describe('basic type matching', () => {
    it('accepts a string value for string type', () => {
      const errors = validateJsonSchema('hello', { type: 'string' }, '/');
      expect(errors).toEqual([]);
    });

    it('rejects a number when string type expected', () => {
      const errors = validateJsonSchema(42, { type: 'string' }, '/');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('expected string');
    });

    it('accepts a number value for number type', () => {
      const errors = validateJsonSchema(3.14, { type: 'number' }, '/');
      expect(errors).toEqual([]);
    });

    it('rejects a string when number type expected', () => {
      const errors = validateJsonSchema('not a number', { type: 'number' }, '/');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('expected number');
    });

    it('accepts an integer value for integer type', () => {
      const errors = validateJsonSchema(42, { type: 'integer' }, '/');
      expect(errors).toEqual([]);
    });

    it('rejects a string when integer type expected', () => {
      const errors = validateJsonSchema('nope', { type: 'integer' }, '/');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('expected number');
    });

    it('accepts a boolean value for boolean type', () => {
      const errors = validateJsonSchema(true, { type: 'boolean' }, '/');
      expect(errors).toEqual([]);
    });

    it('rejects a number when boolean type expected', () => {
      const errors = validateJsonSchema(1, { type: 'boolean' }, '/');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('expected boolean');
    });

    it('accepts null for null type', () => {
      const errors = validateJsonSchema(null, { type: 'null' }, '/');
      expect(errors).toEqual([]);
    });

    it('rejects a string when null type expected', () => {
      const errors = validateJsonSchema('value', { type: 'null' }, '/');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('expected null');
    });
  });

  // ─── Object validation ────────────────────────────────────────

  describe('object validation', () => {
    it('accepts a valid object with required fields', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
        required: ['name', 'age'],
      };
      const errors = validateJsonSchema({ name: 'Alice', age: 30 }, schema, '/');
      expect(errors).toEqual([]);
    });

    it('reports missing required fields', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
        required: ['name', 'age'],
      };
      const errors = validateJsonSchema({ name: 'Alice' }, schema, '/');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("missing required field 'age'");
    });

    it('reports multiple missing required fields', () => {
      const schema = {
        type: 'object',
        properties: {
          a: { type: 'string' },
          b: { type: 'string' },
        },
        required: ['a', 'b'],
      };
      const errors = validateJsonSchema({}, schema, '/');
      expect(errors).toHaveLength(2);
    });

    it('validates property types recursively', () => {
      const schema = {
        type: 'object',
        properties: {
          count: { type: 'number' },
        },
      };
      const errors = validateJsonSchema({ count: 'not a number' }, schema, '/');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('expected number');
    });
  });

  // ─── Nested object validation ─────────────────────────────────

  describe('nested object validation', () => {
    it('validates nested objects recursively', () => {
      const schema = {
        type: 'object',
        properties: {
          user: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              email: { type: 'string' },
            },
            required: ['name'],
          },
        },
      };
      const data = { user: { name: 'Alice', email: 'alice@example.com' } };
      const errors = validateJsonSchema(data, schema, '/');
      expect(errors).toEqual([]);
    });

    it('reports errors in nested objects with correct path', () => {
      const schema = {
        type: 'object',
        properties: {
          user: {
            type: 'object',
            properties: {
              name: { type: 'string' },
            },
            required: ['name'],
          },
        },
      };
      const data = { user: { name: 42 } };
      const errors = validateJsonSchema(data, schema, '/');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('expected string');
      expect(errors[0]).toContain('user/');
    });

    it('reports missing required field in nested object', () => {
      const schema = {
        type: 'object',
        properties: {
          user: {
            type: 'object',
            properties: {
              name: { type: 'string' },
            },
            required: ['name'],
          },
        },
      };
      const data = { user: {} };
      const errors = validateJsonSchema(data, schema, '/');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("missing required field 'name'");
    });
  });

  // ─── Array validation ─────────────────────────────────────────

  describe('array validation', () => {
    it('accepts a valid array with matching items type', () => {
      const schema = {
        type: 'array',
        items: { type: 'string' },
      };
      const errors = validateJsonSchema(['a', 'b', 'c'], schema, '/');
      expect(errors).toEqual([]);
    });

    it('reports type mismatch in array items', () => {
      const schema = {
        type: 'array',
        items: { type: 'number' },
      };
      const errors = validateJsonSchema([1, 'two', 3], schema, '/');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('expected number');
      expect(errors[0]).toContain('[1]');
    });

    it('reports multiple type mismatches in array items', () => {
      const schema = {
        type: 'array',
        items: { type: 'number' },
      };
      const errors = validateJsonSchema(['a', 'b'], schema, '/');
      expect(errors).toHaveLength(2);
    });

    it('accepts empty array', () => {
      const schema = {
        type: 'array',
        items: { type: 'string' },
      };
      const errors = validateJsonSchema([], schema, '/');
      expect(errors).toEqual([]);
    });

    it('accepts array without items schema', () => {
      const schema = { type: 'array' };
      const errors = validateJsonSchema([1, 'two', true], schema, '/');
      expect(errors).toEqual([]);
    });

    it('rejects non-array when array type expected', () => {
      const schema = { type: 'array' };
      const errors = validateJsonSchema('not an array', schema, '/');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('expected array');
    });
  });

  // ─── Schema with no type ──────────────────────────────────────

  describe('schema with no type', () => {
    it('accepts any value when no type is specified', () => {
      const errors = validateJsonSchema('anything', {}, '/');
      expect(errors).toEqual([]);
    });

    it('accepts null when no type is specified', () => {
      const errors = validateJsonSchema(null, {}, '/');
      expect(errors).toEqual([]);
    });

    it('accepts an object when no type is specified', () => {
      const errors = validateJsonSchema({ a: 1 }, {}, '/');
      expect(errors).toEqual([]);
    });

    it('accepts an array when no type is specified', () => {
      const errors = validateJsonSchema([1, 2], {}, '/');
      expect(errors).toEqual([]);
    });
  });

  // ─── Empty schema ─────────────────────────────────────────────

  describe('empty schema', () => {
    it('accepts anything with empty schema', () => {
      expect(validateJsonSchema(42, {}, '/')).toEqual([]);
      expect(validateJsonSchema('str', {}, '/')).toEqual([]);
      expect(validateJsonSchema(null, {}, '/')).toEqual([]);
      expect(validateJsonSchema(true, {}, '/')).toEqual([]);
      expect(validateJsonSchema([], {}, '/')).toEqual([]);
      expect(validateJsonSchema({}, {}, '/')).toEqual([]);
    });
  });

  // ─── Type mismatches ──────────────────────────────────────────

  describe('type mismatches', () => {
    it('rejects an array when object type expected', () => {
      const schema = { type: 'object' };
      const errors = validateJsonSchema([1, 2, 3], schema, '/');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('expected object');
      expect(errors[0]).toContain('array');
    });

    it('rejects null when object type expected', () => {
      const schema = { type: 'object' };
      const errors = validateJsonSchema(null, schema, '/');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('expected object');
    });

    it('rejects a string when object type expected', () => {
      const schema = { type: 'object' };
      const errors = validateJsonSchema('hello', schema, '/');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('expected object');
    });
  });

  // ─── Null value handling ──────────────────────────────────────

  describe('null value handling', () => {
    it('rejects null when string type expected', () => {
      const errors = validateJsonSchema(null, { type: 'string' }, '/');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('expected string');
    });

    it('rejects null when number type expected', () => {
      const errors = validateJsonSchema(null, { type: 'number' }, '/');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('expected number');
    });

    it('rejects null when boolean type expected', () => {
      const errors = validateJsonSchema(null, { type: 'boolean' }, '/');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('expected boolean');
    });

    it('rejects null when array type expected', () => {
      const errors = validateJsonSchema(null, { type: 'array' }, '/');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('expected array');
    });

    it('accepts null when null type expected', () => {
      const errors = validateJsonSchema(null, { type: 'null' }, '/');
      expect(errors).toEqual([]);
    });

    it('accepts null when no type is specified', () => {
      const errors = validateJsonSchema(null, {}, '/');
      expect(errors).toEqual([]);
    });
  });
});
