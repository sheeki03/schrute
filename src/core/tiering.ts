import { getLogger } from './logger.js';
import { getConfig } from './config.js';
import type {
  SkillSpec,
  TierStateName,
  TierLock,
  PermanentTierLock,
  TemporaryDemotion,
  FieldVolatility,
  FailureCauseName,
  ExecutionTierName,
  SchruteConfig,
} from '../skill/types.js';
import { TierState, ExecutionTier, FailureCause } from '../skill/types.js';

const log = getLogger();

// ─── Types ──────────────────────────────────────────────────────

interface PromotionCheckResult {
  promote: boolean;
  lock?: TierLock;
  reason?: string;
}

interface FailureHandleResult {
  newTier: TierStateName;
  tierLock: TierLock;
  reason: string;
}

interface SemanticResult {
  match: boolean;
  hasDynamicRequiredFields: boolean;
}

// ─── Tier State Machine ─────────────────────────────────────────

/**
 * Two tier values (tier_1, tier_3) with optional lock discriminator (permanent | temporary_demotion):
 *   TIER_3_DEFAULT           — initial state, browser-proxied replay
 *   TIER_1_PROMOTED          — direct fetch, fast path
 * Lock discriminators (applied via TierLock):
 *   temporary_demotion       — transient failure, can re-promote
 *   permanent                — structural incompatibility, never promotes
 */

// ─── Promotion Check ────────────────────────────────────────────

/**
 * Check if a skill should be promoted from Tier 3 to Tier 1.
 *
 * Requirements:
 * - configurable consecutive validations (promotionConsecutivePasses)
 * - volatility below configurable threshold
 * - Semantic match in latest validation
 * - No dynamic required fields detected
 */
export function checkPromotion(
  skill: SkillSpec,
  volatilityScores: FieldVolatility[],
  semanticResult: SemanticResult,
  config?: SchruteConfig,
  siteRecommendedTier?: ExecutionTierName,
): PromotionCheckResult {
  const cfg = config ?? getConfig();
  let requiredPasses = cfg.promotionConsecutivePasses;

  // Lower threshold when site recommends direct tier
  if (siteRecommendedTier === ExecutionTier.DIRECT) {
    requiredPasses = Math.min(requiredPasses, 1);
  }
  const volatilityThreshold = cfg.promotionVolatilityThreshold;

  // Already at Tier 1
  if (skill.currentTier === TierState.TIER_1_PROMOTED) {
    return { promote: false, reason: 'Already at Tier 1' };
  }

  // Permanently locked
  if (skill.tierLock?.type === 'permanent') {
    return {
      promote: false,
      lock: skill.tierLock,
      reason: `Permanently locked: ${skill.tierLock.reason}`,
    };
  }

  // Check consecutive validations
  if (skill.consecutiveValidations < requiredPasses) {
    return {
      promote: false,
      reason: `${skill.consecutiveValidations}/${requiredPasses} consecutive validations`,
    };
  }

  // Check volatility
  const highVolatility = volatilityScores.filter(
    (v) => v.entropy > volatilityThreshold || v.changeRate > volatilityThreshold,
  );
  if (highVolatility.length > 0) {
    const fieldNames = highVolatility.map((v) => v.fieldPath).join(', ');
    return {
      promote: false,
      reason: `High volatility in fields: ${fieldNames}`,
    };
  }

  // Check for nonce/token fields — may indicate signed payloads
  const nonceFields = volatilityScores.filter((v) => v.looksLikeNonce || v.looksLikeToken);
  if (nonceFields.length > 0) {
    const lock: PermanentTierLock = {
      type: 'permanent',
      reason: 'signed_payload',
      evidence: `Fields with nonce/token patterns: ${nonceFields.map((v) => v.fieldPath).join(', ')}`,
    };
    return {
      promote: false,
      lock,
      reason: 'Nonce/token fields detected — likely signed payload',
    };
  }

  // Check semantic match
  if (!semanticResult.match) {
    return {
      promote: false,
      reason: 'Semantic check did not match',
    };
  }

  // Check dynamic required fields
  if (semanticResult.hasDynamicRequiredFields) {
    const lock: PermanentTierLock = {
      type: 'permanent',
      reason: 'js_computed_field',
      evidence: 'Dynamic required fields detected in semantic analysis',
    };
    return {
      promote: false,
      lock,
      reason: 'Dynamic required fields detected',
    };
  }

  // All checks passed — promote
  log.info(
    { skillId: skill.id, consecutiveValidations: skill.consecutiveValidations },
    'Skill eligible for tier promotion',
  );

  return { promote: true };
}

// ─── Failure Handling ───────────────────────────────────────────

/**
 * Handle a validation failure and determine the new tier state.
 *
 * Transient failures: temporary demotion (can re-promote after configurable threshold (promotionConsecutivePasses) more passes)
 * Structural failures: permanent lock (js_computed_field, protocol_sensitivity, signed_payload)
 */
export function handleFailure(
  skill: SkillSpec,
  failureCause: FailureCauseName,
): FailureHandleResult {
  // Permanent lock causes
  const permanentCauses: FailureCauseName[] = [
    FailureCause.JS_COMPUTED_FIELD,
    FailureCause.PROTOCOL_SENSITIVITY,
    FailureCause.SIGNED_PAYLOAD,
  ];

  if (permanentCauses.includes(failureCause)) {
    const lock: PermanentTierLock = {
      type: 'permanent',
      reason: failureCause as PermanentTierLock['reason'],
      evidence: `Failure cause: ${failureCause}`,
    };

    log.warn(
      { skillId: skill.id, failureCause },
      'Skill permanently locked at Tier 3',
    );

    return {
      newTier: TierState.TIER_3_DEFAULT as TierStateName,
      tierLock: lock,
      reason: `Permanent lock: ${failureCause}`,
    };
  }

  // Transient failure — temporary demotion
  const existingDemotion = skill.tierLock?.type === 'temporary_demotion'
    ? skill.tierLock as TemporaryDemotion
    : null;

  const demotion: TemporaryDemotion = {
    type: 'temporary_demotion',
    since: new Date().toISOString(),
    demotions: (existingDemotion?.demotions ?? 0) + 1,
  };

  log.info(
    { skillId: skill.id, failureCause, demotions: demotion.demotions },
    'Skill temporarily demoted to Tier 3',
  );

  return {
    newTier: TierState.TIER_3_DEFAULT as TierStateName,
    tierLock: demotion,
    reason: `Temporary demotion (${failureCause}), attempt ${demotion.demotions}`,
  };
}

// ─── Effective Tier ─────────────────────────────────────────────

/**
 * Get the effective tier for a skill, considering tier locks.
 */
export function getEffectiveTier(skill: SkillSpec): TierStateName {
  // Permanent lock or temporary demotion forces Tier 3
  if (skill.tierLock?.type === 'permanent' || skill.tierLock?.type === 'temporary_demotion') {
    return TierState.TIER_3_DEFAULT as TierStateName;
  }

  return skill.currentTier;
}
