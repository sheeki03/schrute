import { describe, it, expect } from 'vitest';
import { checkSemantic } from '../../src/replay/semantic-check.js';
import type { SkillSpec } from '../../src/skill/types.js';

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
    validation: {
      semanticChecks: [],
      customInvariants: [],
    },
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

describe('semantic-check', () => {
  describe('schema_match', () => {
    it('passes for valid response matching schema', () => {
      const skill = makeSkill({
        validation: { semanticChecks: ['schema_match'], customInvariants: [] },
        outputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            name: { type: 'string' },
          },
          required: ['id', 'name'],
        },
      });
      const result = checkSemantic(
        { status: 200, headers: {}, body: JSON.stringify({ id: 1, name: 'test' }) },
        skill,
      );
      expect(result.pass).toBe(true);
      expect(result.details).toContain('schema_match: OK');
    });

    it('fails for type mismatch', () => {
      const skill = makeSkill({
        validation: { semanticChecks: ['schema_match'], customInvariants: [] },
        outputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            name: { type: 'string' },
          },
          required: ['id', 'name'],
        },
      });
      const result = checkSemantic(
        { status: 200, headers: {}, body: JSON.stringify({ id: 'not_a_number', name: 'test' }) },
        skill,
      );
      expect(result.pass).toBe(false);
    });
  });

  describe('no_error_signatures', () => {
    it('detects {"error": ...}', () => {
      const skill = makeSkill({
        validation: { semanticChecks: ['no_error_signatures'], customInvariants: [] },
      });
      const result = checkSemantic(
        { status: 200, headers: {}, body: JSON.stringify({ error: 'something went wrong' }) },
        skill,
      );
      expect(result.pass).toBe(false);
      expect(result.details.some((d) => d.includes('error_field'))).toBe(true);
    });

    it('detects "session expired"', () => {
      const skill = makeSkill({
        validation: { semanticChecks: ['no_error_signatures'], customInvariants: [] },
      });
      const result = checkSemantic(
        { status: 200, headers: {}, body: 'Your session expired, please login again' },
        skill,
      );
      expect(result.pass).toBe(false);
      expect(result.details.some((d) => d.includes('session_expired'))).toBe(true);
    });

    it('passes for clean response', () => {
      const skill = makeSkill({
        validation: { semanticChecks: ['no_error_signatures'], customInvariants: [] },
      });
      const result = checkSemantic(
        { status: 200, headers: {}, body: JSON.stringify({ data: [1, 2, 3] }) },
        skill,
      );
      expect(result.pass).toBe(true);
      expect(result.details).toContain('no_error_signatures: OK');
    });
  });

  describe('custom invariants', () => {
    it('must_include_field works', () => {
      const skill = makeSkill({
        validation: {
          semanticChecks: [],
          customInvariants: ['must_include_field:data'],
        },
      });

      const passResult = checkSemantic(
        { status: 200, headers: {}, body: JSON.stringify({ data: [1, 2] }) },
        skill,
      );
      expect(passResult.pass).toBe(true);

      const failResult = checkSemantic(
        { status: 200, headers: {}, body: JSON.stringify({ results: [1, 2] }) },
        skill,
      );
      expect(failResult.pass).toBe(false);
    });

    it('must_not_contain works', () => {
      const skill = makeSkill({
        validation: {
          semanticChecks: [],
          customInvariants: ['must_not_contain:FORBIDDEN'],
        },
      });

      const passResult = checkSemantic(
        { status: 200, headers: {}, body: JSON.stringify({ data: 'ok' }) },
        skill,
      );
      expect(passResult.pass).toBe(true);

      const failResult = checkSemantic(
        { status: 200, headers: {}, body: 'This response contains FORBIDDEN data' },
        skill,
      );
      expect(failResult.pass).toBe(false);
    });

    it('field_non_empty works', () => {
      const skill = makeSkill({
        validation: {
          semanticChecks: [],
          customInvariants: ['field_non_empty:items'],
        },
      });

      const passResult = checkSemantic(
        { status: 200, headers: {}, body: JSON.stringify({ items: [1, 2, 3] }) },
        skill,
      );
      expect(passResult.pass).toBe(true);

      const failEmptyArray = checkSemantic(
        { status: 200, headers: {}, body: JSON.stringify({ items: [] }) },
        skill,
      );
      expect(failEmptyArray.pass).toBe(false);

      const failEmptyString = checkSemantic(
        { status: 200, headers: {}, body: JSON.stringify({ items: '' }) },
        skill,
      );
      expect(failEmptyString.pass).toBe(false);

      const failMissing = checkSemantic(
        { status: 200, headers: {}, body: JSON.stringify({ other: 'value' }) },
        skill,
      );
      expect(failMissing.pass).toBe(false);
    });
  });
});
