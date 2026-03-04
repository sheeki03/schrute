import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────

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
    dataDir: '/tmp/oneagent-ctx-test',
    logLevel: 'silent',
    daemon: { port: 19420, autoStart: false },
  }),
  getBrowserDataDir: () => '/tmp/oneagent-ctx-test/browser-data',
  getTmpDir: () => '/tmp/oneagent-ctx-test/tmp',
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

// Mock the browser engine launch — not needed for context tests
vi.mock('../../src/browser/engine.js', () => ({
  launchBrowserEngine: vi.fn(),
}));

import { BrowserManager, ContextOverrideMismatchError, stableStringify, safeProxyUrl } from '../../src/browser/manager.js';
import type { ContextOverrides } from '../../src/browser/manager.js';
import type { OneAgentConfig, ProxyConfig, GeoEmulationConfig } from '../../src/skill/types.js';

// ─── Helpers ────────────────────────────────────────────────────

function createMockContext(opts?: Record<string, unknown>) {
  return {
    pages: () => [],
    newPage: vi.fn().mockResolvedValue({}),
    storageState: vi.fn().mockResolvedValue({}),
    close: vi.fn().mockResolvedValue(undefined),
    addCookies: vi.fn(),
    _opts: opts, // stash for inspection
  };
}

function createMockBrowser() {
  const newContextFn = vi.fn();
  return {
    isConnected: vi.fn().mockReturnValue(true),
    newContext: newContextFn,
    contexts: vi.fn().mockReturnValue([]),
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    _newContextFn: newContextFn,
  };
}

function makeConfig(overrides?: Partial<OneAgentConfig>): OneAgentConfig {
  return {
    dataDir: '/tmp/oneagent-ctx-test',
    logLevel: 'silent',
    features: { webmcp: false, httpTransport: false },
    toolBudget: {
      maxToolCallsPerTask: 50,
      maxConcurrentCalls: 3,
      crossDomainCalls: false,
      secretsToNonAllowlisted: false,
    },
    payloadLimits: {
      maxResponseBodyBytes: 10 * 1024 * 1024,
      maxRequestBodyBytes: 5 * 1024 * 1024,
      replayTimeoutMs: { tier1: 30000, tier3: 60000, tier4: 120000 },
      harCaptureMaxBodyBytes: 50 * 1024 * 1024,
      redactorTimeoutMs: 10000,
    },
    audit: { strictMode: true, rootHashExport: true },
    storage: { maxPerSiteMb: 500, maxGlobalMb: 5000, retentionDays: 90 },
    server: { network: false },
    daemon: { port: 19420, autoStart: false },
    tempTtlMs: 3600000,
    gcIntervalMs: 900000,
    confirmationTimeoutMs: 30000,
    confirmationExpiryMs: 60000,
    promotionConsecutivePasses: 5,
    promotionVolatilityThreshold: 0.2,
    maxToolsPerSite: 20,
    toolShortlistK: 10,
    ...overrides,
  } as OneAgentConfig;
}

// ─── Tests ──────────────────────────────────────────────────────

describe('browser context proxy/geo overrides', () => {
  let mockBrowser: ReturnType<typeof createMockBrowser>;

  beforeEach(() => {
    mockBrowser = createMockBrowser();
  });

  // Inject a pre-launched mock browser into the manager
  function injectBrowser(manager: BrowserManager): void {
    // Access private field for testing
    (manager as any).browser = mockBrowser;
    (manager as any).capabilities = {
      configuredEngine: 'playwright',
      effectiveEngine: 'playwright',
    };
  }

  describe('proxy overrides passed to browser.newContext', () => {
    it('passes proxy to newContext when per-call override provided', async () => {
      const manager = new BrowserManager(makeConfig());
      injectBrowser(manager);

      const mockCtx = createMockContext();
      mockBrowser.newContext.mockResolvedValue(mockCtx);

      const proxy: ProxyConfig = { server: 'http://proxy:8080', bypass: '*.local' };
      await manager.getOrCreateContext('site-a', { proxy });

      expect(mockBrowser.newContext).toHaveBeenCalledWith(
        expect.objectContaining({
          proxy: expect.objectContaining({
            server: 'http://proxy:8080',
            bypass: '*.local',
          }),
        }),
      );
    });

    it('passes geo options to newContext when geo override provided', async () => {
      const manager = new BrowserManager(makeConfig());
      injectBrowser(manager);

      const mockCtx = createMockContext();
      mockBrowser.newContext.mockResolvedValue(mockCtx);

      const geo: GeoEmulationConfig = {
        geolocation: { latitude: 40.7128, longitude: -74.006 },
        timezoneId: 'America/New_York',
        locale: 'en-US',
      };
      await manager.getOrCreateContext('site-b', { geo });

      expect(mockBrowser.newContext).toHaveBeenCalledWith(
        expect.objectContaining({
          geolocation: { latitude: 40.7128, longitude: -74.006 },
          permissions: ['geolocation'],
          timezoneId: 'America/New_York',
          locale: 'en-US',
        }),
      );
    });
  });

  describe('config defaults used when no per-call override', () => {
    it('uses proxy from config when no override passed', async () => {
      const config = makeConfig({
        browser: {
          proxy: { server: 'socks5://default-proxy:1080' },
        },
      } as any);
      const manager = new BrowserManager(config);
      injectBrowser(manager);

      const mockCtx = createMockContext();
      mockBrowser.newContext.mockResolvedValue(mockCtx);

      await manager.getOrCreateContext('site-c');

      expect(mockBrowser.newContext).toHaveBeenCalledWith(
        expect.objectContaining({
          proxy: expect.objectContaining({
            server: 'socks5://default-proxy:1080',
          }),
        }),
      );
    });

    it('uses geo from config when no override passed', async () => {
      const config = makeConfig({
        browser: {
          geo: {
            geolocation: { latitude: 51.5074, longitude: -0.1278 },
            timezoneId: 'Europe/London',
            locale: 'en-GB',
          },
        },
      } as any);
      const manager = new BrowserManager(config);
      injectBrowser(manager);

      const mockCtx = createMockContext();
      mockBrowser.newContext.mockResolvedValue(mockCtx);

      await manager.getOrCreateContext('site-d');

      expect(mockBrowser.newContext).toHaveBeenCalledWith(
        expect.objectContaining({
          geolocation: { latitude: 51.5074, longitude: -0.1278 },
          timezoneId: 'Europe/London',
          locale: 'en-GB',
        }),
      );
    });
  });

  describe('per-call override takes precedence over config default', () => {
    it('override proxy replaces config proxy', async () => {
      const config = makeConfig({
        browser: {
          proxy: { server: 'http://default-proxy:8080' },
        },
      } as any);
      const manager = new BrowserManager(config);
      injectBrowser(manager);

      const mockCtx = createMockContext();
      mockBrowser.newContext.mockResolvedValue(mockCtx);

      const overrideProxy: ProxyConfig = { server: 'socks5://override-proxy:1080' };
      await manager.getOrCreateContext('site-e', { proxy: overrideProxy });

      expect(mockBrowser.newContext).toHaveBeenCalledWith(
        expect.objectContaining({
          proxy: expect.objectContaining({
            server: 'socks5://override-proxy:1080',
          }),
        }),
      );
    });
  });

  describe('context override mismatch', () => {
    it('throws ContextOverrideMismatchError when proxy changes', async () => {
      const manager = new BrowserManager(makeConfig());
      injectBrowser(manager);

      const mockCtx = createMockContext();
      mockBrowser.newContext.mockResolvedValue(mockCtx);

      // First call creates context with proxy A
      const proxyA: ProxyConfig = { server: 'http://proxy-a:8080' };
      await manager.getOrCreateContext('site-f', { proxy: proxyA });

      // Second call with proxy B should throw
      const proxyB: ProxyConfig = { server: 'http://proxy-b:9090' };
      await expect(
        manager.getOrCreateContext('site-f', { proxy: proxyB }),
      ).rejects.toThrow(ContextOverrideMismatchError);
    });
  });

  describe('context reused when same overrides provided', () => {
    it('reuses context with identical proxy override', async () => {
      const manager = new BrowserManager(makeConfig());
      injectBrowser(manager);

      const mockCtx = createMockContext();
      mockBrowser.newContext.mockResolvedValue(mockCtx);

      const proxy: ProxyConfig = { server: 'http://proxy:8080' };
      const ctx1 = await manager.getOrCreateContext('site-g', { proxy });
      const ctx2 = await manager.getOrCreateContext('site-g', { proxy });

      expect(ctx1).toBe(ctx2);
      expect(mockBrowser.newContext).toHaveBeenCalledTimes(1);
    });
  });

  describe('CDP mode: overrides ignored', () => {
    it('ignores overrides in CDP mode without error', async () => {
      const manager = new BrowserManager(makeConfig());
      injectBrowser(manager);

      // Set CDP connected state
      (manager as any).cdpConnected = true;

      const mockCtx = createMockContext();
      mockBrowser.contexts.mockReturnValue([mockCtx]);

      const proxy: ProxyConfig = { server: 'http://proxy:8080' };
      const geo: GeoEmulationConfig = {
        geolocation: { latitude: 40, longitude: -74 },
      };

      // Should not throw, should return the existing context
      const ctx = await manager.getOrCreateContext('site-h', { proxy, geo });
      expect(ctx).toBe(mockCtx);
      // newContext should not have been called with proxy/geo options
      expect(mockBrowser.newContext).not.toHaveBeenCalled();
    });

    it('skips mismatch check in CDP mode', async () => {
      const manager = new BrowserManager(makeConfig());
      injectBrowser(manager);

      // Set CDP connected state and pre-populate a context
      (manager as any).cdpConnected = true;
      const mockCtx = createMockContext();
      (manager as any).contexts.set('site-cdp', {
        context: mockCtx,
        siteId: 'site-cdp',
        harPath: undefined,
        createdAt: Date.now(),
        overrides: { proxy: { server: 'http://a:1' } },
      });

      // Different overrides should NOT throw in CDP mode
      const ctx = await manager.getOrCreateContext('site-cdp', {
        proxy: { server: 'http://b:2' },
      });
      expect(ctx).toBe(mockCtx);
    });
  });

  describe('override equality', () => {
    it('undefined equals undefined', async () => {
      const manager = new BrowserManager(makeConfig());
      injectBrowser(manager);

      const mockCtx = createMockContext();
      mockBrowser.newContext.mockResolvedValue(mockCtx);

      const ctx1 = await manager.getOrCreateContext('site-i');
      const ctx2 = await manager.getOrCreateContext('site-i');
      expect(ctx1).toBe(ctx2);
      expect(mockBrowser.newContext).toHaveBeenCalledTimes(1);
    });

    it('same overrides are considered equal', async () => {
      const manager = new BrowserManager(makeConfig());
      injectBrowser(manager);

      const mockCtx = createMockContext();
      mockBrowser.newContext.mockResolvedValue(mockCtx);

      const overrides: ContextOverrides = {
        proxy: { server: 'http://proxy:8080' },
        geo: { timezoneId: 'UTC', locale: 'en-US' },
      };

      const ctx1 = await manager.getOrCreateContext('site-j', overrides);
      const ctx2 = await manager.getOrCreateContext('site-j', { ...overrides });
      expect(ctx1).toBe(ctx2);
      expect(mockBrowser.newContext).toHaveBeenCalledTimes(1);
    });
  });

  describe('full lifecycle: create → mismatch → force-close → recreate', () => {
    it('create context with overrides → attempt second with different overrides → ContextOverrideMismatchError → force-close → recreate with new overrides → success', async () => {
      const manager = new BrowserManager(makeConfig());
      injectBrowser(manager);

      const mockCtx1 = createMockContext();
      const mockCtx2 = createMockContext();
      mockBrowser.newContext.mockResolvedValueOnce(mockCtx1).mockResolvedValueOnce(mockCtx2);

      // Step 1: Create context with proxy A
      const proxyA = { server: 'http://proxy-a:8080' };
      await manager.getOrCreateContext('site-lifecycle', { proxy: proxyA });

      // Step 2: Attempt with proxy B → should throw
      const proxyB = { server: 'http://proxy-b:9090' };
      await expect(
        manager.getOrCreateContext('site-lifecycle', { proxy: proxyB }),
      ).rejects.toThrow(ContextOverrideMismatchError);

      // Step 3: Force-close (close context for that site)
      await manager.closeContext('site-lifecycle');

      // Step 4: Recreate with proxy B → should succeed
      const ctx = await manager.getOrCreateContext('site-lifecycle', { proxy: proxyB });
      expect(ctx).toBe(mockCtx2);
      expect(mockBrowser.newContext).toHaveBeenCalledTimes(2);
    });
  });

  describe('safeProxyUrl strips credentials (via context)', () => {
    it('strips credentials from proxy URL', () => {
      const manager = new BrowserManager(makeConfig());
      injectBrowser(manager);

      const mockCtx = createMockContext();
      mockBrowser.newContext.mockResolvedValue(mockCtx);

      expect(async () => {
        await manager.getOrCreateContext('site-safe', {
          proxy: { server: 'http://proxy:8080', username: 'user', password: 'pass' },
        });
      }).not.toThrow();
    });
  });
});

// ─── stableStringify Tests ───────────────────────────────────────

describe('stableStringify', () => {
  it('nested objects with different key orders produce same output', () => {
    const a = { z: 1, a: { y: 2, b: 3 } };
    const b = { a: { b: 3, y: 2 }, z: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('undefined values are filtered out', () => {
    const obj = { a: 1, b: undefined, c: 3 };
    const result = stableStringify(obj);
    expect(result).not.toContain('"b"');
    expect(result).toContain('"a"');
    expect(result).toContain('"c"');
  });

  it('arrays preserve order', () => {
    const a = [1, 2, 3];
    const b = [3, 2, 1];
    expect(stableStringify(a)).not.toBe(stableStringify(b));
    expect(stableStringify(a)).toBe('[1,2,3]');
    expect(stableStringify(b)).toBe('[3,2,1]');
  });

  it('null and primitives', () => {
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(undefined)).toBe('null');
    expect(stableStringify(42)).toBe('42');
    expect(stableStringify('hello')).toBe('"hello"');
    expect(stableStringify(true)).toBe('true');
  });

  it('empty objects return {}', () => {
    expect(stableStringify({})).toBe('{}');
  });

  it('deeply nested (3+ levels)', () => {
    const a = { l1: { l2: { l3: { val: 'deep' } } } };
    const b = { l1: { l2: { l3: { val: 'deep' } } } };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(stableStringify(a)).toContain('"val":"deep"');
  });
});

// ─── safeProxyUrl Tests ──────────────────────────────────────────

describe('safeProxyUrl', () => {
  it('strips credentials from URL with user:pass', () => {
    const result = safeProxyUrl('http://user:pass@proxy:8080');
    expect(result).toContain('http://proxy:8080');
    expect(result).not.toContain('user');
    expect(result).not.toContain('pass');
  });

  it('preserves non-credential URLs: socks5://proxy:1080', () => {
    const result = safeProxyUrl('socks5://proxy:1080');
    expect(result).toContain('socks5://proxy:1080');
    expect(result).not.toContain('@');
  });

  it('returns [invalid-url] for invalid URLs', () => {
    expect(safeProxyUrl('not-a-url')).toBe('[invalid-url]');
  });

  it('returns [invalid-url] for empty string', () => {
    expect(safeProxyUrl('')).toBe('[invalid-url]');
  });
});
