import { describe, it, expect } from 'vitest';
import { scoreVolatilityNative } from '../../src/native/volatility.js';
import { scoreVolatility } from '../../src/replay/volatility.js';
import type { RequestSample } from '../../src/replay/volatility.js';

describe('native volatility (TS fallback)', () => {
  const samples: RequestSample[] = [
    {
      headers: { 'x-request-id': 'abc123', 'accept': 'application/json' },
      queryParams: { page: '1' },
      bodyFields: { userId: '100' },
    },
    {
      headers: { 'x-request-id': 'def456', 'accept': 'application/json' },
      queryParams: { page: '2' },
      bodyFields: { userId: '100' },
    },
    {
      headers: { 'x-request-id': 'ghi789', 'accept': 'application/json' },
      queryParams: { page: '3' },
      bodyFields: { userId: '100' },
    },
  ];

  it('returns volatility scores for all fields', () => {
    const results = scoreVolatilityNative(samples);
    expect(results.length).toBeGreaterThan(0);

    // Each result should have the expected fields
    for (const r of results) {
      expect(r.fieldPath).toBeDefined();
      expect(r.fieldLocation).toBeDefined();
      expect(typeof r.entropy).toBe('number');
      expect(typeof r.changeRate).toBe('number');
      expect(typeof r.looksLikeNonce).toBe('boolean');
      expect(typeof r.looksLikeToken).toBe('boolean');
      expect(typeof r.isStatic).toBe('boolean');
    }
  });

  it('identifies static fields', () => {
    const results = scoreVolatilityNative(samples);
    const acceptField = results.find(r => r.fieldPath === 'accept');
    const userIdField = results.find(r => r.fieldPath === 'userId');

    if (acceptField) {
      expect(acceptField.isStatic).toBe(true);
      expect(acceptField.changeRate).toBe(0);
    }
    if (userIdField) {
      expect(userIdField.isStatic).toBe(true);
    }
  });

  it('identifies changing fields', () => {
    const results = scoreVolatilityNative(samples);
    const requestIdField = results.find(r => r.fieldPath === 'x-request-id');
    const pageField = results.find(r => r.fieldPath === 'page');

    if (requestIdField) {
      expect(requestIdField.changeRate).toBeGreaterThan(0);
      expect(requestIdField.isStatic).toBe(false);
    }
    if (pageField) {
      expect(pageField.changeRate).toBeGreaterThan(0);
    }
  });

  it('returns empty for empty samples', () => {
    const results = scoreVolatilityNative([]);
    expect(results).toHaveLength(0);
  });

  it('matches TS scoreVolatility field count', () => {
    const nativeResults = scoreVolatilityNative(samples);
    const tsResults = scoreVolatility(samples);

    expect(nativeResults.length).toBe(tsResults.length);
  });
});
