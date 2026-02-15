import { getLogger } from '../core/logger.js';
import type { DiscoveredEndpoint, OpenApiScanResult } from './types.js';

const log = getLogger();

// ─── Known OpenAPI spec paths ────────────────────────────────────────

const PROBE_PATHS = [
  '/openapi.json',
  '/openapi.yaml',
  '/swagger.json',
  '/api-docs',
  '/v2/api-docs',
  '/v3/api-docs',
  '/.well-known/openapi.json',
  '/api/openapi.json',
];

// ─── Public API ──────────────────────────────────────────────────────

export async function scanOpenApi(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<OpenApiScanResult> {
  const origin = normalizeOrigin(baseUrl);

  for (const probePath of PROBE_PATHS) {
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

      const endpoints = version.startsWith('2')
        ? extractSwagger2(spec)
        : extractOpenApi3(spec);

      return {
        found: true,
        specVersion: version,
        endpoints,
        rawSpec: spec,
      };
    } catch {
      // Probe failed, try next path
    }
  }

  return { found: false, endpoints: [] };
}

// ─── Parsing ─────────────────────────────────────────────────────────

function parseSpec(text: string): Record<string, unknown> | null {
  // Try JSON first
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Not JSON, try basic YAML parsing (key: value on separate lines)
  }

  // Minimal YAML parse — only enough to detect if it's an OpenAPI spec.
  // For full YAML, a production system would use a YAML library.
  try {
    if (text.includes('openapi:') || text.includes('swagger:')) {
      // Attempt naive YAML-to-JSON conversion for simple specs
      const jsonStr = yamlToJson(text);
      return JSON.parse(jsonStr) as Record<string, unknown>;
    }
  } catch {
    // Not parseable
  }

  return null;
}

function yamlToJson(yaml: string): string {
  // Very minimal YAML conversion — handles flat key-value pairs.
  // This is intentionally limited; real YAML parsing should use js-yaml.
  const lines = yaml.split('\n');
  const obj: Record<string, unknown> = {};
  for (const line of lines) {
    const match = line.match(/^(\w[\w.-]*):\s*(.+)$/);
    if (match) {
      const val = match[2].trim();
      obj[match[1]] = val.replace(/^['"]|['"]$/g, '');
    }
  }
  return JSON.stringify(obj);
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

      const params = extractOpenApi3Params(operation);
      const inputSchema = extractRequestBody3(operation);
      const outputSchema = extractResponse3(operation);

      endpoints.push({
        method: method.toUpperCase(),
        path: pathStr,
        description: (operation.summary ?? operation.description) as string | undefined,
        parameters: params.length > 0 ? params : undefined,
        inputSchema: inputSchema ?? undefined,
        outputSchema: outputSchema ?? undefined,
        source: 'openapi',
        trustLevel: 5,
      });
    }
  }

  return endpoints;
}

function extractOpenApi3Params(
  operation: Record<string, unknown>,
): { name: string; in: string; type: string }[] {
  const raw = operation.parameters as Record<string, unknown>[] | undefined;
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((p): p is Record<string, unknown> => p != null && typeof p === 'object')
    .map(p => ({
      name: String(p.name ?? ''),
      in: String(p.in ?? 'query'),
      type: extractSchemaType(p.schema as Record<string, unknown> | undefined),
    }));
}

function extractRequestBody3(operation: Record<string, unknown>): Record<string, unknown> | null {
  const body = operation.requestBody as Record<string, unknown> | undefined;
  if (!body) return null;

  const content = body.content as Record<string, Record<string, unknown>> | undefined;
  if (!content) return null;

  const jsonContent = content['application/json'];
  if (jsonContent?.schema) {
    return jsonContent.schema as Record<string, unknown>;
  }

  // Return first available schema
  for (const mediaType of Object.values(content)) {
    if (mediaType?.schema) {
      return mediaType.schema as Record<string, unknown>;
    }
  }

  return null;
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
  const endpoints: DiscoveredEndpoint[] = [];

  for (const [pathStr, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;

    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      const operation = pathItem[method] as Record<string, unknown> | undefined;
      if (!operation) continue;

      const params = extractSwagger2Params(operation);
      const bodyParam = extractSwagger2Body(operation);
      const outputSchema = extractSwagger2Response(operation);

      const fullPath = basePath ? `${basePath}${pathStr}` : pathStr;

      endpoints.push({
        method: method.toUpperCase(),
        path: fullPath,
        description: (operation.summary ?? operation.description) as string | undefined,
        parameters: params.length > 0 ? params : undefined,
        inputSchema: bodyParam ?? undefined,
        outputSchema: outputSchema ?? undefined,
        source: 'openapi',
        trustLevel: 5,
      });
    }
  }

  return endpoints;
}

function extractSwagger2Params(
  operation: Record<string, unknown>,
): { name: string; in: string; type: string }[] {
  const raw = operation.parameters as Record<string, unknown>[] | undefined;
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((p): p is Record<string, unknown> =>
      p != null && typeof p === 'object' && (p.in as string) !== 'body',
    )
    .map(p => ({
      name: String(p.name ?? ''),
      in: String(p.in ?? 'query'),
      type: String(p.type ?? 'string'),
    }));
}

function extractSwagger2Body(operation: Record<string, unknown>): Record<string, unknown> | null {
  const raw = operation.parameters as Record<string, unknown>[] | undefined;
  if (!Array.isArray(raw)) return null;

  const bodyParam = raw.find(
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

function normalizeOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    return url.replace(/\/+$/, '');
  }
}
