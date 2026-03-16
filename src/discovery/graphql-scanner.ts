import { getLogger } from '../core/logger.js';
import { normalizeOrigin } from '../core/utils.js';
import { resolveAndValidate } from '../core/policy.js';
import type { DiscoveredEndpoint, GraphQLOperation, GraphQLScanResult } from './types.js';

const log = getLogger();

// ─── Standard GraphQL Introspection Query ────────────────────────────

const INTROSPECTION_QUERY = `
  query IntrospectionQuery {
    __schema {
      queryType { name }
      mutationType { name }
      types {
        kind
        name
        fields {
          name
          description
          args {
            name
            type {
              kind
              name
              ofType {
                kind
                name
                ofType {
                  kind
                  name
                }
              }
            }
          }
          type {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
              }
            }
          }
        }
      }
    }
  }
`;

// ─── Known GraphQL endpoints ─────────────────────────────────────────

export const GRAPHQL_PATHS = ['/graphql', '/api/graphql', '/gql'];

// ─── Public API ──────────────────────────────────────────────────────

export async function scanGraphQL(
  baseUrl: string,
  headers?: Record<string, string>,
  fetchFn: typeof fetch = fetch,
  pathFilter?: (path: string) => boolean,
): Promise<GraphQLScanResult> {
  const origin = normalizeOrigin(baseUrl);

  // SSRF protection: validate that the target hostname resolves to a public IP.
  // Skip when a custom fetchFn is provided (test/controlled mode).
  if (fetchFn === fetch) {
    try {
      const hostname = new URL(origin).hostname;
      const ipCheck = await resolveAndValidate(hostname);
      if (!ipCheck.allowed) {
        log.warn({ hostname, ip: ipCheck.ip, category: ipCheck.category }, 'GraphQL scan blocked — private IP');
        return { found: false, queries: [], mutations: [] };
      }
    } catch {
      // URL parse failure — let the fetch below handle it
    }
  }

  for (const gqlPath of GRAPHQL_PATHS) {
    if (pathFilter && !pathFilter(gqlPath)) continue;
    const url = `${origin}${gqlPath}`;
    try {
      const resp = await fetchFn(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...headers,
        },
        body: JSON.stringify({ query: INTROSPECTION_QUERY }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!resp.ok) continue;

      const json = (await resp.json()) as Record<string, unknown>;
      const data = json.data as Record<string, unknown> | undefined;
      if (!data?.__schema) continue;

      log.info({ url }, 'GraphQL introspection succeeded');

      const schema = data.__schema as IntrospectionSchema;
      const queries = extractOperations(schema, schema.queryType?.name ?? 'Query', 'query');
      const mutations = extractOperations(schema, schema.mutationType?.name ?? 'Mutation', 'mutation');

      return {
        found: true,
        queries,
        mutations,
      };
    } catch (err) {
      log.debug({ err, url }, 'GraphQL probe failed');
    }
  }

  return { found: false, queries: [], mutations: [] };
}

/**
 * Introspect a GraphQL endpoint at an exact URL (no path probing).
 */
export async function scanGraphQLAt(
  endpointUrl: string,
  allowedOrigin?: string,
  headers?: Record<string, string>,
  fetchFn: typeof fetch = fetch,
): Promise<GraphQLScanResult> {
  // SSRF guard: same-origin check
  if (allowedOrigin) {
    try {
      if (new URL(endpointUrl).origin !== allowedOrigin) {
        log.warn({ endpointUrl, allowedOrigin }, 'scanGraphQLAt blocked — origin mismatch');
        return { found: false, queries: [], mutations: [] };
      }
    } catch {
      return { found: false, queries: [], mutations: [] };
    }
  }

  // Public-IP validation (only when using real fetch)
  if (fetchFn === fetch) {
    try {
      const hostname = new URL(endpointUrl).hostname;
      const ipCheck = await resolveAndValidate(hostname);
      if (!ipCheck.allowed) {
        log.warn({ hostname, ip: ipCheck.ip, category: ipCheck.category }, 'scanGraphQLAt blocked — private IP');
        return { found: false, queries: [], mutations: [] };
      }
    } catch {
      return { found: false, queries: [], mutations: [] };
    }
  }

  try {
    const resp = await fetchFn(endpointUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...headers,
      },
      body: JSON.stringify({ query: INTROSPECTION_QUERY }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      return { found: false, queries: [], mutations: [] };
    }

    const json = (await resp.json()) as Record<string, unknown>;
    const data = json.data as Record<string, unknown> | undefined;
    if (!data?.__schema) {
      return { found: false, queries: [], mutations: [] };
    }

    log.info({ url: endpointUrl }, 'GraphQL introspection succeeded (exact URL)');

    const schema = data.__schema as IntrospectionSchema;
    const queries = extractOperations(schema, schema.queryType?.name ?? 'Query', 'query');
    const mutations = extractOperations(schema, schema.mutationType?.name ?? 'Mutation', 'mutation');

    return {
      found: true,
      queries,
      mutations,
    };
  } catch (err) {
    log.debug({ err, url: endpointUrl }, 'scanGraphQLAt failed');
    return { found: false, queries: [], mutations: [] };
  }
}

/**
 * Convert GraphQL scan results to DiscoveredEndpoint format.
 */
export function graphqlToEndpoints(
  result: GraphQLScanResult,
  basePath: string = '/graphql',
): DiscoveredEndpoint[] {
  if (!result.found) return [];

  const endpoints: DiscoveredEndpoint[] = [];

  for (const op of [...result.queries, ...result.mutations]) {
    endpoints.push({
      method: 'POST',
      path: `${basePath}#${op.type}.${op.name}`,
      description: op.name,
      parameters: op.args.map(a => ({ name: a.name, in: 'body', type: a.type })),
      source: 'graphql',
      trustLevel: 4,
    });
  }

  return endpoints;
}

// ─── Introspection Types ─────────────────────────────────────────────

interface IntrospectionSchema {
  queryType: { name: string } | null;
  mutationType: { name: string } | null;
  types: IntrospectionType[];
}

interface IntrospectionType {
  kind: string;
  name: string;
  fields?: IntrospectionField[] | null;
}

interface IntrospectionField {
  name: string;
  description?: string;
  args: IntrospectionArg[];
  type: IntrospectionTypeRef;
}

interface IntrospectionArg {
  name: string;
  type: IntrospectionTypeRef;
}

interface IntrospectionTypeRef {
  kind: string;
  name: string | null;
  ofType?: IntrospectionTypeRef | null;
}

// ─── Extraction ──────────────────────────────────────────────────────

function extractOperations(
  schema: IntrospectionSchema,
  rootTypeName: string,
  opType: 'query' | 'mutation' | 'subscription',
): GraphQLOperation[] {
  const rootType = schema.types.find(t => t.name === rootTypeName);
  if (!rootType?.fields) return [];

  return rootType.fields.map(field => ({
    name: field.name,
    type: opType,
    args: field.args.map(arg => ({
      name: arg.name,
      type: resolveTypeName(arg.type),
    })),
    returnType: resolveTypeName(field.type),
  }));
}

function resolveTypeName(ref: IntrospectionTypeRef): string {
  if (ref.name) return ref.name;
  if (ref.ofType) {
    const inner = resolveTypeName(ref.ofType);
    if (ref.kind === 'NON_NULL') return `${inner}!`;
    if (ref.kind === 'LIST') return `[${inner}]`;
    return inner;
  }
  return 'unknown';
}

