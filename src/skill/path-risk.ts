import {
  DESTRUCTIVE_GET_PATTERNS,
  DESTRUCTIVE_POST_PATTERNS,
} from './types.js';

// ─── Types ──────────────────────────────────────────────────────

export interface PathRiskResult {
  blocked: boolean;
  reason?: string;
}

// ─── User-configurable allowlist ────────────────────────────────

const pathAllowlist = new Map<string, Set<string>>();

export function addPathAllowlistEntry(siteId: string, path: string): void {
  let entries = pathAllowlist.get(siteId);
  if (!entries) {
    entries = new Set();
    pathAllowlist.set(siteId, entries);
  }
  entries.add(path.toLowerCase());
}

export function removePathAllowlistEntry(siteId: string, path: string): void {
  const entries = pathAllowlist.get(siteId);
  if (entries) {
    entries.delete(path.toLowerCase());
  }
}

export function clearPathAllowlist(siteId?: string): void {
  if (siteId) {
    pathAllowlist.delete(siteId);
  } else {
    pathAllowlist.clear();
  }
}

// ─── Path Risk Check ────────────────────────────────────────────

export function checkPathRisk(
  method: string,
  path: string,
  siteId?: string,
): PathRiskResult {
  const normalizedPath = path.toLowerCase();

  // Check user-configured allowlist overrides
  if (siteId) {
    const entries = pathAllowlist.get(siteId);
    if (entries?.has(normalizedPath)) {
      return { blocked: false };
    }
  }

  const upperMethod = method.toUpperCase();

  if (upperMethod === 'GET' || upperMethod === 'HEAD') {
    for (const pattern of DESTRUCTIVE_GET_PATTERNS) {
      if (pattern.test(path)) {
        return {
          blocked: true,
          reason: `Destructive GET pattern detected: ${pattern.source} on path '${path}'`,
        };
      }
    }
  }

  if (upperMethod === 'POST') {
    for (const pattern of DESTRUCTIVE_POST_PATTERNS) {
      if (pattern.test(path)) {
        return {
          blocked: true,
          reason: `Destructive POST pattern detected: ${pattern.source} on path '${path}'`,
        };
      }
    }
  }

  // PUT, PATCH, DELETE are inherently destructive
  if (
    upperMethod === 'PUT' ||
    upperMethod === 'PATCH' ||
    upperMethod === 'DELETE'
  ) {
    return {
      blocked: true,
      reason: `HTTP method '${upperMethod}' is inherently destructive`,
    };
  }

  return { blocked: false };
}
