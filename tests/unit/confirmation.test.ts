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

// ─── Mock config (needed by database) ────────────────────────────
vi.mock('../../src/core/config.js', () => ({
  getConfig: () => ({
    dataDir: '/tmp/schrute-confirm-test',
    logLevel: 'silent',
  }),
  getDbPath: () => ':memory:',
  ensureDirectories: vi.fn(),
}));

// ─── Mock secrets (keytar) ───────────────────────────────────────
let mockKeytarStore: Record<string, string> = {};
let mockKeytarShouldFail = false;

vi.mock('../../src/storage/secrets.js', () => ({
  retrieve: vi.fn(async (key: string) => {
    if (mockKeytarShouldFail) throw new Error('Keychain unavailable');
    return mockKeytarStore[key] ?? null;
  }),
  store: vi.fn(async (key: string, value: string) => {
    if (mockKeytarShouldFail) throw new Error('Keychain unavailable');
    mockKeytarStore[key] = value;
  }),
}));

import { ConfirmationManager } from '../../src/server/confirmation.js';
import type { AgentDatabase } from '../../src/storage/database.js';
import type { SchruteConfig } from '../../src/skill/types.js';
import { createFullSchemaDb } from '../helpers.js';

// ─── In-Memory DB Setup ──────────────────────────────────────────

function createTestDb(): AgentDatabase {
  const db = createFullSchemaDb();

  // Insert test site and skill
  db.exec(`
    INSERT INTO sites (id, display_name) VALUES ('example.com', 'Example');
    INSERT INTO skills (id, site_id, name, method, path_template) VALUES ('skill1', 'example.com', 'test_skill', 'GET', '/api/test');
    INSERT INTO skills (id, site_id, name, method, path_template) VALUES ('skill2', 'example.com', 'test_skill2', 'POST', '/api/test2');
  `);

  return db;
}

function makeConfig(overrides?: Partial<SchruteConfig>): SchruteConfig {
  return {
    dataDir: '/tmp/schrute-confirm-test',
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
  } as SchruteConfig;
}

describe('ConfirmationManager', () => {
  let db: AgentDatabase;
  let manager: ConfirmationManager;
  let config: SchruteConfig;

  beforeEach(() => {
    mockKeytarStore = {};
    mockKeytarShouldFail = false;
    db = createTestDb();
    config = makeConfig();
    manager = new ConfirmationManager(db, config);
  });

  afterEach(() => {
    try { (db as unknown as { close: () => void }).close(); } catch { /* best effort — don't mask test failures */ }
  });

  // ─── Token Generation ──────────────────────────────────────────

  describe('generateToken', () => {
    it('returns a valid token object', async () => {
      const token = await manager.generateToken('skill1', { page: 1 }, 'tier_1');
      expect(token).toBeDefined();
      expect(typeof token.nonce).toBe('string');
      expect(token.nonce.length).toBeGreaterThan(0);
      expect(token.skillId).toBe('skill1');
      expect(token.tier).toBe('tier_1');
      expect(token.consumed).toBe(false);
      expect(token.createdAt).toBeLessThanOrEqual(Date.now());
      expect(token.expiresAt).toBeGreaterThan(Date.now());
    });

    it('generates unique tokens for each call', async () => {
      const token1 = await manager.generateToken('skill1', { page: 1 }, 'tier_1');
      const token2 = await manager.generateToken('skill1', { page: 1 }, 'tier_1');
      expect(token1.nonce).not.toBe(token2.nonce);
    });

    it('stores the token in the database', async () => {
      const token = await manager.generateToken('skill1', { page: 1 }, 'tier_1');
      const row = db.get<{ nonce: string }>(
        'SELECT nonce FROM confirmation_nonces WHERE nonce = ?',
        token.nonce,
      );
      expect(row).toBeDefined();
      expect(row!.nonce).toBe(token.nonce);
    });
  });

  // ─── Token Verification ────────────────────────────────────────

  describe('verifyToken', () => {
    it('returns valid=true for a fresh token', async () => {
      const token = await manager.generateToken('skill1', {}, 'tier_1');
      const result = manager.verifyToken(token.nonce);
      expect(result.valid).toBe(true);
      expect(result.token).toBeDefined();
      expect(result.token!.skillId).toBe('skill1');
    });

    it('returns valid=false for an unknown token', () => {
      const result = manager.verifyToken('nonexistent-token-id');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Token not found');
    });

    it('returns valid=false for an expired token', async () => {
      vi.useFakeTimers();
      try {
        // Create a token with short expiry
        const shortExpiryConfig = makeConfig({ confirmationExpiryMs: 100 });
        const shortManager = new ConfirmationManager(db, shortExpiryConfig);
        const token = await shortManager.generateToken('skill1', {}, 'tier_1');

        // Advance past expiry
        vi.advanceTimersByTime(200);

        const result = shortManager.verifyToken(token.nonce);
        expect(result.valid).toBe(false);
        expect(result.error).toBe('Token expired');
      } finally {
        vi.useRealTimers();
      }
    });

    it('returns valid=false for an already consumed token', async () => {
      const token = await manager.generateToken('skill1', {}, 'tier_1');
      // Consume it
      manager.consumeToken(token.nonce, true);

      const result = manager.verifyToken(token.nonce);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Token already consumed');
    });
  });

  // ─── Token Consumption (approve/deny) ─────────────────────────

  describe('consumeToken', () => {
    it('marks token as consumed on approval', async () => {
      const token = await manager.generateToken('skill1', {}, 'tier_1');
      manager.consumeToken(token.nonce, true, 'test-user');

      const row = db.get<{ consumed: number }>(
        'SELECT consumed FROM confirmation_nonces WHERE nonce = ?',
        token.nonce,
      );
      expect(row!.consumed).toBe(1);
    });

    it('creates global skill confirmation on approval', async () => {
      const token = await manager.generateToken('skill1', {}, 'tier_1');
      manager.consumeToken(token.nonce, true, 'test-user');

      const confirmation = db.get<{ confirmation_status: string; approved_by: string }>(
        'SELECT confirmation_status, approved_by FROM skill_confirmations WHERE skill_id = ?',
        'skill1',
      );
      expect(confirmation).toBeDefined();
      expect(confirmation!.confirmation_status).toBe('approved');
      expect(confirmation!.approved_by).toBe('test-user');
    });

    it('records denial and invalidates all nonces for the skill', async () => {
      const token1 = await manager.generateToken('skill1', {}, 'tier_1');
      const token2 = await manager.generateToken('skill1', { page: 2 }, 'tier_1');

      // Deny with first token
      manager.consumeToken(token1.nonce, false);

      // Check denial record
      const confirmation = db.get<{ confirmation_status: string }>(
        'SELECT confirmation_status FROM skill_confirmations WHERE skill_id = ?',
        'skill1',
      );
      expect(confirmation!.confirmation_status).toBe('denied');

      // Second token should also be consumed (invalidated)
      const row = db.get<{ consumed: number }>(
        'SELECT consumed FROM confirmation_nonces WHERE nonce = ?',
        token2.nonce,
      );
      expect(row!.consumed).toBe(1);
    });

    it('rejects double-consumption (second verify after consume returns false)', async () => {
      const token = await manager.generateToken('skill1', {}, 'tier_1');
      manager.consumeToken(token.nonce, true);

      // Attempting to verify again should fail
      const result = manager.verifyToken(token.nonce);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Token already consumed');
    });
  });

  // ─── isSkillConfirmed ──────────────────────────────────────────

  describe('isSkillConfirmed', () => {
    it('returns false when no confirmation exists', () => {
      expect(manager.isSkillConfirmed('skill1')).toBe(false);
    });

    it('returns true after skill is approved', async () => {
      const token = await manager.generateToken('skill1', {}, 'tier_1');
      manager.consumeToken(token.nonce, true);
      expect(manager.isSkillConfirmed('skill1')).toBe(true);
    });

    it('returns false after skill is denied', async () => {
      const token = await manager.generateToken('skill1', {}, 'tier_1');
      manager.consumeToken(token.nonce, false);
      expect(manager.isSkillConfirmed('skill1')).toBe(false);
    });
  });

  // ─── revokeApproval ──────────────────────────────────────────────

  describe('revokeApproval', () => {
    it('revokes a previously-approved skill', async () => {
      // Approve first
      const token = await manager.generateToken('skill1', {}, 'tier_1');
      manager.consumeToken(token.nonce, true, 'test-user');
      expect(manager.isSkillConfirmed('skill1')).toBe(true);

      // Revoke
      manager.revokeApproval('skill1');
      expect(manager.isSkillConfirmed('skill1')).toBe(false);
    });

    it('invalidates outstanding nonces for the revoked skill', async () => {
      // Approve first
      const approveToken = await manager.generateToken('skill1', {}, 'tier_1');
      manager.consumeToken(approveToken.nonce, true);

      // Generate a new nonce while skill is approved
      const pendingToken = await manager.generateToken('skill1', { page: 2 }, 'tier_1');

      // Revoke — should invalidate pending nonce
      manager.revokeApproval('skill1');

      const result = manager.verifyToken(pendingToken.nonce);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Token already consumed');
    });

    it('is a no-op for non-approved skills', () => {
      // Should not throw
      manager.revokeApproval('skill1');
      expect(manager.isSkillConfirmed('skill1')).toBe(false);
    });

    it('does not affect other skills', async () => {
      // Approve both skills
      const token1 = await manager.generateToken('skill1', {}, 'tier_1');
      manager.consumeToken(token1.nonce, true);
      const token2 = await manager.generateToken('skill2', {}, 'tier_1');
      manager.consumeToken(token2.nonce, true);

      expect(manager.isSkillConfirmed('skill1')).toBe(true);
      expect(manager.isSkillConfirmed('skill2')).toBe(true);

      // Revoke only skill1
      manager.revokeApproval('skill1');
      expect(manager.isSkillConfirmed('skill1')).toBe(false);
      expect(manager.isSkillConfirmed('skill2')).toBe(true);
    });
  });

  // ─── HMAC Key Fallback ─────────────────────────────────────────

  describe('HMAC key fallback', () => {
    it('generates tokens even when keychain is unavailable', async () => {
      mockKeytarShouldFail = true;
      // Need a fresh manager to pick up the ephemeral key path
      const freshManager = new ConfirmationManager(db, config);
      const token = await freshManager.generateToken('skill1', {}, 'tier_1');
      expect(token.nonce).toBeDefined();
      expect(typeof token.nonce).toBe('string');
      expect(token.nonce.length).toBeGreaterThan(0);
    });
  });

  // ─── Concurrent Access Safety ──────────────────────────────────

  describe('concurrent access', () => {
    it('handles multiple concurrent token generations without errors', async () => {
      const promises = Array.from({ length: 10 }, (_, i) =>
        manager.generateToken('skill1', { i }, 'tier_1'),
      );
      const tokens = await Promise.all(promises);

      // All tokens should be unique
      const nonces = tokens.map((t) => t.nonce);
      expect(new Set(nonces).size).toBe(10);
    });

    it('concurrent verifications of same token are consistent', async () => {
      const token = await manager.generateToken('skill1', {}, 'tier_1');
      const results = Array.from({ length: 5 }, () => manager.verifyToken(token.nonce));
      // All should return valid since token is not consumed
      expect(results.every((r) => r.valid)).toBe(true);
    });
  });

  // ─── verifyAndConsume (atomic race-condition-safe) ─────────────

  describe('verifyAndConsume', () => {
    it('returns valid=true and consumes token on first call', async () => {
      const token = await manager.generateToken('skill1', {}, 'tier_1');
      const result = manager.verifyAndConsume(token.nonce, true, 'test-user');

      expect(result.valid).toBe(true);
      expect(result.token).toBeDefined();
      expect(result.token!.skillId).toBe('skill1');

      // Token should be consumed in DB
      const row = db.get<{ consumed: number }>(
        'SELECT consumed FROM confirmation_nonces WHERE nonce = ?',
        token.nonce,
      );
      expect(row!.consumed).toBe(1);
    });

    it('second call with same token returns valid=false (double-consume prevention)', async () => {
      const token = await manager.generateToken('skill1', {}, 'tier_1');

      const first = manager.verifyAndConsume(token.nonce, true);
      expect(first.valid).toBe(true);

      const second = manager.verifyAndConsume(token.nonce, true);
      expect(second.valid).toBe(false);
      expect(second.error).toBe('Token already consumed');
    });

    it('returns expired error for an expired token', async () => {
      vi.useFakeTimers();
      try {
        // Create a token with short expiry
        const shortExpiryConfig = makeConfig({ confirmationExpiryMs: 100 });
        const shortManager = new ConfirmationManager(db, shortExpiryConfig);
        const token = await shortManager.generateToken('skill1', {}, 'tier_1');

        // Advance past expiry
        vi.advanceTimersByTime(200);

        const result = shortManager.verifyAndConsume(token.nonce, true);
        expect(result.valid).toBe(false);
        expect(result.error).toBe('Token expired');
      } finally {
        vi.useRealTimers();
      }
    });

    it('deny invalidates all sibling nonces for the same skill', async () => {
      const token1 = await manager.generateToken('skill1', {}, 'tier_1');
      const token2 = await manager.generateToken('skill1', { page: 2 }, 'tier_1');
      const token3 = await manager.generateToken('skill2', {}, 'tier_1'); // different skill

      // Deny with first token
      const result = manager.verifyAndConsume(token1.nonce, false);
      expect(result.valid).toBe(true);

      // Second token for same skill should be invalidated
      const sibling = manager.verifyAndConsume(token2.nonce, true);
      expect(sibling.valid).toBe(false);
      expect(sibling.error).toBe('Token already consumed');

      // Token for a different skill should still be valid
      const other = manager.verifyAndConsume(token3.nonce, true);
      expect(other.valid).toBe(true);
    });

    it('creates global skill confirmation on approve', async () => {
      const token = await manager.generateToken('skill1', {}, 'tier_1');
      manager.verifyAndConsume(token.nonce, true, 'admin');

      expect(manager.isSkillConfirmed('skill1')).toBe(true);

      const confirmation = db.get<{ approved_by: string }>(
        'SELECT approved_by FROM skill_confirmations WHERE skill_id = ?',
        'skill1',
      );
      expect(confirmation!.approved_by).toBe('admin');
    });

    it('records denial status on deny', async () => {
      const token = await manager.generateToken('skill1', {}, 'tier_1');
      manager.verifyAndConsume(token.nonce, false);

      expect(manager.isSkillConfirmed('skill1')).toBe(false);

      const confirmation = db.get<{ confirmation_status: string }>(
        'SELECT confirmation_status FROM skill_confirmations WHERE skill_id = ?',
        'skill1',
      );
      expect(confirmation!.confirmation_status).toBe('denied');
    });

    it('returns token not found for unknown token', () => {
      const result = manager.verifyAndConsume('nonexistent', true);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Token not found');
    });
  });
});
