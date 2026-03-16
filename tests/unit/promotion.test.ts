import { describe, it, expect } from 'vitest';
import { canPromote, promoteSkill, demoteSkill } from '../../src/core/promotion.js';
import type { SkillSpec, SchruteConfig } from '../../src/skill/types.js';
import { SkillStatus, SideEffectClass } from '../../src/skill/types.js';

function makeConfig(overrides?: Partial<SchruteConfig>): SchruteConfig {
  return {
    dataDir: '/tmp/test-schrute',
    logLevel: 'silent',
    features: { webmcp: false, httpTransport: false },
    toolBudget: {
      maxToolCallsPerTask: 50,
      maxConcurrentCalls: 3,
      crossDomainCalls: false,
      secretsToNonAllowlisted: false,
    },
    payloadLimits: {
      maxResponseBodyBytes: 10 * 1024 * 1024,
      maxRequestBodyBytes: 5 * 1024 * 1024,
      replayTimeoutMs: { tier1: 30000, tier3: 60000, tier4: 120000 },
      harCaptureMaxBodyBytes: 50 * 1024 * 1024,
      redactorTimeoutMs: 10000,
    },
    audit: { strictMode: true, rootHashExport: true },
    storage: { maxPerSiteMb: 500, maxGlobalMb: 5000, retentionDays: 90 },
    server: { network: false },
    daemon: { port: 19420, autoStart: false },
    tempTtlMs: 3600000,
    gcIntervalMs: 900000,
    confirmationTimeoutMs: 30000,
    confirmationExpiryMs: 60000,
    promotionConsecutivePasses: 5,
    promotionVolatilityThreshold: 0.2,
    maxToolsPerSite: 20,
    toolShortlistK: 10,
    ...overrides,
  } as SchruteConfig;
}

function makeSkill(overrides: Partial<SkillSpec> = {}): SkillSpec {
  return {
    id: 'test.skill.v1',
    version: 1,
    status: 'draft',
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

const config = makeConfig();

describe('promotion', () => {
  describe('canPromote', () => {
    it('allows promotion when all criteria met', () => {
      const skill = makeSkill({
        status: 'draft',
        sampleCount: 5,
        consecutiveValidations: 5,
        sideEffectClass: 'read-only',
      });
      const check = canPromote(skill, config);
      expect(check.eligible).toBe(true);
    });

    it('rejects promotion for non-draft status', () => {
      const skill = makeSkill({ status: 'active' });
      const check = canPromote(skill, config);
      expect(check.eligible).toBe(false);
      expect(check.reason).toContain('active');
      expect(check.reason).toContain('draft');
    });

    it('rejects promotion with fewer than 2 recordings', () => {
      const skill = makeSkill({ sampleCount: 1 });
      const check = canPromote(skill, config);
      expect(check.eligible).toBe(false);
      expect(check.reason).toContain('minimum 2');
    });

    it('rejects promotion with insufficient consecutive validations', () => {
      const skill = makeSkill({ consecutiveValidations: 3 });
      const check = canPromote(skill, config);
      expect(check.eligible).toBe(false);
      expect(check.reason).toContain('3');
      expect(check.reason).toContain('5');
    });

    it('rejects promotion for non-read-only skills', () => {
      const skill = makeSkill({ sideEffectClass: 'non-idempotent' });
      const check = canPromote(skill, config);
      expect(check.eligible).toBe(false);
      expect(check.reason).toContain('read-only');
    });

    it('minimum 2 recordings is enforced exactly', () => {
      const skillWith2 = makeSkill({ sampleCount: 2 });
      expect(canPromote(skillWith2, config).eligible).toBe(true);

      const skillWith1 = makeSkill({ sampleCount: 1 });
      expect(canPromote(skillWith1, config).eligible).toBe(false);
    });
  });

  describe('promoteSkill', () => {
    it('promotes draft to active with updated fields', () => {
      const skill = makeSkill();
      const result = promoteSkill(skill, config);
      expect(result.previousStatus).toBe('draft');
      expect(result.newStatus).toBe('active');
      expect(result.skill.status).toBe('active');
      expect(result.skill.confidence).toBe(1.0);
    });

    it('throws when promotion criteria not met', () => {
      const skill = makeSkill({ status: 'active' });
      expect(() => promoteSkill(skill, config)).toThrow('Cannot promote');
    });
  });

  describe('demoteSkill', () => {
    it('demotes to stale by default', () => {
      const skill = makeSkill({ status: 'active' });
      const result = demoteSkill(skill, 'schema drift detected');
      expect(result.newStatus).toBe('stale');
      expect(result.reason).toBe('schema drift detected');
      expect(result.skill.consecutiveValidations).toBe(0);
    });

    it('demotes to broken when specified', () => {
      const skill = makeSkill({ status: 'active' });
      const result = demoteSkill(skill, 'endpoint removed', 'broken');
      expect(result.newStatus).toBe('broken');
    });

    it('resets consecutive validations on demotion', () => {
      const skill = makeSkill({ consecutiveValidations: 10 });
      const result = demoteSkill(skill, 'test reason');
      expect(result.skill.consecutiveValidations).toBe(0);
    });
  });
});
