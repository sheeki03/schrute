import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isPublicIp } from '../../src/core/policy.js';
import { redactString, redactHeaders, redactBody } from '../../src/storage/redactor.js';
import { BLOCKED_BROWSER_TOOLS, ALLOWED_BROWSER_TOOLS } from '../../src/skill/types.js';
import { ToolBudgetTracker } from '../../src/replay/tool-budget.js';
import { AuditLog } from '../../src/replay/audit-log.js';
import type { OneAgentConfig, ExecutionTierName, CapabilityName } from '../../src/skill/types.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

function makeTestConfig(overrides?: Partial<OneAgentConfig>): OneAgentConfig {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oneagent-sec-'));
  const base: OneAgentConfig = {
    dataDir: tmpDir,
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
    daemon: { port: 19420, autoStart: false },
    audit: { strictMode: true, rootHashExport: false },
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
  return { ...base, ...overrides };
}

describe('Security Invariants', () => {
  let tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  // ─── Private IP Blocking ─────────────────────────────────────────

  describe('Private IP Blocking', () => {
    it('should block all RFC1918 private IPs', () => {
      // 10.0.0.0/8
      expect(isPublicIp('10.0.0.1')).toBe(false);
      expect(isPublicIp('10.255.255.255')).toBe(false);

      // 172.16.0.0/12
      expect(isPublicIp('172.16.0.1')).toBe(false);
      expect(isPublicIp('172.31.255.255')).toBe(false);

      // 192.168.0.0/16
      expect(isPublicIp('192.168.1.1')).toBe(false);
      expect(isPublicIp('192.168.255.255')).toBe(false);
    });

    it('should block loopback addresses', () => {
      expect(isPublicIp('127.0.0.1')).toBe(false);
      expect(isPublicIp('127.255.255.255')).toBe(false);
      expect(isPublicIp('::1')).toBe(false);
    });

    it('should allow legitimate public IPs', () => {
      expect(isPublicIp('8.8.8.8')).toBe(true);
      expect(isPublicIp('1.1.1.1')).toBe(true);
      expect(isPublicIp('93.184.216.34')).toBe(true);
    });

    it('should block link-local and special addresses', () => {
      expect(isPublicIp('169.254.1.1')).toBe(false); // link-local
      expect(isPublicIp('0.0.0.0')).toBe(false); // unspecified
    });
  });

  // ─── PII Redaction ───────────────────────────────────────────────

  describe('Redaction Coverage', () => {
    it('should redact email addresses', async () => {
      const input = 'Contact alice@example.com for details';
      const result = await redactString(input);
      expect(result).not.toContain('alice@example.com');
      expect(result).toMatch(/\[REDACTED:[a-f0-9]+\]/);
    });

    it('should redact JWT tokens', async () => {
      const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const result = await redactString(jwt);
      expect(result).not.toContain('eyJhbGciOi');
    });

    it('should redact sensitive headers', async () => {
      const headers = {
        'Authorization': 'Bearer secret-token-12345',
        'Cookie': 'session=abc123def456',
        'Content-Type': 'application/json',
        'X-Api-Key': 'sk-live-1234567890abcdef',
      };

      const redacted = await redactHeaders(headers);

      // Authorization and Cookie should be redacted
      expect(redacted['Authorization']).not.toBe(headers['Authorization']);
      expect(redacted['Authorization']).toMatch(/\[REDACTED:[a-f0-9]+\]/);
      expect(redacted['Cookie']).not.toBe(headers['Cookie']);
      expect(redacted['Cookie']).toMatch(/\[REDACTED:[a-f0-9]+\]/);
      expect(redacted['X-Api-Key']).not.toBe(headers['X-Api-Key']);

      // Content-Type should be unchanged (safe value)
      expect(redacted['Content-Type']).toBe('application/json');
    });

    it('should redact PII from JSON bodies', async () => {
      const body = JSON.stringify({
        name: 'Alice Johnson',
        email: 'alice@example.com',
        phone: '555-123-4567',
        role: 'admin',
      });

      const redacted = await redactBody(body);
      expect(redacted).toBeDefined();

      const parsed = JSON.parse(redacted!);
      // Email should be redacted
      expect(parsed.email).toMatch(/\[REDACTED:[a-f0-9]+\]/);
      // Role is a safe value (short enum-like string)
      expect(parsed.role).toBe('admin');
    });

    it('should preserve safe values during redaction', async () => {
      expect(await redactString('true')).toBe('true');
      expect(await redactString('false')).toBe('false');
      expect(await redactString('null')).toBe('null');
      expect(await redactString('42')).toBe('42');
      expect(await redactString('admin')).toBe('admin');
    });
  });

  // ─── Sealed evaluateFetch ─────────────────────────────────────────

  describe('Sealed evaluateFetch (Browser Tool Blocking)', () => {
    it('should block browser_evaluate and browser_run_code', () => {
      expect(BLOCKED_BROWSER_TOOLS).toContain('browser_evaluate');
      expect(BLOCKED_BROWSER_TOOLS).toContain('browser_run_code');
    });

    it('should block browser_install', () => {
      expect(BLOCKED_BROWSER_TOOLS).toContain('browser_install');
    });

    it('should ensure blocked tools are not in the allowed list', () => {
      for (const blocked of BLOCKED_BROWSER_TOOLS) {
        expect(
          (ALLOWED_BROWSER_TOOLS as readonly string[]).includes(blocked),
        ).toBe(false);
      }
    });
  });

  // ─── Tool Budget Enforcement ───────────────────────────────────────

  describe('Tool Budget Enforcement', () => {
    it('should enforce max tool calls per task', () => {
      const config = makeTestConfig();
      tmpDirs.push(config.dataDir);
      config.toolBudget.maxToolCallsPerTask = 3;
      const tracker = new ToolBudgetTracker(config);

      // First 3 calls should be allowed
      for (let i = 0; i < 3; i++) {
        const check = tracker.checkBudget(`skill-${i}`, 'site-a');
        expect(check.allowed).toBe(true);
        tracker.recordCall(`skill-${i}`, 'site-a');
        tracker.releaseCall('site-a');
      }

      // 4th call should be blocked
      const blocked = tracker.checkBudget('skill-3', 'site-a');
      expect(blocked.allowed).toBe(false);
      expect(blocked.reason).toContain('Max tool calls per task exceeded');
    });

    it('should enforce max concurrent calls', () => {
      const config = makeTestConfig();
      tmpDirs.push(config.dataDir);
      config.toolBudget.maxConcurrentCalls = 2;
      const tracker = new ToolBudgetTracker(config);

      // Record 2 concurrent calls (without releasing)
      tracker.recordCall('skill-1', 'site-a');
      tracker.recordCall('skill-2', 'site-b');

      // 3rd concurrent should be blocked
      const blocked = tracker.checkBudget('skill-3', 'site-c');
      expect(blocked.allowed).toBe(false);
      expect(blocked.reason).toContain('Max concurrent calls exceeded');

      // Release one, then it should work
      tracker.releaseCall('site-a');
      const allowed = tracker.checkBudget('skill-3', 'site-c');
      expect(allowed.allowed).toBe(true);
    });

    it('should hard-deny secrets to non-allowlisted domains', () => {
      const config = makeTestConfig();
      tmpDirs.push(config.dataDir);
      // Enable cross-domain calls so the cross-domain check doesn't block first
      config.toolBudget.crossDomainCalls = true;
      const tracker = new ToolBudgetTracker(config);
      tracker.setDomainAllowlist(['api.example.com']);

      // Secrets to allowlisted domain: OK
      const allowed = tracker.checkBudget('skill-1', 'example.com', {
        targetDomain: 'api.example.com',
        hasSecrets: true,
      });
      expect(allowed.allowed).toBe(true);

      // Secrets to non-allowlisted domain: HARD DENY
      const denied = tracker.checkBudget('skill-2', 'example.com', {
        targetDomain: 'evil.com',
        hasSecrets: true,
      });
      expect(denied.allowed).toBe(false);
      expect(denied.reason).toContain('HARD DENY');
    });
  });

  // ─── Audit Tamper Detection ────────────────────────────────────────

  describe('Audit Tamper Detection', () => {
    it('should build a valid audit chain', () => {
      const config = makeTestConfig();
      tmpDirs.push(config.dataDir);
      const auditLog = new AuditLog(config);

      // Append 3 entries
      for (let i = 0; i < 3; i++) {
        const result = auditLog.appendEntry({
          id: `entry-${i}`,
          timestamp: Date.now(),
          skillId: 'test-skill',
          executionTier: 'direct' as ExecutionTierName,
          success: true,
          latencyMs: 50,
          capabilityUsed: 'net.fetch.direct' as CapabilityName,
          policyDecision: {
            proposed: 'GET /api/test',
            policyResult: 'allowed',
            policyRule: 'test.rule',
            userConfirmed: null,
            redactionsApplied: [],
          },
        });

        // Should not be an error
        expect('type' in result && (result as { type: string }).type === 'audit_write_error').toBe(false);
      }

      // Verify the chain is valid
      const verification = auditLog.verifyChain();
      expect(verification.valid).toBe(true);
      expect(verification.totalEntries).toBe(3);
    });

    it('should detect tampered audit entries', () => {
      const config = makeTestConfig();
      tmpDirs.push(config.dataDir);
      const auditLog = new AuditLog(config);

      // Append 2 valid entries
      for (let i = 0; i < 2; i++) {
        auditLog.appendEntry({
          id: `entry-${i}`,
          timestamp: Date.now(),
          skillId: 'test-skill',
          executionTier: 'direct' as ExecutionTierName,
          success: true,
          latencyMs: 50,
          capabilityUsed: 'net.fetch.direct' as CapabilityName,
          policyDecision: {
            proposed: 'GET /api/test',
            policyResult: 'allowed',
            policyRule: 'test.rule',
            userConfirmed: null,
            redactionsApplied: [],
          },
        });
      }

      // Tamper with the audit file: change a field in the first entry
      const auditFilePath = path.join(config.dataDir, 'audit', 'audit.jsonl');
      const content = fs.readFileSync(auditFilePath, 'utf-8');
      const lines = content.trim().split('\n');

      // Parse and modify the first entry
      const firstEntry = JSON.parse(lines[0]);
      firstEntry.success = false; // Tamper!
      lines[0] = JSON.stringify(firstEntry);
      fs.writeFileSync(auditFilePath, lines.join('\n') + '\n', 'utf-8');

      // Create a new AuditLog to re-read the file
      const verifier = new AuditLog(config);
      const verification = verifier.verifyChain();

      expect(verification.valid).toBe(false);
      expect(verification.brokenAt).toBe(0);
      expect(verification.message).toContain('hash mismatch');
    });

    it('should detect broken hash chain', () => {
      const config = makeTestConfig();
      tmpDirs.push(config.dataDir);
      const auditLog = new AuditLog(config);

      // Append 3 valid entries
      for (let i = 0; i < 3; i++) {
        auditLog.appendEntry({
          id: `entry-${i}`,
          timestamp: Date.now(),
          skillId: 'test-skill',
          executionTier: 'direct' as ExecutionTierName,
          success: true,
          latencyMs: 50,
          capabilityUsed: 'net.fetch.direct' as CapabilityName,
          policyDecision: {
            proposed: 'GET /api/test',
            policyResult: 'allowed',
            policyRule: 'test.rule',
            userConfirmed: null,
            redactionsApplied: [],
          },
        });
      }

      // Remove the second entry (breaks the chain)
      const auditFilePath = path.join(config.dataDir, 'audit', 'audit.jsonl');
      const content = fs.readFileSync(auditFilePath, 'utf-8');
      const lines = content.trim().split('\n');
      // Remove middle entry
      const tampered = [lines[0], lines[2]].join('\n') + '\n';
      fs.writeFileSync(auditFilePath, tampered, 'utf-8');

      const verifier = new AuditLog(config);
      const verification = verifier.verifyChain();

      expect(verification.valid).toBe(false);
      expect(verification.brokenAt).toBe(1); // Chain breaks at second entry
    });
  });
});
