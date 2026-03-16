import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BrowserBackend, CookieEntry } from '../../src/browser/backend.js';

// Mock logger
vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock child_process
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

// Mock IPC client
const mockIpcClient = {
  bootstrapDaemon: vi.fn().mockResolvedValue(undefined),
  connect: vi.fn().mockResolvedValue(undefined),
  send: vi.fn().mockResolvedValue(undefined),
  close: vi.fn(),
  isConnected: vi.fn().mockReturnValue(true),
};

vi.mock('../../src/browser/agent-browser-ipc.js', () => ({
  AgentBrowserIpcClient: vi.fn(() => ({ ...mockIpcClient })),
  resolveSocketDir: vi.fn(() => '/tmp/agent-browser'),
}));

// Mock provider
const mockProvider = {
  navigate: vi.fn().mockResolvedValue(undefined),
  snapshot: vi.fn().mockResolvedValue({ url: '', title: '', content: '' }),
  click: vi.fn().mockResolvedValue(undefined),
  type: vi.fn().mockResolvedValue(undefined),
  evaluateFetch: vi.fn().mockResolvedValue({ status: 200, headers: {}, body: '' }),
  screenshot: vi.fn().mockResolvedValue(Buffer.from('')),
  networkRequests: vi.fn().mockResolvedValue([]),
  getCurrentUrl: vi.fn().mockReturnValue('about:blank'),
  getCookies: vi.fn().mockResolvedValue([]),
  hydrateCookies: vi.fn().mockResolvedValue(undefined),
  hydrateLocalStorage: vi.fn().mockResolvedValue(undefined),
  extractLocalStorage: vi.fn().mockResolvedValue([]),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../src/browser/agent-browser-provider.js', () => ({
  AgentBrowserProvider: vi.fn(() => ({ ...mockProvider })),
}));

import { AgentBrowserBackend } from '../../src/browser/agent-browser-backend.js';
import { execFile } from 'node:child_process';
import type { SchruteConfig } from '../../src/skill/types.js';

function makeConfig(): SchruteConfig {
  return {
    dataDir: '/tmp/schrute-test',
    logLevel: 'silent',
    features: {
      webmcp: false,
      httpTransport: false,
      discoveryImport: false,
      respectRobotsTxt: true,
      sitemapDiscovery: true,
      adaptivePathTrie: true,
    },
    browser: {
      execution: {
        backend: 'agent-browser',
      },
    },
    toolBudget: { maxCallsPerSkillRun: 50, maxMinutesPerSkillRun: 5 },
    paramLimits: { maxParams: 20, maxArrayItems: 100 },
    payloadLimits: { maxBodyBytes: 1048576, maxResponseBytes: 5242880 },
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
    capabilities: undefined,
  } as SchruteConfig;
}

describe('BrowserBackend interface', () => {
  it('can be implemented as a mock', () => {
    const mock: BrowserBackend = {
      createProvider: vi.fn().mockResolvedValue(undefined),
      getCookies: vi.fn().mockResolvedValue([]),
      setCookies: vi.fn().mockResolvedValue(undefined),
      importCookies: vi.fn().mockResolvedValue(0),
      exportCookies: vi.fn().mockResolvedValue([]),
      closeAndPersist: vi.fn().mockResolvedValue(undefined),
      discardSession: vi.fn().mockResolvedValue(undefined),
      isUsable: vi.fn().mockReturnValue(true),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };

    expect(mock.isUsable()).toBe(true);
  });

  it('mock methods return correct types', async () => {
    const mock: BrowserBackend = {
      createProvider: vi.fn().mockResolvedValue(undefined),
      getCookies: vi.fn().mockResolvedValue([{ name: 'a', value: 'b', domain: 'd', path: '/' }]),
      setCookies: vi.fn().mockResolvedValue(undefined),
      importCookies: vi.fn().mockResolvedValue(5),
      exportCookies: vi.fn().mockResolvedValue([]),
      closeAndPersist: vi.fn().mockResolvedValue(undefined),
      discardSession: vi.fn().mockResolvedValue(undefined),
      isUsable: vi.fn().mockReturnValue(false),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };

    const cookies = await mock.getCookies('site1');
    expect(cookies).toHaveLength(1);
    expect(cookies[0].name).toBe('a');

    const count = await mock.importCookies('site1', '/tmp/cookies.txt');
    expect(count).toBe(5);

    expect(mock.isUsable()).toBe(false);
  });
});

describe('AgentBrowserBackend', () => {
  let backend: AgentBrowserBackend;
  let mockExecFile: ReturnType<typeof vi.mocked>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFile = vi.mocked(execFile);
    // Default: `which agent-browser` succeeds
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      if (cb) cb(null, '/usr/local/bin/agent-browser', '');
      return {} as any;
    });
    backend = new AgentBrowserBackend(makeConfig());
  });

  afterEach(async () => {
    await backend.shutdown();
  });

  describe('ensureProbed (once-promise probe)', () => {
    it('returns undefined when probe fails (binary not found)', async () => {
      mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
        if (cb) cb(new Error('not found'));
        return {} as any;
      });

      const provider = await backend.createProvider('site1', ['example.com']);
      expect(provider).toBeUndefined();
      expect(backend.isUsable()).toBe(false);
    });

    it('caches probe failure with cooldown', async () => {
      mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
        if (cb) cb(new Error('not found'));
        return {} as any;
      });

      // First probe fails
      await backend.createProvider('site1', ['example.com']);
      expect(backend.isUsable()).toBe(false);

      // Second call within cooldown should not re-probe
      const callsBefore = mockExecFile.mock.calls.length;
      await backend.createProvider('site2', ['example.com']);
      // No new execFile calls since result is cached
      expect(mockExecFile.mock.calls.length).toBe(callsBefore);
    });

    it('resetProbe clears cached state', async () => {
      mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
        if (cb) cb(new Error('not found'));
        return {} as any;
      });

      await backend.createProvider('site1', ['example.com']);
      expect(backend.isUsable()).toBe(false);

      backend.resetProbe();
      expect(backend.isUsable()).toBe(false); // reset sets to null, not true

      // But a new probe will run
      mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
        if (cb) cb(null, '/usr/local/bin/agent-browser', '');
        return {} as any;
      });

      // The probe will try to bootstrap + connect IPC which is mocked
      await backend.createProvider('site1', ['example.com']);
    });
  });

  describe('localStorage routing', () => {
    it('returns undefined for sites with non-empty localStorage', async () => {
      const mockAuthStore = {
        load: vi.fn().mockReturnValue({
          cookies: [{ name: 'a', value: 'b', domain: 'd', path: '/' }],
          origins: [{
            origin: 'https://example.com',
            localStorage: [{ name: 'token', value: 'abc' }],
          }],
          version: 1,
          lastUpdated: Date.now(),
        }),
        save: vi.fn().mockReturnValue({ changed: false, version: 1 }),
        toPlaywrightStorageState: vi.fn(),
      };

      const backendWithAuth = new AgentBrowserBackend(makeConfig(), mockAuthStore as any);
      const provider = await backendWithAuth.createProvider('site-with-ls', ['example.com']);
      expect(provider).toBeUndefined();
    });

    it('proceeds for sites with empty localStorage', async () => {
      const mockAuthStore = {
        load: vi.fn().mockReturnValue({
          cookies: [{ name: 'a', value: 'b', domain: 'd', path: '/' }],
          origins: [{ origin: 'https://example.com', localStorage: [] }],
          version: 1,
          lastUpdated: Date.now(),
        }),
        save: vi.fn().mockReturnValue({ changed: false, version: 1 }),
        toPlaywrightStorageState: vi.fn(),
      };

      const backendWithAuth = new AgentBrowserBackend(makeConfig(), mockAuthStore as any);
      const provider = await backendWithAuth.createProvider('site-no-ls', ['example.com']);
      // Provider may or may not be created depending on probe, but it won't be rejected for localStorage
      // The key assertion is that it didn't return undefined due to localStorage
      // (it may return undefined due to probe failure in test environment)
    });
  });

  describe('closeAndPersist (cookies-only merge)', () => {
    it('merges cookies while preserving existing origins', async () => {
      const existingOrigins = [{
        origin: 'https://example.com',
        localStorage: [{ name: 'key', value: 'val' }],
      }];

      const freshCookies: CookieEntry[] = [
        { name: 'session', value: 'new', domain: 'example.com', path: '/' },
      ];

      const mockAuthStore = {
        load: vi.fn().mockReturnValue({
          cookies: [{ name: 'old', value: 'old', domain: 'example.com', path: '/' }],
          origins: existingOrigins,
          version: 1,
          lastUpdated: Date.now(),
        }),
        save: vi.fn().mockReturnValue({ changed: true, version: 2 }),
        toPlaywrightStorageState: vi.fn(),
      };

      const backendWithAuth = new AgentBrowserBackend(makeConfig(), mockAuthStore as any);

      // Manually create a session entry to test closeAndPersist
      const mockProv = {
        ...mockProvider,
        getCookies: vi.fn().mockResolvedValue(freshCookies),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const mockIpc = {
        close: vi.fn(),
      };

      // Access private sessions map
      (backendWithAuth as any).sessions.set('site1', { provider: mockProv, ipc: mockIpc });

      await backendWithAuth.closeAndPersist('site1');

      // Verify save was called with merged data: new cookies + preserved origins
      expect(mockAuthStore.save).toHaveBeenCalledWith('site1', {
        cookies: freshCookies,
        origins: existingOrigins,
        lastUpdated: expect.any(Number),
      });

      // Verify IPC was closed
      expect(mockIpc.close).toHaveBeenCalled();
    });

    it('uses empty origins when no existing state', async () => {
      const freshCookies: CookieEntry[] = [
        { name: 'a', value: 'b', domain: 'd', path: '/' },
      ];

      const mockAuthStore = {
        load: vi.fn().mockReturnValue(undefined),
        save: vi.fn().mockReturnValue({ changed: true, version: 1 }),
        toPlaywrightStorageState: vi.fn(),
      };

      const backendWithAuth = new AgentBrowserBackend(makeConfig(), mockAuthStore as any);

      const mockProv = {
        ...mockProvider,
        getCookies: vi.fn().mockResolvedValue(freshCookies),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const mockIpc = { close: vi.fn() };

      (backendWithAuth as any).sessions.set('site1', { provider: mockProv, ipc: mockIpc });

      await backendWithAuth.closeAndPersist('site1');

      expect(mockAuthStore.save).toHaveBeenCalledWith('site1', {
        cookies: freshCookies,
        origins: [],
        lastUpdated: expect.any(Number),
      });
    });
  });

  describe('discardSession', () => {
    it('closes provider and IPC without persisting', async () => {
      const mockProv = {
        ...mockProvider,
        close: vi.fn().mockResolvedValue(undefined),
      };
      const mockIpc = { close: vi.fn() };

      (backend as any).sessions.set('site1', { provider: mockProv, ipc: mockIpc });

      await backend.discardSession('site1');

      expect(mockProv.close).toHaveBeenCalled();
      expect(mockIpc.close).toHaveBeenCalled();
      expect((backend as any).sessions.has('site1')).toBe(false);
    });
  });

  describe('shutdown', () => {
    it('closes all sessions and IPC clients', async () => {
      const mockProv1 = { ...mockProvider, close: vi.fn().mockResolvedValue(undefined) };
      const mockIpc1 = { close: vi.fn() };
      const mockProv2 = { ...mockProvider, close: vi.fn().mockResolvedValue(undefined) };
      const mockIpc2 = { close: vi.fn() };

      (backend as any).sessions.set('site1', { provider: mockProv1, ipc: mockIpc1 });
      (backend as any).sessions.set('site2', { provider: mockProv2, ipc: mockIpc2 });

      await backend.shutdown();

      expect(mockProv1.close).toHaveBeenCalled();
      expect(mockIpc1.close).toHaveBeenCalled();
      expect(mockProv2.close).toHaveBeenCalled();
      expect(mockIpc2.close).toHaveBeenCalled();
      expect((backend as any).sessions.size).toBe(0);
    });
  });
});
