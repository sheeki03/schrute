import { describe, it, expect } from 'vitest';
import { parseResponse } from '../../src/replay/response-parser.js';
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

describe('response-parser (extended)', () => {
  describe('JSON parsing', () => {
    it('parses valid JSON body', () => {
      const skill = makeSkill();
      const result = parseResponse(
        { status: 200, headers: {}, body: JSON.stringify({ id: 1, name: 'test' }) },
        skill,
      );
      expect(result.data).toEqual({ id: 1, name: 'test' });
    });

    it('returns raw string for non-JSON body without outputSchema', () => {
      const skill = makeSkill();
      const result = parseResponse(
        { status: 200, headers: {}, body: 'plain text response' },
        skill,
      );
      expect(result.data).toBe('plain text response');
      expect(result.errors).toHaveLength(0);
    });

    it('reports parse error for non-JSON body with outputSchema', () => {
      const skill = makeSkill({
        outputSchema: { type: 'object', properties: { id: { type: 'number' } } },
      });
      const result = parseResponse(
        { status: 200, headers: {}, body: 'not valid json' },
        skill,
      );
      expect(result.errors.some((e) => e.type === 'parse_error')).toBe(true);
    });

    it('treats explicit html content as text without forcing json parsing', () => {
      const skill = makeSkill({
        responseContentType: 'text/html',
      });
      const result = parseResponse(
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<html><body>Hello</body></html>' },
        skill,
      );
      expect(result.data).toBe('<html><body>Hello</body></html>');
      expect(result.errors.some((e) => e.type === 'parse_error')).toBe(false);
    });
  });

  describe('error signature detection in 200-range responses', () => {
    it('detects json_error_field with "error" key', () => {
      const skill = makeSkill();
      const result = parseResponse(
        { status: 200, headers: {}, body: JSON.stringify({ error: 'something failed' }) },
        skill,
      );
      const errorSig = result.errors.find((e) => e.detail === 'json_error_field');
      expect(errorSig).toBeDefined();
      expect(errorSig!.type).toBe('error_signature');
    });

    it('detects json_error_field with "errors" key', () => {
      const skill = makeSkill();
      const result = parseResponse(
        { status: 200, headers: {}, body: JSON.stringify({ errors: [{ message: 'fail' }] }) },
        skill,
      );
      expect(result.errors.some((e) => e.detail === 'json_error_field')).toBe(true);
    });

    it('detects session_expired signature', () => {
      const skill = makeSkill();
      const result = parseResponse(
        { status: 200, headers: {}, body: 'Your session expired, please log back in' },
        skill,
      );
      expect(result.errors.some((e) => e.detail === 'session_expired')).toBe(true);
    });

    it('detects please_refresh signature', () => {
      const skill = makeSkill();
      const result = parseResponse(
        { status: 200, headers: {}, body: '<html>Please refresh your browser</html>' },
        skill,
      );
      expect(result.errors.some((e) => e.detail === 'please_refresh')).toBe(true);
    });

    it('detects redirect_to_login signature', () => {
      const skill = makeSkill();
      const result = parseResponse(
        { status: 200, headers: {}, body: '<script>window.location = "/login"</script>' },
        skill,
      );
      expect(result.errors.some((e) => e.detail === 'redirect_to_login')).toBe(true);
    });

    it('does not flag error signatures on non-200 responses', () => {
      const skill = makeSkill();
      const result = parseResponse(
        { status: 500, headers: {}, body: JSON.stringify({ error: 'server error' }) },
        skill,
      );
      // Error signatures only checked for 200-range
      const errorSigs = result.errors.filter((e) => e.type === 'error_signature');
      expect(errorSigs).toHaveLength(0);
    });

    it('passes clean 200 response with no error signatures', () => {
      const skill = makeSkill();
      const result = parseResponse(
        { status: 200, headers: {}, body: JSON.stringify({ data: [1, 2, 3] }) },
        skill,
      );
      const errorSigs = result.errors.filter((e) => e.type === 'error_signature');
      expect(errorSigs).toHaveLength(0);
    });
  });

  describe('schema validation', () => {
    it('validates object with required fields', () => {
      const skill = makeSkill({
        outputSchema: {
          type: 'object',
          properties: { id: { type: 'number' }, name: { type: 'string' } },
          required: ['id', 'name'],
        },
      });
      const pass = parseResponse(
        { status: 200, headers: {}, body: JSON.stringify({ id: 1, name: 'ok' }) },
        skill,
      );
      expect(pass.schemaMatch).toBe(true);

      const fail = parseResponse(
        { status: 200, headers: {}, body: JSON.stringify({ id: 1 }) },
        skill,
      );
      expect(fail.schemaMatch).toBe(false);
      expect(fail.errors.some((e) => e.type === 'schema_mismatch')).toBe(true);
    });

    it('validates array items', () => {
      const skill = makeSkill({
        outputSchema: {
          type: 'array',
          items: { type: 'number' },
        },
      });
      const pass = parseResponse(
        { status: 200, headers: {}, body: JSON.stringify([1, 2, 3]) },
        skill,
      );
      expect(pass.schemaMatch).toBe(true);

      const fail = parseResponse(
        { status: 200, headers: {}, body: JSON.stringify([1, 'two', 3]) },
        skill,
      );
      expect(fail.schemaMatch).toBe(false);
    });

    it('validates nested object types', () => {
      const skill = makeSkill({
        outputSchema: {
          type: 'object',
          properties: {
            user: {
              type: 'object',
              properties: { name: { type: 'string' }, age: { type: 'number' } },
              required: ['name'],
            },
          },
          required: ['user'],
        },
      });
      const pass = parseResponse(
        { status: 200, headers: {}, body: JSON.stringify({ user: { name: 'Alice', age: 30 } }) },
        skill,
      );
      expect(pass.schemaMatch).toBe(true);

      const fail = parseResponse(
        { status: 200, headers: {}, body: JSON.stringify({ user: { age: 30 } }) },
        skill,
      );
      expect(fail.schemaMatch).toBe(false);
    });

    it('accepts anything when no outputSchema is defined', () => {
      const skill = makeSkill({ outputSchema: undefined });
      const result = parseResponse(
        { status: 200, headers: {}, body: 'any arbitrary content' },
        skill,
      );
      expect(result.schemaMatch).toBe(true);
    });
  });
});
