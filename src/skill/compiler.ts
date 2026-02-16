import { z } from 'zod';
import { getLogger } from '../core/logger.js';
import { defaultFetch, withTimeout } from '../core/utils.js';
import { injectAuth, resolveUrl, buildDefaultHeaders, buildBodyOrQuery } from '../replay/request-builder.js';
import type {
  SkillSpec,
  TierStateName,
  AuthRecipe,
  SealedFetchRequest,
  SealedFetchResponse,
} from './types.js';
import { TierState } from './types.js';

const log = getLogger();

// ─── Types ──────────────────────────────────────────────────────

export interface CompiledSkill {
  spec: SkillSpec;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  execute: (
    params: Record<string, unknown>,
    tier: TierStateName,
    options?: ExecutionOptions,
  ) => Promise<ExecutionResult>;
}

export interface ExecutionResult {
  success: boolean;
  status: number;
  headers: Record<string, string>;
  body: unknown;
  rawBody: string;
  latencyMs: number;
}

export interface ExecutionOptions {
  fetchFn?: (req: SealedFetchRequest) => Promise<SealedFetchResponse>;
  authRecipe?: AuthRecipe;
  timeoutMs?: number;
}

// ─── Compile Skill ──────────────────────────────────────────────

export function compileSkill(spec: SkillSpec): CompiledSkill {
  const inputSchema = buildInputZodSchema(spec);
  const outputSchema = buildOutputZodSchema(spec);

  return {
    spec,
    inputSchema,
    outputSchema,
    execute: (params, tier, options) =>
      executeSkill(spec, params, tier, inputSchema, options),
  };
}

// ─── Execution ──────────────────────────────────────────────────

async function executeSkill(
  spec: SkillSpec,
  params: Record<string, unknown>,
  tier: TierStateName,
  inputSchema: z.ZodType,
  options?: ExecutionOptions,
): Promise<ExecutionResult> {
  const startTime = Date.now();
  const fetchFn = options?.fetchFn ?? defaultFetch;

  // Validate input
  const parseResult = inputSchema.safeParse(params);
  if (!parseResult.success) {
    throw new Error(
      `Input validation failed: ${parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }

  // Build the HTTP request
  const request = buildHttpRequest(spec, params, tier, options?.authRecipe);

  log.debug(
    { skillId: spec.id, tier, method: request.method, url: request.url },
    'Executing compiled skill',
  );

  // Execute with timeout
  const timeoutMs = options?.timeoutMs ?? 30000;
  let response: SealedFetchResponse;
  try {
    response = await withTimeout(fetchFn(request), timeoutMs);
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    log.warn({ skillId: spec.id, err, latencyMs }, 'Skill execution failed');
    return {
      success: false,
      status: 0,
      headers: {},
      body: null,
      rawBody: '',
      latencyMs,
    };
  }

  const latencyMs = Date.now() - startTime;

  // Parse response body
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(response.body);
  } catch {
    parsedBody = response.body;
  }

  const success = response.status >= 200 && response.status < 300;

  return {
    success,
    status: response.status,
    headers: response.headers,
    body: parsedBody,
    rawBody: response.body,
    latencyMs,
  };
}

// ─── HTTP Request Building ──────────────────────────────────────

function buildHttpRequest(
  spec: SkillSpec,
  params: Record<string, unknown>,
  tier: TierStateName,
  authRecipe?: AuthRecipe,
): SealedFetchRequest {
  // Resolve parameterized URL
  const resolved = resolveUrl(spec.pathTemplate, params, spec.allowedDomains, spec.siteId);
  const headers = buildDefaultHeaders(spec.requiredHeaders);

  // Inject auth if recipe is present
  if (authRecipe) {
    injectAuth(headers, authRecipe);
  }

  // Build body or query params
  const bodyResult = buildBodyOrQuery(spec.method, resolved.url, params, resolved.pathParamNames, headers);

  return { url: bodyResult.url, method: spec.method, headers, body: bodyResult.body };
}

// ─── Zod Schema Building ────────────────────────────────────────

function buildInputZodSchema(spec: SkillSpec): z.ZodType {
  const schema = spec.inputSchema;
  if (!schema || Object.keys(schema).length === 0) {
    return z.record(z.unknown());
  }

  return jsonSchemaToZod(schema);
}

function buildOutputZodSchema(spec: SkillSpec): z.ZodType {
  if (!spec.outputSchema || Object.keys(spec.outputSchema).length === 0) {
    return z.unknown();
  }

  return jsonSchemaToZod(spec.outputSchema);
}

/**
 * Simplified JSON Schema to Zod converter.
 * Handles the common cases for API schemas.
 */
function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType {
  const type = schema.type as string | undefined;

  if (type === 'object') {
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    const required = (schema.required ?? []) as string[];

    if (!properties) {
      return z.record(z.unknown());
    }

    const shape: Record<string, z.ZodType> = {};
    for (const [key, propSchema] of Object.entries(properties)) {
      let fieldSchema = jsonSchemaToZod(propSchema);
      if (!required.includes(key)) {
        fieldSchema = fieldSchema.optional();
      }
      shape[key] = fieldSchema;
    }

    return z.object(shape);
  }

  if (type === 'array') {
    const items = schema.items as Record<string, unknown> | undefined;
    if (items) {
      return z.array(jsonSchemaToZod(items));
    }
    return z.array(z.unknown());
  }

  if (type === 'string') return z.string();
  if (type === 'number' || type === 'integer') return z.number();
  if (type === 'boolean') return z.boolean();
  if (type === 'null') return z.null();

  return z.unknown();
}

