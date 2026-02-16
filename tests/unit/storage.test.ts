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
    dataDir: '/tmp/oneagent-storage-test',
    logLevel: 'silent',
  }),
  getDbPath: () => ':memory:',
  ensureDirectories: vi.fn(),
}));

import Database from 'better-sqlite3';
import { SkillRepository } from '../../src/storage/skill-repository.js';
import { SiteRepository } from '../../src/storage/site-repository.js';
import type { AgentDatabase } from '../../src/storage/database.js';
import type { SkillSpec, SiteManifest } from '../../src/skill/types.js';

// ─── In-Memory DB Setup ──────────────────────────────────────────

function createTestDb(): AgentDatabase & { close: () => void } {
  const raw = new Database(':memory:');
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');

  // Run migrations (inlined from database.ts)
  raw.exec(`
    CREATE TABLE IF NOT EXISTS sites (
      id              TEXT PRIMARY KEY,
      display_name    TEXT,
      first_seen      INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      last_visited    INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      mastery_level   TEXT NOT NULL DEFAULT 'explore',
      recommended_tier TEXT NOT NULL DEFAULT 'browser_proxied',
      total_requests  INTEGER NOT NULL DEFAULT 0,
      successful_requests INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS skills (
      id                TEXT PRIMARY KEY,
      site_id           TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      name              TEXT NOT NULL,
      version           INTEGER NOT NULL DEFAULT 1,
      status            TEXT NOT NULL DEFAULT 'draft',
      description       TEXT,
      method            TEXT NOT NULL,
      path_template     TEXT NOT NULL,
      input_schema      TEXT NOT NULL DEFAULT '{}',
      output_schema     TEXT,
      auth_type         TEXT,
      required_headers  TEXT,
      dynamic_headers   TEXT,
      side_effect_class TEXT NOT NULL DEFAULT 'read-only',
      is_composite      INTEGER NOT NULL DEFAULT 0,
      chain_spec        TEXT,
      current_tier      TEXT NOT NULL DEFAULT 'tier_3',
      tier_lock         TEXT,
      confidence        REAL NOT NULL DEFAULT 0.0,
      consecutive_validations INTEGER NOT NULL DEFAULT 0,
      sample_count      INTEGER NOT NULL DEFAULT 0,
      parameter_evidence TEXT,
      last_verified     INTEGER,
      last_used         INTEGER,
      success_rate      REAL NOT NULL DEFAULT 0.0,
      skill_md          TEXT,
      openapi_fragment  TEXT,
      created_at        INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      updated_at        INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      allowed_domains TEXT NOT NULL DEFAULT '[]',
      required_capabilities TEXT NOT NULL DEFAULT '[]',
      parameters TEXT NOT NULL DEFAULT '[]',
      validation TEXT NOT NULL DEFAULT '{"semanticChecks":[],"customInvariants":[]}',
      redaction TEXT NOT NULL DEFAULT '{"piiClassesFound":[],"fieldsRedacted":0}',
      replay_strategy TEXT NOT NULL DEFAULT 'prefer_tier_3',
      UNIQUE(site_id, name, version)
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
    transaction<T>(fn: () => T): T {
      return raw.transaction(fn)();
    },
    close() {
      raw.close();
    },
    get raw() {
      return raw;
    },
  } as unknown as AgentDatabase & { close: () => void };

  return db;
}

function makeSkill(overrides?: Partial<SkillSpec>): SkillSpec {
  const now = Date.now();
  return {
    id: 'example.com.get_users.v1',
    siteId: 'example.com',
    name: 'get_users',
    version: 1,
    status: 'active',
    description: 'Get list of users',
    method: 'GET',
    pathTemplate: '/api/users',
    inputSchema: { type: 'object', properties: { page: { type: 'number' } } },
    sideEffectClass: 'read-only',
    isComposite: false,
    currentTier: 'tier_1',
    tierLock: null,
    confidence: 0.95,
    consecutiveValidations: 5,
    sampleCount: 10,
    successRate: 0.98,
    createdAt: now,
    updatedAt: now,
    allowedDomains: ['example.com', 'api.example.com'],
    requiredCapabilities: ['net.fetch.direct'],
    parameters: [
      { name: 'page', type: 'number', source: 'user_input', evidence: ['query param'] },
    ],
    validation: {
      semanticChecks: ['status_2xx'],
      customInvariants: ['must include field data'],
    },
    redaction: {
      piiClassesFound: ['email'],
      fieldsRedacted: 2,
    },
    replayStrategy: 'prefer_tier_1',
    ...overrides,
  } as SkillSpec;
}

function makeSite(overrides?: Partial<SiteManifest>): SiteManifest {
  const now = Date.now();
  return {
    id: 'example.com',
    displayName: 'Example Site',
    firstSeen: now,
    lastVisited: now,
    masteryLevel: 'full',
    recommendedTier: 'direct',
    totalRequests: 100,
    successfulRequests: 98,
    ...overrides,
  } as SiteManifest;
}

describe('Storage Repositories', () => {
  let db: AgentDatabase & { close: () => void };

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* best effort — don't mask test failures */ }
  });

  // ─── SiteRepository ────────────────────────────────────────────

  describe('SiteRepository', () => {
    let siteRepo: SiteRepository;

    beforeEach(() => {
      siteRepo = new SiteRepository(db);
    });

    describe('CRUD operations', () => {
      it('creates and retrieves a site', () => {
        const site = makeSite();
        siteRepo.create(site);

        const retrieved = siteRepo.getById('example.com');
        expect(retrieved).toBeDefined();
        expect(retrieved!.id).toBe('example.com');
        expect(retrieved!.displayName).toBe('Example Site');
        expect(retrieved!.masteryLevel).toBe('full');
        expect(retrieved!.recommendedTier).toBe('direct');
        expect(retrieved!.totalRequests).toBe(100);
        expect(retrieved!.successfulRequests).toBe(98);
      });

      it('returns undefined for non-existent site', () => {
        expect(siteRepo.getById('nonexistent.com')).toBeUndefined();
      });

      it('lists all sites', () => {
        siteRepo.create(makeSite({ id: 'site1.com', displayName: 'Site 1' }));
        siteRepo.create(makeSite({ id: 'site2.com', displayName: 'Site 2' }));

        const all = siteRepo.getAll();
        expect(all).toHaveLength(2);
      });

      it('updates site fields', () => {
        siteRepo.create(makeSite());
        siteRepo.update('example.com', {
          displayName: 'Updated Example',
          masteryLevel: 'explore',
          totalRequests: 200,
        });

        const updated = siteRepo.getById('example.com');
        expect(updated!.displayName).toBe('Updated Example');
        expect(updated!.masteryLevel).toBe('explore');
        expect(updated!.totalRequests).toBe(200);
      });

      it('deletes a site', () => {
        siteRepo.create(makeSite());
        siteRepo.delete('example.com');
        expect(siteRepo.getById('example.com')).toBeUndefined();
      });
    });

    describe('updateMetrics', () => {
      it('increments total and successful on success', () => {
        siteRepo.create(makeSite({ totalRequests: 10, successfulRequests: 8 }));
        siteRepo.updateMetrics('example.com', true);

        const site = siteRepo.getById('example.com');
        expect(site!.totalRequests).toBe(11);
        expect(site!.successfulRequests).toBe(9);
      });

      it('increments only total on failure', () => {
        siteRepo.create(makeSite({ totalRequests: 10, successfulRequests: 8 }));
        siteRepo.updateMetrics('example.com', false);

        const site = siteRepo.getById('example.com');
        expect(site!.totalRequests).toBe(11);
        expect(site!.successfulRequests).toBe(8);
      });
    });
  });

  // ─── SkillRepository ──────────────────────────────────────────

  describe('SkillRepository', () => {
    let skillRepo: SkillRepository;

    beforeEach(() => {
      // Must create site first (FK constraint)
      const siteRepo = new SiteRepository(db);
      siteRepo.create(makeSite());
      skillRepo = new SkillRepository(db);
    });

    describe('CRUD operations', () => {
      it('creates and retrieves a skill', () => {
        const skill = makeSkill();
        skillRepo.create(skill);

        const retrieved = skillRepo.getById('example.com.get_users.v1');
        expect(retrieved).toBeDefined();
        expect(retrieved!.id).toBe('example.com.get_users.v1');
        expect(retrieved!.siteId).toBe('example.com');
        expect(retrieved!.name).toBe('get_users');
        expect(retrieved!.method).toBe('GET');
        expect(retrieved!.pathTemplate).toBe('/api/users');
        expect(retrieved!.status).toBe('active');
        expect(retrieved!.confidence).toBe(0.95);
      });

      it('returns undefined for non-existent skill', () => {
        expect(skillRepo.getById('nonexistent')).toBeUndefined();
      });

      it('gets skills by site ID', () => {
        skillRepo.create(makeSkill());
        skillRepo.create(makeSkill({
          id: 'example.com.get_user.v1',
          name: 'get_user',
          pathTemplate: '/api/users/:id',
        }));

        const skills = skillRepo.getBySiteId('example.com');
        expect(skills).toHaveLength(2);
      });

      it('gets active skills only', () => {
        skillRepo.create(makeSkill({ status: 'active' }));
        skillRepo.create(makeSkill({
          id: 'example.com.draft.v1',
          name: 'draft_skill',
          status: 'draft',
        }));

        const active = skillRepo.getActive('example.com');
        expect(active).toHaveLength(1);
        expect(active[0].status).toBe('active');
      });

      it('gets skills by status', () => {
        skillRepo.create(makeSkill({ status: 'active' }));
        skillRepo.create(makeSkill({
          id: 'example.com.stale.v1',
          name: 'stale_skill',
          status: 'stale',
        }));

        const stale = skillRepo.getByStatus('stale');
        expect(stale).toHaveLength(1);
        expect(stale[0].name).toBe('stale_skill');
      });

      it('updates skill fields', () => {
        skillRepo.create(makeSkill());
        skillRepo.update('example.com.get_users.v1', {
          status: 'stale',
          confidence: 0.5,
          consecutiveValidations: 0,
        });

        const updated = skillRepo.getById('example.com.get_users.v1');
        expect(updated!.status).toBe('stale');
        expect(updated!.confidence).toBe(0.5);
        expect(updated!.consecutiveValidations).toBe(0);
      });

      it('updates tier', () => {
        skillRepo.create(makeSkill());
        skillRepo.updateTier('example.com.get_users.v1', 'tier_3');

        const updated = skillRepo.getById('example.com.get_users.v1');
        expect(updated!.currentTier).toBe('tier_3');
      });

      it('updates confidence', () => {
        skillRepo.create(makeSkill());
        skillRepo.updateConfidence('example.com.get_users.v1', 0.99, 10);

        const updated = skillRepo.getById('example.com.get_users.v1');
        expect(updated!.confidence).toBe(0.99);
        expect(updated!.consecutiveValidations).toBe(10);
      });

      it('deletes a skill', () => {
        skillRepo.create(makeSkill());
        skillRepo.delete('example.com.get_users.v1');
        expect(skillRepo.getById('example.com.get_users.v1')).toBeUndefined();
      });
    });

    // ─── JSON Field Round-Trip ────────────────────────────────────

    describe('JSON field round-trip', () => {
      it('allowedDomains survive create->read', () => {
        const skill = makeSkill({
          allowedDomains: ['example.com', 'api.example.com', 'cdn.example.com'],
        });
        skillRepo.create(skill);

        const retrieved = skillRepo.getById(skill.id);
        expect(retrieved!.allowedDomains).toEqual(['example.com', 'api.example.com', 'cdn.example.com']);
      });

      it('parameters survive create->read', () => {
        const skill = makeSkill({
          parameters: [
            { name: 'page', type: 'number', source: 'user_input', evidence: ['query param'] },
            { name: 'limit', type: 'number', source: 'user_input', evidence: ['query param'] },
          ],
        });
        skillRepo.create(skill);

        const retrieved = skillRepo.getById(skill.id);
        expect(retrieved!.parameters).toHaveLength(2);
        expect(retrieved!.parameters[0].name).toBe('page');
        expect(retrieved!.parameters[1].name).toBe('limit');
      });

      it('validation survive create->read', () => {
        const skill = makeSkill({
          validation: {
            semanticChecks: ['status_2xx', 'no_error_signatures'],
            customInvariants: ['must include field data', 'field items must be non-empty'],
          },
        });
        skillRepo.create(skill);

        const retrieved = skillRepo.getById(skill.id);
        expect(retrieved!.validation.semanticChecks).toEqual(['status_2xx', 'no_error_signatures']);
        expect(retrieved!.validation.customInvariants).toEqual([
          'must include field data',
          'field items must be non-empty',
        ]);
      });

      it('redaction survive create->read', () => {
        const skill = makeSkill({
          redaction: {
            piiClassesFound: ['email', 'phone', 'name'],
            fieldsRedacted: 5,
          },
        });
        skillRepo.create(skill);

        const retrieved = skillRepo.getById(skill.id);
        expect(retrieved!.redaction.piiClassesFound).toEqual(['email', 'phone', 'name']);
        expect(retrieved!.redaction.fieldsRedacted).toBe(5);
      });

      it('replayStrategy survives create->read', () => {
        const skill = makeSkill({ replayStrategy: 'prefer_tier_1' });
        skillRepo.create(skill);

        const retrieved = skillRepo.getById(skill.id);
        expect(retrieved!.replayStrategy).toBe('prefer_tier_1');
      });

      it('requiredCapabilities survive create->read', () => {
        const skill = makeSkill({
          requiredCapabilities: ['net.fetch.direct', 'browser.automation'],
        });
        skillRepo.create(skill);

        const retrieved = skillRepo.getById(skill.id);
        expect(retrieved!.requiredCapabilities).toEqual(['net.fetch.direct', 'browser.automation']);
      });

      it('inputSchema survives create->read', () => {
        const schema = {
          type: 'object',
          properties: {
            page: { type: 'number' },
            query: { type: 'string' },
          },
          required: ['query'],
        };
        const skill = makeSkill({ inputSchema: schema });
        skillRepo.create(skill);

        const retrieved = skillRepo.getById(skill.id);
        expect(retrieved!.inputSchema).toEqual(schema);
      });

      it('tierLock survives create->read (permanent lock)', () => {
        const tierLock = {
          type: 'permanent' as const,
          reason: 'js_computed_field' as const,
          evidence: 'x-signature header detected',
        };
        const skill = makeSkill({ tierLock });
        skillRepo.create(skill);

        const retrieved = skillRepo.getById(skill.id);
        expect(retrieved!.tierLock).toEqual(tierLock);
      });

      it('null tierLock survives create->read', () => {
        const skill = makeSkill({ tierLock: null });
        skillRepo.create(skill);

        const retrieved = skillRepo.getById(skill.id);
        expect(retrieved!.tierLock).toBeNull();
      });
    });

    // ─── Edge cases ──────────────────────────────────────────────

    describe('edge cases', () => {
      it('handles empty allowedDomains', () => {
        const skill = makeSkill({ allowedDomains: [] });
        skillRepo.create(skill);

        const retrieved = skillRepo.getById(skill.id);
        expect(retrieved!.allowedDomains).toEqual([]);
      });

      it('handles empty parameters', () => {
        const skill = makeSkill({ parameters: [] });
        skillRepo.create(skill);

        const retrieved = skillRepo.getById(skill.id);
        expect(retrieved!.parameters).toEqual([]);
      });

      it('update with no fields is a no-op', () => {
        skillRepo.create(makeSkill());
        // Should not throw
        skillRepo.update('example.com.get_users.v1', {});

        const retrieved = skillRepo.getById('example.com.get_users.v1');
        expect(retrieved).toBeDefined();
      });
    });
  });

  // ─── Database Migration ────────────────────────────────────────

  describe('Database migration', () => {
    it('creates tables via schema setup', () => {
      // The createTestDb() function runs migration SQL
      // Verify the tables exist by querying them
      const sites = db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sites'",
      );
      expect(sites).toHaveLength(1);

      const skills = db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='skills'",
      );
      expect(skills).toHaveLength(1);
    });

    it('sites table has expected columns', () => {
      const info = db.all<{ name: string }>('PRAGMA table_info(sites)');
      const columnNames = info.map((c) => c.name);
      expect(columnNames).toContain('id');
      expect(columnNames).toContain('display_name');
      expect(columnNames).toContain('mastery_level');
      expect(columnNames).toContain('recommended_tier');
    });

    it('skills table has JSON columns', () => {
      const info = db.all<{ name: string }>('PRAGMA table_info(skills)');
      const columnNames = info.map((c) => c.name);
      expect(columnNames).toContain('allowed_domains');
      expect(columnNames).toContain('required_capabilities');
      expect(columnNames).toContain('parameters');
      expect(columnNames).toContain('validation');
      expect(columnNames).toContain('redaction');
      expect(columnNames).toContain('replay_strategy');
    });
  });
});
