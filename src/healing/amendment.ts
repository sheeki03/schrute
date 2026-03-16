import { randomUUID } from 'node:crypto';
import { getLogger } from '../core/logger.js';
import type { SkillSpec } from '../skill/types.js';
import type { AmendmentRepository } from '../storage/amendment-repository.js';
import type { SkillRepository } from '../storage/skill-repository.js';
import type { MetricsRepository } from '../storage/metrics-repository.js';

const log = getLogger();

// Amendment strategies
export const AMENDMENT_STRATEGIES = [
  'reinfer_schema',
  'refresh_auth',
  'add_param',
  'relax_validation',
  'escalate_tier',
] as const;

type AmendmentStrategy = typeof AMENDMENT_STRATEGIES[number];

// Failure cause to candidate strategies mapping
const CAUSE_STRATEGIES: Record<string, AmendmentStrategy[]> = {
  schema_drift: ['reinfer_schema', 'relax_validation'],
  auth_expired: ['refresh_auth'],
  cookie_refresh: ['refresh_auth'],
  unknown: ['reinfer_schema', 'add_param', 'relax_validation', 'escalate_tier'],
  js_computed_field: ['escalate_tier'],
  protocol_sensitivity: ['escalate_tier'],
  endpoint_removed: ['reinfer_schema', 'add_param'],
};

interface AmendmentResult {
  applied: boolean;
  amendmentId?: string;
  strategy?: AmendmentStrategy;
  reason: string;
}

export class AmendmentEngine {
  constructor(
    private amendmentRepo: AmendmentRepository,
    private skillRepo: SkillRepository,
    private metricsRepo: MetricsRepository,
    private evaluationWindow: number = 10,
    private cooldownExecutions: number = 50,
    private improvementThreshold: number = 0.15,
  ) {}

  /**
   * Diagnose the dominant failure cause from recent metrics and propose an amendment.
   */
  proposeAmendment(skill: SkillSpec): AmendmentResult {
    // Check if there's already an active amendment
    if (this.amendmentRepo.hasActiveAmendment(skill.id)) {
      return { applied: false, reason: 'Active amendment in progress — evaluation pending' };
    }

    // Check cooldown
    if (this.amendmentRepo.isInCooldown(skill.id, this.cooldownExecutions)) {
      return { applied: false, reason: 'Skill is in amendment cooldown period' };
    }

    // Diagnose dominant failure cause
    const failureCause = this.diagnoseFailureCause(skill);
    if (!failureCause) {
      return { applied: false, reason: 'No clear failure pattern detected' };
    }

    // Select strategy based on historical success rates
    const candidates = CAUSE_STRATEGIES[failureCause] ?? CAUSE_STRATEGIES['unknown'];
    const rankedStrategies = this.amendmentRepo.rankStrategies(failureCause, candidates);

    // Pick the best strategy (highest win rate, or first candidate if no history)
    const strategy = rankedStrategies.length > 0 ? rankedStrategies[0].strategy as AmendmentStrategy : candidates[0];

    // Snapshot current skill fields for rollback
    const snapshotFields = this.snapshotSkill(skill);
    const currentSuccessRate = skill.successRate;

    // Apply the amendment
    const amendmentId = randomUUID();
    this.applyStrategy(skill, strategy);

    // Record the amendment
    this.amendmentRepo.create({
      id: amendmentId,
      skillId: skill.id,
      failureCause,
      strategy,
      snapshotFields: JSON.stringify(snapshotFields),
      successRateBefore: currentSuccessRate,
      evaluationWindow: this.evaluationWindow,
      createdAt: Date.now(),
      status: 'active',
    });

    log.info({ skillId: skill.id, strategy, amendmentId, failureCause }, 'Amendment applied');

    return {
      applied: true,
      amendmentId,
      strategy,
      reason: `Applied '${strategy}' for failure cause '${failureCause}'`,
    };
  }

  /**
   * Evaluate an active amendment after enough executions.
   * Returns true if the amendment was resolved (kept or reverted).
   */
  evaluate(skillId: string): { resolved: boolean; kept?: boolean } {
    const amendment = this.amendmentRepo.getActiveAmendment(skillId);
    if (!amendment) return { resolved: false };

    if (amendment.executionsSince < amendment.evaluationWindow) {
      return { resolved: false };
    }

    // Calculate success rate after amendment
    const recentMetrics = this.metricsRepo.getRecentBySkillId(skillId, amendment.evaluationWindow);
    const successCount = recentMetrics.filter(m => m.success).length;
    const successRateAfter = recentMetrics.length > 0 ? successCount / recentMetrics.length : 0;

    const improvement = successRateAfter - amendment.successRateBefore;
    const kept = improvement >= this.improvementThreshold;

    if (kept) {
      this.amendmentRepo.resolve(amendment.id, 'kept', successRateAfter);
      log.info({ skillId, amendmentId: amendment.id, improvement }, 'Amendment kept');
    } else {
      // Revert the skill to its snapshot
      const snapshot = JSON.parse(amendment.snapshotFields);
      this.revertSkill(skillId, snapshot);
      this.amendmentRepo.resolve(amendment.id, 'reverted', successRateAfter);
      log.info({ skillId, amendmentId: amendment.id, improvement }, 'Amendment reverted');
    }

    return { resolved: true, kept };
  }

  /**
   * Increment execution count for active amendment tracking.
   */
  incrementExecutionCount(skillId: string): void {
    this.amendmentRepo.incrementExecutionCount(skillId);
  }

  private diagnoseFailureCause(skill: SkillSpec): string | null {
    const metrics = this.metricsRepo.getRecentBySkillId(skill.id, 20);
    const failures = metrics.filter(m => !m.success && m.errorType);
    if (failures.length === 0) return null;

    // Count failure causes
    const causeCounts = new Map<string, number>();
    for (const m of failures) {
      const cause = m.errorType!;
      causeCounts.set(cause, (causeCounts.get(cause) ?? 0) + 1);
    }

    // Return the most frequent cause
    let maxCount = 0;
    let dominantCause: string | null = null;
    for (const [cause, count] of causeCounts) {
      if (count > maxCount) {
        maxCount = count;
        dominantCause = cause;
      }
    }

    return dominantCause;
  }

  private snapshotSkill(skill: SkillSpec): Record<string, unknown> {
    return {
      currentTier: skill.currentTier,
      tierLock: skill.tierLock,
      validation: skill.validation,
      replayStrategy: skill.replayStrategy,
      outputSchema: skill.outputSchema,
      parameters: skill.parameters,
      pathTemplate: skill.pathTemplate,
    };
  }

  private applyStrategy(skill: SkillSpec, strategy: AmendmentStrategy): void {
    const updates: Record<string, unknown> = { updatedAt: Date.now() };

    switch (strategy) {
      case 'reinfer_schema':
        // Clear the output schema so the next execution re-infers it
        updates.outputSchema = null;
        break;
      case 'refresh_auth':
        // Force back to browser-proxied tier for fresh auth
        updates.currentTier = 'tier_3';
        updates.replayStrategy = 'prefer_tier_3';
        break;
      case 'add_param':
        // No immediate change — the system will pick up new params on next recording
        break;
      case 'relax_validation':
        updates.validation = JSON.stringify({
          semanticChecks: [],
          customInvariants: [],
        });
        break;
      case 'escalate_tier':
        updates.currentTier = 'tier_3';
        updates.replayStrategy = 'tier_3_only';
        updates.tierLock = JSON.stringify({ type: 'temporary_demotion', since: new Date().toISOString(), demotions: 1 });
        break;
    }

    this.skillRepo.update(skill.id, updates);
  }

  private revertSkill(skillId: string, snapshot: Record<string, unknown>): void {
    const updates: Record<string, unknown> = { updatedAt: Date.now() };
    if (snapshot.currentTier !== undefined) updates.currentTier = snapshot.currentTier;
    if (snapshot.tierLock !== undefined) updates.tierLock = snapshot.tierLock !== null ? JSON.stringify(snapshot.tierLock) : null;
    if (snapshot.validation !== undefined) updates.validation = JSON.stringify(snapshot.validation);
    if (snapshot.replayStrategy !== undefined) updates.replayStrategy = snapshot.replayStrategy;
    if (snapshot.outputSchema !== undefined) updates.outputSchema = snapshot.outputSchema !== null ? JSON.stringify(snapshot.outputSchema) : null;
    if (snapshot.parameters !== undefined) updates.parameters = JSON.stringify(snapshot.parameters);
    if (snapshot.pathTemplate !== undefined) updates.pathTemplate = snapshot.pathTemplate;

    this.skillRepo.update(skillId, updates);
  }
}
