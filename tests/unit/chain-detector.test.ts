import { describe, it, expect } from 'vitest';
import { detectChains, extractChainCandidates } from '../../src/capture/chain-detector.js';
import type { StructuredRecord } from '../../src/capture/har-extractor.js';

// ─── Helpers ──────────────────────────────────────────────────────

function makeRecord(
  overrides: {
    method?: string;
    url?: string;
    reqHeaders?: Record<string, string>;
    queryParams?: Record<string, string>;
    body?: string;
    respBody?: string;
    respHeaders?: Record<string, string>;
    respStatus?: number;
    startedAt?: number;
  } = {},
): StructuredRecord {
  return {
    request: {
      method: overrides.method ?? 'GET',
      url: overrides.url ?? 'https://api.example.com/data',
      headers: overrides.reqHeaders ?? {},
      body: overrides.body,
      queryParams: overrides.queryParams ?? {},
      contentType: overrides.body ? 'application/json' : undefined,
    },
    response: {
      status: overrides.respStatus ?? 200,
      statusText: 'OK',
      headers: overrides.respHeaders ?? {},
      body: overrides.respBody,
      contentType: 'application/json',
    },
    startedAt: overrides.startedAt ?? Date.now(),
    duration: 50,
  };
}

// ─── Tests ────────────────────────────────────────────────────────

describe('chain-detector', () => {
  describe('extractChainCandidates', () => {
    it('extracts scalar values from JSON for capture-time reuse', () => {
      const candidates = extractChainCandidates(JSON.stringify({
        token: 'TOKEN-XYZ-123456',
        nested: { id: 42 },
      }));

      expect(candidates).toEqual({
        'body.token': 'TOKEN-XYZ-123456',
        'body.nested.id': '42',
      });
    });

    it('returns undefined for invalid JSON', () => {
      expect(extractChainCandidates('{nope')).toBeUndefined();
    });
  });

  describe('detectChains', () => {
    it('returns empty array for fewer than 2 requests', () => {
      expect(detectChains([makeRecord()])).toEqual([]);
    });

    it('detects value propagation chain (response value used in subsequent request)', () => {
      const now = Date.now();
      const records = [
        makeRecord({
          url: 'https://api.example.com/auth/login',
          method: 'POST',
          respBody: JSON.stringify({ token: 'abc-secret-token-value' }),
          startedAt: now,
        }),
        makeRecord({
          url: 'https://api.example.com/data',
          reqHeaders: { authorization: 'Bearer abc-secret-token-value' },
          startedAt: now + 1000,
        }),
      ];

      const chains = detectChains(records);
      expect(chains.length).toBeGreaterThanOrEqual(1);

      const valueChain = chains.find(c => !c.canReplayWithCookiesOnly);
      expect(valueChain).toBeDefined();
      expect(valueChain!.steps.length).toBeGreaterThanOrEqual(2);
    });

    it('detects cookie-based chain (set-cookie propagated to subsequent request)', () => {
      const now = Date.now();
      const records = [
        makeRecord({
          url: 'https://api.example.com/login',
          method: 'POST',
          respHeaders: { 'set-cookie': 'session=xyz789; Path=/' },
          startedAt: now,
        }),
        makeRecord({
          url: 'https://api.example.com/dashboard',
          reqHeaders: { cookie: 'session=xyz789' },
          startedAt: now + 1000,
        }),
      ];

      const chains = detectChains(records);
      expect(chains.length).toBeGreaterThanOrEqual(1);

      const cookieChain = chains.find(c => c.canReplayWithCookiesOnly);
      expect(cookieChain).toBeDefined();
      expect(cookieChain!.steps.length).toBeGreaterThanOrEqual(2);
    });

    it('returns empty when no dependencies exist between requests', () => {
      const now = Date.now();
      const records = [
        makeRecord({
          url: 'https://api.example.com/page1',
          respBody: JSON.stringify({ data: 'x' }),
          startedAt: now,
        }),
        makeRecord({
          url: 'https://api.example.com/page2',
          respBody: JSON.stringify({ data: 'y' }),
          startedAt: now + 1000,
        }),
      ];

      const chains = detectChains(records);
      expect(chains).toEqual([]);
    });

    it('builds chain steps with extraction info', () => {
      const now = Date.now();
      const records = [
        makeRecord({
          url: 'https://api.example.com/step1',
          method: 'GET',
          respBody: JSON.stringify({ orderId: 'ORDER-12345-ABCDE' }),
          startedAt: now,
        }),
        makeRecord({
          url: 'https://api.example.com/step2',
          method: 'POST',
          body: JSON.stringify({ ref: 'ORDER-12345-ABCDE' }),
          startedAt: now + 1000,
        }),
      ];

      const chains = detectChains(records);
      expect(chains.length).toBeGreaterThanOrEqual(1);

      const chain = chains[0];
      // The second step should have extractsFrom entries
      const extractionStep = chain.steps.find(s => s.extractsFrom.length > 0);
      expect(extractionStep).toBeDefined();
      expect(extractionStep!.extractsFrom[0].responsePath).toContain('orderId');
      expect(extractionStep!.extractsFrom[0].injectsInto.location).toBe('body');
    });

    it('canReplayWithCookiesOnly is false for value propagation chains', () => {
      const now = Date.now();
      const records = [
        makeRecord({
          url: 'https://api.example.com/init',
          respBody: JSON.stringify({ csrfToken: 'CSRF-TOKEN-VALUE-HERE' }),
          startedAt: now,
        }),
        makeRecord({
          url: 'https://api.example.com/submit',
          reqHeaders: { 'x-csrf': 'CSRF-TOKEN-VALUE-HERE' },
          startedAt: now + 1000,
        }),
      ];

      const chains = detectChains(records);
      const valueChain = chains.find(c => !c.canReplayWithCookiesOnly);
      expect(valueChain).toBeDefined();
      expect(valueChain!.canReplayWithCookiesOnly).toBe(false);
    });

    it('canReplayWithCookiesOnly is true for cookie chains', () => {
      const now = Date.now();
      const records = [
        makeRecord({
          url: 'https://api.example.com/login',
          method: 'POST',
          respHeaders: { 'set-cookie': 'sid=abc123; Path=/' },
          startedAt: now,
        }),
        makeRecord({
          url: 'https://api.example.com/api/data',
          reqHeaders: { cookie: 'sid=abc123' },
          startedAt: now + 1000,
        }),
      ];

      const chains = detectChains(records);
      const cookieChain = chains.find(c => c.canReplayWithCookiesOnly);
      expect(cookieChain).toBeDefined();
      expect(cookieChain!.canReplayWithCookiesOnly).toBe(true);
    });

    it('uses chainCandidates fast path when response body is unavailable', () => {
      const now = Date.now();
      const records = [
        makeRecord({
          url: 'https://api.example.com/auth',
          method: 'POST',
          respBody: '{not-json',
          startedAt: now,
          // @ts-expect-error test-only: emulate pre-extracted chain candidates
          respHeaders: {},
        }),
        makeRecord({
          url: 'https://api.example.com/me',
          reqHeaders: { authorization: 'Bearer TOKEN-XYZ-123456' },
          startedAt: now + 1000,
        }),
      ];

      records[0].response.chainCandidates = {
        'body.token': 'TOKEN-XYZ-123456',
      };

      const chains = detectChains(records);
      const valueChain = chains.find(c => !c.canReplayWithCookiesOnly);
      expect(valueChain).toBeDefined();
      const extractionStep = valueChain!.steps.find(s => s.extractsFrom.length > 0);
      expect(extractionStep).toBeDefined();
      expect(extractionStep!.extractsFrom[0].responsePath).toBe('body.token');
      expect(extractionStep!.extractsFrom[0].injectsInto.location).toBe('header');
    });
  });
});
