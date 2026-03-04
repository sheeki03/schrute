import { describe, it, expect } from 'vitest';
import {
  rankToolsByIntent,
  skillToToolName,
  skillToToolDefinition,
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
      expect(names).toContain('oneagent_explore');
      expect(names).toContain('oneagent_record');
      expect(names).toContain('oneagent_stop');
      expect(names).toContain('oneagent_sites');
      expect(names).toContain('oneagent_skills');
      expect(names).toContain('oneagent_status');
      expect(names).toContain('oneagent_dry_run');
      expect(names).toContain('oneagent_confirm');
    });

    it('includes oneagent_execute meta tool', () => {
      const names = META_TOOLS.map((t) => t.name);
      expect(names).toContain('oneagent_execute');
    });

    it('includes oneagent_doctor meta tool', () => {
      const names = META_TOOLS.map((t) => t.name);
      expect(names).toContain('oneagent_doctor');
    });

    it('includes oneagent_export_cookies meta tool', () => {
      const names = META_TOOLS.map((t) => t.name);
      expect(names).toContain('oneagent_export_cookies');
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
        expect(closeDef.description).toContain('oneagent_close_session');
      }
    });
  });
});
