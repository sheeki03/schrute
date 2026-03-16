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
    name: 'explore',
    description: 'Start exploring a website',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
  },
  {
    name: 'skill__example_com__get_users',
    description: 'Get list of users',
    inputSchema: { type: 'object', properties: {} },
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
import { SkillStatus } from '../../src/skill/types.js';
import { drainMcpNotifications, notify, createEvent } from '../../src/healing/notification.js';

function makeMockDeps(): McpStdioDeps {
  return {
    engine: {} as any,
    skillRepo: {
      getByStatus: vi.fn().mockReturnValue([]),
      getById: vi.fn(),
      getBySiteId: vi.fn().mockReturnValue([]),
      getActive: vi.fn().mockReturnValue([]),
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

describe('mcp-stdio', () => {
  let deps: McpStdioDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = makeMockDeps();
  });

  describe('startMcpServer', () => {
    it('creates and connects the MCP server', async () => {
      const handle = await startMcpServer(deps);
      expect(mockConnect).toHaveBeenCalled();
      expect(handle.close).toBeDefined();
      await handle.close();
    });

    it('registers ListTools, CallTool, Resource, and Prompt handlers', async () => {
      const handle = await startMcpServer(deps);

      // Should register 6 handlers: list_tools, call_tool, list_resources, read_resource, list_prompts, get_prompt
      expect(mockSetRequestHandler).toHaveBeenCalledTimes(6);
      expect(mockSetRequestHandler).toHaveBeenCalledWith('list_tools', expect.any(Function));
      expect(mockSetRequestHandler).toHaveBeenCalledWith('call_tool', expect.any(Function));
      expect(mockSetRequestHandler).toHaveBeenCalledWith('list_resources', expect.any(Function));
      expect(mockSetRequestHandler).toHaveBeenCalledWith('read_resource', expect.any(Function));
      expect(mockSetRequestHandler).toHaveBeenCalledWith('list_prompts', expect.any(Function));
      expect(mockSetRequestHandler).toHaveBeenCalledWith('get_prompt', expect.any(Function));

      await handle.close();
    });
  });

  describe('tool routing', () => {
    it('builds tool list via buildToolList', async () => {
      const handle = await startMcpServer(deps);

      // Get the ListTools handler
      const listToolsCall = mockSetRequestHandler.mock.calls.find(
        (call) => call[0] === 'list_tools',
      );
      expect(listToolsCall).toBeDefined();

      const handler = listToolsCall![1];
      const result = await handler({});

      // deps is spread with an added `router` property at startup
      expect(mockBuildToolList).toHaveBeenCalledWith(
        expect.objectContaining(deps),
        'stdio',
      );
      expect(result.tools).toBeDefined();
      expect(result.tools).toHaveLength(2);

      await handle.close();
    });

    it('dispatches tool calls via dispatchToolCall', async () => {
      const handle = await startMcpServer(deps);

      // Get the CallTool handler
      const callToolCall = mockSetRequestHandler.mock.calls.find(
        (call) => call[0] === 'call_tool',
      );
      expect(callToolCall).toBeDefined();

      const handler = callToolCall![1];
      const result = await handler({
        params: {
          name: 'explore',
          arguments: { url: 'https://example.com' },
        },
      });

      // deps is spread with an added `router` property at startup
      expect(mockDispatchToolCall).toHaveBeenCalledWith(
        'explore',
        { url: 'https://example.com' },
        expect.objectContaining(deps),
        'stdio',
      );

      await handle.close();
    });
  });

  describe('close handler', () => {
    it('cleans up on close', async () => {
      const handle = await startMcpServer(deps);
      await handle.close();
      expect(mockClose).toHaveBeenCalled();
    });
  });
});

describe('MCP notification drain', () => {
  beforeEach(() => {
    // Drain any leftover notifications from previous tests
    drainMcpNotifications();
  });

  it('returns empty array when no notifications pending', () => {
    const result = drainMcpNotifications();
    expect(result).toEqual([]);
  });

  it('drains notifications after events are created and notified', async () => {
    // Create and notify some events
    const event = createEvent('skill_promoted', 'test.skill.v1', 'example.com', { previousStatus: 'draft' });
    const config = {
      dataDir: '/tmp/test',
      logLevel: 'silent',
      server: { network: false },
      daemon: { port: 19420, autoStart: false },
    };
    await notify(event, config as any);

    // Drain should return the pending MCP notifications
    const drained = drainMcpNotifications();
    // The McpSink always runs, so we should have at least one notification
    expect(Array.isArray(drained)).toBe(true);
    expect(drained.length).toBeGreaterThanOrEqual(1);

    // Verify notification structure
    const notification = drained[0];
    expect(notification.method).toBe('notifications/tools/list_changed');
    expect(notification.params).toMatchObject({
      reason: 'skill_promoted',
      skillId: 'test.skill.v1',
      siteId: 'example.com',
    });
    expect(notification.params.timestamp).toBeDefined();
  });

  it('clears queue after drain', async () => {
    const event = createEvent('skill_broken', 'test.skill.v1', 'example.com', { successRate: 0.1 });
    await notify(event, {
      dataDir: '/tmp/test',
      logLevel: 'silent',
      server: { network: false },
      daemon: { port: 19420, autoStart: false },
    } as any);

    // First drain
    drainMcpNotifications();

    // Second drain should be empty
    const secondDrain = drainMcpNotifications();
    expect(secondDrain).toEqual([]);
  });
});
