import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock logger ─────────────────────────────────────────────────
vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ─── Mock config ─────────────────────────────────────────────────
vi.mock('../../src/core/config.js', () => ({
  getConfig: () => ({
    dataDir: '/tmp/schrute-amendment-test',
    logLevel: 'silent',
    daemon: { port: 19420, autoStart: false },
  }),
  getDbPath: () => ':memory:',
  ensureDirectories: vi.fn(),
}));

import { AmendmentEngine, AMENDMENT_STRATEGIES } from '../../src/healing/amendment.js';
import { AmendmentRepository } from '../../src/storage/amendment-repository.js';
import { SkillRepository } from '../../src/storage/skill-repository.js';
import { MetricsRepository } from '../../src/storage/metrics-repository.js';
import { SiteRepository } from '../../src/storage/site-repository.js';
import { shouldAmend } from '../../src/healing/monitor.js';
import type { AgentDatabase } from '../../src/storage/database.js';
import type { SkillSpec, SiteManifest } from '../../src/skill/types.js';
import { createFullSchemaDb } from '../helpers.js';

function makeSite(overrides?: Partial<SiteManifest>): SiteManifest {
  const now = Date.now();
  return {
    id: 'example.com',
    displayName: 'Example Site',
    firstSeen: now,
    lastVisited: now,
    masteryLevel: 'full',
    recommendedTier: 'direct',
    totalRequests: 100,
    successfulRequests: 98,
    ...overrides,
  } as SiteManifest;
}

function makeSkill(overrides?: Partial<SkillSpec>): SkillSpec {
  const now = Date.now();
  return {
    id: 'example.com.get_users.v1',
    siteId: 'example.com',
    name: 'get_users',
    version: 1,
    status: 'active',
    description: 'Get list of users',
    method: 'GET',
    pathTemplate: '/api/users',
    inputSchema: { type: 'object', properties: { page: { type: 'number' } } },
    sideEffectClass: 'read-only',
    isComposite: false,
    currentTier: 'tier_1',
    tierLock: null,
    confidence: 0.95,
    consecutiveValidations: 5,
    sampleCount: 10,
    successRate: 0.5,
    createdAt: now,
    updatedAt: now,
    allowedDomains: ['example.com'],
    requiredCapabilities: ['net.fetch.direct'],
    parameters: [
      { name: 'page', type: 'number', source: 'user_input', evidence: ['query param'] },
    ],
    validation: {
      semanticChecks: ['status_2xx'],
      customInvariants: [],
    },
    redaction: {
      piiClassesFound: [],
      fieldsRedacted: 0,
    },
    replayStrategy: 'prefer_tier_1',
    ...overrides,
  } as SkillSpec;
}

function seedFailureMetrics(
  metricsRepo: MetricsRepository,
  skillId: string,
  errorType: string,
  count: number,
): void {
  for (let i = 0; i < count; i++) {
    metricsRepo.record({
      skillId,
      executionTier: 'direct',
      success: false,
      latencyMs: 100,
      errorType: errorType as any,
      executedAt: Date.now() - (count - i) * 1000,
    });
  }
}

function seedSuccessMetrics(
  metricsRepo: MetricsRepository,
  skillId: string,
  count: number,
): void {
  for (let i = 0; i < count; i++) {
    metricsRepo.record({
      skillId,
      executionTier: 'direct',
      success: true,
      latencyMs: 50,
      executedAt: Date.now() - (count - i) * 1000,
    });
  }
}

// ─── Tests ─────────────────────────────────────────────────────────

describe('Amendment System', () => {
  let db: AgentDatabase & { close: () => void };
  let skillRepo: SkillRepository;
  let siteRepo: SiteRepository;
  let metricsRepo: MetricsRepository;
  let amendmentRepo: AmendmentRepository;

  beforeEach(() => {
    db = createFullSchemaDb();
    siteRepo = new SiteRepository(db);
    skillRepo = new SkillRepository(db);
    metricsRepo = new MetricsRepository(db);
    amendmentRepo = new AmendmentRepository(db);

    // Seed site
    siteRepo.create(makeSite());
  });

  afterEach(() => {
    try { db.close(); } catch { /* best effort */ }
  });

  // ─── AmendmentRepository ─────────────────────────────────────────

  describe('AmendmentRepository', () => {
    describe('CRUD operations', () => {
      it('creates and retrieves an amendment', () => {
        amendmentRepo.create({
          id: 'amend-1',
          skillId: 'example.com.get_users.v1',
          failureCause: 'schema_drift',
          strategy: 'reinfer_schema',
          snapshotFields: '{}',
          successRateBefore: 0.5,
          evaluationWindow: 10,
          status: 'active',
          createdAt: Date.now(),
        });

        const active = amendmentRepo.getActiveAmendment('example.com.get_users.v1');
        expect(active).toBeDefined();
        expect(active!.id).toBe('amend-1');
        expect(active!.strategy).toBe('reinfer_schema');
        expect(active!.failureCause).toBe('schema_drift');
        expect(active!.status).toBe('active');
        expect(active!.executionsSince).toBe(0);
      });

      it('hasActiveAmendment returns true when active', () => {
        amendmentRepo.create({
          id: 'amend-1',
          skillId: 'example.com.get_users.v1',
          failureCause: 'schema_drift',
          strategy: 'reinfer_schema',
          snapshotFields: '{}',
          successRateBefore: 0.5,
          evaluationWindow: 10,
          status: 'active',
          createdAt: Date.now(),
        });

        expect(amendmentRepo.hasActiveAmendment('example.com.get_users.v1')).toBe(true);
        expect(amendmentRepo.hasActiveAmendment('nonexistent.v1')).toBe(false);
      });

      it('incrementExecutionCount increments', () => {
        amendmentRepo.create({
          id: 'amend-1',
          skillId: 'example.com.get_users.v1',
          failureCause: 'schema_drift',
          strategy: 'reinfer_schema',
          snapshotFields: '{}',
          successRateBefore: 0.5,
          evaluationWindow: 10,
          status: 'active',
          createdAt: Date.now(),
        });

        amendmentRepo.incrementExecutionCount('example.com.get_users.v1');
        amendmentRepo.incrementExecutionCount('example.com.get_users.v1');
        amendmentRepo.incrementExecutionCount('example.com.get_users.v1');

        const active = amendmentRepo.getActiveAmendment('example.com.get_users.v1');
        expect(active!.executionsSince).toBe(3);
      });

      it('resolve marks amendment as kept', () => {
        amendmentRepo.create({
          id: 'amend-1',
          skillId: 'example.com.get_users.v1',
          failureCause: 'schema_drift',
          strategy: 'reinfer_schema',
          snapshotFields: '{}',
          successRateBefore: 0.5,
          evaluationWindow: 10,
          status: 'active',
          createdAt: Date.now(),
        });

        amendmentRepo.resolve('amend-1', 'kept', 0.9);

        const active = amendmentRepo.getActiveAmendment('example.com.get_users.v1');
        expect(active).toBeUndefined(); // no longer active

        const all = amendmentRepo.getBySkillId('example.com.get_users.v1');
        expect(all).toHaveLength(1);
        expect(all[0].status).toBe('kept');
        expect(all[0].successRateAfter).toBe(0.9);
        expect(all[0].resolvedAt).toBeDefined();
      });

      it('resolve marks amendment as reverted', () => {
        amendmentRepo.create({
          id: 'amend-1',
          skillId: 'example.com.get_users.v1',
          failureCause: 'schema_drift',
          strategy: 'reinfer_schema',
          snapshotFields: '{}',
          successRateBefore: 0.5,
          evaluationWindow: 10,
          status: 'active',
          createdAt: Date.now(),
        });

        amendmentRepo.resolve('amend-1', 'reverted', 0.4);

        const all = amendmentRepo.getBySkillId('example.com.get_users.v1');
        expect(all[0].status).toBe('reverted');
        expect(all[0].successRateAfter).toBe(0.4);
      });

      it('getBySkillId returns amendments in desc order', () => {
        amendmentRepo.create({
          id: 'amend-1',
          skillId: 'example.com.get_users.v1',
          failureCause: 'schema_drift',
          strategy: 'reinfer_schema',
          snapshotFields: '{}',
          successRateBefore: 0.5,
          evaluationWindow: 10,
          status: 'active',
          createdAt: 1000,
        });

        amendmentRepo.resolve('amend-1', 'reverted', 0.4);

        amendmentRepo.create({
          id: 'amend-2',
          skillId: 'example.com.get_users.v1',
          failureCause: 'auth_expired',
          strategy: 'refresh_auth',
          snapshotFields: '{}',
          successRateBefore: 0.3,
          evaluationWindow: 10,
          status: 'active',
          createdAt: 2000,
        });

        const all = amendmentRepo.getBySkillId('example.com.get_users.v1');
        expect(all).toHaveLength(2);
        expect(all[0].id).toBe('amend-2');
        expect(all[1].id).toBe('amend-1');
      });

      it('getAll returns all amendments', () => {
        amendmentRepo.create({
          id: 'amend-1',
          skillId: 'example.com.get_users.v1',
          failureCause: 'schema_drift',
          strategy: 'reinfer_schema',
          snapshotFields: '{}',
          successRateBefore: 0.5,
          evaluationWindow: 10,
          status: 'active',
          createdAt: Date.now(),
        });

        const all = amendmentRepo.getAll();
        expect(all).toHaveLength(1);
      });
    });

    describe('rankStrategies', () => {
      it('returns ranked results based on win rate', () => {
        // Create several kept and reverted amendments
        amendmentRepo.create({
          id: 'a1',
          skillId: 'example.com.get_users.v1',
          failureCause: 'schema_drift',
          strategy: 'reinfer_schema',
          snapshotFields: '{}',
          successRateBefore: 0.5,
          evaluationWindow: 10,
          status: 'active',
          createdAt: 1000,
        });
        amendmentRepo.resolve('a1', 'kept', 0.9);

        amendmentRepo.create({
          id: 'a2',
          skillId: 'example.com.get_users.v1',
          failureCause: 'schema_drift',
          strategy: 'relax_validation',
          snapshotFields: '{}',
          successRateBefore: 0.5,
          evaluationWindow: 10,
          status: 'active',
          createdAt: 2000,
        });
        amendmentRepo.resolve('a2', 'reverted', 0.4);

        const ranked = amendmentRepo.rankStrategies('schema_drift', ['reinfer_schema', 'relax_validation']);
        expect(ranked).toHaveLength(2);
        expect(ranked[0].strategy).toBe('reinfer_schema');
        expect(ranked[0].winRate).toBe(1.0);
        expect(ranked[1].strategy).toBe('relax_validation');
        expect(ranked[1].winRate).toBe(0.0);
      });

      it('returns empty array for empty candidates', () => {
        const ranked = amendmentRepo.rankStrategies('schema_drift', []);
        expect(ranked).toEqual([]);
      });

      it('returns empty array when no historical data exists', () => {
        const ranked = amendmentRepo.rankStrategies('unknown_cause', ['reinfer_schema']);
        expect(ranked).toEqual([]);
      });
    });

    describe('isInCooldown', () => {
      it('returns false when no reverted amendments exist', () => {
        skillRepo.create(makeSkill());
        expect(amendmentRepo.isInCooldown('example.com.get_users.v1', 50)).toBe(false);
      });

      it('returns true when not enough executions since last revert', () => {
        skillRepo.create(makeSkill());

        amendmentRepo.create({
          id: 'amend-1',
          skillId: 'example.com.get_users.v1',
          failureCause: 'schema_drift',
          strategy: 'reinfer_schema',
          snapshotFields: '{}',
          successRateBefore: 0.5,
          evaluationWindow: 10,
          status: 'active',
          createdAt: Date.now() - 10000,
        });
        amendmentRepo.resolve('amend-1', 'reverted', 0.4);

        // Add fewer metrics than cooldown requires
        seedSuccessMetrics(metricsRepo, 'example.com.get_users.v1', 5);

        expect(amendmentRepo.isInCooldown('example.com.get_users.v1', 50)).toBe(true);
      });

      it('returns false when enough executions since last revert', () => {
        skillRepo.create(makeSkill());

        const resolvedAt = Date.now() - 100000;
        amendmentRepo.create({
          id: 'amend-1',
          skillId: 'example.com.get_users.v1',
          failureCause: 'schema_drift',
          strategy: 'reinfer_schema',
          snapshotFields: '{}',
          successRateBefore: 0.5,
          evaluationWindow: 10,
          status: 'active',
          createdAt: resolvedAt - 1000,
        });
        amendmentRepo.resolve('amend-1', 'reverted', 0.4);

        // Manually seed metrics after the resolved_at timestamp
        const revertedAmendment = amendmentRepo.getBySkillId('example.com.get_users.v1')[0];
        for (let i = 0; i < 60; i++) {
          metricsRepo.record({
            skillId: 'example.com.get_users.v1',
            executionTier: 'direct',
            success: true,
            latencyMs: 50,
            executedAt: revertedAmendment.resolvedAt! + i * 100 + 1,
          });
        }

        expect(amendmentRepo.isInCooldown('example.com.get_users.v1', 50)).toBe(false);
      });
    });
  });

  // ─── AmendmentEngine ─────────────────────────────────────────────

  describe('AmendmentEngine', () => {
    let engine: AmendmentEngine;

    beforeEach(() => {
      skillRepo.create(makeSkill());
      engine = new AmendmentEngine(amendmentRepo, skillRepo, metricsRepo, 5, 50, 0.15);
    });

    describe('proposeAmendment', () => {
      it('creates an amendment for schema_drift failures', () => {
        seedFailureMetrics(metricsRepo, 'example.com.get_users.v1', 'schema_drift', 5);

        const skill = skillRepo.getById('example.com.get_users.v1')!;
        const result = engine.proposeAmendment(skill);

        expect(result.applied).toBe(true);
        expect(result.amendmentId).toBeDefined();
        expect(result.strategy).toBeDefined();
        expect(result.reason).toContain('schema_drift');

        // Verify amendment was stored
        const active = amendmentRepo.getActiveAmendment('example.com.get_users.v1');
        expect(active).toBeDefined();
        expect(active!.failureCause).toBe('schema_drift');
      });

      it('skips if active amendment exists', () => {
        seedFailureMetrics(metricsRepo, 'example.com.get_users.v1', 'schema_drift', 5);

        const skill = skillRepo.getById('example.com.get_users.v1')!;
        const first = engine.proposeAmendment(skill);
        expect(first.applied).toBe(true);

        const second = engine.proposeAmendment(skill);
        expect(second.applied).toBe(false);
        expect(second.reason).toContain('Active amendment');
      });

      it('skips if in cooldown', () => {
        seedFailureMetrics(metricsRepo, 'example.com.get_users.v1', 'schema_drift', 5);

        // Create and revert an amendment to trigger cooldown
        amendmentRepo.create({
          id: 'old-amend',
          skillId: 'example.com.get_users.v1',
          failureCause: 'schema_drift',
          strategy: 'reinfer_schema',
          snapshotFields: '{}',
          successRateBefore: 0.5,
          evaluationWindow: 5,
          status: 'active',
          createdAt: Date.now() - 10000,
        });
        amendmentRepo.resolve('old-amend', 'reverted', 0.4);

        const skill = skillRepo.getById('example.com.get_users.v1')!;
        const result = engine.proposeAmendment(skill);

        expect(result.applied).toBe(false);
        expect(result.reason).toContain('cooldown');
      });

      it('skips when no failure pattern detected', () => {
        // Only successes, no failures
        seedSuccessMetrics(metricsRepo, 'example.com.get_users.v1', 10);

        const skill = skillRepo.getById('example.com.get_users.v1')!;
        const result = engine.proposeAmendment(skill);

        expect(result.applied).toBe(false);
        expect(result.reason).toContain('No clear failure pattern');
      });

      it('selects strategy from historical rankings', () => {
        // Seed historical data: reinfer_schema was kept, relax_validation was reverted
        // Use explicit timestamps far in the past
        const baseTime = Date.now();

        amendmentRepo.create({
          id: 'hist-1',
          skillId: 'example.com.get_users.v1',
          failureCause: 'schema_drift',
          strategy: 'reinfer_schema',
          snapshotFields: '{}',
          successRateBefore: 0.5,
          evaluationWindow: 5,
          status: 'active',
          createdAt: baseTime - 200000,
        });
        amendmentRepo.resolve('hist-1', 'kept', 0.9);

        amendmentRepo.create({
          id: 'hist-2',
          skillId: 'example.com.get_users.v1',
          failureCause: 'schema_drift',
          strategy: 'relax_validation',
          snapshotFields: '{}',
          successRateBefore: 0.5,
          evaluationWindow: 5,
          status: 'active',
          createdAt: baseTime - 100000,
        });
        amendmentRepo.resolve('hist-2', 'reverted', 0.3);

        // Get the resolved_at of the last reverted amendment
        const lastReverted = amendmentRepo.getBySkillId('example.com.get_users.v1')
          .find(a => a.status === 'reverted');

        // Seed enough post-revert metrics to exit cooldown (must be after resolved_at)
        const postRevertStart = (lastReverted?.resolvedAt ?? baseTime) + 1;
        for (let i = 0; i < 60; i++) {
          metricsRepo.record({
            skillId: 'example.com.get_users.v1',
            executionTier: 'direct',
            success: false,
            latencyMs: 100,
            errorType: 'schema_drift' as any,
            executedAt: postRevertStart + i * 10,
          });
        }

        const skill = skillRepo.getById('example.com.get_users.v1')!;
        const result = engine.proposeAmendment(skill);

        expect(result.applied).toBe(true);
        // reinfer_schema should be preferred since it has a 100% win rate
        expect(result.strategy).toBe('reinfer_schema');
      });
    });

    describe('evaluate', () => {
      it('returns resolved=false when no active amendment', () => {
        const result = engine.evaluate('example.com.get_users.v1');
        expect(result.resolved).toBe(false);
      });

      it('returns resolved=false when not enough executions', () => {
        seedFailureMetrics(metricsRepo, 'example.com.get_users.v1', 'schema_drift', 5);

        const skill = skillRepo.getById('example.com.get_users.v1')!;
        engine.proposeAmendment(skill);

        // Only increment a couple times (less than evaluation window of 5)
        engine.incrementExecutionCount('example.com.get_users.v1');
        engine.incrementExecutionCount('example.com.get_users.v1');

        const result = engine.evaluate('example.com.get_users.v1');
        expect(result.resolved).toBe(false);
      });

      it('keeps amendment on sufficient improvement', () => {
        const baseTime = Date.now();

        // Seed old failure metrics (these establish the pre-amendment state)
        for (let i = 0; i < 5; i++) {
          metricsRepo.record({
            skillId: 'example.com.get_users.v1',
            executionTier: 'direct',
            success: false,
            latencyMs: 100,
            errorType: 'schema_drift' as any,
            executedAt: baseTime - 50000 + i * 1000,
          });
        }

        const skill = skillRepo.getById('example.com.get_users.v1')!;
        engine.proposeAmendment(skill);

        // Increment enough times
        for (let i = 0; i < 5; i++) {
          engine.incrementExecutionCount('example.com.get_users.v1');
        }

        // Seed successful metrics AFTER the failures (these are the "recent" metrics evaluated)
        // Use timestamps clearly after the failure metrics
        for (let i = 0; i < 5; i++) {
          metricsRepo.record({
            skillId: 'example.com.get_users.v1',
            executionTier: 'direct',
            success: true,
            latencyMs: 50,
            executedAt: baseTime + 10000 + i * 1000,
          });
        }

        const result = engine.evaluate('example.com.get_users.v1');
        expect(result.resolved).toBe(true);
        expect(result.kept).toBe(true);

        // Verify amendment is marked as kept
        const amendments = amendmentRepo.getBySkillId('example.com.get_users.v1');
        expect(amendments[0].status).toBe('kept');
      });

      it('reverts amendment on no improvement', () => {
        seedFailureMetrics(metricsRepo, 'example.com.get_users.v1', 'schema_drift', 5);

        const skill = skillRepo.getById('example.com.get_users.v1')!;
        engine.proposeAmendment(skill);

        // Increment enough times
        for (let i = 0; i < 5; i++) {
          engine.incrementExecutionCount('example.com.get_users.v1');
        }

        // Seed failing metrics (no improvement)
        seedFailureMetrics(metricsRepo, 'example.com.get_users.v1', 'schema_drift', 5);

        const result = engine.evaluate('example.com.get_users.v1');
        expect(result.resolved).toBe(true);
        expect(result.kept).toBe(false);

        // Verify amendment is marked as reverted
        const amendments = amendmentRepo.getBySkillId('example.com.get_users.v1');
        expect(amendments[0].status).toBe('reverted');
      });
    });

    describe('incrementExecutionCount', () => {
      it('increments count for active amendment', () => {
        seedFailureMetrics(metricsRepo, 'example.com.get_users.v1', 'schema_drift', 5);

        const skill = skillRepo.getById('example.com.get_users.v1')!;
        engine.proposeAmendment(skill);

        engine.incrementExecutionCount('example.com.get_users.v1');
        engine.incrementExecutionCount('example.com.get_users.v1');

        const active = amendmentRepo.getActiveAmendment('example.com.get_users.v1');
        expect(active!.executionsSince).toBe(2);
      });

      it('is a no-op when no active amendment', () => {
        // Should not throw
        engine.incrementExecutionCount('example.com.get_users.v1');
      });
    });
  });

  // ─── shouldAmend ───────────────────────────────────────────────────

  describe('shouldAmend', () => {
    it('returns skip for healthy status', () => {
      const report = {
        skillId: 'example.com.get_users.v1',
        status: 'healthy' as const,
        successRate: 0.95,
        trend: 0,
        windowSize: 50,
      };

      const result = shouldAmend(report, amendmentRepo);
      expect(result).toBe('skip');
    });

    it('returns amend for degrading status with no active amendment', () => {
      skillRepo.create(makeSkill());

      const report = {
        skillId: 'example.com.get_users.v1',
        status: 'degrading' as const,
        successRate: 0.55,
        trend: -0.15,
        windowSize: 50,
      };

      const result = shouldAmend(report, amendmentRepo);
      expect(result).toBe('amend');
    });

    it('returns amend for broken status with no active amendment', () => {
      skillRepo.create(makeSkill());

      const report = {
        skillId: 'example.com.get_users.v1',
        status: 'broken' as const,
        successRate: 0.1,
        trend: -0.5,
        windowSize: 50,
      };

      const result = shouldAmend(report, amendmentRepo);
      expect(result).toBe('amend');
    });

    it('returns skip when active amendment in progress', () => {
      skillRepo.create(makeSkill());

      amendmentRepo.create({
        id: 'amend-1',
        skillId: 'example.com.get_users.v1',
        failureCause: 'schema_drift',
        strategy: 'reinfer_schema',
        snapshotFields: '{}',
        successRateBefore: 0.5,
        evaluationWindow: 10,
        status: 'active',
        createdAt: Date.now(),
      });

      const report = {
        skillId: 'example.com.get_users.v1',
        status: 'degrading' as const,
        successRate: 0.55,
        trend: -0.15,
        windowSize: 50,
      };

      const result = shouldAmend(report, amendmentRepo);
      expect(result).toBe('skip');
    });

    it('returns relearn when in cooldown', () => {
      skillRepo.create(makeSkill());

      // Create and revert an amendment
      amendmentRepo.create({
        id: 'amend-1',
        skillId: 'example.com.get_users.v1',
        failureCause: 'schema_drift',
        strategy: 'reinfer_schema',
        snapshotFields: '{}',
        successRateBefore: 0.5,
        evaluationWindow: 10,
        status: 'active',
        createdAt: Date.now() - 10000,
      });
      amendmentRepo.resolve('amend-1', 'reverted', 0.4);

      // No metrics after revert -> still in cooldown
      const report = {
        skillId: 'example.com.get_users.v1',
        status: 'broken' as const,
        successRate: 0.1,
        trend: -0.5,
        windowSize: 50,
      };

      const result = shouldAmend(report, amendmentRepo);
      expect(result).toBe('relearn');
    });
  });

  // ─── Strategy Constants ──────────────────────────────────────────

  describe('AMENDMENT_STRATEGIES', () => {
    it('contains expected strategies', () => {
      expect(AMENDMENT_STRATEGIES).toContain('reinfer_schema');
      expect(AMENDMENT_STRATEGIES).toContain('refresh_auth');
      expect(AMENDMENT_STRATEGIES).toContain('add_param');
      expect(AMENDMENT_STRATEGIES).toContain('relax_validation');
      expect(AMENDMENT_STRATEGIES).toContain('escalate_tier');
      expect(AMENDMENT_STRATEGIES).toHaveLength(5);
    });
  });
});
