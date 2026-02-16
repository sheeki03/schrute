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
    dataDir: '/tmp/oneagent-confirm-test',
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

import Database from 'better-sqlite3';
import { ConfirmationManager } from '../../src/server/confirmation.js';
import type { AgentDatabase } from '../../src/storage/database.js';
import type { OneAgentConfig } from '../../src/skill/types.js';

// ─── In-Memory DB Setup ──────────────────────────────────────────

function createTestDb(): AgentDatabase {
  const raw = new Database(':memory:');
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');

  // Create the tables needed by ConfirmationManager
  raw.exec(`
    CREATE TABLE IF NOT EXISTS sites (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      first_seen INTEGER NOT NULL DEFAULT 0,
      last_visited INTEGER NOT NULL DEFAULT 0,
      mastery_level TEXT NOT NULL DEFAULT 'explore',
      recommended_tier TEXT NOT NULL DEFAULT 'browser_proxied',
      total_requests INTEGER NOT NULL DEFAULT 0,
      successful_requests INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'draft',
      description TEXT,
      method TEXT NOT NULL,
      path_template TEXT NOT NULL,
      input_schema TEXT NOT NULL DEFAULT '{}',
      output_schema TEXT,
      auth_type TEXT,
      required_headers TEXT,
      dynamic_headers TEXT,
      side_effect_class TEXT NOT NULL DEFAULT 'read-only',
      is_composite INTEGER NOT NULL DEFAULT 0,
      chain_spec TEXT,
      current_tier TEXT NOT NULL DEFAULT 'tier_3',
      tier_lock TEXT,
      confidence REAL NOT NULL DEFAULT 0.0,
      consecutive_validations INTEGER NOT NULL DEFAULT 0,
      sample_count INTEGER NOT NULL DEFAULT 0,
      parameter_evidence TEXT,
      last_verified INTEGER,
      last_used INTEGER,
      success_rate REAL NOT NULL DEFAULT 0.0,
      skill_md TEXT,
      openapi_fragment TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      allowed_domains TEXT NOT NULL DEFAULT '[]',
      required_capabilities TEXT NOT NULL DEFAULT '[]',
      parameters TEXT NOT NULL DEFAULT '[]',
      validation TEXT NOT NULL DEFAULT '{}',
      redaction TEXT NOT NULL DEFAULT '{}',
      replay_strategy TEXT NOT NULL DEFAULT 'prefer_tier_3',
      UNIQUE(site_id, name, version)
    );

    CREATE TABLE IF NOT EXISTS skill_confirmations (
      skill_id TEXT PRIMARY KEY REFERENCES skills(id) ON DELETE CASCADE,
      confirmation_status TEXT NOT NULL DEFAULT 'pending',
      approved_by TEXT,
      approved_at INTEGER,
      denied_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS confirmation_nonces (
      nonce TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      params_hash TEXT NOT NULL,
      tier TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0,
      consumed_at INTEGER
    );
  `);

  // Insert test site and skill
  raw.exec(`
    INSERT INTO sites (id, display_name) VALUES ('example.com', 'Example');
    INSERT INTO skills (id, site_id, name, method, path_template) VALUES ('skill1', 'example.com', 'test_skill', 'GET', '/api/test');
    INSERT INTO skills (id, site_id, name, method, path_template) VALUES ('skill2', 'example.com', 'test_skill2', 'POST', '/api/test2');
  `);

  // Wrap as AgentDatabase-like
  const db = {
    run(sql: string, ...params: unknown[]) {
      return raw.prepare(sql).run(...params);
    },
    get<T = unknown>(sql: string, ...params: unknown[]): T | undefined {
      return raw.prepare(sql).get(...params) as T | undefined;
    },
    all<T = unknown>(sql: string, ...params: unknown[]): T[] {
      return raw.prepare(sql).all(...params) as T[];
    },
    exec(sql: string) {
      raw.exec(sql);
    },
    close() {
      raw.close();
    },
    get raw() {
      return raw;
    },
  } as unknown as AgentDatabase;

  return db;
}

function makeConfig(overrides?: Partial<OneAgentConfig>): OneAgentConfig {
  return {
    dataDir: '/tmp/oneagent-confirm-test',
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

describe('ConfirmationManager', () => {
  let db: AgentDatabase;
  let manager: ConfirmationManager;
  let config: OneAgentConfig;

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
      // Create a token with very short expiry
      const shortExpiryConfig = makeConfig({ confirmationExpiryMs: 1 });
      const shortManager = new ConfirmationManager(db, shortExpiryConfig);
      const token = await shortManager.generateToken('skill1', {}, 'tier_1');

      // Wait for expiry
      await new Promise((resolve) => setTimeout(resolve, 10));

      const result = shortManager.verifyToken(token.nonce);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Token expired');
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
});
