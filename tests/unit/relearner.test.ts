import { describe, it, expect, vi } from 'vitest';
import { relearnSkill } from '../../src/healing/relearner.js';
import type { SkillSpec, OneAgentConfig } from '../../src/skill/types.js';

function makeSkill(overrides: Partial<SkillSpec> = {}): SkillSpec {
  return {
    id: 'example.getData.v1',
    version: 1,
    status: 'broken',
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
    consecutiveValidations: 0,
    confidence: 0.05,
    method: 'GET',
    pathTemplate: '/api/data',
    inputSchema: {},
    isComposite: false,
    siteId: 'example.com',
    name: 'get data',
    successRate: 0.2,
    createdAt: Date.now() - 86400000,
    updatedAt: Date.now(),
    lastVerified: Date.now() - 86400000 * 60, // 60 days ago
    ...overrides,
  } as SkillSpec;
}

function mockSkillRepo() {
  return {
    create: vi.fn(),
    update: vi.fn(),
    getById: vi.fn(),
    getBySiteId: vi.fn().mockReturnValue([]),
    getActive: vi.fn().mockReturnValue([]),
    getByStatus: vi.fn().mockReturnValue([]),
    updateTier: vi.fn(),
    updateConfidence: vi.fn(),
    delete: vi.fn(),
  };
}

function mockMetricsRepo() {
  return {
    record: vi.fn(),
    getBySkillId: vi.fn().mockReturnValue([]),
    getRecentBySkillId: vi.fn().mockReturnValue([]),
    getSuccessRate: vi.fn().mockReturnValue(0),
    getAverageLatency: vi.fn().mockReturnValue(50),
  };
}

const mockConfig: OneAgentConfig = {
  dataDir: '/tmp/oneagent-test',
  logLevel: 'info',
  features: { webmcp: false, httpTransport: false },
  toolBudget: {
    maxToolCallsPerTask: 50,
    maxConcurrentCalls: 3,
    crossDomainCalls: false,
    secretsToNonAllowlisted: false,
  },
  payloadLimits: {
    maxResponseBodyBytes: 10_000_000,
    maxRequestBodyBytes: 5_000_000,
    replayTimeoutMs: { tier1: 30000, tier3: 60000, tier4: 120000 },
    harCaptureMaxBodyBytes: 50_000_000,
    redactorTimeoutMs: 10000,
  },
  audit: { strictMode: true, rootHashExport: true },
  storage: { maxPerSiteMb: 500, maxGlobalMb: 5000, retentionDays: 90 },
  server: { network: false },
  tempTtlMs: 3600000,
  gcIntervalMs: 900000,
  confirmationTimeoutMs: 30000,
  confirmationExpiryMs: 60000,
  promotionConsecutivePasses: 5,
  promotionVolatilityThreshold: 0.2,
  maxToolsPerSite: 20,
  toolShortlistK: 10,
};

describe('relearner', () => {
  describe('relearnSkill', () => {
    it('revalidates if confidence is still acceptable', async () => {
      const skill = makeSkill({
        lastVerified: Date.now() - 1000, // recently verified
        successRate: 0.8,
      });
      const skillRepo = mockSkillRepo();
      const metricsRepo = mockMetricsRepo();

      const result = await relearnSkill(skill, skillRepo as any, metricsRepo as any, mockConfig);

      expect(result.action).toBe('revalidated');
      expect(skillRepo.update).toHaveBeenCalledWith(skill.id, expect.objectContaining({
        status: 'active',
      }));
    });

    it('escalates to new version when confidence is low', async () => {
      const skill = makeSkill({ confidence: 0.05, successRate: 0.1 });
      const skillRepo = mockSkillRepo();
      const metricsRepo = mockMetricsRepo();

      const result = await relearnSkill(skill, skillRepo as any, metricsRepo as any, mockConfig);

      expect(result.action).toBe('escalated');
      expect(result.newVersion).toBeDefined();
      expect(result.newVersion!.version).toBe(2);
      expect(result.newVersion!.id).toBe('example.getData.v2');
      expect(result.oldStatus).toBe('stale');
      expect(skillRepo.create).toHaveBeenCalled();
      expect(skillRepo.update).toHaveBeenCalledWith(skill.id, { status: 'stale' });
    });

    it('signals needs_reexplore after max escalation attempts', async () => {
      const skill = makeSkill({
        id: 'example.getData.v4',
        version: 4, // v4 means 3 escalations already
        confidence: 0.01,
        successRate: 0.0,
      });
      const skillRepo = mockSkillRepo();
      const metricsRepo = mockMetricsRepo();

      const result = await relearnSkill(skill, skillRepo as any, metricsRepo as any, mockConfig);

      expect(result.action).toBe('needs_reexplore');
      expect(result.oldStatus).toBe('broken');
      expect(skillRepo.update).toHaveBeenCalledWith(skill.id, { status: 'broken' });
      expect(skillRepo.create).not.toHaveBeenCalled();
    });

    it('returns needs_reexplore if create fails', async () => {
      const skill = makeSkill({ confidence: 0.01, successRate: 0.0 });
      const skillRepo = mockSkillRepo();
      skillRepo.create.mockImplementation(() => {
        throw new Error('DB error');
      });
      const metricsRepo = mockMetricsRepo();

      const result = await relearnSkill(skill, skillRepo as any, metricsRepo as any, mockConfig);

      expect(result.action).toBe('needs_reexplore');
    });

    it('new version starts in draft status', async () => {
      const skill = makeSkill({ confidence: 0.01, successRate: 0.0 });
      const skillRepo = mockSkillRepo();
      const metricsRepo = mockMetricsRepo();

      const result = await relearnSkill(skill, skillRepo as any, metricsRepo as any, mockConfig);

      expect(result.action).toBe('escalated');
      expect(result.newVersion!.status).toBe('draft');
      expect(result.newVersion!.consecutiveValidations).toBe(0);
      expect(result.newVersion!.sampleCount).toBe(0);
    });
  });
});
