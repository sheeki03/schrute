import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock logger ─────────────────────────────────────────────────
vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { getStrategy, updateStrategy } from '../../src/automation/strategy.js';
import { ExecutionTier } from '../../src/skill/types.js';
import type { StrategyObservation } from '../../src/automation/strategy.js';

describe('strategy', () => {
  // Note: strategy.ts uses module-level Maps, so state persists between tests.
  // We use unique siteIds to avoid interference.
  let siteCounter = 0;

  function uniqueSiteId(): string {
    return `strategy-test-site-${++siteCounter}-${Date.now()}`;
  }

  describe('getStrategy', () => {
    it('returns default strategy for unknown site', () => {
      const siteId = uniqueSiteId();
      const strategy = getStrategy(siteId);
      expect(strategy.defaultTier).toBe(ExecutionTier.BROWSER_PROXIED);
      expect(strategy.overrides).toEqual({});
    });

    it('returns same instance for same site', () => {
      const siteId = uniqueSiteId();
      const s1 = getStrategy(siteId);
      const s2 = getStrategy(siteId);
      expect(s1).toBe(s2);
    });
  });

  describe('promotion logic', () => {
    it('promotes skill to DIRECT after 3+ successes at >=80% rate at DIRECT tier', () => {
      const siteId = uniqueSiteId();
      const skillId = 'test-skill-promote';

      // 3 successful direct observations
      for (let i = 0; i < 3; i++) {
        updateStrategy(siteId, {
          skillId,
          tier: ExecutionTier.DIRECT,
          success: true,
          latencyMs: 50,
        });
      }

      const strategy = getStrategy(siteId);
      expect(strategy.overrides[skillId]).toBe(ExecutionTier.DIRECT);
    });

    it('does not promote with fewer than 3 successes', () => {
      const siteId = uniqueSiteId();
      const skillId = 'test-skill-no-promote';

      for (let i = 0; i < 2; i++) {
        updateStrategy(siteId, {
          skillId,
          tier: ExecutionTier.DIRECT,
          success: true,
          latencyMs: 50,
        });
      }

      const strategy = getStrategy(siteId);
      expect(strategy.overrides[skillId]).toBeUndefined();
    });

    it('does not promote when success rate is below 80%', () => {
      const siteId = uniqueSiteId();
      const skillId = 'test-skill-low-rate';

      // 3 successes, 5 failures = 37.5% rate
      for (let i = 0; i < 3; i++) {
        updateStrategy(siteId, {
          skillId,
          tier: ExecutionTier.DIRECT,
          success: true,
          latencyMs: 50,
        });
      }
      for (let i = 0; i < 5; i++) {
        updateStrategy(siteId, {
          skillId,
          tier: ExecutionTier.DIRECT,
          success: false,
          latencyMs: 500,
        });
      }

      const strategy = getStrategy(siteId);
      // With 3 success / 8 total = 37.5%, should have been demoted
      expect(strategy.overrides[skillId]).toBe(ExecutionTier.BROWSER_PROXIED);
    });
  });

  describe('demotion logic', () => {
    it('demotes skill to BROWSER_PROXIED after 3+ attempts with <50% success at DIRECT', () => {
      const siteId = uniqueSiteId();
      const skillId = 'test-skill-demote';

      // 1 success, 3 failures = 25% rate
      updateStrategy(siteId, {
        skillId,
        tier: ExecutionTier.DIRECT,
        success: true,
        latencyMs: 50,
      });
      for (let i = 0; i < 3; i++) {
        updateStrategy(siteId, {
          skillId,
          tier: ExecutionTier.DIRECT,
          success: false,
          latencyMs: 500,
        });
      }

      const strategy = getStrategy(siteId);
      expect(strategy.overrides[skillId]).toBe(ExecutionTier.BROWSER_PROXIED);
    });

    it('does not demote with >=50% success rate', () => {
      const siteId = uniqueSiteId();
      const skillId = 'test-skill-no-demote';

      // 2 success, 2 failures = 50% rate
      for (let i = 0; i < 2; i++) {
        updateStrategy(siteId, {
          skillId,
          tier: ExecutionTier.DIRECT,
          success: true,
          latencyMs: 50,
        });
      }
      for (let i = 0; i < 2; i++) {
        updateStrategy(siteId, {
          skillId,
          tier: ExecutionTier.DIRECT,
          success: false,
          latencyMs: 500,
        });
      }

      const strategy = getStrategy(siteId);
      // 50% is not < 50%, so should not be demoted
      expect(strategy.overrides[skillId]).toBeUndefined();
    });
  });

  describe('default tier update', () => {
    it('updates default tier when a tier has 5+ observations at >=80% success', () => {
      const siteId = uniqueSiteId();

      // 5 successful observations at DIRECT tier
      for (let i = 0; i < 5; i++) {
        updateStrategy(siteId, {
          skillId: `skill-${i}`,
          tier: ExecutionTier.DIRECT,
          success: true,
          latencyMs: 50,
        });
      }

      const strategy = getStrategy(siteId);
      expect(strategy.defaultTier).toBe(ExecutionTier.DIRECT);
    });

    it('does not update default tier with insufficient observations', () => {
      const siteId = uniqueSiteId();

      for (let i = 0; i < 4; i++) {
        updateStrategy(siteId, {
          skillId: `skill-${i}`,
          tier: ExecutionTier.DIRECT,
          success: true,
          latencyMs: 50,
        });
      }

      const strategy = getStrategy(siteId);
      expect(strategy.defaultTier).toBe(ExecutionTier.BROWSER_PROXIED);
    });
  });
});
