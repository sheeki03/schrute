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
    dataDir: '/tmp/oneagent-browser-test',
    logLevel: 'silent',
    payloadLimits: {
      harCaptureMaxBodyBytes: 50 * 1024 * 1024,
    },
  }),
  getBrowserDataDir: () => '/tmp/oneagent-browser-test/browser-data',
  getTmpDir: () => '/tmp/oneagent-browser-test/tmp',
}));

// ─── Mock Engine Factory ────────────────────────────────────────
const mockPage = {
  goto: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
};

const mockContext = {
  newPage: vi.fn().mockResolvedValue(mockPage),
  pages: vi.fn().mockReturnValue([mockPage]),
  close: vi.fn().mockResolvedValue(undefined),
  cookies: vi.fn().mockResolvedValue([]),
  storageState: vi.fn().mockResolvedValue({}),
};

const mockBrowser = {
  isConnected: vi.fn().mockReturnValue(true),
  newContext: vi.fn().mockResolvedValue(mockContext),
  close: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
};

const mockCapabilities = {
  supportsConsoleEvents: false,
  supportsCDP: true,
  configuredEngine: 'patchright' as const,
  effectiveEngine: 'patchright' as const,
};

vi.mock('../../src/browser/engine.js', () => ({
  launchBrowserEngine: vi.fn().mockImplementation(async () => ({
    browser: mockBrowser,
    capabilities: mockCapabilities,
  })),
}));

// Mock fs for storage paths
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

import { BrowserManager } from '../../src/browser/manager.js';
import { launchBrowserEngine } from '../../src/browser/engine.js';
import type { OneAgentConfig } from '../../src/skill/types.js';

function makeConfig(): OneAgentConfig {
  return {
    dataDir: '/tmp/oneagent-browser-test',
    logLevel: 'silent',
    payloadLimits: {
      harCaptureMaxBodyBytes: 50 * 1024 * 1024,
    },
    daemon: { port: 19420, autoStart: false },
  } as unknown as OneAgentConfig;
}

describe('BrowserManager', () => {
  let manager: BrowserManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new BrowserManager(makeConfig());
  });

  describe('launch idempotency', () => {
    it('launches browser on first call', async () => {
      const browser = await manager.launchBrowser();
      expect(browser).toBeDefined();
      expect(launchBrowserEngine).toHaveBeenCalledTimes(1);
    });

    it('returns same browser on second call (idempotent)', async () => {
      const browser1 = await manager.launchBrowser();
      const browser2 = await manager.launchBrowser();
      expect(browser1).toBe(browser2);
      expect(launchBrowserEngine).toHaveBeenCalledTimes(1);
    });

    it('relaunches browser after disconnect', async () => {
      const browser1 = await manager.launchBrowser();

      // Simulate disconnect by making isConnected return false
      (browser1 as any).isConnected.mockReturnValue(false);

      await manager.launchBrowser();
      // Should have launched again (second call to launchBrowserEngine)
      expect(launchBrowserEngine).toHaveBeenCalledTimes(2);
    });
  });

  describe('context management', () => {
    it('creates context for a site', async () => {
      const ctx = await manager.getOrCreateContext('example.com');
      expect(ctx).toBeDefined();
    });

    it('reuses context for same site (idempotent)', async () => {
      const ctx1 = await manager.getOrCreateContext('example.com');
      const ctx2 = await manager.getOrCreateContext('example.com');
      expect(ctx1).toBe(ctx2);
    });

    it('hasContext returns false for unknown site', () => {
      expect(manager.hasContext('unknown.com')).toBe(false);
    });

    it('hasContext returns true after context creation', async () => {
      await manager.getOrCreateContext('example.com');
      expect(manager.hasContext('example.com')).toBe(true);
    });
  });

  describe('context closing', () => {
    it('closes context for a specific site', async () => {
      await manager.getOrCreateContext('example.com');
      await manager.closeContext('example.com');
      expect(manager.hasContext('example.com')).toBe(false);
    });

    it('does not throw when closing non-existent context', async () => {
      // Should not throw
      await manager.closeContext('nonexistent.com');
    });
  });

  describe('browser cleanup', () => {
    it('closes browser and clears all contexts via closeAll()', async () => {
      await manager.getOrCreateContext('example.com');
      await manager.closeAll();
      expect(manager.hasContext('example.com')).toBe(false);
    });
  });

  describe('engine selection', () => {
    it('resolves engine from config', async () => {
      const config = {
        ...makeConfig(),
        browser: { engine: 'camoufox' as const },
      };
      const mgr = new BrowserManager(config as unknown as OneAgentConfig);
      await mgr.launchBrowser();
      expect(launchBrowserEngine).toHaveBeenCalledWith('camoufox', { headless: true });
    });

    it('defaults to patchright when no engine configured', async () => {
      const mgr = new BrowserManager(makeConfig());
      await mgr.launchBrowser();
      expect(launchBrowserEngine).toHaveBeenCalledWith('patchright', { headless: true });
    });
  });

  describe('capabilities', () => {
    it('returns null before launch', () => {
      const mgr = new BrowserManager(makeConfig());
      expect(mgr.getCapabilities()).toBeNull();
    });

    it('returns capabilities after launch', async () => {
      const mgr = new BrowserManager(makeConfig());
      await mgr.launchBrowser();
      const caps = mgr.getCapabilities();
      expect(caps).toEqual(mockCapabilities);
    });
  });
});
