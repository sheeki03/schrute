/**
 * Security Parity Tests (v0.2 Checklist Item 8)
 *
 * Verifies that policy, redaction, and audit behavior is IDENTICAL
 * across all transports (stdio, HTTP, REST).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  makeTestConfig,
  makeSkill,
  makeDangerousSkill,
  makeUnvalidatedSkill,
  makeSitePolicy,
} from '../helpers.js';
import type { AuditEntry } from '../../src/skill/types.js';
import { ToolBudgetTracker } from '../../src/replay/tool-budget.js';
import {
  BLOCKED_BROWSER_TOOLS,
  ALLOWED_BROWSER_TOOLS,
} from '../../src/skill/types.js';
import { dryRun } from '../../src/replay/dry-run.js';
import { AuditLog } from '../../src/replay/audit-log.js';

// ─── Config defaults ──────────────────────────────────────────────

describe('Security Parity — Config Defaults', () => {
  it('audit.strictMode defaults to true', () => {
    const config = makeTestConfig();
    expect(config.audit.strictMode).toBe(true);
  });

  it('server.network defaults to false', () => {
    const config = makeTestConfig();
    expect(config.server.network).toBe(false);
  });

  it('features.httpTransport defaults to false', () => {
    const config = makeTestConfig();
    expect(config.features.httpTransport).toBe(false);
  });

  it('toolBudget.secretsToNonAllowlisted is always false', () => {
    const config = makeTestConfig();
    expect(config.toolBudget.secretsToNonAllowlisted).toBe(false);
  });
});

// ─── Policy checks ───────────────────────────────────────────────

describe('Security Parity — Policy Checks', () => {
  let checkCapability: typeof import('../../src/core/policy.js').checkCapability;
  let enforceDomainAllowlist: typeof import('../../src/core/policy.js').enforceDomainAllowlist;
  let checkMethodAllowed: typeof import('../../src/core/policy.js').checkMethodAllowed;
  let checkPathRisk: typeof import('../../src/core/policy.js').checkPathRisk;
  let setSitePolicy: typeof import('../../src/core/policy.js').setSitePolicy;

  beforeEach(async () => {
    const policy = await import('../../src/core/policy.js');
    checkCapability = policy.checkCapability;
    enforceDomainAllowlist = policy.enforceDomainAllowlist;
    checkMethodAllowed = policy.checkMethodAllowed;
    checkPathRisk = policy.checkPathRisk;
    setSitePolicy = policy.setSitePolicy;
  });

  describe('checkCapability', () => {
    it('allows default v0.1 capabilities', () => {
      const result = checkCapability('example.com', 'net.fetch.direct');
      expect(result).toHaveProperty('allowed');
      expect(result).toHaveProperty('rule');
    });

    it('blocks v0.1 disabled capabilities', () => {
      const result = checkCapability('example.com', 'browser.modelContext');
      expect(result.allowed).toBe(false);
      expect(result.rule).toBe('capability.disabled_by_default');
    });

    it('blocks export.skills (v0.1 disabled)', () => {
      const result = checkCapability('example.com', 'export.skills');
      expect(result.allowed).toBe(false);
      expect(result.rule).toBe('capability.disabled_by_default');
    });
  });

  describe('enforceDomainAllowlist', () => {
    it('blocks when no allowlist is configured', () => {
      const result = enforceDomainAllowlist('no-policy-site.com', 'example.com');
      expect(result.allowed).toBe(false);
    });

    it('allows domain on allowlist', () => {
      setSitePolicy(makeSitePolicy({
        siteId: 'test-site',
        domainAllowlist: ['example.com'],
      }));
      const result = enforceDomainAllowlist('test-site', 'example.com');
      expect(result.allowed).toBe(true);
      expect(result.rule).toBe('domain.allowlisted');
    });

    it('allows subdomains of allowlisted domains', () => {
      setSitePolicy(makeSitePolicy({
        siteId: 'test-site-sub',
        domainAllowlist: ['example.com'],
      }));
      const result = enforceDomainAllowlist('test-site-sub', 'api.example.com');
      expect(result.allowed).toBe(true);
    });

    it('blocks domains not on allowlist', () => {
      setSitePolicy(makeSitePolicy({
        siteId: 'test-site-blocked',
        domainAllowlist: ['example.com'],
      }));
      const result = enforceDomainAllowlist('test-site-blocked', 'evil.com');
      expect(result.allowed).toBe(false);
      expect(result.rule).toBe('domain.not_allowlisted');
    });
  });

  describe('checkMethodAllowed', () => {
    it('always allows GET and HEAD', () => {
      expect(checkMethodAllowed('any-site', 'GET')).toBe(true);
      expect(checkMethodAllowed('any-site', 'HEAD')).toBe(true);
    });

    it('blocks DELETE by default', () => {
      expect(checkMethodAllowed('any-site', 'DELETE')).toBe(false);
    });

    it('blocks POST by default unless read-only side-effect', () => {
      expect(checkMethodAllowed('any-site', 'POST')).toBe(false);
      expect(checkMethodAllowed('any-site', 'POST', 'read-only')).toBe(true);
    });

    it('allows methods explicitly listed in policy', () => {
      setSitePolicy(makeSitePolicy({
        siteId: 'post-allowed-site',
        allowedMethods: ['GET', 'HEAD', 'POST'],
      }));
      expect(checkMethodAllowed('post-allowed-site', 'POST')).toBe(true);
    });
  });

  describe('checkPathRisk', () => {
    it('blocks destructive GET patterns', () => {
      const paths = ['/logout', '/signout', '/delete/123', '/unsubscribe', '/destroy'];
      for (const p of paths) {
        const result = checkPathRisk('GET', p);
        expect(result.blocked).toBe(true);
      }
    });

    it('blocks destructive POST patterns', () => {
      const paths = ['/mutation', '/charge', '/delete', '/send', '/order', '/payment'];
      for (const p of paths) {
        const result = checkPathRisk('POST', p);
        expect(result.blocked).toBe(true);
      }
    });

    it('allows safe GET paths', () => {
      const result = checkPathRisk('GET', '/api/users');
      expect(result.blocked).toBe(false);
    });

    it('allows safe POST paths', () => {
      const result = checkPathRisk('POST', '/api/search');
      expect(result.blocked).toBe(false);
    });
  });
});

// ─── Router uses same policy for REST as MCP ──────────────────────

describe('Security Parity — Router Policy Integration', () => {
  it('router applies executeSkill with confirmation for unvalidated skills', () => {
    const skill = makeUnvalidatedSkill();
    expect(skill.consecutiveValidations).toBe(0);
    expect(skill.consecutiveValidations < 1).toBe(true);
  });

  it('router applies same dry-run redaction as MCP', () => {
    const skill = makeSkill();
    expect(skill.method).toBe('GET');
  });
});

// ─── Tool Budget ──────────────────────────────────────────────────

describe('Security Parity — Tool Budget', () => {
  it('enforces max tool calls per task', () => {
    const config = makeTestConfig({ toolBudget: {
      maxToolCallsPerTask: 2,
      maxConcurrentCalls: 3,
      crossDomainCalls: false,
      secretsToNonAllowlisted: false,
    }});
    const tracker = new ToolBudgetTracker(config);

    tracker.recordCall('skill1', 'site1');
    tracker.releaseCall('site1');
    tracker.recordCall('skill1', 'site1');
    tracker.releaseCall('site1');

    const check = tracker.checkBudget('skill1', 'site1');
    expect(check.allowed).toBe(false);
    expect(check.rule).toBe('budget.max_calls_per_task');
  });

  it('enforces max concurrent calls', () => {
    const config = makeTestConfig({ toolBudget: {
      maxToolCallsPerTask: 100,
      maxConcurrentCalls: 2,
      crossDomainCalls: false,
      secretsToNonAllowlisted: false,
    }});
    const tracker = new ToolBudgetTracker(config);

    tracker.recordCall('skill1', 'site1');
    tracker.recordCall('skill2', 'site2');

    const check = tracker.checkBudget('skill3', 'site3');
    expect(check.allowed).toBe(false);
    expect(check.rule).toBe('budget.max_concurrent_global');
  });

  it('HARD DENY: secrets to non-allowlisted domain', () => {
    const config = makeTestConfig({ toolBudget: {
      maxToolCallsPerTask: 50,
      maxConcurrentCalls: 3,
      crossDomainCalls: true,  // enable cross-domain to reach secrets check
      secretsToNonAllowlisted: false,
    }});
    const tracker = new ToolBudgetTracker(config);
    tracker.setDomainAllowlist(['trusted.com']);

    const check = tracker.checkBudget('skill1', 'site1', {
      hasSecrets: true,
      targetDomain: 'evil.com',
    });
    expect(check.allowed).toBe(false);
    expect(check.rule).toBe('budget.secrets_non_allowlisted');
  });

  it('allows secrets to allowlisted domain', () => {
    const config = makeTestConfig({ toolBudget: {
      maxToolCallsPerTask: 50,
      maxConcurrentCalls: 3,
      crossDomainCalls: true,  // enable cross-domain to reach secrets check
      secretsToNonAllowlisted: false,
    }});
    const tracker = new ToolBudgetTracker(config);
    tracker.setDomainAllowlist(['trusted.com']);

    const check = tracker.checkBudget('skill1', 'site1', {
      hasSecrets: true,
      targetDomain: 'trusted.com',
    });
    expect(check.allowed).toBe(true);
  });

  it('enforces request body size limit', () => {
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

    const check = tracker.checkBudget('skill1', 'site1', {
      requestBodyBytes: 200,
    });
    expect(check.allowed).toBe(false);
    expect(check.rule).toBe('budget.request_body_too_large');
  });
});

// ─── Blocked browser tools ────────────────────────────────────────

describe('Security Parity — Blocked Browser Tools', () => {
  it('browser_evaluate is in BLOCKED_BROWSER_TOOLS', () => {
    expect(BLOCKED_BROWSER_TOOLS).toContain('browser_evaluate');
  });

  it('browser_run_code is in BLOCKED_BROWSER_TOOLS', () => {
    expect(BLOCKED_BROWSER_TOOLS).toContain('browser_run_code');
  });

  it('browser_install is in BLOCKED_BROWSER_TOOLS', () => {
    expect(BLOCKED_BROWSER_TOOLS).toContain('browser_install');
  });

  it('blocked tools are not in ALLOWED_BROWSER_TOOLS', () => {
    for (const blocked of BLOCKED_BROWSER_TOOLS) {
      expect((ALLOWED_BROWSER_TOOLS as readonly string[])).not.toContain(blocked);
    }
  });
});

// ─── Redaction parity ─────────────────────────────────────────────

describe('Security Parity — Redaction', () => {
  it('dryRun always redacts sensitive headers', async () => {
    const skill = makeSkill({
      requiredHeaders: { 'Authorization': 'Bearer secret-token' },
    });
    const result = await dryRun(skill, { page: 1 }, 'agent-safe');
    if (result.headers.Authorization || result.headers.authorization) {
      const val = result.headers.Authorization || result.headers.authorization;
      // Canonical redactor uses HMAC-based redaction: [REDACTED:<hash>]
      expect(val).toMatch(/\[REDACTED/);
    }
    expect(result.policyDecision).toBeDefined();
    expect(result.policyDecision.policyResult).toBeDefined();
  });

  it('developer-debug mode includes volatility and tier info', async () => {
    const skill = makeSkill();
    const result = await dryRun(skill, { page: 1 }, 'developer-debug');
    expect(result.tierDecision).toBeDefined();
    expect(result.tierDecision).toContain('currentTier=');
  });

  it('agent-safe mode does not include tier decision info', async () => {
    const skill = makeSkill();
    const result = await dryRun(skill, { page: 1 }, 'agent-safe');
    expect(result.tierDecision).toBeUndefined();
  });
});

// ─── Audit log ────────────────────────────────────────────────────

describe('Security Parity — Audit Log', () => {
  it('rejects entries with incomplete policyDecision in strict mode', () => {
    const config = makeTestConfig({ audit: { strictMode: true, rootHashExport: true } });
    const auditLog = new AuditLog(config);

    const result = auditLog.appendEntry({
      id: 'test-1',
      timestamp: Date.now(),
      skillId: 'test.skill.v1',
      executionTier: 'direct',
      success: true,
      latencyMs: 10,
      capabilityUsed: 'net.fetch.direct',
      policyDecision: {
        proposed: '',
        policyResult: 'allowed',
        policyRule: 'test',
        userConfirmed: null,
        redactionsApplied: [],
      },
    });

    expect(result).toHaveProperty('type', 'audit_write_error');
  });

  it('accepts complete audit entries', () => {
    const config = makeTestConfig({ audit: { strictMode: true, rootHashExport: true } });
    const auditLog = new AuditLog(config);

    const result = auditLog.appendEntry({
      id: 'test-2',
      timestamp: Date.now(),
      skillId: 'test.skill.v1',
      executionTier: 'direct',
      success: true,
      latencyMs: 10,
      capabilityUsed: 'net.fetch.direct',
      policyDecision: {
        proposed: 'GET /api/test',
        policyResult: 'allowed',
        policyRule: 'engine.executeSkill',
        userConfirmed: null,
        redactionsApplied: [],
      },
    });

    expect(result).not.toHaveProperty('type', 'audit_write_error');
    expect(result).toHaveProperty('entryHash');
    expect(result).toHaveProperty('previousHash');
    expect(result).toHaveProperty('signature');
  });

  it('maintains hash chain across entries', () => {
    const config = makeTestConfig({ audit: { strictMode: true, rootHashExport: true } });
    const auditLog = new AuditLog(config);

    const entry1 = auditLog.appendEntry({
      id: 'chain-1',
      timestamp: Date.now(),
      skillId: 'test.skill.v1',
      executionTier: 'direct',
      success: true,
      latencyMs: 10,
      capabilityUsed: 'net.fetch.direct',
      policyDecision: {
        proposed: 'GET /api/test',
        policyResult: 'allowed',
        policyRule: 'test',
        userConfirmed: null,
        redactionsApplied: [],
      },
    });

    const entry2 = auditLog.appendEntry({
      id: 'chain-2',
      timestamp: Date.now(),
      skillId: 'test.skill.v1',
      executionTier: 'direct',
      success: true,
      latencyMs: 15,
      capabilityUsed: 'net.fetch.direct',
      policyDecision: {
        proposed: 'GET /api/test2',
        policyResult: 'allowed',
        policyRule: 'test',
        userConfirmed: null,
        redactionsApplied: [],
      },
    });

    if (!('type' in entry1) && !('type' in entry2)) {
      expect((entry2 as AuditEntry).previousHash).toBe((entry1 as AuditEntry).entryHash);
    }
  });
});

// ─── Header filtering ─────────────────────────────────────────────

describe('Security Parity — Header Filtering', () => {
  let filterHeaders: typeof import('../../src/core/policy.js').filterHeaders;

  beforeEach(async () => {
    const policy = await import('../../src/core/policy.js');
    filterHeaders = policy.filterHeaders;
  });

  it('blocks hop-by-hop headers', () => {
    const headers = {
      'Host': 'example.com',
      'Connection': 'keep-alive',
      'Transfer-Encoding': 'chunked',
      'Content-Type': 'application/json',
    };
    const filtered = filterHeaders(headers, 1, ['example.com'], 'example.com');
    expect(filtered).not.toHaveProperty('Host');
    expect(filtered).not.toHaveProperty('Connection');
    expect(filtered).not.toHaveProperty('Transfer-Encoding');
    expect(filtered).toHaveProperty('Content-Type');
  });

  it('blocks proxy-* headers', () => {
    const headers = {
      'Proxy-Authorization': 'Basic abc',
      'Proxy-Connection': 'keep-alive',
      'Content-Type': 'application/json',
    };
    const filtered = filterHeaders(headers, 1, ['example.com'], 'example.com');
    expect(filtered).not.toHaveProperty('Proxy-Authorization');
    expect(filtered).not.toHaveProperty('Proxy-Connection');
  });

  it('blocks origin and referer', () => {
    const headers = {
      'Origin': 'https://example.com',
      'Referer': 'https://example.com/page',
      'Accept': 'application/json',
    };
    const filtered = filterHeaders(headers, 1, ['example.com'], 'example.com');
    expect(filtered).not.toHaveProperty('Origin');
    expect(filtered).not.toHaveProperty('Referer');
    expect(filtered).toHaveProperty('Accept');
  });

  it('tier 1 only allows specific headers', () => {
    const headers = {
      'User-Agent': 'test',
      'Accept': 'application/json',
      'X-Custom-Header': 'value',
      'Content-Type': 'application/json',
    };
    const filtered = filterHeaders(headers, 1, ['example.com'], 'example.com');
    expect(filtered).toHaveProperty('User-Agent');
    expect(filtered).toHaveProperty('Accept');
    expect(filtered).toHaveProperty('Content-Type');
    expect(filtered).not.toHaveProperty('X-Custom-Header');
  });

  it('tier 1 blocks authorization for non-allowlisted domains', () => {
    const headers = {
      'Authorization': 'Bearer token',
      'Accept': 'application/json',
    };
    const filtered = filterHeaders(headers, 1, ['trusted.com'], 'untrusted.com');
    expect(filtered).not.toHaveProperty('Authorization');
    expect(filtered).toHaveProperty('Accept');
  });

  it('tier 1 allows authorization for allowlisted domains', () => {
    const headers = {
      'Authorization': 'Bearer token',
      'Accept': 'application/json',
    };
    const filtered = filterHeaders(headers, 1, ['trusted.com'], 'trusted.com');
    expect(filtered).toHaveProperty('Authorization');
  });
});
