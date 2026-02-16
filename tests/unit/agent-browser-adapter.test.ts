import { describe, it, expect, vi } from 'vitest';
import { AgentBrowserAdapter } from '../../src/browser/agent-browser-adapter.js';
import type { BrowserFeatureFlags } from '../../src/browser/feature-flags.js';
import type { EngineCapabilities } from '../../src/browser/engine.js';

// Feature flags that disable all new features for backward-compat testing
const LEGACY_FLAGS: BrowserFeatureFlags = {
  snapshotMode: 'full',
  incrementalDiffs: false,
  modalTracking: false,
  screenshotResize: false,
  batchActions: false,
};

const PATCHRIGHT_CAPABILITIES: EngineCapabilities = {
  supportsConsoleEvents: false,
  supportsCDP: true,
  configuredEngine: 'patchright',
  effectiveEngine: 'patchright',
};

// Minimal Playwright Page mock
function mockPage(overrides: Record<string, unknown> = {}) {
  const mainFrameMock = {
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
  };

  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue('https://example.com'),
    title: vi.fn().mockResolvedValue('Example'),
    locator: vi.fn().mockReturnValue({
      ariaSnapshot: vi.fn().mockResolvedValue('- heading "Example"\n- button "Click me"'),
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
    getByRole: vi.fn().mockReturnValue({
      click: vi.fn().mockResolvedValue(undefined),
      fill: vi.fn().mockResolvedValue(undefined),
      hover: vi.fn().mockResolvedValue(undefined),
      nth: vi.fn().mockReturnThis(),
      getByRole: vi.fn().mockReturnThis(),
      first: vi.fn().mockReturnThis(),
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
    setDefaultTimeout: vi.fn(),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    mainFrame: vi.fn().mockReturnValue(mainFrameMock),
    frames: vi.fn().mockReturnValue([mainFrameMock]),
    context: vi.fn().mockReturnValue({
      pages: vi.fn().mockReturnValue([{
        url: vi.fn().mockReturnValue('https://example.com'),
      }]),
    }),
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  };
  return page;
}

describe('AgentBrowserAdapter', () => {
  describe('constructor', () => {
    it('creates adapter with page and domain allowlist', () => {
      const page = mockPage();
      const adapter = new AgentBrowserAdapter(page as any, ['example.com'], { flags: LEGACY_FLAGS });
      expect(adapter).toBeDefined();
    });
  });

  describe('navigate', () => {
    it('navigates to URL via page.goto', async () => {
      const page = mockPage();
      const adapter = new AgentBrowserAdapter(page as any, ['example.com'], { flags: LEGACY_FLAGS });

      await adapter.navigate('https://example.com');

      expect(page.goto).toHaveBeenCalledWith('https://example.com', { waitUntil: 'domcontentloaded' });
    });
  });

  describe('snapshot', () => {
    it('returns page snapshot with aria tree content', async () => {
      const page = mockPage();
      const adapter = new AgentBrowserAdapter(page as any, ['example.com'], { flags: LEGACY_FLAGS });

      const snap = await adapter.snapshot();

      expect(snap.url).toBe('https://example.com');
      expect(snap.title).toBe('Example');
      expect(snap.content).toContain('heading');
    });
  });

  describe('click', () => {
    it('clicks element by legacy ref', async () => {
      const page = mockPage();
      const adapter = new AgentBrowserAdapter(page as any, ['example.com'], { flags: LEGACY_FLAGS });

      await adapter.click('submit-btn');

      expect(page.locator).toHaveBeenCalledWith(
        '[data-ref="submit-btn"], [aria-label="submit-btn"]',
      );
    });
  });

  describe('type', () => {
    it('types text into element by legacy ref', async () => {
      const page = mockPage();
      const adapter = new AgentBrowserAdapter(page as any, ['example.com'], { flags: LEGACY_FLAGS });

      await adapter.type('email-input', 'test@example.com');

      expect(page.locator).toHaveBeenCalledWith(
        '[data-ref="email-input"], [aria-label="email-input"]',
      );
    });
  });

  describe('evaluateFetch', () => {
    it('executes sealed fetch for allowed domains', async () => {
      const page = mockPage();
      const adapter = new AgentBrowserAdapter(page as any, ['api.example.com'], { flags: LEGACY_FLAGS });

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
      const adapter = new AgentBrowserAdapter(page as any, ['example.com'], { flags: LEGACY_FLAGS });

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
      const adapter = new AgentBrowserAdapter(page as any, [], { flags: LEGACY_FLAGS });

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
      // screenshotResize: false — returns raw buffer without PNG parsing
      const adapter = new AgentBrowserAdapter(page as any, ['example.com'], { flags: LEGACY_FLAGS });

      const buf = await adapter.screenshot();

      expect(Buffer.isBuffer(buf)).toBe(true);
    });
  });

  describe('networkRequests', () => {
    it('returns empty array initially', async () => {
      const page = mockPage();
      const adapter = new AgentBrowserAdapter(page as any, ['example.com'], { flags: LEGACY_FLAGS });

      const entries = await adapter.networkRequests();

      expect(entries).toEqual([]);
    });
  });

  describe('proxyTool', () => {
    it('blocks browser_evaluate', async () => {
      const page = mockPage();
      const adapter = new AgentBrowserAdapter(page as any, ['example.com'], { flags: LEGACY_FLAGS });

      await expect(
        adapter.proxyTool('browser_evaluate', {}),
      ).rejects.toThrow('BLOCKED');
    });

    it('blocks browser_run_code', async () => {
      const page = mockPage();
      const adapter = new AgentBrowserAdapter(page as any, ['example.com'], { flags: LEGACY_FLAGS });

      await expect(
        adapter.proxyTool('browser_run_code', {}),
      ).rejects.toThrow('BLOCKED');
    });

    it('denies unknown tools', async () => {
      const page = mockPage();
      const adapter = new AgentBrowserAdapter(page as any, ['example.com'], { flags: LEGACY_FLAGS });

      await expect(
        adapter.proxyTool('unknown_tool', {}),
      ).rejects.toThrow('DENIED');
    });

    it('proxies browser_navigate', async () => {
      const page = mockPage();
      const adapter = new AgentBrowserAdapter(page as any, ['example.com'], { flags: LEGACY_FLAGS });

      const result = await adapter.proxyTool('browser_navigate', { url: 'https://example.com' });

      expect(result).toEqual({ success: true });
      expect(page.goto).toHaveBeenCalled();
    });

    it('proxies browser_snapshot', async () => {
      const page = mockPage();
      const adapter = new AgentBrowserAdapter(page as any, ['example.com'], { flags: LEGACY_FLAGS });

      const result = await adapter.proxyTool('browser_snapshot', {});

      expect(result).toHaveProperty('url');
      expect(result).toHaveProperty('title');
      expect(result).toHaveProperty('content');
    });
  });

  describe('multi-frame snapshots', () => {
    it('includes iframe content in annotated mode', async () => {
      const mainFrameMock = {
        waitForLoadState: vi.fn().mockResolvedValue(undefined),
        getByRole: vi.fn().mockReturnValue({
          click: vi.fn().mockResolvedValue(undefined),
          nth: vi.fn().mockReturnThis(),
          getByRole: vi.fn().mockReturnThis(),
        }),
        locator: vi.fn().mockReturnValue({ first: vi.fn().mockReturnThis() }),
      };

      const childFrameMock = {
        locator: vi.fn().mockReturnValue({
          ariaSnapshot: vi.fn().mockResolvedValue('- textbox "Email"'),
        }),
        getByRole: vi.fn().mockReturnValue({
          click: vi.fn().mockResolvedValue(undefined),
          nth: vi.fn().mockReturnThis(),
        }),
        parentFrame: vi.fn().mockReturnValue(mainFrameMock),
        childFrames: vi.fn().mockReturnValue([]),
        name: vi.fn().mockReturnValue('contact-form'),
        url: vi.fn().mockReturnValue('about:blank'),
      };

      (mainFrameMock as any).childFrames = vi.fn().mockReturnValue([childFrameMock]);
      (mainFrameMock as any).parentFrame = vi.fn().mockReturnValue(null);

      const page = mockPage({
        mainFrame: vi.fn().mockReturnValue(mainFrameMock),
        frames: vi.fn().mockReturnValue([mainFrameMock, childFrameMock]),
      });

      const annotatedFlags = { ...LEGACY_FLAGS, snapshotMode: 'annotated' as const };
      const adapter = new AgentBrowserAdapter(page as any, ['example.com'], { flags: annotatedFlags });

      const snap = await adapter.snapshot();

      expect(snap.content).toContain('button "Click me"');
      expect(snap.content).toContain('[frame: main>name:contact-form]');
      expect(snap.content).toContain('textbox "Email"');
      expect(snap.mode).toBe('annotated');
    });

    it('includes iframe content in full mode', async () => {
      const mainFrameMock = {
        waitForLoadState: vi.fn().mockResolvedValue(undefined),
      };

      const childFrameMock = {
        locator: vi.fn().mockReturnValue({
          ariaSnapshot: vi.fn().mockResolvedValue('- link "Help"'),
        }),
        parentFrame: vi.fn().mockReturnValue(mainFrameMock),
        childFrames: vi.fn().mockReturnValue([]),
        name: vi.fn().mockReturnValue('sidebar'),
        url: vi.fn().mockReturnValue('about:blank'),
      };

      (mainFrameMock as any).childFrames = vi.fn().mockReturnValue([childFrameMock]);
      (mainFrameMock as any).parentFrame = vi.fn().mockReturnValue(null);

      const page = mockPage({
        mainFrame: vi.fn().mockReturnValue(mainFrameMock),
        frames: vi.fn().mockReturnValue([mainFrameMock, childFrameMock]),
      });

      const adapter = new AgentBrowserAdapter(page as any, ['example.com'], { flags: LEGACY_FLAGS });

      const snap = await adapter.snapshot();

      expect(snap.content).toContain('heading "Example"');
      expect(snap.content).toContain('[frame: main>name:sidebar]');
      expect(snap.content).toContain('link "Help"');
    });

    it('handles iframe timeout gracefully', async () => {
      const mainFrameMock = {
        waitForLoadState: vi.fn().mockResolvedValue(undefined),
      };

      const slowFrameMock = {
        locator: vi.fn().mockReturnValue({
          ariaSnapshot: vi.fn().mockRejectedValue(new Error('Timeout 3000ms exceeded')),
        }),
        parentFrame: vi.fn().mockReturnValue(mainFrameMock),
        childFrames: vi.fn().mockReturnValue([]),
        name: vi.fn().mockReturnValue('slow-iframe'),
        url: vi.fn().mockReturnValue('about:blank'),
      };

      (mainFrameMock as any).childFrames = vi.fn().mockReturnValue([slowFrameMock]);
      (mainFrameMock as any).parentFrame = vi.fn().mockReturnValue(null);

      const page = mockPage({
        mainFrame: vi.fn().mockReturnValue(mainFrameMock),
        frames: vi.fn().mockReturnValue([mainFrameMock, slowFrameMock]),
      });

      const annotatedFlags = { ...LEGACY_FLAGS, snapshotMode: 'annotated' as const };
      const adapter = new AgentBrowserAdapter(page as any, ['example.com'], { flags: annotatedFlags });

      const snap = await adapter.snapshot();

      // Main frame content should still be present
      expect(snap.content).toContain('button "Click me"');
      // Failed iframe should show error placeholder
      expect(snap.content).toContain('[frame: main>name:slow-iframe]');
      expect(snap.content).toContain('timeout');
    });

    it('builds frame path with URL when name is empty', async () => {
      const mainFrameMock = {
        waitForLoadState: vi.fn().mockResolvedValue(undefined),
      };

      const childFrameMock = {
        locator: vi.fn().mockReturnValue({
          ariaSnapshot: vi.fn().mockResolvedValue('- button "Pay"'),
        }),
        parentFrame: vi.fn().mockReturnValue(mainFrameMock),
        childFrames: vi.fn().mockReturnValue([]),
        name: vi.fn().mockReturnValue(''),
        url: vi.fn().mockReturnValue('https://checkout.stripe.com/pay'),
      };

      (mainFrameMock as any).childFrames = vi.fn().mockReturnValue([childFrameMock]);
      (mainFrameMock as any).parentFrame = vi.fn().mockReturnValue(null);

      const page = mockPage({
        mainFrame: vi.fn().mockReturnValue(mainFrameMock),
        frames: vi.fn().mockReturnValue([mainFrameMock, childFrameMock]),
      });

      const annotatedFlags = { ...LEGACY_FLAGS, snapshotMode: 'annotated' as const };
      const adapter = new AgentBrowserAdapter(page as any, ['example.com'], { flags: annotatedFlags });

      const snap = await adapter.snapshot();

      expect(snap.content).toContain('[frame: main>url:checkout.stripe.com/pay]');
      expect(snap.content).toContain('button "Pay"');
    });

    it('uses sibling index when name and url are absent', async () => {
      const mainFrameMock = {
        waitForLoadState: vi.fn().mockResolvedValue(undefined),
      };

      const childFrameMock = {
        locator: vi.fn().mockReturnValue({
          ariaSnapshot: vi.fn().mockResolvedValue('- text "Ad"'),
        }),
        parentFrame: vi.fn().mockReturnValue(mainFrameMock),
        childFrames: vi.fn().mockReturnValue([]),
        name: vi.fn().mockReturnValue(''),
        url: vi.fn().mockReturnValue('about:blank'),
      };

      (mainFrameMock as any).childFrames = vi.fn().mockReturnValue([childFrameMock]);
      (mainFrameMock as any).parentFrame = vi.fn().mockReturnValue(null);

      const page = mockPage({
        mainFrame: vi.fn().mockReturnValue(mainFrameMock),
        frames: vi.fn().mockReturnValue([mainFrameMock, childFrameMock]),
      });

      const annotatedFlags = { ...LEGACY_FLAGS, snapshotMode: 'annotated' as const };
      const adapter = new AgentBrowserAdapter(page as any, ['example.com'], { flags: annotatedFlags });

      const snap = await adapter.snapshot();

      expect(snap.content).toContain('[frame: main>iframe[0]]');
    });
  });

  describe('console event degradation with patchright', () => {
    it('skips console listener when supportsConsoleEvents is false', () => {
      const page = mockPage();
      const adapter = new AgentBrowserAdapter(page as any, ['example.com'], {
        flags: LEGACY_FLAGS,
        capabilities: PATCHRIGHT_CAPABILITIES,
      });

      // page.on should NOT have been called with 'console' as first arg
      const onCalls = (page.on as ReturnType<typeof vi.fn>).mock.calls;
      const consoleCalls = onCalls.filter((c: any[]) => c[0] === 'console');
      expect(consoleCalls.length).toBe(0);
    });

    it('registers console listener when no capabilities provided', () => {
      const page = mockPage();
      const adapter = new AgentBrowserAdapter(page as any, ['example.com'], {
        flags: LEGACY_FLAGS,
      });

      const onCalls = (page.on as ReturnType<typeof vi.fn>).mock.calls;
      const consoleCalls = onCalls.filter((c: any[]) => c[0] === 'console');
      expect(consoleCalls.length).toBe(1);
    });

    it('adds console unavailable notice on first annotated snapshot', async () => {
      const page = mockPage();
      const annotatedFlags = { ...LEGACY_FLAGS, snapshotMode: 'annotated' as const };
      const adapter = new AgentBrowserAdapter(page as any, ['example.com'], {
        flags: annotatedFlags,
        capabilities: PATCHRIGHT_CAPABILITIES,
      });

      const snap1 = await adapter.snapshot();
      expect(snap1.content).toContain('[Note: console events unavailable');

      // Second snapshot should NOT contain the notice (one-shot)
      const snap2 = await adapter.snapshot();
      expect(snap2.content).not.toContain('[Note: console events unavailable');
    });

    it('does not add notice in full snapshot mode', async () => {
      const page = mockPage();
      const adapter = new AgentBrowserAdapter(page as any, ['example.com'], {
        flags: LEGACY_FLAGS, // LEGACY_FLAGS has snapshotMode: 'full'
        capabilities: PATCHRIGHT_CAPABILITIES,
      });

      const snap = await adapter.snapshot();
      expect(snap.content).not.toContain('[Note: console events unavailable');
    });
  });
});
