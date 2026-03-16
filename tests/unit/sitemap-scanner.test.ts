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

// ─── Mock policy (SSRF guard) ────────────────────────────────────
vi.mock('../../src/core/policy.js', () => ({
  resolveAndValidate: vi.fn().mockResolvedValue({ ip: '93.184.216.34', allowed: true, category: 'unicast' }),
}));

import { scanSitemap } from '../../src/discovery/sitemap-scanner.js';
import { resolveAndValidate } from '../../src/core/policy.js';
import type { RobotsPolicy } from '../../src/discovery/robots.js';

function makeRobotsPolicy(opts?: {
  blocked?: string[];
  sitemapUrls?: string[];
}): RobotsPolicy {
  const blocked = opts?.blocked ?? [];
  return {
    sitemapUrls: opts?.sitemapUrls ?? [],
    isAllowed(path: string): boolean {
      return !blocked.some(b => path.startsWith(b));
    },
  };
}

function xmlUrlset(urls: string[]): string {
  const locs = urls.map(u => `<url><loc>${u}</loc></url>`).join('\n');
  return `<?xml version="1.0"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locs}\n</urlset>`;
}

function xmlSitemapIndex(sitemapUrls: string[]): string {
  const entries = sitemapUrls.map(u => `<sitemap><loc>${u}</loc></sitemap>`).join('\n');
  return `<?xml version="1.0"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>`;
}

describe('sitemap-scanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveAndValidate).mockResolvedValue({ ip: '93.184.216.34', allowed: true, category: 'unicast' });
  });

  it('parses a simple urlset sitemap', async () => {
    const urls = [
      'https://example.com/page1',
      'https://example.com/page2',
      'https://example.com/page3',
    ];
    const body = xmlUrlset(urls);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      text: async () => body,
    });

    const result = await scanSitemap('https://example.com', mockFetch as any);

    expect(result.found).toBe(true);
    expect(result.urls).toEqual(expect.arrayContaining(urls));
    expect(result.urls.length).toBe(3);
    expect(result.sitemapCount).toBeGreaterThanOrEqual(1);
  });

  it('handles sitemap index with recursion', async () => {
    const childSitemap = xmlUrlset([
      'https://example.com/from-child-1',
      'https://example.com/from-child-2',
    ]);
    const indexBody = xmlSitemapIndex([
      'https://example.com/sitemap-child.xml',
    ]);

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('sitemap-child.xml')) {
        return { ok: true, headers: new Headers(), text: async () => childSitemap };
      }
      // Default sitemaps (sitemap.xml, sitemap_index.xml) — return index on first, 404 on others
      if (url.endsWith('/sitemap.xml')) {
        return { ok: true, headers: new Headers(), text: async () => indexBody };
      }
      return { ok: false, status: 404, headers: new Headers(), text: async () => '' };
    });

    const result = await scanSitemap('https://example.com', mockFetch as any);

    expect(result.found).toBe(true);
    expect(result.urls).toContain('https://example.com/from-child-1');
    expect(result.urls).toContain('https://example.com/from-child-2');
    expect(result.sitemapCount).toBe(2); // index + child
  });

  it('filters out cross-origin URLs', async () => {
    const body = xmlUrlset([
      'https://example.com/same-origin',
      'https://evil.com/cross-origin',
      'https://other.example.com/different-host',
    ]);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      text: async () => body,
    });

    const result = await scanSitemap('https://example.com', mockFetch as any);

    expect(result.urls).toContain('https://example.com/same-origin');
    expect(result.urls).not.toContain('https://evil.com/cross-origin');
    expect(result.urls).not.toContain('https://other.example.com/different-host');
    expect(result.urls.length).toBe(1);
  });

  it('respects URL cap of 50,000', async () => {
    // Generate more than 50,000 URLs
    const urls: string[] = [];
    for (let i = 0; i < 50_010; i++) {
      urls.push(`https://example.com/page/${i}`);
    }
    const body = xmlUrlset(urls);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      text: async () => body,
    });

    const result = await scanSitemap('https://example.com', mockFetch as any);

    expect(result.urls.length).toBeLessThanOrEqual(50_000);
  });

  it('uses Sitemap: directives from robots.txt policy', async () => {
    const customSitemapBody = xmlUrlset([
      'https://example.com/custom-page',
    ]);

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url === 'https://example.com/custom-sitemap.xml') {
        return { ok: true, headers: new Headers(), text: async () => customSitemapBody };
      }
      return { ok: false, status: 404, headers: new Headers(), text: async () => '' };
    });

    const policy = makeRobotsPolicy({
      sitemapUrls: ['https://example.com/custom-sitemap.xml'],
    });

    const result = await scanSitemap('https://example.com', mockFetch as any, policy);

    expect(result.found).toBe(true);
    expect(result.urls).toContain('https://example.com/custom-page');
  });

  it('skips sitemaps blocked by robots.txt', async () => {
    const body = xmlUrlset(['https://example.com/should-not-see']);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      text: async () => body,
    });

    const policy = makeRobotsPolicy({
      blocked: ['/sitemap'],
    });

    const result = await scanSitemap('https://example.com', mockFetch as any, policy);

    // Both /sitemap.xml and /sitemap_index.xml are blocked
    expect(result.found).toBe(false);
    expect(result.urls.length).toBe(0);
  });

  it('skips sitemaps with private IPs (SSRF guard)', async () => {
    vi.mocked(resolveAndValidate).mockResolvedValue({
      ip: '127.0.0.1',
      allowed: false,
      category: 'loopback',
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      text: async () => xmlUrlset(['https://example.com/page']),
    });

    const result = await scanSitemap('https://example.com', mockFetch as any);

    expect(result.found).toBe(false);
    expect(result.urls.length).toBe(0);
    // fetch should NOT have been called since SSRF check blocks it
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('deduplicates URLs across multiple sitemaps', async () => {
    const sitemap1 = xmlUrlset([
      'https://example.com/page1',
      'https://example.com/page2',
    ]);
    const sitemap2 = xmlUrlset([
      'https://example.com/page2',
      'https://example.com/page3',
    ]);

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/sitemap.xml')) {
        return { ok: true, headers: new Headers(), text: async () => sitemap1 };
      }
      if (url.endsWith('/sitemap_index.xml')) {
        return { ok: true, headers: new Headers(), text: async () => sitemap2 };
      }
      return { ok: false, status: 404, headers: new Headers(), text: async () => '' };
    });

    const result = await scanSitemap('https://example.com', mockFetch as any);

    // page2 appears in both, should be deduplicated
    expect(result.urls.filter(u => u === 'https://example.com/page2').length).toBe(1);
    expect(result.urls.length).toBe(3);
  });

  it('returns found=false when no sitemaps respond successfully', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers(),
      text: async () => '',
    });

    const result = await scanSitemap('https://example.com', mockFetch as any);

    expect(result.found).toBe(false);
    expect(result.urls.length).toBe(0);
    expect(result.sitemapCount).toBe(0);
  });

  it('handles fetch errors gracefully', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const result = await scanSitemap('https://example.com', mockFetch as any);

    expect(result.found).toBe(false);
    expect(result.urls.length).toBe(0);
  });

  it('skips cross-origin sitemap index children', async () => {
    const indexBody = xmlSitemapIndex([
      'https://evil.com/evil-sitemap.xml',
      'https://example.com/legit-child.xml',
    ]);
    const childBody = xmlUrlset(['https://example.com/child-page']);

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/sitemap.xml')) {
        return { ok: true, headers: new Headers(), text: async () => indexBody };
      }
      if (url.endsWith('/legit-child.xml')) {
        return { ok: true, headers: new Headers(), text: async () => childBody };
      }
      return { ok: false, status: 404, headers: new Headers(), text: async () => '' };
    });

    const result = await scanSitemap('https://example.com', mockFetch as any);

    expect(result.urls).toContain('https://example.com/child-page');
    // evil.com child should have been skipped (cross-origin)
    expect(mockFetch).not.toHaveBeenCalledWith(
      'https://evil.com/evil-sitemap.xml',
      expect.anything(),
    );
  });

  it('limits recursion depth to 2', async () => {
    // depth 0: index pointing to child index
    const level0 = xmlSitemapIndex(['https://example.com/level1.xml']);
    // depth 1: another index pointing to yet another
    const level1 = xmlSitemapIndex(['https://example.com/level2.xml']);
    // depth 2: yet another index — should NOT recurse further
    const level2 = xmlSitemapIndex(['https://example.com/level3.xml']);
    // depth 3 (should not be reached)
    const level3 = xmlUrlset(['https://example.com/deep-page']);

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/sitemap.xml')) return { ok: true, headers: new Headers(), text: async () => level0 };
      if (url.endsWith('/level1.xml')) return { ok: true, headers: new Headers(), text: async () => level1 };
      if (url.endsWith('/level2.xml')) return { ok: true, headers: new Headers(), text: async () => level2 };
      if (url.endsWith('/level3.xml')) return { ok: true, headers: new Headers(), text: async () => level3 };
      return { ok: false, status: 404, headers: new Headers(), text: async () => '' };
    });

    const result = await scanSitemap('https://example.com', mockFetch as any);

    // level3.xml should NOT be fetched because depth=2 means the index at level2
    // tries to recurse but depth >= MAX_RECURSION_DEPTH (2)
    expect(mockFetch).not.toHaveBeenCalledWith(
      'https://example.com/level3.xml',
      expect.anything(),
    );
    // deep-page should not appear
    expect(result.urls).not.toContain('https://example.com/deep-page');
  });
});
