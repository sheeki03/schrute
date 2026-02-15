import { describe, it, expect } from 'vitest';
import { discoverParams, type RequestSample } from '../../src/capture/param-discoverer.js';
import type { StructuredRecord } from '../../src/capture/har-extractor.js';

// ─── Helpers ──────────────────────────────────────────────────────

function makeRecord(
  headers: Record<string, string> = {},
  queryParams: Record<string, string> = {},
  body?: string,
): StructuredRecord {
  return {
    request: {
      method: 'POST',
      url: 'https://api.example.com/data',
      headers,
      body,
      contentType: body ? 'application/json' : undefined,
      queryParams,
    },
    response: {
      status: 200,
      statusText: 'OK',
      headers: {},
    },
    startedAt: Date.now(),
    duration: 50,
  };
}

function makeSample(
  record: StructuredRecord,
  declaredInputs?: Record<string, string>,
): RequestSample {
  return { record, declaredInputs };
}

// ─── Tests ────────────────────────────────────────────────────────

describe('param-discoverer', () => {
  describe('discoverParams', () => {
    it('returns empty array if fewer than 2 recordings', () => {
      const samples = [makeSample(makeRecord())];
      expect(discoverParams(samples)).toEqual([]);
    });

    it('classifies constant fields (same value across samples)', () => {
      const samples = [
        makeSample(makeRecord({ 'x-version': '2.0' }, {})),
        makeSample(makeRecord({ 'x-version': '2.0' }, {})),
        makeSample(makeRecord({ 'x-version': '2.0' }, {})),
      ];

      const evidence = discoverParams(samples);
      const versionField = evidence.find(e => e.fieldPath === 'header.x-version');
      expect(versionField).toBeDefined();
      expect(versionField!.classification).toBe('constant');
    });

    it('classifies parameters that vary with moderate volatility', () => {
      // With 4 samples and 2 unique values, volatility = 0.5 (moderate)
      const samples = [
        makeSample(makeRecord({}, { page: '1' })),
        makeSample(makeRecord({}, { page: '2' })),
        makeSample(makeRecord({}, { page: '1' })),
        makeSample(makeRecord({}, { page: '2' })),
      ];

      const evidence = discoverParams(samples);
      const pageField = evidence.find(e => e.fieldPath === 'query.page');
      expect(pageField).toBeDefined();
      expect(pageField!.classification).toBe('parameter');
    });

    it('classifies ephemeral fields (high volatility, no input correlation)', () => {
      // Each value is unique (volatility = 1.0)
      const samples = [
        makeSample(makeRecord({}, {}, JSON.stringify({ nonce: 'abc111' }))),
        makeSample(makeRecord({}, {}, JSON.stringify({ nonce: 'def222' }))),
        makeSample(makeRecord({}, {}, JSON.stringify({ nonce: 'ghi333' }))),
        makeSample(makeRecord({}, {}, JSON.stringify({ nonce: 'jkl444' }))),
        makeSample(makeRecord({}, {}, JSON.stringify({ nonce: 'mno555' }))),
      ];

      const evidence = discoverParams(samples);
      const nonceField = evidence.find(e => e.fieldPath === 'body.nonce');
      expect(nonceField).toBeDefined();
      expect(nonceField!.classification).toBe('ephemeral');
    });

    it('detects input correlation with declared inputs', () => {
      const samples = [
        makeSample(
          makeRecord({}, { q: 'shoes' }),
          { search: 'shoes' },
        ),
        makeSample(
          makeRecord({}, { q: 'hats' }),
          { search: 'hats' },
        ),
      ];

      const evidence = discoverParams(samples);
      const qField = evidence.find(e => e.fieldPath === 'query.q');
      expect(qField).toBeDefined();
      expect(qField!.correlatesWithInput).toBe(true);
      expect(qField!.classification).toBe('parameter');
    });

    it('computes volatility as uniqueValues/totalValues', () => {
      const samples = [
        makeSample(makeRecord({}, { mode: 'dark' })),
        makeSample(makeRecord({}, { mode: 'dark' })),
        makeSample(makeRecord({}, { mode: 'light' })),
        makeSample(makeRecord({}, { mode: 'light' })),
      ];

      const evidence = discoverParams(samples);
      const modeField = evidence.find(e => e.fieldPath === 'query.mode');
      expect(modeField).toBeDefined();
      // 2 unique / 4 total = 0.5
      expect(modeField!.volatility).toBe(0.5);
    });

    it('handles JSON body fields', () => {
      // 4 samples with 2 unique names gives volatility 0.5 (moderate => parameter)
      // count is the same across all => constant
      const samples = [
        makeSample(makeRecord({}, {}, JSON.stringify({ name: 'Alice', count: 10 }))),
        makeSample(makeRecord({}, {}, JSON.stringify({ name: 'Bob', count: 10 }))),
        makeSample(makeRecord({}, {}, JSON.stringify({ name: 'Alice', count: 10 }))),
        makeSample(makeRecord({}, {}, JSON.stringify({ name: 'Bob', count: 10 }))),
      ];

      const evidence = discoverParams(samples);
      const nameField = evidence.find(e => e.fieldPath === 'body.name');
      expect(nameField).toBeDefined();
      expect(nameField!.classification).toBe('parameter');

      const countField = evidence.find(e => e.fieldPath === 'body.count');
      expect(countField).toBeDefined();
      expect(countField!.classification).toBe('constant');
    });

    it('redacts PII values in observed values', () => {
      const samples = [
        makeSample(makeRecord({}, {}, JSON.stringify({ email: 'user1@example.com' }))),
        makeSample(makeRecord({}, {}, JSON.stringify({ email: 'user2@example.com' }))),
      ];

      const evidence = discoverParams(samples);
      const emailField = evidence.find(e => e.fieldPath === 'body.email');
      expect(emailField).toBeDefined();
      // PII should be redacted with HMAC
      for (const val of emailField!.observedValues) {
        expect(val).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
      }
    });

    it('handles GraphQL variables in body', () => {
      const samples = [
        makeSample(makeRecord({}, {}, JSON.stringify({
          query: 'query GetUser($id: ID!) { user(id: $id) { name } }',
          variables: { id: '123' },
        }))),
        makeSample(makeRecord({}, {}, JSON.stringify({
          query: 'query GetUser($id: ID!) { user(id: $id) { name } }',
          variables: { id: '456' },
        }))),
      ];

      const evidence = discoverParams(samples);
      const idField = evidence.find(e => e.fieldPath === 'graphql_var.id');
      expect(idField).toBeDefined();
    });
  });
});
