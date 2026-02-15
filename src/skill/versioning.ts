import type { SkillSpec } from './types.js';

// ─── Confidence Decay ───────────────────────────────────────────

export const DECAY_CONSTANT_DAYS = 30;
export const STALE_THRESHOLD = 0.3;
export const BROKEN_THRESHOLD = 0.1;

/**
 * Exponential decay: exp(-days_since_last_verified / 30)
 */
export function calculateConfidence(skill: SkillSpec): number {
  if (!skill.lastVerified) {
    return 0;
  }

  const now = Date.now();
  const daysSinceVerified = (now - skill.lastVerified) / (1000 * 60 * 60 * 24);

  if (daysSinceVerified <= 0) {
    return 1;
  }

  return Math.exp(-daysSinceVerified / DECAY_CONSTANT_DAYS);
}

/**
 * Skill is stale when confidence drops below 0.3
 */
export function isStale(skill: SkillSpec): boolean {
  return calculateConfidence(skill) < STALE_THRESHOLD;
}

/**
 * Skill is broken when confidence drops below 0.1
 */
export function isBroken(skill: SkillSpec): boolean {
  return calculateConfidence(skill) < BROKEN_THRESHOLD;
}

/**
 * Create a new SkillSpec with incremented version.
 * Resets the version-specific counters.
 */
export function incrementVersion(skill: SkillSpec): SkillSpec {
  const newVersion = skill.version + 1;
  const baseId = skill.id.replace(/\.v\d+$/, '');
  const newId = `${baseId}.v${newVersion}`;

  return {
    ...skill,
    id: newId,
    version: newVersion,
    consecutiveValidations: 0,
    sampleCount: 0,
    confidence: 0,
    lastVerified: undefined,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Batch-update confidence for all skills based on time since last verification.
 * Returns skills with updated confidence values.
 */
export function updateConfidenceDecay(skills: SkillSpec[]): SkillSpec[] {
  return skills.map((skill) => ({
    ...skill,
    confidence: calculateConfidence(skill),
  }));
}
