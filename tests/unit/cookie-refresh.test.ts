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

vi.mock('../../src/core/config.js', () => ({
  getConfig: () => ({
    dataDir: '/tmp/schrute-cookie-test',
    logLevel: 'silent',
  }),
  getBrowserDataDir: () => '/tmp/schrute-cookie-test/browser-data',
  getTmpDir: () => '/tmp/schrute-cookie-test/tmp',
}));

// Mock cookie jar
const mockCookieJar = {
  saveCookies: vi.fn().mockResolvedValue(undefined),
  loadCookies: vi.fn().mockResolvedValue([]),
};

vi.mock('../../src/browser/cookie-jar.js', () => ({
  CookieJar: vi.fn().mockImplementation(() => mockCookieJar),
}));

import { refreshCookies } from '../../src/automation/cookie-refresh.js';
import type { BrowserManager } from '../../src/browser/manager.js';

function makeMockPage(cookies: Array<{
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
}> = []) {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockContext(
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: string;
  }> = [],
) {
  const page = makeMockPage(cookies);
  return {
    context: {
      newPage: vi.fn().mockResolvedValue(page),
      cookies: vi.fn().mockResolvedValue(cookies),
    },
    page,
  };
}

describe('cookie-refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('refreshCookies', () => {
    it('creates browser context and navigates to site', async () => {
      const { context, page } = makeMockContext([
        {
          name: 'session',
          value: 'abc123',
          domain: '.example.com',
          path: '/',
          expires: Date.now() / 1000 + 3600,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
      ]);

      const mockBrowserManager = {
        getOrCreateContext: vi.fn().mockResolvedValue(context),
      } as unknown as BrowserManager;

      const result = await refreshCookies('example.com', undefined, mockBrowserManager);
      expect(result).toBe(true);
      expect(mockBrowserManager.getOrCreateContext).toHaveBeenCalledWith('example.com');
      expect(page.goto).toHaveBeenCalledWith('https://example.com', expect.objectContaining({
        waitUntil: 'networkidle',
      }));
    });

    it('extracts and saves cookies to cookie jar', async () => {
      const cookies = [
        {
          name: 'session',
          value: 'abc',
          domain: '.example.com',
          path: '/',
          expires: Date.now() / 1000 + 3600,
          httpOnly: true,
          secure: true,
          sameSite: 'Strict',
        },
        {
          name: 'pref',
          value: 'dark',
          domain: '.example.com',
          path: '/',
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: 'Lax',
        },
      ];

      const { context } = makeMockContext(cookies);
      const mockBrowserManager = {
        getOrCreateContext: vi.fn().mockResolvedValue(context),
      } as unknown as BrowserManager;

      await refreshCookies('example.com', mockCookieJar as any, mockBrowserManager);
      expect(mockCookieJar.saveCookies).toHaveBeenCalledWith(
        'example.com',
        expect.arrayContaining([
          expect.objectContaining({ name: 'session', value: 'abc' }),
          expect.objectContaining({ name: 'pref', value: 'dark' }),
        ]),
      );
    });

    it('returns false when no cookies found', async () => {
      const { context, page } = makeMockContext([]);
      const mockBrowserManager = {
        getOrCreateContext: vi.fn().mockResolvedValue(context),
      } as unknown as BrowserManager;

      const result = await refreshCookies('no-cookies.com', undefined, mockBrowserManager);
      expect(result).toBe(false);
      expect(page.close).toHaveBeenCalled();
    });

    it('handles navigation timeout gracefully', async () => {
      const cookies = [
        {
          name: 'session',
          value: 'abc',
          domain: '.example.com',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
      ];

      const { context, page } = makeMockContext(cookies);
      page.goto.mockRejectedValueOnce(new Error('Navigation timeout'));

      const mockBrowserManager = {
        getOrCreateContext: vi.fn().mockResolvedValue(context),
      } as unknown as BrowserManager;

      // Should still return true if cookies are found despite timeout
      const result = await refreshCookies('example.com', mockCookieJar as any, mockBrowserManager);
      expect(result).toBe(true);
    });

    it('returns false on browser context creation failure', async () => {
      const mockBrowserManager = {
        getOrCreateContext: vi.fn().mockRejectedValue(new Error('Browser crashed')),
      } as unknown as BrowserManager;

      const result = await refreshCookies('example.com', undefined, mockBrowserManager);
      expect(result).toBe(false);
    });
  });
});
