import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHar, extractRequestResponse } from '../../src/capture/har-extractor.js';
import { detectAuth } from '../../src/capture/auth-detector.js';
import { executeSkill } from '../../src/replay/executor.js';
import { createAuthMockServer } from '../fixtures/mock-sites/auth-mock-server.js';
import type { SkillSpec, SealedFetchRequest, SealedFetchResponse } from '../../src/skill/types.js';
import { ExecutionTier, Capability } from '../../src/skill/types.js';
import { setSitePolicy } from '../../src/core/policy.js';

// Mock resolveAndValidate to avoid real DNS lookups in tests
vi.mock('../../src/core/policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/policy.js')>();
  return {
    ...actual,
    resolveAndValidate: vi.fn().mockResolvedValue({ ip: '127.0.0.1', allowed: true, category: 'unicast' }),
  };
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const harDir = join(__dirname, '..', 'fixtures', 'har-files');

let authServer: { url: string; close: () => Promise<void> };

function makeSkill(overrides: Partial<SkillSpec> = {}): SkillSpec {
  return {
    id: 'example_com.protected.v1',
    version: 1,
    status: 'active',
    currentTier: 'tier_1',
    tierLock: null,
    allowedDomains: ['example.com'],
    requiredCapabilities: [],
    parameters: [],
    validation: {
      semanticChecks: ['no_error_signatures'],
      customInvariants: [],
    },
    redaction: { piiClassesFound: [], fieldsRedacted: 0 },
    replayStrategy: 'prefer_tier_1',
    sideEffectClass: 'read-only',
    sampleCount: 5,
    consecutiveValidations: 5,
    confidence: 0.9,
    method: 'GET',
    pathTemplate: '/api/protected',
    inputSchema: {},
    isComposite: false,
    siteId: 'example.com',
    name: 'protected_resource',
    successRate: 1.0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as SkillSpec;
}

// Creates a fetchFn that rewrites the skill's https URL to the local mock server's http URL
function makeFetchFn(serverUrl: string): (req: SealedFetchRequest) => Promise<SealedFetchResponse> {
  return async (req: SealedFetchRequest): Promise<SealedFetchResponse> => {
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

beforeAll(async () => {
  authServer = await createAuthMockServer();
});

afterAll(async () => {
  await authServer.close();
});

beforeEach(() => {
  // Set up site policy so executor's policy gates pass
  setSitePolicy({
    siteId: 'example.com',
    allowedMethods: ['GET', 'HEAD', 'POST'],
    maxQps: 10,
    maxConcurrent: 3,
    readOnlyDefault: true,
    requireConfirmation: [],
    domainAllowlist: ['example.com', 'localhost', '127.0.0.1'],
    redactionRules: [],
    capabilities: [
      Capability.NET_FETCH_DIRECT,
      Capability.NET_FETCH_BROWSER_PROXIED,
      Capability.BROWSER_AUTOMATION,
      Capability.STORAGE_WRITE,
      Capability.SECRETS_USE,
    ],
  });
});

describe('auth flow integration', () => {
  it('detects bearer token auth pattern from HAR', () => {
    const har = parseHar(join(harDir, 'auth-flow.har'));
    const records = har.log.entries.map(extractRequestResponse);
    const authRecipe = detectAuth(records);

    expect(authRecipe).not.toBeNull();
    // The auth-flow.har has both bearer tokens and a token/refresh endpoint.
    // detectAuth tries OAuth2 first, then bearer.
    expect(['oauth2', 'bearer']).toContain(authRecipe!.type);
    expect(authRecipe!.injection.location).toBe('header');
    expect(authRecipe!.injection.key).toBe('Authorization');
  });

  it('detects bearer token pattern in requests with Authorization header', () => {
    const har = parseHar(join(harDir, 'auth-flow.har'));
    const records = har.log.entries.map(extractRequestResponse);

    const withBearer = records.filter(
      r => r.request.headers['authorization']?.startsWith('Bearer '),
    );
    expect(withBearer.length).toBeGreaterThan(0);

    const authRecipe = detectAuth(records);
    expect(authRecipe).not.toBeNull();
    expect(authRecipe!.injection.prefix).toBe('Bearer ');
  });

  it('executes authenticated request against auth mock server', async () => {
    // Step 1: Login to get a token
    const loginResponse = await fetch(`${authServer.url}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice@example.com', password: 'password123' }),
    });
    expect(loginResponse.status).toBe(200);
    const loginData = await loginResponse.json() as { access_token: string };
    const accessToken = loginData.access_token;
    expect(accessToken).toBeTruthy();

    // Step 2: Execute skill with the obtained token
    const skill = makeSkill({
      authType: 'bearer',
      requiredHeaders: {
        authorization: `Bearer ${accessToken}`,
      },
    });

    const result = await executeSkill(skill, {}, {
      fetchFn: makeFetchFn(authServer.url),
      forceTier: ExecutionTier.DIRECT,
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe(200);
    const data = result.data as { message: string; userId: number };
    expect(data.message).toBe('Protected resource accessed');
  });

  it('fails authentication with invalid token', async () => {
    const skill = makeSkill({
      authType: 'bearer',
      requiredHeaders: {
        authorization: 'Bearer invalid_token_here',
      },
    });

    const result = await executeSkill(skill, {}, {
      fetchFn: makeFetchFn(authServer.url),
      forceTier: ExecutionTier.DIRECT,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(401);
    expect(result.failureCause).toBe('auth_expired');
  });

  it('detects refresh triggers in auth HAR', () => {
    const har = parseHar(join(harDir, 'auth-flow.har'));
    const records = har.log.entries.map(extractRequestResponse);
    const authRecipe = detectAuth(records);

    expect(authRecipe).not.toBeNull();
    expect(authRecipe!.refreshTriggers).toBeInstanceOf(Array);
    expect(authRecipe!.refreshTriggers.length).toBeGreaterThan(0);
    expect(authRecipe!.refreshTriggers).toContain('401');
  });
});
