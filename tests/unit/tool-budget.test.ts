import { describe, it, expect, beforeEach } from 'vitest';
import { ToolBudgetTracker } from '../../src/replay/tool-budget.js';
import type { OneAgentConfig } from '../../src/skill/types.js';

function makeConfig(overrides?: Partial<OneAgentConfig>): OneAgentConfig {
  return {
    dataDir: '/tmp/test-oneagent',
    logLevel: 'silent',
    features: { webmcp: false, httpTransport: false },
    toolBudget: {
      maxToolCallsPerTask: 5,
      maxConcurrentCalls: 2,
      crossDomainCalls: false,
      secretsToNonAllowlisted: false,
    },
    payloadLimits: {
      maxResponseBodyBytes: 10 * 1024 * 1024,
      maxRequestBodyBytes: 5 * 1024 * 1024,
      replayTimeoutMs: { tier1: 30000, tier3: 60000, tier4: 120000 },
      harCaptureMaxBodyBytes: 50 * 1024 * 1024,
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
    ...overrides,
  } as OneAgentConfig;
}

describe('tool-budget', () => {
  let tracker: ToolBudgetTracker;

  beforeEach(() => {
    tracker = new ToolBudgetTracker(makeConfig());
  });

  describe('max tool calls per task', () => {
    it('allows calls under the limit', () => {
      const result = tracker.checkBudget('skill-1', 'site-1');
      expect(result.allowed).toBe(true);
    });

    it('blocks calls exceeding the limit', () => {
      for (let i = 0; i < 5; i++) {
        tracker.recordCall(`skill-${i}`, 'site-1');
        tracker.releaseCall('site-1');
      }
      const result = tracker.checkBudget('skill-6', 'site-1');
      expect(result.allowed).toBe(false);
      expect(result.rule).toBe('budget.max_calls_per_task');
    });
  });

  describe('max concurrent calls', () => {
    it('blocks when max concurrent reached', () => {
      tracker.recordCall('skill-1', 'site-a');
      tracker.recordCall('skill-2', 'site-b');
      const result = tracker.checkBudget('skill-3', 'site-c');
      expect(result.allowed).toBe(false);
      expect(result.rule).toBe('budget.max_concurrent_global');
    });

    it('allows after releasing a call', () => {
      tracker.recordCall('skill-1', 'site-a');
      tracker.recordCall('skill-2', 'site-b');
      tracker.releaseCall('site-a');
      const result = tracker.checkBudget('skill-3', 'site-c');
      expect(result.allowed).toBe(true);
    });
  });

  describe('cross-domain calls', () => {
    it('blocks cross-domain calls when disabled', () => {
      const result = tracker.checkBudget('skill-1', 'example.com', {
        targetDomain: 'other-site.com',
      });
      expect(result.allowed).toBe(false);
      expect(result.rule).toBe('budget.cross_domain_denied');
    });

    it('allows same-domain calls', () => {
      const result = tracker.checkBudget('skill-1', 'example.com', {
        targetDomain: 'api.example.com',
      });
      expect(result.allowed).toBe(true);
    });

    it('allows cross-domain when enabled', () => {
      const crossDomainTracker = new ToolBudgetTracker(makeConfig({
        toolBudget: {
          maxToolCallsPerTask: 50,
          maxConcurrentCalls: 3,
          crossDomainCalls: true,
          secretsToNonAllowlisted: false,
        },
      } as Partial<OneAgentConfig>));
      const result = crossDomainTracker.checkBudget('skill-1', 'example.com', {
        targetDomain: 'other-site.com',
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe('secrets to non-allowlisted domain', () => {
    it('blocks secrets to non-allowlisted domain', () => {
      // Use a tracker that allows cross-domain so the secrets check is what blocks
      const crossDomainTracker = new ToolBudgetTracker(makeConfig({
        toolBudget: {
          maxToolCallsPerTask: 50,
          maxConcurrentCalls: 3,
          crossDomainCalls: true,
          secretsToNonAllowlisted: false,
        },
      } as Partial<OneAgentConfig>));
      crossDomainTracker.setDomainAllowlist(['trusted.com']);
      const result = crossDomainTracker.checkBudget('skill-1', 'trusted.com', {
        targetDomain: 'evil.com',
        hasSecrets: true,
      });
      expect(result.allowed).toBe(false);
      expect(result.rule).toBe('budget.secrets_non_allowlisted');
    });

    it('allows secrets to allowlisted domain', () => {
      tracker.setDomainAllowlist(['trusted.com']);
      const result = tracker.checkBudget('skill-1', 'trusted.com', {
        targetDomain: 'trusted.com',
        hasSecrets: true,
      });
      expect(result.allowed).toBe(true);
    });

    it('allows secrets to subdomain of allowlisted domain', () => {
      tracker.setDomainAllowlist(['trusted.com']);
      const result = tracker.checkBudget('skill-1', 'trusted.com', {
        targetDomain: 'api.trusted.com',
        hasSecrets: true,
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe('budget stats', () => {
    it('tracks call counts correctly', () => {
      tracker.recordCall('skill-1', 'site-a');
      tracker.recordCall('skill-1', 'site-b');
      tracker.recordCall('skill-2', 'site-a');
      const stats = tracker.getCurrent();
      expect(stats.totalCalls).toBe(3);
      expect(stats.activeConcurrent).toBe(3);
      expect(stats.callsBySkill['skill-1']).toBe(2);
      expect(stats.callsBySite['site-a']).toBe(2);
    });

    it('resets cleanly', () => {
      tracker.recordCall('skill-1', 'site-a');
      tracker.reset();
      const stats = tracker.getCurrent();
      expect(stats.totalCalls).toBe(0);
      expect(stats.activeConcurrent).toBe(0);
    });
  });
});
