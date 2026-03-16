/**
 * v0.2 Acceptance — Security
 *
 * Audit entries for REST execution, redaction on API responses,
 * policy blocks, blocked browser tools via REST.
 */

import { describe, it, expect, vi } from 'vitest';
import { makeTestConfig, makeSkill } from '../helpers.js';
import { AuditLog } from '../../src/replay/audit-log.js';

describe('v0.2 Security — Audit Entries', () => {
  it('AuditLog produces entries with hash chain', () => {
    const config = makeTestConfig();
    const auditLog = new AuditLog(config);

    const entry = auditLog.appendEntry({
      id: 'sec-test-1',
      timestamp: Date.now(),
      skillId: 'site.skill.v1',
      executionTier: 'direct',
      success: true,
      latencyMs: 25,
      capabilityUsed: 'net.fetch.direct',
      policyDecision: {
        proposed: 'GET /api/data',
        policyResult: 'allowed',
        policyRule: 'engine.executeSkill',
        userConfirmed: null,
        redactionsApplied: [],
      },
    });

    expect(entry).not.toHaveProperty('type', 'audit_write_error');
    expect(entry).toHaveProperty('entryHash');
    expect(entry).toHaveProperty('signature');
    expect((entry as any).entryHash.length).toBe(64);
  });

  it('audit chain can be verified', () => {
    const config = makeTestConfig();
    const auditLog = new AuditLog(config);

    // Add two entries to create a chain
    auditLog.appendEntry({
      id: 'verify-1',
      timestamp: Date.now(),
      skillId: 'site.skill.v1',
      executionTier: 'direct',
      success: true,
      latencyMs: 10,
      capabilityUsed: 'net.fetch.direct',
      policyDecision: {
        proposed: 'GET /api/a',
        policyResult: 'allowed',
        policyRule: 'test',
        userConfirmed: null,
        redactionsApplied: [],
      },
    });

    auditLog.appendEntry({
      id: 'verify-2',
      timestamp: Date.now(),
      skillId: 'site.skill.v1',
      executionTier: 'direct',
      success: true,
      latencyMs: 15,
      capabilityUsed: 'net.fetch.direct',
      policyDecision: {
        proposed: 'GET /api/b',
        policyResult: 'allowed',
        policyRule: 'test',
        userConfirmed: null,
        redactionsApplied: [],
      },
    });

    const verification = auditLog.verifyChain();
    expect(verification.valid).toBe(true);
    expect(verification.totalEntries).toBe(2);
  });

  it('strict mode rejects incomplete policyDecision', () => {
    const config = makeTestConfig({ audit: { strictMode: true, rootHashExport: true } });
    const auditLog = new AuditLog(config);

    const result = auditLog.appendEntry({
      id: 'strict-1',
      timestamp: Date.now(),
      skillId: 'site.skill.v1',
      executionTier: 'direct',
      success: true,
      latencyMs: 10,
      capabilityUsed: 'net.fetch.direct',
      policyDecision: {
        proposed: '',  // empty = invalid
        policyResult: 'allowed',
        policyRule: 'test',
        userConfirmed: null,
        redactionsApplied: [],
      },
    });

    expect(result).toHaveProperty('type', 'audit_write_error');
    expect((result as any).message).toContain('proposed');
  });
});

describe('v0.2 Security — Redaction on API Responses', () => {
  it('redactString handles PII patterns', async () => {
    const { redactString } = await import('../../src/storage/redactor.js');
    const email = 'user@example.com';
    const result = await redactString(email);
    expect(result).toContain('[REDACTED:');
    expect(result).not.toContain(email);
  });

  it('redactString preserves safe values', async () => {
    const { redactString } = await import('../../src/storage/redactor.js');
    expect(await redactString('true')).toBe('true');
    expect(await redactString('42')).toBe('42');
    expect(await redactString('active')).toBe('active');
  });

  it('redactHeaders redacts sensitive headers', async () => {
    const { redactHeaders } = await import('../../src/storage/redactor.js');
    const headers = {
      'Authorization': 'Bearer eyJabc123',
      'Content-Type': 'application/json',
      'X-API-Key': 'secret-key-12345',
    };
    const result = await redactHeaders(headers);
    expect(result['Authorization']).toContain('[REDACTED:');
    expect(result['X-API-Key']).toContain('[REDACTED:');
    // Content-Type is not sensitive
    expect(result['Content-Type']).toBe('application/json');
  });

  it('redactBody handles JSON body', async () => {
    const { redactBody } = await import('../../src/storage/redactor.js');
    const body = JSON.stringify({
      username: 'testuser',
      email: 'test@example.com',
      age: 25,
    });
    const result = await redactBody(body);
    expect(result).toBeDefined();
    const parsed = JSON.parse(result!);
    // email should be redacted (PII)
    expect(parsed.email).toContain('[REDACTED:');
    // age (number) is preserved
    expect(parsed.age).toBe(25);
  });

  it('redactForOutput agent-safe mode redacts PII', async () => {
    const { redactForOutput } = await import('../../src/storage/redactor.js');
    const data = {
      user: 'test@example.com',
      count: 5,
      active: true,
    };
    const result = await redactForOutput(data, 'agent-safe');
    expect((result as any).user).toContain('[REDACTED:');
    expect((result as any).count).toBe(5);
    expect((result as any).active).toBe(true);
  });

  it('redactForOutput developer-debug includes PII type annotation', async () => {
    const { redactForOutput } = await import('../../src/storage/redactor.js');
    const email = 'user@example.com';
    const result = await redactForOutput(email, 'developer-debug');
    expect(typeof result).toBe('string');
    expect(result as string).toContain('[was:email]');
  });
});

describe('v0.2 Security — Policy Blocks', () => {
  it('checkPathRisk blocks destructive GET paths', async () => {
    const { checkPathRisk } = await import('../../src/core/policy.js');

    expect(checkPathRisk('GET', '/api/logout').blocked).toBe(true);
    expect(checkPathRisk('GET', '/api/delete/123').blocked).toBe(true);
    expect(checkPathRisk('GET', '/api/destroy').blocked).toBe(true);
    expect(checkPathRisk('GET', '/api/unsubscribe').blocked).toBe(true);
  });

  it('checkPathRisk blocks destructive POST paths', async () => {
    const { checkPathRisk } = await import('../../src/core/policy.js');

    expect(checkPathRisk('POST', '/api/payment').blocked).toBe(true);
    expect(checkPathRisk('POST', '/api/charge').blocked).toBe(true);
    expect(checkPathRisk('POST', '/api/order').blocked).toBe(true);
  });

  it('checkCapability blocks disabled capabilities', async () => {
    const { checkCapability } = await import('../../src/core/policy.js');

    const result = checkCapability('any-site', 'export.skills');
    expect(result.allowed).toBe(false);
    expect(result.rule).toBe('capability.disabled_by_default');
  });

  it('checkMethodAllowed blocks DELETE by default', async () => {
    const { checkMethodAllowed } = await import('../../src/core/policy.js');

    expect(checkMethodAllowed('any-site', 'DELETE')).toBe(false);
    expect(checkMethodAllowed('any-site', 'PUT')).toBe(false);
    expect(checkMethodAllowed('any-site', 'PATCH')).toBe(false);
  });
});

describe('v0.2 Security — Blocked Browser Tools', () => {
  it('BLOCKED_BROWSER_TOOLS contains dangerous tools', async () => {
    const { BLOCKED_BROWSER_TOOLS } = await import('../../src/skill/types.js');

    expect(BLOCKED_BROWSER_TOOLS).toContain('browser_evaluate');
    expect(BLOCKED_BROWSER_TOOLS).toContain('browser_run_code');
    expect(BLOCKED_BROWSER_TOOLS).toContain('browser_install');
  });

  it('ALLOWED and BLOCKED have no overlap', async () => {
    const { ALLOWED_BROWSER_TOOLS, BLOCKED_BROWSER_TOOLS } = await import('../../src/skill/types.js');

    for (const blocked of BLOCKED_BROWSER_TOOLS) {
      expect((ALLOWED_BROWSER_TOOLS as readonly string[]).includes(blocked)).toBe(false);
    }
  });

  it('ALLOWED_BROWSER_TOOLS includes expected safe tools', async () => {
    const { ALLOWED_BROWSER_TOOLS } = await import('../../src/skill/types.js');

    const expected = [
      'browser_navigate', 'browser_snapshot', 'browser_click',
      'browser_type', 'browser_take_screenshot', 'browser_close',
    ];
    for (const name of expected) {
      expect((ALLOWED_BROWSER_TOOLS as readonly string[]).includes(name)).toBe(true);
    }
  });
});

describe('v0.2 Security — Private Network Blocking', () => {
  it('blocks access to private IPs', async () => {
    const { isPublicIp } = await import('../../src/core/policy.js');

    expect(isPublicIp('127.0.0.1')).toBe(false);
    expect(isPublicIp('10.0.0.1')).toBe(false);
    expect(isPublicIp('192.168.1.1')).toBe(false);
    expect(isPublicIp('172.16.0.1')).toBe(false);
    expect(isPublicIp('0.0.0.0')).toBe(false);
  });

  it('allows public IPs', async () => {
    const { isPublicIp } = await import('../../src/core/policy.js');

    expect(isPublicIp('8.8.8.8')).toBe(true);
    expect(isPublicIp('1.1.1.1')).toBe(true);
    expect(isPublicIp('93.184.216.34')).toBe(true);
  });
});
