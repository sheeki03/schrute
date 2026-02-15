import { describe, it, expect } from 'vitest';
import { inferSchema, detectEnums } from '../../src/capture/schema-inferrer.js';

describe('schema-inferrer', () => {
  describe('inferSchema', () => {
    it('infers object type with properties', () => {
      const schema = inferSchema([{ name: 'Alice', age: 30 }]);
      expect(schema.type).toBe('object');
      expect(schema.properties).toBeDefined();
      expect(schema.properties!.name).toEqual({ type: 'string' });
      expect(schema.properties!.age).toEqual({ type: 'integer' });
    });

    it('detects required vs optional fields', () => {
      const schema = inferSchema([
        { id: 1, name: 'Alice', email: 'a@b.com' },
        { id: 2, name: 'Bob' },
      ]);
      expect(schema.type).toBe('object');
      // id and name present in both -> required
      expect(schema.required).toContain('id');
      expect(schema.required).toContain('name');
      // email only in first sample -> not required
      expect(schema.required).not.toContain('email');
    });

    it('infers array types', () => {
      const schema = inferSchema([[1, 2, 3]]);
      expect(schema.type).toBe('array');
      expect(schema.items).toBeDefined();
      expect(schema.items!.type).toBe('integer');
    });

    it('merges schemas from multiple samples', () => {
      const schema = inferSchema([
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob', role: 'admin' },
      ]);
      expect(schema.type).toBe('object');
      expect(schema.properties).toHaveProperty('id');
      expect(schema.properties).toHaveProperty('name');
      expect(schema.properties).toHaveProperty('role');
      // role is optional (only in second sample)
      expect(schema.required).not.toContain('role');
    });

    it('merges integer + number to number', () => {
      const schema = inferSchema([42, 3.14]);
      // Merged type should collapse integer + number to just number
      if (Array.isArray(schema.type)) {
        expect(schema.type).toContain('number');
        expect(schema.type).not.toContain('integer');
      } else {
        expect(schema.type).toBe('number');
      }
    });

    it('handles empty samples', () => {
      const schema = inferSchema([]);
      expect(schema).toEqual({});
    });

    it('infers boolean type', () => {
      const schema = inferSchema([true]);
      expect(schema.type).toBe('boolean');
    });

    it('infers null type', () => {
      const schema = inferSchema([null]);
      expect(schema.type).toBe('null');
    });

    it('infers nested objects', () => {
      const schema = inferSchema([{ user: { name: 'Alice', id: 1 } }]);
      expect(schema.type).toBe('object');
      expect(schema.properties!.user.type).toBe('object');
      expect(schema.properties!.user.properties!.name.type).toBe('string');
    });
  });

  describe('detectEnums', () => {
    it('detects enum fields with limited distinct values', () => {
      const samples = [
        { status: 'active', name: 'a' },
        { status: 'inactive', name: 'b' },
        { status: 'active', name: 'c' },
        { status: 'inactive', name: 'd' },
      ];
      const enums = detectEnums(samples);
      expect(enums).toHaveProperty('status');
      expect(enums.status).toContain('active');
      expect(enums.status).toContain('inactive');
    });

    it('returns empty for single sample', () => {
      expect(detectEnums([{ status: 'active' }])).toEqual({});
    });
  });
});
