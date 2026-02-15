/**
 * IP policy — native Rust acceleration with TS fallback.
 *
 * JSON contracts:
 *   isPublicIp:
 *     Input:  IP address string
 *     Output: { ip, allowed, category }
 *
 *   checkDomainAllowlist:
 *     Input:  { targetDomain, allowlist }
 *     Output: { allowed, matchedDomain? }
 *
 *   normalizeDomain:
 *     Input:  domain string
 *     Output: normalized domain string
 */

import type { IpValidationResult } from '../core/policy.js';
import { isPublicIp as tsIsPublicIp } from '../core/policy.js';
import { getNativeModule } from './index.js';

export function isPublicIpNative(ip: string): { ip: string; allowed: boolean; category: string } | null {
  const native = getNativeModule();

  if (native?.isPublicIp) {
    try {
      const resultJson: string = native.isPublicIp(ip);
      return JSON.parse(resultJson);
    } catch {
      // Fall through to TS fallback
    }
  }

  // Synchronous fallback using TS
  const allowed = tsIsPublicIp(ip);
  return { ip, allowed, category: allowed ? 'unicast' : 'blocked' };
}

export function normalizeDomainNative(domain: string): string {
  const native = getNativeModule();

  if (native?.normalizeDomainNative) {
    try {
      return native.normalizeDomainNative(domain) as string;
    } catch {
      // Fall through to TS fallback
    }
  }

  // Inline TS fallback
  let d = domain.toLowerCase();
  while (d.endsWith('.')) {
    d = d.slice(0, -1);
  }
  try {
    const url = new URL(`http://${d}`);
    return url.hostname;
  } catch {
    return d;
  }
}

export function checkDomainAllowlistNative(
  targetDomain: string,
  allowlist: string[],
): { allowed: boolean; matchedDomain?: string } | null {
  const native = getNativeModule();

  if (native?.checkDomainAllowlist) {
    try {
      const input = JSON.stringify({ targetDomain, allowlist });
      const resultJson: string = native.checkDomainAllowlist(input);
      return JSON.parse(resultJson);
    } catch {
      // Fall through to null (caller uses TS)
    }
  }

  return null;
}
