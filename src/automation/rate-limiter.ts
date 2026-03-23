import { getLogger } from '../core/logger.js';
import { BoundedMap } from '../shared/bounded-map.js';
import type { AgentDatabase } from '../storage/database.js';

const log = getLogger();

// ─── Constants ────────────────────────────────────────────────────

const MAX_BACKOFF_MULTIPLIER = 60;
const LOW_REMAINING_THRESHOLD = 2;
const INITIAL_BACKOFF_MULTIPLIER = 1;
const BURST_CAPACITY_MULTIPLIER = 2;
const DEFAULT_CALLER_FRACTION = 0.25;

// ─── Types ────────────────────────────────────────────────────────

interface RateCheckResult {
  allowed: boolean;
  retryAfterMs?: number;
}

interface RateCheckOptions {
  minGapMs?: number;
}

interface WaitForPermitOptions extends RateCheckOptions {
  timeoutMs?: number;
}

interface SiteBucket {
  tokens: number;
  maxTokens: number;
  refillRate: number; // tokens per second
  lastRefill: number;
  lastGrantedAt: number;
  backoffUntil: number;
  backoffMultiplier: number;
  latencyEwa: number;
  latencyThresholdMs: number;
}

// ─── Rate Limiter ──────────────────────────────────────────────

export class RateLimiter {
  // Global per-site buckets (protects upstream API).
  // No TTL — buckets are mutated in place via get(), and TTL is based on insertedAt
  // which is never refreshed. LRU eviction via maxSize is sufficient.
  private siteBuckets = new BoundedMap<string, SiteBucket>({ maxSize: 5000 });
  // Per-caller sub-buckets (ensures fairness, keyed by siteId::callerId)
  private callerBuckets = new BoundedMap<string, SiteBucket>({ maxSize: 10000 });
  private defaultQps: number;
  private callerFraction: number;
  private db?: AgentDatabase;

  constructor(defaultQps = 1.0, callerFraction = DEFAULT_CALLER_FRACTION) {
    this.defaultQps = defaultQps;
    this.callerFraction = callerFraction;
  }

  /** Attach a database for backoff persistence across restarts. */
  attachDatabase(db: AgentDatabase): void {
    this.db = db;
    this.loadBackoffs();
  }

  /** Persist active backoff windows to DB. */
  persistBackoffs(): void {
    if (!this.db) return;
    const now = Date.now();
    for (const [siteId, bucket] of this.siteBuckets.entries()) {
      if (bucket.backoffUntil > now) {
        this.db.run(
          'INSERT OR REPLACE INTO rate_limit_backoffs (site_id, backoff_until, multiplier) VALUES (?, ?, ?)',
          siteId, bucket.backoffUntil, bucket.backoffMultiplier,
        );
      } else {
        // Clean up expired backoffs
        this.db.run('DELETE FROM rate_limit_backoffs WHERE site_id = ?', siteId);
      }
    }
  }

  /** Load persisted backoffs on startup. */
  private loadBackoffs(): void {
    if (!this.db) return;
    try {
      const rows = this.db.all<{ site_id: string; backoff_until: number; multiplier: number }>(
        'SELECT site_id, backoff_until, multiplier FROM rate_limit_backoffs WHERE backoff_until > ?',
        Date.now(),
      );
      for (const row of rows) {
        const bucket = this.getOrCreateSiteBucket(row.site_id);
        bucket.backoffUntil = row.backoff_until;
        bucket.backoffMultiplier = row.multiplier;
      }
      log.info({ count: rows.length }, 'Loaded persisted rate limit backoffs');
    } catch (err) {
      log.warn({ err }, 'Failed to load rate limit backoffs (table may not exist yet)');
    }
  }

  /**
   * Two-tier rate check:
   * 1. Global site bucket — protects upstream API (shared across all callers)
   * 2. Per-caller sub-bucket — ensures fairness (one caller can't exhaust the budget)
   */
  checkRate(siteId: string, callerId?: string, options?: RateCheckOptions): RateCheckResult {
    return this.tryAcquirePermit(siteId, callerId, options);
  }

  async waitForPermit(
    siteId: string,
    callerId?: string,
    options?: WaitForPermitOptions,
  ): Promise<RateCheckResult> {
    const timeoutMs = Math.max(options?.timeoutMs ?? 30_000, 0);
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const result = this.tryAcquirePermit(siteId, callerId, options);
      if (result.allowed) {
        return result;
      }

      const retryAfterMs = Math.max(Math.ceil(result.retryAfterMs ?? 0), 1);
      if (Date.now() + retryAfterMs > deadline) {
        return result;
      }

      await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
    }
  }

  /**
   * Two-tier rate check:
   * 1. Global site bucket — protects upstream API (shared across all callers)
   * 2. Per-caller sub-bucket — ensures fairness (one caller can't exhaust the budget)
   */
  private tryAcquirePermit(
    siteId: string,
    callerId?: string,
    options?: RateCheckOptions,
  ): RateCheckResult {
    const minGapMs = Math.max(Math.floor(options?.minGapMs ?? 0), 0);

    // 1. Check global site bucket first — protects upstream
    const siteBucket = this.getOrCreateSiteBucket(siteId);
    this.refillTokens(siteBucket);

    const now = Date.now();
    let retryAfterMs = this.getBucketRetryAfterMs(siteBucket, now);
    retryAfterMs = Math.max(retryAfterMs, this.getMinGapRetryAfterMs(siteBucket, now, minGapMs));

    // 2. If callerId provided, also check per-caller sub-bucket
    let callerBucket: SiteBucket | undefined;
    if (callerId) {
      const callerKey = `${siteId}::${callerId}`;
      callerBucket = this.getOrCreateCallerBucket(callerKey, siteBucket);
      this.refillTokens(callerBucket);
      retryAfterMs = Math.max(retryAfterMs, this.getBucketRetryAfterMs(callerBucket, now));
    }

    if (retryAfterMs > 0) {
      log.debug(
        { siteId, callerId, retryAfterMs, minGapMs },
        'Rate limited: permit unavailable',
      );
      return { allowed: false, retryAfterMs };
    }

    if (callerBucket) {
      callerBucket.tokens -= 1;
      callerBucket.lastGrantedAt = now;
    }

    // 3. Consume from global bucket
    siteBucket.tokens -= 1;
    siteBucket.lastGrantedAt = now;
    return { allowed: true };
  }

  recordResponse(
    siteId: string,
    status: number,
    headers: Record<string, string>,
    latencyMs?: number,
    callerId?: string,
  ): void {
    const bucket = this.getOrCreateSiteBucket(siteId);
    const now = Date.now();
    const prevMaxTokens = bucket.maxTokens;
    const prevRefillRate = bucket.refillRate;

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

      // Propagate backoff to caller sub-bucket
      if (callerId) {
        const callerKey = `${siteId}::${callerId}`;
        const callerBucket = this.getOrCreateCallerBucket(callerKey, bucket);
        callerBucket.backoffUntil = bucket.backoffUntil;
        callerBucket.tokens = 0;
      }
      return;
    }

    // Successful response — reset backoff multiplier
    if (status >= 200 && status < 300) {
      bucket.backoffMultiplier = INITIAL_BACKOFF_MULTIPLIER;
    }

    // Rate limit header parsing: supports X-RateLimit-Remaining, X-RateLimit-Reset,
    // Retry-After. Reset values > 1_000_000_000 are treated as Unix timestamps in
    // seconds (epoch exceeded 1 billion in Sep 2001), smaller values as relative
    // seconds-from-now.
    const remaining = this.parseHeader(headers, 'x-ratelimit-remaining');
    const limit = this.parseHeader(headers, 'x-ratelimit-limit');
    const reset = this.parseHeader(headers, 'x-ratelimit-reset');

    if (remaining !== null && limit !== null) {
      // Calibrate refill rate based on server limits
      if (reset !== null) {
        const resetMs = reset > 1_000_000_000 ? (reset * 1000) - now : reset * 1000;
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

    // Latency-based AIMD: adjust refill rate based on exponentially weighted average latency
    if (latencyMs != null && status >= 200 && status < 300) {
      bucket.latencyEwa = bucket.latencyEwa === 0
        ? latencyMs
        : 0.2 * latencyMs + 0.8 * bucket.latencyEwa;
      if (bucket.latencyEwa > bucket.latencyThresholdMs) {
        bucket.refillRate = Math.max(bucket.refillRate * 0.8, 0.1);
      } else if (bucket.latencyEwa < bucket.latencyThresholdMs * 0.5) {
        bucket.refillRate = Math.min(bucket.refillRate + 0.1, bucket.maxTokens);
      }
    }

    // Re-calibrate ALL caller buckets for this site only when limits actually changed.
    if (bucket.maxTokens !== prevMaxTokens || bucket.refillRate !== prevRefillRate) {
      this.recalibrateCallerBuckets(siteId, bucket);
    }
  }

  /**
   * Re-calibrate all per-caller sub-buckets for a site when site limits change.
   * Prevents fairness drift where some callers keep stale larger sub-buckets.
   */
  private recalibrateCallerBuckets(siteId: string, siteBucket: SiteBucket): void {
    const prefix = `${siteId}::`;
    for (const key of this.callerBuckets.keys()) {
      if (key.startsWith(prefix)) {
        const callerBucket = this.callerBuckets.get(key);
        if (callerBucket) {
          callerBucket.maxTokens = Math.max(1, Math.floor(siteBucket.maxTokens * this.callerFraction));
          callerBucket.refillRate = Math.max(0.1, siteBucket.refillRate * this.callerFraction);
        }
      }
    }
  }

  setQps(siteId: string, qps: number): void {
    const bucket = this.getOrCreateSiteBucket(siteId);
    bucket.refillRate = qps;
    bucket.maxTokens = Math.max(Math.ceil(qps * BURST_CAPACITY_MULTIPLIER), 1);
  }

  // ─── Internal ───────────────────────────────────────────────────

  private getOrCreateSiteBucket(siteId: string): SiteBucket {
    let bucket = this.siteBuckets.get(siteId);
    if (!bucket) {
      bucket = {
        tokens: Math.max(Math.ceil(this.defaultQps * BURST_CAPACITY_MULTIPLIER), 1),
        maxTokens: Math.max(Math.ceil(this.defaultQps * BURST_CAPACITY_MULTIPLIER), 1),
        refillRate: this.defaultQps,
        lastRefill: Date.now(),
        lastGrantedAt: 0,
        backoffUntil: 0,
        backoffMultiplier: INITIAL_BACKOFF_MULTIPLIER,
        latencyEwa: 0,
        latencyThresholdMs: 2000,
      };
      this.siteBuckets.set(siteId, bucket);
    }
    return bucket;
  }

  private getOrCreateCallerBucket(callerKey: string, siteBucket: SiteBucket): SiteBucket {
    let bucket = this.callerBuckets.get(callerKey);
    if (!bucket) {
      const maxTokens = Math.max(1, Math.floor(siteBucket.maxTokens * this.callerFraction));
      bucket = {
        tokens: maxTokens,
        maxTokens,
        refillRate: Math.max(0.1, siteBucket.refillRate * this.callerFraction),
        lastRefill: Date.now(),
        lastGrantedAt: 0,
        backoffUntil: 0,
        backoffMultiplier: INITIAL_BACKOFF_MULTIPLIER,
        latencyEwa: 0,
        latencyThresholdMs: 2000,
      };
      this.callerBuckets.set(callerKey, bucket);
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

  private getBucketRetryAfterMs(bucket: SiteBucket, now: number): number {
    let retryAfterMs = 0;

    if (now < bucket.backoffUntil) {
      retryAfterMs = Math.max(retryAfterMs, bucket.backoffUntil - now);
    }

    if (bucket.tokens < 1) {
      retryAfterMs = Math.max(
        retryAfterMs,
        Math.ceil((1 - bucket.tokens) / bucket.refillRate * 1000),
      );
    }

    return retryAfterMs;
  }

  private getMinGapRetryAfterMs(bucket: SiteBucket, now: number, minGapMs: number): number {
    if (minGapMs <= 0 || bucket.lastGrantedAt === 0) {
      return 0;
    }

    const nextAllowedAt = bucket.lastGrantedAt + minGapMs;
    return nextAllowedAt > now ? nextAllowedAt - now : 0;
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
