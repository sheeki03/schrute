import { describe, it, expect } from 'vitest';
import { dryRun } from '../../src/replay/dry-run.js';
import type { SkillSpec, FieldVolatility } from '../../src/skill/types.js';
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

describe('dry-run', () => {
  it('produces agent-safe mode output with redacted headers', () => {
    const skill = makeSkill({
      requiredHeaders: { 'authorization': 'Bearer secret123', 'accept': 'application/json' },
    });
    const result = dryRun(skill, {}, 'agent-safe');
    expect(result.headers['authorization']).toBe('[REDACTED]');
    expect(result.headers['accept']).toBe('application/json');
    expect(result.policyDecision.redactionsApplied).toContain('headers');
  });

  it('redacts sensitive body fields in agent-safe mode', () => {
    const skill = makeSkill({ method: 'POST', pathTemplate: '/api/login' });
    const result = dryRun(skill, { password: 'secret123', username: 'user' }, 'agent-safe');
    if (result.body) {
      expect(result.body).not.toContain('secret123');
    }
  });

  it('redacts sensitive URL query parameters', () => {
    const skill = makeSkill({
      method: 'GET',
      pathTemplate: '/api/data',
    });
    const result = dryRun(skill, { token: 'abc123', page: '1' }, 'agent-safe');
    // URL.searchParams.set encodes brackets: [REDACTED] becomes %5BREDACTED%5D
    expect(result.url).toMatch(/REDACTED/);
    expect(result.url).toContain('page=1');
    expect(result.policyDecision.redactionsApplied).toContain('url');
  });

  it('includes volatility report and tier decision in developer-debug mode', () => {
    const volatility: FieldVolatility[] = [{
      fieldPath: 'nonce',
      fieldLocation: 'body',
      entropy: 4.0,
      changeRate: 1.0,
      looksLikeNonce: true,
      looksLikeToken: false,
      isStatic: false,
    }];
    const skill = makeSkill({
      currentTier: 'tier_1',
      tierLock: { type: 'permanent', reason: 'js_computed_field', evidence: 'test' },
    });
    const result = dryRun(skill, {}, 'developer-debug', {
      volatilityReport: volatility,
    });
    expect(result.volatilityReport).toBeDefined();
    expect(result.volatilityReport).toHaveLength(1);
    expect(result.tierDecision).toContain('tierLock.type=permanent');
    expect(result.tierDecision).toContain('tierLock.reason=js_computed_field');
  });

  it('does not include volatility report in agent-safe mode', () => {
    const volatility: FieldVolatility[] = [{
      fieldPath: 'nonce',
      fieldLocation: 'body',
      entropy: 4.0,
      changeRate: 1.0,
      looksLikeNonce: true,
      looksLikeToken: false,
      isStatic: false,
    }];
    const skill = makeSkill();
    const result = dryRun(skill, {}, 'agent-safe', {
      volatilityReport: volatility,
    });
    expect(result.volatilityReport).toBeUndefined();
    expect(result.tierDecision).toBeUndefined();
  });

  it('uses correct tier from skill state', () => {
    const skillTier1 = makeSkill({ currentTier: 'tier_1', tierLock: null });
    const result1 = dryRun(skillTier1, {}, 'agent-safe');
    expect(result1.tier).toBe('direct');

    const skillTier3 = makeSkill({ currentTier: 'tier_3', tierLock: null });
    const result3 = dryRun(skillTier3, {}, 'agent-safe');
    expect(result3.tier).toBe('browser_proxied');
  });

  it('redacts cookie header values', () => {
    const skill = makeSkill({
      requiredHeaders: { 'cookie': 'session=abc123; pref=dark' },
    });
    const result = dryRun(skill, {}, 'agent-safe');
    expect(result.headers['cookie']).toBe('[REDACTED]');
  });
});
