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

// ─── Mock MCP SDK ────────────────────────────────────────────────
const mockSetRequestHandler = vi.fn();
const mockNotification = vi.fn();
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: vi.fn().mockImplementation(() => ({
    setRequestHandler: mockSetRequestHandler,
    notification: mockNotification,
    connect: mockConnect,
    close: mockClose,
  })),
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  CallToolRequestSchema: 'call_tool',
  ListToolsRequestSchema: 'list_tools',
  ListResourcesRequestSchema: 'list_resources',
  ReadResourceRequestSchema: 'read_resource',
  ListPromptsRequestSchema: 'list_prompts',
  GetPromptRequestSchema: 'get_prompt',
}));

// ─── Mock tool dispatch ──────────────────────────────────────────
const mockBuildToolList = vi.fn().mockReturnValue([
  {
    name: 'schrute_explore',
    description: 'Start exploring a website',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
  },
]);

const mockDispatchToolCall = vi.fn().mockResolvedValue({
  content: [{ type: 'text', text: 'ok' }],
});

vi.mock('../../src/server/tool-dispatch.js', () => ({
  buildToolList: (...args: unknown[]) => mockBuildToolList(...args),
  dispatchToolCall: (...args: unknown[]) => mockDispatchToolCall(...args),
}));

import { startMcpServer, type McpStdioDeps } from '../../src/server/mcp-stdio.js';
import { SkillStatus, SideEffectClass, TierState, Capability, MasteryLevel, ExecutionTier } from '../../src/skill/types.js';
import type { SkillSpec, SiteManifest } from '../../src/skill/types.js';

// ─── Test Helpers ────────────────────────────────────────────────

function makeTestSkill(overrides?: Partial<SkillSpec>): SkillSpec {
  const now = Date.now();
  return {
    id: 'example.com.get_users.v1',
    version: 1,
    status: SkillStatus.ACTIVE,
    currentTier: TierState.TIER_1_PROMOTED,
    tierLock: null,
    allowedDomains: ['example.com'],
    requiredCapabilities: [Capability.NET_FETCH_DIRECT],
    parameters: [
      { name: 'page', type: 'number', source: 'user_input', evidence: ['query param'] },
    ],
    validation: { semanticChecks: ['status_2xx'], customInvariants: [] },
    redaction: { piiClassesFound: [], fieldsRedacted: 0 },
    replayStrategy: 'prefer_tier_1',
    sideEffectClass: SideEffectClass.READ_ONLY,
    sampleCount: 10,
    consecutiveValidations: 5,
    confidence: 0.95,
    method: 'GET',
    pathTemplate: '/api/users',
    inputSchema: { type: 'object', properties: { page: { type: 'number' } } },
    isComposite: false,
    siteId: 'example.com',
    name: 'get_users',
    description: 'Get list of users',
    successRate: 0.98,
    createdAt: now,
    updatedAt: now,
    // Include fields that should be redacted
    requiredHeaders: { 'Authorization': 'Bearer secret123' },
    dynamicHeaders: { 'X-Session': 'sess-abc' },
    authType: 'bearer',
    ...overrides,
  } as SkillSpec;
}

function makeMockDeps(): McpStdioDeps {
  return {
    engine: {
      getStatus: vi.fn().mockReturnValue({
        mode: 'idle',
        activeSession: null,
        currentRecording: null,
        uptime: 12345,
      }),
    } as any,
    skillRepo: {
      getByStatus: vi.fn().mockReturnValue([]),
      getById: vi.fn(),
      getBySiteId: vi.fn().mockReturnValue([]),
    } as any,
    siteRepo: {
      getAll: vi.fn().mockReturnValue([]),
      getById: vi.fn(),
    } as any,
    confirmation: {
      isSkillConfirmed: vi.fn().mockReturnValue(true),
      generateToken: vi.fn(),
      verifyToken: vi.fn(),
      consumeToken: vi.fn(),
    } as any,
    config: {
      dataDir: '/tmp/mcp-test',
      logLevel: 'silent',
    } as any,
  };
}

function getHandler(schema: string): Function {
  const call = mockSetRequestHandler.mock.calls.find(
    (c: any[]) => c[0] === schema,
  );
  if (!call) throw new Error(`Handler for ${schema} not registered`);
  return call[1];
}

describe('mcp-protocol', () => {
  let deps: McpStdioDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = makeMockDeps();
  });

  describe('capabilities', () => {
    it('registers resource and prompt handlers alongside tool handlers', async () => {
      const handle = await startMcpServer(deps);

      // Should register: list_tools, call_tool, list_resources, read_resource, list_prompts, get_prompt
      const registeredSchemas = mockSetRequestHandler.mock.calls.map((c: any[]) => c[0]);
      expect(registeredSchemas).toContain('list_resources');
      expect(registeredSchemas).toContain('read_resource');
      expect(registeredSchemas).toContain('list_prompts');
      expect(registeredSchemas).toContain('get_prompt');

      await handle.close();
    });
  });

  describe('resources', () => {
    it('ListResources returns 3 resources with correct URIs', async () => {
      const handle = await startMcpServer(deps);
      const handler = getHandler('list_resources');
      const result = await handler({});

      expect(result.resources).toHaveLength(3);
      const uris = result.resources.map((r: any) => r.uri);
      expect(uris).toContain('schrute://status');
      expect(uris).toContain('schrute://skills');
      expect(uris).toContain('schrute://sites');

      // All should have application/json MIME type
      for (const resource of result.resources) {
        expect(resource.mimeType).toBe('application/json');
      }

      await handle.close();
    });

    it('ReadResource(schrute://status) returns engine status', async () => {
      const handle = await startMcpServer(deps);
      const handler = getHandler('read_resource');

      const result = await handler({ params: { uri: 'schrute://status' } });

      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].mimeType).toBe('application/json');
      const status = JSON.parse(result.contents[0].text);
      expect(status.mode).toBe('idle');
      expect(status.uptime).toBe(12345);

      await handle.close();
    });

    it('ReadResource(schrute://skills) returns redacted skill summaries', async () => {
      const testSkill = makeTestSkill();
      (deps.skillRepo.getByStatus as any).mockImplementation((status: string) => {
        if (status === SkillStatus.ACTIVE) return [testSkill];
        return [];
      });

      const handle = await startMcpServer(deps);
      const handler = getHandler('read_resource');

      const result = await handler({ params: { uri: 'schrute://skills' } });

      expect(result.contents).toHaveLength(1);
      const data = JSON.parse(result.contents[0].text);
      expect(data.total).toBe(1);
      expect(data.returned).toBe(1);
      expect(data.truncated).toBe(false);
      expect(data.items).toHaveLength(1);

      const skill = data.items[0];
      // Should have safe fields
      expect(skill.id).toBe('example.com.get_users.v1');
      expect(skill.name).toBe('get_users');
      expect(skill.method).toBe('GET');
      expect(skill.pathTemplate).toBe('/api/users');
      expect(skill.sideEffectClass).toBe(SideEffectClass.READ_ONLY);

      // Should NOT have sensitive fields
      expect(skill.requiredHeaders).toBeUndefined();
      expect(skill.dynamicHeaders).toBeUndefined();
      expect(skill.authType).toBeUndefined();
      expect(skill.chainSpec).toBeUndefined();
      expect(skill.parameterEvidence).toBeUndefined();

      await handle.close();
    });

    it('ReadResource(schrute://sites) returns site summaries', async () => {
      const site: SiteManifest = {
        id: 'example.com',
        displayName: 'Example',
        firstSeen: 1000,
        lastVisited: 2000,
        masteryLevel: MasteryLevel.FULL,
        recommendedTier: ExecutionTier.DIRECT,
        totalRequests: 100,
        successfulRequests: 98,
      };
      (deps.siteRepo.getAll as any).mockReturnValue([site]);

      const handle = await startMcpServer(deps);
      const handler = getHandler('read_resource');

      const result = await handler({ params: { uri: 'schrute://sites' } });

      const data = JSON.parse(result.contents[0].text);
      expect(data.total).toBe(1);
      expect(data.items[0].id).toBe('example.com');
      expect(data.items[0].displayName).toBe('Example');
      expect(data.items[0].firstSeen).toBe(1000);
      expect(data.items[0].lastVisited).toBe(2000);

      await handle.close();
    });

    it('ReadResource with unknown URI returns error text', async () => {
      const handle = await startMcpServer(deps);
      const handler = getHandler('read_resource');

      const result = await handler({ params: { uri: 'schrute://unknown' } });

      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].mimeType).toBe('text/plain');
      expect(result.contents[0].text).toContain('Error');

      await handle.close();
    });

    it('ReadResource handles engine errors gracefully', async () => {
      (deps.engine.getStatus as any).mockImplementation(() => {
        throw new Error('Engine unavailable');
      });

      const handle = await startMcpServer(deps);
      const handler = getHandler('read_resource');

      const result = await handler({ params: { uri: 'schrute://status' } });

      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].mimeType).toBe('text/plain');
      expect(result.contents[0].text).toContain('Engine unavailable');

      await handle.close();
    });
  });

  describe('prompts', () => {
    it('ListPrompts returns 2 prompts', async () => {
      const handle = await startMcpServer(deps);
      const handler = getHandler('list_prompts');

      const result = await handler({});

      expect(result.prompts).toHaveLength(2);
      const names = result.prompts.map((p: any) => p.name);
      expect(names).toContain('explore-site');
      expect(names).toContain('record-action');

      await handle.close();
    });

    it('GetPrompt(explore-site) returns messages with URL', async () => {
      const handle = await startMcpServer(deps);
      const handler = getHandler('get_prompt');

      const result = await handler({
        params: {
          name: 'explore-site',
          arguments: { url: 'https://example.com' },
        },
      });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content.text).toContain('https://example.com');
      expect(result.messages[0].content.text).toContain('schrute_explore');

      await handle.close();
    });

    it('GetPrompt(record-action) returns messages with URL and action name', async () => {
      const handle = await startMcpServer(deps);
      const handler = getHandler('get_prompt');

      const result = await handler({
        params: {
          name: 'record-action',
          arguments: { url: 'https://example.com', action_name: 'search' },
        },
      });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content.text).toContain('https://example.com');
      expect(result.messages[0].content.text).toContain('search');
      expect(result.messages[0].content.text).toContain('schrute_record');

      await handle.close();
    });

    it('GetPrompt with unknown name throws', async () => {
      const handle = await startMcpServer(deps);
      const handler = getHandler('get_prompt');

      await expect(
        handler({ params: { name: 'nonexistent', arguments: {} } }),
      ).rejects.toThrow('Unknown prompt');

      await handle.close();
    });

    it('explore-site prompt argument definitions are correct', async () => {
      const handle = await startMcpServer(deps);
      const handler = getHandler('list_prompts');

      const result = await handler({});
      const exploreSite = result.prompts.find((p: any) => p.name === 'explore-site');

      expect(exploreSite.arguments).toHaveLength(1);
      expect(exploreSite.arguments[0].name).toBe('url');
      expect(exploreSite.arguments[0].required).toBe(true);

      await handle.close();
    });

    it('record-action prompt argument definitions are correct', async () => {
      const handle = await startMcpServer(deps);
      const handler = getHandler('list_prompts');

      const result = await handler({});
      const recordAction = result.prompts.find((p: any) => p.name === 'record-action');

      expect(recordAction.arguments).toHaveLength(2);
      expect(recordAction.arguments[0].name).toBe('url');
      expect(recordAction.arguments[0].required).toBe(true);
      expect(recordAction.arguments[1].name).toBe('action_name');
      expect(recordAction.arguments[1].required).toBe(true);

      await handle.close();
    });
  });
});
