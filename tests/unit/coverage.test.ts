import { describe, it, expect } from 'vitest';
import { computeCoverage } from '../../src/discovery/coverage.js';
import type { DiscoveryResult } from '../../src/discovery/types.js';
import type { SkillSpec } from '../../src/skill/types.js';

function makeEndpoint(method: string, path: string) {
  return {
    method,
    path,
    source: 'openapi' as const,
    trustLevel: 3 as const,
  };
}

function makeSkill(overrides: Partial<SkillSpec> = {}): SkillSpec {
  return {
    id: 'test.skill.v1',
    version: 1,
    status: 'active',
    currentTier: 'tier_3',
    tierLock: null,
    allowedDomains: ['example.com'],
    requiredCapabilities: ['net.fetch.direct'],
    parameters: [],
    validation: { semanticChecks: [], customInvariants: [] },
    redaction: { piiClassesFound: [], fieldsRedacted: 0 },
    replayStrategy: 'prefer_tier_1',
    sideEffectClass: 'read-only',
    sampleCount: 1,
    consecutiveValidations: 0,
    confidence: 1,
    method: 'GET',
    pathTemplate: '/api/users',
    inputSchema: {},
    isComposite: false,
    siteId: 'example.com',
    name: 'Get Users',
    successRate: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeDiscoveryResult(endpoints: ReturnType<typeof makeEndpoint>[]): DiscoveryResult {
  return {
    siteId: 'example.com',
    sources: [{ type: 'openapi', found: true, endpointCount: endpoints.length }],
    endpoints,
    trustRanking: { openapi: 5, graphql: 4, platform: 3, webmcp: 2, traffic: 1, sitemap: 1, 'devtools-mcp': 1 },
  };
}

describe('computeCoverage', () => {
  it('computes 60% for 5 discovered, 3 active skills', () => {
    const discovery = makeDiscoveryResult([
      makeEndpoint('GET', '/api/users'),
      makeEndpoint('POST', '/api/users'),
      makeEndpoint('GET', '/api/users/{id}'),
      makeEndpoint('DELETE', '/api/users/{id}'),
      makeEndpoint('GET', '/api/posts'),
    ]);

    const skills = [
      makeSkill({ id: 'e.get_users.v1', method: 'GET', pathTemplate: '/api/users', status: 'active' }),
      makeSkill({ id: 'e.post_users.v1', method: 'POST', pathTemplate: '/api/users', status: 'active' }),
      makeSkill({ id: 'e.get_user.v1', method: 'GET', pathTemplate: '/api/users/{id}', status: 'active' }),
    ];

    const report = computeCoverage(discovery, skills);

    expect(report.discovered).toBe(5);
    expect(report.active).toBe(3);
    expect(report.coveragePercent).toBe(60);
    expect(report.uncovered).toEqual([
      'DELETE /api/users/{id}',
      'GET /api/posts',
    ]);
  });

  it('matches parameterized paths with different param names ({id} matches {userId})', () => {
    const discovery = makeDiscoveryResult([
      makeEndpoint('GET', '/api/users/{userId}'),
      makeEndpoint('PUT', '/api/users/{userId}/profile'),
    ]);

    const skills = [
      makeSkill({ id: 'e.get_user.v1', method: 'GET', pathTemplate: '/api/users/{id}', status: 'active' }),
      makeSkill({ id: 'e.put_profile.v1', method: 'PUT', pathTemplate: '/api/users/{uid}/profile', status: 'active' }),
    ];

    const report = computeCoverage(discovery, skills);

    expect(report.discovered).toBe(2);
    expect(report.active).toBe(2);
    expect(report.coveragePercent).toBe(100);
    expect(report.uncovered).toEqual([]);
  });

  it('counts stale and broken skills separately', () => {
    const discovery = makeDiscoveryResult([
      makeEndpoint('GET', '/api/users'),
      makeEndpoint('POST', '/api/users'),
      makeEndpoint('GET', '/api/posts'),
      makeEndpoint('DELETE', '/api/posts/{id}'),
    ]);

    const skills = [
      makeSkill({ id: 'e.get_users.v1', method: 'GET', pathTemplate: '/api/users', status: 'active' }),
      makeSkill({ id: 'e.post_users.v1', method: 'POST', pathTemplate: '/api/users', status: 'stale' }),
      makeSkill({ id: 'e.get_posts.v1', method: 'GET', pathTemplate: '/api/posts', status: 'broken' }),
    ];

    const report = computeCoverage(discovery, skills);

    expect(report.active).toBe(1);
    expect(report.stale).toBe(1);
    expect(report.broken).toBe(1);
    expect(report.coveragePercent).toBe(75);
    expect(report.uncovered).toEqual(['DELETE /api/posts/{id}']);
  });

  it('lists uncovered endpoints', () => {
    const discovery = makeDiscoveryResult([
      makeEndpoint('GET', '/api/users'),
      makeEndpoint('GET', '/api/posts'),
      makeEndpoint('GET', '/api/comments'),
    ]);

    const skills = [
      makeSkill({ id: 'e.get_users.v1', method: 'GET', pathTemplate: '/api/users', status: 'active' }),
    ];

    const report = computeCoverage(discovery, skills);

    expect(report.uncovered).toEqual([
      'GET /api/posts',
      'GET /api/comments',
    ]);
    expect(report.coveragePercent).toBe(33);
  });

  it('returns 0% when 0 endpoints discovered', () => {
    const discovery = makeDiscoveryResult([]);
    const skills = [
      makeSkill({ id: 'e.get_users.v1', method: 'GET', pathTemplate: '/api/users', status: 'active' }),
    ];

    const report = computeCoverage(discovery, skills);

    expect(report.discovered).toBe(0);
    expect(report.active).toBe(0);
    expect(report.stale).toBe(0);
    expect(report.broken).toBe(0);
    expect(report.uncovered).toEqual([]);
    expect(report.coveragePercent).toBe(0);
  });

  it('returns 100% when all endpoints are covered', () => {
    const discovery = makeDiscoveryResult([
      makeEndpoint('GET', '/api/users'),
      makeEndpoint('POST', '/api/users'),
    ]);

    const skills = [
      makeSkill({ id: 'e.get_users.v1', method: 'GET', pathTemplate: '/api/users', status: 'active' }),
      makeSkill({ id: 'e.post_users.v1', method: 'POST', pathTemplate: '/api/users', status: 'active' }),
    ];

    const report = computeCoverage(discovery, skills);

    expect(report.discovered).toBe(2);
    expect(report.active).toBe(2);
    expect(report.coveragePercent).toBe(100);
    expect(report.uncovered).toEqual([]);
  });

  it('prefers active skill over draft for same endpoint', () => {
    const discovery = makeDiscoveryResult([
      makeEndpoint('GET', '/api/users'),
    ]);

    const skills = [
      makeSkill({ id: 'e.get_users_draft.v1', method: 'GET', pathTemplate: '/api/users', status: 'draft' }),
      makeSkill({ id: 'e.get_users_active.v1', method: 'GET', pathTemplate: '/api/users', status: 'active' }),
    ];

    const report = computeCoverage(discovery, skills);
    expect(report.active).toBe(1);
    expect(report.broken).toBe(0);
    expect(report.stale).toBe(0);
  });

  it('prefers host-matching skill over wrong-host skill', () => {
    const discovery = makeDiscoveryResult([
      makeEndpoint('GET', '/api/data'),
    ]);

    const skills = [
      makeSkill({ id: 'e.data_wrong.v1', method: 'GET', pathTemplate: '/api/data', status: 'active', allowedDomains: ['other.com'] }),
      makeSkill({ id: 'e.data_right.v1', method: 'GET', pathTemplate: '/api/data', status: 'stale', allowedDomains: ['example.com'] }),
    ];

    // With siteId hint, should prefer the host-matching stale skill over wrong-host active
    const report = computeCoverage(discovery, skills, 'example.com');
    expect(report.stale).toBe(1);
    expect(report.active).toBe(0);
  });

  it('treats draft skills as uncovered', () => {
    const discovery = makeDiscoveryResult([
      makeEndpoint('GET', '/api/users'),
    ]);

    const skills = [
      makeSkill({ id: 'e.get_users.v1', method: 'GET', pathTemplate: '/api/users', status: 'draft' }),
    ];

    const report = computeCoverage(discovery, skills);
    // draft should not count as covered
    expect(report.active).toBe(0);
    expect(report.stale).toBe(0);
    expect(report.broken).toBe(0);
  });
});
