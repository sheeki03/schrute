import { TRACKING_PARAMS } from '../skill/types.js';
import type { StructuredRequest } from './har-extractor.js';

const TRACKING_SET = new Set(TRACKING_PARAMS);

const EPHEMERAL_BODY_KEYS = new Set([
  'timestamp', 'requestId', 'request_id', 'nonce',
  '_t', '_ts', '_timestamp', '_nonce',
  'correlationId', 'correlation_id',
  'traceId', 'trace_id', 'spanId', 'span_id',
]);

// ─── URL Canonicalization ────────────────────────────────────────────

export function canonicalizeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  // Lowercase host
  parsed.hostname = parsed.hostname.toLowerCase();

  // Strip tracking params
  for (const param of TRACKING_SET) {
    parsed.searchParams.delete(param);
  }

  // Sort remaining query params
  const params = Array.from(parsed.searchParams.entries());
  params.sort((a, b) => a[0].localeCompare(b[0]));

  // Rebuild search string
  parsed.search = '';
  for (const [key, value] of params) {
    parsed.searchParams.append(key, value);
  }

  return parsed.toString();
}

// ─── JSON Body Canonicalization ──────────────────────────────────────

export function canonicalizeJsonBody(body: string | undefined): string | undefined {
  if (!body) return body;

  try {
    const parsed = JSON.parse(body);
    const cleaned = sortAndClean(parsed);
    return JSON.stringify(cleaned);
  } catch {
    return body;
  }
}

function sortAndClean(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(sortAndClean);
  }

  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(obj as Record<string, unknown>).sort();

  for (const key of keys) {
    if (EPHEMERAL_BODY_KEYS.has(key)) continue;
    sorted[key] = sortAndClean((obj as Record<string, unknown>)[key]);
  }

  return sorted;
}

// ─── GraphQL Canonicalization ────────────────────────────────────────

export function canonicalizeGraphQL(query: string): string {
  // Strip comments
  let cleaned = query.replace(/#[^\n]*/g, '');

  // Collapse whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned;
}

function canonicalizeGraphQLVariables(variables: string | undefined): string | undefined {
  if (!variables) return variables;
  try {
    const parsed = JSON.parse(variables);
    const sorted = sortAndClean(parsed);
    return JSON.stringify(sorted);
  } catch {
    return variables;
  }
}

// ─── Full Request Canonicalization ───────────────────────────────────

export interface CanonicalizedRequest {
  method: string;
  canonicalUrl: string;
  canonicalBody?: string;
  contentType?: string;
}

export function canonicalizeRequest(req: StructuredRequest): CanonicalizedRequest {
  const canonicalUrl = canonicalizeUrl(req.url);
  let canonicalBody = req.body;

  const ct = req.contentType?.toLowerCase() ?? '';

  if (ct.includes('application/json') || ct.includes('application/graphql+json')) {
    // Check if this is a GraphQL request
    if (req.body) {
      try {
        const parsed = JSON.parse(req.body);
        if (parsed && typeof parsed === 'object' && ('query' in parsed || 'operationName' in parsed)) {
          // GraphQL: canonicalize query and variables separately
          const result: Record<string, unknown> = {};
          if (parsed.operationName) result.operationName = parsed.operationName;
          if (parsed.query) result.query = canonicalizeGraphQL(parsed.query);
          if (parsed.variables) {
            const varsStr = JSON.stringify(parsed.variables);
            const canonical = canonicalizeGraphQLVariables(varsStr);
            result.variables = canonical ? JSON.parse(canonical) : parsed.variables;
          }
          canonicalBody = JSON.stringify(result);
        } else {
          canonicalBody = canonicalizeJsonBody(req.body);
        }
      } catch {
        canonicalBody = canonicalizeJsonBody(req.body);
      }
    }
  } else if (ct.includes('application/json')) {
    canonicalBody = canonicalizeJsonBody(req.body);
  }

  return {
    method: req.method.toUpperCase(),
    canonicalUrl,
    canonicalBody,
    contentType: req.contentType,
  };
}
