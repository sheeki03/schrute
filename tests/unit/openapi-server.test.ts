import { describe, it, expect, vi } from 'vitest';
import { buildOpenApiSpec } from '../../src/server/openapi-server.js';
import type { SkillRepository } from '../../src/storage/skill-repository.js';
import type { SkillSpec } from '../../src/skill/types.js';

// ─── Mock Logger ─────────────────────────────────────────────────

vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ─── Helpers ──────────────────────────────────────────────────────

function makeSkill(overrides: Partial<SkillSpec> = {}): SkillSpec {
  return {
    id: 'example_com.get_users.v1',
    version: 1,
    status: 'active',
    currentTier: 'tier_3',
    tierLock: null,
    allowedDomains: ['example.com'],
    requiredCapabilities: ['net.fetch.direct'],
    parameters: [],
    validation: { semanticChecks: [], customInvariants: [] },
    redaction: { piiClassesFound: [], fieldsRedacted: 0 },
    replayStrategy: 'prefer_tier_3',
    sideEffectClass: 'read-only',
    sampleCount: 5,
    consecutiveValidations: 3,
    confidence: 0.9,
    method: 'GET',
    pathTemplate: '/api/users/{id}',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
    },
    isComposite: false,
    siteId: 'example.com',
    name: 'get_users',
    description: 'Fetch users from the API',
    successRate: 0.95,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeSkillRepo(skills: SkillSpec[]): SkillRepository {
  return {
    getByStatus: vi.fn().mockReturnValue(skills),
  } as unknown as SkillRepository;
}

// ─── Tests ────────────────────────────────────────────────────────

describe('openapi-server', () => {
  describe('buildOpenApiSpec', () => {
    it('returns valid OpenAPI 3.1.0 spec', () => {
      const repo = makeSkillRepo([]);
      const spec = buildOpenApiSpec(repo);
      expect(spec.openapi).toBe('3.1.0');
      expect(spec.info.title).toBe('OneAgent API');
      expect(spec.info.version).toBe('0.2.0');
    });

    it('uses custom options', () => {
      const repo = makeSkillRepo([]);
      const spec = buildOpenApiSpec(repo, {
        title: 'My API',
        version: '1.0.0',
        serverUrl: 'http://localhost:8080',
      });
      expect(spec.info.title).toBe('My API');
      expect(spec.info.version).toBe('1.0.0');
      expect(spec.servers[0].url).toBe('http://localhost:8080');
    });

    it('includes meta routes', () => {
      const repo = makeSkillRepo([]);
      const spec = buildOpenApiSpec(repo);
      expect(spec.paths['/api/sites']).toBeDefined();
      expect(spec.paths['/api/health']).toBeDefined();
      expect(spec.paths['/api/explore']).toBeDefined();
      expect(spec.paths['/api/record']).toBeDefined();
      expect(spec.paths['/api/stop']).toBeDefined();
      expect(spec.paths['/api/audit']).toBeDefined();
    });

    it('includes paths from active skills', () => {
      const skill = makeSkill();
      const repo = makeSkillRepo([skill]);
      const spec = buildOpenApiSpec(repo);

      // Skill names are now slugified in paths
      const slugifiedName = skill.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const proxyPath = `/api/sites/${skill.siteId}/skills/${slugifiedName}`;
      expect(spec.paths[proxyPath]).toBeDefined();

      // Should include the original path
      expect(spec.paths['/api/users/{id}']).toBeDefined();
    });

    it('adds site tags for active skills', () => {
      const skill = makeSkill();
      const repo = makeSkillRepo([skill]);
      const spec = buildOpenApiSpec(repo);

      const tagNames = spec.tags.map((t) => t.name);
      expect(tagNames).toContain('example.com');
      expect(tagNames).toContain('meta');
    });

    it('adds security schemes for bearer auth', () => {
      const skill = makeSkill({ authType: 'bearer' });
      const repo = makeSkillRepo([skill]);
      const spec = buildOpenApiSpec(repo);
      expect(spec.components.securitySchemes['bearerAuth']).toBeDefined();
    });

    it('adds security schemes for api_key auth', () => {
      const skill = makeSkill({ authType: 'api_key' });
      const repo = makeSkillRepo([skill]);
      const spec = buildOpenApiSpec(repo);
      expect(spec.components.securitySchemes['apiKeyAuth']).toBeDefined();
    });

    it('adds security schemes for cookie auth', () => {
      const skill = makeSkill({ authType: 'cookie' });
      const repo = makeSkillRepo([skill]);
      const spec = buildOpenApiSpec(repo);
      expect(spec.components.securitySchemes['cookieAuth']).toBeDefined();
    });

    it('adds security schemes for oauth2 auth', () => {
      const skill = makeSkill({ authType: 'oauth2' });
      const repo = makeSkillRepo([skill]);
      const spec = buildOpenApiSpec(repo);
      expect(spec.components.securitySchemes['oauth2Auth']).toBeDefined();
    });

    it('handles multiple skills from different sites', () => {
      const skill1 = makeSkill({ siteId: 'site-a.com', name: 'action1', id: 's1' });
      const skill2 = makeSkill({ siteId: 'site-b.com', name: 'action2', id: 's2' });
      const repo = makeSkillRepo([skill1, skill2]);
      const spec = buildOpenApiSpec(repo);

      const tagNames = spec.tags.map((t) => t.name);
      expect(tagNames).toContain('site-a.com');
      expect(tagNames).toContain('site-b.com');
    });

    it('handles skill with no auth', () => {
      const skill = makeSkill({ authType: undefined });
      const repo = makeSkillRepo([skill]);
      const spec = buildOpenApiSpec(repo);
      expect(Object.keys(spec.components.securitySchemes)).toHaveLength(0);
    });
  });
});
