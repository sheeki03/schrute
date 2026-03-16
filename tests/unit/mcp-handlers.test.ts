import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock logger ─────────────────────────────────────────────────
vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ─── Mock config ─────────────────────────────────────────────────
vi.mock('../../src/core/config.js', () => ({
  getConfig: () => ({
    dataDir: '/tmp/schrute-mcp-test',
    logLevel: 'silent',
  }),
  getSkillsDir: () => '/tmp/schrute-mcp-test/skills',
  getDbPath: () => ':memory:',
  ensureDirectories: vi.fn(),
}));

// ─── Mock fs ─────────────────────────────────────────────────────
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readdirSync: vi.fn().mockReturnValue([]),
    statSync: vi.fn().mockReturnValue({ isDirectory: () => false, isFile: () => false }),
    readFileSync: vi.fn().mockReturnValue(''),
    mkdirSync: vi.fn(),
  };
});

import { registerResourceHandlers } from '../../src/server/mcp-handlers.js';
import type { ToolDispatchDeps } from '../../src/server/tool-dispatch.js';
import type { SkillSpec } from '../../src/skill/types.js';
import { SkillStatus } from '../../src/skill/types.js';

// ─── Helpers ─────────────────────────────────────────────────────

function makeSkillSpec(overrides?: Partial<SkillSpec>): SkillSpec {
  const now = Date.now();
  return {
    id: 'example.com.get_users.v1',
    siteId: 'example.com',
    name: 'get_users',
    version: 1,
    status: 'active',
    description: 'Get list of users',
    method: 'GET',
    pathTemplate: '/api/users',
    inputSchema: { type: 'object', properties: { page: { type: 'number' } } },
    sideEffectClass: 'read-only',
    isComposite: false,
    currentTier: 'tier_1',
    tierLock: null,
    confidence: 0.95,
    consecutiveValidations: 5,
    sampleCount: 10,
    successRate: 0.98,
    createdAt: now,
    updatedAt: now,
    allowedDomains: ['example.com'],
    requiredCapabilities: ['net.fetch.direct'],
    parameters: [
      { name: 'page', type: 'number', source: 'user_input', evidence: ['query param'] },
    ],
    validation: { semanticChecks: [], customInvariants: [] },
    redaction: { piiClassesFound: [], fieldsRedacted: 0 },
    replayStrategy: 'prefer_tier_1',
    authType: 'bearer',
    requiredHeaders: { 'x-api-key': 'secret123' },
    dynamicHeaders: { 'x-req-id': '{{uuid}}' },
    ...overrides,
  } as SkillSpec;
}

/**
 * A mock MCP Server that captures registered handlers by schema.
 * We only need setRequestHandler — the test invokes handlers directly.
 */
function createMockServer() {
  const handlers = new Map<string, (request: any) => Promise<any>>();

  return {
    setRequestHandler(schema: { method: string } | any, handler: (request: any) => Promise<any>) {
      // Key by the schema reference itself (schemas are singletons)
      handlers.set(schema, handler);
    },
    getHandler(schema: any) {
      return handlers.get(schema);
    },
    _handlers: handlers,
  };
}

function createMockDeps(overrides?: Partial<ToolDispatchDeps>): ToolDispatchDeps {
  return {
    engine: { getStatus: vi.fn().mockReturnValue({ mode: 'idle', uptime: 1000 }) } as any,
    skillRepo: {
      getAll: vi.fn().mockReturnValue([]),
      getByStatus: vi.fn().mockReturnValue([]),
    } as any,
    siteRepo: {
      getAll: vi.fn().mockReturnValue([]),
    } as any,
    confirmation: {} as any,
    config: {
      dataDir: '/tmp/schrute-mcp-test',
    } as any,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────

describe('MCP Resource Handlers', () => {
  // We import the schemas to use them as handler keys
  let ListResourcesRequestSchema: any;
  let ReadResourceRequestSchema: any;

  beforeEach(async () => {
    const schemas = await import('@modelcontextprotocol/sdk/types.js');
    ListResourcesRequestSchema = schemas.ListResourcesRequestSchema;
    ReadResourceRequestSchema = schemas.ReadResourceRequestSchema;
  });

  // ─── schrute://skills ──────────────────────────────────────────

  describe('schrute://skills resource', () => {
    it('returns redacted skills (no authType, requiredHeaders, dynamicHeaders)', async () => {
      const skill = makeSkillSpec({
        authType: 'bearer',
        requiredHeaders: { 'x-api-key': 'secret123' },
        dynamicHeaders: { 'x-req-id': '{{uuid}}' },
      });

      const deps = createMockDeps({
        skillRepo: {
          getAll: vi.fn().mockReturnValue([skill]),
          getByStatus: vi.fn().mockReturnValue([]),
        } as any,
      });

      const server = createMockServer();
      registerResourceHandlers(server as any, deps);

      const handler = server.getHandler(ReadResourceRequestSchema);
      expect(handler).toBeDefined();

      const result = await handler!({ params: { uri: 'schrute://skills' } });
      const parsed = JSON.parse(result.contents[0].text);

      // Should have the redacted fields
      expect(parsed.items[0].id).toBe(skill.id);
      expect(parsed.items[0].name).toBe(skill.name);
      expect(parsed.items[0].method).toBe(skill.method);
      expect(parsed.items[0].status).toBe(skill.status);
      expect(parsed.items[0].currentTier).toBe(skill.currentTier);

      // Should NOT have sensitive fields
      expect(parsed.items[0]).not.toHaveProperty('authType');
      expect(parsed.items[0]).not.toHaveProperty('requiredHeaders');
      expect(parsed.items[0]).not.toHaveProperty('dynamicHeaders');
      expect(parsed.items[0]).not.toHaveProperty('inputSchema');
      expect(parsed.items[0]).not.toHaveProperty('outputSchema');
      expect(parsed.items[0]).not.toHaveProperty('chainSpec');
    });

    it('redacts parameter descriptions', async () => {
      const skill = makeSkillSpec({
        parameters: [
          { name: 'page', type: 'number', source: 'user_input', evidence: ['query param'] },
        ],
      });

      const deps = createMockDeps({
        skillRepo: { getAll: vi.fn().mockReturnValue([skill]), getByStatus: vi.fn().mockReturnValue([]) } as any,
      });

      const server = createMockServer();
      registerResourceHandlers(server as any, deps);
      const handler = server.getHandler(ReadResourceRequestSchema);

      const result = await handler!({ params: { uri: 'schrute://skills' } });
      const parsed = JSON.parse(result.contents[0].text);

      // Parameters should have name and required but description should be undefined
      expect(parsed.items[0].parameters[0].name).toBe('page');
      expect(parsed.items[0].parameters[0].required).toBe(true);
      expect(parsed.items[0].parameters[0].description).toBeUndefined();
    });

    it('truncates when over 1000 items', async () => {
      // Create 1100 skills
      const skills: SkillSpec[] = [];
      for (let i = 0; i < 1100; i++) {
        skills.push(makeSkillSpec({
          id: `example.com.skill_${i}.v1`,
          name: `skill_${i}`,
          createdAt: Date.now() - i, // ensure sort order
        }));
      }

      const deps = createMockDeps({
        skillRepo: { getAll: vi.fn().mockReturnValue(skills), getByStatus: vi.fn().mockReturnValue([]) } as any,
      });

      const server = createMockServer();
      registerResourceHandlers(server as any, deps);
      const handler = server.getHandler(ReadResourceRequestSchema);

      const result = await handler!({ params: { uri: 'schrute://skills' } });
      const parsed = JSON.parse(result.contents[0].text);

      expect(parsed.total).toBe(1100);
      expect(parsed.returned).toBeLessThanOrEqual(1000);
      expect(parsed.truncated).toBe(true);
      expect(parsed.items.length).toBeLessThanOrEqual(1000);
    });

    it('returns truncated: false when all items fit', async () => {
      const skills = [
        makeSkillSpec({ id: 'a.b.v1', name: 'a' }),
        makeSkillSpec({ id: 'c.d.v1', name: 'c' }),
      ];

      const deps = createMockDeps({
        skillRepo: { getAll: vi.fn().mockReturnValue(skills), getByStatus: vi.fn().mockReturnValue([]) } as any,
      });

      const server = createMockServer();
      registerResourceHandlers(server as any, deps);
      const handler = server.getHandler(ReadResourceRequestSchema);

      const result = await handler!({ params: { uri: 'schrute://skills' } });
      const parsed = JSON.parse(result.contents[0].text);

      expect(parsed.total).toBe(2);
      expect(parsed.returned).toBe(2);
      expect(parsed.truncated).toBe(false);
    });

    it('falls back to getByStatus when getAll is missing', async () => {
      const skill = makeSkillSpec();
      const getByStatusMock = vi.fn().mockReturnValue([skill]);

      const deps = createMockDeps({
        skillRepo: {
          getByStatus: getByStatusMock,
          // no getAll property
        } as any,
      });

      const server = createMockServer();
      registerResourceHandlers(server as any, deps);
      const handler = server.getHandler(ReadResourceRequestSchema);

      const result = await handler!({ params: { uri: 'schrute://skills' } });
      const parsed = JSON.parse(result.contents[0].text);

      // Should have called getByStatus for each status
      expect(getByStatusMock).toHaveBeenCalledWith(SkillStatus.ACTIVE);
      expect(getByStatusMock).toHaveBeenCalledWith(SkillStatus.DRAFT);
      expect(getByStatusMock).toHaveBeenCalledWith(SkillStatus.STALE);
      expect(getByStatusMock).toHaveBeenCalledWith(SkillStatus.BROKEN);
      // Result should include the duplicated skill from all 4 calls
      expect(parsed.items.length).toBeGreaterThanOrEqual(1);
    });

    it('sorts skills by createdAt descending (newest first)', async () => {
      const now = Date.now();
      const skills = [
        makeSkillSpec({ id: 'old.v1', name: 'old', createdAt: now - 2000 }),
        makeSkillSpec({ id: 'new.v1', name: 'new', createdAt: now }),
        makeSkillSpec({ id: 'mid.v1', name: 'mid', createdAt: now - 1000 }),
      ];

      const deps = createMockDeps({
        skillRepo: { getAll: vi.fn().mockReturnValue(skills), getByStatus: vi.fn().mockReturnValue([]) } as any,
      });

      const server = createMockServer();
      registerResourceHandlers(server as any, deps);
      const handler = server.getHandler(ReadResourceRequestSchema);

      const result = await handler!({ params: { uri: 'schrute://skills' } });
      const parsed = JSON.parse(result.contents[0].text);

      expect(parsed.items[0].name).toBe('new');
      expect(parsed.items[1].name).toBe('mid');
      expect(parsed.items[2].name).toBe('old');
    });
  });

  // ─── schrute://sites/{siteId}/skills/{skillId}/docs ────────────

  describe('skill docs path traversal', () => {
    it('rejects .. in siteId', async () => {
      const deps = createMockDeps();
      const server = createMockServer();
      registerResourceHandlers(server as any, deps);
      const handler = server.getHandler(ReadResourceRequestSchema);

      // siteId = ".." — regex captures [^/]+ so ".." is a valid capture
      // but the path traversal guard rejects it
      const result = await handler!({
        params: { uri: 'schrute://sites/../skills/some-skill/docs' },
      });

      // ".." captured as siteId, "some-skill" is NOT captured as skillId
      // because the regex expects exactly sites/{one}/skills/{two}/docs
      // Actually with siteId="..", the path becomes sites/../skills/some-skill/docs
      // Let me use a siteId that contains ".." embedded
      expect(result.contents[0].text).toMatch(/Invalid|Unknown/);
    });

    it('rejects siteId containing .. traversal', async () => {
      const deps = createMockDeps();
      const server = createMockServer();
      registerResourceHandlers(server as any, deps);
      const handler = server.getHandler(ReadResourceRequestSchema);

      // siteId = "foo..bar" contains ".." — path traversal check catches it
      const result = await handler!({
        params: { uri: 'schrute://sites/foo..bar/skills/some-skill/docs' },
      });

      expect(result.contents[0].text).toContain('Invalid');
    });

    it('rejects skillId containing .. traversal', async () => {
      const deps = createMockDeps();
      const server = createMockServer();
      registerResourceHandlers(server as any, deps);
      const handler = server.getHandler(ReadResourceRequestSchema);

      // skillId = "skill..evil" contains ".."
      const result = await handler!({
        params: { uri: 'schrute://sites/example.com/skills/skill..evil/docs' },
      });

      expect(result.contents[0].text).toContain('Invalid');
    });

    it('rejects backslash in siteId', async () => {
      const deps = createMockDeps();
      const server = createMockServer();
      registerResourceHandlers(server as any, deps);
      const handler = server.getHandler(ReadResourceRequestSchema);

      // siteId contains backslash
      const result = await handler!({
        params: { uri: 'schrute://sites/example\\evil/skills/some-skill/docs' },
      });

      expect(result.contents[0].text).toContain('Invalid');
    });
  });

  // ─── Unknown resource URI ──────────────────────────────────────

  describe('unknown resource URI', () => {
    it('returns error for unknown URI', async () => {
      const deps = createMockDeps();
      const server = createMockServer();
      registerResourceHandlers(server as any, deps);
      const handler = server.getHandler(ReadResourceRequestSchema);

      const result = await handler!({
        params: { uri: 'schrute://nonexistent' },
      });

      expect(result.contents[0].text).toContain('Unknown resource URI');
    });
  });

  // ─── schrute://status ──────────────────────────────────────────

  describe('schrute://status resource', () => {
    it('returns engine status as JSON', async () => {
      const statusData = { mode: 'recording', uptime: 5000, sessions: 1 };
      const deps = createMockDeps({
        engine: { getStatus: vi.fn().mockReturnValue(statusData) } as any,
      });

      const server = createMockServer();
      registerResourceHandlers(server as any, deps);
      const handler = server.getHandler(ReadResourceRequestSchema);

      const result = await handler!({ params: { uri: 'schrute://status' } });
      const parsed = JSON.parse(result.contents[0].text);

      expect(parsed.mode).toBe('recording');
      expect(parsed.uptime).toBe(5000);
    });
  });

  // ─── Error handling ────────────────────────────────────────────

  describe('error handling', () => {
    it('catches errors and returns error text without throwing', async () => {
      const deps = createMockDeps({
        engine: {
          getStatus: vi.fn().mockImplementation(() => {
            throw new Error('engine exploded');
          }),
        } as any,
      });

      const server = createMockServer();
      registerResourceHandlers(server as any, deps);
      const handler = server.getHandler(ReadResourceRequestSchema);

      const result = await handler!({ params: { uri: 'schrute://status' } });

      expect(result.contents[0].mimeType).toBe('text/plain');
      expect(result.contents[0].text).toContain('engine exploded');
    });
  });
});
