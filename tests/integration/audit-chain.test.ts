import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { AuditLog } from '../../src/replay/audit-log.js';
import type { SchruteConfig, PolicyDecision, AuditEntry } from '../../src/skill/types.js';

function makeConfig(dataDir: string): SchruteConfig {
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
  } as SchruteConfig;
}

function makePolicyDecision(): PolicyDecision {
  return {
    proposed: 'GET /api/users',
    policyResult: 'allowed',
    policyRule: 'default.allow',
    userConfirmed: null,
    redactionsApplied: [],
  };
}

function makeEntryData(skillId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `entry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    skillId,
    executionTier: 'direct' as const,
    success: true,
    latencyMs: 45,
    capabilityUsed: 'net.fetch.direct' as const,
    policyDecision: makePolicyDecision(),
    requestSummary: { method: 'GET', url: '/api/users' },
    responseSummary: { status: 200, schemaMatch: true },
    ...overrides,
  };
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'schrute-audit-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('audit chain integration', () => {
  it('creates audit entries with linked hash chain', () => {
    const config = makeConfig(tempDir);
    const auditLog = new AuditLog(config);

    const entry1 = auditLog.appendEntry(makeEntryData('skill1'));
    expect('entryHash' in entry1).toBe(true);
    const e1 = entry1 as AuditEntry;
    // First entry's previousHash should be all zeros
    expect(e1.previousHash).toBe('0'.repeat(64));
    expect(e1.entryHash).toBeTruthy();

    const entry2 = auditLog.appendEntry(makeEntryData('skill2'));
    const e2 = entry2 as AuditEntry;
    // Second entry's previousHash should link to first entry's hash
    expect(e2.previousHash).toBe(e1.entryHash);

    const entry3 = auditLog.appendEntry(makeEntryData('skill3'));
    const e3 = entry3 as AuditEntry;
    expect(e3.previousHash).toBe(e2.entryHash);
  });

  it('verifies an intact hash chain', () => {
    const config = makeConfig(tempDir);
    const auditLog = new AuditLog(config);

    // Create 5 entries
    for (let i = 0; i < 5; i++) {
      auditLog.appendEntry(makeEntryData(`skill-${i}`));
    }

    const verification = auditLog.verifyChain();
    expect(verification.valid).toBe(true);
    expect(verification.totalEntries).toBe(5);
    expect(verification.brokenAt).toBeUndefined();
  });

  it('detects tampered entry in the chain', () => {
    const config = makeConfig(tempDir);
    const auditLog = new AuditLog(config);

    // Create 3 entries
    for (let i = 0; i < 3; i++) {
      auditLog.appendEntry(makeEntryData(`skill-${i}`));
    }

    // Verify chain is valid before tampering
    let verification = auditLog.verifyChain();
    expect(verification.valid).toBe(true);

    // Tamper with the audit file: modify the second entry's latencyMs
    const auditFilePath = join(tempDir, 'audit', 'audit.jsonl');
    const content = readFileSync(auditFilePath, 'utf-8').trim();
    const lines = content.split('\n');

    // Parse and modify the second entry
    const entry2 = JSON.parse(lines[1]) as AuditEntry;
    entry2.latencyMs = 99999; // tamper the data
    lines[1] = JSON.stringify(entry2);

    // Write back the tampered file
    writeFileSync(auditFilePath, lines.join('\n') + '\n', 'utf-8');

    // Create a new AuditLog instance to reload from disk
    const auditLog2 = new AuditLog(config);
    verification = auditLog2.verifyChain();

    expect(verification.valid).toBe(false);
    // The tampered entry should be detected at index 1
    expect(verification.brokenAt).toBe(1);
    expect(verification.message).toContain('hash mismatch');
  });

  it('detects broken chain links when previousHash is modified', () => {
    const config = makeConfig(tempDir);
    const auditLog = new AuditLog(config);

    // Create 3 entries
    for (let i = 0; i < 3; i++) {
      auditLog.appendEntry(makeEntryData(`skill-${i}`));
    }

    // Tamper: change the previousHash of the third entry
    const auditFilePath = join(tempDir, 'audit', 'audit.jsonl');
    const content = readFileSync(auditFilePath, 'utf-8').trim();
    const lines = content.split('\n');

    const entry3 = JSON.parse(lines[2]) as AuditEntry;
    entry3.previousHash = 'a'.repeat(64); // wrong previousHash
    // Recompute entryHash with the tampered previousHash
    const hashPayload = JSON.stringify({
      ...entry3,
      entryHash: undefined,
      signature: undefined,
    });
    entry3.entryHash = createHash('sha256').update(hashPayload).digest('hex');
    lines[2] = JSON.stringify(entry3);

    writeFileSync(auditFilePath, lines.join('\n') + '\n', 'utf-8');

    const auditLog2 = new AuditLog(config);
    const verification = auditLog2.verifyChain();

    expect(verification.valid).toBe(false);
    expect(verification.brokenAt).toBe(2);
    expect(verification.message).toContain('Chain broken');
  });

  it('handles empty audit log gracefully', () => {
    const config = makeConfig(tempDir);
    const auditLog = new AuditLog(config);

    const verification = auditLog.verifyChain();
    expect(verification.valid).toBe(true);
    expect(verification.totalEntries).toBe(0);
  });

  it('each entry has a valid HMAC signature', () => {
    const config = makeConfig(tempDir);
    const auditLog = new AuditLog(config);

    const entry = auditLog.appendEntry(makeEntryData('skill-sig-test'));
    const e = entry as AuditEntry;

    expect(e.signature).toBeTruthy();
    // Signature should be a hex string
    expect(e.signature).toMatch(/^[0-9a-f]{64}$/);

    // Verify the chain passes (which includes signature verification)
    const verification = auditLog.verifyChain();
    expect(verification.valid).toBe(true);
  });
});
