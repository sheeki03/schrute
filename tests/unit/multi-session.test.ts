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
    dataDir: '/tmp/schrute-ms-test',
    browser: {},
    daemon: { port: 19420, autoStart: false },
  }),
  getBrowserDataDir: () => '/tmp/schrute-ms-test/browser-data',
  getTmpDir: () => '/tmp/schrute-ms-test/tmp',
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
    dataDir: '/tmp/schrute-ms-test',
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

    // Note: multi-session.close() policy restore with persisted=false warn path
    // is verified by code review (the branch exists in multi-session.ts:201-206).
    // A unit test for this requires mocking a dynamic import() which vitest
    // doesn't reliably intercept for runtime-resolved paths.
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

  // ─── Session Isolation (Multi-User Mode) ─────────────────────

  describe('session isolation (multi-user mode)', () => {
    const networkConfig = {
      dataDir: '/tmp/schrute-ms-test',
      daemon: { port: 19420, autoStart: false },
      server: { network: true },
    } as any;

    const localConfig = {
      dataDir: '/tmp/schrute-ms-test',
      daemon: { port: 19420, autoStart: false },
      server: { network: false },
    } as any;

    // ─── setActive ───────────────────────────────────────────

    it('setActive rejects non-default session when server.network=true', () => {
      msm.getOrCreate('custom');
      expect(() => msm.setActive('custom', networkConfig)).toThrow(
        /Cannot switch global active session in multi-user mode/,
      );
    });

    it('setActive allows non-default session when server.network=false', () => {
      msm.getOrCreate('custom');
      msm.setActive('custom', localConfig);
      expect(msm.getActive()).toBe('custom');
    });

    it('setActive allows non-default session when no config passed (backward compat)', () => {
      msm.getOrCreate('custom');
      msm.setActive('custom');
      expect(msm.getActive()).toBe('custom');
    });

    // ─── assertOwnership ─────────────────────────────────────

    it('assertOwnership succeeds when callerId matches ownedBy', async () => {
      const mockBrowser = createMockBrowser();
      (connectViaCDP as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser);

      await msm.connectCDP('owned', { port: 9222 }, 'site', 'caller-a');

      // Should not throw
      expect(() => msm.assertOwnership('owned', 'caller-a')).not.toThrow();
    });

    it('assertOwnership throws when callerId does not match ownedBy', async () => {
      const mockBrowser = createMockBrowser();
      (connectViaCDP as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser);

      await msm.connectCDP('owned', { port: 9222 }, 'site', 'caller-a');

      expect(() => msm.assertOwnership('owned', 'caller-b')).toThrow(
        /belongs to a different client/,
      );
    });

    it('assertOwnership succeeds on default session regardless', async () => {
      // Default session has no ownedBy — should always succeed
      expect(() => msm.assertOwnership('default', 'anyone')).not.toThrow();
    });

    it('assertOwnership succeeds when session has no ownedBy', () => {
      msm.getOrCreate('shared');
      // No ownedBy set — should succeed for any caller
      expect(() => msm.assertOwnership('shared', 'any-caller')).not.toThrow();
    });

    it('assertOwnership succeeds when callerId is undefined', async () => {
      const mockBrowser = createMockBrowser();
      (connectViaCDP as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser);

      await msm.connectCDP('owned', { port: 9222 }, 'site', 'caller-a');

      // undefined callerId = stdio/CLI = no restriction
      expect(() => msm.assertOwnership('owned', undefined)).not.toThrow();
    });

    // ─── list filtering ──────────────────────────────────────

    it('list returns all sessions when callerId is undefined', () => {
      msm.getOrCreate('session-a');
      msm.getOrCreate('session-b');

      const result = msm.list(undefined, networkConfig);
      const names = result.map(s => s.name);
      expect(names).toContain('default');
      expect(names).toContain('session-a');
      expect(names).toContain('session-b');
    });

    it('list returns all sessions for admin caller (stdio) in network mode', () => {
      msm.getOrCreate('session-a');
      msm.getOrCreate('session-b');

      const result = msm.list('stdio', networkConfig);
      const names = result.map(s => s.name);
      expect(names).toContain('default');
      expect(names).toContain('session-a');
      expect(names).toContain('session-b');
    });

    it('list returns all sessions for admin caller (daemon) in network mode', () => {
      msm.getOrCreate('session-a');

      const result = msm.list('daemon', networkConfig);
      const names = result.map(s => s.name);
      expect(names).toContain('default');
      expect(names).toContain('session-a');
    });

    it('list hides default session for non-admin in network mode', async () => {
      const mockBrowser = createMockBrowser();
      (connectViaCDP as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser);

      await msm.connectCDP('my-session', { port: 9222 }, 'site', 'remote-caller');

      const result = msm.list('remote-caller', networkConfig);
      const names = result.map(s => s.name);
      expect(names).not.toContain('default');
      expect(names).toContain('my-session');
    });

    it('list shows only callers own sessions for non-admin in network mode', async () => {
      const mockBrowser = createMockBrowser();
      (connectViaCDP as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser);

      // Create sessions owned by different callers
      await msm.connectCDP('session-a', { port: 9222 }, 'site-a', 'caller-a');
      (connectViaCDP as ReturnType<typeof vi.fn>).mockResolvedValue(createMockBrowser());
      await msm.connectCDP('session-b', { port: 9223 }, 'site-b', 'caller-b');

      // Also create an unowned session (legacy)
      msm.getOrCreate('shared');

      // caller-a should see only their own + unowned sessions (not default, not caller-b's)
      const result = msm.list('caller-a', networkConfig);
      const names = result.map(s => s.name);
      expect(names).toContain('session-a');
      expect(names).toContain('shared');      // no ownedBy → visible
      expect(names).not.toContain('default');
      expect(names).not.toContain('session-b');
    });

    it('list returns all sessions for any caller when server.network=false', async () => {
      const mockBrowser = createMockBrowser();
      (connectViaCDP as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser);

      await msm.connectCDP('session-a', { port: 9222 }, 'site-a', 'caller-a');

      // Even a non-admin callerId sees everything when network=false
      const result = msm.list('random-caller', localConfig);
      const names = result.map(s => s.name);
      expect(names).toContain('default');
      expect(names).toContain('session-a');
    });
  });

  // ─── Session Sweep ────────────────────────────────────────────

  describe('session sweep', () => {
    it('sweeps idle sessions past maxIdleMs', () => {
      msm.getOrCreate('idle-session');

      // Backdate lastUsedAt to simulate idle time
      const session = msm.get('idle-session')!;
      session.lastUsedAt = Date.now() - 7200_000; // 2 hours ago

      const swept = msm.sweepIdleSessions(3600_000); // 1 hour threshold
      expect(swept).toBe(1);
      // Session should be removed asynchronously via close()
    });

    it('does not sweep default session', () => {
      // Backdate default session's lastUsedAt
      const defaultSession = msm.get('default')!;
      defaultSession.lastUsedAt = Date.now() - 7200_000; // 2 hours ago

      const swept = msm.sweepIdleSessions(3600_000);
      expect(swept).toBe(0);
      // Default session should still exist
      expect(msm.get('default')).toBeDefined();
    });

    it('does not sweep recently used sessions', () => {
      msm.getOrCreate('active-session');

      // lastUsedAt is set to Date.now() by getOrCreate — well within threshold
      const swept = msm.sweepIdleSessions(3600_000);
      expect(swept).toBe(0);
    });

    it('sweeps multiple idle sessions but keeps active ones', () => {
      msm.getOrCreate('idle-1');
      msm.getOrCreate('idle-2');
      msm.getOrCreate('active-1');

      // Backdate only the idle sessions
      msm.get('idle-1')!.lastUsedAt = Date.now() - 7200_000;
      msm.get('idle-2')!.lastUsedAt = Date.now() - 7200_000;
      // active-1 keeps its recent timestamp

      const swept = msm.sweepIdleSessions(3600_000);
      expect(swept).toBe(2);
    });

    it('uses default maxIdleMs of 1 hour', () => {
      msm.getOrCreate('idle-session');
      msm.get('idle-session')!.lastUsedAt = Date.now() - 3601_000; // just over 1 hour

      const swept = msm.sweepIdleSessions(); // no arg = default 1h
      expect(swept).toBe(1);
    });
  });

  // ─── lastUsedAt Tracking ──────────────────────────────────────

  describe('lastUsedAt tracking', () => {
    it('getOrCreate touches lastUsedAt on existing session', () => {
      const session = msm.getOrCreate('tracked');
      const originalTs = session.lastUsedAt;

      // Backdate to verify it gets updated
      session.lastUsedAt = originalTs - 10_000;

      const retrieved = msm.getOrCreate('tracked');
      expect(retrieved.lastUsedAt).toBeGreaterThan(originalTs - 10_000);
      expect(retrieved.lastUsedAt).toBeGreaterThanOrEqual(originalTs);
    });

    it('get touches lastUsedAt', () => {
      msm.getOrCreate('tracked');
      const session = msm.get('tracked')!;

      // Backdate to verify it gets updated
      session.lastUsedAt = Date.now() - 60_000;
      const backdated = session.lastUsedAt;

      const retrieved = msm.get('tracked')!;
      expect(retrieved.lastUsedAt).toBeGreaterThan(backdated);
    });

    it('connectCDP sets lastUsedAt on new CDP session', async () => {
      const mockBrowser = createMockBrowser();
      (connectViaCDP as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser);

      const before = Date.now();
      const session = await msm.connectCDP('cdp-tracked', { port: 9222 }, 'site');
      const after = Date.now();

      expect(session.lastUsedAt).toBeGreaterThanOrEqual(before);
      expect(session.lastUsedAt).toBeLessThanOrEqual(after);
    });

    it('new session from getOrCreate has lastUsedAt set', () => {
      const before = Date.now();
      const session = msm.getOrCreate('fresh');
      const after = Date.now();

      expect(session.lastUsedAt).toBeGreaterThanOrEqual(before);
      expect(session.lastUsedAt).toBeLessThanOrEqual(after);
    });
  });

  // ─── connectCDP ownedBy ───────────────────────────────────────

  describe('connectCDP ownedBy', () => {
    it('sets ownedBy when provided', async () => {
      const mockBrowser = createMockBrowser();
      (connectViaCDP as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser);

      const session = await msm.connectCDP('owned', { port: 9222 }, 'site', 'my-caller');
      expect(session.ownedBy).toBe('my-caller');
    });

    it('ownedBy is undefined when not provided', async () => {
      const mockBrowser = createMockBrowser();
      (connectViaCDP as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser);

      const session = await msm.connectCDP('unowned', { port: 9222 }, 'site');
      expect(session.ownedBy).toBeUndefined();
    });
  });
});
