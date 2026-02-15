import type { SkillSpec, SkillStatusName } from '../skill/types.js';
import { SkillStatus } from '../skill/types.js';
import { incrementVersion, calculateConfidence } from '../skill/versioning.js';
import type { SkillRepository } from '../storage/skill-repository.js';
import type { MetricsRepository } from '../storage/metrics-repository.js';
import type { OneAgentConfig } from '../skill/types.js';
import { getLogger } from '../core/logger.js';

const log = getLogger();

// ─── Types ──────────────────────────────────────────────────────

export type RelearnAction = 'revalidated' | 'escalated' | 'needs_reexplore';

export interface RelearnResult {
  /** What action was taken */
  action: RelearnAction;
  /** New skill version (if escalated) */
  newVersion?: SkillSpec;
  /** Status the old skill was set to */
  oldStatus?: SkillStatusName;
}

// ─── Constants ──────────────────────────────────────────────────

const REVALIDATION_CONFIDENCE_THRESHOLD = 0.5;
const MAX_ESCALATION_ATTEMPTS = 3;

// ─── Relearner ──────────────────────────────────────────────────

/**
 * Re-learn a skill that has been detected as broken or degrading.
 *
 * Workflow:
 * 1. **Revalidate** — if confidence is still above threshold, mark as revalidated
 * 2. **Escalate tier** — create a new version with reset counters
 * 3. **Needs re-explore** — if escalation limit reached, signal full re-capture
 *
 * @param skill - The broken/degrading skill
 * @param skillRepo - Repository for skill CRUD
 * @param metricsRepo - Repository for metrics
 * @param config - Agent configuration
 * @returns The result of the relearn attempt
 */
export async function relearnSkill(
  skill: SkillSpec,
  skillRepo: SkillRepository,
  metricsRepo: MetricsRepository,
  _config: OneAgentConfig,
): Promise<RelearnResult> {
  log.info({ skillId: skill.id, status: skill.status }, 'Attempting to relearn skill');

  // Step 1: Revalidation check
  const confidence = calculateConfidence(skill);
  if (confidence >= REVALIDATION_CONFIDENCE_THRESHOLD && skill.successRate >= 0.5) {
    log.info({ skillId: skill.id, confidence }, 'Skill still has acceptable confidence, revalidating');
    skillRepo.update(skill.id, {
      status: SkillStatus.ACTIVE,
      lastVerified: Date.now(),
    });
    return { action: 'revalidated' };
  }

  // Step 2: Check escalation count via version number
  const escalationCount = skill.version - 1; // v1 = 0 escalations, v2 = 1, etc.
  if (escalationCount >= MAX_ESCALATION_ATTEMPTS) {
    log.warn(
      { skillId: skill.id, escalationCount },
      'Max escalation attempts reached, needs full re-explore',
    );
    skillRepo.update(skill.id, { status: SkillStatus.BROKEN });
    return {
      action: 'needs_reexplore',
      oldStatus: SkillStatus.BROKEN,
    };
  }

  // Step 3: Escalate — create new version
  const newSkill = incrementVersion(skill);
  newSkill.status = SkillStatus.DRAFT;

  try {
    skillRepo.create(newSkill);
  } catch (err) {
    log.error({ skillId: skill.id, err }, 'Failed to create new skill version');
    return {
      action: 'needs_reexplore',
      oldStatus: skill.status,
    };
  }

  // Mark old version as stale
  const oldStatus = SkillStatus.STALE;
  skillRepo.update(skill.id, { status: oldStatus });

  log.info(
    { oldId: skill.id, newId: newSkill.id, newVersion: newSkill.version },
    'Escalated skill to new version',
  );

  return {
    action: 'escalated',
    newVersion: newSkill,
    oldStatus,
  };
}
