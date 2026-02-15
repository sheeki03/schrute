import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildRequest } from '../../src/replay/request-builder.js';
import { executeSkill } from '../../src/replay/executor.js';
import { parseResponse } from '../../src/replay/response-parser.js';
import { checkSemantic } from '../../src/replay/semantic-check.js';
import { createRestMockServer } from '../fixtures/mock-sites/rest-mock-server.js';
import type { SkillSpec, SealedFetchRequest, SealedFetchResponse } from '../../src/skill/types.js';
import { ExecutionTier } from '../../src/skill/types.js';

let mockServer: { url: string; close: () => Promise<void> };

function makeSkill(overrides: Partial<SkillSpec> = {}): SkillSpec {
  return {
    id: 'example_com.get_users.v1',
    version: 1,
    status: 'active',
    currentTier: 'tier_1',
    tierLock: null,
    allowedDomains: ['example.com'],
    requiredCapabilities: [],
    parameters: [],
    validation: {
      semanticChecks: ['schema_match', 'no_error_signatures'],
      customInvariants: [],
    },
    redaction: { piiClassesFound: [], fieldsRedacted: 0 },
    replayStrategy: 'prefer_tier_1',
    sideEffectClass: 'read-only',
    sampleCount: 5,
    consecutiveValidations: 5,
    confidence: 0.9,
    method: 'GET',
    pathTemplate: '/api/users',
    inputSchema: {},
    outputSchema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          name: { type: 'string' },
          email: { type: 'string' },
        },
        required: ['id', 'name'],
      },
    },
    isComposite: false,
    siteId: 'example.com',
    name: 'get_users',
    successRate: 1.0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as SkillSpec;
}

beforeAll(async () => {
  mockServer = await createRestMockServer();
});

afterAll(async () => {
  await mockServer.close();
});

// Creates a fetchFn that rewrites the skill's https URL to the local mock server's http URL
function makeFetchFn(serverUrl: string): (req: SealedFetchRequest) => Promise<SealedFetchResponse> {
  return async (req: SealedFetchRequest): Promise<SealedFetchResponse> => {
    // Replace the skill's https://domain base with the local http mock server URL
    const url = new URL(req.url);
    const localUrl = new URL(serverUrl);
    url.protocol = localUrl.protocol;
    url.hostname = localUrl.hostname;
    url.port = localUrl.port;

    const response = await fetch(url.toString(), {
      method: req.method,
      headers: req.headers,
      body: req.body,
    });
    const body = await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return { status: response.status, headers, body };
  };
}

describe('replay flow integration', () => {
  it('builds a request for a GET skill with correct URL and headers', () => {
    const skill = makeSkill({
      pathTemplate: '/api/users',
      method: 'GET',
    });

    const result = buildRequest(skill, {}, ExecutionTier.DIRECT);

    expect(result.method).toBe('GET');
    expect(result.url).toContain('/api/users');
    expect(result.headers['accept']).toBe('application/json');
  });

  it('executes a GET skill against the mock server with auth header', async () => {
    const skill = makeSkill({
      pathTemplate: '/api/users',
      method: 'GET',
      requiredHeaders: {
        authorization: 'Bearer token123',
      },
    });

    const result = await executeSkill(skill, {}, {
      fetchFn: makeFetchFn(mockServer.url),
      forceTier: ExecutionTier.DIRECT,
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe(200);
    expect(result.data).toBeInstanceOf(Array);
    expect((result.data as unknown[]).length).toBeGreaterThan(0);
  });

  it('parses response and validates schema match', async () => {
    const skill = makeSkill({
      pathTemplate: '/api/users',
      method: 'GET',
      requiredHeaders: {
        authorization: 'Bearer token123',
      },
    });

    const fetchFn = makeFetchFn(mockServer.url);
    // Build request and manually call the fetch
    const request = buildRequest(skill, {}, ExecutionTier.DIRECT);
    const response = await fetchFn(request);

    const parsed = parseResponse(
      { status: response.status, headers: response.headers, body: response.body },
      skill,
    );

    expect(parsed.schemaMatch).toBe(true);
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.data).toBeInstanceOf(Array);
  });

  it('runs semantic checks on a valid response', async () => {
    const skill = makeSkill({
      pathTemplate: '/api/users',
      method: 'GET',
      requiredHeaders: {
        authorization: 'Bearer token123',
      },
    });

    const fetchFn = makeFetchFn(mockServer.url);
    const request = buildRequest(skill, {}, ExecutionTier.DIRECT);
    const response = await fetchFn(request);

    const semantic = checkSemantic(
      { status: response.status, headers: response.headers, body: response.body },
      skill,
    );

    expect(semantic.pass).toBe(true);
    expect(semantic.details).toBeInstanceOf(Array);
    expect(semantic.details.some(d => d.includes('OK'))).toBe(true);
  });

  it('handles 401 unauthorized correctly', async () => {
    const skill = makeSkill({
      pathTemplate: '/api/users',
      method: 'GET',
      authType: 'bearer',
      // No auth header -> mock server returns 401
    });

    const result = await executeSkill(skill, {}, {
      fetchFn: makeFetchFn(mockServer.url),
      forceTier: ExecutionTier.DIRECT,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(401);
    expect(result.failureCause).toBe('auth_expired');
  });

  it('full replay flow: build -> execute -> parse -> semantic check', async () => {
    const skill = makeSkill({
      pathTemplate: '/api/users',
      method: 'GET',
      requiredHeaders: {
        authorization: 'Bearer token123',
      },
    });

    // Step 1: Build request
    const request = buildRequest(skill, {}, ExecutionTier.DIRECT);
    expect(request.url).toContain('/api/users');

    // Step 2: Execute via fetchFn
    const fetchFn = makeFetchFn(mockServer.url);
    const response = await fetchFn(request);
    expect(response.status).toBe(200);

    // Step 3: Parse
    const parsed = parseResponse(
      { status: response.status, headers: response.headers, body: response.body },
      skill,
    );
    expect(parsed.schemaMatch).toBe(true);

    // Step 4: Semantic check
    const semantic = checkSemantic(
      { status: response.status, headers: response.headers, body: response.body },
      skill,
    );
    expect(semantic.pass).toBe(true);

    // Overall: all checks pass
    const overallSuccess =
      response.status >= 200 &&
      response.status < 300 &&
      parsed.schemaMatch &&
      semantic.pass &&
      parsed.errors.length === 0;
    expect(overallSuccess).toBe(true);
  });
});
