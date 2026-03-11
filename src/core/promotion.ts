import { getLogger } from './logger.js';
import { getConfig } from './config.js';
import type { SkillSpec, SkillStatusName, OneAgentConfig } from '../skill/types.js';
import { SkillStatus, SideEffectClass, ConfirmationStatus } from '../skill/types.js';

const log = getLogger();

// ─── Types ──────────────────────────────────────────────────────

export interface PromotionCheck {
  eligible: boolean;
  reason?: string;
}

export interface PromotionResult {
  skillId: string;
  previousStatus: SkillStatusName;
  newStatus: SkillStatusName;
  timestamp: number;
}

export interface DemotionResult {
  skillId: string;
  previousStatus: SkillStatusName;
  newStatus: SkillStatusName;
  reason: string;
  timestamp: number;
}

// ─── Promotion Gate ─────────────────────────────────────────────

/**
 * Check if a skill is eligible for promotion from draft to active.
 *
 * Requirements:
 * - status === 'draft'
 * - sample_count >= 2
 * - consecutive_validations >= N (from config)
 * - side_effect_class === 'read-only'
 */
export function canPromote(
  skill: SkillSpec,
  config?: OneAgentConfig,
): PromotionCheck {
  const cfg = config ?? getConfig();
  const requiredPasses = cfg.promotionConsecutivePasses;

  if (skill.status !== SkillStatus.DRAFT) {
    return {
      eligible: false,
      reason: `Skill status is '${skill.status}', must be 'draft' to promote`,
    };
  }

  if (skill.sampleCount < 2) {
    return {
      eligible: false,
      reason: `Sample count is ${skill.sampleCount}, minimum 2 required`,
    };
  }

  if (skill.consecutiveValidations < requiredPasses) {
    return {
      eligible: false,
      reason: `${skill.consecutiveValidations} consecutive validations, need ${requiredPasses}`,
    };
  }

  if (skill.sideEffectClass !== SideEffectClass.READ_ONLY) {
    return {
      eligible: false,
      reason: `Side effect class is '${skill.sideEffectClass}', only 'read-only' skills can be auto-promoted`,
    };
  }

  return { eligible: true };
}

/**
 * Promote a skill from draft to active.
 * Returns a new SkillSpec with updated status and confirmation.
 */
export function promoteSkill(skill: SkillSpec, config?: OneAgentConfig): PromotionResult & { skill: SkillSpec } {
  const check = canPromote(skill, config);
  if (!check.eligible) {
    throw new Error(`Cannot promote skill '${skill.id}': ${check.reason}`);
  }

  const now = Date.now();

  const promoted: SkillSpec = {
    ...skill,
    status: SkillStatus.ACTIVE as SkillStatusName,
    updatedAt: now,
    lastVerified: now,
    confidence: 1.0,
  };

  log.info(
    { skillId: skill.id, previousStatus: skill.status, newStatus: promoted.status },
    'Skill promoted to active',
  );

  return {
    skillId: skill.id,
    previousStatus: skill.status,
    newStatus: promoted.status,
    timestamp: now,
    skill: promoted,
  };
}

/**
 * Manually force-promote a DRAFT or BROKEN skill to ACTIVE.
 * Bypasses auto-promotion gates (sample count, validations, side-effect class).
 * The first execution will still require confirmation.
 */
const FORCE_PROMOTABLE: ReadonlySet<SkillStatusName> = new Set([SkillStatus.DRAFT, SkillStatus.BROKEN]);

export function forcePromote(skill: SkillSpec): PromotionResult {
  if (!FORCE_PROMOTABLE.has(skill.status)) {
    throw new Error(`Cannot activate skill '${skill.id}': status is '${skill.status}', must be 'draft' or 'broken'`);
  }
  const now = Date.now();
  log.info({ skillId: skill.id }, 'Skill manually activated');
  return {
    skillId: skill.id,
    previousStatus: skill.status,
    newStatus: SkillStatus.ACTIVE as SkillStatusName,
    timestamp: now,
  };
}

/**
 * Demote a skill to stale or broken.
 * Returns a new SkillSpec with updated status.
 */
export function demoteSkill(
  skill: SkillSpec,
  reason: string,
  targetStatus?: 'stale' | 'broken',
): DemotionResult & { skill: SkillSpec } {
  const newStatus = (targetStatus ?? SkillStatus.STALE) as SkillStatusName;
  const now = Date.now();

  const demoted: SkillSpec = {
    ...skill,
    status: newStatus,
    updatedAt: now,
    consecutiveValidations: 0,
  };

  log.info(
    { skillId: skill.id, previousStatus: skill.status, newStatus, reason },
    'Skill demoted',
  );

  return {
    skillId: skill.id,
    previousStatus: skill.status,
    newStatus,
    reason,
    timestamp: now,
    skill: demoted,
  };
}
