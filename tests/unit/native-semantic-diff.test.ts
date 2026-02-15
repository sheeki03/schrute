import { describe, it, expect } from 'vitest';
import { checkSemanticNative } from '../../src/native/semantic-diff.js';
import type { SkillSpec } from '../../src/skill/types.js';

function makeSkill(overrides: Partial<SkillSpec> = {}): SkillSpec {
  return {
    id: 'test.skill.v1',
    version: 1,
    status: 'active',
    currentTier: 'tier_1',
    tierLock: null,
    allowedDomains: ['example.com'],
    requiredCapabilities: ['net.fetch.direct'],
    parameters: [],
    validation: {
      semanticChecks: ['schema_match', 'no_error_signatures'],
      customInvariants: [],
    },
    redaction: { piiClassesFound: [], fieldsRedacted: 0 },
    replayStrategy: 'prefer_tier_1',
    sideEffectClass: 'read-only',
    sampleCount: 5,
    consecutiveValidations: 3,
    confidence: 0.95,
    method: 'GET',
    pathTemplate: '/api/data',
    inputSchema: {},
    outputSchema: {
      type: 'object',
      properties: {
        data: { type: 'array' },
        count: { type: 'number' },
      },
      required: ['data'],
    },
    isComposite: false,
    siteId: 'example.com',
    name: 'Test Skill',
    successRate: 1.0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('native semantic diff (TS fallback)', () => {
  it('passes for valid response matching schema', () => {
    const response = {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: [1, 2, 3], count: 3 }),
    };

    const result = checkSemanticNative(response, makeSkill());
    expect(result.pass).toBe(true);
    expect(result.details).toContain('schema_match: OK');
    expect(result.details).toContain('no_error_signatures: OK');
  });

  it('fails for response with error signatures', () => {
    const response = {
      status: 200,
      headers: {},
      body: JSON.stringify({ error: 'Something went wrong', data: [] }),
    };

    const result = checkSemanticNative(response, makeSkill());
    expect(result.pass).toBe(false);
    expect(result.details.some(d => d.includes('error_field'))).toBe(true);
  });

  it('fails for response not matching schema (missing required field)', () => {
    const response = {
      status: 200,
      headers: {},
      body: JSON.stringify({ count: 5 }), // missing 'data'
    };

    const result = checkSemanticNative(response, makeSkill());
    expect(result.pass).toBe(false);
    expect(result.details.some(d => d.includes('schema_match'))).toBe(true);
  });

  it('evaluates must_include_field invariant', () => {
    const skill = makeSkill({
      validation: {
        semanticChecks: [],
        customInvariants: ['must_include_field:data'],
      },
    });

    const passResponse = {
      status: 200,
      headers: {},
      body: JSON.stringify({ data: [1] }),
    };

    const failResponse = {
      status: 200,
      headers: {},
      body: JSON.stringify({ results: [1] }),
    };

    expect(checkSemanticNative(passResponse, skill).pass).toBe(true);
    expect(checkSemanticNative(failResponse, skill).pass).toBe(false);
  });

  it('evaluates must_not_contain invariant', () => {
    const skill = makeSkill({
      validation: {
        semanticChecks: [],
        customInvariants: ['must_not_contain:FORBIDDEN'],
      },
    });

    const passResponse = {
      status: 200,
      headers: {},
      body: 'all good',
    };

    const failResponse = {
      status: 200,
      headers: {},
      body: 'contains FORBIDDEN marker',
    };

    expect(checkSemanticNative(passResponse, skill).pass).toBe(true);
    expect(checkSemanticNative(failResponse, skill).pass).toBe(false);
  });

  it('detects session_expired pattern', () => {
    const response = {
      status: 200,
      headers: {},
      body: 'Your session expired, please log in again.',
    };

    const skill = makeSkill({
      validation: {
        semanticChecks: ['no_error_signatures'],
        customInvariants: [],
      },
      outputSchema: undefined,
    });

    const result = checkSemanticNative(response, skill);
    expect(result.pass).toBe(false);
    expect(result.details.some(d => d.includes('session_expired'))).toBe(true);
  });
});
