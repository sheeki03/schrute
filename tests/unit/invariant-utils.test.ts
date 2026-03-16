import { describe, it, expect, vi } from 'vitest';

// ─── Mock logger ─────────────────────────────────────────────────
const { mockWarn } = vi.hoisted(() => {
  const mockWarn = vi.fn();
  return { mockWarn };
});

vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(), warn: mockWarn, error: vi.fn(), debug: vi.fn(),
  }),
}));

import { evaluateInvariant } from '../../src/shared/invariant-utils.js';

describe('evaluateInvariant', () => {
  // ─── Colon-delimited: must_include_field:X ──────────────────
  describe('must_include_field:X', () => {
    it('passes when field exists', () => {
      const result = evaluateInvariant('must_include_field:data', { data: [1, 2] }, '');
      expect(result.passed).toBe(true);
      expect(result.reason).toBe('');
    });

    it('fails when field is missing', () => {
      const result = evaluateInvariant('must_include_field:data', { other: 1 }, '');
      expect(result.passed).toBe(false);
      expect(result.reason).toContain("'data' not found");
    });

    it('fails when parsed body is null', () => {
      const result = evaluateInvariant('must_include_field:data', null, '');
      expect(result.passed).toBe(false);
    });
  });

  // ─── Colon-delimited: must_not_contain:Y ────────────────────
  describe('must_not_contain:Y', () => {
    it('passes when marker is absent from raw body', () => {
      const result = evaluateInvariant('must_not_contain:ERROR', '{"status":"ok"}', '');
      expect(result.passed).toBe(true);
    });

    it('fails when marker is present in raw body', () => {
      const result = evaluateInvariant('must_not_contain:ERROR', {}, '{"status":"ERROR"}');
      expect(result.passed).toBe(false);
      expect(result.reason).toContain("'ERROR' found");
    });
  });

  // ─── Colon-delimited: field_non_empty:X ─────────────────────
  describe('field_non_empty:X', () => {
    it('passes when field has a value', () => {
      const result = evaluateInvariant('field_non_empty:items', { items: [1] }, '');
      expect(result.passed).toBe(true);
    });

    it('fails when field is empty string', () => {
      const result = evaluateInvariant('field_non_empty:name', { name: '' }, '');
      expect(result.passed).toBe(false);
      expect(result.reason).toContain("'name' is empty");
    });

    it('fails when field is empty array', () => {
      const result = evaluateInvariant('field_non_empty:items', { items: [] }, '');
      expect(result.passed).toBe(false);
    });

    it('fails when field is null', () => {
      const result = evaluateInvariant('field_non_empty:items', { items: null }, '');
      expect(result.passed).toBe(false);
    });

    it('fails when field is missing', () => {
      const result = evaluateInvariant('field_non_empty:items', { other: 1 }, '');
      expect(result.passed).toBe(false);
    });
  });

  // ─── Natural-language: must include field X ─────────────────
  describe('must include field X (natural language)', () => {
    it('passes when field exists', () => {
      const result = evaluateInvariant('must include field data', { data: [1] }, '');
      expect(result.passed).toBe(true);
    });

    it('fails when field is missing', () => {
      const result = evaluateInvariant('must include field data', { other: 1 }, '');
      expect(result.passed).toBe(false);
      expect(result.reason).toContain("'data' not found");
    });
  });

  // ─── Natural-language: must not contain marker Y ────────────
  describe('must not contain marker Y (natural language)', () => {
    it('passes when marker is absent', () => {
      const result = evaluateInvariant('must not contain marker FORBIDDEN', {}, '{"ok":true}');
      expect(result.passed).toBe(true);
    });

    it('fails when marker is present', () => {
      const result = evaluateInvariant('must not contain marker FORBIDDEN', {}, 'FORBIDDEN value');
      expect(result.passed).toBe(false);
    });
  });

  // ─── Natural-language: field Y must be non-empty ────────────
  describe('field Y must be non-empty (natural language)', () => {
    it('passes when field has value', () => {
      const result = evaluateInvariant('field results must be non-empty', { results: [1] }, '');
      expect(result.passed).toBe(true);
    });

    it('fails when field is empty', () => {
      const result = evaluateInvariant('field results must be non-empty', { results: [] }, '');
      expect(result.passed).toBe(false);
    });

    it('fails when parsed is null', () => {
      const result = evaluateInvariant('field results must be non-empty', null, '');
      expect(result.passed).toBe(false);
    });
  });

  // ─── Unknown format ─────────────────────────────────────────
  describe('unknown format', () => {
    it('passes by default with a warning', () => {
      mockWarn.mockClear();
      const result = evaluateInvariant('some totally unknown check', {}, '');
      expect(result.passed).toBe(true);
      expect(result.reason).toContain('unknown invariant format');
      expect(mockWarn).toHaveBeenCalledWith(
        expect.objectContaining({ invariant: 'some totally unknown check' }),
        'Unknown custom invariant format',
      );
    });
  });
});
