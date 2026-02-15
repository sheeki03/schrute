import { describe, it, expect, vi } from 'vitest';
import { executeSkill, type ExecutorOptions, type ExecutionResult } from '../../src/replay/executor.js';
import type { SkillSpec, SealedFetchRequest, SealedFetchResponse } from '../../src/skill/types.js';
import { FailureCause, ExecutionTier, TierState } from '../../src/skill/types.js';
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

function mockFetch(response: Partial<SealedFetchResponse>): (req: SealedFetchRequest) => Promise<SealedFetchResponse> {
  return async () => ({
    status: response.status ?? 200,
    headers: response.headers ?? { 'content-type': 'application/json' },
    body: response.body ?? '{"data":"ok"}',
  });
}

describe('executor', () => {
  describe('failure classification', () => {
    it('classifies 429 as rate_limited', async () => {
      const skill = makeSkill();
      const result = await executeSkill(skill, {}, {
        fetchFn: mockFetch({ status: 429, body: 'Too Many Requests' }),
      });
      expect(result.success).toBe(false);
      expect(result.failureCause).toBe(FailureCause.RATE_LIMITED);
    });

    it('classifies 404 as endpoint_removed when 2+ historical successes', async () => {
      const skill = makeSkill();
      const mockMetrics: SkillMetric[] = [
        { skillId: skill.id, executionTier: 'direct', success: true, latencyMs: 50, executedAt: Date.now() - 3600000 },
        { skillId: skill.id, executionTier: 'direct', success: true, latencyMs: 50, executedAt: Date.now() - 1800000 },
      ];
      const result = await executeSkill(skill, {}, {
        fetchFn: mockFetch({ status: 404, body: 'Not Found' }),
        metricsRepo: { getBySkillId: () => mockMetrics } as any,
      });
      expect(result.success).toBe(false);
      expect(result.failureCause).toBe(FailureCause.ENDPOINT_REMOVED);
    });

    it('classifies 410 as endpoint_removed when 2+ historical successes', async () => {
      const skill = makeSkill();
      const mockMetrics: SkillMetric[] = [
        { skillId: skill.id, executionTier: 'direct', success: true, latencyMs: 50, executedAt: Date.now() - 3600000 },
        { skillId: skill.id, executionTier: 'direct', success: true, latencyMs: 50, executedAt: Date.now() - 1800000 },
      ];
      const result = await executeSkill(skill, {}, {
        fetchFn: mockFetch({ status: 410, body: 'Gone' }),
        metricsRepo: { getBySkillId: () => mockMetrics } as any,
      });
      expect(result.success).toBe(false);
      expect(result.failureCause).toBe(FailureCause.ENDPOINT_REMOVED);
    });

    it('classifies 404 as unknown without metrics history', async () => {
      const skill = makeSkill();
      const result = await executeSkill(skill, {}, {
        fetchFn: mockFetch({ status: 404, body: 'Not Found' }),
      });
      expect(result.success).toBe(false);
      expect(result.failureCause).toBe(FailureCause.UNKNOWN);
    });

    it('classifies js_computed_field with permanent lock', async () => {
      const skill = makeSkill({
        currentTier: 'tier_3',
        tierLock: { type: 'permanent', reason: 'js_computed_field', evidence: 'test' },
        outputSchema: {
          type: 'object',
          properties: { computed: { type: 'string' } },
          required: ['computed'],
        },
      });
      const result = await executeSkill(skill, {}, {
        fetchFn: mockFetch({
          status: 200,
          body: JSON.stringify({ wrong: 'schema' }),
        }),
      });
      expect(result.success).toBe(false);
      expect(result.failureCause).toBe(FailureCause.JS_COMPUTED_FIELD);
    });

    it('classifies protocol_sensitivity with permanent lock', async () => {
      const skill = makeSkill({
        tierLock: { type: 'permanent', reason: 'protocol_sensitivity', evidence: 'test' },
      });
      // Use a non-2xx response so overallSuccess is false and classifyFailure is called
      const result = await executeSkill(skill, {}, {
        fetchFn: mockFetch({ status: 500, body: 'Server Error' }),
      });
      expect(result.success).toBe(false);
      expect(result.failureCause).toBe(FailureCause.PROTOCOL_SENSITIVITY);
    });

    it('classifies signed_payload with permanent lock', async () => {
      const skill = makeSkill({
        tierLock: { type: 'permanent', reason: 'signed_payload', evidence: 'test' },
      });
      const result = await executeSkill(skill, {}, {
        fetchFn: mockFetch({ status: 500, body: 'Server Error' }),
      });
      expect(result.success).toBe(false);
      expect(result.failureCause).toBe(FailureCause.SIGNED_PAYLOAD);
    });

    it('classifies schema_drift for 200 with mismatched schema', async () => {
      const skill = makeSkill({
        outputSchema: {
          type: 'object',
          properties: { id: { type: 'number' } },
          required: ['id'],
        },
      });
      const result = await executeSkill(skill, {}, {
        fetchFn: mockFetch({ status: 200, body: JSON.stringify({ name: 'no_id' }) }),
      });
      expect(result.success).toBe(false);
      expect(result.failureCause).toBe(FailureCause.SCHEMA_DRIFT);
    });

    it('classifies auth_expired for 401 with authType', async () => {
      const skill = makeSkill({ authType: 'bearer' });
      const result = await executeSkill(skill, {}, {
        fetchFn: mockFetch({ status: 401, body: 'Unauthorized' }),
      });
      expect(result.success).toBe(false);
      expect(result.failureCause).toBe(FailureCause.AUTH_EXPIRED);
    });

    it('classifies cookie_refresh for 403 without authType', async () => {
      const skill = makeSkill({ authType: undefined });
      const result = await executeSkill(skill, {}, {
        fetchFn: mockFetch({ status: 403, body: 'Forbidden' }),
      });
      expect(result.success).toBe(false);
      expect(result.failureCause).toBe(FailureCause.COOKIE_REFRESH);
    });

    it('classifies unknown for unrecognized errors', async () => {
      const skill = makeSkill();
      const result = await executeSkill(skill, {}, {
        fetchFn: async () => { throw new Error('network failure'); },
      });
      expect(result.success).toBe(false);
      expect(result.failureCause).toBe(FailureCause.UNKNOWN);
    });
  });

  describe('tier cascade', () => {
    it('uses browser_proxied tier for tier_3 skill', async () => {
      const skill = makeSkill({ currentTier: 'tier_3', tierLock: null });
      const result = await executeSkill(skill, {}, {
        fetchFn: mockFetch({ status: 200, body: '{"data":"ok"}' }),
      });
      expect(result.tier).toBe(ExecutionTier.BROWSER_PROXIED);
    });

    it('uses direct tier for tier_1 skill', async () => {
      const skill = makeSkill({ currentTier: 'tier_1', tierLock: null });
      const result = await executeSkill(skill, {}, {
        fetchFn: mockFetch({ status: 200, body: '{"data":"ok"}' }),
      });
      expect(result.tier).toBe(ExecutionTier.DIRECT);
    });

    it('falls back to browser_proxied for permanently locked skill', async () => {
      const skill = makeSkill({
        currentTier: 'tier_1',
        tierLock: { type: 'permanent', reason: 'js_computed_field', evidence: 'test' },
      });
      const result = await executeSkill(skill, {}, {
        fetchFn: mockFetch({ status: 200, body: '{"data":"ok"}' }),
      });
      expect(result.tier).toBe(ExecutionTier.BROWSER_PROXIED);
    });

    it('falls back to browser_proxied for temporarily demoted skill', async () => {
      const skill = makeSkill({
        currentTier: 'tier_1',
        tierLock: { type: 'temporary_demotion', since: new Date().toISOString(), demotions: 1 },
      });
      const result = await executeSkill(skill, {}, {
        fetchFn: mockFetch({ status: 200, body: '{"data":"ok"}' }),
      });
      expect(result.tier).toBe(ExecutionTier.BROWSER_PROXIED);
    });
  });

  describe('side-effect safety', () => {
    it('returns successful result for clean response', async () => {
      const skill = makeSkill({ sideEffectClass: 'read-only' });
      const result = await executeSkill(skill, {}, {
        fetchFn: mockFetch({ status: 200, body: '{"data":"ok"}' }),
      });
      expect(result.success).toBe(true);
      expect(result.status).toBe(200);
    });

    it('forceTier overrides computed tier', async () => {
      const skill = makeSkill({ currentTier: 'tier_3' });
      const result = await executeSkill(skill, {}, {
        fetchFn: mockFetch({ status: 200, body: '{"data":"ok"}' }),
        forceTier: ExecutionTier.DIRECT,
      });
      expect(result.tier).toBe(ExecutionTier.DIRECT);
    });
  });
});
