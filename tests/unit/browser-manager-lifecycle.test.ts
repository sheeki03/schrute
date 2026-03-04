import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Browser, BrowserContext } from 'playwright';

// ─── Mocks ──────────────────────────────────────────────────────────

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
    dataDir: '/tmp/oneagent-bm-test',
    browser: {},
    daemon: { port: 19420, autoStart: false },
  }),
  getBrowserDataDir: () => '/tmp/oneagent-bm-test/browser-data',
  getTmpDir: () => '/tmp/oneagent-bm-test/tmp',
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

import { BrowserManager } from '../../src/browser/manager.js';
import { launchBrowserEngine } from '../../src/browser/engine.js';

// ─── Helpers ────────────────────────────────────────────────────────

function createMockBrowser(connected = true): Browser {
  const disconnectHandlers: Array<() => void> = [];
  return {
    isConnected: vi.fn().mockReturnValue(connected),
    newContext: vi.fn().mockResolvedValue(createMockContext()),
    contexts: vi.fn().mockReturnValue([]),
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, handler: () => void) => {
      if (event === 'disconnected') disconnectHandlers.push(handler);
    }),
    _triggerDisconnect: () => disconnectHandlers.forEach(h => h()),
  } as unknown as Browser & { _triggerDisconnect: () => void };
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

function setupLaunchMock(browser?: Browser) {
  const mockBrowser = browser ?? createMockBrowser();
  (launchBrowserEngine as ReturnType<typeof vi.fn>).mockResolvedValue({
    browser: mockBrowser,
    capabilities: {
      configuredEngine: 'patchright',
      effectiveEngine: 'patchright',
    },
  });
  return mockBrowser;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('BrowserManager Lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Idle Timeout ─────────────────────────────────────────────

  describe('idle timeout', () => {
    it('closes browser after idle timeout expires', async () => {
      const manager = new BrowserManager({
        dataDir: '/tmp/test',
        browser: { idleTimeoutMs: 1000 },
        daemon: { port: 19420, autoStart: false },
      } as any);

      const mockBrowser = setupLaunchMock();
      await manager.launchBrowser();

      // Advance past idle timeout
      await vi.advanceTimersByTimeAsync(1100);

      // Browser should have been closed
      expect(mockBrowser.close).toHaveBeenCalled();
    });

    it('touchActivity prevents idle shutdown', async () => {
      const manager = new BrowserManager({
        dataDir: '/tmp/test',
        browser: { idleTimeoutMs: 1000 },
        daemon: { port: 19420, autoStart: false },
      } as any);

      const mockBrowser = setupLaunchMock();
      await manager.launchBrowser();

      manager.touchActivity();

      // Advance past idle timeout
      await vi.advanceTimersByTimeAsync(1100);

      // Browser should NOT have been closed because ops are in-flight
      expect(mockBrowser.close).not.toHaveBeenCalled();

      // Release to start timer
      manager.releaseActivity();
    });

    it('releaseActivity starts idle timer when inFlightOps reaches 0', async () => {
      const manager = new BrowserManager({
        dataDir: '/tmp/test',
        browser: { idleTimeoutMs: 1000 },
        daemon: { port: 19420, autoStart: false },
      } as any);

      const mockBrowser = setupLaunchMock();
      await manager.launchBrowser();

      // Two ops in flight
      manager.touchActivity();
      manager.touchActivity();

      // First release — still 1 op
      manager.releaseActivity();
      await vi.advanceTimersByTimeAsync(1100);
      expect(mockBrowser.close).not.toHaveBeenCalled();

      // Second release — 0 ops, timer starts
      manager.releaseActivity();
      await vi.advanceTimersByTimeAsync(1100);
      expect(mockBrowser.close).toHaveBeenCalled();
    });

    it('idleTimeoutMs: 0 disables idle timeout', async () => {
      const manager = new BrowserManager({
        dataDir: '/tmp/test',
        browser: { idleTimeoutMs: 0 },
        daemon: { port: 19420, autoStart: false },
      } as any);

      const mockBrowser = setupLaunchMock();
      await manager.launchBrowser();

      // Advance way past any reasonable timeout
      await vi.advanceTimersByTimeAsync(600000);

      // Browser should NOT have been closed
      expect(mockBrowser.close).not.toHaveBeenCalled();
    });

    it('suppressIdleTimeout prevents idle shutdown during recording', async () => {
      const manager = new BrowserManager({
        dataDir: '/tmp/test',
        browser: { idleTimeoutMs: 1000 },
        daemon: { port: 19420, autoStart: false },
      } as any);

      const mockBrowser = setupLaunchMock();
      await manager.launchBrowser();

      manager.setSuppressIdleTimeout(true);

      // Advance past idle timeout
      await vi.advanceTimersByTimeAsync(1100);

      // Browser should NOT have been closed — suppressed
      expect(mockBrowser.close).not.toHaveBeenCalled();

      // Unsuppress — timer restarts
      manager.setSuppressIdleTimeout(false);
      await vi.advanceTimersByTimeAsync(1100);

      // Now it should close
      expect(mockBrowser.close).toHaveBeenCalled();
    });

    it('CDP sessions skip idle timeout entirely', async () => {
      const manager = new BrowserManager({
        dataDir: '/tmp/test',
        browser: { idleTimeoutMs: 1000 },
        daemon: { port: 19420, autoStart: false },
      } as any);

      const mockBrowser = createMockBrowser();
      (mockBrowser.contexts as ReturnType<typeof vi.fn>).mockReturnValue([createMockContext()]);

      await manager.connectExisting(mockBrowser, 'test-site', { port: 9222 });

      // Advance past idle timeout
      await vi.advanceTimersByTimeAsync(5000);

      // Browser should NOT have been closed — CDP sessions skip idle
      expect(mockBrowser.close).not.toHaveBeenCalled();
    });
  });

  // ─── withLease ──────────────────────────────────────────────────

  describe('withLease', () => {
    it('brackets correctly: touch before, release in finally even on error', async () => {
      const manager = new BrowserManager({
        dataDir: '/tmp/test',
        browser: { idleTimeoutMs: 60000 },
        daemon: { port: 19420, autoStart: false },
      } as any);

      setupLaunchMock();
      await manager.launchBrowser();

      // Verify lease starts
      expect(manager.isIdle()).toBe(true);

      try {
        await manager.withLease(async () => {
          expect(manager.isIdle()).toBe(false);
          throw new Error('intentional');
        });
      } catch {
        // expected
      }

      // Should be idle again after error
      expect(manager.isIdle()).toBe(true);
    });

    it('nested calls are safe (counter increments/decrements correctly)', async () => {
      const manager = new BrowserManager({
        dataDir: '/tmp/test',
        daemon: { port: 19420, autoStart: false },
      } as any);

      setupLaunchMock();

      let innerIdleState: boolean | undefined;

      await manager.withLease(async () => {
        expect(manager.isIdle()).toBe(false);

        await manager.withLease(async () => {
          innerIdleState = manager.isIdle();
        });

        // After inner lease released, outer still holds
        expect(manager.isIdle()).toBe(false);
      });

      expect(innerIdleState).toBe(false);
      expect(manager.isIdle()).toBe(true);
    });
  });

  // ─── Lifecycle Lock ────────────────────────────────────────────

  describe('lifecycle lock', () => {
    it('closeAll clears timer and resets ops counter', async () => {
      const manager = new BrowserManager({
        dataDir: '/tmp/test',
        browser: { idleTimeoutMs: 5000 },
        daemon: { port: 19420, autoStart: false },
      } as any);

      setupLaunchMock();
      await manager.launchBrowser();

      manager.touchActivity();
      expect(manager.isIdle()).toBe(false);

      await manager.closeAll();

      expect(manager.isIdle()).toBe(true);
    });

    it('serializes concurrent lifecycle operations (no overlap)', async () => {
      vi.useRealTimers(); // need real timers for concurrent promise resolution

      const manager = new BrowserManager({
        dataDir: '/tmp/test',
        browser: { idleTimeoutMs: 0 },
        daemon: { port: 19420, autoStart: false },
      } as any);

      setupLaunchMock();
      await manager.launchBrowser();

      const executionOrder: string[] = [];

      // Launch two concurrent closeAll + idleShutdown — they must serialize
      const p1 = manager.closeAll().then(() => executionOrder.push('closeAll'));

      // Re-setup mock for second operation
      setupLaunchMock();
      await manager.launchBrowser();

      const p2 = manager.idleShutdown().then(() => executionOrder.push('idleShutdown'));

      await Promise.all([p1, p2]);

      // Both completed, and in sequence (not interleaved)
      expect(executionOrder).toHaveLength(2);
      expect(executionOrder[0]).toBe('closeAll');
      expect(executionOrder[1]).toBe('idleShutdown');

      vi.useFakeTimers();
    });

    it('concurrent same-name lifecycle calls queue instead of erroring', async () => {
      vi.useRealTimers();

      const manager = new BrowserManager({
        dataDir: '/tmp/test',
        browser: { idleTimeoutMs: 0 },
        daemon: { port: 19420, autoStart: false },
      } as any);

      setupLaunchMock();
      await manager.launchBrowser();

      // Two concurrent closeAll() calls — must both complete, not throw reentrancy error
      const p1 = manager.closeAll();

      setupLaunchMock();
      await manager.launchBrowser();

      const p2 = manager.closeAll();

      // Both should resolve without error
      await expect(Promise.all([p1, p2])).resolves.toBeDefined();

      vi.useFakeTimers();
    });
  });

  // ─── Disconnect + Relaunch ─────────────────────────────────────

  describe('disconnect and relaunch', () => {
    it('browser relaunches on getOrCreateContext after disconnect', async () => {
      const manager = new BrowserManager({
        dataDir: '/tmp/test',
        browser: { idleTimeoutMs: 0 },
        daemon: { port: 19420, autoStart: false },
      } as any);

      const mockBrowser1 = setupLaunchMock() as Browser & { _triggerDisconnect: () => void };
      await manager.launchBrowser();

      // Simulate disconnect
      mockBrowser1._triggerDisconnect();

      // Set up new browser for relaunch
      const mockBrowser2 = setupLaunchMock();
      const context = await manager.getOrCreateContext('test-site');

      expect(context).toBeDefined();
      expect(launchBrowserEngine).toHaveBeenCalledTimes(2);
    });

    it('browser relaunches on getOrCreateContext after idle shutdown', async () => {
      const manager = new BrowserManager({
        dataDir: '/tmp/test',
        browser: { idleTimeoutMs: 500 },
        daemon: { port: 19420, autoStart: false },
      } as any);

      setupLaunchMock();
      await manager.launchBrowser();

      // Trigger idle shutdown
      await vi.advanceTimersByTimeAsync(600);

      // Set up new browser for relaunch
      setupLaunchMock();
      const context = await manager.getOrCreateContext('test-site');

      expect(context).toBeDefined();
      expect(launchBrowserEngine).toHaveBeenCalledTimes(2);
    });
  });

  // ─── releaseActivity underflow protection ─────────────────────

  describe('releaseActivity underflow', () => {
    it('does not underflow after disconnect', async () => {
      const manager = new BrowserManager({
        dataDir: '/tmp/test',
        daemon: { port: 19420, autoStart: false },
      } as any);

      // Release without any touch — should clamp to 0
      manager.releaseActivity();
      expect(manager.isIdle()).toBe(true);
    });

    it('does not underflow after closeAll', async () => {
      const manager = new BrowserManager({
        dataDir: '/tmp/test',
        daemon: { port: 19420, autoStart: false },
      } as any);

      setupLaunchMock();
      await manager.launchBrowser();

      manager.touchActivity();
      await manager.closeAll();

      // Extra release after closeAll — should not underflow
      manager.releaseActivity();
      expect(manager.isIdle()).toBe(true);
    });
  });

  // ─── Accessors ────────────────────────────────────────────────

  describe('accessors', () => {
    it('supportsHarRecording returns true for launch-based', () => {
      const manager = new BrowserManager({
        dataDir: '/tmp/test',
        daemon: { port: 19420, autoStart: false },
      } as any);

      expect(manager.supportsHarRecording()).toBe(true);
    });

    it('supportsHarRecording returns false after CDP connect', async () => {
      const manager = new BrowserManager({
        dataDir: '/tmp/test',
        daemon: { port: 19420, autoStart: false },
      } as any);

      const mockBrowser = createMockBrowser();
      (mockBrowser.contexts as ReturnType<typeof vi.fn>).mockReturnValue([createMockContext()]);

      await manager.connectExisting(mockBrowser, 'test', { port: 9222 });

      expect(manager.supportsHarRecording()).toBe(false);
    });

    it('getHandlerTimeoutMs returns configured value', () => {
      const manager = new BrowserManager({
        dataDir: '/tmp/test',
        browser: { handlerTimeoutMs: 5000 },
        daemon: { port: 19420, autoStart: false },
      } as any);

      expect(manager.getHandlerTimeoutMs()).toBe(5000);
    });

    it('getHandlerTimeoutMs returns default when not configured', () => {
      const manager = new BrowserManager({
        dataDir: '/tmp/test',
        daemon: { port: 19420, autoStart: false },
      } as any);

      expect(manager.getHandlerTimeoutMs()).toBe(30000);
    });
  });
});
