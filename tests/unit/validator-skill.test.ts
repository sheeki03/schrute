import { describe, it, expect, vi } from 'vitest';

// ─── Mock logger ─────────────────────────────────────────────────
vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { validateSkill } from '../../src/skill/validator.js';
import type { SkillSpec, SealedFetchRequest, SealedFetchResponse } from '../../src/skill/types.js';

function makeSkill(overrides?: Partial<SkillSpec>): SkillSpec {
  return {
    id: 'test.get_data.v1',
    siteId: 'example.com',
    name: 'get_data',
    version: 1,
    status: 'active',
    method: 'GET',
    pathTemplate: '/api/data',
    inputSchema: {},
    sideEffectClass: 'read-only',
    isComposite: false,
    currentTier: 'tier_1',
    tierLock: null,
    confidence: 0.9,
    consecutiveValidations: 5,
    sampleCount: 10,
    successRate: 0.98,
    allowedDomains: ['example.com'],
    requiredCapabilities: [],
    parameters: [],
    validation: { semanticChecks: [], customInvariants: [] },
    redaction: { piiClassesFound: [], fieldsRedacted: 0 },
    replayStrategy: 'prefer_tier_1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as SkillSpec;
}

function mockFetch(response: Partial<SealedFetchResponse>): (req: SealedFetchRequest) => Promise<SealedFetchResponse> {
  return async () => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: '{"data": [1, 2, 3]}',
    ...response,
  });
}

describe('skill/validator', () => {
  describe('buildRequest (via validateSkill)', () => {
    it('sends GET request to correct URL', async () => {
      let capturedReq: SealedFetchRequest | null = null;
      const result = await validateSkill(
        makeSkill({ pathTemplate: '/api/users' }),
        {},
        {
          fetchFn: async (req) => {
            capturedReq = req;
            return { status: 200, headers: {}, body: '{}' };
          },
        },
      );

      expect(capturedReq).not.toBeNull();
      expect(capturedReq!.url).toContain('/api/users');
      expect(capturedReq!.method).toBe('GET');
    });

    it('resolves path parameters in URL', async () => {
      let capturedReq: SealedFetchRequest | null = null;
      await validateSkill(
        makeSkill({ pathTemplate: '/api/users/{userId}' }),
        { userId: '42' },
        {
          fetchFn: async (req) => {
            capturedReq = req;
            return { status: 200, headers: {}, body: '{}' };
          },
        },
      );

      expect(capturedReq!.url).toContain('/api/users/42');
    });

    it('adds query params for GET request', async () => {
      let capturedReq: SealedFetchRequest | null = null;
      await validateSkill(
        makeSkill({ method: 'GET', pathTemplate: '/api/search' }),
        { q: 'test', page: '1' },
        {
          fetchFn: async (req) => {
            capturedReq = req;
            return { status: 200, headers: {}, body: '{}' };
          },
        },
      );

      expect(capturedReq!.url).toContain('q=test');
      expect(capturedReq!.url).toContain('page=1');
    });

    it('sends body for POST request', async () => {
      let capturedReq: SealedFetchRequest | null = null;
      await validateSkill(
        makeSkill({ method: 'POST', pathTemplate: '/api/users' }),
        { name: 'John', email: 'john@example.com' },
        {
          fetchFn: async (req) => {
            capturedReq = req;
            return { status: 200, headers: {}, body: '{}' };
          },
        },
      );

      expect(capturedReq!.body).toBeDefined();
      const body = JSON.parse(capturedReq!.body!);
      expect(body.name).toBe('John');
      expect(body.email).toBe('john@example.com');
    });
  });

  describe('detectErrorSignatures', () => {
    it('detects json_error_field in 200 response', async () => {
      const result = await validateSkill(
        makeSkill(),
        {},
        { fetchFn: mockFetch({ body: '{"error": "something went wrong"}' }) },
      );

      expect(result.errorSignatures).toContain('json_error_field');
      expect(result.success).toBe(false);
    });

    it('detects session_expired in response body', async () => {
      const result = await validateSkill(
        makeSkill(),
        {},
        { fetchFn: mockFetch({ body: 'Your session expired, please log in again' }) },
      );

      expect(result.errorSignatures).toContain('session_expired');
      expect(result.success).toBe(false);
    });

    it('detects please_refresh in response body', async () => {
      const result = await validateSkill(
        makeSkill(),
        {},
        { fetchFn: mockFetch({ body: 'Please refresh your browser to continue' }) },
      );

      expect(result.errorSignatures).toContain('please_refresh');
      expect(result.success).toBe(false);
    });

    it('no error signatures for clean response', async () => {
      const result = await validateSkill(
        makeSkill(),
        {},
        { fetchFn: mockFetch({ body: '{"data": [1, 2, 3]}' }) },
      );

      expect(result.errorSignatures).toHaveLength(0);
    });

    it('skips error detection for non-200 responses', async () => {
      const result = await validateSkill(
        makeSkill(),
        {},
        { fetchFn: mockFetch({ status: 404, body: '{"error": "not found"}' }) },
      );

      // Error signatures check only runs on 200-range responses
      expect(result.errorSignatures).toHaveLength(0);
      expect(result.success).toBe(false);
    });
  });

  describe('schema matching', () => {
    it('passes when no output schema defined', async () => {
      const result = await validateSkill(
        makeSkill({ outputSchema: undefined }),
        {},
        { fetchFn: mockFetch({ body: '{"anything": true}' }) },
      );

      expect(result.schemaMatch).toBe(true);
    });

    it('passes when required keys are present', async () => {
      const result = await validateSkill(
        makeSkill({
          outputSchema: {
            type: 'object',
            properties: { data: { type: 'array' } },
            required: ['data'],
          },
        }),
        {},
        { fetchFn: mockFetch({ body: '{"data": [1, 2]}' }) },
      );

      expect(result.schemaMatch).toBe(true);
    });

    it('fails when required keys are missing', async () => {
      const result = await validateSkill(
        makeSkill({
          outputSchema: {
            type: 'object',
            properties: { data: { type: 'array' } },
            required: ['data'],
          },
        }),
        {},
        { fetchFn: mockFetch({ body: '{"other": "value"}' }) },
      );

      expect(result.schemaMatch).toBe(false);
    });

    it('fails for non-JSON response body', async () => {
      const result = await validateSkill(
        makeSkill({
          outputSchema: {
            type: 'object',
            properties: { data: {} },
            required: ['data'],
          },
        }),
        {},
        { fetchFn: mockFetch({ body: 'not json' }) },
      );

      expect(result.schemaMatch).toBe(false);
    });
  });

  describe('overall validation result', () => {
    it('succeeds for 200 with no errors', async () => {
      const result = await validateSkill(
        makeSkill(),
        {},
        { fetchFn: mockFetch({ status: 200, body: '{"data": []}' }) },
      );

      expect(result.success).toBe(true);
      expect(result.responseStatus).toBe(200);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('fails for non-200 status', async () => {
      const result = await validateSkill(
        makeSkill(),
        {},
        { fetchFn: mockFetch({ status: 500 }) },
      );

      expect(result.success).toBe(false);
    });

    it('fails on fetch error', async () => {
      const result = await validateSkill(
        makeSkill(),
        {},
        {
          fetchFn: async () => {
            throw new Error('Network error');
          },
        },
      );

      expect(result.success).toBe(false);
      expect(result.errorSignatures).toContain('fetch_error');
    });
  });

  describe('custom invariants', () => {
    it('evaluates "must include field X" invariant', async () => {
      const result = await validateSkill(
        makeSkill({
          validation: {
            semanticChecks: [],
            customInvariants: ['must include field data'],
          },
        }),
        {},
        { fetchFn: mockFetch({ body: '{"data": [1, 2]}' }) },
      );

      const invariant = result.invariantResults.find((r) => r.name === 'must include field data');
      expect(invariant).toBeDefined();
      expect(invariant!.passed).toBe(true);
    });

    it('fails "must include field X" when field missing', async () => {
      const result = await validateSkill(
        makeSkill({
          validation: {
            semanticChecks: [],
            customInvariants: ['must include field data'],
          },
        }),
        {},
        { fetchFn: mockFetch({ body: '{"other": "value"}' }) },
      );

      const invariant = result.invariantResults.find((r) => r.name === 'must include field data');
      expect(invariant).toBeDefined();
      expect(invariant!.passed).toBe(false);
    });

    it('evaluates "must not contain marker X" invariant', async () => {
      const result = await validateSkill(
        makeSkill({
          validation: {
            semanticChecks: [],
            customInvariants: ['must not contain marker ERROR'],
          },
        }),
        {},
        { fetchFn: mockFetch({ body: '{"status": "ok"}' }) },
      );

      const invariant = result.invariantResults.find((r) => r.name === 'must not contain marker ERROR');
      expect(invariant).toBeDefined();
      expect(invariant!.passed).toBe(true);
    });

    it('evaluates "field X must be non-empty" invariant', async () => {
      const result = await validateSkill(
        makeSkill({
          validation: {
            semanticChecks: [],
            customInvariants: ['field items must be non-empty'],
          },
        }),
        {},
        { fetchFn: mockFetch({ body: '{"items": [1, 2, 3]}' }) },
      );

      const invariant = result.invariantResults.find((r) => r.name === 'field items must be non-empty');
      expect(invariant).toBeDefined();
      expect(invariant!.passed).toBe(true);
    });
  });
});
