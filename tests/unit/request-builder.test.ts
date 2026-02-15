import { describe, it, expect } from 'vitest';
import { buildRequest } from '../../src/replay/request-builder.js';
import type { SkillSpec, AuthRecipe } from '../../src/skill/types.js';
import { ExecutionTier } from '../../src/skill/types.js';

function makeSkill(overrides: Partial<SkillSpec> = {}): SkillSpec {
  return {
    id: 'test.skill.v1',
    version: 1,
    status: 'active',
    currentTier: 'tier_3',
    tierLock: null,
    allowedDomains: ['example.com'],
    requiredCapabilities: [],
    parameters: [],
    validation: { semanticChecks: [], customInvariants: [] },
    redaction: { piiClassesFound: [], fieldsRedacted: 0 },
    replayStrategy: 'prefer_tier_1',
    sideEffectClass: 'read-only',
    sampleCount: 5,
    consecutiveValidations: 5,
    confidence: 0.9,
    method: 'GET',
    pathTemplate: '/api/data',
    inputSchema: {},
    isComposite: false,
    siteId: 'example.com',
    name: 'test skill',
    successRate: 1.0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as SkillSpec;
}

describe('request-builder', () => {
  describe('URL template filling', () => {
    it('replaces path parameters in template', () => {
      const skill = makeSkill({ pathTemplate: '/api/users/{userId}/posts/{postId}' });
      const result = buildRequest(skill, { userId: '42', postId: '99' }, ExecutionTier.BROWSER_PROXIED);
      expect(result.url).toBe('https://example.com/api/users/42/posts/99');
    });

    it('encodes path parameters', () => {
      const skill = makeSkill({ pathTemplate: '/api/search/{query}' });
      const result = buildRequest(skill, { query: 'hello world' }, ExecutionTier.BROWSER_PROXIED);
      expect(result.url).toBe('https://example.com/api/search/hello%20world');
    });

    it('prepends https domain when pathTemplate is relative', () => {
      const skill = makeSkill({ pathTemplate: '/api/data' });
      const result = buildRequest(skill, {}, ExecutionTier.BROWSER_PROXIED);
      expect(result.url).toMatch(/^https:\/\/example\.com\/api\/data/);
    });

    it('preserves absolute URL when pathTemplate starts with http', () => {
      const skill = makeSkill({ pathTemplate: 'https://custom.com/api/data' });
      const result = buildRequest(skill, {}, ExecutionTier.BROWSER_PROXIED);
      expect(result.url).toMatch(/^https:\/\/custom\.com\/api\/data/);
    });
  });

  describe('header shaping', () => {
    it('sets default accept header to application/json', () => {
      const skill = makeSkill();
      const result = buildRequest(skill, {}, ExecutionTier.BROWSER_PROXIED);
      expect(result.headers['accept']).toBe('application/json');
    });

    it('copies requiredHeaders from skill', () => {
      const skill = makeSkill({
        requiredHeaders: { 'x-custom': 'value123', 'accept': 'text/html' },
      });
      const result = buildRequest(skill, {}, ExecutionTier.BROWSER_PROXIED);
      expect(result.headers['x-custom']).toBe('value123');
      expect(result.headers['accept']).toBe('text/html');
    });

    it('filters headers through tier 1 allowlist', () => {
      const skill = makeSkill({
        requiredHeaders: { 'x-custom': 'value', 'accept': 'application/json', 'user-agent': 'Test' },
      });
      const result = buildRequest(skill, {}, ExecutionTier.DIRECT);
      // x-custom is NOT in TIER1_ALLOWED_HEADERS, so filtered out
      expect(result.headers['x-custom']).toBeUndefined();
      expect(result.headers['accept']).toBe('application/json');
      expect(result.headers['user-agent']).toBe('Test');
    });

    it('blocks hop-by-hop headers', () => {
      const skill = makeSkill({
        requiredHeaders: { 'connection': 'keep-alive', 'transfer-encoding': 'chunked', 'accept': 'application/json' },
      });
      const result = buildRequest(skill, {}, ExecutionTier.BROWSER_PROXIED);
      expect(result.headers['connection']).toBeUndefined();
      expect(result.headers['transfer-encoding']).toBeUndefined();
    });

    it('computes content-length from body', () => {
      const skill = makeSkill({ method: 'POST', pathTemplate: '/api/data' });
      const result = buildRequest(skill, { name: 'test' }, ExecutionTier.BROWSER_PROXIED);
      const expectedLen = new TextEncoder().encode(JSON.stringify({ name: 'test' })).byteLength;
      expect(result.headers['content-length']).toBe(String(expectedLen));
    });
  });

  describe('auth injection', () => {
    it('injects bearer auth into authorization header', () => {
      const skill = makeSkill({ authType: 'bearer' });
      const recipe: AuthRecipe = {
        type: 'bearer',
        injection: { location: 'header', key: 'Authorization', prefix: 'Bearer ' },
        refreshTriggers: ['401'],
        refreshMethod: 'browser_relogin',
      };
      const result = buildRequest(skill, {}, ExecutionTier.BROWSER_PROXIED, recipe);
      expect(result.headers['authorization']).toBe('Bearer {{SECRET}}');
    });

    it('injects cookie auth', () => {
      const skill = makeSkill({ authType: 'cookie' });
      const recipe: AuthRecipe = {
        type: 'cookie',
        injection: { location: 'cookie', key: 'session_token' },
        refreshTriggers: ['401'],
        refreshMethod: 'browser_relogin',
      };
      const result = buildRequest(skill, {}, ExecutionTier.BROWSER_PROXIED, recipe);
      expect(result.headers['cookie']).toContain('session_token={{SECRET}}');
    });
  });

  describe('body construction', () => {
    it('builds JSON body for POST requests', () => {
      const skill = makeSkill({ method: 'POST', pathTemplate: '/api/data' });
      const result = buildRequest(skill, { name: 'test', value: 123 }, ExecutionTier.BROWSER_PROXIED);
      expect(result.body).toBe(JSON.stringify({ name: 'test', value: 123 }));
      expect(result.headers['content-type']).toBe('application/json');
    });

    it('adds query params for GET requests', () => {
      const skill = makeSkill({ method: 'GET', pathTemplate: '/api/search' });
      const result = buildRequest(skill, { q: 'test', page: '1' }, ExecutionTier.BROWSER_PROXIED);
      expect(result.url).toContain('q=test');
      expect(result.url).toContain('page=1');
      expect(result.body).toBeUndefined();
    });

    it('excludes path params from body on POST', () => {
      const skill = makeSkill({ method: 'POST', pathTemplate: '/api/users/{userId}' });
      const result = buildRequest(skill, { userId: '42', name: 'Alice' }, ExecutionTier.BROWSER_PROXIED);
      const body = JSON.parse(result.body!);
      expect(body.userId).toBeUndefined();
      expect(body.name).toBe('Alice');
    });

    it('sets origin and referer for POST requests', () => {
      const skill = makeSkill({ method: 'POST', pathTemplate: '/api/data' });
      const result = buildRequest(skill, { data: 'test' }, ExecutionTier.BROWSER_PROXIED);
      expect(result.headers['origin']).toBe('https://example.com');
      expect(result.headers['referer']).toBe('https://example.com/');
    });
  });
});
