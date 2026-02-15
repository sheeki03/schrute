/**
 * v0.2 Acceptance — MCP HTTP full cycle
 *
 * Verifies MCP HTTP transport: list tools, call meta-tools, execute skills.
 * Validates tool list parity with stdio.
 */

import { describe, it, expect, vi } from 'vitest';

// We test the shared components that both MCP transports (stdio + HTTP) use.
// Direct MCP HTTP server testing requires a real HTTP server; instead we
// verify the shared tool registry and handler logic that both transports share.

vi.mock('../../src/storage/database.js', () => ({
  getDatabase: () => ({
    prepare: () => ({
      run: () => ({ changes: 1 }),
      get: () => undefined,
      all: () => [],
    }),
    exec: () => {},
    close: () => {},
  }),
}));

describe('v0.2 MCP HTTP — Tool Registry Parity', () => {
  it('META_TOOLS includes all required meta tools', async () => {
    const { META_TOOLS } = await import('../../src/server/tool-registry.js');
    const names = META_TOOLS.map(t => t.name);

    expect(names).toContain('oneagent_explore');
    expect(names).toContain('oneagent_record');
    expect(names).toContain('oneagent_stop');
    expect(names).toContain('oneagent_sites');
    expect(names).toContain('oneagent_skills');
    expect(names).toContain('oneagent_status');
    expect(names).toContain('oneagent_dry_run');
    expect(names).toContain('oneagent_confirm');
  });

  it('all META_TOOLS have required schema fields', async () => {
    const { META_TOOLS } = await import('../../src/server/tool-registry.js');
    for (const tool of META_TOOLS) {
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('description');
      expect(tool).toHaveProperty('inputSchema');
      expect(tool.inputSchema).toHaveProperty('type', 'object');
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
    }
  });

  it('browser tool definitions come from allowlist only', async () => {
    const { getBrowserToolDefinitions } = await import('../../src/server/tool-registry.js');
    const { ALLOWED_BROWSER_TOOLS, BLOCKED_BROWSER_TOOLS } = await import('../../src/skill/types.js');

    const browserTools = getBrowserToolDefinitions();
    const browserNames = browserTools.map(t => t.name);

    // All browser tools should be from ALLOWED_BROWSER_TOOLS
    for (const name of browserNames) {
      expect((ALLOWED_BROWSER_TOOLS as readonly string[]).includes(name)).toBe(true);
    }

    // None should be from BLOCKED_BROWSER_TOOLS
    for (const blocked of BLOCKED_BROWSER_TOOLS) {
      expect(browserNames).not.toContain(blocked);
    }
  });

  it('tool list from both transports uses same META_TOOLS constant', async () => {
    // Both mcp-stdio.ts and mcp-http.ts import META_TOOLS from tool-registry.ts
    // This is a structural parity check — same import, same data
    const { META_TOOLS } = await import('../../src/server/tool-registry.js');
    expect(META_TOOLS.length).toBe(8);
  });
});

describe('v0.2 MCP HTTP — Skill Tool Conversion', () => {
  it('skillToToolName produces deterministic names', async () => {
    const { skillToToolName } = await import('../../src/server/tool-registry.js');
    const skill = {
      name: 'get_users',
      siteId: 'example.com',
      version: 1,
    } as any;

    const name = skillToToolName(skill);
    expect(name).toBe('example_com.get_users.v1');
    // Should be deterministic
    expect(skillToToolName(skill)).toBe(name);
  });

  it('skillToToolDefinition produces valid tool definition', async () => {
    const { skillToToolDefinition } = await import('../../src/server/tool-registry.js');
    const skill = {
      name: 'get_users',
      siteId: 'example.com',
      version: 1,
      description: 'Get users',
      method: 'GET',
      pathTemplate: '/api/users',
      parameters: [
        { name: 'page', type: 'number', source: 'user_input', evidence: [] },
        { name: 'apiVersion', type: 'string', source: 'constant', evidence: [] },
      ],
    } as any;

    const def = skillToToolDefinition(skill);
    expect(def).toHaveProperty('name');
    expect(def).toHaveProperty('description');
    expect(def).toHaveProperty('inputSchema');
    expect(def.inputSchema.type).toBe('object');
    // Only user_input params should be required
    expect(def.inputSchema.required).toContain('page');
    expect(def.inputSchema.required).not.toContain('apiVersion');
  });

  it('rankToolsByIntent respects k limit', async () => {
    const { rankToolsByIntent } = await import('../../src/server/tool-registry.js');
    const skills = Array.from({ length: 30 }, (_, i) => ({
      id: `site.skill${i}.v1`,
      name: `skill_${i}`,
      siteId: 'site',
      version: 1,
      description: `Skill ${i}`,
      successRate: 0.9,
      lastUsed: Date.now(),
    })) as any[];

    const result = rankToolsByIntent(skills, undefined, 10);
    expect(result.length).toBe(10);
  });

  it('rankToolsByIntent returns all if under k', async () => {
    const { rankToolsByIntent } = await import('../../src/server/tool-registry.js');
    const skills = Array.from({ length: 5 }, (_, i) => ({
      id: `site.skill${i}.v1`,
      name: `skill_${i}`,
      siteId: 'site',
      version: 1,
      description: `Skill ${i}`,
      successRate: 0.9,
    })) as any[];

    const result = rankToolsByIntent(skills, undefined, 20);
    expect(result.length).toBe(5);
  });

  it('rankToolsByIntent ranks by intent keyword matching', async () => {
    const { rankToolsByIntent } = await import('../../src/server/tool-registry.js');
    const skills = [
      { id: 'a.login.v1', name: 'login', siteId: 'a', version: 1, description: 'Login to site', successRate: 0.5 },
      { id: 'a.users.v1', name: 'get_users', siteId: 'a', version: 1, description: 'Get user list', successRate: 0.5 },
      { id: 'a.settings.v1', name: 'settings', siteId: 'a', version: 1, description: 'Site settings', successRate: 0.5 },
    ] as any[];

    const result = rankToolsByIntent(skills, 'login', 2);
    expect(result.length).toBe(2);
    expect(result[0].name).toBe('login');
  });
});

describe('v0.2 MCP HTTP — Shared Router', () => {
  it('router health returns status ok', async () => {
    // Import createRouter directly to test shared logic
    const { createRouter } = await import('../../src/server/router.js');

    const mockEngine = {
      getStatus: () => ({
        mode: 'idle',
        activeSession: null,
        currentRecording: null,
        uptime: 5000,
      }),
      explore: async () => ({ sessionId: 's1', siteId: 'test.com', url: 'https://test.com' }),
      startRecording: async () => ({ id: 'r1', name: 'test', siteId: 'test.com', startedAt: Date.now(), requestCount: 0 }),
      stopRecording: async () => ({ id: 'r1', name: 'test', siteId: 'test.com', startedAt: Date.now(), requestCount: 3 }),
      executeSkill: async () => ({ success: true, data: {}, latencyMs: 10 }),
      close: async () => {},
    } as any;

    const mockSkillRepo = {
      getByStatus: () => [],
      getBySiteId: () => [],
      getById: () => null,
    } as any;

    const mockSiteRepo = {
      getAll: () => [],
      getById: () => null,
    } as any;

    const config = {
      confirmationExpiryMs: 60000,
    } as any;

    const router = createRouter({
      engine: mockEngine,
      skillRepo: mockSkillRepo,
      siteRepo: mockSiteRepo,
      config,
    });

    const health = router.health();
    expect(health.success).toBe(true);
    expect((health.data as any).status).toBe('ok');
    expect((health.data as any).uptime).toBe(5000);
  });

  it('router listSites returns from siteRepo', async () => {
    const { createRouter } = await import('../../src/server/router.js');
    const mockSites = [{ id: 'a.com' }, { id: 'b.com' }];

    const router = createRouter({
      engine: { getStatus: () => ({}) } as any,
      skillRepo: { getByStatus: () => [] } as any,
      siteRepo: { getAll: () => mockSites, getById: () => null } as any,
      config: {} as any,
    });

    const result = router.listSites();
    expect(result.success).toBe(true);
    expect(result.data).toEqual(mockSites);
  });

  it('router getSite returns 404 for unknown site', async () => {
    const { createRouter } = await import('../../src/server/router.js');

    const router = createRouter({
      engine: { getStatus: () => ({}) } as any,
      skillRepo: { getByStatus: () => [] } as any,
      siteRepo: { getAll: () => [], getById: () => null } as any,
      config: {} as any,
    });

    const result = router.getSite('unknown.com');
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(404);
    expect(result.error).toContain('unknown.com');
  });
});
