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

// ─── Mock cdp-connector ──────────────────────────────────────────
const mockConnectViaCDP = vi.fn();
vi.mock('../../src/browser/cdp-connector.js', () => ({
  connectViaCDP: (...args: any[]) => mockConnectViaCDP(...args),
}));

import { BrowserPool } from '../../src/browser/pool.js';

// ─── Helpers ─────────────────────────────────────────────────────

function makeMockBrowser(connected = true) {
  return {
    isConnected: vi.fn().mockReturnValue(connected),
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  } as any;
}

// ─── Tests ───────────────────────────────────────────────────────

describe('BrowserPool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('creates pool with no endpoints', () => {
      const pool = new BrowserPool();
      // Should not throw
      expect(pool).toBeDefined();
    });

    it('creates pool with initial endpoints', () => {
      const pool = new BrowserPool([
        { wsEndpoint: 'ws://a:9222' },
        { wsEndpoint: 'ws://b:9222', maxSessions: 10 },
      ]);
      expect(pool).toBeDefined();
    });

    it('ignores duplicate endpoints in constructor', () => {
      const pool = new BrowserPool([
        { wsEndpoint: 'ws://a:9222' },
        { wsEndpoint: 'ws://a:9222' },
      ]);
      expect(pool).toBeDefined();
    });
  });

  describe('acquire — least-loaded selection', () => {
    it('throws when no endpoints configured', async () => {
      const pool = new BrowserPool();
      await expect(pool.acquire()).rejects.toThrow('no endpoints configured');
    });

    it('connects and returns browser with release function', async () => {
      const mockBrowser = makeMockBrowser();
      mockConnectViaCDP.mockResolvedValue(mockBrowser);

      const pool = new BrowserPool([{ wsEndpoint: 'ws://a:9222' }]);
      const { browser, release } = await pool.acquire();

      expect(browser).toBe(mockBrowser);
      expect(typeof release).toBe('function');
      expect(mockConnectViaCDP).toHaveBeenCalledWith({ wsEndpoint: 'ws://a:9222' });
    });

    it('selects least-loaded endpoint', async () => {
      const browserA = makeMockBrowser();
      const browserB = makeMockBrowser();

      mockConnectViaCDP
        .mockResolvedValueOnce(browserA)
        .mockResolvedValueOnce(browserA)
        .mockResolvedValueOnce(browserB);

      const pool = new BrowserPool([
        { wsEndpoint: 'ws://a:9222', maxSessions: 2 },
        { wsEndpoint: 'ws://b:9222', maxSessions: 2 },
      ]);

      // First two acquisitions go to 'a' (or 'b'), but once one is more loaded
      // the pool should prefer the other
      const r1 = await pool.acquire();
      // After acquiring from a, b has 0/2 load and a has 1/2 load
      // so next should go to b
      const r2 = await pool.acquire();

      // Both should succeed
      expect(r1.browser).toBeDefined();
      expect(r2.browser).toBeDefined();
    });

    it('throws at capacity when all endpoints full', async () => {
      const mockBrowser = makeMockBrowser();
      mockConnectViaCDP.mockResolvedValue(mockBrowser);

      const pool = new BrowserPool([{ wsEndpoint: 'ws://a:9222', maxSessions: 1 }]);

      await pool.acquire(); // fills the single slot
      await expect(pool.acquire()).rejects.toThrow('all endpoints at capacity');
    });

    it('reconnects when browser is disconnected', async () => {
      const disconnectedBrowser = makeMockBrowser(false);
      const freshBrowser = makeMockBrowser(true);

      mockConnectViaCDP
        .mockResolvedValueOnce(disconnectedBrowser)
        .mockResolvedValueOnce(freshBrowser);

      const pool = new BrowserPool([{ wsEndpoint: 'ws://a:9222', maxSessions: 2 }]);

      // First acquire connects
      const r1 = await pool.acquire();
      r1.release();

      // Simulate disconnect
      disconnectedBrowser.isConnected.mockReturnValue(false);

      // Second acquire should reconnect
      const r2 = await pool.acquire();
      expect(r2.browser).toBe(freshBrowser);
      expect(mockConnectViaCDP).toHaveBeenCalledTimes(2);
    });
  });

  describe('release', () => {
    it('decrements active sessions', async () => {
      const mockBrowser = makeMockBrowser();
      mockConnectViaCDP.mockResolvedValue(mockBrowser);

      const pool = new BrowserPool([{ wsEndpoint: 'ws://a:9222', maxSessions: 1 }]);

      const { release } = await pool.acquire();
      // Pool is full now — would throw on second acquire
      await expect(pool.acquire()).rejects.toThrow('at capacity');

      release();

      // After release, should be able to acquire again
      const r2 = await pool.acquire();
      expect(r2.browser).toBe(mockBrowser);
    });

    it('is idempotent — double release does not go negative', async () => {
      const mockBrowser = makeMockBrowser();
      mockConnectViaCDP.mockResolvedValue(mockBrowser);

      const pool = new BrowserPool([{ wsEndpoint: 'ws://a:9222', maxSessions: 2 }]);

      const r1 = await pool.acquire();
      const r2 = await pool.acquire();

      // Release r1 twice — should not allow more than maxSessions
      r1.release();
      r1.release(); // idempotent, should not double-decrement

      // Only one slot freed, so we can acquire once more
      const r3 = await pool.acquire();
      expect(r3.browser).toBeDefined();

      // But not a second time (because r2 is still held and r1 only freed one)
      await expect(pool.acquire()).rejects.toThrow('at capacity');
    });
  });

  describe('addEndpoint / removeEndpoint', () => {
    it('adds a new endpoint', async () => {
      const mockBrowser = makeMockBrowser();
      mockConnectViaCDP.mockResolvedValue(mockBrowser);

      const pool = new BrowserPool();
      pool.addEndpoint('ws://new:9222', 3);

      const { browser } = await pool.acquire();
      expect(browser).toBe(mockBrowser);
    });

    it('ignores duplicate addEndpoint', async () => {
      const mockBrowser = makeMockBrowser();
      mockConnectViaCDP.mockResolvedValue(mockBrowser);

      const pool = new BrowserPool();
      pool.addEndpoint('ws://a:9222', 1);
      pool.addEndpoint('ws://a:9222', 1); // duplicate

      await pool.acquire(); // fills single slot
      await expect(pool.acquire()).rejects.toThrow('at capacity');
    });

    it('removes an endpoint', async () => {
      const pool = new BrowserPool([{ wsEndpoint: 'ws://a:9222' }]);
      pool.removeEndpoint('ws://a:9222');

      await expect(pool.acquire()).rejects.toThrow('no endpoints configured');
    });
  });

  describe('shutdown', () => {
    it('closes all connected browsers and clears entries', async () => {
      const mockBrowser = makeMockBrowser();
      mockConnectViaCDP.mockResolvedValue(mockBrowser);

      const pool = new BrowserPool([{ wsEndpoint: 'ws://a:9222' }]);
      await pool.acquire();

      await pool.shutdown();

      expect(mockBrowser.close).toHaveBeenCalled();
      await expect(pool.acquire()).rejects.toThrow('no endpoints configured');
    });
  });
});
