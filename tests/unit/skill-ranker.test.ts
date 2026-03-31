import { describe, it, expect } from 'vitest';
import { shouldSuppressSkill, deduplicateByPathTemplate } from '../../src/capture/skill-ranker.js';
import type { SkillSpec } from '../../src/skill/types.js';

function makeSkill(overrides: Partial<SkillSpec> = {}): SkillSpec {
  return {
    id: 'test.action.v1',
    version: 1,
    status: 'draft',
    currentTier: 'tier_3',
    tierLock: null,
    allowedDomains: ['example.com'],
    requiredCapabilities: [],
    parameters: [],
    validation: { semanticChecks: [], customInvariants: [] },
    redaction: { piiClassesFound: [], fieldsRedacted: 0 },
    replayStrategy: 'prefer_tier_3',
    sideEffectClass: 'read-only',
    sampleCount: 3,
    consecutiveValidations: 0,
    confidence: 0,
    method: 'GET',
    pathTemplate: '/api/v1/data',
    inputSchema: {},
    isComposite: false,
    siteId: 'example.com',
    name: 'get_data',
    successRate: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('shouldSuppressSkill', () => {
  it('suppresses CSRF endpoints', () => {
    const skill = makeSkill({ pathTemplate: '/api/csrf-token' });
    const result = shouldSuppressSkill(skill);
    expect(result.suppress).toBe(true);
    expect(result.reason).toContain('Auth/session');
  });

  it('suppresses session endpoints', () => {
    const skill = makeSkill({ pathTemplate: '/api/session/status' });
    const result = shouldSuppressSkill(skill);
    expect(result.suppress).toBe(true);
  });

  it('suppresses logged_in check endpoints', () => {
    const skill = makeSkill({ pathTemplate: '/api/logged_in' });
    const result = shouldSuppressSkill(skill);
    expect(result.suppress).toBe(true);
  });

  it('suppresses onboarding endpoints', () => {
    const skill = makeSkill({ pathTemplate: '/api/onboarding/check' });
    const result = shouldSuppressSkill(skill);
    expect(result.suppress).toBe(true);
  });

  it('suppresses user_info endpoints', () => {
    const skill = makeSkill({ pathTemplate: '/api/user_info' });
    const result = shouldSuppressSkill(skill);
    expect(result.suppress).toBe(true);
  });

  it('keeps normal API endpoints', () => {
    const skill = makeSkill({ pathTemplate: '/api/v1/products' });
    const result = shouldSuppressSkill(skill);
    expect(result.suppress).toBe(false);
    expect(result.reason).toBeUndefined();
  });
});

describe('deduplicateByPathTemplate', () => {
  it('deduplicates skills differing only in last segment (image variants)', () => {
    const existing = makeSkill({
      id: 'example.get_image_thumb.v1',
      pathTemplate: '/api/images/thumb',
      method: 'GET',
      allowedDomains: ['cdn.example.com'],
    });
    const newSkill = makeSkill({
      id: 'example.get_image_large.v1',
      pathTemplate: '/api/images/large',
      method: 'GET',
      allowedDomains: ['cdn.example.com'],
    });

    const result = deduplicateByPathTemplate([newSkill], [existing]);
    expect(result.keep).toHaveLength(0);
    expect(result.suppressed).toHaveLength(1);
    expect(result.suppressed[0].reason).toContain('Duplicate path variant');
  });

  it('keeps skills with different parent paths', () => {
    const existing = makeSkill({
      pathTemplate: '/api/users/list',
      method: 'GET',
    });
    const newSkill = makeSkill({
      pathTemplate: '/api/products/list',
      method: 'GET',
    });

    const result = deduplicateByPathTemplate([newSkill], [existing]);
    expect(result.keep).toHaveLength(1);
    expect(result.suppressed).toHaveLength(0);
  });

  it('is host-aware — different hosts are not duplicates', () => {
    const existing = makeSkill({
      pathTemplate: '/api/v1/data',
      method: 'GET',
      allowedDomains: ['api.example.com'],
    });
    const newSkill = makeSkill({
      pathTemplate: '/api/v1/items',
      method: 'GET',
      allowedDomains: ['api.other.com'],
    });

    const result = deduplicateByPathTemplate([newSkill], [existing]);
    expect(result.keep).toHaveLength(1);
    expect(result.suppressed).toHaveLength(0);
  });

  it('deduplicates among new candidates themselves', () => {
    const newSkills = [
      makeSkill({
        id: 'example.get_a.v1',
        pathTemplate: '/api/items/a',
        method: 'GET',
      }),
      makeSkill({
        id: 'example.get_b.v1',
        pathTemplate: '/api/items/b',
        method: 'GET',
      }),
    ];

    const result = deduplicateByPathTemplate(newSkills, []);
    expect(result.keep).toHaveLength(1);
    expect(result.suppressed).toHaveLength(1);
  });

  it('does not mutate existing active skills', () => {
    const existing = makeSkill({
      id: 'existing.v1',
      pathTemplate: '/api/items/original',
      method: 'GET',
      status: 'active',
    });
    const newSkill = makeSkill({
      id: 'new.v1',
      pathTemplate: '/api/items/variant',
      method: 'GET',
    });

    const result = deduplicateByPathTemplate([newSkill], [existing]);
    // New skill suppressed, existing untouched
    expect(result.suppressed).toHaveLength(1);
    expect(result.suppressed[0].skill.id).toBe('new.v1');
  });

  it('does NOT dedup single-segment root routes like /login, /health, /status', () => {
    const skills = [
      makeSkill({ id: 'a.login.v1', pathTemplate: '/login', method: 'GET' }),
      makeSkill({ id: 'a.health.v1', pathTemplate: '/health', method: 'GET' }),
      makeSkill({ id: 'a.status.v1', pathTemplate: '/status', method: 'GET' }),
    ];

    const result = deduplicateByPathTemplate(skills, []);
    // All should be kept — single-segment paths must NOT be deduped
    expect(result.suppressed).toHaveLength(0);
    expect(result.keep).toHaveLength(3);
  });
});
