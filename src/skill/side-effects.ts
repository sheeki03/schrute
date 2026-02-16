import type { SideEffectClassName } from './types.js';
import { SideEffectClass } from './types.js';
import { checkPathRiskNative as checkPathRisk } from '../native/path-risk.js';
import { getLogger } from '../core/logger.js';

const log = getLogger();

// ─── Observed Effects ───────────────────────────────────────────

export interface ObservedEffects {
  stateChangingCookiesSet?: boolean;
  redirectedToLogout?: boolean;
  triggeredDownstreamWrites?: boolean;
}

// ─── GraphQL Detection ──────────────────────────────────────────

export type GraphQLOperationType = 'query' | 'mutation' | 'subscription';

export function detectGraphQLOperation(body?: string): GraphQLOperationType | null {
  if (!body) return null;

  try {
    const parsed = JSON.parse(body);
    const query: string = parsed.query ?? parsed.operationName ?? '';
    const trimmed = query.trim().toLowerCase();

    if (trimmed.startsWith('mutation')) return 'mutation';
    if (trimmed.startsWith('subscription')) return 'subscription';
    if (trimmed.startsWith('query') || trimmed.startsWith('{')) return 'query';

    return null;
  } catch (err) {
    log.debug({ err }, 'GraphQL detection failed');
    return null;
  }
}

// ─── Side Effect Classification ─────────────────────────────────

export function classifySideEffect(
  method: string,
  path: string,
  observedEffects?: ObservedEffects,
  requestBody?: string,
): SideEffectClassName {
  const upperMethod = method.toUpperCase();

  // GraphQL: all goes through POST typically
  if (upperMethod === 'POST' && isGraphQLPath(path)) {
    const opType = detectGraphQLOperation(requestBody);
    if (opType === 'query') return SideEffectClass.READ_ONLY;
    if (opType === 'mutation') return SideEffectClass.NON_IDEMPOTENT;
    if (opType === 'subscription') return SideEffectClass.NON_IDEMPOTENT; // WebSocket blocked upstream
  }

  // GET/HEAD are read-only unless path-risk blocks them
  if (upperMethod === 'GET' || upperMethod === 'HEAD') {
    const pathRisk = checkPathRisk(method, path);
    if (pathRisk.blocked) {
      return SideEffectClass.NON_IDEMPOTENT;
    }
    return SideEffectClass.READ_ONLY;
  }

  // PUT is idempotent by HTTP semantics
  if (upperMethod === 'PUT') {
    return SideEffectClass.IDEMPOTENT;
  }

  // DELETE is idempotent by HTTP semantics
  if (upperMethod === 'DELETE') {
    return SideEffectClass.IDEMPOTENT;
  }

  // POST requires further analysis
  if (upperMethod === 'POST') {
    // Check path-based heuristics
    const pathRisk = checkPathRisk(method, path);
    if (pathRisk.blocked) {
      return SideEffectClass.NON_IDEMPOTENT;
    }

    // Check observed effects from validation runs
    if (observedEffects) {
      if (
        observedEffects.stateChangingCookiesSet ||
        observedEffects.redirectedToLogout ||
        observedEffects.triggeredDownstreamWrites
      ) {
        return SideEffectClass.NON_IDEMPOTENT;
      }
    }

    // Search-like POST endpoints (common pattern)
    if (isSearchLikePath(path)) {
      return SideEffectClass.READ_ONLY;
    }

    // Default POST is non-idempotent unless proven otherwise
    return SideEffectClass.NON_IDEMPOTENT;
  }

  // PATCH is non-idempotent
  if (upperMethod === 'PATCH') {
    return SideEffectClass.NON_IDEMPOTENT;
  }

  // Unknown methods are non-idempotent
  return SideEffectClass.NON_IDEMPOTENT;
}

// ─── Helpers ────────────────────────────────────────────────────

function isGraphQLPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.includes('/graphql') || lower.includes('/gql');
}

const SEARCH_PATH_PATTERNS = [
  /\/search/i,
  /\/query/i,
  /\/filter/i,
  /\/autocomplete/i,
  /\/suggest/i,
  /\/lookup/i,
  /\/find/i,
];

function isSearchLikePath(path: string): boolean {
  return SEARCH_PATH_PATTERNS.some((p) => p.test(path));
}
