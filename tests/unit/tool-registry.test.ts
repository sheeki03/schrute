import { describe, it, expect } from 'vitest';
import {
  rankToolsByIntent,
  skillToToolName,
  skillToToolDefinition,
  sanitizeParamKey,
  getBrowserToolDefinitions,
  META_TOOLS,
} from '../../src/server/tool-registry.js';
import type { SkillSpec } from '../../src/skill/types.js';

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
    parameters: [
      { name: 'id', type: 'string', source: 'user_input', evidence: ['123'] },
    ],
    validation: { semanticChecks: [], customInvariants: [] },
    redaction: { piiClassesFound: [], fieldsRedacted: 0 },
    replayStrategy: 'prefer_tier_3',
    sideEffectClass: 'read-only',
    sampleCount: 5,
    consecutiveValidations: 3,
    confidence: 0.9,
    method: 'GET',
    pathTemplate: '/api/users/{id}',
    inputSchema: {},
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

// ─── Tests ────────────────────────────────────────────────────────

describe('tool-registry', () => {
  describe('skillToToolName', () => {
    it('builds namespace from siteId + name + version', () => {
      const skill = makeSkill();
      expect(skillToToolName(skill)).toBe('example_com.get_users.v1');
    });

    it('sanitizes special characters', () => {
      const skill = makeSkill({
        siteId: 'my-site.co.uk',
        name: 'get user!data',
        version: 2,
      });
      expect(skillToToolName(skill)).toBe('my_site_co_uk.get_user_data.v2');
    });
  });

  describe('skillToToolDefinition', () => {
    it('returns a valid tool definition', () => {
      const skill = makeSkill();
      const def = skillToToolDefinition(skill);
      expect(def.name).toBe('example_com.get_users.v1');
      expect(def.description).toBe('Fetch users from the API');
      expect(def.inputSchema.type).toBe('object');
    });

    it('uses buildAutoDescription as fallback description', () => {
      const skill = makeSkill({ description: undefined });
      const def = skillToToolDefinition(skill);
      // Should include method, path, side effect class
      expect(def.description).toContain('GET /api/users/{id}');
      expect(def.description).toContain('[read-only]');
    });

    it('buildAutoDescription includes auth type when present', () => {
      const skill = makeSkill({ description: undefined, authType: 'bearer' });
      const def = skillToToolDefinition(skill);
      expect(def.description).toContain('(auth: bearer)');
    });

    it('buildAutoDescription includes user_input params', () => {
      const skill = makeSkill({
        description: undefined,
        parameters: [
          { name: 'id', type: 'string', source: 'user_input', evidence: [] },
          { name: 'token', type: 'string', source: 'extracted', evidence: [] },
        ],
      });
      const def = skillToToolDefinition(skill);
      expect(def.description).toContain('Inputs: id');
      expect(def.description).not.toContain('token');
    });

    it('marks user_input params as required', () => {
      const skill = makeSkill({
        parameters: [
          { name: 'id', type: 'string', source: 'user_input', evidence: [] },
          { name: 'token', type: 'string', source: 'extracted', evidence: [] },
        ],
      });
      const def = skillToToolDefinition(skill);
      expect(def.inputSchema.required).toEqual(['id']);
    });

    it('sanitizes parameter names with invalid characters', () => {
      const skill = makeSkill({
        parameters: [
          { name: 'header.:path', type: 'string', source: 'user_input', evidence: [] },
          { name: 'header.:method', type: 'string', source: 'extracted', evidence: [] },
          { name: 'query[search]', type: 'string', source: 'user_input', evidence: [] },
        ],
      });
      const def = skillToToolDefinition(skill);
      const props = def.inputSchema.properties as Record<string, unknown>;
      const keys = Object.keys(props);
      // All keys must match ^[a-zA-Z0-9_.-]{1,64}$
      for (const key of keys) {
        expect(key).toMatch(/^[a-zA-Z0-9_.-]{1,64}$/);
      }
      // Required array should also be sanitized
      const required = def.inputSchema.required as string[];
      for (const r of required) {
        expect(r).toMatch(/^[a-zA-Z0-9_.-]{1,64}$/);
      }
    });

    it('with no options returns full description', () => {
      const longDesc = 'A'.repeat(500);
      const skill = makeSkill({ description: longDesc });
      const def = skillToToolDefinition(skill);
      expect(def.description).toBe(longDesc);
      expect(def.description.length).toBe(500);
    });

    it('with maxDescriptionLength truncates long descriptions', () => {
      const longDesc = 'A'.repeat(500);
      const skill = makeSkill({ description: longDesc });
      const def = skillToToolDefinition(skill, { maxDescriptionLength: 200 });
      expect(def.description.length).toBe(203); // 200 + '...'
      expect(def.description.endsWith('...')).toBe(true);
    });

    it('with maxDescriptionLength leaves short descriptions unchanged', () => {
      const shortDesc = 'Fetch users from the API';
      const skill = makeSkill({ description: shortDesc });
      const def = skillToToolDefinition(skill, { maxDescriptionLength: 200 });
      expect(def.description).toBe(shortDesc);
    });

    it('preserves full inputSchema regardless of description trimming', () => {
      const longDesc = 'B'.repeat(500);
      const skill = makeSkill({
        description: longDesc,
        parameters: [
          { name: 'id', type: 'string', source: 'user_input', evidence: ['123'] },
          { name: 'token', type: 'string', source: 'extracted', evidence: ['abc'] },
        ],
      });
      const def = skillToToolDefinition(skill, { maxDescriptionLength: 50 });
      // Description is truncated
      expect(def.description.length).toBe(53); // 50 + '...'
      // inputSchema remains complete
      const props = def.inputSchema.properties as Record<string, unknown>;
      expect(props).toHaveProperty('id');
      expect(props).toHaveProperty('token');
      expect(def.inputSchema.required).toContain('id');
    });
  });

  describe('sanitizeParamKey', () => {
    it('passes through valid names', () => {
      expect(sanitizeParamKey('id')).toBe('id');
      expect(sanitizeParamKey('user_name')).toBe('user_name');
      expect(sanitizeParamKey('header.accept')).toBe('header.accept');
      expect(sanitizeParamKey('x-api-key')).toBe('x-api-key');
    });

    it('replaces colons with underscores', () => {
      expect(sanitizeParamKey('header.:path')).toBe('header._path');
      expect(sanitizeParamKey('header.:method')).toBe('header._method');
    });

    it('replaces brackets with underscores', () => {
      expect(sanitizeParamKey('query[search]')).toBe('query_search');
    });

    it('truncates to 64 characters', () => {
      const long = 'a'.repeat(100);
      expect(sanitizeParamKey(long).length).toBeLessThanOrEqual(64);
    });

    it('returns "param" for empty result', () => {
      expect(sanitizeParamKey(':::')).toBe('param');
    });
  });

  describe('rankToolsByIntent', () => {
    it('returns all skills when count <= k', () => {
      const skills = [makeSkill(), makeSkill({ id: 'x' })];
      const result = rankToolsByIntent(skills, 'anything', 10);
      expect(result).toHaveLength(2);
    });

    it('returns up to k skills when no intent', () => {
      const skills = Array.from({ length: 5 }, (_, i) =>
        makeSkill({ id: `s${i}` }),
      );
      const result = rankToolsByIntent(skills, undefined, 3);
      expect(result).toHaveLength(3);
    });

    it('ranks by name match over description match', () => {
      const skillA = makeSkill({
        id: 'a',
        name: 'search',
        description: 'not relevant',
        successRate: 0,
      });
      const skillB = makeSkill({
        id: 'b',
        name: 'other',
        description: 'search in data',
        successRate: 0,
      });
      const result = rankToolsByIntent([skillA, skillB], 'search', 1);
      expect(result[0].id).toBe('a');
    });

    it('gives whole-segment bonus — "users" ranks /users above /producers', () => {
      const usersSkill = makeSkill({
        id: 'site.get_users.v1',
        name: 'get_users',
        pathTemplate: '/api/users',
        successRate: 0,
      });
      const producersSkill = makeSkill({
        id: 'site.get_producers.v1',
        name: 'get_producers',
        pathTemplate: '/api/producers',
        successRate: 0,
      });
      // "users" is a whole segment in /api/users but NOT in /api/producers
      const result = rankToolsByIntent([producersSkill, usersSkill], 'users', 1);
      expect(result[0].id).toBe('site.get_users.v1');
    });

    it('gives method+path combo bonus — "GET users" prefers GET /users over POST /users', () => {
      const getUsers = makeSkill({
        id: 'site.get_users.v1',
        name: 'get_users',
        pathTemplate: '/api/users',
        method: 'GET',
        successRate: 0,
      });
      const postUsers = makeSkill({
        id: 'site.create_user.v1',
        name: 'create_user',
        pathTemplate: '/api/users',
        method: 'POST',
        successRate: 0,
      });
      const result = rankToolsByIntent([postUsers, getUsers], 'GET users', 1);
      expect(result[0].id).toBe('site.get_users.v1');
    });

    it('exact method match (+2) scores higher than no method match', () => {
      const getSkill = makeSkill({
        id: 'site.get_item.v1',
        name: 'item',
        method: 'GET',
        pathTemplate: '/items',
        successRate: 0,
      });
      const deleteSkill = makeSkill({
        id: 'site.delete_item.v1',
        name: 'item',
        method: 'DELETE',
        pathTemplate: '/items',
        successRate: 0,
      });
      // "get" matches GET exactly, doesn't match DELETE at all
      const result = rankToolsByIntent([deleteSkill, getSkill], 'get', 1);
      expect(result[0].id).toBe('site.get_item.v1');
    });

    it('boosts recently used skills', () => {
      const recentSkill = makeSkill({
        id: 'recent',
        name: 'a',
        successRate: 0.5,
        lastUsed: Date.now() - 1000,
      });
      const oldSkill = makeSkill({
        id: 'old',
        name: 'b',
        successRate: 0.5,
        lastUsed: Date.now() - 48 * 60 * 60 * 1000,
      });
      const result = rankToolsByIntent([oldSkill, recentSkill], 'something', 1);
      expect(result[0].id).toBe('recent');
    });
  });

  describe('getBrowserToolDefinitions', () => {
    it('returns definitions for all allowed browser tools', () => {
      const defs = getBrowserToolDefinitions();
      expect(defs.length).toBeGreaterThan(0);
      expect(defs[0].name).toBe('browser_navigate');
      expect(defs[0].inputSchema.type).toBe('object');
    });
  });

  describe('META_TOOLS', () => {
    it('includes all expected meta tools', () => {
      const names = META_TOOLS.map((t) => t.name);
      expect(names).toContain('schrute_explore');
      expect(names).toContain('schrute_recover_explore');
      expect(names).toContain('schrute_record');
      expect(names).toContain('schrute_stop');
      expect(names).toContain('schrute_pipeline_status');
      expect(names).toContain('schrute_sites');
      expect(names).toContain('schrute_skills');
      expect(names).toContain('schrute_status');
      expect(names).toContain('schrute_dry_run');
      expect(names).toContain('schrute_confirm');
    });

    it('includes schrute_execute meta tool', () => {
      const names = META_TOOLS.map((t) => t.name);
      expect(names).toContain('schrute_execute');
    });

    it('includes schrute_doctor meta tool', () => {
      const names = META_TOOLS.map((t) => t.name);
      expect(names).toContain('schrute_doctor');
    });

    it('includes schrute_export_cookies meta tool', () => {
      const names = META_TOOLS.map((t) => t.name);
      expect(names).toContain('schrute_export_cookies');
    });

    it('includes schrute_revoke meta tool', () => {
      const names = META_TOOLS.map((t) => t.name);
      expect(names).toContain('schrute_revoke');
    });

    it('all meta tools have valid inputSchema', () => {
      for (const tool of META_TOOLS) {
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.description).toBeTruthy();
      }
    });
  });

  describe('getBrowserToolDefinitions - browser_close', () => {
    it('browser_close has clarified description', () => {
      const defs = getBrowserToolDefinitions();
      const closeDef = defs.find(d => d.name === 'browser_close');
      if (closeDef) {
        expect(closeDef.description).toContain('NOT the session');
        expect(closeDef.description).toContain('schrute_close_session');
      }
    });
  });
});
