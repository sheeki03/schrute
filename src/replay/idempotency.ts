import { randomUUID } from 'node:crypto';
import type { SealedFetchRequest, SkillSpec } from '../skill/types.js';
import { SideEffectClass } from '../skill/types.js';

// ─── Constants ──────────────────────────────────────────────────

const IDEMPOTENCY_HEADERS = [
  'idempotency-key',
  'x-idempotency-key',
  'x-request-id',
] as const;

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── Idempotency Tracker ─────────────────────────────────────────

interface TrackedKey {
  key: string;
  skillId: string;
  createdAt: number;
}

/**
 * Tracks recently-used idempotency keys to prevent duplicates.
 */
export class IdempotencyTracker {
  private keys = new Map<string, TrackedKey>();
  private ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /**
   * Check if a key was already used.
   */
  check(key: string): boolean {
    this.gc();
    return this.keys.has(key);
  }

  /**
   * Record a newly-generated key.
   */
  record(key: string, skillId: string): void {
    this.keys.set(key, { key, skillId, createdAt: Date.now() });
  }

  /**
   * Clear all tracked keys.
   */
  clear(): void {
    this.keys.clear();
  }

  /**
   * Get the number of tracked keys.
   */
  get size(): number {
    this.gc();
    return this.keys.size;
  }

  /**
   * Garbage-collect expired keys.
   */
  private gc(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, entry] of this.keys) {
      if (entry.createdAt < cutoff) {
        this.keys.delete(key);
      }
    }
  }
}

// ─── Default Tracker (module-level singleton) ───────────────────

const defaultTracker = new IdempotencyTracker();

// ─── Idempotency Key Injection ──────────────────────────────────

/**
 * Inject an idempotency key into a SealedFetchRequest for write operations.
 *
 * Only applies to NON_IDEMPOTENT side-effect class skills.
 * Detects existing idempotency headers and preserves them.
 * Generates a UUID-based key if none is present.
 *
 * @param req - The sealed fetch request to augment
 * @param skill - The skill spec (used for side-effect classification)
 * @param tracker - Optional tracker instance (defaults to module singleton)
 * @returns A new SealedFetchRequest with idempotency header injected
 */
export function injectIdempotencyKey(
  req: SealedFetchRequest,
  skill: SkillSpec,
  tracker: IdempotencyTracker = defaultTracker,
): SealedFetchRequest {
  // Only inject for non-idempotent operations
  if (skill.sideEffectClass !== SideEffectClass.NON_IDEMPOTENT) {
    return req;
  }

  // Check if the request already has an idempotency header
  const lowerHeaders = new Map(
    Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), { original: k, value: v }]),
  );

  for (const headerName of IDEMPOTENCY_HEADERS) {
    const existing = lowerHeaders.get(headerName);
    if (existing && existing.value) {
      // Already has an idempotency key — don't overwrite
      return req;
    }
  }

  // Detect which header pattern the API expects based on skill metadata
  const headerName = detectIdempotencyHeader(skill) ?? 'Idempotency-Key';

  // Generate a unique key
  let key: string;
  let attempts = 0;
  do {
    key = randomUUID();
    attempts++;
  } while (tracker.check(key) && attempts < 10);

  // Record the key
  tracker.record(key, skill.id);

  // Return a new request with the header injected
  return {
    ...req,
    headers: {
      ...req.headers,
      [headerName]: key,
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Detect which idempotency header an API expects from required/dynamic headers.
 */
function detectIdempotencyHeader(skill: SkillSpec): string | null {
  const allHeaders = {
    ...skill.requiredHeaders,
    ...skill.dynamicHeaders,
  };

  for (const [key] of Object.entries(allHeaders)) {
    const lower = key.toLowerCase();
    if (IDEMPOTENCY_HEADERS.includes(lower as typeof IDEMPOTENCY_HEADERS[number])) {
      return key; // Preserve original casing
    }
  }

  return null;
}
