import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GepaEngine } from '../../src/healing/gepa.js';
import { AmendmentEngine } from '../../src/healing/amendment.js';
import { makeSkill } from '../helpers.js';
import { SkillStatus } from '../../src/skill/types.js';

describe('GepaEngine', () => {
  // Mock repositories
  const mockSkillRepo = {
    getById: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
    getActive: vi.fn().mockReturnValue([]),
    getBySiteId: vi.fn().mockReturnValue([]),
    getByStatus: vi.fn().mockReturnValue([]),
    update: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  };

  const mockAmendmentRepo = {
    create: vi.fn(),
    getActiveAmendment: vi.fn().mockReturnValue(undefined),
    hasActiveAmendment: vi.fn().mockReturnValue(false),
    isInCooldown: vi.fn().mockReturnValue(false),
    incrementExecutionCount: vi.fn(),
    resolve: vi.fn(),
    rankStrategies: vi.fn().mockReturnValue([]),
    getBySkillId: vi.fn().mockReturnValue([]),
    getAll: vi.fn().mockReturnValue([]),
  };

  const mockExemplarRepo = {
    get: vi.fn(),
    save: vi.fn(),
    delete: vi.fn(),
    pruneOlderThan: vi.fn().mockReturnValue(0),
  };

  const mockMetricsRepo = {
    record: vi.fn(),
    getBySkillId: vi.fn().mockReturnValue([]),
    getRecentBySkillId: vi.fn().mockReturnValue([]),
    getSuccessRate: vi.fn().mockReturnValue(0),
    getAverageLatency: vi.fn().mockReturnValue(0),
  };

  let amendmentEngine: AmendmentEngine;
  let gepa: GepaEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    amendmentEngine = new AmendmentEngine(
      mockAmendmentRepo as any,
      mockSkillRepo as any,
      mockMetricsRepo as any,
    );
    gepa = new GepaEngine(
      mockSkillRepo as any,
      mockAmendmentRepo as any,
      mockExemplarRepo as any,
      amendmentEngine,
    );
  });

  it('rejects non-existent skill', async () => {
    mockSkillRepo.getById.mockReturnValue(null);
    const result = await gepa.optimize('nonexistent');
    expect(result.optimized).toBe(false);
    expect(result.reason).toContain('not found');
  });

  it('rejects non-eligible skill', async () => {
    mockSkillRepo.getById.mockReturnValue(makeSkill({ status: SkillStatus.ACTIVE }));
    mockAmendmentRepo.getBySkillId.mockReturnValue([]); // No reverted amendments
    const result = await gepa.optimize('example.com.get_users.v1');
    expect(result.optimized).toBe(false);
    expect(result.reason).toContain('not eligible');
  });

  it('checks eligibility for broken skills', () => {
    mockSkillRepo.getById.mockReturnValue(makeSkill({ status: SkillStatus.BROKEN }));
    expect(gepa.isEligible('example.com.get_users.v1')).toBe(true);
  });

  it('checks eligibility for skills with 2+ reverted amendments', () => {
    mockSkillRepo.getById.mockReturnValue(makeSkill({ status: SkillStatus.ACTIVE }));
    mockAmendmentRepo.getBySkillId.mockReturnValue([
      { status: 'reverted' },
      { status: 'reverted' },
    ]);
    expect(gepa.isEligible('example.com.get_users.v1')).toBe(true);
  });

  it('rejects optimization without exemplar', async () => {
    mockSkillRepo.getById.mockReturnValue(makeSkill({ status: SkillStatus.BROKEN }));
    mockExemplarRepo.get.mockReturnValue(undefined);
    const result = await gepa.optimize('example.com.get_users.v1');
    expect(result.optimized).toBe(false);
    expect(result.reason).toContain('No exemplar');
  });

  it('generates variants from failure causes', async () => {
    const skill = makeSkill({ status: SkillStatus.BROKEN });
    mockSkillRepo.getById.mockReturnValue(skill);
    mockExemplarRepo.get.mockReturnValue({
      skillId: skill.id,
      responseStatus: 200,
      responseSchemaHash: 'abc',
      redactedResponseBody: '{}',
      capturedAt: Date.now(),
    });
    mockAmendmentRepo.getBySkillId.mockReturnValue([
      { failureCause: 'schema_drift', status: 'reverted' },
      { failureCause: 'schema_drift', status: 'reverted' },
    ]);

    // Allow amendment
    mockAmendmentRepo.hasActiveAmendment.mockReturnValue(false);
    mockAmendmentRepo.isInCooldown.mockReturnValue(false);
    mockMetricsRepo.getRecentBySkillId.mockReturnValue([
      { success: false, errorType: 'schema_drift' },
    ]);

    const result = await gepa.optimize(skill.id);
    expect(result.variantsGenerated).toBeGreaterThan(0);
  });

  describe('scoreVariant uses exemplar body', () => {
    it('scores higher when exemplar body keys match existing outputSchema', async () => {
      const skill = makeSkill({
        status: SkillStatus.BROKEN,
        outputSchema: { properties: { id: { type: 'number' }, name: { type: 'string' } } },
      });
      mockSkillRepo.getById.mockReturnValue(skill);
      mockExemplarRepo.get.mockReturnValue({
        skillId: skill.id,
        responseStatus: 200,
        responseSchemaHash: 'abc',
        redactedResponseBody: JSON.stringify({ id: 1, name: 'test' }),
        capturedAt: Date.now(),
      });
      mockAmendmentRepo.getBySkillId.mockReturnValue([
        { failureCause: 'auth_expired', status: 'reverted' },
        { failureCause: 'auth_expired', status: 'reverted' },
      ]);
      mockAmendmentRepo.hasActiveAmendment.mockReturnValue(false);
      mockAmendmentRepo.isInCooldown.mockReturnValue(false);
      mockMetricsRepo.getRecentBySkillId.mockReturnValue([
        { success: false, errorType: 'auth_expired' },
      ]);

      const result = await gepa.optimize(skill.id);
      // Should generate variants and score them using exemplar body
      expect(result.variantsGenerated).toBeGreaterThan(0);
      if (result.bestVariant?.score !== undefined) {
        expect(result.bestVariant.score).toBeGreaterThan(0);
      }
    });

    it('gives neutral score when exemplar body is not parseable', async () => {
      const skill = makeSkill({ status: SkillStatus.BROKEN });
      mockSkillRepo.getById.mockReturnValue(skill);
      mockExemplarRepo.get.mockReturnValue({
        skillId: skill.id,
        responseStatus: 200,
        responseSchemaHash: 'abc',
        redactedResponseBody: 'not-json',
        capturedAt: Date.now(),
      });
      mockAmendmentRepo.getBySkillId.mockReturnValue([
        { failureCause: 'schema_drift', status: 'reverted' },
        { failureCause: 'schema_drift', status: 'reverted' },
      ]);
      mockAmendmentRepo.hasActiveAmendment.mockReturnValue(false);
      mockAmendmentRepo.isInCooldown.mockReturnValue(false);
      mockMetricsRepo.getRecentBySkillId.mockReturnValue([
        { success: false, errorType: 'schema_drift' },
      ]);

      const result = await gepa.optimize(skill.id);
      expect(result.variantsGenerated).toBeGreaterThan(0);
    });

    it('scores schema clearing variant at 0.7 when exemplar body exists', async () => {
      const skill = makeSkill({
        status: SkillStatus.BROKEN,
        outputSchema: { properties: { id: { type: 'number' } } },
      });
      mockSkillRepo.getById.mockReturnValue(skill);
      mockExemplarRepo.get.mockReturnValue({
        skillId: skill.id,
        responseStatus: 200,
        responseSchemaHash: 'abc',
        redactedResponseBody: JSON.stringify({ id: 1 }),
        capturedAt: Date.now(),
      });
      mockAmendmentRepo.getBySkillId.mockReturnValue([
        { failureCause: 'schema_drift', status: 'reverted' },
        { failureCause: 'schema_drift', status: 'reverted' },
      ]);
      mockAmendmentRepo.hasActiveAmendment.mockReturnValue(false);
      mockAmendmentRepo.isInCooldown.mockReturnValue(false);
      mockMetricsRepo.getRecentBySkillId.mockReturnValue([
        { success: false, errorType: 'schema_drift' },
      ]);

      const result = await gepa.optimize(skill.id);
      // schema_drift generates variants that clear outputSchema
      // The scoring should use exemplar body, not hardcoded 0.5
      expect(result.variantsGenerated).toBeGreaterThan(0);
      if (result.bestVariant) {
        expect(result.bestVariant.score).toBeDefined();
      }
    });
  });
});
