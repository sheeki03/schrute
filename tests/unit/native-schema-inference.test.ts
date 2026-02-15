import { describe, it, expect } from 'vitest';
import { inferSchemaNative } from '../../src/native/schema-inference.js';
import { inferSchema } from '../../src/capture/schema-inferrer.js';

describe('native schema inference (TS fallback)', () => {
  it('infers schema from simple objects', () => {
    const samples = [
      { name: 'Alice', age: 30 },
      { name: 'Bob', age: 25 },
    ];

    const result = inferSchemaNative(samples);
    expect(result.type).toBe('object');
    expect(result.properties).toBeDefined();
    expect(result.properties!['name']).toBeDefined();
    expect(result.properties!['age']).toBeDefined();
  });

  it('infers array schema', () => {
    const samples = [[1, 2], [3, 4, 5]];

    const result = inferSchemaNative(samples);
    expect(result.type).toBe('array');
    expect(result.items).toBeDefined();
  });

  it('handles empty samples', () => {
    const result = inferSchemaNative([]);
    // Should return empty schema
    expect(result).toBeDefined();
  });

  it('merges schemas with optional fields', () => {
    const samples = [
      { name: 'Alice', email: 'alice@test.com' },
      { name: 'Bob' },
    ];

    const result = inferSchemaNative(samples);
    expect(result.type).toBe('object');
    expect(result.properties!['name']).toBeDefined();
    expect(result.properties!['email']).toBeDefined();
    // 'name' should be required (present in both), 'email' should not
    expect(result.required).toContain('name');
    if (result.required) {
      expect(result.required).not.toContain('email');
    }
  });

  it('matches TS inferSchema output', () => {
    const samples = [
      { x: 1, y: 'hello' },
      { x: 2, y: 'world', z: true },
    ];

    const nativeResult = inferSchemaNative(samples);
    const tsResult = inferSchema(samples);

    // Both should identify 'object' type
    expect(nativeResult.type).toEqual(tsResult.type);
    // Both should have the same property keys
    const nativeKeys = Object.keys(nativeResult.properties ?? {}).sort();
    const tsKeys = Object.keys(tsResult.properties ?? {}).sort();
    expect(nativeKeys).toEqual(tsKeys);
  });
});
