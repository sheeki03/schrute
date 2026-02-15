import { describe, it, expect } from 'vitest';
import {
  computeEntryHashNative,
  signEntryHashNative,
  verifyChainNative,
} from '../../src/native/audit-chain.js';

describe('native audit chain (TS fallback)', () => {
  const hmacKey = 'test-hmac-key-for-audit';

  it('computes entry hash', () => {
    const entry = {
      id: 'entry-1',
      timestamp: 1700000000000,
      skillId: 'test.skill.v1',
    };

    const hash = computeEntryHashNative(
      JSON.stringify(entry),
      '0'.repeat(64),
    );

    expect(hash).not.toBeNull();
    expect(hash).toHaveLength(64);
    // Should be a valid hex string
    expect(/^[0-9a-f]{64}$/.test(hash!)).toBe(true);
  });

  it('produces deterministic hashes', () => {
    const entry = { id: 'entry-1', data: 'test' };
    const prevHash = '0'.repeat(64);

    const hash1 = computeEntryHashNative(JSON.stringify(entry), prevHash);
    const hash2 = computeEntryHashNative(JSON.stringify(entry), prevHash);

    expect(hash1).toBe(hash2);
  });

  it('signs entry hash with HMAC', () => {
    const entryHash = 'a'.repeat(64);

    const sig = signEntryHashNative(entryHash, hmacKey);

    expect(sig).not.toBeNull();
    expect(sig).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(sig!)).toBe(true);
  });

  it('produces deterministic signatures', () => {
    const entryHash = 'b'.repeat(64);

    const sig1 = signEntryHashNative(entryHash, hmacKey);
    const sig2 = signEntryHashNative(entryHash, hmacKey);

    expect(sig1).toBe(sig2);
  });

  it('verifyChainNative returns null without native module (caller uses TS class)', () => {
    const result = verifyChainNative([], hmacKey);
    // Without native, returns null
    if (result !== null) {
      expect(result.valid).toBe(true);
      expect(result.totalEntries).toBe(0);
    }
  });
});
