import { getLogger } from '../core/logger.js';

const log = getLogger();

// ─── Constants ────────────────────────────────────────────────────

const MAX_BACKOFF_MULTIPLIER = 60;
const LOW_REMAINING_THRESHOLD = 2;
const INITIAL_BACKOFF_MULTIPLIER = 1;
const BURST_CAPACITY_MULTIPLIER = 2;

// ─── Types ────────────────────────────────────────────────────────

export interface RateCheckResult {
  allowed: boolean;
  retryAfterMs?: number;
}

interface SiteBucket {
  tokens: number;
  maxTokens: number;
  refillRate: number; // tokens per second
  lastRefill: number;
  backoffUntil: number;
  backoffMultiplier: number;
}

// ─── Rate Limiter ──────────────────────────────────────────────

export class RateLimiter {
  private buckets = new Map<string, SiteBucket>();
  private defaultQps: number;

  constructor(defaultQps = 1.0) {
    this.defaultQps = defaultQps;
  }

  checkRate(siteId: string): RateCheckResult {
    const bucket = this.getOrCreateBucket(siteId);
    this.refillTokens(bucket);

    const now = Date.now();

    // Check backoff
    if (now < bucket.backoffUntil) {
      const retryAfterMs = bucket.backoffUntil - now;
      log.debug(
        { siteId, retryAfterMs },
        'Rate limited: in backoff period',
      );
      return { allowed: false, retryAfterMs };
    }

    // Check token bucket
    if (bucket.tokens < 1) {
      const retryAfterMs = Math.ceil((1 - bucket.tokens) / bucket.refillRate * 1000);
      log.debug(
        { siteId, tokens: bucket.tokens, retryAfterMs },
        'Rate limited: insufficient tokens',
      );
      return { allowed: false, retryAfterMs };
    }

    // Consume token
    bucket.tokens -= 1;
    return { allowed: true };
  }

  recordResponse(
    siteId: string,
    status: number,
    headers: Record<string, string>,
  ): void {
    const bucket = this.getOrCreateBucket(siteId);
    const now = Date.now();

    if (status === 429) {
      // Exponential backoff on 429
      const retryAfter = this.parseRetryAfter(headers);
      const backoffMs = retryAfter ?? bucket.backoffMultiplier * 1000;

      bucket.backoffUntil = now + backoffMs;
      bucket.backoffMultiplier = Math.min(bucket.backoffMultiplier * 2, MAX_BACKOFF_MULTIPLIER);
      bucket.tokens = 0;

      log.info(
        { siteId, backoffMs, multiplier: bucket.backoffMultiplier },
        'Rate limited (429): backing off',
      );
      return;
    }

    // Successful response — reset backoff multiplier
    if (status >= 200 && status < 300) {
      bucket.backoffMultiplier = INITIAL_BACKOFF_MULTIPLIER;
    }

    // Rate limit header parsing: supports X-RateLimit-Remaining, X-RateLimit-Reset,
    // Retry-After. Reset values >1e10 are treated as Unix timestamps (seconds),
    // smaller values as seconds-from-now.
    const remaining = this.parseHeader(headers, 'x-ratelimit-remaining');
    const limit = this.parseHeader(headers, 'x-ratelimit-limit');
    const reset = this.parseHeader(headers, 'x-ratelimit-reset');

    if (remaining !== null && limit !== null) {
      // Calibrate refill rate based on server limits
      if (reset !== null) {
        const resetMs = reset > 1e10 ? reset - now : reset * 1000;
        if (resetMs > 0 && limit > 0) {
          bucket.refillRate = limit / (resetMs / 1000);
          bucket.maxTokens = limit;
        }
      }

      // If remaining is low, slow down proactively
      if (remaining <= LOW_REMAINING_THRESHOLD) {
        bucket.tokens = Math.min(bucket.tokens, remaining);
        log.debug(
          { siteId, remaining, limit },
          'Rate limit headers indicate low remaining quota',
        );
      }
    }
  }

  setQps(siteId: string, qps: number): void {
    const bucket = this.getOrCreateBucket(siteId);
    bucket.refillRate = qps;
    bucket.maxTokens = Math.max(Math.ceil(qps * BURST_CAPACITY_MULTIPLIER), 1);
  }

  // ─── Internal ───────────────────────────────────────────────────

  private getOrCreateBucket(siteId: string): SiteBucket {
    let bucket = this.buckets.get(siteId);
    if (!bucket) {
      bucket = {
        tokens: Math.max(Math.ceil(this.defaultQps * BURST_CAPACITY_MULTIPLIER), 1),
        maxTokens: Math.max(Math.ceil(this.defaultQps * BURST_CAPACITY_MULTIPLIER), 1),
        refillRate: this.defaultQps,
        lastRefill: Date.now(),
        backoffUntil: 0,
        backoffMultiplier: INITIAL_BACKOFF_MULTIPLIER,
      };
      this.buckets.set(siteId, bucket);
    }
    return bucket;
  }

  private refillTokens(bucket: SiteBucket): void {
    const now = Date.now();
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(
      bucket.maxTokens,
      bucket.tokens + elapsed * bucket.refillRate,
    );
    bucket.lastRefill = now;
  }

  private parseRetryAfter(headers: Record<string, string>): number | null {
    const value = this.getHeaderCaseInsensitive(headers, 'retry-after');
    if (!value) return null;

    const seconds = Number(value);
    if (!isNaN(seconds)) {
      return seconds * 1000;
    }

    // Try HTTP-date format
    const date = Date.parse(value);
    if (!isNaN(date)) {
      return Math.max(0, date - Date.now());
    }

    return null;
  }

  private parseHeader(headers: Record<string, string>, name: string): number | null {
    const value = this.getHeaderCaseInsensitive(headers, name);
    if (!value) return null;
    const num = Number(value);
    return isNaN(num) ? null : num;
  }

  private getHeaderCaseInsensitive(
    headers: Record<string, string>,
    name: string,
  ): string | undefined {
    const lower = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === lower) return value;
    }
    return undefined;
  }
}
