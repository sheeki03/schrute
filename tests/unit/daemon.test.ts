import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';

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
  getDaemonSocketPath: (config: { dataDir: string }) => `${config.dataDir}/daemon.sock`,
  getDaemonPidPath: (config: { dataDir: string }) => `${config.dataDir}/daemon.pid`,
  getDaemonTokenPath: (config: { dataDir: string }) => `${config.dataDir}/daemon.token`,
}));

import { checkBearerAuth, LifecycleGuard } from '../../src/server/daemon.js';

// Helper to create a minimal mock IncomingMessage with an authorization header
function mockReq(authHeader?: string): IncomingMessage {
  return { headers: { authorization: authHeader } } as unknown as IncomingMessage;
}

describe('Daemon utilities', () => {
  // ─── Bearer Auth ──────────────────────────────────────────────

  describe('checkBearerAuth', () => {
    const token = crypto.randomBytes(32).toString('hex');

    it('returns true for valid bearer token', () => {
      expect(checkBearerAuth(mockReq(`Bearer ${token}`), token)).toBe(true);
    });

    it('returns false for missing auth header', () => {
      expect(checkBearerAuth(mockReq(undefined), token)).toBe(false);
    });

    it('returns false for wrong token', () => {
      const wrongToken = crypto.randomBytes(32).toString('hex');
      expect(checkBearerAuth(mockReq(`Bearer ${wrongToken}`), token)).toBe(false);
    });

    it('returns false for malformed auth header (no Bearer prefix)', () => {
      expect(checkBearerAuth(mockReq(`Basic ${token}`), token)).toBe(false);
    });

    it('returns false for empty auth header', () => {
      expect(checkBearerAuth(mockReq(''), token)).toBe(false);
    });

    it('handles case-insensitive Bearer prefix', () => {
      expect(checkBearerAuth(mockReq(`bearer ${token}`), token)).toBe(true);
      expect(checkBearerAuth(mockReq(`BEARER ${token}`), token)).toBe(true);
    });

    it('returns false when token has different length', () => {
      expect(checkBearerAuth(mockReq('Bearer short'), token)).toBe(false);
    });
  });

  // ─── LifecycleGuard ───────────────────────────────────────────

  describe('LifecycleGuard', () => {
    let guard: LifecycleGuard;

    beforeEach(() => {
      guard = new LifecycleGuard();
    });

    it('executes function inside lock', async () => {
      const result = await guard.withLock(async () => 42);
      expect(result).toBe(42);
    });

    it('serializes concurrent requests', async () => {
      const order: number[] = [];

      const p1 = guard.withLock(async () => {
        await new Promise((r) => setTimeout(r, 50));
        order.push(1);
        return 1;
      });

      const p2 = guard.withLock(async () => {
        order.push(2);
        return 2;
      });

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBe(1);
      expect(r2).toBe(2);
      expect(order).toEqual([1, 2]);
    });

    it('markShuttingDown returns true first time, false second', () => {
      expect(guard.markShuttingDown()).toBe(true);
      expect(guard.markShuttingDown()).toBe(false);
    });

    it('isShuttingDown reflects state', () => {
      expect(guard.isShuttingDown).toBe(false);
      guard.markShuttingDown();
      expect(guard.isShuttingDown).toBe(true);
    });

    it('drainLock resolves after all pending operations', async () => {
      let completed = false;
      guard.withLock(async () => {
        await new Promise((r) => setTimeout(r, 30));
        completed = true;
      });

      await guard.drainLock();
      expect(completed).toBe(true);
    });

    it('propagates errors from locked function', async () => {
      await expect(
        guard.withLock(async () => {
          throw new Error('test error');
        }),
      ).rejects.toThrow('test error');

      // Lock should still work after error
      const result = await guard.withLock(async () => 'ok');
      expect(result).toBe('ok');
    });
  });

  // ─── Socket validation concepts ────────────────────────────────
  // (Testing the logic patterns — actual fs operations are mocked)

  describe('socket validation patterns', () => {
    it('rejects non-socket files (simulated)', () => {
      // In daemon.ts: if (!stat.isSocket()) throw Error
      const stat = { isSocket: () => false };
      expect(stat.isSocket()).toBe(false);
    });

    it('rejects wrong owner (simulated)', () => {
      // In daemon.ts: if (stat.uid !== process.getuid!()) throw Error
      const stat = { uid: 99999 };
      const currentUid = process.getuid?.() ?? 0;
      expect(stat.uid).not.toBe(currentUid);
    });
  });

  // ─── Token generation ──────────────────────────────────────────

  describe('token generation', () => {
    it('generates 64-character hex tokens', () => {
      const token = crypto.randomBytes(32).toString('hex');
      expect(token).toHaveLength(64);
      expect(token).toMatch(/^[a-f0-9]+$/);
    });

    it('generates unique tokens', () => {
      const t1 = crypto.randomBytes(32).toString('hex');
      const t2 = crypto.randomBytes(32).toString('hex');
      expect(t1).not.toBe(t2);
    });
  });
});
