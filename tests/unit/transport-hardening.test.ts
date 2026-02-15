/**
 * Transport Hardening Tests (v0.2 Checklist Item 9)
 *
 * Verifies request/response size limits, timeouts, concurrency caps,
 * and structured error responses.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestConfig } from '../helpers.js';
import { ToolBudgetTracker } from '../../src/replay/tool-budget.js';
import { isPublicIp } from '../../src/core/policy.js';

// ─── Payload Limits ───────────────────────────────────────────────

describe('Transport Hardening — Payload Limits', () => {
  it('config has request body size limit (5MB default)', () => {
    const config = makeTestConfig();
    expect(config.payloadLimits.maxRequestBodyBytes).toBe(5 * 1024 * 1024);
  });

  it('config has response body size limit (10MB default)', () => {
    const config = makeTestConfig();
    expect(config.payloadLimits.maxResponseBodyBytes).toBe(10 * 1024 * 1024);
  });

  it('tool budget enforces request body size', () => {
    const config = makeTestConfig({
      payloadLimits: {
        maxRequestBodyBytes: 1024,
        maxResponseBodyBytes: 10 * 1024 * 1024,
        replayTimeoutMs: { tier1: 30000, tier3: 60000, tier4: 120000 },
        harCaptureMaxBodyBytes: 50 * 1024 * 1024,
        redactorTimeoutMs: 10000,
      },
    });
    const tracker = new ToolBudgetTracker(config);

    const ok = tracker.checkBudget('skill1', 'site1', { requestBodyBytes: 512 });
    expect(ok.allowed).toBe(true);

    const denied = tracker.checkBudget('skill1', 'site1', { requestBodyBytes: 2048 });
    expect(denied.allowed).toBe(false);
    expect(denied.rule).toBe('budget.request_body_too_large');
    expect(denied.reason).toContain('2048');
    expect(denied.reason).toContain('1024');
  });

  it('ToolBudgetTracker reports max response bytes', () => {
    const config = makeTestConfig({
      payloadLimits: {
        maxRequestBodyBytes: 5 * 1024 * 1024,
        maxResponseBodyBytes: 2048,
        replayTimeoutMs: { tier1: 30000, tier3: 60000, tier4: 120000 },
        harCaptureMaxBodyBytes: 50 * 1024 * 1024,
        redactorTimeoutMs: 10000,
      },
    });
    const tracker = new ToolBudgetTracker(config);
    expect(tracker.getMaxResponseBytes()).toBe(2048);
  });
});

// ─── Timeouts Per Tier ────────────────────────────────────────────

describe('Transport Hardening — Timeouts Per Tier', () => {
  it('tier 1 (direct) has 30s timeout', () => {
    const config = makeTestConfig();
    const tracker = new ToolBudgetTracker(config);
    expect(tracker.getTimeoutMs('direct')).toBe(30000);
  });

  it('tier 3 (browser_proxied) has 60s timeout', () => {
    const config = makeTestConfig();
    const tracker = new ToolBudgetTracker(config);
    expect(tracker.getTimeoutMs('browser_proxied')).toBe(60000);
  });

  it('tier 4 (full_browser) has 120s timeout', () => {
    const config = makeTestConfig();
    const tracker = new ToolBudgetTracker(config);
    expect(tracker.getTimeoutMs('full_browser')).toBe(120000);
  });

  it('custom timeout overrides', () => {
    const config = makeTestConfig({
      payloadLimits: {
        maxRequestBodyBytes: 5 * 1024 * 1024,
        maxResponseBodyBytes: 10 * 1024 * 1024,
        replayTimeoutMs: { tier1: 5000, tier3: 10000, tier4: 20000 },
        harCaptureMaxBodyBytes: 50 * 1024 * 1024,
        redactorTimeoutMs: 10000,
      },
    });
    const tracker = new ToolBudgetTracker(config);
    expect(tracker.getTimeoutMs('direct')).toBe(5000);
    expect(tracker.getTimeoutMs('browser_proxied')).toBe(10000);
    expect(tracker.getTimeoutMs('full_browser')).toBe(20000);
  });
});

// ─── Concurrency Caps ─────────────────────────────────────────────

describe('Transport Hardening — Concurrency Caps', () => {
  it('enforces global concurrent call limit', () => {
    const config = makeTestConfig({ toolBudget: {
      maxToolCallsPerTask: 100,
      maxConcurrentCalls: 3,
      crossDomainCalls: false,
      secretsToNonAllowlisted: false,
    }});
    const tracker = new ToolBudgetTracker(config);

    tracker.recordCall('s1', 'a.com');
    tracker.recordCall('s2', 'b.com');
    tracker.recordCall('s3', 'c.com');

    const check = tracker.checkBudget('s4', 'd.com');
    expect(check.allowed).toBe(false);
    expect(check.rule).toBe('budget.max_concurrent_global');
  });

  it('releases concurrent slot correctly', () => {
    const config = makeTestConfig({ toolBudget: {
      maxToolCallsPerTask: 100,
      maxConcurrentCalls: 2,
      crossDomainCalls: false,
      secretsToNonAllowlisted: false,
    }});
    const tracker = new ToolBudgetTracker(config);

    tracker.recordCall('s1', 'a.com');
    tracker.recordCall('s2', 'b.com');

    let check = tracker.checkBudget('s3', 'c.com');
    expect(check.allowed).toBe(false);

    tracker.releaseCall('a.com');
    check = tracker.checkBudget('s3', 'c.com');
    expect(check.allowed).toBe(true);
  });

  it('enforces per-site concurrent limit (1)', () => {
    const config = makeTestConfig({ toolBudget: {
      maxToolCallsPerTask: 100,
      maxConcurrentCalls: 10,
      crossDomainCalls: false,
      secretsToNonAllowlisted: false,
    }});
    const tracker = new ToolBudgetTracker(config);

    tracker.recordCall('s1', 'same-site.com');

    const check = tracker.checkBudget('s2', 'same-site.com');
    expect(check.allowed).toBe(false);
    expect(check.rule).toBe('budget.max_concurrent_per_site');
  });

  it('cross-domain calls denied by default', () => {
    const config = makeTestConfig({ toolBudget: {
      maxToolCallsPerTask: 100,
      maxConcurrentCalls: 10,
      crossDomainCalls: false,
      secretsToNonAllowlisted: false,
    }});
    const tracker = new ToolBudgetTracker(config);

    const check = tracker.checkBudget('s1', 'site-a.com', {
      targetDomain: 'site-b.com',
    });
    expect(check.allowed).toBe(false);
    expect(check.rule).toBe('budget.cross_domain_denied');
  });
});

// ─── Structured Error Responses ───────────────────────────────────

describe('Transport Hardening — Structured Error Responses', () => {
  it('budget exceeded error has rule and reason', () => {
    const config = makeTestConfig({ toolBudget: {
      maxToolCallsPerTask: 1,
      maxConcurrentCalls: 3,
      crossDomainCalls: false,
      secretsToNonAllowlisted: false,
    }});
    const tracker = new ToolBudgetTracker(config);

    tracker.recordCall('s1', 'site.com');
    tracker.releaseCall('site.com');

    const result = tracker.checkBudget('s2', 'site.com');
    expect(result.allowed).toBe(false);
    expect(result.rule).toBeDefined();
    expect(result.reason).toBeDefined();
    expect(typeof result.rule).toBe('string');
    expect(typeof result.reason).toBe('string');
  });

  it('request body too large error includes actual and max sizes', () => {
    const config = makeTestConfig({
      payloadLimits: {
        maxRequestBodyBytes: 100,
        maxResponseBodyBytes: 10 * 1024 * 1024,
        replayTimeoutMs: { tier1: 30000, tier3: 60000, tier4: 120000 },
        harCaptureMaxBodyBytes: 50 * 1024 * 1024,
        redactorTimeoutMs: 10000,
      },
    });
    const tracker = new ToolBudgetTracker(config);

    const result = tracker.checkBudget('s1', 'site.com', { requestBodyBytes: 500 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('500');
    expect(result.reason).toContain('100');
  });

  it('secrets denial includes domain name', () => {
    const config = makeTestConfig({ toolBudget: {
      maxToolCallsPerTask: 50,
      maxConcurrentCalls: 3,
      crossDomainCalls: true,  // enable cross-domain to reach secrets check
      secretsToNonAllowlisted: false,
    }});
    const tracker = new ToolBudgetTracker(config);
    tracker.setDomainAllowlist(['safe.com']);

    const result = tracker.checkBudget('s1', 'site.com', {
      hasSecrets: true,
      targetDomain: 'attacker.com',
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('attacker.com');
    expect(result.rule).toBe('budget.secrets_non_allowlisted');
  });
});

// ─── Budget Stats ─────────────────────────────────────────────────

describe('Transport Hardening — Budget Statistics', () => {
  it('tracks total calls and concurrent calls', () => {
    const config = makeTestConfig();
    const tracker = new ToolBudgetTracker(config);

    tracker.recordCall('skill-a', 'site-a.com');
    tracker.recordCall('skill-b', 'site-b.com');

    const stats = tracker.getCurrent();
    expect(stats.totalCalls).toBe(2);
    expect(stats.activeConcurrent).toBe(2);
    expect(stats.callsBySkill['skill-a']).toBe(1);
    expect(stats.callsBySkill['skill-b']).toBe(1);
    expect(stats.callsBySite['site-a.com']).toBe(1);
    expect(stats.callsBySite['site-b.com']).toBe(1);

    tracker.releaseCall('site-a.com');
    const stats2 = tracker.getCurrent();
    expect(stats2.activeConcurrent).toBe(1);
    expect(stats2.totalCalls).toBe(2);
  });

  it('reset clears all counters', () => {
    const config = makeTestConfig();
    const tracker = new ToolBudgetTracker(config);

    tracker.recordCall('skill-a', 'site-a.com');
    tracker.recordCall('skill-b', 'site-b.com');

    tracker.reset();
    const stats = tracker.getCurrent();
    expect(stats.totalCalls).toBe(0);
    expect(stats.activeConcurrent).toBe(0);
    expect(Object.keys(stats.callsBySkill)).toHaveLength(0);
    expect(Object.keys(stats.callsBySite)).toHaveLength(0);
  });
});

// ─── IP Validation ────────────────────────────────────────────────

describe('Transport Hardening — Private Network Egress Blocking', () => {
  it('blocks private IPv4 addresses', () => {
    expect(isPublicIp('10.0.0.1')).toBe(false);
    expect(isPublicIp('192.168.1.1')).toBe(false);
    expect(isPublicIp('172.16.0.1')).toBe(false);
  });

  it('blocks loopback addresses', () => {
    expect(isPublicIp('127.0.0.1')).toBe(false);
    expect(isPublicIp('::1')).toBe(false);
  });

  it('allows public IPv4 addresses', () => {
    expect(isPublicIp('8.8.8.8')).toBe(true);
    expect(isPublicIp('1.1.1.1')).toBe(true);
  });

  it('blocks CGNAT addresses', () => {
    expect(isPublicIp('100.64.0.1')).toBe(false);
  });

  it('rejects invalid IPs', () => {
    expect(isPublicIp('not-an-ip')).toBe(false);
    expect(isPublicIp('')).toBe(false);
  });
});
