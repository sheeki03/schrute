import { randomUUID } from 'node:crypto';
import { getLogger } from '../core/logger.js';
import type { SkillSpec } from '../skill/types.js';
import type { AmendmentEngine } from './amendment.js';
import type { ExemplarRepository, SkillExemplar } from '../storage/exemplar-repository.js';
import type { SkillRepository } from '../storage/skill-repository.js';
import type { AmendmentRepository } from '../storage/amendment-repository.js';

const log = getLogger();

// ─── Types ──────────────────────────────────────────────────────

interface SkillVariant {
  id: string;
  skillId: string;
  mutations: VariantMutation[];
  score?: number;
}

interface VariantMutation {
  field: string;
  from: unknown;
  to: unknown;
  reason: string;
}

interface GepaResult {
  optimized: boolean;
  variantsGenerated: number;
  bestVariant?: SkillVariant;
  appliedVia?: string; // amendment ID if applied through amendment engine
  reason: string;
}

interface GepaConfig {
  maxVariants: number;       // default: 5
  correctnessWeight: number; // default: 0.5
  responseMatchWeight: number; // default: 0.3
  complexityPenalty: number;  // default: 0.2
}

const DEFAULT_GEPA_CONFIG: GepaConfig = {
  maxVariants: 5,
  correctnessWeight: 0.5,
  responseMatchWeight: 0.3,
  complexityPenalty: 0.2,
};

// ─── GEPA Engine ────────────────────────────────────────────────

export class GepaEngine {
  private config: GepaConfig;

  constructor(
    private skillRepo: SkillRepository,
    private amendmentRepo: AmendmentRepository,
    private exemplarRepo: ExemplarRepository,
    private amendmentEngine: AmendmentEngine,
    config?: Partial<GepaConfig>,
  ) {
    this.config = { ...DEFAULT_GEPA_CONFIG, ...config };
  }

  /**
   * Check if a skill is eligible for GEPA optimization.
   * A skill qualifies if it's BROKEN or has had 2+ reverted amendments.
   */
  isEligible(skillId: string): boolean {
    const skill = this.skillRepo.getById(skillId);
    if (!skill) return false;

    // BROKEN skills are eligible
    if (skill.status === 'broken') return true;

    // Skills with 2+ reverted amendments are eligible
    const amendments = this.amendmentRepo.getBySkillId(skillId);
    const revertedCount = amendments.filter(a => a.status === 'reverted').length;
    return revertedCount >= 2;
  }

  /**
   * Run GEPA optimization on a skill.
   * Generates variants, evaluates them against exemplar data,
   * and applies the best one through the amendment engine.
   */
  async optimize(skillId: string): Promise<GepaResult> {
    const skill = this.skillRepo.getById(skillId);
    if (!skill) {
      return { optimized: false, variantsGenerated: 0, reason: 'Skill not found' };
    }

    if (!this.isEligible(skillId)) {
      return { optimized: false, variantsGenerated: 0, reason: 'Skill not eligible for GEPA' };
    }

    // Get exemplar for comparison
    const exemplar = this.exemplarRepo.get(skillId);
    if (!exemplar) {
      return {
        optimized: false,
        variantsGenerated: 0,
        reason: 'No exemplar available — skill needs at least one successful execution for GEPA comparison',
      };
    }

    // Analyze failure history to guide mutations
    const amendments = this.amendmentRepo.getBySkillId(skillId);
    const failureCauses = [...new Set(amendments.map(a => a.failureCause))];

    // Generate variants
    const variants = this.generateVariants(skill, failureCauses);
    if (variants.length === 0) {
      return { optimized: false, variantsGenerated: 0, reason: 'No viable variants generated' };
    }

    // Score each variant
    for (const variant of variants) {
      variant.score = this.scoreVariant(variant, skill, exemplar);
    }

    // Sort by score descending
    variants.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    const bestVariant = variants[0];
    if ((bestVariant.score ?? 0) <= 0) {
      return {
        optimized: false,
        variantsGenerated: variants.length,
        bestVariant,
        reason: 'No variant scored above threshold',
      };
    }

    // Apply best variant through amendment engine (gets snapshot/rollback for free)
    const amendResult = this.amendmentEngine.proposeAmendment(skill);
    if (!amendResult.applied) {
      return {
        optimized: false,
        variantsGenerated: variants.length,
        bestVariant,
        reason: `Amendment blocked: ${amendResult.reason}`,
      };
    }

    // Apply the variant's mutations to the skill
    this.applyVariantMutations(skill, bestVariant);

    log.info({
      skillId,
      variantsGenerated: variants.length,
      bestScore: bestVariant.score,
      mutations: bestVariant.mutations.length,
    }, 'GEPA optimization applied');

    return {
      optimized: true,
      variantsGenerated: variants.length,
      bestVariant,
      appliedVia: amendResult.amendmentId,
      reason: `Applied variant with score ${bestVariant.score?.toFixed(3)}`,
    };
  }

  /**
   * Generate N variants by mutating skill fields guided by failure causes.
   */
  private generateVariants(
    skill: SkillSpec,
    failureCauses: string[],
  ): SkillVariant[] {
    const variants: SkillVariant[] = [];

    for (let i = 0; i < this.config.maxVariants; i++) {
      const mutations: VariantMutation[] = [];

      // Guided mutations based on failure causes
      for (const cause of failureCauses) {
        switch (cause) {
          case 'schema_drift':
            // Try clearing output schema
            mutations.push({
              field: 'outputSchema',
              from: skill.outputSchema,
              to: undefined,
              reason: 'Clear stale output schema after schema_drift',
            });
            break;

          case 'auth_expired':
          case 'cookie_refresh':
            // Force browser-proxied tier
            mutations.push({
              field: 'replayStrategy',
              from: skill.replayStrategy,
              to: 'prefer_tier_3',
              reason: 'Force browser tier for auth refresh',
            });
            break;

          case 'endpoint_removed':
            // Try path variations
            if (skill.pathTemplate.includes('/v1/')) {
              mutations.push({
                field: 'pathTemplate',
                from: skill.pathTemplate,
                to: skill.pathTemplate.replace('/v1/', '/v2/'),
                reason: 'Try API version bump',
              });
            }
            break;

          case 'js_computed_field':
          case 'protocol_sensitivity':
            // Lock to browser tier
            mutations.push({
              field: 'replayStrategy',
              from: skill.replayStrategy,
              to: 'tier_3_only',
              reason: `Lock to browser tier for ${cause}`,
            });
            break;
        }
      }

      // Always try relaxing validation as one variant
      if (i === this.config.maxVariants - 1) {
        mutations.push({
          field: 'validation',
          from: skill.validation,
          to: { semanticChecks: [], customInvariants: [] },
          reason: 'Relax validation as fallback variant',
        });
      }

      if (mutations.length > 0) {
        variants.push({
          id: randomUUID(),
          skillId: skill.id,
          mutations,
        });
      }
    }

    return variants;
  }

  /**
   * Score a variant based on:
   * - correctness (0.5): do the mutations address known failure causes?
   * - response_match (0.3): does the variant structure align with the exemplar?
   * - complexity_penalty (0.2): fewer mutations preferred
   */
  private scoreVariant(
    variant: SkillVariant,
    skill: SkillSpec,
    exemplar: SkillExemplar,
  ): number {
    const { correctnessWeight, responseMatchWeight, complexityPenalty } = this.config;

    // Correctness: each mutation that addresses a known issue gets credit
    const correctness = Math.min(variant.mutations.length / 3, 1.0);

    // Response match: compare variant structure against exemplar body
    const responseMatch = this.matchExemplarAgainstSchema(variant, skill, exemplar);

    // Complexity: fewer mutations = less risk
    const complexity = Math.min(variant.mutations.length / this.config.maxVariants, 1.0);

    const score =
      correctness * correctnessWeight +
      responseMatch * responseMatchWeight -
      complexity * complexityPenalty;

    return Math.max(0, score);
  }

  /**
   * Score how well a variant aligns with the exemplar response.
   * Uses exemplar.redactedResponseBody to compare structural similarity.
   */
  private matchExemplarAgainstSchema(
    variant: SkillVariant,
    skill: SkillSpec,
    exemplar: SkillExemplar,
  ): number {
    // If variant changes outputSchema, check if new schema would match exemplar body
    const schemaChange = variant.mutations.find(m => m.field === 'outputSchema');

    if (!exemplar.redactedResponseBody) return 0.5; // No body to compare

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(exemplar.redactedResponseBody);
    } catch {
      return 0.5; // Can't parse body, neutral score
    }

    if (schemaChange) {
      if (schemaChange.to === undefined) {
        // Clearing schema — body exists, so likely compatible
        return 0.7;
      }
      // New schema provided — check if body keys match schema properties
      const newSchema = schemaChange.to as Record<string, unknown>;
      const schemaProps = (newSchema?.properties as Record<string, unknown>) ?? {};
      if (typeof parsedBody === 'object' && parsedBody !== null) {
        const bodyKeys = Object.keys(parsedBody);
        const schemaKeys = Object.keys(schemaProps);
        if (schemaKeys.length === 0) return 0.6;
        const overlap = bodyKeys.filter(k => schemaKeys.includes(k)).length;
        return Math.min(overlap / schemaKeys.length, 1.0);
      }
      return 0.4;
    }

    // No schema change — if body matches existing outputSchema, score high
    if (skill.outputSchema?.properties && typeof parsedBody === 'object' && parsedBody !== null) {
      const bodyKeys = Object.keys(parsedBody);
      const schemaKeys = Object.keys(skill.outputSchema.properties as Record<string, unknown>);
      if (schemaKeys.length === 0) return 0.8;
      const overlap = bodyKeys.filter(k => schemaKeys.includes(k)).length;
      return 0.5 + 0.5 * Math.min(overlap / schemaKeys.length, 1.0);
    }

    return 0.8; // No schema to compare against, default positive
  }

  /**
   * Apply a variant's mutations to the skill via skillRepo.update().
   */
  private applyVariantMutations(skill: SkillSpec, variant: SkillVariant): void {
    const updates: Partial<Omit<SkillSpec, 'id'>> = {};

    for (const mutation of variant.mutations) {
      switch (mutation.field) {
        case 'pathTemplate':
          updates.pathTemplate = mutation.to as string;
          break;
        case 'outputSchema':
          updates.outputSchema = mutation.to as Record<string, unknown> | undefined;
          break;
        case 'replayStrategy':
          updates.replayStrategy = mutation.to as SkillSpec['replayStrategy'];
          break;
        case 'validation':
          updates.validation = mutation.to as SkillSpec['validation'];
          break;
        case 'currentTier':
          updates.currentTier = mutation.to as SkillSpec['currentTier'];
          break;
      }
    }

    this.skillRepo.update(skill.id, updates);
  }
}
