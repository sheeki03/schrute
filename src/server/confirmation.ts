import { createHash, randomBytes, createHmac } from 'node:crypto';
import { getLogger } from '../core/logger.js';
import type { AgentDatabase } from '../storage/database.js';
import type { ConfirmationToken, OneAgentConfig } from '../skill/types.js';

const log = getLogger();

// ─── HMAC Secret (per-process, used to sign nonces) ──────────────
const HMAC_SECRET = randomBytes(32);

// ─── DB-Backed Confirmation Manager ──────────────────────────────

export class ConfirmationManager {
  private db: AgentDatabase;
  private config: OneAgentConfig;

  constructor(db: AgentDatabase, config: OneAgentConfig) {
    this.db = db;
    this.config = config;
  }

  /**
   * Check if a skill has already been globally confirmed (approved).
   * Once confirmed in skill_confirmations, the skill never needs
   * re-confirmation.
   */
  isSkillConfirmed(skillId: string): boolean {
    const row = this.db.get<{ confirmation_status: string }>(
      'SELECT confirmation_status FROM skill_confirmations WHERE skill_id = ?',
      skillId,
    );
    return row?.confirmation_status === 'approved';
  }

  /**
   * Generate a confirmation token and persist the nonce in the DB.
   */
  generateToken(
    skillId: string,
    params: Record<string, unknown>,
    tier: string,
  ): ConfirmationToken {
    const nonce = randomBytes(16).toString('hex');
    const paramsHash = createHash('sha256')
      .update(JSON.stringify(params))
      .digest('hex');
    const now = Date.now();
    const expiresAt = now + this.config.confirmationExpiryMs;

    // Sign with HMAC to produce the tokenId
    const hmacPayload = `${skillId}|${paramsHash}|${tier}|${expiresAt}|${nonce}`;
    const tokenId = createHmac('sha256', HMAC_SECRET)
      .update(hmacPayload)
      .digest('hex');

    // Persist nonce in DB
    this.db.run(
      `INSERT INTO confirmation_nonces (nonce, skill_id, params_hash, tier, created_at, expires_at, consumed, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, NULL)`,
      tokenId,
      skillId,
      paramsHash,
      tier,
      now,
      expiresAt,
    );

    return {
      nonce: tokenId,
      skillId,
      paramsHash,
      tier,
      createdAt: now,
      expiresAt,
      consumed: false,
    };
  }

  /**
   * Verify a confirmation token from the DB.
   */
  verifyToken(tokenId: string): {
    valid: boolean;
    token?: ConfirmationToken;
    error?: string;
  } {
    const row = this.db.get<{
      nonce: string;
      skill_id: string;
      params_hash: string;
      tier: string;
      created_at: number;
      expires_at: number;
      consumed: number;
      consumed_at: number | null;
    }>(
      'SELECT * FROM confirmation_nonces WHERE nonce = ?',
      tokenId,
    );

    if (!row) {
      return { valid: false, error: 'Token not found' };
    }

    if (row.consumed) {
      return { valid: false, error: 'Token already consumed' };
    }

    if (Date.now() > row.expires_at) {
      // Clean up expired token
      this.db.run('DELETE FROM confirmation_nonces WHERE nonce = ?', tokenId);
      return { valid: false, error: 'Token expired' };
    }

    const token: ConfirmationToken = {
      nonce: row.nonce,
      skillId: row.skill_id,
      paramsHash: row.params_hash,
      tier: row.tier,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      consumed: false,
    };

    return { valid: true, token };
  }

  /**
   * Consume a token and optionally approve the skill globally.
   */
  consumeToken(tokenId: string, approve: boolean, approvedBy?: string): void {
    const now = Date.now();

    // Mark nonce as consumed
    this.db.run(
      'UPDATE confirmation_nonces SET consumed = 1, consumed_at = ? WHERE nonce = ?',
      now,
      tokenId,
    );

    // Look up the skill_id from the nonce
    const row = this.db.get<{ skill_id: string }>(
      'SELECT skill_id FROM confirmation_nonces WHERE nonce = ?',
      tokenId,
    );

    if (!row) return;

    if (approve) {
      // Upsert into skill_confirmations for global unlock
      this.db.run(
        `INSERT INTO skill_confirmations (skill_id, confirmation_status, approved_by, approved_at)
         VALUES (?, 'approved', ?, ?)
         ON CONFLICT(skill_id) DO UPDATE SET
           confirmation_status = 'approved',
           approved_by = excluded.approved_by,
           approved_at = excluded.approved_at`,
        row.skill_id,
        approvedBy ?? 'mcp-client',
        now,
      );

      log.info({ skillId: row.skill_id }, 'Skill globally confirmed (approved)');
    } else {
      // Record denial
      this.db.run(
        `INSERT INTO skill_confirmations (skill_id, confirmation_status, denied_at)
         VALUES (?, 'denied', ?)
         ON CONFLICT(skill_id) DO UPDATE SET
           confirmation_status = 'denied',
           denied_at = excluded.denied_at`,
        row.skill_id,
        now,
      );

      log.info({ skillId: row.skill_id }, 'Skill confirmation denied');
    }
  }
}
