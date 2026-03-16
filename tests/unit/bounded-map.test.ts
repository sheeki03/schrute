import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BoundedMap } from '../../src/shared/bounded-map.js';

// ─── Tests ───────────────────────────────────────────────────────

describe('BoundedMap', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Basic Map compatibility ─────────────────────────────────────

  describe('standard Map usage patterns', () => {
    it('set and get', () => {
      const map = new BoundedMap<string, number>({ maxSize: 10 });
      map.set('a', 1);
      expect(map.get('a')).toBe(1);
    });

    it('has returns true for existing key', () => {
      const map = new BoundedMap<string, number>({ maxSize: 10 });
      map.set('a', 1);
      expect(map.has('a')).toBe(true);
    });

    it('has returns false for missing key', () => {
      const map = new BoundedMap<string, number>({ maxSize: 10 });
      expect(map.has('missing')).toBe(false);
    });

    it('get returns undefined for missing key', () => {
      const map = new BoundedMap<string, number>({ maxSize: 10 });
      expect(map.get('missing')).toBeUndefined();
    });

    it('size reflects entry count', () => {
      const map = new BoundedMap<string, number>({ maxSize: 10 });
      expect(map.size).toBe(0);
      map.set('a', 1);
      map.set('b', 2);
      expect(map.size).toBe(2);
    });

    it('overwriting a key does not increase size', () => {
      const map = new BoundedMap<string, number>({ maxSize: 10 });
      map.set('a', 1);
      map.set('a', 2);
      expect(map.size).toBe(1);
      expect(map.get('a')).toBe(2);
    });

    it('delete removes entry and returns true', () => {
      const map = new BoundedMap<string, number>({ maxSize: 10 });
      map.set('a', 1);
      expect(map.delete('a')).toBe(true);
      expect(map.has('a')).toBe(false);
      expect(map.size).toBe(0);
    });

    it('delete returns false for missing key', () => {
      const map = new BoundedMap<string, number>({ maxSize: 10 });
      expect(map.delete('missing')).toBe(false);
    });

    it('clear removes all entries', () => {
      const map = new BoundedMap<string, number>({ maxSize: 10 });
      map.set('a', 1);
      map.set('b', 2);
      map.clear();
      expect(map.size).toBe(0);
      expect(map.get('a')).toBeUndefined();
    });
  });

  // ── LRU eviction ───────────────────────────────────────────────

  describe('LRU eviction', () => {
    it('evicts least-recently-accessed entry when at capacity', () => {
      const map = new BoundedMap<string, number>({ maxSize: 3 });

      vi.setSystemTime(1000);
      map.set('a', 1);
      vi.setSystemTime(2000);
      map.set('b', 2);
      vi.setSystemTime(3000);
      map.set('c', 3);

      // 'a' was accessed least recently (t=1000)
      vi.setSystemTime(4000);
      map.set('d', 4);

      expect(map.has('a')).toBe(false);
      expect(map.get('b')).toBe(2);
      expect(map.get('c')).toBe(3);
      expect(map.get('d')).toBe(4);
      expect(map.size).toBe(3);
    });

    it('accessing an entry makes it not the LRU victim', () => {
      const map = new BoundedMap<string, number>({ maxSize: 3 });

      vi.setSystemTime(1000);
      map.set('a', 1);
      vi.setSystemTime(2000);
      map.set('b', 2);
      vi.setSystemTime(3000);
      map.set('c', 3);

      // Touch 'a' so it's no longer the oldest accessed
      vi.setSystemTime(4000);
      map.get('a');

      // Now 'b' is the LRU entry (lastAccessedAt=2000)
      vi.setSystemTime(5000);
      map.set('d', 4);

      expect(map.has('b')).toBe(false);
      expect(map.get('a')).toBe(1);
      expect(map.get('c')).toBe(3);
      expect(map.get('d')).toBe(4);
    });

    it('overwriting existing key does not trigger eviction', () => {
      const map = new BoundedMap<string, number>({ maxSize: 2 });
      map.set('a', 1);
      map.set('b', 2);
      map.set('a', 10); // overwrite, not new
      expect(map.size).toBe(2);
      expect(map.get('a')).toBe(10);
      expect(map.get('b')).toBe(2);
    });
  });

  // ── TTL expiration ─────────────────────────────────────────────

  describe('TTL expiration', () => {
    it('get returns undefined for expired entry', () => {
      const map = new BoundedMap<string, number>({ maxSize: 10, ttlMs: 500 });

      vi.setSystemTime(1000);
      map.set('a', 1);

      vi.setSystemTime(1400);
      expect(map.get('a')).toBe(1); // not yet expired

      vi.setSystemTime(1501);
      expect(map.get('a')).toBeUndefined(); // expired
    });

    it('has returns false for expired entry', () => {
      const map = new BoundedMap<string, number>({ maxSize: 10, ttlMs: 500 });

      vi.setSystemTime(1000);
      map.set('a', 1);

      vi.setSystemTime(1501);
      expect(map.has('a')).toBe(false);
    });

    it('size does NOT purge expired entries (lazy purge only)', () => {
      const map = new BoundedMap<string, number>({ maxSize: 10, ttlMs: 500 });

      vi.setSystemTime(1000);
      map.set('a', 1);

      vi.setSystemTime(2000);
      // size is a direct count — does not purge
      expect(map.size).toBe(1);
    });

    it('expired entry is cleaned up on get, reducing size', () => {
      const map = new BoundedMap<string, number>({ maxSize: 10, ttlMs: 500 });

      vi.setSystemTime(1000);
      map.set('a', 1);

      vi.setSystemTime(2000);
      map.get('a'); // triggers lazy purge
      expect(map.size).toBe(0);
    });
  });

  // ── onEvict callback ───────────────────────────────────────────

  describe('onEvict callback', () => {
    it('fires on LRU eviction', () => {
      const onEvict = vi.fn();
      const map = new BoundedMap<string, number>({ maxSize: 2, onEvict });

      vi.setSystemTime(1000);
      map.set('a', 1);
      vi.setSystemTime(2000);
      map.set('b', 2);
      vi.setSystemTime(3000);
      map.set('c', 3); // evicts 'a'

      expect(onEvict).toHaveBeenCalledTimes(1);
      expect(onEvict).toHaveBeenCalledWith('a', 1);
    });

    it('fires on explicit delete', () => {
      const onEvict = vi.fn();
      const map = new BoundedMap<string, number>({ maxSize: 10, onEvict });

      map.set('x', 42);
      map.delete('x');

      expect(onEvict).toHaveBeenCalledTimes(1);
      expect(onEvict).toHaveBeenCalledWith('x', 42);
    });

    it('fires on TTL expiration via get', () => {
      const onEvict = vi.fn();
      const map = new BoundedMap<string, number>({ maxSize: 10, ttlMs: 100, onEvict });

      vi.setSystemTime(1000);
      map.set('a', 1);

      vi.setSystemTime(1200);
      map.get('a'); // expired → evicted

      expect(onEvict).toHaveBeenCalledTimes(1);
      expect(onEvict).toHaveBeenCalledWith('a', 1);
    });

    it('fires on TTL expiration via has', () => {
      const onEvict = vi.fn();
      const map = new BoundedMap<string, number>({ maxSize: 10, ttlMs: 100, onEvict });

      vi.setSystemTime(1000);
      map.set('a', 1);

      vi.setSystemTime(1200);
      map.has('a');

      expect(onEvict).toHaveBeenCalledTimes(1);
      expect(onEvict).toHaveBeenCalledWith('a', 1);
    });

    it('does not fire on clear', () => {
      const onEvict = vi.fn();
      const map = new BoundedMap<string, number>({ maxSize: 10, onEvict });

      map.set('a', 1);
      map.clear();

      expect(onEvict).not.toHaveBeenCalled();
    });
  });

  // ── Iterators ──────────────────────────────────────────────────

  describe('iterators', () => {
    it('entries() skips expired entries', () => {
      const map = new BoundedMap<string, number>({ maxSize: 10, ttlMs: 500 });

      vi.setSystemTime(1000);
      map.set('old', 1);

      vi.setSystemTime(1300);
      map.set('new', 2);

      vi.setSystemTime(1501); // 'old' expired, 'new' still valid
      const result = [...map.entries()];

      expect(result).toEqual([['new', 2]]);
      expect(map.size).toBe(1); // 'old' was lazily purged
    });

    it('keys() skips expired entries', () => {
      const map = new BoundedMap<string, number>({ maxSize: 10, ttlMs: 500 });

      vi.setSystemTime(1000);
      map.set('old', 1);

      vi.setSystemTime(1300);
      map.set('new', 2);

      vi.setSystemTime(1501);
      expect([...map.keys()]).toEqual(['new']);
    });

    it('values() skips expired entries', () => {
      const map = new BoundedMap<string, number>({ maxSize: 10, ttlMs: 500 });

      vi.setSystemTime(1000);
      map.set('old', 1);

      vi.setSystemTime(1300);
      map.set('new', 2);

      vi.setSystemTime(1501);
      expect([...map.values()]).toEqual([2]);
    });

    it('forEach skips expired entries', () => {
      const map = new BoundedMap<string, number>({ maxSize: 10, ttlMs: 500 });

      vi.setSystemTime(1000);
      map.set('old', 1);

      vi.setSystemTime(1300);
      map.set('new', 2);

      vi.setSystemTime(1501);
      const collected: Array<[string, number]> = [];
      map.forEach((value, key) => collected.push([key, value]));

      expect(collected).toEqual([['new', 2]]);
    });

    it('iterators work on map with no expired entries', () => {
      const map = new BoundedMap<string, number>({ maxSize: 10 });
      map.set('a', 1);
      map.set('b', 2);

      expect([...map.keys()]).toEqual(['a', 'b']);
      expect([...map.values()]).toEqual([1, 2]);
      expect([...map.entries()]).toEqual([['a', 1], ['b', 2]]);
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────

  describe('edge cases', () => {
    it('rejects maxSize < 1', () => {
      expect(() => new BoundedMap({ maxSize: 0 })).toThrow(RangeError);
    });

    it('works with maxSize of 1', () => {
      const map = new BoundedMap<string, number>({ maxSize: 1 });

      map.set('a', 1);
      expect(map.get('a')).toBe(1);

      map.set('b', 2);
      expect(map.get('a')).toBeUndefined();
      expect(map.get('b')).toBe(2);
      expect(map.size).toBe(1);
    });

    it('set returns this for chaining', () => {
      const map = new BoundedMap<string, number>({ maxSize: 10 });
      const result = map.set('a', 1).set('b', 2);
      expect(result).toBe(map);
      expect(map.size).toBe(2);
    });
  });
});
