import { z } from 'zod';
import { getLogger } from '../core/logger.js';
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
  let url = spec.pathTemplate;
  const pathParamNames = extractPathParams(spec.pathTemplate);

  for (const paramName of pathParamNames) {
    if (paramName in params) {
      url = url.replace(
        `{${paramName}}`,
        encodeURIComponent(String(params[paramName])),
      );
    }
  }

  // Ensure full URL
  if (!url.startsWith('http')) {
    const domain = spec.allowedDomains[0] ?? spec.siteId;
    url = `https://${domain}${url}`;
  }

  // Build headers
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(spec.requiredHeaders ?? {}),
  };

  // Inject auth if recipe is present
  if (authRecipe) {
    injectAuth(headers, authRecipe);
  }

  // Build body or query params
  let body: string | undefined;
  const upperMethod = spec.method.toUpperCase();

  if (upperMethod === 'POST' || upperMethod === 'PUT' || upperMethod === 'PATCH') {
    const bodyParams: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (!pathParamNames.includes(key)) {
        bodyParams[key] = value;
      }
    }
    if (Object.keys(bodyParams).length > 0) {
      body = JSON.stringify(bodyParams);
      headers['content-type'] = 'application/json';
    }
  } else if (upperMethod === 'GET' || upperMethod === 'HEAD') {
    const queryEntries: string[] = [];
    for (const [key, value] of Object.entries(params)) {
      if (!pathParamNames.includes(key)) {
        queryEntries.push(
          `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
        );
      }
    }
    if (queryEntries.length > 0) {
      const separator = url.includes('?') ? '&' : '?';
      url = `${url}${separator}${queryEntries.join('&')}`;
    }
  }

  return { url, method: spec.method, headers, body };
}

// ─── Auth Injection ─────────────────────────────────────────────

function injectAuth(
  headers: Record<string, string>,
  recipe: AuthRecipe,
): void {
  // Auth injection is based on the recipe's injection config.
  // The actual secret values come from the secrets store at runtime.
  // Here we set the header structure; the caller is responsible for
  // populating the actual credential value.
  if (recipe.injection.location === 'header') {
    const prefix = recipe.injection.prefix ?? '';
    headers[recipe.injection.key] = `${prefix}{{SECRET}}`;
  }
  // Cookie and query injection would be handled similarly but
  // are deferred to the browser/cookie-jar layer.
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

// ─── Helpers ────────────────────────────────────────────────────

function extractPathParams(template: string): string[] {
  const matches = template.match(/\{(\w+)\}/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(1, -1));
}

async function defaultFetch(req: SealedFetchRequest): Promise<SealedFetchResponse> {
  const response = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
  });

  const body = await response.text();
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    status: response.status,
    headers,
    body,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Execution timed out after ${ms}ms`));
    }, ms);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}
