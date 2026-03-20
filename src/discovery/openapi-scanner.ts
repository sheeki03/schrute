import yaml from 'js-yaml';
import { getLogger } from '../core/logger.js';
import { normalizeOrigin } from '../core/utils.js';
import { resolveAndValidate } from '../core/policy.js';
import type { DiscoveredEndpoint, OpenApiScanResult } from './types.js';

const log = getLogger();

// ─── Known OpenAPI spec paths ────────────────────────────────────────

export const PROBE_PATHS = [
  '/openapi.json',
  '/openapi.yaml',
  '/swagger.json',
  '/api-docs',
  '/v2/api-docs',
  '/v3/api-docs',
  '/.well-known/openapi.json',
  '/api/openapi.json',
  '/spec.json',
  '/docs/openapi.json',
  '/swagger/v1/swagger.json',
  '/api/v1/openapi.json',
  '/api/swagger.json',
];

// ─── Public API ──────────────────────────────────────────────────────

export async function scanOpenApi(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
  pathFilter?: (path: string) => boolean,
): Promise<OpenApiScanResult> {
  const origin = normalizeOrigin(baseUrl);

  for (const probePath of PROBE_PATHS) {
    if (pathFilter && !pathFilter(probePath)) continue;
    const url = `${origin}${probePath}`;
    try {
      const resp = await fetchFn(url, {
        headers: { accept: 'application/json, application/yaml, */*' },
        signal: AbortSignal.timeout(10_000),
      });

      if (!resp.ok) continue;

      const text = await resp.text();
      const spec = parseSpec(text);
      if (!spec) continue;

      const version = detectVersion(spec);
      if (!version) continue;

      log.info({ url, version }, 'Found OpenAPI spec');

      const endpoints = version.startsWith('3')
        ? extractOpenApi3(spec)
        : extractSwagger2(spec);

      return {
        found: true,
        specVersion: version,
        endpoints,
        rawSpec: spec,
      };
    } catch (err) {
      log.debug({ err, url }, 'OpenAPI probe failed');
    }
  }

  return { found: false, endpoints: [] };
}

/**
 * Fetch and parse an OpenAPI spec at an exact URL (no path probing).
 */
export async function scanOpenApiAt(
  specUrl: string,
  allowedOrigin?: string,
  fetchFn: typeof fetch = fetch,
): Promise<OpenApiScanResult> {
  // SSRF guard: same-origin check
  if (allowedOrigin) {
    try {
      if (new URL(specUrl).origin !== allowedOrigin) {
        log.warn({ specUrl, allowedOrigin }, 'scanOpenApiAt blocked — origin mismatch');
        return { found: false, endpoints: [] };
      }
    } catch {
      return { found: false, endpoints: [] };
    }
  }

  // Public-IP validation (only when using real fetch)
  if (fetchFn === fetch) {
    try {
      const hostname = new URL(specUrl).hostname;
      const ipCheck = await resolveAndValidate(hostname);
      if (!ipCheck.allowed) {
        log.warn({ hostname, ip: ipCheck.ip, category: ipCheck.category }, 'scanOpenApiAt blocked — private IP');
        return { found: false, endpoints: [] };
      }
    } catch {
      return { found: false, endpoints: [] };
    }
  }

  try {
    const resp = await fetchFn(specUrl, {
      headers: { accept: 'application/json, application/yaml, */*' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      return { found: false, endpoints: [] };
    }

    const text = await resp.text();
    const spec = parseSpec(text);
    if (!spec) return { found: false, endpoints: [] };

    const version = detectVersion(spec);
    if (!version) return { found: false, endpoints: [] };

    log.info({ url: specUrl, version }, 'Found OpenAPI spec (exact URL)');

    const endpoints = version.startsWith('3')
      ? extractOpenApi3(spec)
      : extractSwagger2(spec);

    return {
      found: true,
      specVersion: version,
      endpoints,
      rawSpec: spec,
    };
  } catch (err) {
    log.debug({ err, url: specUrl }, 'scanOpenApiAt fetch failed');
    return { found: false, endpoints: [] };
  }
}

/**
 * Parse a pre-loaded OpenAPI spec object (no HTTP fetch needed).
 */
export function parseOpenApiSpec(spec: Record<string, unknown>): OpenApiScanResult {
  const version = detectVersion(spec);
  if (!version) return { found: false, endpoints: [] };
  const endpoints = version.startsWith('3') ? extractOpenApi3(spec) : extractSwagger2(spec);
  return { found: true, specVersion: version, endpoints, rawSpec: spec };
}

// ─── Parsing ─────────────────────────────────────────────────────────

function parseSpec(text: string): Record<string, unknown> | null {
  // Try JSON first
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Not JSON — fall through to YAML
  }

  // Try YAML via js-yaml
  try {
    const result = yaml.load(text);
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      return result as Record<string, unknown>;
    }
  } catch {
    // Not parseable
  }

  return null;
}

function detectVersion(spec: Record<string, unknown>): string | null {
  if (typeof spec.openapi === 'string' && spec.openapi.startsWith('3')) {
    return spec.openapi as string;
  }
  if (typeof spec.swagger === 'string' && spec.swagger.startsWith('2')) {
    return spec.swagger as string;
  }
  return null;
}

// ─── Unresolved Schema Detection ─────────────────────────────────────

const UNRESOLVED_KEYS = new Set(['$ref', 'allOf', 'anyOf', 'oneOf']);

function hasUnresolvedSchemaNodes(obj: unknown, depth = 0): boolean {
  if (depth > 10 || obj === null || obj === undefined || typeof obj !== 'object') return false;
  if (Array.isArray(obj)) return obj.some(item => hasUnresolvedSchemaNodes(item, depth + 1));
  const record = obj as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (UNRESOLVED_KEYS.has(key)) return true;
    if (hasUnresolvedSchemaNodes(record[key], depth + 1)) return true;
  }
  return false;
}

// ─── OpenAPI 3.x Extraction ─────────────────────────────────────────

function extractOpenApi3(spec: Record<string, unknown>): DiscoveredEndpoint[] {
  const paths = spec.paths as Record<string, Record<string, unknown>> | undefined;
  if (!paths) return [];

  const endpoints: DiscoveredEndpoint[] = [];

  for (const [pathStr, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;

    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      const operation = pathItem[method] as Record<string, unknown> | undefined;
      if (!operation) continue;

      const params = extractOpenApi3Params(pathItem, operation);
      const bodyResult = extractRequestBody3(operation);
      const inputSchema = bodyResult.schema;
      const outputSchema = extractResponse3(operation);

      // Detect unresolved refs in params and body
      const rawParams = mergeParams(
        pathItem.parameters as Record<string, unknown>[] | undefined,
        operation.parameters as Record<string, unknown>[] | undefined,
      );
      let unresolvedRefs = rawParams.some(p =>
        (typeof p === 'object' && p !== null && '$ref' in p) ||
        hasUnresolvedSchemaNodes((p as Record<string, unknown>).schema),
      );
      if (!unresolvedRefs && inputSchema) {
        unresolvedRefs = hasUnresolvedSchemaNodes(inputSchema);
      }

      const endpoint: DiscoveredEndpoint = {
        method: method.toUpperCase(),
        path: pathStr,
        description: (operation.summary ?? operation.description) as string | undefined,
        parameters: params.length > 0 ? params : undefined,
        inputSchema: inputSchema ?? undefined,
        outputSchema: outputSchema ?? undefined,
        source: 'openapi',
        trustLevel: 5,
      };

      if (bodyResult.hasNonJsonBody) {
        endpoint._hasNonJsonBody = true;
      }
      if (unresolvedRefs) {
        endpoint._hasUnresolvedRefs = true;
      }

      endpoints.push(endpoint);
    }
  }

  return endpoints;
}

/**
 * Merge path-level and operation-level parameters.
 * Operation params win on name+in collision.
 */
function mergeParams(
  pathParams: Record<string, unknown>[] | undefined,
  opParams: Record<string, unknown>[] | undefined,
): Record<string, unknown>[] {
  const pathLevel = Array.isArray(pathParams)
    ? pathParams.filter((p): p is Record<string, unknown> => p != null && typeof p === 'object')
    : [];
  const opLevel = Array.isArray(opParams)
    ? opParams.filter((p): p is Record<string, unknown> => p != null && typeof p === 'object')
    : [];

  if (pathLevel.length === 0) return opLevel;
  if (opLevel.length === 0) return pathLevel;

  // Operation-level overrides path-level on same name+in
  const opKeys = new Set(opLevel.map(p => `${String(p.name)}:${String(p.in)}`));
  const merged = [...opLevel];
  for (const p of pathLevel) {
    const key = `${String(p.name)}:${String(p.in)}`;
    if (!opKeys.has(key)) {
      merged.push(p);
    }
  }
  return merged;
}

function extractOpenApi3Params(
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>,
): { name: string; in: string; type: string; required?: boolean }[] {
  const merged = mergeParams(
    pathItem.parameters as Record<string, unknown>[] | undefined,
    operation.parameters as Record<string, unknown>[] | undefined,
  );

  return merged
    .filter((p): p is Record<string, unknown> => p != null && typeof p === 'object' && !('$ref' in p))
    .map(p => {
      const inValue = String(p.in ?? 'query');
      const required = inValue === 'path' ? true : Boolean(p.required);
      return {
        name: String(p.name ?? ''),
        in: inValue,
        type: extractSchemaType(p.schema as Record<string, unknown> | undefined),
        ...(required ? { required } : {}),
      };
    });
}

function extractRequestBody3(
  operation: Record<string, unknown>,
): { schema: Record<string, unknown> | null; hasNonJsonBody: boolean } {
  const body = operation.requestBody as Record<string, unknown> | undefined;
  if (!body) return { schema: null, hasNonJsonBody: false };

  const content = body.content as Record<string, Record<string, unknown>> | undefined;
  if (!content) return { schema: null, hasNonJsonBody: false };

  // Look for any JSON-compatible media type
  for (const [mediaType, mediaObj] of Object.entries(content)) {
    if (mediaType.includes('json') && mediaObj?.schema) {
      return { schema: mediaObj.schema as Record<string, unknown>, hasNonJsonBody: false };
    }
  }

  // Body exists but no JSON content type found
  return { schema: null, hasNonJsonBody: true };
}

function extractResponse3(operation: Record<string, unknown>): Record<string, unknown> | null {
  const responses = operation.responses as Record<string, Record<string, unknown>> | undefined;
  if (!responses) return null;

  // Prefer 200, then 201, then first 2xx
  const successResponse = responses['200'] ?? responses['201']
    ?? Object.entries(responses).find(([code]) => code.startsWith('2'))?.[1];

  if (!successResponse) return null;

  const content = successResponse.content as Record<string, Record<string, unknown>> | undefined;
  if (!content) return null;

  const jsonContent = content['application/json'];
  if (jsonContent?.schema) {
    return jsonContent.schema as Record<string, unknown>;
  }

  return null;
}

// ─── Swagger 2.0 Extraction ─────────────────────────────────────────

function extractSwagger2(spec: Record<string, unknown>): DiscoveredEndpoint[] {
  const paths = spec.paths as Record<string, Record<string, unknown>> | undefined;
  if (!paths) return [];

  const basePath = (spec.basePath as string) ?? '';
  const specConsumes = spec.consumes as string[] | undefined;
  const endpoints: DiscoveredEndpoint[] = [];

  for (const [pathStr, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;

    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      const operation = pathItem[method] as Record<string, unknown> | undefined;
      if (!operation) continue;

      const params = extractSwagger2Params(pathItem, operation);
      const bodySchema = extractSwagger2Body(pathItem, operation);
      const outputSchema = extractSwagger2Response(operation);

      const fullPath = basePath ? `${basePath}${pathStr}` : pathStr;

      // Detect non-JSON body via consumes
      const effectiveConsumes = (operation.consumes ?? specConsumes) as string[] | undefined;
      const hasJsonConsumes = !effectiveConsumes || effectiveConsumes.some(c => c.includes('json'));
      const hasNonJsonBody = Boolean(bodySchema) && !hasJsonConsumes;

      // Detect unresolved refs in params and body
      const rawMerged = mergeParams(
        pathItem.parameters as Record<string, unknown>[] | undefined,
        operation.parameters as Record<string, unknown>[] | undefined,
      );
      let unresolvedRefs = rawMerged.some(p =>
        (typeof p === 'object' && p !== null && '$ref' in p) ||
        hasUnresolvedSchemaNodes((p as Record<string, unknown>).schema) ||
        hasUnresolvedSchemaNodes((p as Record<string, unknown>).items),
      );
      if (!unresolvedRefs && bodySchema) {
        unresolvedRefs = hasUnresolvedSchemaNodes(bodySchema);
      }

      const endpoint: DiscoveredEndpoint = {
        method: method.toUpperCase(),
        path: fullPath,
        description: (operation.summary ?? operation.description) as string | undefined,
        parameters: params.length > 0 ? params : undefined,
        inputSchema: bodySchema ?? undefined,
        outputSchema: outputSchema ?? undefined,
        source: 'openapi',
        trustLevel: 5,
      };

      if (hasNonJsonBody) {
        endpoint._hasNonJsonBody = true;
      }
      if (unresolvedRefs) {
        endpoint._hasUnresolvedRefs = true;
      }

      endpoints.push(endpoint);
    }
  }

  return endpoints;
}

function extractSwagger2Params(
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>,
): { name: string; in: string; type: string; required?: boolean }[] {
  const merged = mergeParams(
    pathItem.parameters as Record<string, unknown>[] | undefined,
    operation.parameters as Record<string, unknown>[] | undefined,
  );

  return merged
    .filter((p): p is Record<string, unknown> =>
      p != null && typeof p === 'object' &&
      !('$ref' in p) &&
      (p.in as string) !== 'body' &&
      (p.in as string) !== 'formData',
    )
    .map(p => {
      const inValue = String(p.in ?? 'query');
      const required = inValue === 'path' ? true : Boolean(p.required);
      return {
        name: String(p.name ?? ''),
        in: inValue,
        type: String(p.type ?? 'string'),
        ...(required ? { required } : {}),
      };
    });
}

function extractSwagger2Body(
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>,
): Record<string, unknown> | null {
  const merged = mergeParams(
    pathItem.parameters as Record<string, unknown>[] | undefined,
    operation.parameters as Record<string, unknown>[] | undefined,
  );

  const bodyParam = merged.find(
    (p): p is Record<string, unknown> => p != null && typeof p === 'object' && (p.in as string) === 'body',
  );

  if (bodyParam?.schema) {
    return bodyParam.schema as Record<string, unknown>;
  }

  return null;
}

function extractSwagger2Response(operation: Record<string, unknown>): Record<string, unknown> | null {
  const responses = operation.responses as Record<string, Record<string, unknown>> | undefined;
  if (!responses) return null;

  const successResponse = responses['200'] ?? responses['201'];
  if (!successResponse) return null;

  if (successResponse.schema) {
    return successResponse.schema as Record<string, unknown>;
  }

  return null;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function extractSchemaType(schema: Record<string, unknown> | undefined): string {
  if (!schema) return 'string';
  return String(schema.type ?? 'string');
}
