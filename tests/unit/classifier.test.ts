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

import { classifySite } from '../../src/automation/classifier.js';
import type { NetworkEntry } from '../../src/skill/types.js';
import { ExecutionTier } from '../../src/skill/types.js';

function makeEntry(overrides?: Partial<NetworkEntry>): NetworkEntry {
  return {
    url: 'https://api.example.com/data',
    method: 'GET',
    status: 200,
    requestHeaders: {},
    responseHeaders: {},
    timing: { startTime: 0, endTime: 100, duration: 100 },
    ...overrides,
  };
}

describe('classifier', () => {
  describe('auth detection', () => {
    it('detects Authorization header', () => {
      const traffic = [
        makeEntry({ requestHeaders: { Authorization: 'Bearer abc' } }),
      ];
      const result = classifySite('test.com', traffic);
      expect(result.authRequired).toBe(true);
    });

    it('detects Cookie header', () => {
      const traffic = [
        makeEntry({ requestHeaders: { Cookie: 'session=xyz' } }),
      ];
      const result = classifySite('test.com', traffic);
      expect(result.authRequired).toBe(true);
    });

    it('detects x-csrf-token header', () => {
      const traffic = [
        makeEntry({ requestHeaders: { 'x-csrf-token': 'abc123' } }),
      ];
      const result = classifySite('test.com', traffic);
      expect(result.authRequired).toBe(true);
    });

    it('detects x-xsrf-token header', () => {
      const traffic = [
        makeEntry({ requestHeaders: { 'X-XSRF-Token': 'def456' } }),
      ];
      const result = classifySite('test.com', traffic);
      expect(result.authRequired).toBe(true);
    });

    it('returns false for no auth headers', () => {
      const traffic = [
        makeEntry({ requestHeaders: { 'Content-Type': 'application/json' } }),
      ];
      const result = classifySite('test.com', traffic);
      expect(result.authRequired).toBe(false);
    });
  });

  describe('GraphQL detection', () => {
    it('detects GraphQL via URL path', () => {
      const traffic = [
        makeEntry({ url: 'https://api.example.com/graphql' }),
      ];
      const result = classifySite('test.com', traffic);
      expect(result.graphqlDetected).toBe(true);
    });

    it('detects GraphQL via request body query field', () => {
      const traffic = [
        makeEntry({
          url: 'https://api.example.com/api',
          requestBody: JSON.stringify({ query: '{ users { id name } }' }),
        }),
      ];
      const result = classifySite('test.com', traffic);
      expect(result.graphqlDetected).toBe(true);
    });

    it('returns false when no GraphQL indicators', () => {
      const traffic = [
        makeEntry({ url: 'https://api.example.com/rest/users' }),
      ];
      const result = classifySite('test.com', traffic);
      expect(result.graphqlDetected).toBe(false);
    });
  });

  describe('tier recommendation', () => {
    it('recommends DIRECT for simple API without auth or GraphQL', () => {
      const traffic = [makeEntry()];
      const result = classifySite('test.com', traffic);
      expect(result.recommendedTier).toBe(ExecutionTier.DIRECT);
    });

    it('recommends DIRECT for GraphQL without auth', () => {
      const traffic = [makeEntry({ url: 'https://api.example.com/graphql' })];
      const result = classifySite('test.com', traffic);
      expect(result.recommendedTier).toBe(ExecutionTier.DIRECT);
    });

    it('recommends BROWSER_PROXIED for auth-required traffic', () => {
      const traffic = [
        makeEntry({ requestHeaders: { Authorization: 'Bearer abc' } }),
      ];
      const result = classifySite('test.com', traffic);
      expect(result.recommendedTier).toBe(ExecutionTier.BROWSER_PROXIED);
    });

    it('recommends FULL_BROWSER for JS-computed fields (signatures)', () => {
      const traffic = [
        makeEntry({ requestHeaders: { 'X-Signature': 'hmac-sha256:abc123' } }),
      ];
      const result = classifySite('test.com', traffic);
      expect(result.recommendedTier).toBe(ExecutionTier.FULL_BROWSER);
    });

    it('recommends BROWSER_PROXIED for dynamic fields + auth', () => {
      const traffic = [
        makeEntry({
          url: 'https://api.example.com/api?_ts=12345',
          requestHeaders: { Authorization: 'Bearer abc' },
        }),
      ];
      const result = classifySite('test.com', traffic);
      expect(result.recommendedTier).toBe(ExecutionTier.BROWSER_PROXIED);
    });
  });

  describe('dynamic fields detection', () => {
    it('detects nonce patterns in URL', () => {
      const traffic = [makeEntry({ url: 'https://api.example.com/api?nonce=abc' })];
      const result = classifySite('test.com', traffic);
      expect(result.dynamicFieldsDetected).toBe(true);
    });

    it('detects token patterns in request body', () => {
      const traffic = [makeEntry({ requestBody: 'csrf_token=abc123' })];
      const result = classifySite('test.com', traffic);
      expect(result.dynamicFieldsDetected).toBe(true);
    });

    it('detects timestamp patterns in headers', () => {
      const traffic = [makeEntry({ requestHeaders: { 'x-timestamp': '1234567890' } })];
      const result = classifySite('test.com', traffic);
      expect(result.dynamicFieldsDetected).toBe(true);
    });
  });
});
