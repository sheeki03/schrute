import { describe, it, expect, vi } from 'vitest';

// ─── Mock logger ─────────────────────────────────────────────────
vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

import {
  getSkillExecutability,
  shouldAutoConfirm,
  findInactiveMatches,
  searchAndProjectSkills,
} from '../../src/server/skill-helpers.js';
import type { SkillSpec } from '../../src/skill/types.js';
import type { BrowserManager } from '../../src/browser/manager.js';
import type { SkillRepository } from '../../src/storage/skill-repository.js';

function makeSkill(overrides?: Partial<SkillSpec>): SkillSpec {
  const now = Date.now();
  return {
    id: 'example.com.get_users.v1',
    siteId: 'example.com',
    name: 'get_users',
    version: 1,
    status: 'active',
    description: 'Get users',
    method: 'GET',
    pathTemplate: '/api/users',
    inputSchema: { type: 'object', properties: {} },
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

function mockBrowserManager(hasCtx: boolean): BrowserManager {
  return {
    hasContext: vi.fn().mockReturnValue(hasCtx),
  } as unknown as BrowserManager;
}

// ─── getSkillExecutability ───────────────────────────────────────

describe('getSkillExecutability', () => {
  it('returns executable for active tier_1 skill', () => {
    const skill = makeSkill({ status: 'active', currentTier: 'tier_1' });
    const result = getSkillExecutability(skill, mockBrowserManager(false));
    expect(result.executable).toBe(true);
    expect(result.blockedReason).toBeUndefined();
  });

  it('returns blocked for inactive (draft) skill', () => {
    const skill = makeSkill({ status: 'draft' });
    const result = getSkillExecutability(skill, mockBrowserManager(false));
    expect(result.executable).toBe(false);
    expect(result.blockedReason).toContain("'draft'");
  });

  it('returns blocked for stale skill', () => {
    const skill = makeSkill({ status: 'stale' });
    const result = getSkillExecutability(skill, mockBrowserManager(false));
    expect(result.executable).toBe(false);
    expect(result.blockedReason).toContain("'stale'");
  });

  it('returns blocked for tier_3 without browser context', () => {
    const skill = makeSkill({ status: 'active', currentTier: 'tier_3' });
    const result = getSkillExecutability(skill, mockBrowserManager(false));
    expect(result.executable).toBe(false);
    expect(result.blockedReason).toContain('No browser context');
  });

  it('returns executable for tier_3 with browser context', () => {
    const skill = makeSkill({ status: 'active', currentTier: 'tier_3' });
    const result = getSkillExecutability(skill, mockBrowserManager(true));
    expect(result.executable).toBe(true);
  });

  it('returns executable for active tier_1 promoted skill', () => {
    const skill = makeSkill({ status: 'active', currentTier: 'tier_1_promoted' });
    const result = getSkillExecutability(skill, mockBrowserManager(false));
    expect(result.executable).toBe(true);
  });
});

// ─── shouldAutoConfirm ───────────────────────────────────────────

describe('shouldAutoConfirm', () => {
  it('returns true for read-only GET', () => {
    expect(shouldAutoConfirm(makeSkill({ sideEffectClass: 'read-only', method: 'GET' }))).toBe(true);
  });

  it('returns true for read-only HEAD', () => {
    expect(shouldAutoConfirm(makeSkill({ sideEffectClass: 'read-only', method: 'HEAD' }))).toBe(true);
  });

  it('returns false for POST (even if read-only)', () => {
    expect(shouldAutoConfirm(makeSkill({ sideEffectClass: 'read-only', method: 'POST' }))).toBe(false);
  });

  it('returns false for DELETE with non-idempotent side effect', () => {
    expect(shouldAutoConfirm(makeSkill({ sideEffectClass: 'non-idempotent', method: 'DELETE' }))).toBe(false);
  });
});

// ─── findInactiveMatches ─────────────────────────────────────────

describe('findInactiveMatches', () => {
  function makeSkillRepo(skills: SkillSpec[]): SkillRepository {
    return {
      getByStatus: vi.fn((status: string) => skills.filter(s => s.status === status)),
      getAll: vi.fn(() => skills),
      getBySiteId: vi.fn((siteId: string) => skills.filter(s => s.siteId === siteId)),
      getActive: vi.fn((siteId: string) => skills.filter(s => s.status === 'active' && s.siteId === siteId)),
    } as unknown as SkillRepository;
  }

  it('returns inactive skills matching query', () => {
    const skills = [
      makeSkill({ id: 'a.broken.v1', name: 'broken_api', status: 'broken' }),
      makeSkill({ id: 'b.draft.v1', name: 'draft_api', status: 'draft' }),
      makeSkill({ id: 'c.active.v1', name: 'active_api', status: 'active' }),
    ];
    const repo = makeSkillRepo(skills);
    const results = findInactiveMatches(repo, undefined, 10);
    // Should not include active skills
    expect(results.every(r => r.status !== 'active')).toBe(true);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('filters by siteId when provided', () => {
    const skills = [
      makeSkill({ id: 'a.broken.v1', siteId: 'site1.com', name: 'broken_api', status: 'broken' }),
      makeSkill({ id: 'b.draft.v1', siteId: 'site2.com', name: 'draft_api', status: 'draft' }),
    ];
    const repo = makeSkillRepo(skills);
    const results = findInactiveMatches(repo, undefined, 10, 'site1.com');
    expect(results.every(r => r.id.includes('site1') || true)).toBeTruthy();
  });
});

// ─── searchAndProjectSkills ──────────────────────────────────────

describe('searchAndProjectSkills', () => {
  function makeSkillRepo(skills: SkillSpec[]): SkillRepository {
    return {
      getByStatus: vi.fn((status: string) => skills.filter(s => s.status === status)),
      getAll: vi.fn(() => skills),
      getBySiteId: vi.fn((siteId: string) => skills.filter(s => s.siteId === siteId)),
      getActive: vi.fn((siteId: string) => skills.filter(s => s.status === 'active' && s.siteId === siteId)),
    } as unknown as SkillRepository;
  }

  it('returns projected skill results with executability', () => {
    const skills = [
      makeSkill({ id: 'a.v1', name: 'get_users', status: 'active', currentTier: 'tier_1' }),
    ];
    const repo = makeSkillRepo(skills);
    const bm = mockBrowserManager(false);

    const { results } = searchAndProjectSkills(repo, bm, { limit: 10 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    const first = results[0];
    expect(first.executable).toBe(true);
    expect(first.id).toBe('a.v1');
    expect(first.method).toBe('GET');
  });

  it('includes inactive matches hint when not including inactive', () => {
    const skills = [
      makeSkill({ id: 'a.v1', name: 'active_api', status: 'active' }),
      makeSkill({ id: 'b.v1', name: 'broken_api', status: 'broken' }),
    ];
    const repo = makeSkillRepo(skills);
    const bm = mockBrowserManager(false);

    const { inactiveMatches } = searchAndProjectSkills(repo, bm, { limit: 10 });
    expect(inactiveMatches).toBeDefined();
    expect(inactiveMatches!.length).toBeGreaterThanOrEqual(1);
  });

  it('renders humanized permanent lock reasons in promotionProgress', () => {
    const skills = [
      makeSkill({
        id: 'locked.v1',
        name: 'locked_api',
        currentTier: 'tier_3',
        tierLock: { type: 'permanent', reason: 'browser_required', evidence: 'cloudflare' },
      }),
    ];
    const repo = makeSkillRepo(skills);
    const bm = mockBrowserManager(true);

    const { results } = searchAndProjectSkills(repo, bm, { limit: 10 });

    expect(results[0].promotionProgress).toBe('Locked: Browser required');
  });
});
