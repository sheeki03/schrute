import { describe, it, expect } from 'vitest';
import { monitorSkills } from '../../src/healing/monitor.js';
import type { SkillSpec } from '../../src/skill/types.js';
import type { SkillMetric } from '../../src/storage/metrics-repository.js';

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

function makeMetric(success: boolean, executedAt: number): SkillMetric {
  return {
    skillId: 'test.skill.v1',
    executionTier: 'direct',
    success,
    latencyMs: 50,
    executedAt,
  };
}

function mockMetricsRepo(metrics: SkillMetric[]) {
  return {
    getRecentBySkillId: (_skillId: string, _limit?: number) => metrics,
    getBySkillId: (_skillId: string) => metrics,
    getSuccessRate: () => 1.0,
    getAverageLatency: () => 50,
    record: () => {},
  };
}

describe('monitor', () => {
  describe('monitorSkills', () => {
    it('returns healthy for skills with no metrics', () => {
      const skills = [makeSkill()];
      const repo = mockMetricsRepo([]);

      const reports = monitorSkills(skills, repo as any);

      expect(reports).toHaveLength(1);
      expect(reports[0].status).toBe('healthy');
      expect(reports[0].windowSize).toBe(0);
    });

    it('returns healthy for skills with high success rate', () => {
      const now = Date.now();
      const metrics = Array.from({ length: 50 }, (_, i) =>
        makeMetric(true, now - i * 1000),
      );
      const skills = [makeSkill()];
      const repo = mockMetricsRepo(metrics);

      const reports = monitorSkills(skills, repo as any);

      expect(reports[0].status).toBe('healthy');
      expect(reports[0].successRate).toBe(1.0);
    });

    it('returns broken for skills with low success rate', () => {
      const now = Date.now();
      // 80% failures, 20% success
      const metrics = Array.from({ length: 50 }, (_, i) =>
        makeMetric(i % 5 === 0, now - i * 1000),
      );
      const skills = [makeSkill()];
      const repo = mockMetricsRepo(metrics);

      const reports = monitorSkills(skills, repo as any);

      expect(reports[0].status).toBe('broken');
      expect(reports[0].successRate).toBeLessThan(0.3);
    });

    it('returns degrading for skills with moderate success rate', () => {
      const now = Date.now();
      // ~60% success
      const metrics = Array.from({ length: 50 }, (_, i) =>
        makeMetric(i % 5 !== 0 && i % 5 !== 1, now - i * 1000),
      );
      const skills = [makeSkill()];
      const repo = mockMetricsRepo(metrics);

      const reports = monitorSkills(skills, repo as any);

      expect(reports[0].status).toBe('degrading');
    });

    it('detects sudden drop between windows', () => {
      const now = Date.now();
      // Current window: all failures; Previous window: all successes
      const metrics = [
        ...Array.from({ length: 50 }, (_, i) => makeMetric(false, now - i * 1000)),
        ...Array.from({ length: 50 }, (_, i) => makeMetric(true, now - (50 + i) * 1000)),
      ];
      const skills = [makeSkill()];
      const repo = mockMetricsRepo(metrics);

      const reports = monitorSkills(skills, repo as any);

      expect(reports[0].status).toBe('broken');
    });

    it('monitors multiple skills independently', () => {
      const now = Date.now();
      const healthyMetrics = Array.from({ length: 50 }, (_, i) =>
        makeMetric(true, now - i * 1000),
      );
      const brokenMetrics = Array.from({ length: 50 }, (_, i) =>
        makeMetric(false, now - i * 1000),
      );

      const skills = [
        makeSkill({ id: 'healthy.skill.v1' }),
        makeSkill({ id: 'broken.skill.v1' }),
      ];

      const repo = {
        getRecentBySkillId: (skillId: string) =>
          skillId.startsWith('healthy') ? healthyMetrics : brokenMetrics,
        getBySkillId: () => [],
        getSuccessRate: () => 1.0,
        getAverageLatency: () => 50,
        record: () => {},
      };

      const reports = monitorSkills(skills, repo as any);

      expect(reports[0].status).toBe('healthy');
      expect(reports[1].status).toBe('broken');
    });

    it('filters metrics older than 24 hours', () => {
      const oldTime = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
      const metrics = Array.from({ length: 50 }, (_, i) =>
        makeMetric(false, oldTime - i * 1000),
      );
      const skills = [makeSkill()];
      const repo = mockMetricsRepo(metrics);

      const reports = monitorSkills(skills, repo as any);

      // All metrics are outside the 24h window
      expect(reports[0].windowSize).toBe(0);
      expect(reports[0].status).toBe('healthy'); // no data = healthy
    });
  });
});
