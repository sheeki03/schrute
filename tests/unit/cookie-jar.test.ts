import { describe, it, expect, beforeEach } from 'vitest';
import { CookieJar } from '../../src/browser/cookie-jar.js';

const testCookies = [
  {
    name: 'session',
    value: 'abc123',
    domain: 'example.com',
    path: '/',
    expires: Date.now() + 3600000,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax' as const,
  },
  {
    name: 'pref',
    value: 'dark',
    domain: 'example.com',
    path: '/',
    expires: Date.now() + 86400000,
    httpOnly: false,
    secure: false,
    sameSite: 'None' as const,
  },
];

describe('CookieJar', () => {
  describe('in-memory storage (locked mode)', () => {
    it('saves and loads cookies in locked mode', async () => {
      const jar = new CookieJar(true);
      await jar.saveCookies('example.com', testCookies);
      const loaded = await jar.loadCookies('example.com');
      expect(loaded).toHaveLength(2);
      expect(loaded[0].name).toBe('session');
      expect(loaded[1].name).toBe('pref');
    });

    it('returns empty array for unknown site in locked mode', async () => {
      const jar = new CookieJar(true);
      const loaded = await jar.loadCookies('unknown.com');
      expect(loaded).toHaveLength(0);
    });

    it('clears cookies in locked mode', async () => {
      const jar = new CookieJar(true);
      await jar.saveCookies('example.com', testCookies);
      await jar.clearCookies('example.com');
      const loaded = await jar.loadCookies('example.com');
      expect(loaded).toHaveLength(0);
    });

    it('refresh needed returns true when no cookies stored', async () => {
      const jar = new CookieJar(true);
      const needed = await jar.refreshNeeded('example.com');
      expect(needed).toBe(true);
    });

    it('refresh needed returns false when cookies are fresh', async () => {
      const jar = new CookieJar(true, 60 * 60 * 1000); // 1 hour refresh
      await jar.saveCookies('example.com', testCookies);
      const needed = await jar.refreshNeeded('example.com');
      expect(needed).toBe(false);
    });
  });

  describe('normal mode (keytar fallback)', () => {
    it('falls back to in-memory when keytar is unavailable', async () => {
      // keytar won't be available in test env; the jar should fall back gracefully
      const jar = new CookieJar(false);
      await jar.saveCookies('example.com', testCookies);
      const loaded = await jar.loadCookies('example.com');
      expect(loaded).toHaveLength(2);
    });

    it('clearCookies does not throw when keytar is unavailable', async () => {
      const jar = new CookieJar(false);
      await jar.saveCookies('example.com', testCookies);
      await expect(jar.clearCookies('example.com')).resolves.toBeUndefined();
    });

    it('refreshNeeded returns true after TTL expires', async () => {
      const jar = new CookieJar(true, 1); // 1ms refresh interval
      await jar.saveCookies('example.com', testCookies);
      // Wait a bit beyond the TTL
      await new Promise((r) => setTimeout(r, 10));
      const needed = await jar.refreshNeeded('example.com');
      expect(needed).toBe(true);
    });
  });
});
