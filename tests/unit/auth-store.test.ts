import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import { BrowserAuthStore } from '../../src/browser/auth-store.js';

vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('BrowserAuthStore', () => {
  let dataDir: string;
  let store: BrowserAuthStore;

  beforeEach(() => {
    dataDir = '/tmp/schrute-authstore-test-' + Math.random().toString(36).slice(2);
    fs.mkdirSync(dataDir, { recursive: true });
    store = new BrowserAuthStore(dataDir);
  });

  afterEach(() => {
    try { fs.rmSync(dataDir, { recursive: true }); } catch { /* cleanup best effort */ }
  });

  it('returns undefined for non-existent site', () => {
    expect(store.load('nonexistent')).toBeUndefined();
  });

  it('saves and loads auth state', () => {
    const result = store.save('site1', {
      cookies: [{ name: 'tok', value: 'abc', domain: 'site1.com', path: '/' }],
      origins: [],
      lastUpdated: Date.now(),
    });
    expect(result.changed).toBe(true);
    expect(result.version).toBe(1);

    const loaded = store.load('site1');
    expect(loaded).toBeDefined();
    expect(loaded!.cookies).toHaveLength(1);
    expect(loaded!.version).toBe(1);
  });

  it('increments version on each changed save', () => {
    store.save('site1', { cookies: [{ name: 'a', value: '1', domain: 'd', path: '/' }], origins: [], lastUpdated: 1 });
    const r2 = store.save('site1', { cookies: [{ name: 'b', value: '2', domain: 'd', path: '/' }], origins: [], lastUpdated: 2 });
    expect(r2.version).toBe(2);
  });

  it('no-op save returns changed=false with same version', () => {
    store.save('site1', { cookies: [{ name: 'a', value: '1', domain: 'd', path: '/' }], origins: [], lastUpdated: 1 });
    const r2 = store.save('site1', { cookies: [{ name: 'a', value: '1', domain: 'd', path: '/' }], origins: [], lastUpdated: 1 });
    expect(r2.changed).toBe(false);
    expect(r2.version).toBe(1);
  });

  it('converts to Playwright storage state format', () => {
    const state = {
      cookies: [{ name: 'tok', value: 'abc', domain: '.example.com', path: '/' }],
      origins: [{ origin: 'https://example.com', localStorage: [{ name: 'key', value: 'val' }] }],
      version: 1,
      lastUpdated: Date.now(),
    };
    const pwState = store.toPlaywrightStorageState(state) as Record<string, unknown>;
    const cookies = pwState.cookies as Array<Record<string, unknown>>;
    expect(cookies).toHaveLength(1);
    expect(cookies[0].sameSite).toBe('None');
    expect(cookies[0].httpOnly).toBe(false);
    expect(cookies[0].secure).toBe(false);
    expect(cookies[0].expires).toBe(-1);
    const origins = pwState.origins as Array<Record<string, unknown>>;
    expect(origins).toHaveLength(1);
  });

  it('sanitizes siteId for filesystem', () => {
    const result = store.save('site/with:special<chars>', {
      cookies: [{ name: 'x', value: 'y', domain: 'd', path: '/' }],
      origins: [],
      lastUpdated: 1,
    });
    expect(result.changed).toBe(true);
    const loaded = store.load('site/with:special<chars>');
    expect(loaded).toBeDefined();
    expect(loaded!.cookies[0].name).toBe('x');
  });

  it('detects change when cookie values differ', () => {
    store.save('site1', { cookies: [{ name: 'a', value: '1', domain: 'd', path: '/' }], origins: [], lastUpdated: 1 });
    const r2 = store.save('site1', { cookies: [{ name: 'a', value: '2', domain: 'd', path: '/' }], origins: [], lastUpdated: 1 });
    expect(r2.changed).toBe(true);
    expect(r2.version).toBe(2);
  });

  it('detects change when origins differ', () => {
    store.save('site1', { cookies: [], origins: [], lastUpdated: 1 });
    const r2 = store.save('site1', {
      cookies: [],
      origins: [{ origin: 'https://example.com', localStorage: [{ name: 'k', value: 'v' }] }],
      lastUpdated: 1,
    });
    expect(r2.changed).toBe(true);
    expect(r2.version).toBe(2);
  });
});
