import { describe, it, expect, vi } from 'vitest';
import { compileSkill, type CompiledSkill, type ExecutionResult } from '../../src/skill/compiler.js';
import { generateSkill, type ClusterInfo } from '../../src/skill/generator.js';
import type { SealedFetchRequest, SealedFetchResponse } from '../../src/skill/types.js';

// ─── Helpers ──────────────────────────────────────────────────────

function makeCluster(overrides: Partial<ClusterInfo> = {}): ClusterInfo {
  return {
    method: 'GET',
    pathTemplate: '/api/users/{id}',
    actionName: 'getUser',
    description: 'Fetch a user by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    sampleCount: 5,
    ...overrides,
  };
}

function makePostCluster(): ClusterInfo {
  return makeCluster({
    method: 'POST',
    pathTemplate: '/api/users',
    actionName: 'createUser',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['name'],
    },
  });
}

function makeMockFetch(
  status = 200,
  body = '{"ok":true}',
  headers: Record<string, string> = {},
): (req: SealedFetchRequest) => Promise<SealedFetchResponse> {
  return vi.fn().mockResolvedValue({ status, headers, body });
}

// ─── Tests ────────────────────────────────────────────────────────

describe('compiler', () => {
  describe('compileSkill', () => {
    it('returns a CompiledSkill with spec, schemas, and execute function', () => {
      const spec = generateSkill('example.com', makeCluster());
      const compiled = compileSkill(spec);

      expect(compiled.spec).toBe(spec);
      expect(compiled.inputSchema).toBeDefined();
      expect(compiled.outputSchema).toBeDefined();
      expect(typeof compiled.execute).toBe('function');
    });

    it('generates Zod schema that validates correct input', () => {
      const spec = generateSkill('example.com', makeCluster());
      const compiled = compileSkill(spec);

      const result = compiled.inputSchema.safeParse({ id: '123' });
      expect(result.success).toBe(true);
    });

    it('generates Zod schema that rejects invalid input', () => {
      const spec = generateSkill('example.com', makeCluster());
      const compiled = compileSkill(spec);

      // 'id' is required as string, passing number should fail
      const result = compiled.inputSchema.safeParse({ id: 123 });
      expect(result.success).toBe(false);
    });
  });

  describe('execute', () => {
    it('makes a GET request with path params substituted', async () => {
      const spec = generateSkill('example.com', makeCluster());
      const compiled = compileSkill(spec);
      const mockFetch = makeMockFetch();

      const result = await compiled.execute(
        { id: '42' },
        'tier_3',
        { fetchFn: mockFetch },
      );

      expect(result.success).toBe(true);
      expect(result.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const request = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as SealedFetchRequest;
      expect(request.url).toContain('/api/users/42');
      expect(request.method).toBe('GET');
    });

    it('sends body as JSON for POST requests', async () => {
      const spec = generateSkill('example.com', makePostCluster());
      const compiled = compileSkill(spec);
      const mockFetch = makeMockFetch();

      await compiled.execute(
        { name: 'Alice', age: 30 },
        'tier_3',
        { fetchFn: mockFetch },
      );

      const request = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as SealedFetchRequest;
      expect(request.method).toBe('POST');
      expect(request.headers['content-type']).toBe('application/json');

      const body = JSON.parse(request.body!);
      expect(body.name).toBe('Alice');
      expect(body.age).toBe(30);
    });

    it('returns success false for non-2xx status', async () => {
      const spec = generateSkill('example.com', makeCluster());
      const compiled = compileSkill(spec);
      const mockFetch = makeMockFetch(404, '{"error":"not found"}');

      const result = await compiled.execute(
        { id: '999' },
        'tier_3',
        { fetchFn: mockFetch },
      );

      expect(result.success).toBe(false);
      expect(result.status).toBe(404);
    });

    it('throws on input validation failure', async () => {
      const spec = generateSkill('example.com', makeCluster());
      const compiled = compileSkill(spec);

      await expect(
        compiled.execute(
          { id: 123 } as any,
          'tier_3',
          { fetchFn: makeMockFetch() },
        ),
      ).rejects.toThrow('Input validation failed');
    });

    it('returns success false on fetch error', async () => {
      const spec = generateSkill('example.com', makeCluster());
      const compiled = compileSkill(spec);
      const errorFetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const result = await compiled.execute(
        { id: '42' },
        'tier_3',
        { fetchFn: errorFetch },
      );

      expect(result.success).toBe(false);
      expect(result.status).toBe(0);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });
});
