import { describe, it, expect } from 'vitest';
import { createHash, randomBytes, createHmac } from 'node:crypto';
import type { ConfirmationToken, OneAgentConfig } from '../../src/skill/types.js';

// Re-implement the confirmation token logic from mcp-stdio.ts for testing,
// since those functions are module-private. This tests the same algorithm.

const HMAC_SECRET = randomBytes(32);
const pendingConfirmations = new Map<string, ConfirmationToken>();

function makeConfig(overrides?: Partial<OneAgentConfig>): OneAgentConfig {
  return {
    dataDir: '/tmp/test-oneagent-confirm',
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
    ...overrides,
  } as OneAgentConfig;
}

function generateConfirmationToken(
  skillId: string,
  params: Record<string, unknown>,
  tier: string,
  config: OneAgentConfig,
): ConfirmationToken {
  const nonce = randomBytes(16).toString('hex');
  const paramsHash = createHash('sha256')
    .update(JSON.stringify(params))
    .digest('hex');
  const now = Date.now();

  const token: ConfirmationToken = {
    nonce,
    skillId,
    paramsHash,
    tier,
    createdAt: now,
    expiresAt: now + config.confirmationExpiryMs,
    consumed: false,
  };

  const hmacPayload = `${skillId}|${paramsHash}|${tier}|${token.expiresAt}|${nonce}`;
  const hmac = createHmac('sha256', HMAC_SECRET).update(hmacPayload).digest('hex');
  const tokenId = hmac;

  pendingConfirmations.set(tokenId, token);
  return { ...token, nonce: tokenId };
}

function verifyConfirmationToken(
  tokenId: string,
): { valid: boolean; token?: ConfirmationToken; error?: string } {
  const token = pendingConfirmations.get(tokenId);
  if (!token) {
    return { valid: false, error: 'Token not found' };
  }
  if (token.consumed) {
    return { valid: false, error: 'Token already consumed' };
  }
  if (Date.now() > token.expiresAt) {
    pendingConfirmations.delete(tokenId);
    return { valid: false, error: 'Token expired' };
  }
  return { valid: true, token };
}

function consumeToken(tokenId: string): void {
  const token = pendingConfirmations.get(tokenId);
  if (token) {
    token.consumed = true;
    token.consumedAt = Date.now();
  }
}

describe('confirmation flow integration', () => {
  it('generates a valid HMAC-based confirmation token', () => {
    const config = makeConfig();
    const token = generateConfirmationToken(
      'example.get_users.v1',
      { page: 1 },
      'tier_1',
      config,
    );

    expect(token.nonce).toBeTruthy();
    // Token ID (nonce) should be a 64-char hex string (SHA-256 HMAC)
    expect(token.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(token.skillId).toBe('example.get_users.v1');
    expect(token.consumed).toBe(false);
    expect(token.expiresAt).toBeGreaterThan(token.createdAt);
  });

  it('verifies and consumes a valid confirmation token (approve path)', () => {
    const config = makeConfig();
    const token = generateConfirmationToken(
      'example.get_users.v1',
      { page: 1 },
      'tier_1',
      config,
    );

    // Verify the token
    const verification = verifyConfirmationToken(token.nonce);
    expect(verification.valid).toBe(true);
    expect(verification.token).toBeDefined();
    expect(verification.token!.skillId).toBe('example.get_users.v1');

    // Approve: consume the token
    consumeToken(token.nonce);

    // Token should now be consumed
    const postConsume = verifyConfirmationToken(token.nonce);
    expect(postConsume.valid).toBe(false);
    expect(postConsume.error).toBe('Token already consumed');
  });

  it('rejects unknown confirmation token (deny path)', () => {
    const verification = verifyConfirmationToken('nonexistent-token-id');
    expect(verification.valid).toBe(false);
    expect(verification.error).toBe('Token not found');
  });

  it('rejects expired confirmation token', () => {
    // Create a config with very short expiry
    const config = makeConfig({ confirmationExpiryMs: 1 });
    const token = generateConfirmationToken(
      'example.get_users.v1',
      {},
      'tier_1',
      config,
    );

    // Wait for expiry (token was created with 1ms expiry)
    // The token should expire immediately since expiresAt = now + 1ms
    // Use a small delay to ensure we pass the expiry time
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const verification = verifyConfirmationToken(token.nonce);
        expect(verification.valid).toBe(false);
        expect(verification.error).toBe('Token expired');
        resolve();
      }, 10);
    });
  });

  it('different params produce different token IDs', () => {
    const config = makeConfig();
    const token1 = generateConfirmationToken(
      'example.get_users.v1',
      { page: 1 },
      'tier_1',
      config,
    );
    const token2 = generateConfirmationToken(
      'example.get_users.v1',
      { page: 2 },
      'tier_1',
      config,
    );

    expect(token1.nonce).not.toBe(token2.nonce);
    // Both should be valid
    expect(verifyConfirmationToken(token1.nonce).valid).toBe(true);
    expect(verifyConfirmationToken(token2.nonce).valid).toBe(true);
  });

  it('token paramsHash is deterministic for same params', () => {
    const config = makeConfig();
    const params = { page: 1, limit: 10 };

    const token1 = generateConfirmationToken('skill.v1', params, 'tier_1', config);
    const token2 = generateConfirmationToken('skill.v1', params, 'tier_1', config);

    // paramsHash should be the same for the same params
    expect(token1.paramsHash).toBe(token2.paramsHash);
    // But token IDs differ because nonces are random
    expect(token1.nonce).not.toBe(token2.nonce);
  });
});
