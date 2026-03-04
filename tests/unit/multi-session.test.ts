import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Browser, BrowserContext } from 'playwright';

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
    dataDir: '/tmp/oneagent-ms-test',
    browser: {},
    daemon: { port: 19420, autoStart: false },
  }),
  getBrowserDataDir: () => '/tmp/oneagent-ms-test/browser-data',
  getTmpDir: () => '/tmp/oneagent-ms-test/tmp',
}));

vi.mock('../../src/browser/engine.js', () => ({
  launchBrowserEngine: vi.fn(),
}));

vi.mock('../../src/browser/cdp-connector.js', () => ({
  connectViaCDP: vi.fn(),
}));

vi.mock('node:fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    realpathSync: vi.fn((p: string) => p),
    statSync: vi.fn().mockReturnValue({ isFile: () => true }),
  },
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  realpathSync: vi.fn((p: string) => p),
  statSync: vi.fn().mockReturnValue({ isFile: () => true }),
}));

import { MultiSessionManager } from '../../src/browser/multi-session.js';
import { BrowserManager } from '../../src/browser/manager.js';
import { connectViaCDP } from '../../src/browser/cdp-connector.js';

// ─── Helpers ────────────────────────────────────────────────────────

function createMockBrowser(): Browser {
  return {
    isConnected: vi.fn().mockReturnValue(true),
    newContext: vi.fn().mockResolvedValue(createMockContext()),
    contexts: vi.fn().mockReturnValue([createMockContext()]),
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  } as unknown as Browser;
}

function createMockContext(): BrowserContext {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    storageState: vi.fn().mockResolvedValue({}),
    pages: vi.fn().mockReturnValue([]),
    newPage: vi.fn().mockResolvedValue({}),
    addCookies: vi.fn().mockResolvedValue(undefined),
  } as unknown as BrowserContext;
}

function createDefaultManager(): BrowserManager {
  return new BrowserManager({
    dataDir: '/tmp/oneagent-ms-test',
    daemon: { port: 19420, autoStart: false },
  } as any);
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('MultiSessionManager', () => {
  let defaultManager: BrowserManager;
  let msm: MultiSessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    defaultManager = createDefaultManager();
    msm = new MultiSessionManager(defaultManager);
  });

  // ─── Session CRUD ─────────────────────────────────────────────

  describe('session management', () => {
    it('default session always exists', () => {
      const session = msm.get('default');
      expect(session).toBeDefined();
      expect(session!.name).toBe('default');
      expect(session!.isCdp).toBe(false);
    });

    it('getOrCreate returns existing session', () => {
      const s1 = msm.getOrCreate('default');
      const s2 = msm.getOrCreate('default');
      expect(s1).toBe(s2);
    });

    it('getOrCreate creates new session for unknown name', () => {
      const session = msm.getOrCreate('custom');
      expect(session.name).toBe('custom');
      expect(session.isCdp).toBe(false);
    });

    it('list returns all sessions', () => {
      msm.getOrCreate('session-a');
      msm.getOrCreate('session-b');

      const list = msm.list();
      const names = list.map(s => s.name);
      expect(names).toContain('default');
      expect(names).toContain('session-a');
      expect(names).toContain('session-b');
    });

    it('close non-default session removes it', async () => {
      msm.getOrCreate('temp');
      expect(msm.get('temp')).toBeDefined();

      await msm.close('temp');
      expect(msm.get('temp')).toBeUndefined();
    });

    it('close default session is soft-close (keeps entry)', async () => {
      const defaultSession = msm.get('default')!;
      defaultSession.siteId = 'example.com';

      await msm.close('default', { engineMode: 'idle' });

      // Session entry still exists with siteId intact
      const session = msm.get('default');
      expect(session).toBeDefined();
      expect(session!.siteId).toBe('example.com');
    });

    it('close default blocked during recording', async () => {
      await expect(
        msm.close('default', { engineMode: 'recording' }),
      ).rejects.toThrow(/Cannot close default session while exploring/);
    });

    it('close default blocked during exploring', async () => {
      await expect(
        msm.close('default', { engineMode: 'exploring' }),
      ).rejects.toThrow(/Cannot close default session while exploring/);
    });

    it('closeAll closes all sessions', async () => {
      msm.getOrCreate('s1');
      msm.getOrCreate('s2');

      await msm.closeAll();

      // Non-default sessions should be removed (default stays as entry)
      expect(msm.get('s1')).toBeUndefined();
      expect(msm.get('s2')).toBeUndefined();
      expect(msm.get('default')).toBeDefined();
    });
  });

  // ─── Active Session Routing ───────────────────────────────────

  describe('active session', () => {
    it('defaults to "default"', () => {
      expect(msm.getActive()).toBe('default');
    });

    it('setActive changes active session', () => {
      msm.getOrCreate('other');
      msm.setActive('other');
      expect(msm.getActive()).toBe('other');
    });

    it('setActive throws for non-existent session', () => {
      expect(() => msm.setActive('ghost')).toThrow(/does not exist/);
    });

    it('closing active session auto-fallbacks to default', async () => {
      msm.getOrCreate('temp');
      msm.setActive('temp');
      expect(msm.getActive()).toBe('temp');

      await msm.close('temp');
      expect(msm.getActive()).toBe('default');
    });
  });

  // ─── CDP Sessions ─────────────────────────────────────────────

  describe('CDP sessions', () => {
    it('connectCDP creates CDP session', async () => {
      const mockBrowser = createMockBrowser();
      (connectViaCDP as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser);

      const session = await msm.connectCDP('electron', { port: 9222 }, 'cdp-electron');

      expect(session.name).toBe('electron');
      expect(session.siteId).toBe('cdp-electron');
      expect(session.isCdp).toBe(true);
    });

    it('connectCDP("default") is always rejected', async () => {
      await expect(
        msm.connectCDP('default', { port: 9222 }, 'any-site'),
      ).rejects.toThrow(/Cannot use "default" for CDP sessions/);
    });

    it('connectCDP rejects duplicate name', async () => {
      const mockBrowser = createMockBrowser();
      (connectViaCDP as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser);

      await msm.connectCDP('app', { port: 9222 }, 'cdp-app');

      await expect(
        msm.connectCDP('app', { port: 9222 }, 'cdp-app'),
      ).rejects.toThrow(/already exists/);
    });
  });

  // ─── updateSiteId ─────────────────────────────────────────────

  describe('updateSiteId', () => {
    it('updates siteId for named session', () => {
      msm.getOrCreate('default');
      msm.updateSiteId('default', 'example.com');

      const session = msm.get('default');
      expect(session!.siteId).toBe('example.com');
    });

    it('no-op for non-existent session', () => {
      // Should not throw
      msm.updateSiteId('ghost', 'example.com');
    });
  });
});
