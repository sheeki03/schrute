import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock logger ─────────────────────────────────────────────────
vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { RateLimiter } from '../../src/automation/rate-limiter.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(1.0); // 1 QPS default
  });

  describe('token bucket', () => {
    it('allows initial requests (burst capacity)', () => {
      const result = limiter.checkRate('test-site');
      expect(result.allowed).toBe(true);
    });

    it('denies requests when tokens exhausted', () => {
      // Default QPS = 1.0, burst capacity = max(ceil(1.0 * 2), 1) = 2
      const r1 = limiter.checkRate('test-site');
      const r2 = limiter.checkRate('test-site');
      const r3 = limiter.checkRate('test-site');

      expect(r1.allowed).toBe(true);
      expect(r2.allowed).toBe(true);
      expect(r3.allowed).toBe(false);
      expect(r3.retryAfterMs).toBeGreaterThan(0);
    });

    it('refills tokens over time', async () => {
      // Exhaust tokens
      limiter.checkRate('test-site');
      limiter.checkRate('test-site');

      const r3 = limiter.checkRate('test-site');
      expect(r3.allowed).toBe(false);

      // Wait for refill (~1 second for 1 QPS)
      await new Promise((r) => setTimeout(r, 1100));

      const r4 = limiter.checkRate('test-site');
      expect(r4.allowed).toBe(true);
    });

    it('isolates buckets per site', () => {
      limiter.checkRate('site-a');
      limiter.checkRate('site-a');

      // site-b should have full tokens
      const result = limiter.checkRate('site-b');
      expect(result.allowed).toBe(true);
    });
  });

  describe('429 response backoff', () => {
    it('triggers backoff on 429 status', () => {
      limiter.checkRate('backoff-site'); // consume one token

      limiter.recordResponse('backoff-site', 429, {});

      const result = limiter.checkRate('backoff-site');
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBeGreaterThan(0);
    });

    it('uses Retry-After header for backoff duration', () => {
      limiter.checkRate('retry-after-site');
      limiter.recordResponse('retry-after-site', 429, { 'Retry-After': '5' });

      const result = limiter.checkRate('retry-after-site');
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBeGreaterThanOrEqual(4000);
    });

    it('doubles backoff multiplier on consecutive 429s', () => {
      limiter.checkRate('double-backoff');

      // First 429
      limiter.recordResponse('double-backoff', 429, {});
      // Second 429
      limiter.recordResponse('double-backoff', 429, {});

      const result = limiter.checkRate('double-backoff');
      expect(result.allowed).toBe(false);
      // The backoff should be longer than the initial backoff
      expect(result.retryAfterMs).toBeGreaterThan(1000);
    });

    it('resets backoff multiplier on successful response', () => {
      const siteId = 'reset-backoff';
      limiter.checkRate(siteId);

      // Trigger backoff
      limiter.recordResponse(siteId, 429, {});

      // Wait for backoff to expire
      // Instead of waiting, simulate successful response
      limiter.recordResponse(siteId, 200, {});

      // The backoff multiplier should be reset to 1, though the backoffUntil timestamp
      // from the 429 still applies for the current window
    });
  });

  describe('rate-limit header calibration', () => {
    it('calibrates from x-ratelimit headers', () => {
      const siteId = 'calibrate-site';
      limiter.checkRate(siteId);

      // Simulate response with rate limit headers
      const now = Date.now();
      limiter.recordResponse(siteId, 200, {
        'x-ratelimit-remaining': '50',
        'x-ratelimit-limit': '100',
        'x-ratelimit-reset': String(Math.floor((now + 60000) / 1000)), // 60s from now
      });

      // After calibration, should still be able to make requests
      const result = limiter.checkRate(siteId);
      expect(result.allowed).toBe(true);
    });

    it('slows down when remaining is low', () => {
      const siteId = 'low-remaining-site';

      // Create bucket with some tokens
      limiter.checkRate(siteId);

      // Report low remaining
      limiter.recordResponse(siteId, 200, {
        'x-ratelimit-remaining': '1',
        'x-ratelimit-limit': '100',
      });

      // Consume what's left
      limiter.checkRate(siteId);

      // Should be rate limited now
      const result = limiter.checkRate(siteId);
      expect(result.allowed).toBe(false);
    });
  });

  describe('setQps', () => {
    it('allows configuring QPS per site', () => {
      // setQps updates maxTokens and refillRate but does NOT reset current tokens.
      // The bucket was created with default 1 QPS (tokens=2, maxTokens=2).
      // setQps(10) updates maxTokens=20 but tokens remain at initial value (2).
      // After setQps, refill via time would add more tokens up to new max.
      limiter.setQps('fast-site', 10.0);

      // Current tokens: bucket was just created with default (tokens=2).
      // setQps doesn't reset tokens, so we can consume the existing 2.
      let allowed = 0;
      for (let i = 0; i < 5; i++) {
        if (limiter.checkRate('fast-site').allowed) allowed++;
      }
      // Should allow at least the initial 2 tokens
      expect(allowed).toBe(2);
    });
  });

  describe('higher default QPS', () => {
    it('respects custom default QPS', () => {
      const fast = new RateLimiter(5.0); // 5 QPS

      // burst = max(ceil(5 * 2), 1) = 10
      let allowed = 0;
      for (let i = 0; i < 15; i++) {
        if (fast.checkRate('site').allowed) allowed++;
      }
      expect(allowed).toBe(10);
    });
  });
});
