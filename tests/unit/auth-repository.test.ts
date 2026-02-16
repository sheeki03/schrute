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

// ─── Mock config ─────────────────────────────────────────────────
vi.mock('../../src/core/config.js', () => ({
  getConfig: () => ({
    dataDir: '/tmp/oneagent-auth-repo-test',
    logLevel: 'silent',
    daemon: { port: 19420, autoStart: false },
  }),
  getDbPath: () => ':memory:',
  ensureDirectories: vi.fn(),
}));

import Database from 'better-sqlite3';
import { AuthRepository } from '../../src/storage/auth-repository.js';
import type { AuthFlow } from '../../src/storage/auth-repository.js';
import type { AgentDatabase } from '../../src/storage/database.js';
import type { AuthRecipe } from '../../src/skill/types.js';

// ─── In-Memory DB Setup ──────────────────────────────────────────

function createTestDb(): AgentDatabase & { close: () => void } {
  const raw = new Database(':memory:');
  raw.pragma('journal_mode = WAL');

  raw.exec(`
    CREATE TABLE IF NOT EXISTS auth_flows (
      id                 TEXT PRIMARY KEY,
      site_id            TEXT NOT NULL,
      type               TEXT NOT NULL,
      recipe             TEXT,
      token_keychain_ref TEXT,
      token_expires_at   INTEGER,
      last_refreshed     INTEGER
    );
  `);

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
  } as unknown as AgentDatabase & { close: () => void };

  return db;
}

// ─── Fixtures ────────────────────────────────────────────────────

function makeAuthFlow(overrides?: Partial<AuthFlow>): AuthFlow {
  return {
    id: 'auth-1',
    siteId: 'example.com',
    type: 'bearer',
    recipe: null,
    tokenKeychainRef: null,
    tokenExpiresAt: null,
    lastRefreshed: null,
    ...overrides,
  };
}

function makeRecipe(): AuthRecipe {
  return {
    type: 'bearer',
    injection: {
      location: 'header',
      key: 'Authorization',
      prefix: 'Bearer ',
    },
    refreshTriggers: ['401'],
    refreshMethod: 'oauth_refresh',
    refreshUrl: 'https://example.com/oauth/token',
  };
}

// ─── Tests ───────────────────────────────────────────────────────

describe('AuthRepository', () => {
  let db: AgentDatabase & { close: () => void };
  let repo: AuthRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new AuthRepository(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* best effort — don't mask test failures */ }
  });

  // ─── create() ──────────────────────────────────────────────────

  describe('create()', () => {
    it('creates auth flow with null recipe', () => {
      const flow = makeAuthFlow({ recipe: null });
      repo.create(flow);

      const retrieved = repo.getById('auth-1');
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe('auth-1');
      expect(retrieved!.siteId).toBe('example.com');
      expect(retrieved!.type).toBe('bearer');
      expect(retrieved!.recipe).toBeNull();
    });

    it('creates auth flow with populated recipe (JSON serialization)', () => {
      const recipe = makeRecipe();
      const flow = makeAuthFlow({ id: 'auth-recipe', recipe });
      repo.create(flow);

      const retrieved = repo.getById('auth-recipe');
      expect(retrieved).toBeDefined();
      expect(retrieved!.recipe).toBeDefined();
      expect(retrieved!.recipe).not.toBeNull();
      expect(retrieved!.recipe!.type).toBe('bearer');
      expect(retrieved!.recipe!.injection.location).toBe('header');
      expect(retrieved!.recipe!.injection.key).toBe('Authorization');
      expect(retrieved!.recipe!.injection.prefix).toBe('Bearer ');
      expect(retrieved!.recipe!.refreshTriggers).toEqual(['401']);
    });

    it('stores all optional fields correctly', () => {
      const now = Date.now();
      const flow = makeAuthFlow({
        id: 'auth-full',
        tokenKeychainRef: 'keychain://secret-token',
        tokenExpiresAt: now + 3600000,
        lastRefreshed: now,
      });
      repo.create(flow);

      const retrieved = repo.getById('auth-full');
      expect(retrieved!.tokenKeychainRef).toBe('keychain://secret-token');
      expect(retrieved!.tokenExpiresAt).toBe(now + 3600000);
      expect(retrieved!.lastRefreshed).toBe(now);
    });
  });

  // ─── getById() ─────────────────────────────────────────────────

  describe('getById()', () => {
    it('returns undefined for non-existent id', () => {
      expect(repo.getById('nonexistent')).toBeUndefined();
    });

    it('returns auth flow with correct type mapping', () => {
      repo.create(makeAuthFlow({ type: 'cookie' }));
      const retrieved = repo.getById('auth-1');
      expect(retrieved!.type).toBe('cookie');
    });
  });

  // ─── getBySiteId() ─────────────────────────────────────────────

  describe('getBySiteId()', () => {
    it('returns all flows for a site', () => {
      repo.create(makeAuthFlow({ id: 'auth-a', siteId: 'example.com', type: 'bearer' }));
      repo.create(makeAuthFlow({ id: 'auth-b', siteId: 'example.com', type: 'cookie' }));
      repo.create(makeAuthFlow({ id: 'auth-c', siteId: 'other.com', type: 'api_key' }));

      const exampleFlows = repo.getBySiteId('example.com');
      expect(exampleFlows).toHaveLength(2);
      expect(exampleFlows.map(f => f.id).sort()).toEqual(['auth-a', 'auth-b']);
    });

    it('returns empty array when no flows exist for site', () => {
      const flows = repo.getBySiteId('nonexistent.com');
      expect(flows).toEqual([]);
    });
  });

  // ─── update() dynamic SQL builder ─────────────────────────────

  describe('update()', () => {
    it('updates single field', () => {
      repo.create(makeAuthFlow());
      repo.update('auth-1', { type: 'api_key' });

      const retrieved = repo.getById('auth-1');
      expect(retrieved!.type).toBe('api_key');
    });

    it('updates multiple fields at once', () => {
      const now = Date.now();
      repo.create(makeAuthFlow());
      repo.update('auth-1', {
        type: 'oauth2',
        tokenKeychainRef: 'keychain://new-ref',
        lastRefreshed: now,
      });

      const retrieved = repo.getById('auth-1');
      expect(retrieved!.type).toBe('oauth2');
      expect(retrieved!.tokenKeychainRef).toBe('keychain://new-ref');
      expect(retrieved!.lastRefreshed).toBe(now);
    });

    it('updates recipe from null to populated', () => {
      repo.create(makeAuthFlow({ recipe: null }));
      repo.update('auth-1', { recipe: makeRecipe() });

      const retrieved = repo.getById('auth-1');
      expect(retrieved!.recipe).not.toBeNull();
      expect(retrieved!.recipe!.type).toBe('bearer');
    });

    it('updates recipe from populated to null', () => {
      repo.create(makeAuthFlow({ recipe: makeRecipe() }));
      repo.update('auth-1', { recipe: null });

      const retrieved = repo.getById('auth-1');
      expect(retrieved!.recipe).toBeNull();
    });

    it('no-ops when no fields provided', () => {
      repo.create(makeAuthFlow());
      // Should not throw
      repo.update('auth-1', {});
      const retrieved = repo.getById('auth-1');
      expect(retrieved!.type).toBe('bearer');
    });

    it('updates siteId field', () => {
      repo.create(makeAuthFlow());
      repo.update('auth-1', { siteId: 'new-site.com' });

      const retrieved = repo.getById('auth-1');
      expect(retrieved!.siteId).toBe('new-site.com');
    });

    it('updates tokenExpiresAt field', () => {
      repo.create(makeAuthFlow());
      const future = Date.now() + 7200000;
      repo.update('auth-1', { tokenExpiresAt: future });

      const retrieved = repo.getById('auth-1');
      expect(retrieved!.tokenExpiresAt).toBe(future);
    });
  });

  // ─── delete() ──────────────────────────────────────────────────

  describe('delete()', () => {
    it('removes auth flow', () => {
      repo.create(makeAuthFlow());
      repo.delete('auth-1');
      expect(repo.getById('auth-1')).toBeUndefined();
    });

    it('does not throw for non-existent id', () => {
      expect(() => repo.delete('nonexistent')).not.toThrow();
    });
  });

  // ─── rowToAuthFlow JSON recipe parsing ─────────────────────────

  describe('rowToAuthFlow JSON recipe round-trip', () => {
    it('correctly parses complex recipe from DB row', () => {
      const recipe = makeRecipe();
      repo.create(makeAuthFlow({ id: 'auth-json', recipe }));

      const retrieved = repo.getById('auth-json');
      expect(retrieved!.recipe).toEqual(recipe);
    });

    it('handles recipe with all optional fields', () => {
      const recipe: AuthRecipe = {
        type: 'oauth2',
        injection: {
          location: 'header',
          key: 'Authorization',
          prefix: 'Bearer ',
        },
        refreshTriggers: ['401', '403'],
        refreshMethod: 'oauth_refresh',
        refreshUrl: 'https://example.com/oauth/refresh',
      };
      repo.create(makeAuthFlow({ id: 'auth-complex', recipe }));

      const retrieved = repo.getById('auth-complex');
      expect(retrieved!.recipe!.refreshTriggers).toEqual(['401', '403']);
      expect(retrieved!.recipe!.refreshMethod).toBe('oauth_refresh');
    });
  });
});
