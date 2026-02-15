import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { getLogger } from '../core/logger.js';
import { retrieve, store } from '../storage/secrets.js';
import type { AuditEntry, PolicyDecision, OneAgentConfig } from '../skill/types.js';
import { AuditEntrySchema } from '../skill/types.js';

const log = getLogger();

const AUDIT_HMAC_KEY_NAME = 'oneagent-audit-hmac-key';

// ─── Types ──────────────────────────────────────────────────────

export interface AuditWriteError {
  type: 'audit_write_error';
  message: string;
  entry: Partial<AuditEntry>;
}

export interface ChainVerification {
  valid: boolean;
  brokenAt?: number;
  totalEntries: number;
  message?: string;
}

// ─── Audit Log ──────────────────────────────────────────────────

export class AuditLog {
  private auditFilePath: string;
  private rootHashDir: string;
  private strictMode: boolean;
  private hmacKey: string;
  private lastHash: string = '';
  private entryCount: number = 0;

  constructor(config: OneAgentConfig) {
    this.auditFilePath = join(config.dataDir, 'audit', 'audit.jsonl');
    this.rootHashDir = join(config.dataDir, 'audit', 'roots');
    this.strictMode = config.audit.strictMode;
    // Fallback key: stronger derivation using dataDir + hostname; replaced by keychain key after initHmacKey()
    this.hmacKey = createHash('sha256').update(`oneagent-audit:${config.dataDir}:${hostname()}`).digest('hex');

    this.ensureDirs();
    this.loadLastHash();
  }

  /**
   * Initialise the HMAC key from the OS keychain.
   * Must be called after construction (async).
   *  1. Try to retrieve 'oneagent-audit-hmac-key' from keychain.
   *  2. If not found, generate a random 32-byte key and store it.
   *  3. If the keychain is locked / unavailable, keep the derived fallback key and log a warning.
   */
  async initHmacKey(): Promise<void> {
    try {
      const existing = await retrieve(AUDIT_HMAC_KEY_NAME);
      if (existing) {
        this.hmacKey = existing;
        return;
      }

      // Generate and persist a new random key
      const newKey = randomBytes(32).toString('hex');
      await store(AUDIT_HMAC_KEY_NAME, newKey);
      this.hmacKey = newKey;
    } catch (err) {
      log.warn(
        { err },
        'OS keychain unavailable for audit HMAC key — falling back to derived key',
      );
      // this.hmacKey already holds the derived fallback from the constructor
    }
  }

  appendEntry(
    entry: Omit<AuditEntry, 'previousHash' | 'entryHash' | 'signature'>,
  ): AuditEntry | AuditWriteError {
    // Validate policyDecision completeness — partial entries REJECTED at write time
    const pdValid = validatePolicyDecision(entry.policyDecision);
    if (!pdValid.valid) {
      const error: AuditWriteError = {
        type: 'audit_write_error',
        message: `Incomplete policyDecision: ${pdValid.reason}`,
        entry,
      };
      if (this.strictMode) {
        log.error({ error }, 'Audit write rejected: incomplete policyDecision');
        return error;
      }
      log.warn({ error }, 'Audit policyDecision incomplete (non-strict mode)');
    }

    // Build full entry with hash chain
    const previousHash = this.lastHash || '0'.repeat(64);
    const entryWithHashes: AuditEntry = {
      ...entry,
      previousHash,
      entryHash: '',
      signature: undefined,
    };

    // Compute entry hash: SHA-256 of the entry content (excluding entryHash and signature)
    const hashPayload = JSON.stringify({
      ...entryWithHashes,
      entryHash: undefined,
      signature: undefined,
    });
    const entryHash = createHash('sha256').update(hashPayload).digest('hex');
    entryWithHashes.entryHash = entryHash;

    // Sign with HMAC-SHA256 (covers entryHash + previousHash to prevent reordering)
    const signature = createHmac('sha256', this.hmacKey)
      .update(`${previousHash}:${entryHash}`)
      .digest('hex');
    entryWithHashes.signature = signature;

    // Schema validate the complete entry
    const parseResult = AuditEntrySchema.safeParse(entryWithHashes);
    if (!parseResult.success) {
      const error: AuditWriteError = {
        type: 'audit_write_error',
        message: `Schema validation failed: ${parseResult.error.issues.map((i) => i.message).join('; ')}`,
        entry: entryWithHashes,
      };
      if (this.strictMode) {
        log.error({ error }, 'Audit write rejected: schema validation failed');
        return error;
      }
      log.warn({ error }, 'Audit schema validation failed (non-strict mode)');
    }

    // Write to JSONL file
    try {
      appendFileSync(this.auditFilePath, JSON.stringify(entryWithHashes) + '\n', 'utf-8');
      this.lastHash = entryHash;
      this.entryCount++;
    } catch (err) {
      const error: AuditWriteError = {
        type: 'audit_write_error',
        message: `File write failed: ${String(err)}`,
        entry: entryWithHashes,
      };
      if (this.strictMode) {
        log.error({ err }, 'Audit write failed (strict mode blocks execution)');
        return error;
      }
      log.warn({ err }, 'Audit write failed (non-strict mode, execution continues)');
    }

    return entryWithHashes;
  }

  verifyChain(): ChainVerification {
    if (!existsSync(this.auditFilePath)) {
      return { valid: true, brokenAt: undefined, totalEntries: 0, message: 'No audit file found' };
    }

    const content = readFileSync(this.auditFilePath, 'utf-8').trim();
    if (!content) {
      return { valid: true, brokenAt: undefined, totalEntries: 0, message: 'Empty audit file' };
    }

    const lines = content.split('\n');
    let expectedPreviousHash = '0'.repeat(64);
    let index = 0;

    for (const line of lines) {
      let entry: AuditEntry;
      try {
        entry = JSON.parse(line) as AuditEntry;
      } catch {
        return {
          valid: false,
          brokenAt: index,
          totalEntries: lines.length,
          message: `Failed to parse entry at line ${index}`,
        };
      }

      // Verify previousHash chain
      if (entry.previousHash !== expectedPreviousHash) {
        return {
          valid: false,
          brokenAt: index,
          totalEntries: lines.length,
          message: `Chain broken at entry ${index}: expected previousHash ${expectedPreviousHash}, got ${entry.previousHash}`,
        };
      }

      // Verify entryHash
      const recomputePayload = JSON.stringify({
        ...entry,
        entryHash: undefined,
        signature: undefined,
      });
      const recomputedHash = createHash('sha256').update(recomputePayload).digest('hex');
      if (entry.entryHash !== recomputedHash) {
        return {
          valid: false,
          brokenAt: index,
          totalEntries: lines.length,
          message: `Entry hash mismatch at entry ${index}`,
        };
      }

      // Verify HMAC signature (covers previousHash + entryHash to prevent reordering)
      // Uses timing-safe comparison to prevent timing side-channel attacks (CR-08).
      if (entry.signature) {
        const expectedSig = createHmac('sha256', this.hmacKey)
          .update(`${entry.previousHash}:${entry.entryHash}`)
          .digest('hex');
        const expectedBuf = Buffer.from(expectedSig, 'hex');
        const actualBuf = Buffer.from(entry.signature, 'hex');
        if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
          return {
            valid: false,
            brokenAt: index,
            totalEntries: lines.length,
            message: `Signature mismatch at entry ${index}`,
          };
        }
      }

      expectedPreviousHash = entry.entryHash;
      index++;
    }

    return { valid: true, brokenAt: undefined, totalEntries: lines.length };
  }

  exportRootHash(): string | null {
    const today = new Date().toISOString().split('T')[0];
    const rootHashPath = join(this.rootHashDir, `${today}.hash`);

    const chainResult = this.verifyChain();
    const rootHash = this.lastHash || '0'.repeat(64);

    const content = JSON.stringify({
      date: today,
      rootHash,
      entryCount: chainResult.totalEntries,
      chainValid: chainResult.valid,
      exportedAt: new Date().toISOString(),
    }, null, 2);

    try {
      writeFileSync(rootHashPath, content, 'utf-8');
      log.info({ rootHashPath, rootHash }, 'Exported daily root hash');
    } catch (err) {
      log.error({ err, rootHashPath }, 'Failed to export audit root hash — compliance integrity at risk');
      return null;
    }

    return rootHashPath;
  }

  getLastHash(): string {
    return this.lastHash;
  }

  getEntryCount(): number {
    return this.entryCount;
  }

  isStrictMode(): boolean {
    return this.strictMode;
  }

  // ─── Private ────────────────────────────────────────────────────

  private ensureDirs(): void {
    const auditDir = dirname(this.auditFilePath);
    if (!existsSync(auditDir)) {
      mkdirSync(auditDir, { recursive: true });
    }
    if (!existsSync(this.rootHashDir)) {
      mkdirSync(this.rootHashDir, { recursive: true });
    }
  }

  private loadLastHash(): void {
    if (!existsSync(this.auditFilePath)) {
      this.lastHash = '';
      this.entryCount = 0;
      return;
    }

    const content = readFileSync(this.auditFilePath, 'utf-8').trim();
    if (!content) {
      this.lastHash = '';
      this.entryCount = 0;
      return;
    }

    const lines = content.split('\n');
    this.entryCount = lines.length;

    const lastLine = lines[lines.length - 1];
    try {
      const entry = JSON.parse(lastLine) as AuditEntry;
      this.lastHash = entry.entryHash;
    } catch (err) {
      log.info(
        { err, line: lastLine, entryCount: this.entryCount },
        'Audit log last entry corrupted — starting fresh hash chain. Previous entries are intact but chain continuity is broken.',
      );
      this.lastHash = '';
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function validatePolicyDecision(
  pd: PolicyDecision,
): { valid: boolean; reason?: string } {
  if (!pd.proposed || pd.proposed.trim() === '') {
    return { valid: false, reason: 'missing proposed' };
  }
  if (!pd.policyResult) {
    return { valid: false, reason: 'missing policyResult' };
  }
  if (!pd.policyRule || pd.policyRule.trim() === '') {
    return { valid: false, reason: 'missing policyRule' };
  }
  if (pd.userConfirmed === undefined) {
    return { valid: false, reason: 'missing userConfirmed' };
  }
  if (!Array.isArray(pd.redactionsApplied)) {
    return { valid: false, reason: 'missing redactionsApplied' };
  }
  return { valid: true };
}
