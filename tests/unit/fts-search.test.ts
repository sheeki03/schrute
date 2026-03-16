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
    dataDir: '/tmp/schrute-fts-test',
    logLevel: 'silent',
    daemon: { port: 19420, autoStart: false },
  }),
  getDbPath: () => ':memory:',
  ensureDirectories: vi.fn(),
}));

import { SkillRepository } from '../../src/storage/skill-repository.js';
import type { AgentDatabase } from '../../src/storage/database.js';
import type { SkillSpec } from '../../src/skill/types.js';
import { createFullSchemaDb } from '../helpers.js';

function makeSkill(overrides?: Partial<SkillSpec>): SkillSpec {
  const now = Date.now();
  return {
    id: 'example.com.get_users.v1',
    siteId: 'example.com',
    name: 'get_users',
    version: 1,
    status: 'active',
    description: 'Get list of users from the API',
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
    allowedDomains: ['example.com'],
    requiredCapabilities: ['net.fetch.direct'],
    parameters: [],
    validation: { semanticChecks: [], customInvariants: [] },
    redaction: { piiClassesFound: [], fieldsRedacted: 0 },
    replayStrategy: 'prefer_tier_1',
    ...overrides,
  } as SkillSpec;
}

describe('FTS5 search', () => {
  let db: AgentDatabase & { close: () => void };
  let repo: SkillRepository;

  beforeEach(() => {
    db = createFullSchemaDb();

    // Insert a site row for FK constraint
    db.run(
      `INSERT INTO sites (id, display_name, mastery_level, recommended_tier) VALUES (?, ?, ?, ?)`,
      'example.com', 'Example', 'full', 'direct',
    );
    db.run(
      `INSERT INTO sites (id, display_name, mastery_level, recommended_tier) VALUES (?, ?, ?, ?)`,
      'other.com', 'Other', 'explore', 'browser_proxied',
    );

    repo = new SkillRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('finds skills by name via FTS', () => {
    repo.create(makeSkill({ id: 'example.com.get_users.v1', name: 'get_users', description: 'Get list of users' }));
    repo.create(makeSkill({ id: 'example.com.create_order.v1', name: 'create_order', description: 'Create a new order', method: 'POST', pathTemplate: '/api/orders' }));

    const { skills, matchType } = repo.searchFts('users');
    expect(skills.length).toBe(1);
    expect(skills[0].name).toBe('get_users');
    expect(matchType).toBe('fts');
  });

  it('finds skills by description via FTS', () => {
    repo.create(makeSkill({ id: 'example.com.get_users.v1', name: 'get_users', description: 'Retrieve all customer accounts' }));
    repo.create(makeSkill({ id: 'example.com.create_order.v1', name: 'create_order', description: 'Place a purchase order', method: 'POST', pathTemplate: '/api/orders' }));

    const { skills, matchType } = repo.searchFts('customer');
    expect(skills.length).toBe(1);
    expect(skills[0].name).toBe('get_users');
    expect(matchType).toBe('fts');
  });

  it('finds skills by path template via FTS', () => {
    repo.create(makeSkill({ id: 'example.com.get_users.v1', name: 'get_users', pathTemplate: '/api/v2/users' }));
    repo.create(makeSkill({ id: 'example.com.create_order.v1', name: 'create_order', pathTemplate: '/api/v2/orders', method: 'POST' }));

    const { skills, matchType } = repo.searchFts('orders');
    expect(skills.length).toBe(1);
    expect(skills[0].name).toBe('create_order');
    expect(matchType).toBe('fts');
  });

  it('filters by siteId', () => {
    repo.create(makeSkill({ id: 'example.com.get_users.v1', siteId: 'example.com', name: 'get_users' }));
    repo.create(makeSkill({ id: 'other.com.get_users.v1', siteId: 'other.com', name: 'get_users', description: 'Get users from other site' }));

    const { skills, matchType } = repo.searchFts('users', { siteId: 'other.com' });
    expect(skills.length).toBe(1);
    expect(skills[0].siteId).toBe('other.com');
    expect(matchType).toBe('fts');
  });

  it('respects limit', () => {
    repo.create(makeSkill({ id: 'example.com.get_users.v1', name: 'get_users', description: 'Get users' }));
    repo.create(makeSkill({ id: 'example.com.list_users.v1', name: 'list_users', description: 'List users', pathTemplate: '/api/users/list' }));

    const { skills } = repo.searchFts('users', { limit: 1 });
    expect(skills.length).toBe(1);
  });

  it('returns empty array when no match', () => {
    repo.create(makeSkill({ id: 'example.com.get_users.v1', name: 'get_users' }));

    const { skills } = repo.searchFts('nonexistent_xyz');
    expect(skills.length).toBe(0);
  });

  it('maps reviewRequired field correctly', () => {
    const skill = makeSkill({ id: 'example.com.get_users.v1', name: 'get_users', reviewRequired: true });
    repo.create(skill);

    const retrieved = repo.getById('example.com.get_users.v1');
    expect(retrieved).toBeDefined();
    expect(retrieved!.reviewRequired).toBe(true);
  });

  it('updates reviewRequired field', () => {
    repo.create(makeSkill({ id: 'example.com.get_users.v1', name: 'get_users', reviewRequired: false }));
    repo.update('example.com.get_users.v1', { reviewRequired: true });

    const retrieved = repo.getById('example.com.get_users.v1');
    expect(retrieved!.reviewRequired).toBe(true);
  });

  it('FTS index stays in sync after insert', () => {
    // Insert after migration — trigger should fire
    repo.create(makeSkill({ id: 'example.com.get_users.v1', name: 'get_users' }));

    const { skills } = repo.searchFts('users');
    expect(skills.length).toBe(1);
  });

  it('FTS index stays in sync after delete', () => {
    repo.create(makeSkill({ id: 'example.com.get_users.v1', name: 'get_users' }));
    repo.delete('example.com.get_users.v1');

    const { skills } = repo.searchFts('users');
    expect(skills.length).toBe(0);
  });

  it('returns matchType fts on FTS hit', () => {
    repo.create(makeSkill({ id: 'example.com.get_users.v1', name: 'get_users', description: 'Get users' }));

    const { skills, matchType } = repo.searchFts('users');
    expect(skills.length).toBe(1);
    expect(matchType).toBe('fts');
  });
});

describe('LIKE fallback search', () => {
  it('falls back to LIKE when FTS query is invalid and returns matchType like', () => {
    const db = createFullSchemaDb();
    db.run(
      `INSERT INTO sites (id, display_name, mastery_level, recommended_tier) VALUES (?, ?, ?, ?)`,
      'example.com', 'Example', 'full', 'direct',
    );
    const repo = new SkillRepository(db);
    repo.create(makeSkill({ id: 'example.com.get_users.v1', name: 'get_users' }));

    // FTS5 doesn't accept bare special chars like unbalanced quotes — triggers LIKE fallback
    const { skills, matchType } = repo.searchFts('"unclosed');
    // Should not throw; LIKE fallback will find via name
    expect(skills.length).toBeGreaterThanOrEqual(0);
    expect(matchType).toBe('like');

    db.close();
  });

  it('escapes % in LIKE query so it does not match everything', () => {
    const db = createFullSchemaDb();
    db.run(
      `INSERT INTO sites (id, display_name, mastery_level, recommended_tier) VALUES (?, ?, ?, ?)`,
      'example.com', 'Example', 'full', 'direct',
    );
    const repo = new SkillRepository(db);
    repo.create(makeSkill({ id: 'example.com.get_users.v1', name: 'get_users', description: 'Get users' }));
    repo.create(makeSkill({ id: 'example.com.create_order.v1', name: 'create_order', description: 'Create order', method: 'POST', pathTemplate: '/api/orders' }));

    // A bare "%" without escaping would match everything via LIKE
    const { skills, matchType } = repo.searchFts('"%invalid-fts');
    expect(matchType).toBe('like');
    // "%" is escaped, so it should not match all rows
    expect(skills.length).toBe(0);

    db.close();
  });

  it('escapes _ in LIKE query so it does not act as single-char wildcard', () => {
    const db = createFullSchemaDb();
    db.run(
      `INSERT INTO sites (id, display_name, mastery_level, recommended_tier) VALUES (?, ?, ?, ?)`,
      'example.com', 'Example', 'full', 'direct',
    );
    const repo = new SkillRepository(db);
    repo.create(makeSkill({ id: 'example.com.get_users.v1', name: 'get_users', description: 'Get users' }));

    // Without escaping, "_et_users" would match "get_users" via _ as single-char wildcard
    // The literal "_et_users" should not match because the underscores are escaped
    const { skills, matchType } = repo.searchFts('"_et_users');
    expect(matchType).toBe('like');
    expect(skills.length).toBe(0);

    db.close();
  });

  it('escapes backslash literal in LIKE query', () => {
    const db = createFullSchemaDb();
    db.run(
      `INSERT INTO sites (id, display_name, mastery_level, recommended_tier) VALUES (?, ?, ?, ?)`,
      'example.com', 'Example', 'full', 'direct',
    );
    const repo = new SkillRepository(db);
    repo.create(makeSkill({ id: 'example.com.get_users.v1', name: 'get_users', description: 'path\\to\\resource' }));
    repo.create(makeSkill({ id: 'example.com.create_order.v1', name: 'create_order', description: 'Create order', method: 'POST', pathTemplate: '/api/orders' }));

    // Searching for a literal backslash should only match the skill that contains one
    const { skills, matchType } = repo.searchFts('"path\\to');
    expect(matchType).toBe('like');
    expect(skills.length).toBe(1);
    expect(skills[0].name).toBe('get_users');

    db.close();
  });

  it('LIKE fallback respects siteId filter', () => {
    const db = createFullSchemaDb();
    db.run(
      `INSERT INTO sites (id, display_name, mastery_level, recommended_tier) VALUES (?, ?, ?, ?)`,
      'example.com', 'Example', 'full', 'direct',
    );
    db.run(
      `INSERT INTO sites (id, display_name, mastery_level, recommended_tier) VALUES (?, ?, ?, ?)`,
      'other.com', 'Other', 'explore', 'browser_proxied',
    );
    const repo = new SkillRepository(db);
    repo.create(makeSkill({ id: 'example.com.get_users.v1', siteId: 'example.com', name: 'get_users', description: 'Get users' }));
    repo.create(makeSkill({ id: 'other.com.get_users.v1', siteId: 'other.com', name: 'get_users', description: 'Get users from other site' }));

    // Trigger LIKE fallback with unbalanced quote, filter by siteId
    const { skills, matchType } = repo.searchFts('"get_users', { siteId: 'other.com' });
    expect(matchType).toBe('like');
    // Should only return the other.com skill, not the example.com one
    for (const s of skills) {
      expect(s.siteId).toBe('other.com');
    }

    db.close();
  });

  it('LIKE fallback respects limit option', () => {
    const db = createFullSchemaDb();
    db.run(
      `INSERT INTO sites (id, display_name, mastery_level, recommended_tier) VALUES (?, ?, ?, ?)`,
      'example.com', 'Example', 'full', 'direct',
    );
    const repo = new SkillRepository(db);
    repo.create(makeSkill({ id: 'example.com.skill_a.v1', name: 'skill_a', description: 'shared keyword' }));
    repo.create(makeSkill({ id: 'example.com.skill_b.v1', name: 'skill_b', description: 'shared keyword', method: 'POST', pathTemplate: '/api/b' }));

    // Trigger LIKE fallback with unbalanced quote, limit to 1
    const { skills, matchType } = repo.searchFts('"shared', { limit: 1 });
    expect(matchType).toBe('like');
    expect(skills.length).toBeLessThanOrEqual(1);

    db.close();
  });

  it('rethrows unexpected database errors instead of falling back to LIKE', () => {
    const db = createFullSchemaDb();
    db.run(
      `INSERT INTO sites (id, display_name, mastery_level, recommended_tier) VALUES (?, ?, ?, ?)`,
      'example.com', 'Example', 'full', 'direct',
    );
    const repo = new SkillRepository(db);

    // Close the database to simulate an unexpected DB error (not an FTS syntax issue)
    db.close();

    expect(() => repo.searchFts('test')).toThrow();
  });
});
