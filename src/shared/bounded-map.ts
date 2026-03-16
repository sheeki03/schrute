/**
 * A size-bounded Map with LRU eviction and optional TTL.
 *
 * O(n) eviction scan is acceptable for maps up to ~10 000 entries.
 */

// ── Types ────────────────────────────────────────────────────────

interface BoundedMapOptions<K, V> {
  /** Maximum number of entries before LRU eviction kicks in. */
  maxSize: number;
  /** Optional time-to-live in milliseconds. Entries older than this are lazily purged on access. */
  ttlMs?: number;
  /** Called whenever an entry is evicted (capacity pressure) or explicitly deleted. */
  onEvict?: (key: K, value: V) => void;
}

interface Entry<V> {
  value: V;
  insertedAt: number;
  lastAccessedAt: number;
}

// ── Implementation ───────────────────────────────────────────────

export class BoundedMap<K, V> {
  private readonly map = new Map<K, Entry<V>>();
  private readonly maxSize: number;
  private readonly ttlMs: number | undefined;
  private readonly onEvict: ((key: K, value: V) => void) | undefined;

  constructor(options: BoundedMapOptions<K, V>) {
    if (options.maxSize < 1) {
      throw new RangeError('maxSize must be at least 1');
    }
    this.maxSize = options.maxSize;
    this.ttlMs = options.ttlMs;
    this.onEvict = options.onEvict;
  }

  // ── Core accessors ──────────────────────────────────────────────

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;

    if (this.isExpired(entry)) {
      this.evictEntry(key, entry);
      return undefined;
    }

    entry.lastAccessedAt = Date.now();
    return entry.value;
  }

  set(key: K, value: V): this {
    const now = Date.now();
    const existing = this.map.get(key);

    if (existing) {
      // Update in place — no eviction needed.
      existing.value = value;
      existing.insertedAt = now;
      existing.lastAccessedAt = now;
      return this;
    }

    // Evict LRU if at capacity.
    if (this.map.size >= this.maxSize) {
      this.evictLru();
    }

    this.map.set(key, { value, insertedAt: now, lastAccessedAt: now });
    return this;
  }

  has(key: K): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;

    if (this.isExpired(entry)) {
      this.evictEntry(key, entry);
      return false;
    }

    return true;
  }

  delete(key: K): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;

    this.map.delete(key);
    this.onEvict?.(key, entry.value);
    return true;
  }

  /** Delete an entry WITHOUT firing the onEvict callback. */
  deleteQuiet(key: K): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;
    this.map.delete(key);
    return true;
  }

  /** Remove all entries. Does NOT fire onEvict callbacks. Use delete() for individual eviction with callback, or deleteQuiet() to skip the callback. */
  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  // ── Iterators (lazy-purge expired entries) ──────────────────────

  *keys(): IterableIterator<K> {
    for (const [key, entry] of this.map) {
      if (this.isExpired(entry)) {
        this.evictEntry(key, entry);
        continue;
      }
      yield key;
    }
  }

  *values(): IterableIterator<V> {
    for (const [key, entry] of this.map) {
      if (this.isExpired(entry)) {
        this.evictEntry(key, entry);
        continue;
      }
      yield entry.value;
    }
  }

  *entries(): IterableIterator<[K, V]> {
    for (const [key, entry] of this.map) {
      if (this.isExpired(entry)) {
        this.evictEntry(key, entry);
        continue;
      }
      yield [key, entry.value];
    }
  }

  forEach(callback: (value: V, key: K, map: BoundedMap<K, V>) => void): void {
    for (const [key, entry] of this.map) {
      if (this.isExpired(entry)) {
        this.evictEntry(key, entry);
        continue;
      }
      callback(entry.value, key, this);
    }
  }

  // ── Internal helpers ────────────────────────────────────────────

  private isExpired(entry: Entry<V>): boolean {
    if (this.ttlMs === undefined) return false;
    return Date.now() - entry.insertedAt > this.ttlMs;
  }

  private evictLru(): void {
    let oldestKey: K | undefined;
    let oldestTime = Infinity;

    for (const [key, entry] of this.map) {
      if (entry.lastAccessedAt < oldestTime) {
        oldestTime = entry.lastAccessedAt;
        oldestKey = key;
      }
    }

    if (oldestKey !== undefined) {
      const entry = this.map.get(oldestKey)!;
      this.map.delete(oldestKey);
      this.onEvict?.(oldestKey, entry.value);
    }
  }

  private evictEntry(key: K, entry: Entry<V>): void {
    this.map.delete(key);
    this.onEvict?.(key, entry.value);
  }
}
