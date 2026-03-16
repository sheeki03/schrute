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

import { fetchRobotsPolicy, clearRobotsPolicyCache } from '../../src/discovery/robots.js';

describe('robots.txt', () => {
  beforeEach(() => {
    clearRobotsPolicyCache();
  });

  describe('fetchRobotsPolicy — parsing', () => {
    it('parses allow and disallow rules', async () => {
      const robotsTxt = [
        'User-agent: *',
        'Disallow: /private/',
        'Allow: /private/public',
      ].join('\n');

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => robotsTxt,
      });

      const policy = await fetchRobotsPolicy('https://example.com', mockFetch as any);

      expect(policy.isAllowed('/public/page')).toBe(true);
      expect(policy.isAllowed('/private/secret')).toBe(false);
      expect(policy.isAllowed('/private/public')).toBe(true);
    });

    it('parses crawl-delay', async () => {
      const robotsTxt = [
        'User-agent: *',
        'Crawl-delay: 10',
        'Disallow: /admin/',
      ].join('\n');

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => robotsTxt,
      });

      const policy = await fetchRobotsPolicy('https://example.com', mockFetch as any);

      expect(policy.crawlDelay).toBe(10);
    });

    it('ignores comments and blank lines', async () => {
      const robotsTxt = [
        '# This is a comment',
        '',
        'User-agent: *',
        '# Another comment',
        'Disallow: /secret/',
        '',
      ].join('\n');

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => robotsTxt,
      });

      const policy = await fetchRobotsPolicy('https://example.com', mockFetch as any);

      expect(policy.isAllowed('/public')).toBe(true);
      expect(policy.isAllowed('/secret/page')).toBe(false);
    });

    it('handles user-agent specific rules', async () => {
      const robotsTxt = [
        'User-agent: mybot',
        'Disallow: /mybot-blocked/',
        '',
        'User-agent: *',
        'Disallow: /blocked/',
      ].join('\n');

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => robotsTxt,
      });

      const policy = await fetchRobotsPolicy('https://example.com', mockFetch as any);

      // mybot is blocked from /mybot-blocked/ and /blocked/ (matches both its rules and *)
      expect(policy.isAllowed('/mybot-blocked/', 'mybot')).toBe(false);
      expect(policy.isAllowed('/blocked/', 'mybot')).toBe(false);

      // Generic user-agent only blocked from /blocked/
      expect(policy.isAllowed('/mybot-blocked/')).toBe(true);
      expect(policy.isAllowed('/blocked/')).toBe(false);
    });
  });

  describe('isAllowed — path matching', () => {
    it('allows paths not matched by any disallow rule', async () => {
      const robotsTxt = 'User-agent: *\nDisallow: /admin/';
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => robotsTxt,
      });

      const policy = await fetchRobotsPolicy('https://example.com', mockFetch as any);

      expect(policy.isAllowed('/')).toBe(true);
      expect(policy.isAllowed('/about')).toBe(true);
      expect(policy.isAllowed('/admin/')).toBe(false);
      expect(policy.isAllowed('/admin/users')).toBe(false);
    });

    it('allow wins on equal-length tie with disallow', async () => {
      const robotsTxt = [
        'User-agent: *',
        'Disallow: /path',
        'Allow: /path',
      ].join('\n');

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => robotsTxt,
      });

      const policy = await fetchRobotsPolicy('https://example.com', mockFetch as any);

      // Allow uses >= for length comparison, so equal-length allow wins
      expect(policy.isAllowed('/path')).toBe(true);
    });

    it('more specific path wins', async () => {
      const robotsTxt = [
        'User-agent: *',
        'Disallow: /dir/',
        'Allow: /dir/exception/',
      ].join('\n');

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => robotsTxt,
      });

      const policy = await fetchRobotsPolicy('https://example.com', mockFetch as any);

      expect(policy.isAllowed('/dir/blocked')).toBe(false);
      expect(policy.isAllowed('/dir/exception/ok')).toBe(true);
    });

    it('handles wildcard patterns', async () => {
      const robotsTxt = [
        'User-agent: *',
        'Disallow: /search*',
      ].join('\n');

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => robotsTxt,
      });

      const policy = await fetchRobotsPolicy('https://example.com', mockFetch as any);

      expect(policy.isAllowed('/search')).toBe(false);
      expect(policy.isAllowed('/search?q=test')).toBe(false);
    });

    it('handles $ end-of-string anchor', async () => {
      const robotsTxt = [
        'User-agent: *',
        'Disallow: /exact$',
      ].join('\n');

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => robotsTxt,
      });

      const policy = await fetchRobotsPolicy('https://example.com', mockFetch as any);

      expect(policy.isAllowed('/exact')).toBe(false);
      expect(policy.isAllowed('/exact/more')).toBe(true);
    });

    it('allows everything when no rules match user-agent', async () => {
      const robotsTxt = [
        'User-agent: specificbot',
        'Disallow: /',
      ].join('\n');

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => robotsTxt,
      });

      const policy = await fetchRobotsPolicy('https://example.com', mockFetch as any);

      // Default user-agent (*) has no rules → allow all
      expect(policy.isAllowed('/')).toBe(true);
      expect(policy.isAllowed('/anything')).toBe(true);
    });
  });

  describe('cache behavior', () => {
    it('caches policy by origin', async () => {
      const robotsTxt = 'User-agent: *\nDisallow: /blocked/';
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => robotsTxt,
      });

      const policy1 = await fetchRobotsPolicy('https://example.com/page1', mockFetch as any);
      const policy2 = await fetchRobotsPolicy('https://example.com/page2', mockFetch as any);

      // Should only fetch once — second call uses cache
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(policy1).toBe(policy2);
    });

    it('fetches separately for different origins', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => 'User-agent: *\nDisallow:',
      });

      await fetchRobotsPolicy('https://a.com', mockFetch as any);
      await fetchRobotsPolicy('https://b.com', mockFetch as any);

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('clearRobotsPolicyCache resets the cache', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => 'User-agent: *\nDisallow:',
      });

      await fetchRobotsPolicy('https://example.com', mockFetch as any);
      clearRobotsPolicyCache();
      await fetchRobotsPolicy('https://example.com', mockFetch as any);

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('fetch failure handling', () => {
    it('allows all when fetch throws', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const policy = await fetchRobotsPolicy('https://example.com', mockFetch as any);

      expect(policy.isAllowed('/')).toBe(true);
      expect(policy.isAllowed('/admin')).toBe(true);
      expect(policy.isAllowed('/anything')).toBe(true);
    });

    it('allows all when response is not ok', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });

      const policy = await fetchRobotsPolicy('https://example.com', mockFetch as any);

      expect(policy.isAllowed('/')).toBe(true);
      expect(policy.isAllowed('/secret')).toBe(true);
    });

    it('caches allow-all policy on fetch failure', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));

      await fetchRobotsPolicy('https://example.com', mockFetch as any);
      // Second call should use cache
      await fetchRobotsPolicy('https://example.com', mockFetch as any);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
