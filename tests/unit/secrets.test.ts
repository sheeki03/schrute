import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock logger ─────────────────────────────────────────────────
vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ─── Mock keytar ─────────────────────────────────────────────────

let mockKeytarStore: Record<string, string> = {};
let mockKeytarShouldFail = false;
let mockKeytarShouldTimeout = false;
const TIMEOUT_DELAY = 5000; // longer than the 2000ms keytar timeout

const mockKeytar = {
  setPassword: vi.fn(async (_service: string, account: string, password: string) => {
    if (mockKeytarShouldTimeout) {
      await new Promise((r) => setTimeout(r, TIMEOUT_DELAY));
    }
    if (mockKeytarShouldFail) throw new Error('Keychain access denied');
    mockKeytarStore[account] = password;
  }),
  getPassword: vi.fn(async (_service: string, account: string) => {
    if (mockKeytarShouldTimeout) {
      await new Promise((r) => setTimeout(r, TIMEOUT_DELAY));
    }
    if (mockKeytarShouldFail) throw new Error('Keychain access denied');
    return mockKeytarStore[account] ?? null;
  }),
  deletePassword: vi.fn(async (_service: string, account: string) => {
    if (mockKeytarShouldTimeout) {
      await new Promise((r) => setTimeout(r, TIMEOUT_DELAY));
    }
    if (mockKeytarShouldFail) throw new Error('Keychain access denied');
    const existed = account in mockKeytarStore;
    delete mockKeytarStore[account];
    return existed;
  }),
  findPassword: vi.fn(async () => null),
};

vi.mock('keytar', () => ({
  default: mockKeytar,
}));

// We need to reimport after mocking to reset module-level state
let secretsModule: typeof import('../../src/storage/secrets.js');

beforeEach(async () => {
  mockKeytarStore = {};
  mockKeytarShouldFail = false;
  mockKeytarShouldTimeout = false;
  vi.clearAllMocks();

  // Dynamic reimport to reset module state
  vi.resetModules();

  // Re-mock after reset
  vi.mock('../../src/core/logger.js', () => ({
    getLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  }));

  vi.mock('keytar', () => ({
    default: mockKeytar,
  }));

  secretsModule = await import('../../src/storage/secrets.js');
});

describe('Secrets (keytar wrapper)', () => {
  // ─── Store/Retrieve/Delete Flow ────────────────────────────────

  describe('store/retrieve/delete flow', () => {
    it('stores a value', async () => {
      await secretsModule.store('test-key', 'test-value');
      expect(mockKeytar.setPassword).toHaveBeenCalledWith('oneagent', 'test-key', 'test-value');
    });

    it('retrieves a stored value', async () => {
      await secretsModule.store('test-key', 'test-value');
      const result = await secretsModule.retrieve('test-key');
      expect(result).toBe('test-value');
    });

    it('returns null for non-existent key', async () => {
      const result = await secretsModule.retrieve('nonexistent');
      expect(result).toBeNull();
    });

    it('removes a stored value', async () => {
      await secretsModule.store('test-key', 'test-value');
      const removed = await secretsModule.remove('test-key');
      expect(removed).toBe(true);

      const retrieved = await secretsModule.retrieve('test-key');
      expect(retrieved).toBeNull();
    });

    it('returns false when removing non-existent key', async () => {
      const removed = await secretsModule.remove('nonexistent');
      expect(removed).toBe(false);
    });
  });

  // ─── exists() ──────────────────────────────────────────────────

  describe('exists()', () => {
    it('returns true for existing key', async () => {
      await secretsModule.store('exists-key', 'value');
      const result = await secretsModule.exists('exists-key');
      expect(result).toBe(true);
    });

    it('returns false for non-existing key', async () => {
      const result = await secretsModule.exists('no-key');
      expect(result).toBe(false);
    });
  });

  // ─── Site-scoped secrets ───────────────────────────────────────

  describe('site-scoped secrets', () => {
    it('stores and retrieves site secret', async () => {
      await secretsModule.storeSiteSecret('example.com', 'token', 'abc123');
      const result = await secretsModule.retrieveSiteSecret('example.com', 'token');
      expect(result).toBe('abc123');
    });

    it('removes site secret', async () => {
      await secretsModule.storeSiteSecret('example.com', 'token', 'abc123');
      const removed = await secretsModule.removeSiteSecret('example.com', 'token');
      expect(removed).toBe(true);
    });

    it('isolates secrets between sites', async () => {
      await secretsModule.storeSiteSecret('site1.com', 'token', 'token-1');
      await secretsModule.storeSiteSecret('site2.com', 'token', 'token-2');

      expect(await secretsModule.retrieveSiteSecret('site1.com', 'token')).toBe('token-1');
      expect(await secretsModule.retrieveSiteSecret('site2.com', 'token')).toBe('token-2');
    });
  });

  // ─── Keytar Unavailable (graceful fallback) ────────────────────

  describe('keytar unavailable', () => {
    it('throws when keytar operations fail', async () => {
      mockKeytarShouldFail = true;
      await expect(secretsModule.store('key', 'value')).rejects.toThrow('Keychain access denied');
    });

    it('throws on retrieve when keytar fails', async () => {
      mockKeytarShouldFail = true;
      await expect(secretsModule.retrieve('key')).rejects.toThrow('Keychain access denied');
    });
  });

  // ─── Timeout Handling ──────────────────────────────────────────

  describe('timeout handling', () => {
    it('rejects when keytar operation takes too long', async () => {
      mockKeytarShouldTimeout = true;
      await expect(secretsModule.store('key', 'value')).rejects.toThrow('timed out');
    }, 10000);

    it('rejects retrieve on timeout', async () => {
      mockKeytarShouldTimeout = true;
      await expect(secretsModule.retrieve('key')).rejects.toThrow('timed out');
    }, 10000);
  });

  // ─── getLockedModeStatus ───────────────────────────────────────

  describe('getLockedModeStatus', () => {
    it('reports unlocked when keytar works', async () => {
      const status = await secretsModule.getLockedModeStatus();
      expect(status.locked).toBe(false);
      expect(status.availableCapabilities).toContain('secrets.use');
      expect(status.unavailableCapabilities).toHaveLength(0);
    });

    it('reports locked when keytar fails', async () => {
      mockKeytarShouldFail = true;
      const status = await secretsModule.getLockedModeStatus();
      expect(status.locked).toBe(true);
      expect(status.reason).toContain('Keychain unavailable');
      expect(status.unavailableCapabilities).toContain('secrets.use');
    });
  });
});
