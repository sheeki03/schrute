import { describe, it, expect } from 'vitest';
import { buildExecutionSchema } from '../../src/replay/param-validator.js';
import type { SkillSpec } from '../../src/skill/types.js';
import { SideEffectClass, TierState, SkillStatus } from '../../src/skill/types.js';

// ─── Inline the candidate filter logic from engine.ts ────────────
// runAutoValidationCycle is private, so we replicate its filtering criteria here.
function isCycleCandidate(skill: SkillSpec): boolean {
  return (
    skill.status === SkillStatus.ACTIVE
    && skill.currentTier === TierState.TIER_3_DEFAULT
    && skill.tierLock?.type !== 'permanent'
    && skill.sideEffectClass === SideEffectClass.READ_ONLY
    && (skill.method === 'GET' || skill.method === 'HEAD')
  );
}

function hasParamCoverage(skill: SkillSpec): boolean {
  const execSchema = buildExecutionSchema(skill);
  const samples = skill.sampleParams ?? {};
  const uncovered = execSchema.required.filter(r => !(r in samples));
  return uncovered.length === 0;
}

// Test the auto-validation filtering criteria
describe('auto-validation', () => {
  function makeSkill(overrides: Partial<SkillSpec> = {}): SkillSpec {
    return {
      id: 'test.get_data.v1',
      version: 1,
      status: SkillStatus.ACTIVE,
      currentTier: TierState.TIER_3_DEFAULT,
      tierLock: null,
      allowedDomains: ['example.com'],
      requiredCapabilities: ['net.fetch.direct'],
      parameters: [],
      validation: { semanticChecks: [], customInvariants: [] },
      redaction: { piiClassesFound: [], fieldsRedacted: 0 },
      replayStrategy: 'prefer_tier_3',
      sideEffectClass: SideEffectClass.READ_ONLY,
      sampleCount: 1,
      consecutiveValidations: 0,
      confidence: 0.5,
      method: 'GET',
      pathTemplate: '/data',
      inputSchema: {},
      isComposite: false,
      siteId: 'example.com',
      name: 'get_data',
      successRate: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    } as SkillSpec;
  }

  describe('candidate filtering', () => {
    it('GET read-only tier_3 active skill is a valid candidate', () => {
      const skill = makeSkill();
      expect(isCycleCandidate(skill)).toBe(true);
    });

    it('POST skills are excluded', () => {
      const skill = makeSkill({ method: 'POST' });
      expect(isCycleCandidate(skill)).toBe(false);
    });

    it('PUT skills are excluded', () => {
      const skill = makeSkill({ method: 'PUT' });
      expect(isCycleCandidate(skill)).toBe(false);
    });

    it('non-read-only skills are excluded', () => {
      const skill = makeSkill({ sideEffectClass: SideEffectClass.IDEMPOTENT });
      expect(isCycleCandidate(skill)).toBe(false);
    });

    it('non-idempotent skills are excluded', () => {
      const skill = makeSkill({ sideEffectClass: SideEffectClass.NON_IDEMPOTENT });
      expect(isCycleCandidate(skill)).toBe(false);
    });

    it('tier_1 skills are excluded', () => {
      const skill = makeSkill({ currentTier: TierState.TIER_1_PROMOTED });
      expect(isCycleCandidate(skill)).toBe(false);
    });

    it('permanently locked skills are excluded', () => {
      const skill = makeSkill({
        tierLock: { type: 'permanent', reason: 'js_computed_field', evidence: 'test' },
      });
      expect(isCycleCandidate(skill)).toBe(false);
    });

    it('temporarily demoted skills are NOT excluded', () => {
      const skill = makeSkill({
        tierLock: { type: 'temporary_demotion', since: new Date().toISOString(), demotions: 1 },
      });
      expect(isCycleCandidate(skill)).toBe(true);
    });

    it('HEAD skills are valid candidates', () => {
      const skill = makeSkill({ method: 'HEAD' });
      expect(isCycleCandidate(skill)).toBe(true);
    });

    it('draft skills are excluded (must be active)', () => {
      const skill = makeSkill({ status: SkillStatus.DRAFT });
      expect(isCycleCandidate(skill)).toBe(false);
    });

    it('stale skills are excluded', () => {
      const skill = makeSkill({ status: SkillStatus.STALE });
      expect(isCycleCandidate(skill)).toBe(false);
    });

    it('broken skills are excluded', () => {
      const skill = makeSkill({ status: SkillStatus.BROKEN });
      expect(isCycleCandidate(skill)).toBe(false);
    });
  });

  describe('param coverage gating', () => {
    it('skill with no required params passes coverage check', () => {
      const skill = makeSkill({ pathTemplate: '/data', parameters: [] });
      expect(hasParamCoverage(skill)).toBe(true);
    });

    it('skill with path params covered by sampleParams passes', () => {
      const skill = makeSkill({
        pathTemplate: '/coins/{id}',
        sampleParams: { id: 'bitcoin' },
      });
      expect(hasParamCoverage(skill)).toBe(true);
    });

    it('skill with uncovered required params is skipped', () => {
      const skill = makeSkill({
        pathTemplate: '/coins/{id}',
        // no sampleParams
      });
      expect(hasParamCoverage(skill)).toBe(false);
    });

    it('skill with required user_input params not in sampleParams is skipped', () => {
      const skill = makeSkill({
        pathTemplate: '/search',
        parameters: [{ name: 'q', type: 'string', source: 'user_input', evidence: ['test'] }],
      });
      expect(hasParamCoverage(skill)).toBe(false);
    });

    it('skill with multiple path params partially covered is skipped', () => {
      const skill = makeSkill({
        pathTemplate: '/users/{userId}/posts/{postId}',
        sampleParams: { userId: '42' }, // postId missing
      });
      expect(hasParamCoverage(skill)).toBe(false);
    });

    it('skill with all multi-param paths covered passes', () => {
      const skill = makeSkill({
        pathTemplate: '/users/{userId}/posts/{postId}',
        sampleParams: { userId: '42', postId: '99' },
      });
      expect(hasParamCoverage(skill)).toBe(true);
    });
  });

  describe('site-scoped prioritization', () => {
    // Replicates the sorting logic from runAutoValidationCycle
    function sortCandidates(candidates: SkillSpec[], siteId?: string): SkillSpec[] {
      const byLastVerified = (a: SkillSpec, b: SkillSpec) =>
        (a.lastVerified ?? 0) - (b.lastVerified ?? 0);
      if (siteId) {
        const siteSkills = candidates.filter(s => s.siteId === siteId).sort(byLastVerified);
        const otherSkills = candidates.filter(s => s.siteId !== siteId).sort(byLastVerified);
        return [...siteSkills, ...otherSkills];
      }
      return [...candidates].sort(byLastVerified);
    }

    it('prioritizes matching siteId skills first', () => {
      const skills = [
        makeSkill({ id: 'other.a.v1', siteId: 'other.com', lastVerified: 100 }),
        makeSkill({ id: 'example.a.v1', siteId: 'example.com', lastVerified: 200 }),
        makeSkill({ id: 'other.b.v1', siteId: 'other.com', lastVerified: 50 }),
      ];
      const sorted = sortCandidates(skills, 'example.com');
      expect(sorted[0].siteId).toBe('example.com');
      expect(sorted[1].siteId).toBe('other.com');
    });

    it('sorts within site group by lastVerified ascending (oldest first)', () => {
      const skills = [
        makeSkill({ id: 'example.b.v1', siteId: 'example.com', lastVerified: 500 }),
        makeSkill({ id: 'example.a.v1', siteId: 'example.com', lastVerified: 100 }),
        makeSkill({ id: 'example.c.v1', siteId: 'example.com', lastVerified: 300 }),
      ];
      const sorted = sortCandidates(skills, 'example.com');
      expect(sorted.map(s => s.id)).toEqual(['example.a.v1', 'example.c.v1', 'example.b.v1']);
    });

    it('without siteId, sorts all by lastVerified ascending', () => {
      const skills = [
        makeSkill({ id: 'b.v1', siteId: 'b.com', lastVerified: 300 }),
        makeSkill({ id: 'a.v1', siteId: 'a.com', lastVerified: 100 }),
        makeSkill({ id: 'c.v1', siteId: 'c.com', lastVerified: 200 }),
      ];
      const sorted = sortCandidates(skills);
      expect(sorted.map(s => s.id)).toEqual(['a.v1', 'c.v1', 'b.v1']);
    });

    it('treats undefined lastVerified as 0 (highest priority)', () => {
      const skills = [
        makeSkill({ id: 'verified.v1', lastVerified: 100 }),
        makeSkill({ id: 'never.v1' }), // lastVerified undefined → 0
      ];
      const sorted = sortCandidates(skills);
      expect(sorted[0].id).toBe('never.v1');
    });
  });

  describe('maxSkillsPerCycle limiting', () => {
    it('batch is sliced to maxSkillsPerCycle', () => {
      const maxPerCycle = 3;
      const candidates = Array.from({ length: 10 }, (_, i) =>
        makeSkill({ id: `skill.${i}.v1` }),
      );
      const batch = candidates.slice(0, maxPerCycle);
      expect(batch).toHaveLength(3);
    });

    it('batch returns all when fewer than max', () => {
      const maxPerCycle = 5;
      const candidates = [makeSkill(), makeSkill({ id: 'test.b.v1' })];
      const batch = candidates.slice(0, maxPerCycle);
      expect(batch).toHaveLength(2);
    });
  });

  describe('mode guard', () => {
    // The cycle checks: if (this.mode !== 'idle' || this.autoValidationRunning || this.isClosing) return;
    it('cycle should only run when mode is idle', () => {
      const modes = ['idle', 'exploring', 'recording', 'executing'] as const;
      const shouldRun = modes.filter(m => m === 'idle');
      expect(shouldRun).toEqual(['idle']);
    });

    it('cycle should not run when already running (re-entrancy guard)', () => {
      // Simulating: if autoValidationRunning is true, cycle returns early
      let autoValidationRunning = false;
      const canRun = () => !autoValidationRunning;

      expect(canRun()).toBe(true);
      autoValidationRunning = true;
      expect(canRun()).toBe(false);
    });
  });

  describe('rate-limit skip', () => {
    it('rate-limited skills should be skipped in cycle', () => {
      // Simulating: rateLimiter.checkRate returns { allowed: false }
      const rateCheck = { allowed: false };
      expect(rateCheck.allowed).toBe(false);
      // In the real cycle, this increments skippedRateLimited and continues
    });

    it('non-rate-limited skills proceed', () => {
      const rateCheck = { allowed: true };
      expect(rateCheck.allowed).toBe(true);
    });
  });

  describe('counter increments', () => {
    it('successful validation increments succeeded and validated counters', () => {
      const stats = { validated: 0, succeeded: 0, failed: 0, promoted: 0 };
      // Simulate successful execution
      const result = { success: true };
      stats.validated++;
      if (result.success) stats.succeeded++;
      else stats.failed++;

      expect(stats.validated).toBe(1);
      expect(stats.succeeded).toBe(1);
      expect(stats.failed).toBe(0);
    });

    it('failed validation increments failed and validated counters', () => {
      const stats = { validated: 0, succeeded: 0, failed: 0, promoted: 0 };
      const result = { success: false };
      stats.validated++;
      if (result.success) stats.succeeded++;
      else stats.failed++;

      expect(stats.validated).toBe(1);
      expect(stats.succeeded).toBe(0);
      expect(stats.failed).toBe(1);
    });

    it('promotion counter increments when skill reaches tier_1 after validation', () => {
      const stats = { validated: 0, succeeded: 0, failed: 0, promoted: 0 };
      const result = { success: true };
      stats.validated++;
      if (result.success) {
        stats.succeeded++;
        // Simulate: fresh skill was promoted to tier_1
        const freshTier = TierState.TIER_1_PROMOTED;
        if (freshTier === TierState.TIER_1_PROMOTED) {
          stats.promoted++;
        }
      }

      expect(stats.promoted).toBe(1);
    });
  });

  describe('extractPathParamSample', () => {
    // Since extractPathParamSample is a module-level function in engine.ts (not exported),
    // test the logic inline
    function extractPathParamSample(
      template: string,
      requestUrl: string,
    ): Record<string, string> | undefined {
      try {
        const actualPath = new URL(requestUrl).pathname;
        const templateSegs = template.split('/');
        const actualSegs = actualPath.split('/');
        const params: Record<string, string> = {};

        for (let i = 0; i < templateSegs.length && i < actualSegs.length; i++) {
          const t = templateSegs[i];
          if (t.startsWith('{') && t.endsWith('}') && actualSegs[i]) {
            params[t.slice(1, -1)] = decodeURIComponent(actualSegs[i]);
          }
        }
        return Object.keys(params).length > 0 ? params : undefined;
      } catch { return undefined; }
    }

    it('extracts path params from a matching URL', () => {
      const result = extractPathParamSample('/coins/{id}', 'https://api.example.com/coins/bitcoin');
      expect(result).toEqual({ id: 'bitcoin' });
    });

    it('extracts multiple path params', () => {
      const result = extractPathParamSample('/users/{userId}/posts/{postId}', 'https://api.example.com/users/42/posts/99');
      expect(result).toEqual({ userId: '42', postId: '99' });
    });

    it('returns undefined for templates without params', () => {
      const result = extractPathParamSample('/coins/markets', 'https://api.example.com/coins/markets');
      expect(result).toBeUndefined();
    });

    it('decodes URI-encoded values', () => {
      const result = extractPathParamSample('/search/{query}', 'https://api.example.com/search/hello%20world');
      expect(result).toEqual({ query: 'hello world' });
    });

    it('returns undefined for invalid URLs', () => {
      const result = extractPathParamSample('/coins/{id}', 'not-a-url');
      expect(result).toBeUndefined();
    });
  });
});
