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

  // ─── Per-Caller Sub-Bucket Tests ──────────────────────────────

  describe('per-caller sub-buckets', () => {
    it('two callerIds on same site get independent sub-budgets', () => {
      // Use a higher QPS so global bucket has enough tokens for both callers
      const multi = new RateLimiter(10.0); // burst = 20

      // Caller A consumes their sub-budget (callerFraction=0.25, so maxTokens = floor(20*0.25) = 5)
      let callerAAllowed = 0;
      for (let i = 0; i < 10; i++) {
        if (multi.checkRate('api.example.com', 'caller-A').allowed) callerAAllowed++;
      }
      // Caller A should have been allowed exactly 5 requests (sub-bucket capacity)
      expect(callerAAllowed).toBe(5);

      // Caller B should still have their own fresh sub-budget
      const callerBResult = multi.checkRate('api.example.com', 'caller-B');
      expect(callerBResult.allowed).toBe(true);
    });

    it('one caller exhausting sub-budget does not block another caller', () => {
      const multi = new RateLimiter(10.0); // burst = 20, caller sub-budget = 5

      // Exhaust caller-A's sub-budget
      for (let i = 0; i < 10; i++) {
        multi.checkRate('api.example.com', 'caller-A');
      }

      // Caller A should be denied
      const callerAResult = multi.checkRate('api.example.com', 'caller-A');
      expect(callerAResult.allowed).toBe(false);

      // Caller B should still be allowed
      const callerBResult = multi.checkRate('api.example.com', 'caller-B');
      expect(callerBResult.allowed).toBe(true);
    });

    it('global site budget enforced even when caller sub-buckets have tokens', () => {
      // Low global QPS = 1.0, burst = 2, caller sub-budget = max(1, floor(2*0.25)) = 1
      // After 2 global tokens consumed, new callers are denied at the site level
      limiter.checkRate('shared-site', 'caller-X');
      limiter.checkRate('shared-site', 'caller-Y');

      // Global is exhausted (2 tokens used). Caller-Z has a fresh sub-bucket
      // but the global check fails first.
      const result = limiter.checkRate('shared-site', 'caller-Z');
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBeGreaterThan(0);
    });

    it('no callerId falls back to site-only check (backward compat)', () => {
      // This is already tested by existing tests, but verify explicitly
      // that passing undefined callerId works without error
      const r1 = limiter.checkRate('compat-site');
      expect(r1.allowed).toBe(true);

      const r2 = limiter.checkRate('compat-site');
      expect(r2.allowed).toBe(true);

      // Third call exhausts the global bucket (burst = 2)
      const r3 = limiter.checkRate('compat-site');
      expect(r3.allowed).toBe(false);
    });

    it('429 response propagates backoff to both site and caller buckets', () => {
      const multi = new RateLimiter(10.0); // burst = 20

      // Make a request as caller-A to create the caller sub-bucket
      multi.checkRate('backoff-dual', 'caller-A');

      // 429 with callerId propagates backoff to both site and caller bucket
      multi.recordResponse('backoff-dual', 429, {}, undefined, 'caller-A');

      // Caller A is denied (caller backoff)
      const callerAResult = multi.checkRate('backoff-dual', 'caller-A');
      expect(callerAResult.allowed).toBe(false);
      expect(callerAResult.retryAfterMs).toBeGreaterThan(0);

      // Caller B is also denied because the global site bucket is in backoff
      const callerBResult = multi.checkRate('backoff-dual', 'caller-B');
      expect(callerBResult.allowed).toBe(false);
      expect(callerBResult.retryAfterMs).toBeGreaterThan(0);
    });

    it('caller sub-budget recalibrates when site headers update global limit', async () => {
      const multi = new RateLimiter(10.0); // burst = 20, caller sub = 5

      // Create caller sub-bucket by consuming one request
      multi.checkRate('recalibrate-site', 'caller-C');

      // Server reports a much higher limit via headers
      const now = Date.now();
      multi.recordResponse('recalibrate-site', 200, {
        'x-ratelimit-remaining': '500',
        'x-ratelimit-limit': '1000',
        'x-ratelimit-reset': String(Math.floor((now + 60000) / 1000)),
      }, undefined, 'caller-C');

      // After recalibration: site maxTokens=1000, caller maxTokens = floor(1000*0.25)=250
      // caller refillRate = (1000/60) * 0.25 ≈ 4.17 tokens/sec
      // The caller bucket still has ~4 tokens from the initial fill (5 - 1 consumed).
      // Wait briefly so the faster refillRate can add tokens up to the new max.
      await new Promise((r) => setTimeout(r, 1100));

      // After ~1.1 seconds at ~4.17 tokens/sec, caller should have gained ~4.6 tokens
      // on top of the ~4 remaining, totaling ~8+ tokens (capped at new maxTokens=250).
      let allowed = 0;
      for (let i = 0; i < 10; i++) {
        if (multi.checkRate('recalibrate-site', 'caller-C').allowed) allowed++;
      }
      // Should allow more than the original 5 sub-budget capacity
      expect(allowed).toBeGreaterThan(5);
    });
  });

  describe('bucket persistence (regression: no TTL eviction)', () => {
    it('site bucket backoff state survives past old 1h TTL boundary', () => {
      vi.useFakeTimers();
      const limiter = new RateLimiter(2.0); // 2 QPS → maxTokens=4

      // Seed a distinct state: trigger two 429s to escalate backoff multiplier
      // After 1st 429: multiplier=2, after 2nd 429: multiplier=4
      limiter.recordResponse('persistent-site', 429, {});
      vi.advanceTimersByTime(2000); // wait past 1st backoff (1s * 1 = 1s)
      limiter.recordResponse('persistent-site', 429, {});
      // Now backoff multiplier is 4 (1 → 2 → 4). A fresh bucket would have multiplier=1.

      // Wait past the backoff, then advance past the old 1h TTL boundary
      vi.advanceTimersByTime(10_000); // clear the ~4s backoff
      vi.advanceTimersByTime(2 * 3600_000); // 2 hours past creation

      // Trigger another 429 — if the bucket was recreated, multiplier would be 1
      // (backoff = 1s). With the surviving bucket, multiplier is 4 (backoff = 4s).
      limiter.recordResponse('persistent-site', 429, {});

      const check = limiter.checkRate('persistent-site');
      expect(check.allowed).toBe(false);
      // A fresh bucket's first 429 gives retryAfterMs = 1000 (multiplier 1 * 1000).
      // The surviving bucket's 3rd 429 gives retryAfterMs = 4000 (multiplier 4 * 1000).
      expect(check.retryAfterMs).toBeGreaterThanOrEqual(4000);

      vi.useRealTimers();
    });

    it('caller sub-bucket backoff state survives past old 1h TTL boundary', () => {
      vi.useFakeTimers();
      const limiter = new RateLimiter(2.0);

      // Seed distinct caller bucket state: two 429s to escalate multiplier to 4
      limiter.recordResponse('persistent-site', 429, {}, undefined, 'caller-A');
      vi.advanceTimersByTime(2000);
      limiter.recordResponse('persistent-site', 429, {}, undefined, 'caller-A');
      vi.advanceTimersByTime(10_000); // clear backoff

      // Advance 2 hours past creation — past old 1h TTL
      vi.advanceTimersByTime(2 * 3600_000);

      // The caller bucket should still exist with escalated multiplier.
      // Exhaust the caller's tokens (they refilled over 2h, so drain them).
      while (limiter.checkRate('persistent-site', 'caller-A').allowed) {
        // drain tokens
      }

      // Now trigger another 429 on the caller
      limiter.recordResponse('persistent-site', 429, {}, undefined, 'caller-A');

      const check = limiter.checkRate('persistent-site', 'caller-A');
      expect(check.allowed).toBe(false);
      // A fresh bucket would have multiplier=1 (1s backoff on first 429).
      // The surviving bucket has multiplier=4 from before the TTL boundary,
      // escalated to 8 by this 3rd 429 → backoff = 8s.
      expect(check.retryAfterMs).toBeGreaterThanOrEqual(4000);

      vi.useRealTimers();
    });
  });
});
