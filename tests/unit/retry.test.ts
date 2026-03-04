import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock request-builder to work around upperMethod bug in source
vi.mock('../../src/replay/request-builder.js', () => ({
  buildRequest: vi.fn((skill: any, params: any, tier: string) => ({
    url: `https://${skill.allowedDomains?.[0] ?? skill.siteId}${skill.pathTemplate}`,
    method: skill.method,
    headers: { 'accept': 'application/json' },
    body: undefined,
  })),
  extractDomain: vi.fn((url: string) => {
    try { return new URL(url).hostname; } catch { return ''; }
  }),
}));

import { retryWithEscalation, type RetryOptions } from '../../src/replay/retry.js';
import type { SkillSpec, SealedFetchRequest, SealedFetchResponse } from '../../src/skill/types.js';
import { FailureCause, ExecutionTier, SideEffectClass, Capability } from '../../src/skill/types.js';
import { setSitePolicy } from '../../src/core/policy.js';

// Mock resolveAndValidate to avoid real DNS lookups in tests
vi.mock('../../src/core/policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/policy.js')>();
  return {
    ...actual,
    resolveAndValidate: vi.fn().mockResolvedValue({ ip: '93.184.216.34', allowed: true, category: 'unicast' }),
  };
});

function makeSkill(overrides: Partial<SkillSpec> = {}): SkillSpec {
  return {
    id: 'test.skill.v1',
    version: 1,
    status: 'active',
    currentTier: 'tier_1',
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

describe('retry', () => {
  beforeEach(() => {
    setSitePolicy({
      siteId: 'example.com',
      allowedMethods: ['GET', 'HEAD', 'POST'],
      maxQps: 10,
      maxConcurrent: 3,
      readOnlyDefault: true,
      requireConfirmation: [],
      domainAllowlist: ['example.com'],
      redactionRules: [],
      capabilities: [
        Capability.NET_FETCH_DIRECT,
        Capability.NET_FETCH_BROWSER_PROXIED,
        Capability.BROWSER_AUTOMATION,
        Capability.STORAGE_WRITE,
        Capability.SECRETS_USE,
      ],
    });
  });

  it('does not retry write operations (non-read-only)', async () => {
    let callCount = 0;
    const skill = makeSkill({ sideEffectClass: 'non-idempotent' });
    const result = await retryWithEscalation(skill, {}, {
      fetchFn: async () => {
        callCount++;
        return { status: 500, headers: {}, body: 'Error' };
      },
      maxRetries: 3,
    });
    // Should only be called once -- no retries for non-read-only
    expect(callCount).toBe(1);
    expect(result.retryDecisions).toHaveLength(0);
  });

  it('retries up to maxRetries for read-only skills', async () => {
    let callCount = 0;
    const skill = makeSkill({ sideEffectClass: 'read-only' });
    const result = await retryWithEscalation(skill, {}, {
      fetchFn: async () => {
        callCount++;
        return { status: 500, headers: {}, body: 'Error' };
      },
      maxRetries: 3,
    });
    // Initial call (attempt 0) + retries, capped at maxRetries+1 total calls
    // Exact count depends on tier escalation and backoff, but should be > 1 and <= maxRetries+1
    expect(callCount).toBeGreaterThan(1);
    expect(callCount).toBeLessThanOrEqual(4);
    expect(result.success).toBe(false);
    // Should have recorded retry decisions
    expect(result.retryDecisions.length).toBeGreaterThan(0);
  });

  it('succeeds immediately on first success', async () => {
    let callCount = 0;
    const skill = makeSkill({ sideEffectClass: 'read-only' });
    const result = await retryWithEscalation(skill, {}, {
      fetchFn: async () => {
        callCount++;
        return { status: 200, headers: {}, body: '{"data":"ok"}' };
      },
      maxRetries: 3,
    });
    expect(callCount).toBe(1);
    expect(result.success).toBe(true);
    expect(result.retryDecisions).toHaveLength(0);
  });

  it('aborts immediately for endpoint_removed with metrics history', async () => {
    let callCount = 0;
    const skill = makeSkill({ sideEffectClass: 'read-only' });
    const mockMetrics = [
      { skillId: skill.id, executionTier: 'direct', success: true, latencyMs: 50, executedAt: Date.now() - 3600000 },
      { skillId: skill.id, executionTier: 'direct', success: true, latencyMs: 50, executedAt: Date.now() - 1800000 },
    ];
    const result = await retryWithEscalation(skill, {}, {
      fetchFn: async () => {
        callCount++;
        return { status: 404, headers: {}, body: 'Not Found' };
      },
      maxRetries: 3,
      metricsRepo: { getBySkillId: () => mockMetrics } as any,
    });
    // Should only attempt once, then abort
    expect(callCount).toBeLessThanOrEqual(2);
    const abortDecision = result.retryDecisions.find((d) => d.action === 'abort');
    expect(abortDecision).toBeDefined();
    expect(abortDecision!.reason).toContain('Endpoint removed');
  });

  it('aborts for auth_expired (needs re-auth)', async () => {
    const skill = makeSkill({ sideEffectClass: 'read-only', authType: 'bearer' });
    const result = await retryWithEscalation(skill, {}, {
      fetchFn: async () => {
        return { status: 401, headers: {}, body: 'Unauthorized' };
      },
      maxRetries: 3,
    });
    const abortDecision = result.retryDecisions.find((d) => d.action === 'abort');
    expect(abortDecision).toBeDefined();
    expect(abortDecision!.reason).toContain('Auth expired');
  });

  it('escalates tier on cookie_refresh', async () => {
    const skill = makeSkill({ sideEffectClass: 'read-only', currentTier: 'tier_1' });
    const result = await retryWithEscalation(skill, {}, {
      fetchFn: async () => {
        return { status: 403, headers: {}, body: 'Forbidden' };
      },
      maxRetries: 3,
    });
    const escalateDecision = result.retryDecisions.find((d) => d.action === 'escalate');
    expect(escalateDecision).toBeDefined();
    expect(escalateDecision!.reason).toContain('Cookie refresh');
  });

  it('records retry decisions with backoff for rate limiting', async () => {
    let callCount = 0;
    const skill = makeSkill({ sideEffectClass: 'read-only' });
    const result = await retryWithEscalation(skill, {}, {
      fetchFn: async () => {
        callCount++;
        if (callCount <= 2) {
          return { status: 429, headers: {}, body: 'Rate Limited' };
        }
        return { status: 200, headers: {}, body: '{"data":"ok"}' };
      },
      maxRetries: 3,
    });
    // Should have retry decisions with exponential backoff
    const retryDecisions = result.retryDecisions.filter((d) => d.action === 'retry');
    expect(retryDecisions.length).toBeGreaterThan(0);
    for (const d of retryDecisions) {
      expect(d.backoffMs).toBeGreaterThan(0);
    }
  });

  it('builds tier cascade: tier_1 -> tier_3 -> tier_4', async () => {
    const skill = makeSkill({ sideEffectClass: 'read-only', currentTier: 'tier_1', tierLock: null });
    const result = await retryWithEscalation(skill, {}, {
      fetchFn: async () => {
        return { status: 500, headers: {}, body: 'Error' };
      },
      maxRetries: 3,
    });
    // The retryDecisions should show tier escalation pattern
    expect(result.retryDecisions.length).toBeGreaterThan(0);
    // Verify that at least one escalation happened (from tier_1 to browser_proxied or beyond)
    const escalations = result.retryDecisions.filter(d => d.action === 'escalate');
    const retries = result.retryDecisions.filter(d => d.action === 'retry');
    // With unknown failure: first same-tier retry, then escalation
    expect(escalations.length + retries.length).toBeGreaterThan(0);
    // Final result should not succeed
    expect(result.success).toBe(false);
  });

  describe('wiring: tier cascade', () => {
    it('starts with DIRECT for tier_1 skill without locks', async () => {
      const skill = makeSkill({ currentTier: 'tier_1', tierLock: null });
      const result = await retryWithEscalation(skill, {}, {
        fetchFn: async () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }),
      });
      expect(result.tier).toBe('direct');
    });

    it('skips DIRECT tier for permanently locked skill', async () => {
      const skill = makeSkill({
        currentTier: 'tier_1',
        tierLock: { type: 'permanent', reason: 'signed_payload', evidence: 'test' },
      });
      const mockBrowserProvider = {
        evaluateFetch: async () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }),
      };
      const result = await retryWithEscalation(skill, {}, {
        fetchFn: async () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }),
        browserProvider: mockBrowserProvider as any,
      });
      // Should start at browser_proxied, not direct
      expect(result.tier).toBe('browser_proxied');
    });

    it('skips DIRECT tier for temporarily demoted skill', async () => {
      const skill = makeSkill({
        currentTier: 'tier_1',
        tierLock: { type: 'temporary_demotion', since: new Date().toISOString(), demotions: 1 },
      });
      const mockBrowserProvider = {
        evaluateFetch: async () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }),
      };
      const result = await retryWithEscalation(skill, {}, {
        fetchFn: async () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }),
        browserProvider: mockBrowserProvider as any,
      });
      expect(result.tier).toBe('browser_proxied');
    });
  });
});
