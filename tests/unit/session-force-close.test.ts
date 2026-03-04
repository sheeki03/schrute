import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { MultiSessionManager } from '../../src/browser/multi-session.js';
import { BrowserManager } from '../../src/browser/manager.js';

// ─── Helpers ────────────────────────────────────────────────────

function createMockBrowserManager(): BrowserManager {
  const mock = {
    launchBrowser: vi.fn().mockResolvedValue({}),
    getOrCreateContext: vi.fn().mockResolvedValue({
      pages: () => [],
      newPage: vi.fn().mockResolvedValue({}),
    }),
    hasContext: vi.fn().mockReturnValue(false),
    tryGetContext: vi.fn().mockReturnValue(undefined),
    closeContext: vi.fn().mockResolvedValue(undefined),
    closeAll: vi.fn().mockResolvedValue(undefined),
    getHarPath: vi.fn().mockReturnValue(null),
    getCapabilities: vi.fn().mockReturnValue(null),
    getHandlerTimeoutMs: vi.fn().mockReturnValue(30000),
    supportsHarRecording: vi.fn().mockReturnValue(true),
    isCdpConnected: vi.fn().mockReturnValue(false),
    detachCdp: vi.fn().mockResolvedValue(undefined),
    setSuppressIdleTimeout: vi.fn(),
    withLease: vi.fn().mockImplementation(async (fn: () => Promise<unknown>) => fn()),
    touchActivity: vi.fn(),
    releaseActivity: vi.fn(),
    isIdle: vi.fn().mockReturnValue(true),
    connectExisting: vi.fn().mockResolvedValue(undefined),
  };
  return mock as unknown as BrowserManager;
}

// ─── Tests ──────────────────────────────────────────────────────

describe('session force close behavior', () => {
  let defaultManager: BrowserManager;
  let multiSession: MultiSessionManager;

  beforeEach(() => {
    defaultManager = createMockBrowserManager();
    multiSession = new MultiSessionManager(defaultManager);
  });

  describe('force: true closes default session during exploring mode', () => {
    it('closes default session when force is true and mode is exploring', async () => {
      await multiSession.close('default', { engineMode: 'exploring', force: true });
      expect(vi.mocked(defaultManager.closeAll)).toHaveBeenCalled();
    });

    it('rejects force close during recording mode (HAR invariant protection)', async () => {
      // force: true does NOT override recording guard — HAR must be flushed cleanly
      await expect(
        multiSession.close('default', { engineMode: 'recording', force: true }),
      ).rejects.toThrow(/Cannot close during recording/);
    });
  });

  describe('force: true rejected during recording mode (without force)', () => {
    it('throws when closing default session during exploring without force', async () => {
      await expect(
        multiSession.close('default', { engineMode: 'exploring' }),
      ).rejects.toThrow(/Cannot close default session/);
    });

    it('throws when closing default session during recording without force', async () => {
      await expect(
        multiSession.close('default', { engineMode: 'recording' }),
      ).rejects.toThrow(/Cannot close default session/);
    });
  });

  describe('non-default sessions always close regardless of force flag', () => {
    it('closes non-default session without force during exploring', async () => {
      // Create a non-default session first
      const session = multiSession.getOrCreate('secondary');
      const secondaryManager = session.browserManager;
      vi.spyOn(secondaryManager, 'closeAll').mockResolvedValue(undefined);
      vi.spyOn(secondaryManager, 'isCdpConnected').mockReturnValue(false);

      await multiSession.close('secondary', { engineMode: 'exploring' });
      expect(secondaryManager.closeAll).toHaveBeenCalled();
      expect(multiSession.get('secondary')).toBeUndefined();
    });

    it('force flag has no effect on non-default sessions (they always close)', async () => {
      const session = multiSession.getOrCreate('other');
      const otherManager = session.browserManager;
      vi.spyOn(otherManager, 'closeAll').mockResolvedValue(undefined);
      vi.spyOn(otherManager, 'isCdpConnected').mockReturnValue(false);

      await multiSession.close('other', { engineMode: 'recording', force: false });
      expect(otherManager.closeAll).toHaveBeenCalled();
      expect(multiSession.get('other')).toBeUndefined();
    });
  });

  describe('default session keeps entry after force close (soft-close)', () => {
    it('default session entry persists after force close', async () => {
      await multiSession.close('default', { engineMode: 'exploring', force: true });
      // Default session entry should still exist (soft-close)
      expect(multiSession.get('default')).toBeDefined();
      expect(vi.mocked(defaultManager.closeAll)).toHaveBeenCalled();
    });
  });

  describe('active session falls back to default when closed', () => {
    it('active falls back to default when active non-default session is closed', async () => {
      const session = multiSession.getOrCreate('temp');
      vi.spyOn(session.browserManager, 'closeAll').mockResolvedValue(undefined);
      vi.spyOn(session.browserManager, 'isCdpConnected').mockReturnValue(false);

      multiSession.setActive('temp');
      expect(multiSession.getActive()).toBe('temp');

      await multiSession.close('temp');
      expect(multiSession.getActive()).toBe('default');
    });
  });

  describe('closing non-existent session is no-op', () => {
    it('does not throw when closing a session that does not exist', async () => {
      await expect(multiSession.close('nonexistent')).resolves.toBeUndefined();
    });
  });

  describe('CDP session close uses detachCdp', () => {
    it('calls detachCdp for CDP-connected non-default session', async () => {
      const session = multiSession.getOrCreate('cdp-session');
      const mgr = session.browserManager;
      vi.spyOn(mgr, 'isCdpConnected').mockReturnValue(true);
      vi.spyOn(mgr, 'detachCdp').mockResolvedValue(undefined);

      await multiSession.close('cdp-session');
      expect(mgr.detachCdp).toHaveBeenCalled();
      expect(multiSession.get('cdp-session')).toBeUndefined();
    });
  });

  describe('full lifecycle: idle → explore → record guard → stop → force-close → re-explore', () => {
    it('transitions through modes with correct close behavior', async () => {
      // 1. idle mode: close without force and without mode succeeds (no mode guard triggered)
      await multiSession.close('default');
      expect(vi.mocked(defaultManager.closeAll)).toHaveBeenCalledTimes(1);
      expect(multiSession.get('default')).toBeDefined(); // default session persists (soft-close)

      vi.mocked(defaultManager.closeAll).mockClear();

      // 2. exploring mode: close without force throws
      await expect(
        multiSession.close('default', { engineMode: 'exploring' }),
      ).rejects.toThrow(/Cannot close default session/);
      expect(vi.mocked(defaultManager.closeAll)).not.toHaveBeenCalled();

      // 3. exploring mode: close WITH force succeeds
      await multiSession.close('default', { engineMode: 'exploring', force: true });
      expect(vi.mocked(defaultManager.closeAll)).toHaveBeenCalledTimes(1);
      expect(multiSession.get('default')).toBeDefined(); // still persists

      vi.mocked(defaultManager.closeAll).mockClear();

      // 4. recording mode: close with force throws (HAR invariant protection)
      await expect(
        multiSession.close('default', { engineMode: 'recording', force: true }),
      ).rejects.toThrow(/Cannot close during recording/);
      expect(vi.mocked(defaultManager.closeAll)).not.toHaveBeenCalled();

      // 5. recording mode: close without force also throws
      await expect(
        multiSession.close('default', { engineMode: 'recording' }),
      ).rejects.toThrow(/Cannot close default session/);

      // 6. After "stopping recording" (mode back to exploring), force-close succeeds
      await multiSession.close('default', { engineMode: 'exploring', force: true });
      expect(vi.mocked(defaultManager.closeAll)).toHaveBeenCalledTimes(1);

      vi.mocked(defaultManager.closeAll).mockClear();

      // 7. After force-close, session entry still exists — can "re-explore" (idle close)
      await multiSession.close('default');
      expect(vi.mocked(defaultManager.closeAll)).toHaveBeenCalledTimes(1);
      expect(multiSession.get('default')).toBeDefined();
    });
  });
});
