import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../src/shared/atomic-write.js', () => ({
  writeFileAtomically: vi.fn(),
}));

import { loadAuthCookieHeader } from '../../src/replay/executor.js';
import type { BrowserAuthStore } from '../../src/browser/auth-store.js';
import type { CookieEntry } from '../../src/browser/backend.js';

function makeCookie(overrides: Partial<CookieEntry> = {}): CookieEntry {
  return {
    name: 'session',
    value: 'abc123',
    domain: 'example.com',
    path: '/',
    ...overrides,
  };
}

function makeAuthStore(cookies: CookieEntry[]): BrowserAuthStore {
  return {
    load: vi.fn().mockReturnValue({
      cookies,
      origins: [],
      version: 1,
      lastUpdated: Date.now(),
    }),
    save: vi.fn(),
    toPlaywrightStorageState: vi.fn(),
  } as unknown as BrowserAuthStore;
}

describe('loadAuthCookieHeader', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when no authStore is provided', () => {
    const result = loadAuthCookieHeader('example.com', 'https://example.com/api/data', undefined);
    expect(result).toBeNull();
  });

  it('returns null when authStore has no cookies', () => {
    const store = makeAuthStore([]);
    const result = loadAuthCookieHeader('example.com', 'https://example.com/api/data', store);
    expect(result).toBeNull();
  });

  it('returns null when no cookies match the request domain', () => {
    const store = makeAuthStore([makeCookie({ domain: 'other.com' })]);
    const result = loadAuthCookieHeader('example.com', 'https://example.com/api/data', store);
    expect(result).toBeNull();
  });

  it('returns cookie header for exact domain match', () => {
    const store = makeAuthStore([makeCookie({ domain: 'example.com', name: 'sid', value: 'xyz' })]);
    const result = loadAuthCookieHeader('example.com', 'https://example.com/api/data', store);
    expect(result).toBe('sid=xyz');
  });

  it('returns cookie header for dot-boundary suffix match (sub.example.com matches example.com)', () => {
    const store = makeAuthStore([makeCookie({ domain: 'example.com', name: 'sid', value: 'xyz' })]);
    const result = loadAuthCookieHeader('example.com', 'https://sub.example.com/api/data', store);
    expect(result).toBe('sid=xyz');
  });

  it('returns cookie header for leading-dot domain (.example.com matches sub.example.com)', () => {
    const store = makeAuthStore([makeCookie({ domain: '.example.com', name: 'sid', value: 'xyz' })]);
    const result = loadAuthCookieHeader('example.com', 'https://sub.example.com/api/data', store);
    expect(result).toBe('sid=xyz');
  });

  it('does NOT match notexample.com against example.com (dot-boundary safety)', () => {
    const store = makeAuthStore([makeCookie({ domain: 'example.com', name: 'sid', value: 'xyz' })]);
    const result = loadAuthCookieHeader('example.com', 'https://notexample.com/api/data', store);
    expect(result).toBeNull();
  });

  it('does NOT match evilexample.com against example.com', () => {
    const store = makeAuthStore([makeCookie({ domain: 'example.com', name: 'sid', value: 'xyz' })]);
    const result = loadAuthCookieHeader('example.com', 'https://evilexample.com/api/data', store);
    expect(result).toBeNull();
  });

  it('filters out expired cookies', () => {
    const pastExpiry = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    const store = makeAuthStore([makeCookie({ name: 'expired', value: 'old', expires: pastExpiry })]);
    const result = loadAuthCookieHeader('example.com', 'https://example.com/api/data', store);
    expect(result).toBeNull();
  });

  it('includes non-expired cookies', () => {
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    const store = makeAuthStore([makeCookie({ name: 'valid', value: 'fresh', expires: futureExpiry })]);
    const result = loadAuthCookieHeader('example.com', 'https://example.com/api/data', store);
    expect(result).toBe('valid=fresh');
  });

  it('includes session cookies (expires === 0 or undefined)', () => {
    const store = makeAuthStore([
      makeCookie({ name: 'sess1', value: 'a', expires: 0 }),
      makeCookie({ name: 'sess2', value: 'b', expires: undefined }),
    ]);
    const result = loadAuthCookieHeader('example.com', 'https://example.com/api/data', store);
    expect(result).toBe('sess1=a; sess2=b');
  });

  it('rejects secure cookies on http:// requests', () => {
    const store = makeAuthStore([makeCookie({ name: 'sec', value: 'safe', secure: true })]);
    const result = loadAuthCookieHeader('example.com', 'http://example.com/api/data', store);
    expect(result).toBeNull();
  });

  it('includes secure cookies on https:// requests', () => {
    const store = makeAuthStore([makeCookie({ name: 'sec', value: 'safe', secure: true })]);
    const result = loadAuthCookieHeader('example.com', 'https://example.com/api/data', store);
    expect(result).toBe('sec=safe');
  });

  it('filters cookies by path prefix', () => {
    const store = makeAuthStore([
      makeCookie({ name: 'root', value: 'r', path: '/' }),
      makeCookie({ name: 'api', value: 'a', path: '/api' }),
      makeCookie({ name: 'admin', value: 'x', path: '/admin' }),
    ]);
    const result = loadAuthCookieHeader('example.com', 'https://example.com/api/data', store);
    expect(result).toBe('root=r; api=a');
  });

  it('path matching requires boundary — /api does NOT match /api2', () => {
    const store = makeAuthStore([
      makeCookie({ name: 'tok', value: 'v', path: '/api' }),
    ]);
    const result = loadAuthCookieHeader('example.com', 'https://example.com/api2', store);
    expect(result).toBeNull();
  });

  it('path matching allows exact match — /api matches /api', () => {
    const store = makeAuthStore([
      makeCookie({ name: 'tok', value: 'v', path: '/api' }),
    ]);
    const result = loadAuthCookieHeader('example.com', 'https://example.com/api', store);
    expect(result).toBe('tok=v');
  });

  it('path matching allows slash boundary — /api matches /api/foo', () => {
    const store = makeAuthStore([
      makeCookie({ name: 'tok', value: 'v', path: '/api' }),
    ]);
    const result = loadAuthCookieHeader('example.com', 'https://example.com/api/foo', store);
    expect(result).toBe('tok=v');
  });

  it('joins multiple matching cookies with semicolon', () => {
    const store = makeAuthStore([
      makeCookie({ name: 'a', value: '1' }),
      makeCookie({ name: 'b', value: '2' }),
      makeCookie({ name: 'c', value: '3' }),
    ]);
    const result = loadAuthCookieHeader('example.com', 'https://example.com/', store);
    expect(result).toBe('a=1; b=2; c=3');
  });

  it('falls back to siteId when cookie domain is undefined', () => {
    const store = makeAuthStore([makeCookie({ name: 'fallback', value: 'fb', domain: undefined as any })]);
    const result = loadAuthCookieHeader('example.com', 'https://example.com/api/data', store);
    expect(result).toBe('fallback=fb');
  });

  it('returns null when authStore.load throws', () => {
    const store = {
      load: vi.fn().mockImplementation(() => { throw new Error('disk error'); }),
    } as unknown as BrowserAuthStore;
    const result = loadAuthCookieHeader('example.com', 'https://example.com/api/data', store);
    expect(result).toBeNull();
  });

  it('returns null when authStore.load returns undefined', () => {
    const store = {
      load: vi.fn().mockReturnValue(undefined),
    } as unknown as BrowserAuthStore;
    const result = loadAuthCookieHeader('example.com', 'https://example.com/api/data', store);
    expect(result).toBeNull();
  });
});
