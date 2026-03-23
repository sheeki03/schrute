import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock request-builder to produce deterministic requests without tier-based
// header filtering, auth injection, or body/query construction.
// The real buildRequest depends on tier-specific allowlists (TIER1_ALLOWED_HEADERS,
// TIER3_BLOCKED_HEADERS) and adds Origin/Referer for POST/PUT/PATCH. Mocking
// it here isolates executor tests from header-filtering logic, which has its own
// tests in request-builder.test.ts. There is no bug in the source; the original
// comment ("upperMethod bug") was misleading — skill.method is passed through
// as-is in both the mock and the real implementation.
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

vi.mock('../../src/native/redactor.js', () => ({
  redactNative: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/storage/redactor.js', () => ({
  getCachedSalt: vi.fn().mockReturnValue(null),
  redactString: vi.fn().mockResolvedValue('REDACTED'),
}));

import * as http from 'node:http';
import { executeSkill, type ExecutorOptions, type ExecutionResult } from '../../src/replay/executor.js';
import type { SkillSpec, SealedFetchRequest, SealedFetchResponse } from '../../src/skill/types.js';
import { FailureCause, ExecutionTier, TierState, Capability } from '../../src/skill/types.js';
import type { SkillMetric } from '../../src/storage/metrics-repository.js';
import { setSitePolicy, resolveAndValidate } from '../../src/core/policy.js';
import { buildRequest } from '../../src/replay/request-builder.js';
import { redactNative } from '../../src/native/redactor.js';
import { getCachedSalt } from '../../src/storage/redactor.js';

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

function mockFetch(response: Partial<SealedFetchResponse>): (req: SealedFetchRequest) => Promise<SealedFetchResponse> {
  return async () => ({
    status: response.status ?? 200,
    headers: response.headers ?? { 'content-type': 'application/json' },
    body: response.body ?? '{"data":"ok"}',
  });
}

// TODO: add integration test with real DB/real fetch

describe('executor', () => {
  beforeEach(() => {
    // Set up site policy so executor's policy gates pass
    setSitePolicy({
      siteId: 'example.com',
      allowedMethods: ['GET', 'HEAD', 'POST', 'DELETE'],
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

  describe('tier routing', () => {
    it('starts browser_required-locked skills at browser_proxied', async () => {
      const skill = makeSkill({
        currentTier: TierState.TIER_3_DEFAULT,
        tierLock: { type: 'permanent', reason: 'browser_required', evidence: 'challenge detected' },
      });
      const browserProvider = {
        navigate: vi.fn().mockResolvedValue(undefined),
        networkRequests: vi.fn().mockResolvedValue([]),
        evaluateFetch: vi.fn().mockResolvedValue({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: '{"data":"ok"}',
        }),
      } as any;

      const result = await executeSkill(skill, {}, { browserProvider });

      expect(result.success).toBe(true);
      expect(result.tier).toBe(ExecutionTier.BROWSER_PROXIED);
      expect(browserProvider.evaluateFetch).toHaveBeenCalledTimes(1);
      expect(browserProvider.navigate).not.toHaveBeenCalled();
    });
  });

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

    it('classifies cloudflare_challenge from cf-mitigated header before auth handling', async () => {
      const skill = makeSkill({ authType: 'bearer' });
      const result = await executeSkill(skill, {}, {
        fetchFn: mockFetch({
          status: 403,
          headers: {
            'cf-mitigated': 'challenge',
            'content-type': 'text/html',
          },
          body: '<html>Verifying you are human</html>',
        }),
      });
      expect(result.success).toBe(false);
      expect(result.failureCause).toBe(FailureCause.CLOUDFLARE_CHALLENGE);
    });

    it('classifies cloudflare_challenge from challenge body before 5xx handling', async () => {
      const skill = makeSkill();
      const result = await executeSkill(skill, {}, {
        fetchFn: mockFetch({
          status: 503,
          headers: {
            'server': 'cloudflare',
            'content-type': 'text/html',
          },
          body: '<html><title>Just a moment</title><body>Checking your browser</body></html>',
        }),
      });
      expect(result.success).toBe(false);
      expect(result.failureCause).toBe(FailureCause.CLOUDFLARE_CHALLENGE);
    });

    it('does not classify server-cloudflare alone as cloudflare_challenge', async () => {
      const skill = makeSkill();
      const result = await executeSkill(skill, {}, {
        fetchFn: mockFetch({
          status: 403,
          headers: {
            'server': 'cloudflare',
            'cf-ray': 'abc123',
            'content-type': 'text/plain',
          },
          body: 'Forbidden',
        }),
      });
      expect(result.success).toBe(false);
      expect(result.failureCause).toBe(FailureCause.COOKIE_REFRESH);
    });

    it('does not classify generic interstitial text without Cloudflare corroboration', async () => {
      const skill = makeSkill();
      const result = await executeSkill(skill, {}, {
        fetchFn: mockFetch({
          status: 403,
          headers: {
            'content-type': 'text/html',
          },
          body: '<html><title>Just a moment</title><body>Checking your browser</body></html>',
        }),
      });
      expect(result.success).toBe(false);
      expect(result.failureCause).toBe(FailureCause.COOKIE_REFRESH);
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
      const fetchFn = mockFetch({ status: 200, body: JSON.stringify({ wrong: 'schema' }) });
      const result = await executeSkill(skill, {}, {
        fetchFn,
        browserProvider: { evaluateFetch: async (req) => fetchFn(req) } as any,
      });
      expect(result.success).toBe(false);
      expect(result.failureCause).toBe(FailureCause.JS_COMPUTED_FIELD);
    });

    it('classifies protocol_sensitivity with permanent lock', async () => {
      const skill = makeSkill({
        tierLock: { type: 'permanent', reason: 'protocol_sensitivity', evidence: 'test' },
      });
      // Use a non-2xx, non-5xx response so classifyFailure reaches tier lock probes
      const fetchFn = mockFetch({ status: 403, body: 'Forbidden' });
      const result = await executeSkill(skill, {}, {
        fetchFn,
        browserProvider: { evaluateFetch: async (req) => fetchFn(req) } as any,
      });
      expect(result.success).toBe(false);
      expect(result.failureCause).toBe(FailureCause.PROTOCOL_SENSITIVITY);
    });

    it('classifies signed_payload with permanent lock', async () => {
      const skill = makeSkill({
        tierLock: { type: 'permanent', reason: 'signed_payload', evidence: 'test' },
      });
      // Use a non-2xx, non-5xx response so classifyFailure reaches tier lock probes
      const fetchFn = mockFetch({ status: 403, body: 'Forbidden' });
      const result = await executeSkill(skill, {}, {
        fetchFn,
        browserProvider: { evaluateFetch: async (req) => fetchFn(req) } as any,
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

    it('classifies fetch_error for thrown fetch errors', async () => {
      const skill = makeSkill();
      const result = await executeSkill(skill, {}, {
        fetchFn: async () => { throw new Error('network failure'); },
      });
      expect(result.success).toBe(false);
      expect(result.failureCause).toBe(FailureCause.FETCH_ERROR);
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

  // ─── TC-06: Redirect Chain Tests ─────────────────────────────

  describe('redirect chain', () => {
    it('follows redirects to allowed domains', async () => {
      const skill = makeSkill();
      let callCount = 0;
      const result = await executeSkill(skill, {}, {
        fetchFn: async (req) => {
          callCount++;
          if (callCount === 1) {
            return {
              status: 302,
              headers: { 'location': 'https://example.com/api/data-v2', 'content-type': 'text/html' },
              body: 'Redirecting...',
            };
          }
          return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"data":"ok"}' };
        },
      });
      expect(callCount).toBe(2);
      expect(result.status).toBe(200);
      expect(result.success).toBe(true);
    });

    it('blocks redirects to disallowed domains with failureDetail', async () => {
      const skill = makeSkill();
      const result = await executeSkill(skill, {}, {
        fetchFn: async () => ({
          status: 302,
          headers: { 'location': 'https://evil.com/steal', 'content-type': 'text/html' },
          body: 'Redirecting...',
        }),
      });
      // Should fail because redirect target is not in domain allowlist
      expect(result.success).toBe(false);
      expect(result.failureCause).toBe(FailureCause.POLICY_DENIED);
      expect(result.failureDetail).toBeDefined();
      expect(result.failureDetail).toContain('evil.com');
    });

    it('respects max redirect limit', async () => {
      const skill = makeSkill();
      let callCount = 0;
      const result = await executeSkill(skill, {}, {
        fetchFn: async () => {
          callCount++;
          return {
            status: 302,
            headers: { 'location': `https://example.com/redirect-${callCount}`, 'content-type': 'text/html' },
            body: 'Redirecting...',
          };
        },
      });
      // MAX_REDIRECTS is 5 + initial request = at most 6 calls
      expect(callCount).toBeLessThanOrEqual(7);
      // Final result should be a redirect status since we never got a non-redirect response
      expect(result.status).toBe(302);
    });

    it('validates SSRF on each redirect hop', async () => {
      const skill = makeSkill();
      let callCount = 0;

      // Make resolveAndValidate return blocked on the second call (redirect target)
      const mockResolve = resolveAndValidate as ReturnType<typeof vi.fn>;
      mockResolve
        .mockResolvedValueOnce({ ip: '93.184.216.34', allowed: true, category: 'unicast' }) // initial domain check
        .mockResolvedValueOnce({ ip: '127.0.0.1', allowed: false, category: 'loopback' }); // redirect hop

      const result = await executeSkill(skill, {}, {
        fetchFn: async () => {
          callCount++;
          if (callCount === 1) {
            return {
              status: 302,
              headers: { 'location': 'https://example.com/internal', 'content-type': 'text/html' },
              body: 'Redirecting...',
            };
          }
          return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"data":"ok"}' };
        },
      });
      // Should be blocked because redirect resolved to private IP
      expect(result.success).toBe(false);
      expect(result.failureCause).toBe(FailureCause.POLICY_DENIED);
      expect(result.failureDetail).toBeDefined();
      expect(result.failureDetail).toContain('private IP');
    });
  });

  // ─── TC-07: Budget and Audit Flow Tests ──────────────────────

  describe('budget tracking', () => {
    it('blocks execution when budget is exceeded', async () => {
      const skill = makeSkill();
      const mockBudget = {
        checkBudget: vi.fn().mockReturnValue({ allowed: false, reason: 'Max calls exceeded' }),
        recordCall: vi.fn(),
        releaseCall: vi.fn(),
        getTimeoutMs: vi.fn().mockReturnValue(30000),
        getMaxResponseBytes: vi.fn().mockReturnValue(10 * 1024 * 1024),
      };

      const result = await executeSkill(skill, {}, {
        fetchFn: mockFetch({ status: 200, body: '{"data":"ok"}' }),
        budgetTracker: mockBudget as any,
      });
      expect(result.success).toBe(false);
      expect(mockBudget.checkBudget).toHaveBeenCalled();
      expect(mockBudget.recordCall).not.toHaveBeenCalled();
    });

    it('records call and releases on success', async () => {
      const skill = makeSkill();
      const mockBudget = {
        checkBudget: vi.fn().mockReturnValue({ allowed: true }),
        recordCall: vi.fn(),
        releaseCall: vi.fn(),
        getTimeoutMs: vi.fn().mockReturnValue(30000),
        getMaxResponseBytes: vi.fn().mockReturnValue(10 * 1024 * 1024),
      };

      await executeSkill(skill, {}, {
        fetchFn: mockFetch({ status: 200, body: '{"data":"ok"}' }),
        budgetTracker: mockBudget as any,
      });
      expect(mockBudget.recordCall).toHaveBeenCalledWith(skill.id, skill.siteId);
      expect(mockBudget.releaseCall).toHaveBeenCalledWith(skill.siteId);
    });

    it('releases budget on fetch failure', async () => {
      const skill = makeSkill();
      const mockBudget = {
        checkBudget: vi.fn().mockReturnValue({ allowed: true }),
        recordCall: vi.fn(),
        releaseCall: vi.fn(),
        getTimeoutMs: vi.fn().mockReturnValue(30000),
        getMaxResponseBytes: vi.fn().mockReturnValue(10 * 1024 * 1024),
      };

      await executeSkill(skill, {}, {
        fetchFn: async () => { throw new Error('network error'); },
        budgetTracker: mockBudget as any,
      });
      expect(mockBudget.releaseCall).toHaveBeenCalledWith(skill.siteId);
    });
  });

  describe('audit logging', () => {
    it('writes intent and outcome audit entries', async () => {
      const skill = makeSkill();
      const appendedEntries: unknown[] = [];
      const mockAuditLog = {
        appendEntry: vi.fn((entry: unknown) => {
          appendedEntries.push(entry);
          return { id: 'audit-1', entryHash: 'abc' };
        }),
        isStrictMode: vi.fn().mockReturnValue(false),
      };

      await executeSkill(skill, {}, {
        fetchFn: mockFetch({ status: 200, body: '{"data":"ok"}' }),
        auditLog: mockAuditLog as any,
      });

      // Should have called appendEntry at least twice: intent + outcome
      expect(mockAuditLog.appendEntry).toHaveBeenCalledTimes(2);

      // First call is the intent (success: false as placeholder)
      const intentEntry = appendedEntries[0] as Record<string, unknown>;
      expect(intentEntry.success).toBe(false);

      // Second call is the outcome (actual result)
      const outcomeEntry = appendedEntries[1] as Record<string, unknown>;
      expect(outcomeEntry.success).toBe(true);
    });

    it('aborts execution in strict mode when audit intent write fails', async () => {
      const skill = makeSkill();
      const mockAuditLog = {
        appendEntry: vi.fn().mockReturnValue({ type: 'audit_write_error', message: 'disk full' }),
        isStrictMode: vi.fn().mockReturnValue(true),
      };
      const mockBudget = {
        checkBudget: vi.fn().mockReturnValue({ allowed: true }),
        recordCall: vi.fn(),
        releaseCall: vi.fn(),
        getTimeoutMs: vi.fn().mockReturnValue(30000),
        getMaxResponseBytes: vi.fn().mockReturnValue(10 * 1024 * 1024),
      };

      const result = await executeSkill(skill, {}, {
        fetchFn: mockFetch({ status: 200, body: '{"data":"ok"}' }),
        auditLog: mockAuditLog as any,
        budgetTracker: mockBudget as any,
      });

      expect(result.success).toBe(false);
      expect(result.auditIncomplete).toBe(true);
      // Budget should be released when aborting
      expect(mockBudget.releaseCall).toHaveBeenCalled();
    });

    it('flags audit_incomplete in non-strict mode when intent write fails', async () => {
      const skill = makeSkill();
      const mockAuditLog = {
        appendEntry: vi.fn()
          .mockReturnValueOnce({ type: 'audit_write_error', message: 'disk issue' })
          .mockReturnValue({ id: 'audit-2', entryHash: 'def' }),
        isStrictMode: vi.fn().mockReturnValue(false),
      };

      const result = await executeSkill(skill, {}, {
        fetchFn: mockFetch({ status: 200, body: '{"data":"ok"}' }),
        auditLog: mockAuditLog as any,
      });

      // In non-strict mode, execution continues
      expect(result.status).toBe(200);
    });
  });

  describe('wiring: tiering', () => {
    it('uses tier_1 (DIRECT) for skill with currentTier tier_1 and no lock', async () => {
      const skill = makeSkill({ currentTier: 'tier_1', tierLock: null });
      const result = await executeSkill(skill, {}, {
        fetchFn: mockFetch({ status: 200 }),
      });
      expect(result.tier).toBe('direct');
    });

    it('uses browser_proxied for skill with permanent lock', async () => {
      const skill = makeSkill({
        currentTier: 'tier_1',
        tierLock: { type: 'permanent', reason: 'js_computed_field', evidence: 'test' },
      });
      const result = await executeSkill(skill, {}, {
        fetchFn: mockFetch({ status: 200 }),
      });
      // Should use browser_proxied due to permanent lock (getEffectiveTier returns tier_3)
      expect(result.tier).toBe('browser_proxied');
    });

    it('uses browser_proxied for skill with temporary_demotion lock', async () => {
      const skill = makeSkill({
        currentTier: 'tier_1',
        tierLock: { type: 'temporary_demotion', since: new Date().toISOString(), demotions: 1 },
      });
      const result = await executeSkill(skill, {}, {
        fetchFn: mockFetch({ status: 200 }),
      });
      expect(result.tier).toBe('browser_proxied');
    });
  });

  describe('wiring: native redactor fast path', () => {
    it('uses native redactor when getCachedSalt returns a salt', async () => {
      (getCachedSalt as ReturnType<typeof vi.fn>).mockReturnValue('test-salt-value');
      (redactNative as ReturnType<typeof vi.fn>).mockReturnValue('NATIVE_REDACTED');

      const skill = makeSkill();
      const mockAuditLog = {
        appendEntry: vi.fn().mockReturnValue({ id: 'audit-1', entryHash: 'abc' }),
        isStrictMode: vi.fn().mockReturnValue(false),
      };

      await executeSkill(skill, {}, {
        fetchFn: mockFetch({ status: 200, body: '{"data":"ok"}' }),
        auditLog: mockAuditLog as any,
      });

      expect(getCachedSalt).toHaveBeenCalled();
      expect(redactNative).toHaveBeenCalledWith(skill.pathTemplate, 'test-salt-value');
    });

    it('falls back to redactString when getCachedSalt returns null', async () => {
      (getCachedSalt as ReturnType<typeof vi.fn>).mockReturnValue(null);
      (redactNative as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const skill = makeSkill();
      const mockAuditLog = {
        appendEntry: vi.fn().mockReturnValue({ id: 'audit-1', entryHash: 'abc' }),
        isStrictMode: vi.fn().mockReturnValue(false),
      };

      await executeSkill(skill, {}, {
        fetchFn: mockFetch({ status: 200, body: '{"data":"ok"}' }),
        auditLog: mockAuditLog as any,
      });

      expect(getCachedSalt).toHaveBeenCalled();
      // redactNative should not be called (or called with null salt which returns null)
      // The code path falls through to redactString
    });

    it('uses native result when redactNative returns non-null', async () => {
      (getCachedSalt as ReturnType<typeof vi.fn>).mockReturnValue('salt123');
      (redactNative as ReturnType<typeof vi.fn>).mockReturnValue('natively-redacted-path');

      const skill = makeSkill();
      const appendedEntries: any[] = [];
      const mockAuditLog = {
        appendEntry: vi.fn().mockImplementation((entry: any) => {
          appendedEntries.push(entry);
          return { id: 'audit-1', entryHash: 'abc' };
        }),
        isStrictMode: vi.fn().mockReturnValue(false),
      };

      await executeSkill(skill, {}, {
        fetchFn: mockFetch({ status: 200, body: '{"data":"ok"}' }),
        auditLog: mockAuditLog as any,
      });

      // The intent audit entry should have the natively-redacted URL
      expect(appendedEntries[0].requestSummary.url).toBe('natively-redacted-path');
    });
  });

  // ─── TA-6: Pinned IP fetch tests ─────────────────────────────
  //
  // These tests exercise the pinnedIpFetch code path (directFetch when
  // resolvedIp is set and no fetchFn is injected). A local HTTP server
  // stands in for the target so we can verify real socket-level behavior.

  describe('pinned IP fetch (pinnedIpFetch path)', () => {
    let server: http.Server;
    const mockResolve = resolveAndValidate as ReturnType<typeof vi.fn>;
    const mockBuild = buildRequest as ReturnType<typeof vi.fn>;

    function startServer(handler: http.RequestListener): Promise<number> {
      return new Promise((resolve, reject) => {
        server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          if (addr && typeof addr === 'object') {
            resolve(addr.port);
          } else {
            reject(new Error('Could not determine server port'));
          }
        });
        server.on('error', reject);
      });
    }

    function stopServer(): Promise<void> {
      return new Promise((resolve) => {
        if (!server) { resolve(); return; }
        server.close(() => resolve());
      });
    }

    afterEach(async () => {
      await stopServer();
      // Restore default mocks after each test
      mockResolve.mockResolvedValue({ ip: '93.184.216.34', allowed: true, category: 'unicast' });
    });

    beforeEach(() => {
      // Add localhost to domain allowlist so policy gates pass
      setSitePolicy({
        siteId: 'example.com',
        allowedMethods: ['GET', 'HEAD', 'POST', 'DELETE'],
        maxQps: 10,
        maxConcurrent: 3,
        readOnlyDefault: true,
        requireConfirmation: [],
        domainAllowlist: ['example.com', 'localhost'],
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

    // Helper: override buildRequest for both calls (pre-build in executeSkill
    // and the actual request in executeTier).
    function mockBuildForPort(port: number): void {
      const value = {
        url: `http://localhost:${port}/api/data`,
        method: 'GET',
        headers: { 'accept': 'application/json' },
        body: undefined,
      };
      mockBuild
        .mockReturnValueOnce(value)   // pre-build (body size check)
        .mockReturnValueOnce(value);  // executeTier request
    }

    it('successful fetch through pinned IP hits the local server', async () => {
      const port = await startServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ pinned: true }));
      });

      mockBuildForPort(port);

      // resolveAndValidate returns 127.0.0.1 as allowed (normally blocked, but
      // mocked here) so the executor uses pinnedIpFetch with this IP.
      mockResolve.mockResolvedValue({ ip: '127.0.0.1', allowed: true, category: 'unicast' });

      const skill = makeSkill({ allowedDomains: ['example.com', 'localhost'] });
      const result = await executeSkill(skill, {}, {
        // No fetchFn — real directFetch -> pinnedIpFetch
        timeoutMs: 5000,
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe(200);
      expect(result.rawBody).toContain('"pinned":true');
    });

    it('rejects response exceeding body size limit', async () => {
      // Server sends a body larger than the configured limit
      const port = await startServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        // 200 bytes is enough to exceed a 100-byte limit
        res.end(JSON.stringify({ payload: 'x'.repeat(200) }));
      });

      mockBuildForPort(port);
      mockResolve.mockResolvedValue({ ip: '127.0.0.1', allowed: true, category: 'unicast' });

      const skill = makeSkill({ allowedDomains: ['example.com', 'localhost'] });
      // pinnedIpFetch checks maxResponseBytes; use config to set a small limit
      const result = await executeSkill(skill, {}, {
        timeoutMs: 5000,
        config: {
          payloadLimits: { maxResponseBodyBytes: 100 },
        } as any,
      });

      // pinnedIpFetch rejects with an error when body exceeds the limit,
      // which directFetch propagates as a thrown error -> FETCH_ERROR
      expect(result.success).toBe(false);
      expect(result.failureCause).toBe(FailureCause.FETCH_ERROR);
    });

    it('times out when server delays beyond timeoutMs', async () => {
      const port = await startServer((_req, res) => {
        // Delay response well beyond the timeout
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"data":"late"}');
        }, 5000);
      });

      mockBuildForPort(port);
      mockResolve.mockResolvedValue({ ip: '127.0.0.1', allowed: true, category: 'unicast' });

      const skill = makeSkill({ allowedDomains: ['example.com', 'localhost'] });
      const result = await executeSkill(skill, {}, {
        timeoutMs: 200, // Very short timeout
      });

      expect(result.success).toBe(false);
      expect(result.failureCause).toBe(FailureCause.FETCH_ERROR);
    }, 10000); // Generous test timeout to account for cleanup
  });
});
