import { describe, it, expect } from 'vitest';
import { validateParams, buildExecutionSchema } from '../../src/replay/param-validator.js';
import type { SkillSpec } from '../../src/skill/types.js';

const makeSkill = (overrides: Partial<SkillSpec>): SkillSpec =>
  ({
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
    sampleCount: 1,
    consecutiveValidations: 0,
    confidence: 1,
    method: 'GET',
    pathTemplate: '/api/test',
    inputSchema: {},
    isComposite: false,
    siteId: 'example.com',
    name: 'test_skill',
    successRate: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as SkillSpec);

describe('param-validator', () => {
  describe('validateParams', () => {
    it('rejects missing required path param', () => {
      const skill = makeSkill({ pathTemplate: '/api/users/{userId}' });
      const result = validateParams({}, skill);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining("Missing required parameter: 'userId'")]),
      );
    });

    it('rejects missing required user_input param', () => {
      const skill = makeSkill({
        parameters: [
          { name: 'query', type: 'string', source: 'user_input', evidence: [] },
        ],
      });
      const result = validateParams({}, skill);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining("Missing required parameter: 'query'")]),
      );
    });

    it('handles type mismatch (number passed where string expected)', () => {
      const skill = makeSkill({
        parameters: [
          { name: 'name', type: 'string', source: 'user_input', evidence: [] },
        ],
      });
      const result = validateParams({ name: 42 }, skill);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining("Type mismatch for 'name'")]),
      );
    });

    it('rejects string exceeding maxLength', () => {
      const skill = makeSkill({
        parameters: [
          { name: 'body', type: 'string', source: 'user_input', evidence: [] },
        ],
      });
      const longStr = 'a'.repeat(101);
      const result = validateParams({ body: longStr }, skill, { maxStringLength: 100 });
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('exceeds max length 100')]),
      );
    });

    it('rejects object exceeding maxDepth', () => {
      const skill = makeSkill({
        parameters: [
          { name: 'data', type: 'object', source: 'user_input', evidence: [] },
        ],
      });
      const deep = { a: { b: { c: { d: 'deep' } } } };
      const result = validateParams({ data: deep }, skill, { maxDepth: 2 });
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('nesting depth')]),
      );
    });

    it('rejects too many properties', () => {
      const skill = makeSkill({
        parameters: Array.from({ length: 60 }, (_, i) => ({
          name: `p${i}`,
          type: 'string',
          source: 'user_input' as const,
          evidence: [],
        })),
      });
      const params: Record<string, unknown> = {};
      for (let i = 0; i < 60; i++) params[`p${i}`] = 'v';
      const result = validateParams(params, skill, { maxProperties: 50 });
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('Too many properties')]),
      );
    });

    it('allows omission of extracted params (not required)', () => {
      const skill = makeSkill({
        parameters: [
          { name: 'token', type: 'string', source: 'extracted', evidence: [] },
        ],
      });
      const result = validateParams({}, skill);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('passes valid params matching execution schema', () => {
      const skill = makeSkill({
        pathTemplate: '/api/users/{userId}',
        parameters: [
          { name: 'query', type: 'string', source: 'user_input', evidence: [] },
        ],
      });
      const result = validateParams({ userId: '123', query: 'search term' }, skill);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('passes when skill has no params and no path params', () => {
      const skill = makeSkill({ pathTemplate: '/api/health', parameters: [] });
      const result = validateParams({}, skill);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects unknown param keys', () => {
      const skill = makeSkill({ pathTemplate: '/api/test', parameters: [] });
      const result = validateParams({ rogue: 'value' }, skill);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining("Unknown parameter: 'rogue'")]),
      );
    });
  });

  describe('buildExecutionSchema', () => {
    it('returns correct structure with path params and skill params', () => {
      const skill = makeSkill({
        pathTemplate: '/api/users/{userId}/posts/{postId}',
        parameters: [
          { name: 'title', type: 'string', source: 'user_input', evidence: [] },
          { name: 'count', type: 'number', source: 'user_input', evidence: [], required: false },
          { name: 'token', type: 'string', source: 'extracted', evidence: [] },
        ],
      });

      const schema = buildExecutionSchema(skill);

      // Path params
      expect(schema.properties).toHaveProperty('userId', { type: 'string' });
      expect(schema.properties).toHaveProperty('postId', { type: 'string' });

      // Skill params
      expect(schema.properties).toHaveProperty('title', { type: 'string' });
      expect(schema.properties).toHaveProperty('count', { type: 'number' });
      expect(schema.properties).toHaveProperty('token', { type: 'string' });

      // Required: path params + user_input params where isParamRequired is true
      expect(schema.required).toContain('userId');
      expect(schema.required).toContain('postId');
      expect(schema.required).toContain('title');
      // count has required: false explicitly
      expect(schema.required).not.toContain('count');
      // extracted source → not required
      expect(schema.required).not.toContain('token');
    });

    it('returns empty properties and required for skill with no params', () => {
      const skill = makeSkill({ pathTemplate: '/api/health', parameters: [] });
      const schema = buildExecutionSchema(skill);
      expect(schema.properties).toEqual({});
      expect(schema.required).toEqual([]);
    });
  });
});
