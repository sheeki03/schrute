import { describe, it, expect, vi } from 'vitest';

// ─── Mock logger ─────────────────────────────────────────────────
vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock native canonicalizer to use TS-like fallback
vi.mock('../../src/native/canonicalizer.js', () => ({
  canonicalizeRequestNative: (req: {
    method: string;
    url: string;
    body?: string;
    contentType?: string;
  }) => ({
    method: req.method.toUpperCase(),
    canonicalUrl: req.url,
    canonicalBody: req.body,
    contentType: req.contentType,
  }),
}));

// Mock parameterizePath from api-extractor
vi.mock('../../src/capture/api-extractor.js', () => ({
  parameterizePath: (path: string) => {
    // Simple UUID/numeric parameterization
    return path
      .split('/')
      .map((seg: string) => {
        if (!seg) return seg;
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return '{uuid}';
        if (/^\d+$/.test(seg)) return '{id}';
        return seg;
      })
      .join('/');
  },
}));

import { deduplicate } from '../../src/capture/deduplicator.js';
import type { RequestSample } from '../../src/capture/param-discoverer.js';
import type { StructuredRecord } from '../../src/capture/har-extractor.js';

// ─── Helpers ─────────────────────────────────────────────────────

function makeRecord(overrides: Partial<{
  method: string;
  url: string;
  body?: string;
  contentType?: string;
  queryParams?: Record<string, string>;
  headers?: Record<string, string>;
  status?: number;
}> = {}): StructuredRecord {
  return {
    request: {
      method: overrides.method ?? 'GET',
      url: overrides.url ?? 'https://example.com/api/users',
      headers: overrides.headers ?? { 'accept': 'application/json' },
      body: overrides.body,
      contentType: overrides.contentType,
      queryParams: overrides.queryParams ?? {},
    },
    response: {
      status: overrides.status ?? 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      body: '{"data":[]}',
    },
    startedAt: Date.now(),
    duration: 50,
  };
}

function makeSample(recordOverrides?: Parameters<typeof makeRecord>[0]): RequestSample {
  return { record: makeRecord(recordOverrides) };
}

// ─── Tests ───────────────────────────────────────────────────────

describe('deduplicator', () => {
  // ─── Exact Duplicate Detection ─────────────────────────────────

  describe('exact duplicate detection', () => {
    it('marks identical requests as duplicates', () => {
      const sample1 = makeSample({ method: 'GET', url: 'https://example.com/api/users' });
      const sample2 = makeSample({ method: 'GET', url: 'https://example.com/api/users' });

      const results = deduplicate([[sample1, sample2]]);
      expect(results).toHaveLength(2);
      expect(results[0].isDuplicate).toBe(false);
      expect(results[1].isDuplicate).toBe(true);
    });

    it('does not mark different methods as duplicates', () => {
      const get = makeSample({ method: 'GET', url: 'https://example.com/api/users' });
      const post = makeSample({ method: 'POST', url: 'https://example.com/api/users' });

      const results = deduplicate([[get, post]]);
      expect(results[0].isDuplicate).toBe(false);
      expect(results[1].isDuplicate).toBe(false);
    });

    it('does not mark different paths as duplicates', () => {
      const users = makeSample({ method: 'GET', url: 'https://example.com/api/users' });
      const posts = makeSample({ method: 'GET', url: 'https://example.com/api/posts' });

      const results = deduplicate([[users, posts]]);
      expect(results[0].isDuplicate).toBe(false);
      expect(results[1].isDuplicate).toBe(false);
    });

    it('assigns consistent canonicalKey to duplicates', () => {
      const sample1 = makeSample({ method: 'GET', url: 'https://example.com/api/data' });
      const sample2 = makeSample({ method: 'GET', url: 'https://example.com/api/data' });

      const results = deduplicate([[sample1, sample2]]);
      expect(results[0].canonicalKey).toBe(results[1].canonicalKey);
    });
  });

  // ─── Fingerprinting with Various Body Types ────────────────────

  describe('fingerprinting with various body types', () => {
    it('treats requests with same JSON keys as duplicates regardless of values', () => {
      const sample1 = makeSample({
        method: 'POST',
        url: 'https://example.com/api/submit',
        body: JSON.stringify({ name: 'Alice', age: 30 }),
        contentType: 'application/json',
      });
      const sample2 = makeSample({
        method: 'POST',
        url: 'https://example.com/api/submit',
        body: JSON.stringify({ name: 'Bob', age: 25 }),
        contentType: 'application/json',
      });

      const results = deduplicate([[sample1, sample2]]);
      expect(results[0].isDuplicate).toBe(false);
      expect(results[1].isDuplicate).toBe(true);
    });

    it('treats requests with different JSON keys as unique', () => {
      const sample1 = makeSample({
        method: 'POST',
        url: 'https://example.com/api/submit',
        body: JSON.stringify({ name: 'Alice' }),
        contentType: 'application/json',
      });
      const sample2 = makeSample({
        method: 'POST',
        url: 'https://example.com/api/submit',
        body: JSON.stringify({ email: 'alice@test.com' }),
        contentType: 'application/json',
      });

      const results = deduplicate([[sample1, sample2]]);
      expect(results[0].isDuplicate).toBe(false);
      expect(results[1].isDuplicate).toBe(false);
    });

    it('treats non-JSON bodies with empty fingerprint as same', () => {
      const sample1 = makeSample({
        method: 'POST',
        url: 'https://example.com/api/upload',
        body: 'raw-data-version-1',
        contentType: 'text/plain',
      });
      const sample2 = makeSample({
        method: 'POST',
        url: 'https://example.com/api/upload',
        body: 'raw-data-version-2',
        contentType: 'text/plain',
      });

      // Non-JSON bodies produce empty body fingerprint, so they look the same
      const results = deduplicate([[sample1, sample2]]);
      expect(results[1].isDuplicate).toBe(true);
    });
  });

  // ─── Edge Cases ────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty body', () => {
      const sample1 = makeSample({ method: 'GET', url: 'https://example.com/api/data' });
      const sample2 = makeSample({ method: 'GET', url: 'https://example.com/api/data', body: undefined });

      const results = deduplicate([[sample1, sample2]]);
      expect(results).toHaveLength(2);
      expect(results[0].isDuplicate).toBe(false);
      expect(results[1].isDuplicate).toBe(true);
    });

    it('handles empty sessions array', () => {
      const results = deduplicate([]);
      expect(results).toHaveLength(0);
    });

    it('handles session with no samples', () => {
      const results = deduplicate([[]]);
      expect(results).toHaveLength(0);
    });

    it('handles single sample (never duplicate)', () => {
      const results = deduplicate([[makeSample()]]);
      expect(results).toHaveLength(1);
      expect(results[0].isDuplicate).toBe(false);
    });

    it('handles large JSON payloads', () => {
      const largeObj: Record<string, string> = {};
      for (let i = 0; i < 100; i++) {
        largeObj[`field_${i}`] = `value_${i}`;
      }

      const sample1 = makeSample({
        method: 'POST',
        url: 'https://example.com/api/bulk',
        body: JSON.stringify(largeObj),
        contentType: 'application/json',
      });

      // Same keys, different values
      const largeObj2: Record<string, string> = {};
      for (let i = 0; i < 100; i++) {
        largeObj2[`field_${i}`] = `different_${i}`;
      }
      const sample2 = makeSample({
        method: 'POST',
        url: 'https://example.com/api/bulk',
        body: JSON.stringify(largeObj2),
        contentType: 'application/json',
      });

      const results = deduplicate([[sample1, sample2]]);
      expect(results[0].isDuplicate).toBe(false);
      expect(results[1].isDuplicate).toBe(true);
    });

    it('handles JSON arrays as body (not treated as object)', () => {
      const sample1 = makeSample({
        method: 'POST',
        url: 'https://example.com/api/batch',
        body: JSON.stringify([1, 2, 3]),
        contentType: 'application/json',
      });
      const sample2 = makeSample({
        method: 'POST',
        url: 'https://example.com/api/batch',
        body: JSON.stringify([4, 5, 6]),
        contentType: 'application/json',
      });

      // Arrays are not objects, so body fingerprint is empty for both
      const results = deduplicate([[sample1, sample2]]);
      expect(results[1].isDuplicate).toBe(true);
    });
  });

  // ─── Multi-session Deduplication ───────────────────────────────

  describe('multi-session deduplication', () => {
    it('detects duplicates across sessions', () => {
      const session1 = [makeSample({ method: 'GET', url: 'https://example.com/api/users' })];
      const session2 = [makeSample({ method: 'GET', url: 'https://example.com/api/users' })];

      const results = deduplicate([session1, session2]);
      expect(results).toHaveLength(2);
      expect(results[0].isDuplicate).toBe(false);
      expect(results[1].isDuplicate).toBe(true);
    });

    it('preserves unique requests from different sessions', () => {
      const session1 = [makeSample({ method: 'GET', url: 'https://example.com/api/users' })];
      const session2 = [makeSample({ method: 'GET', url: 'https://example.com/api/posts' })];

      const results = deduplicate([session1, session2]);
      expect(results).toHaveLength(2);
      expect(results[0].isDuplicate).toBe(false);
      expect(results[1].isDuplicate).toBe(false);
    });
  });
});
