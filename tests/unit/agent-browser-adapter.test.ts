import { describe, it, expect, vi } from 'vitest';
import { AgentBrowserAdapter } from '../../src/browser/agent-browser-adapter.js';

// Minimal Playwright Page mock
function mockPage(overrides: Record<string, unknown> = {}) {
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue('https://example.com'),
    title: vi.fn().mockResolvedValue('Example'),
    locator: vi.fn().mockReturnValue({
      ariaSnapshot: vi.fn().mockResolvedValue('heading "Example"\nbutton "Click me"'),
      innerText: vi.fn().mockResolvedValue('Example\nClick me'),
      click: vi.fn().mockResolvedValue(undefined),
      fill: vi.fn().mockResolvedValue(undefined),
      hover: vi.fn().mockResolvedValue(undefined),
      first: vi.fn().mockReturnValue({
        click: vi.fn().mockResolvedValue(undefined),
        fill: vi.fn().mockResolvedValue(undefined),
      }),
      dragTo: vi.fn().mockResolvedValue(undefined),
      selectOption: vi.fn().mockResolvedValue(undefined),
      setInputFiles: vi.fn().mockResolvedValue(undefined),
    }),
    evaluate: vi.fn().mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
    }),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-screenshot')),
    goBack: vi.fn().mockResolvedValue(undefined),
    keyboard: { press: vi.fn().mockResolvedValue(undefined) },
    setViewportSize: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    context: vi.fn().mockReturnValue({
      pages: vi.fn().mockReturnValue([{
        url: vi.fn().mockReturnValue('https://example.com'),
      }]),
    }),
    on: vi.fn(), // network capture listener
    ...overrides,
  };
  return page;
}

describe('AgentBrowserAdapter', () => {
  describe('constructor', () => {
    it('creates adapter with page and domain allowlist', () => {
      const page = mockPage();
      const adapter = new AgentBrowserAdapter(page as any, ['example.com']);
      expect(adapter).toBeDefined();
    });
  });

  describe('navigate', () => {
    it('navigates to URL via page.goto', async () => {
      const page = mockPage();
      const adapter = new AgentBrowserAdapter(page as any, ['example.com']);

      await adapter.navigate('https://example.com');

      expect(page.goto).toHaveBeenCalledWith('https://example.com', { waitUntil: 'domcontentloaded' });
    });
  });

  describe('snapshot', () => {
    it('returns page snapshot with aria tree content', async () => {
      const page = mockPage();
      const adapter = new AgentBrowserAdapter(page as any, ['example.com']);

      const snap = await adapter.snapshot();

      expect(snap.url).toBe('https://example.com');
      expect(snap.title).toBe('Example');
      expect(snap.content).toContain('heading');
    });
  });

  describe('click', () => {
    it('clicks element by ref', async () => {
      const page = mockPage();
      const adapter = new AgentBrowserAdapter(page as any, ['example.com']);

      await adapter.click('submit-btn');

      expect(page.locator).toHaveBeenCalledWith(
        '[data-ref="submit-btn"], [aria-label="submit-btn"]',
      );
    });
  });

  describe('type', () => {
    it('types text into element by ref', async () => {
      const page = mockPage();
      const adapter = new AgentBrowserAdapter(page as any, ['example.com']);

      await adapter.type('email-input', 'test@example.com');

      expect(page.locator).toHaveBeenCalledWith(
        '[data-ref="email-input"], [aria-label="email-input"]',
      );
    });
  });

  describe('evaluateFetch', () => {
    it('executes sealed fetch for allowed domains', async () => {
      const page = mockPage();
      const adapter = new AgentBrowserAdapter(page as any, ['api.example.com']);

      const result = await adapter.evaluateFetch({
        url: 'https://api.example.com/data',
        method: 'GET',
        headers: {},
      });

      expect(result.status).toBe(200);
      expect(result.body).toContain('ok');
      expect(page.evaluate).toHaveBeenCalled();
    });

    it('rejects fetch for domains not in allowlist', async () => {
      const page = mockPage();
      const adapter = new AgentBrowserAdapter(page as any, ['example.com']);

      await expect(
        adapter.evaluateFetch({
          url: 'https://evil.com/steal',
          method: 'GET',
          headers: {},
        }),
      ).rejects.toThrow('not on the allowlist');
    });

    it('rejects fetch when allowlist is empty', async () => {
      const page = mockPage();
      const adapter = new AgentBrowserAdapter(page as any, []);

      await expect(
        adapter.evaluateFetch({
          url: 'https://example.com/api',
          method: 'GET',
          headers: {},
        }),
      ).rejects.toThrow('not on the allowlist');
    });
  });

  describe('screenshot', () => {
    it('returns buffer from page.screenshot', async () => {
      const page = mockPage();
      const adapter = new AgentBrowserAdapter(page as any, ['example.com']);

      const buf = await adapter.screenshot();

      expect(Buffer.isBuffer(buf)).toBe(true);
    });
  });

  describe('networkRequests', () => {
    it('returns empty array initially', async () => {
      const page = mockPage();
      const adapter = new AgentBrowserAdapter(page as any, ['example.com']);

      const entries = await adapter.networkRequests();

      expect(entries).toEqual([]);
    });
  });

  describe('proxyTool', () => {
    it('blocks browser_evaluate', async () => {
      const page = mockPage();
      const adapter = new AgentBrowserAdapter(page as any, ['example.com']);

      await expect(
        adapter.proxyTool('browser_evaluate', {}),
      ).rejects.toThrow('BLOCKED');
    });

    it('blocks browser_run_code', async () => {
      const page = mockPage();
      const adapter = new AgentBrowserAdapter(page as any, ['example.com']);

      await expect(
        adapter.proxyTool('browser_run_code', {}),
      ).rejects.toThrow('BLOCKED');
    });

    it('denies unknown tools', async () => {
      const page = mockPage();
      const adapter = new AgentBrowserAdapter(page as any, ['example.com']);

      await expect(
        adapter.proxyTool('unknown_tool', {}),
      ).rejects.toThrow('DENIED');
    });

    it('proxies browser_navigate', async () => {
      const page = mockPage();
      const adapter = new AgentBrowserAdapter(page as any, ['example.com']);

      const result = await adapter.proxyTool('browser_navigate', { url: 'https://example.com' });

      expect(result).toEqual({ success: true });
      expect(page.goto).toHaveBeenCalled();
    });

    it('proxies browser_snapshot', async () => {
      const page = mockPage();
      const adapter = new AgentBrowserAdapter(page as any, ['example.com']);

      const result = await adapter.proxyTool('browser_snapshot', {});

      expect(result).toHaveProperty('url');
      expect(result).toHaveProperty('title');
      expect(result).toHaveProperty('content');
    });
  });
});
