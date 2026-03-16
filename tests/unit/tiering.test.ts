import { describe, it, expect } from 'vitest';
import {
  checkPromotion,
  handleFailure,
  getEffectiveTier,
} from '../../src/core/tiering.js';
import { TierState, FailureCause, ExecutionTier } from '../../src/skill/types.js';
import type {
  SkillSpec,
  FieldVolatility,
  SchruteConfig,
  PermanentTierLock,
} from '../../src/skill/types.js';

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
    status: 'active',
    currentTier: TierState.TIER_3_DEFAULT,
    tierLock: null,
    allowedDomains: ['example.com'],
    requiredCapabilities: [],
    parameters: [],
    validation: { semanticChecks: ['schema_match'], customInvariants: [] },
    redaction: { piiClassesFound: [], fieldsRedacted: 0 },
    replayStrategy: 'prefer_tier_1',
    sideEffectClass: 'read-only',
    sampleCount: 10,
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

function makeStaticVolatility(): FieldVolatility[] {
  return [
    {
      fieldPath: 'content-type',
      fieldLocation: 'header',
      entropy: 0.0,
      changeRate: 0.0,
      looksLikeNonce: false,
      looksLikeToken: false,
      isStatic: true,
    },
  ];
}

function makeHighVolatility(): FieldVolatility[] {
  return [
    {
      fieldPath: 'nonce',
      fieldLocation: 'body',
      entropy: 4.5,
      changeRate: 1.0,
      looksLikeNonce: true,
      looksLikeToken: false,
      isStatic: false,
    },
  ];
}

const config = makeConfig();

describe('tiering', () => {
  describe('promotion', () => {
    it('promotes after 5 consecutive passes with low volatility', () => {
      const skill = makeSkill({ consecutiveValidations: 5 });
      const result = checkPromotion(
        skill,
        makeStaticVolatility(),
        { match: true, hasDynamicRequiredFields: false },
        config,
      );
      expect(result.promote).toBe(true);
    });

    it('does not promote with fewer than 5 consecutive passes', () => {
      const skill = makeSkill({ consecutiveValidations: 3 });
      const result = checkPromotion(
        skill,
        makeStaticVolatility(),
        { match: true, hasDynamicRequiredFields: false },
        config,
      );
      expect(result.promote).toBe(false);
      expect(result.reason).toContain('3/5');
    });

    it('does not promote with high volatility', () => {
      const skill = makeSkill({ consecutiveValidations: 5 });
      const result = checkPromotion(
        skill,
        makeHighVolatility(),
        { match: true, hasDynamicRequiredFields: false },
        config,
      );
      expect(result.promote).toBe(false);
    });

    it('does not promote if already at Tier 1', () => {
      const skill = makeSkill({ currentTier: TierState.TIER_1_PROMOTED });
      const result = checkPromotion(
        skill,
        makeStaticVolatility(),
        { match: true, hasDynamicRequiredFields: false },
        config,
      );
      expect(result.promote).toBe(false);
      expect(result.reason).toContain('Already at Tier 1');
    });
  });

  describe('siteRecommendedTier promotion', () => {
    it('promotes after 1 pass when siteRecommendedTier is direct', () => {
      const skill = makeSkill({ consecutiveValidations: 1, tierLock: null });
      const result = checkPromotion(
        skill,
        makeStaticVolatility(),
        { match: true, hasDynamicRequiredFields: false },
        config,
        ExecutionTier.DIRECT,
      );
      expect(result.promote).toBe(true);
    });

    it('does NOT promote with 0 validations even when site recommends direct', () => {
      const skill = makeSkill({ consecutiveValidations: 0, tierLock: null });
      const result = checkPromotion(
        skill,
        makeStaticVolatility(),
        { match: true, hasDynamicRequiredFields: false },
        config,
        ExecutionTier.DIRECT,
      );
      expect(result.promote).toBe(false);
      expect(result.reason).toContain('0/1');
    });

    it('does NOT promote permanently locked skill even with site recommendation', () => {
      const skill = makeSkill({
        consecutiveValidations: 10,
        tierLock: { type: 'permanent', reason: 'signed_payload', evidence: 'test' },
      });
      const result = checkPromotion(
        skill,
        makeStaticVolatility(),
        { match: true, hasDynamicRequiredFields: false },
        config,
        ExecutionTier.DIRECT,
      );
      expect(result.promote).toBe(false);
      expect(result.reason).toContain('Permanently locked');
    });

    it('uses standard threshold (5) when no site recommendation', () => {
      const skill = makeSkill({ consecutiveValidations: 1, tierLock: null });
      const result = checkPromotion(
        skill,
        makeStaticVolatility(),
        { match: true, hasDynamicRequiredFields: false },
        config,
      );
      expect(result.promote).toBe(false);
      expect(result.reason).toContain('1/5');
    });
  });

  describe('temporary demotion on failure', () => {
    it('demotes on transient failure', () => {
      const skill = makeSkill({ currentTier: TierState.TIER_1_PROMOTED });
      const result = handleFailure(skill, FailureCause.SCHEMA_DRIFT);
      expect(result.newTier).toBe(TierState.TIER_3_DEFAULT);
      expect(result.tierLock.type).toBe('temporary_demotion');
    });

    it('re-promotes after 5 new passes following demotion', () => {
      const skill = makeSkill({
        currentTier: TierState.TIER_3_DEFAULT,
        tierLock: { type: 'temporary_demotion', since: new Date().toISOString(), demotions: 1 },
        consecutiveValidations: 5,
      });
      const result = checkPromotion(
        skill,
        makeStaticVolatility(),
        { match: true, hasDynamicRequiredFields: false },
        config,
      );
      // Temporary demotion doesn't block promotion -- it's just a lock type
      // The skill should be eligible for promotion if consecutiveValidations >= 5
      // But we need to clear the tierLock for promotion to succeed
      // Actually, looking at the code, checkPromotion only checks for permanent lock
      expect(result.promote).toBe(true);
    });
  });

  describe('permanent lock', () => {
    it('permanent lock on js_computed_field', () => {
      const skill = makeSkill();
      const result = handleFailure(skill, FailureCause.JS_COMPUTED_FIELD);
      expect(result.tierLock.type).toBe('permanent');
      expect((result.tierLock as PermanentTierLock).reason).toBe('js_computed_field');
    });

    it('permanent lock on protocol_sensitivity', () => {
      const skill = makeSkill();
      const result = handleFailure(skill, FailureCause.PROTOCOL_SENSITIVITY);
      expect(result.tierLock.type).toBe('permanent');
      expect((result.tierLock as PermanentTierLock).reason).toBe('protocol_sensitivity');
    });

    it('permanent lock on signed_payload', () => {
      const skill = makeSkill();
      const result = handleFailure(skill, FailureCause.SIGNED_PAYLOAD);
      expect(result.tierLock.type).toBe('permanent');
      expect((result.tierLock as PermanentTierLock).reason).toBe('signed_payload');
    });

    it('no transition out of permanent lock', () => {
      const lock: PermanentTierLock = {
        type: 'permanent',
        reason: 'js_computed_field',
        evidence: 'test',
      };
      const skill = makeSkill({
        tierLock: lock,
        consecutiveValidations: 10,
      });
      const result = checkPromotion(
        skill,
        makeStaticVolatility(),
        { match: true, hasDynamicRequiredFields: false },
        config,
      );
      expect(result.promote).toBe(false);
      expect(result.reason).toContain('Permanently locked');
    });
  });

  describe('getEffectiveTier', () => {
    it('returns Tier 3 for permanently locked skill', () => {
      const skill = makeSkill({
        currentTier: TierState.TIER_1_PROMOTED,
        tierLock: { type: 'permanent', reason: 'js_computed_field', evidence: 'test' },
      });
      expect(getEffectiveTier(skill)).toBe(TierState.TIER_3_DEFAULT);
    });

    it('returns Tier 3 for temporarily demoted skill', () => {
      const skill = makeSkill({
        currentTier: TierState.TIER_1_PROMOTED,
        tierLock: { type: 'temporary_demotion', since: new Date().toISOString(), demotions: 1 },
      });
      expect(getEffectiveTier(skill)).toBe(TierState.TIER_3_DEFAULT);
    });

    it('returns current tier when no lock', () => {
      const skill = makeSkill({ currentTier: TierState.TIER_1_PROMOTED, tierLock: null });
      expect(getEffectiveTier(skill)).toBe(TierState.TIER_1_PROMOTED);
    });
  });
});
