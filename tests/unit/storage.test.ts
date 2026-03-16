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
    dataDir: '/tmp/schrute-storage-test',
    logLevel: 'silent',
  }),
  getDbPath: () => ':memory:',
  ensureDirectories: vi.fn(),
}));

import { SkillRepository } from '../../src/storage/skill-repository.js';
import { SiteRepository } from '../../src/storage/site-repository.js';
import type { AgentDatabase } from '../../src/storage/database.js';
import { MIGRATIONS } from '../../src/storage/database.js';
import type { SkillSpec, SiteManifest } from '../../src/skill/types.js';
import { createFullSchemaDb } from '../helpers.js';

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
    db = createFullSchemaDb();
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

      it('throws on invalid status value read from DB', () => {
        // Insert a row directly with an invalid status
        const now = Date.now();
        db.run(
          `INSERT INTO skills (id, site_id, name, version, status, method, path_template,
           input_schema, side_effect_class, current_tier, confidence,
           consecutive_validations, sample_count, success_rate, created_at, updated_at,
           allowed_domains, required_capabilities, parameters, validation, redaction, replay_strategy)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          'bad.status.v1', 'example.com', 'bad_status', 1, 'INVALID_STATUS', 'GET', '/api/bad',
          '{}', 'read-only', 'tier_1', 0.5,
          0, 0, 0.0, now, now,
          '[]', '[]', '[]', '{"semanticChecks":[],"customInvariants":[]}',
          '{"piiClassesFound":[],"fieldsRedacted":0}', 'prefer_tier_1',
        );

        expect(() => skillRepo.getById('bad.status.v1')).toThrow(/invalid skill status/i);
      });

      it('throws on invalid tier value read from DB', () => {
        const now = Date.now();
        db.run(
          `INSERT INTO skills (id, site_id, name, version, status, method, path_template,
           input_schema, side_effect_class, current_tier, confidence,
           consecutive_validations, sample_count, success_rate, created_at, updated_at,
           allowed_domains, required_capabilities, parameters, validation, redaction, replay_strategy)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          'bad.tier.v1', 'example.com', 'bad_tier', 1, 'active', 'GET', '/api/bad',
          '{}', 'read-only', 'INVALID_TIER', 0.5,
          0, 0, 0.0, now, now,
          '[]', '[]', '[]', '{"semanticChecks":[],"customInvariants":[]}',
          '{"piiClassesFound":[],"fieldsRedacted":0}', 'prefer_tier_1',
        );

        expect(() => skillRepo.getById('bad.tier.v1')).toThrow(/invalid tier state/i);
      });

      it('falls back to null for malformed JSON in tier_lock column', () => {
        const now = Date.now();
        db.run(
          `INSERT INTO skills (id, site_id, name, version, status, method, path_template,
           input_schema, side_effect_class, current_tier, tier_lock, confidence,
           consecutive_validations, sample_count, success_rate, created_at, updated_at,
           allowed_domains, required_capabilities, parameters, validation, redaction, replay_strategy)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          'bad.json.v1', 'example.com', 'bad_json', 1, 'active', 'GET', '/api/bad',
          '{}', 'read-only', 'tier_1', '{not valid json}', 0.5,
          0, 0, 0.0, now, now,
          '[]', '[]', '[]', '{"semanticChecks":[],"customInvariants":[]}',
          '{"piiClassesFound":[],"fieldsRedacted":0}', 'prefer_tier_1',
        );

        // parseJson catches parse errors and uses the fallback (null for tier_lock)
        const retrieved = skillRepo.getById('bad.json.v1');
        expect(retrieved).toBeDefined();
        expect(retrieved!.tierLock).toBeNull();
      });

      it('falls back to null for invalid TierLock shape (unknown type)', () => {
        const now = Date.now();
        db.run(
          `INSERT INTO skills (id, site_id, name, version, status, method, path_template,
           input_schema, side_effect_class, current_tier, tier_lock, confidence,
           consecutive_validations, sample_count, success_rate, created_at, updated_at,
           allowed_domains, required_capabilities, parameters, validation, redaction, replay_strategy)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          'bad.lock.v1', 'example.com', 'bad_lock', 1, 'active', 'GET', '/api/bad',
          '{}', 'read-only', 'tier_1', '{"type":"bogus"}', 0.5,
          0, 0, 0.0, now, now,
          '[]', '[]', '[]', '{"semanticChecks":[],"customInvariants":[]}',
          '{"piiClassesFound":[],"fieldsRedacted":0}', 'prefer_tier_1',
        );

        // Shape validator throws internally, parseJson catches and uses fallback (null)
        const retrieved = skillRepo.getById('bad.lock.v1');
        expect(retrieved).toBeDefined();
        expect(retrieved!.tierLock).toBeNull();
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

    it('all expected tables exist after running migrations', () => {
      const tables = db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).map(r => r.name);

      // Core tables from migration 001
      expect(tables).toContain('sites');
      expect(tables).toContain('skills');
      expect(tables).toContain('auth_flows');
      expect(tables).toContain('action_frames');
      expect(tables).toContain('action_frame_entries');
      expect(tables).toContain('skill_confirmations');
      expect(tables).toContain('confirmation_nonces');
      expect(tables).toContain('skill_metrics');
      expect(tables).toContain('policies');
      // Migration 002: webmcp
      expect(tables).toContain('webmcp_tools');
      // Migration 004: exemplars
      expect(tables).toContain('skill_exemplars');
      // Migration 005: amendments
      expect(tables).toContain('skill_amendments');
      // Migration tracking
      expect(tables).toContain('schema_migrations');
    });

    it('all MIGRATIONS entries are recorded in schema_migrations', () => {
      const applied = db.all<{ filename: string }>(
        'SELECT filename FROM schema_migrations ORDER BY id',
      ).map(r => r.filename);

      for (const migration of MIGRATIONS) {
        expect(applied).toContain(migration.filename);
      }
      expect(applied).toHaveLength(MIGRATIONS.length);
    });
  });
});
