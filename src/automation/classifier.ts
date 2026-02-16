import { getLogger } from '../core/logger.js';
import type { NetworkEntry, ExecutionTierName } from '../skill/types.js';
import { ExecutionTier } from '../skill/types.js';

const log = getLogger();

// ─── Types ────────────────────────────────────────────────────────

export interface SiteClassification {
  recommendedTier: ExecutionTierName;
  authRequired: boolean;
  dynamicFieldsDetected: boolean;
  graphqlDetected: boolean;
}

// ─── Heuristic Helpers ──────────────────────────────────────────

function hasAuthHeaders(traffic: NetworkEntry[]): boolean {
  return traffic.some((entry) => {
    const headers = Object.keys(entry.requestHeaders).map((h) => h.toLowerCase());
    return (
      headers.includes('authorization') ||
      headers.includes('cookie') ||
      headers.includes('x-csrf-token') ||
      headers.includes('x-xsrf-token')
    );
  });
}

function hasGraphQL(traffic: NetworkEntry[]): boolean {
  return traffic.some((entry) => {
    if (entry.url.includes('/graphql')) return true;
    if (entry.requestBody) {
      try {
        const body = JSON.parse(entry.requestBody);
        return typeof body === 'object' && body !== null && 'query' in body;
      } catch {
        return false;
      }
    }
    return false;
  });
}

function hasDynamicFields(traffic: NetworkEntry[]): boolean {
  const noncePatterns = [
    /csrf/i,
    /nonce/i,
    /token/i,
    /_ts\b/,
    /timestamp/i,
    /request.id/i,
  ];

  return traffic.some((entry) => {
    const url = entry.url;
    if (noncePatterns.some((p) => p.test(url))) return true;

    if (entry.requestBody) {
      if (noncePatterns.some((p) => p.test(entry.requestBody!))) return true;
    }

    const headers = Object.entries(entry.requestHeaders);
    return headers.some(([key]) =>
      noncePatterns.some((p) => p.test(key)),
    );
  });
}

function hasJsComputedFields(traffic: NetworkEntry[]): boolean {
  const signaturePatterns = [
    /x-signature/i,
    /x-hash/i,
    /x-checksum/i,
    /hmac/i,
  ];

  return traffic.some((entry) => {
    const headers = Object.keys(entry.requestHeaders).map((h) => h.toLowerCase());
    return headers.some((h) => signaturePatterns.some((p) => p.test(h)));
  });
}

// ─── Main Classifier ────────────────────────────────────────────

export function classifySite(
  siteId: string,
  traffic: NetworkEntry[],
): SiteClassification {
  const authRequired = hasAuthHeaders(traffic);
  const graphqlDetected = hasGraphQL(traffic);
  const dynamicFieldsDetected = hasDynamicFields(traffic);
  const jsComputed = hasJsComputedFields(traffic);

  let recommendedTier: ExecutionTierName;

  if (jsComputed) {
    // JS-computed fields require full browser for replay
    recommendedTier = ExecutionTier.FULL_BROWSER;
  } else if (authRequired) {
    // Auth (with or without dynamic fields) typically needs cookie refresh tier
    recommendedTier = ExecutionTier.COOKIE_REFRESH;
  } else if (graphqlDetected) {
    // GraphQL without auth — direct fetch may work
    recommendedTier = ExecutionTier.DIRECT;
  } else {
    // Simple API — direct fetch
    recommendedTier = ExecutionTier.DIRECT;
  }

  log.debug(
    { siteId, recommendedTier, authRequired, dynamicFieldsDetected, graphqlDetected },
    'Site classified',
  );

  return {
    recommendedTier,
    authRequired,
    dynamicFieldsDetected,
    graphqlDetected,
  };
}
