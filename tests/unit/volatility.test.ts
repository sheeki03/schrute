import { describe, it, expect } from 'vitest';
import {
  scoreVolatility,
  overallVolatilityScore,
  type RequestSample,
} from '../../src/replay/volatility.js';

function makeStaticSamples(count: number): RequestSample[] {
  return Array.from({ length: count }, () => ({
    headers: { 'content-type': 'application/json', 'accept': 'application/json' },
    queryParams: { page: '1', limit: '10' },
    bodyFields: { action: 'search', category: 'books' },
  }));
}

function makeNonceSamples(count: number): RequestSample[] {
  return Array.from({ length: count }, (_, i) => ({
    headers: { 'content-type': 'application/json' },
    queryParams: {},
    bodyFields: {
      action: 'search',
      nonce: `${crypto.randomUUID()}-${i}-${Math.random().toString(36)}`,
    },
  }));
}

function makeTokenSamples(count: number): RequestSample[] {
  // Token changes periodically (every other sample)
  return Array.from({ length: count }, (_, i) => ({
    headers: {
      'authorization': i < count / 2 ? 'Bearer token-abc123' : 'Bearer token-xyz789',
    },
    queryParams: {},
    bodyFields: { action: 'fetch' },
  }));
}

describe('volatility', () => {
  describe('scoreVolatility', () => {
    it('detects static fields (same value across samples)', () => {
      const samples = makeStaticSamples(5);
      const results = scoreVolatility(samples);
      const contentType = results.find((r) => r.fieldPath === 'content-type');
      expect(contentType).toBeDefined();
      expect(contentType!.isStatic).toBe(true);
      expect(contentType!.changeRate).toBe(0);
    });

    it('detects nonce fields (high entropy, changes every time)', () => {
      const samples = makeNonceSamples(10);
      const results = scoreVolatility(samples);
      const nonce = results.find((r) => r.fieldPath === 'nonce');
      expect(nonce).toBeDefined();
      expect(nonce!.changeRate).toBeGreaterThan(0.8);
      expect(nonce!.looksLikeNonce).toBe(true);
    });

    it('detects token fields (periodic changes)', () => {
      const samples = makeTokenSamples(10);
      const results = scoreVolatility(samples);
      const auth = results.find((r) => r.fieldPath === 'authorization');
      expect(auth).toBeDefined();
      // Changes once at the midpoint
      expect(auth!.changeRate).toBeGreaterThan(0);
      expect(auth!.changeRate).toBeLessThan(0.9);
    });

    it('returns empty for empty samples', () => {
      expect(scoreVolatility([])).toEqual([]);
    });
  });

  describe('overallVolatilityScore', () => {
    it('< 0.2 for mostly-static samples', () => {
      const samples = makeStaticSamples(5);
      const volatilities = scoreVolatility(samples);
      const score = overallVolatilityScore(volatilities);
      expect(score).toBeLessThan(0.2);
    });

    it('> 0.2 for samples with nonces', () => {
      const samples = makeNonceSamples(10);
      const volatilities = scoreVolatility(samples);
      const score = overallVolatilityScore(volatilities);
      // At least nonce field has high changeRate, pulling overall up
      expect(score).toBeGreaterThan(0.2);
    });

    it('returns 0 for empty volatilities', () => {
      expect(overallVolatilityScore([])).toBe(0);
    });
  });
});
