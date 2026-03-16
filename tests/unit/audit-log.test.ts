import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuditLog } from '../../src/replay/audit-log.js';
import type { SchruteConfig, AuditEntry, PolicyDecision } from '../../src/skill/types.js';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeConfig(dataDir: string, strictMode = true): SchruteConfig {
  return {
    dataDir,
    logLevel: 'silent',
    features: { webmcp: false, httpTransport: false },
    toolBudget: {
      maxToolCallsPerTask: 50,
      maxConcurrentCalls: 3,
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
    audit: { strictMode, rootHashExport: true },
    storage: { maxPerSiteMb: 500, maxGlobalMb: 5000, retentionDays: 90 },
    server: { network: false },
    daemon: { port: 19420, autoStart: false },
    tempTtlMs: 3600000,
    gcIntervalMs: 900000,
    confirmationTimeoutMs: 30000,
    confirmationExpiryMs: 60000,
    promotionConsecutivePasses: 5,
    promotionVolatilityThreshold: 0.2,
    maxToolsPerSite: 20,
    toolShortlistK: 10,
  } as SchruteConfig;
}

function makeValidEntry(): Omit<AuditEntry, 'previousHash' | 'entryHash' | 'signature'> {
  return {
    id: randomUUID(),
    timestamp: Date.now(),
    skillId: 'test.skill.v1',
    executionTier: 'direct',
    success: true,
    latencyMs: 42,
    capabilityUsed: 'net.fetch.direct',
    policyDecision: {
      proposed: 'GET https://api.example.com/data',
      policyResult: 'allowed',
      policyRule: 'domain.allowlisted',
      userConfirmed: null,
      redactionsApplied: ['email'],
    },
  };
}

describe('audit-log', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'schrute-audit-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('appendEntry', () => {
    it('appends entries with hash chain', () => {
      const log = new AuditLog(makeConfig(tempDir));
      const entry1 = log.appendEntry(makeValidEntry());
      const entry2 = log.appendEntry(makeValidEntry());

      expect(entry1).not.toHaveProperty('type', 'audit_write_error');
      expect(entry2).not.toHaveProperty('type', 'audit_write_error');

      const e1 = entry1 as AuditEntry;
      const e2 = entry2 as AuditEntry;

      expect(e1.entryHash).toBeTruthy();
      expect(e2.previousHash).toBe(e1.entryHash);
    });

    it('rejects partial entries (missing policyDecision fields) in strict mode', () => {
      const log = new AuditLog(makeConfig(tempDir, true));
      const entry = makeValidEntry();
      // Remove required policyDecision field
      (entry.policyDecision as Partial<PolicyDecision>).proposed = '';

      const result = log.appendEntry(entry);
      expect(result).toHaveProperty('type', 'audit_write_error');
    });
  });

  describe('hash chain verification', () => {
    it('hash chain is verifiable', () => {
      const log = new AuditLog(makeConfig(tempDir));
      log.appendEntry(makeValidEntry());
      log.appendEntry(makeValidEntry());
      log.appendEntry(makeValidEntry());

      const verification = log.verifyChain();
      expect(verification.valid).toBe(true);
      expect(verification.totalEntries).toBe(3);
    });

    it('detects chain tampering', () => {
      const log = new AuditLog(makeConfig(tempDir));
      log.appendEntry(makeValidEntry());
      log.appendEntry(makeValidEntry());

      // Tamper with the audit file
      const auditPath = join(tempDir, 'audit', 'audit.jsonl');
      const content = readFileSync(auditPath, 'utf-8');
      const lines = content.trim().split('\n');
      const tampered = JSON.parse(lines[0]);
      tampered.skillId = 'tampered.skill';
      lines[0] = JSON.stringify(tampered);
      writeFileSync(auditPath, lines.join('\n') + '\n', 'utf-8');

      // Create a new log instance that reads from the tampered file
      const log2 = new AuditLog(makeConfig(tempDir));
      const verification = log2.verifyChain();
      expect(verification.valid).toBe(false);
    });
  });

  describe('strict mode', () => {
    it('strict mode blocks on write failure for incomplete policyDecision', () => {
      const log = new AuditLog(makeConfig(tempDir, true));
      const entry = makeValidEntry();
      (entry.policyDecision as Partial<PolicyDecision>).policyRule = '';

      const result = log.appendEntry(entry);
      expect(result).toHaveProperty('type', 'audit_write_error');
      expect((result as any).message).toContain('policyRule');
    });

    it('non-strict mode allows incomplete policyDecision with warning', () => {
      const log = new AuditLog(makeConfig(tempDir, false));
      const entry = makeValidEntry();
      (entry.policyDecision as Partial<PolicyDecision>).policyRule = '';

      const result = log.appendEntry(entry);
      // In non-strict mode, the entry is still written (not an error)
      expect(result).not.toHaveProperty('type', 'audit_write_error');
    });
  });

  describe('entry counting', () => {
    it('tracks entry count', () => {
      const log = new AuditLog(makeConfig(tempDir));
      expect(log.getEntryCount()).toBe(0);
      log.appendEntry(makeValidEntry());
      expect(log.getEntryCount()).toBe(1);
      log.appendEntry(makeValidEntry());
      expect(log.getEntryCount()).toBe(2);
    });
  });
});
