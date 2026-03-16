/**
 * Audit hash-chain — native Rust acceleration with TS fallback.
 *
 * JSON contracts:
 *   computeEntryHash:
 *     Input:  { entryJson, previousHash }
 *     Output: { entryHash }
 *
 *   signEntryHash:
 *     Input:  { entryHash, hmacKey }
 *     Output: { signature }
 *
 *   verifyChain:
 *     Input:  { entriesJson: string[], hmacKey }
 *     Output: { valid, brokenAt?, totalEntries, message? }
 */

import { createHash, createHmac } from 'node:crypto';
import { getNativeModule } from './index.js';
import { getLogger } from '../core/logger.js';

const log = getLogger();
let _nativeFailureLogged = false;

interface ChainVerificationNative {
  valid: boolean;
  brokenAt?: number;
  totalEntries: number;
  message?: string;
}

export function computeEntryHashNative(
  entryJson: string,
  previousHash: string,
): string | null {
  const native = getNativeModule();

  if (native?.computeEntryHash) {
    try {
      const input = JSON.stringify({ entryJson, previousHash });
      const resultJson: string = native.computeEntryHash(input);
      const parsed = JSON.parse(resultJson);
      return parsed.entryHash;
    } catch (err) {
      if (!_nativeFailureLogged) {
        log.info({ err }, 'Native audit-chain unavailable, using TS fallback');
        _nativeFailureLogged = true;
      }
    }
  }

  // TS fallback — use null (not undefined) to match Rust serialization
  const entry = JSON.parse(entryJson);
  const withHashes = {
    ...entry,
    previousHash,
    entryHash: null,
    signature: null,
  };
  const payload = JSON.stringify(withHashes);
  return createHash('sha256').update(payload).digest('hex');
}

export function signEntryHashNative(
  entryHash: string,
  hmacKey: string,
): string | null {
  const native = getNativeModule();

  if (native?.signEntryHash) {
    try {
      const input = JSON.stringify({ entryHash, hmacKey });
      const resultJson: string = native.signEntryHash(input);
      const parsed = JSON.parse(resultJson);
      return parsed.signature;
    } catch (err) {
      if (!_nativeFailureLogged) {
        log.info({ err }, 'Native audit-chain unavailable, using TS fallback');
        _nativeFailureLogged = true;
      }
    }
  }

  // TS fallback
  return createHmac('sha256', hmacKey).update(entryHash).digest('hex');
}

export function verifyChainNative(
  entriesJson: string[],
  hmacKey: string,
): ChainVerificationNative | null {
  const native = getNativeModule();

  if (native?.verifyChain) {
    try {
      const input = JSON.stringify({ entriesJson, hmacKey });
      const resultJson: string = native.verifyChain(input);
      return JSON.parse(resultJson);
    } catch (err) {
      if (!_nativeFailureLogged) {
        log.info({ err }, 'Native audit-chain unavailable, using TS fallback');
        _nativeFailureLogged = true;
      }
    }
  }

  return null;
}
