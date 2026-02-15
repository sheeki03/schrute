import { getLogger } from '../core/logger.js';
import type { StructuredRecord, StructuredRequest } from './har-extractor.js';

const log = getLogger();

// ─── Types ───────────────────────────────────────────────────────────

export interface GraphQLInfo {
  operationName: string | null;
  operationType: 'query' | 'mutation' | 'subscription' | null;
  variables: Record<string, unknown> | null;
  query: string | null;
  isPersistedQuery: boolean;
  persistedQueryHash?: string;
}

export interface GraphQLOperationCluster {
  operationName: string;
  operationType: 'query' | 'mutation' | 'subscription' | null;
  skillName: string;
  requests: StructuredRecord[];
  variableShape: Record<string, string>;
  hasPersistedQueries: boolean;
}

// ─── Detection ───────────────────────────────────────────────────────

export function isGraphQL(request: StructuredRequest): boolean {
  // Check URL ending
  try {
    const urlPath = new URL(request.url).pathname;
    if (urlPath.endsWith('/graphql') || urlPath.endsWith('/gql')) {
      return true;
    }
  } catch {
    // ignore
  }

  // Check content type
  const ct = request.contentType?.toLowerCase() ?? '';
  if (ct.includes('application/graphql')) {
    return true;
  }

  // Check body structure
  if (request.body) {
    try {
      const parsed = JSON.parse(request.body);
      if (
        parsed &&
        typeof parsed === 'object' &&
        ('query' in parsed || 'operationName' in parsed)
      ) {
        return true;
      }
    } catch {
      // not JSON
    }
  }

  return false;
}

// ─── Extraction ──────────────────────────────────────────────────────

export function extractGraphQLInfo(request: StructuredRequest): GraphQLInfo {
  const result: GraphQLInfo = {
    operationName: null,
    operationType: null,
    variables: null,
    query: null,
    isPersistedQuery: false,
  };

  if (!request.body) return result;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(request.body);
  } catch {
    return result;
  }

  if (typeof parsed.operationName === 'string') {
    result.operationName = parsed.operationName;
  }

  if (typeof parsed.query === 'string') {
    result.query = parsed.query;
    result.operationType = detectOperationType(parsed.query);
  }

  if (parsed.variables && typeof parsed.variables === 'object') {
    result.variables = parsed.variables as Record<string, unknown>;
  }

  // Detect persisted queries (APQ)
  if (parsed.extensions && typeof parsed.extensions === 'object') {
    const ext = parsed.extensions as Record<string, unknown>;
    if (ext.persistedQuery && typeof ext.persistedQuery === 'object') {
      const pq = ext.persistedQuery as Record<string, unknown>;
      result.isPersistedQuery = true;
      if (typeof pq.sha256Hash === 'string') {
        result.persistedQueryHash = pq.sha256Hash;
      }
    }
  }

  // If no query text but has a hash, this is a persisted query without inline query
  if (!result.query && result.isPersistedQuery) {
    result.isPersistedQuery = true;
  }

  // Try to extract operation name from query text if not explicitly provided
  if (!result.operationName && result.query) {
    result.operationName = extractOperationNameFromQuery(result.query);
  }

  return result;
}

// ─── Clustering ──────────────────────────────────────────────────────

export function clusterByOperation(
  requests: StructuredRecord[],
  siteId: string,
): GraphQLOperationCluster[] {
  const clusterMap = new Map<string, { records: StructuredRecord[]; info: GraphQLInfo }>();

  for (const rec of requests) {
    if (!isGraphQL(rec.request)) continue;

    const info = extractGraphQLInfo(rec.request);
    const key = info.operationName ?? info.persistedQueryHash ?? 'anonymous';

    let cluster = clusterMap.get(key);
    if (!cluster) {
      cluster = { records: [], info };
      clusterMap.set(key, cluster);
    }
    cluster.records.push(rec);
  }

  const clusters: GraphQLOperationCluster[] = [];

  for (const [key, { records, info }] of clusterMap) {
    const opName = info.operationName ?? key;
    const skillName = `${siteId}.gql.${sanitizeName(opName)}.v1`;
    const variableShape = inferVariableShape(records);

    clusters.push({
      operationName: opName,
      operationType: info.operationType,
      skillName,
      requests: records,
      variableShape,
      hasPersistedQueries: records.some(r => {
        const gqlInfo = extractGraphQLInfo(r.request);
        return gqlInfo.isPersistedQuery;
      }),
    });
  }

  log.debug({ clusterCount: clusters.length }, 'Clustered GraphQL operations');
  return clusters;
}

/**
 * Check if a persisted query can be replayed.
 * Unknown persisted queries (no query text, no schema) should be BLOCKED.
 */
export function canReplayPersistedQuery(info: GraphQLInfo): boolean {
  // If we have the query text, we can replay
  if (info.query) return true;

  // If it's a persisted query without query text, we cannot safely replay
  // without schema/introspection access
  if (info.isPersistedQuery && !info.query) return false;

  return true;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function detectOperationType(query: string): 'query' | 'mutation' | 'subscription' | null {
  const trimmed = query.trim();

  if (/^mutation\b/i.test(trimmed)) return 'mutation';
  if (/^subscription\b/i.test(trimmed)) return 'subscription';
  if (/^query\b/i.test(trimmed)) return 'query';

  // Named operations: look for the keyword before the name
  const opMatch = trimmed.match(/^(query|mutation|subscription)\s+\w+/i);
  if (opMatch) {
    return opMatch[1].toLowerCase() as 'query' | 'mutation' | 'subscription';
  }

  // Default: if it starts with { it's a query
  if (trimmed.startsWith('{')) return 'query';

  return null;
}

function extractOperationNameFromQuery(query: string): string | null {
  const match = query.match(/(?:query|mutation|subscription)\s+(\w+)/i);
  return match ? match[1] : null;
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
}

function inferVariableShape(records: StructuredRecord[]): Record<string, string> {
  const shape: Record<string, string> = {};
  const allKeys = new Set<string>();

  for (const rec of records) {
    const info = extractGraphQLInfo(rec.request);
    if (info.variables) {
      for (const key of Object.keys(info.variables)) {
        allKeys.add(key);
      }
    }
  }

  for (const key of allKeys) {
    const types = new Set<string>();
    for (const rec of records) {
      const info = extractGraphQLInfo(rec.request);
      if (info.variables && key in info.variables) {
        const val = info.variables[key];
        types.add(val === null ? 'null' : Array.isArray(val) ? 'array' : typeof val);
      }
    }
    shape[key] = types.size === 1 ? [...types][0] : 'mixed';
  }

  return shape;
}
