import { describe, it, expect } from 'vitest';
import { detectDrift } from '../../src/healing/diff-engine.js';

describe('diff-engine', () => {
  describe('detectDrift', () => {
    it('returns no drift when live matches schema', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
        required: ['name', 'age'],
      };

      const live = { name: 'Alice', age: 30 };
      const result = detectDrift(schema, live);

      expect(result.drifted).toBe(false);
      expect(result.breaking).toBe(false);
      expect(result.changes).toHaveLength(0);
    });

    it('detects field_added as non-breaking', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name'],
      };

      const live = { name: 'Alice', email: 'alice@example.com' };
      const result = detectDrift(schema, live);

      expect(result.drifted).toBe(true);
      expect(result.breaking).toBe(false);
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].type).toBe('field_added');
      expect(result.changes[0].path).toBe('$.email');
    });

    it('detects field_removed as breaking', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
        required: ['name', 'age'],
      };

      const live = { name: 'Alice' }; // age missing
      const result = detectDrift(schema, live);

      expect(result.drifted).toBe(true);
      expect(result.breaking).toBe(true);
      expect(result.changes.some((c) => c.type === 'field_removed' && c.path === '$.age')).toBe(true);
    });

    it('detects type_changed as breaking', () => {
      const schema = {
        type: 'object',
        properties: {
          count: { type: 'number' },
        },
        required: ['count'],
      };

      const live = { count: 'not-a-number' };
      const result = detectDrift(schema, live);

      expect(result.drifted).toBe(true);
      expect(result.breaking).toBe(true);
      const change = result.changes.find((c) => c.type === 'type_changed');
      expect(change).toBeDefined();
      expect(change!.previous).toBe('number');
      expect(change!.current).toBe('string');
    });

    it('handles null live data as breaking', () => {
      const schema = {
        type: 'object',
        properties: { name: { type: 'string' } },
      };

      const result = detectDrift(schema, null);

      expect(result.drifted).toBe(true);
      expect(result.breaking).toBe(true);
    });

    it('handles empty schema gracefully', () => {
      // Empty schema with no properties — any live field is "added" (non-breaking)
      const result = detectDrift({}, { name: 'Alice' });

      // Fields exist in live data but not in schema = field_added (non-breaking drift)
      expect(result.breaking).toBe(false);
    });

    it('handles array schema with items', () => {
      const schema = {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            name: { type: 'string' },
          },
          required: ['id', 'name'],
        },
      };

      const live = [{ id: 1, name: 'Alice', extra: true }];
      const result = detectDrift(schema, live);

      expect(result.drifted).toBe(true);
      expect(result.breaking).toBe(false);
      expect(result.changes[0].type).toBe('field_added');
    });

    it('detects multiple changes at once', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
          status: { type: 'string' },
        },
        required: ['name', 'age', 'status'],
      };

      const live = { name: 'Alice', age: 'thirty', newField: true };
      // age type changed, status removed, newField added
      const result = detectDrift(schema, live);

      expect(result.drifted).toBe(true);
      expect(result.breaking).toBe(true);
      expect(result.changes.length).toBeGreaterThanOrEqual(2);
    });

    it('allows null for optional fields', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          bio: { type: 'string' },
        },
        required: ['name'], // bio is optional
      };

      const live = { name: 'Alice', bio: null };
      const result = detectDrift(schema, live);

      // bio is optional and null is acceptable
      expect(result.breaking).toBe(false);
    });

    it('detects root type mismatch', () => {
      const schema = {
        type: 'object',
        properties: { name: { type: 'string' } },
      };

      const live = [1, 2, 3]; // array instead of object
      const result = detectDrift(schema, live);

      expect(result.drifted).toBe(true);
      expect(result.breaking).toBe(true);
      expect(result.changes[0].type).toBe('type_changed');
      expect(result.changes[0].previous).toBe('object');
      expect(result.changes[0].current).toBe('array');
    });
  });
});
