import { describe, it, expect } from 'vitest';
import {
  calculateConfidence,
  isStale,
  isBroken,
  incrementVersion,
} from '../../src/skill/versioning.js';
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

describe('versioning', () => {
  describe('calculateConfidence', () => {
    it('recent verification -> high confidence', () => {
      const skill = makeSkill({ lastVerified: Date.now() });
      const confidence = calculateConfidence(skill);
      expect(confidence).toBeGreaterThan(0.9);
    });

    it('old verification -> low confidence', () => {
      const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
      const skill = makeSkill({ lastVerified: ninetyDaysAgo });
      const confidence = calculateConfidence(skill);
      // exp(-90/30) = exp(-3) ~ 0.05
      expect(confidence).toBeLessThan(0.1);
    });

    it('returns 0 for never-verified skill', () => {
      const skill = makeSkill({ lastVerified: undefined });
      expect(calculateConfidence(skill)).toBe(0);
    });

    it('returns 1 for just-verified skill', () => {
      const skill = makeSkill({ lastVerified: Date.now() + 1000 });
      expect(calculateConfidence(skill)).toBe(1);
    });
  });

  describe('isStale', () => {
    it('returns true when confidence < 0.3', () => {
      // ln(0.3) = -1.204, so -days/30 = -1.204 -> days ~ 36.1
      const fortyDaysAgo = Date.now() - 40 * 24 * 60 * 60 * 1000;
      const skill = makeSkill({ lastVerified: fortyDaysAgo });
      expect(isStale(skill)).toBe(true);
    });

    it('returns false when confidence >= 0.3', () => {
      const skill = makeSkill({ lastVerified: Date.now() });
      expect(isStale(skill)).toBe(false);
    });
  });

  describe('isBroken', () => {
    it('returns true when confidence < 0.1', () => {
      // ln(0.1) = -2.303, so -days/30 = -2.303 -> days ~ 69.1
      const seventyDaysAgo = Date.now() - 75 * 24 * 60 * 60 * 1000;
      const skill = makeSkill({ lastVerified: seventyDaysAgo });
      expect(isBroken(skill)).toBe(true);
    });

    it('returns false when confidence >= 0.1', () => {
      const skill = makeSkill({ lastVerified: Date.now() });
      expect(isBroken(skill)).toBe(false);
    });
  });

  describe('incrementVersion', () => {
    it('increments version and resets counters', () => {
      const skill = makeSkill({
        id: 'example.com.get-users.v1',
        version: 1,
        consecutiveValidations: 5,
        sampleCount: 10,
      });
      const v2 = incrementVersion(skill);
      expect(v2.id).toBe('example.com.get-users.v2');
      expect(v2.version).toBe(2);
      expect(v2.consecutiveValidations).toBe(0);
      expect(v2.sampleCount).toBe(0);
      expect(v2.confidence).toBe(0);
      expect(v2.lastVerified).toBeUndefined();
    });
  });
});
