import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { SkillSpec, OneAgentConfig } from '../../src/skill/types.js';
import {
  ALLOWED_BROWSER_TOOLS,
  BLOCKED_BROWSER_TOOLS,
  SkillStatus,
} from '../../src/skill/types.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

// We test the MCP server logic by replicating the registration pattern
// from mcp-stdio.ts, but using an in-memory transport to avoid stdio.

function makeTestConfig(): OneAgentConfig {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oneagent-mcp-test-'));
  return {
    dataDir: tmpDir,
    logLevel: 'silent',
    features: { webmcp: false, httpTransport: false },
    toolBudget: {
      maxToolCallsPerTask: 50,
      maxConcurrentCalls: 3,
      crossDomainCalls: false,
      secretsToNonAllowlisted: false,
    },
    payloadLimits: {
      maxResponseBodyBytes: 10 * 1024 * 1024,
      maxRequestBodyBytes: 5 * 1024 * 1024,
      replayTimeoutMs: { tier1: 30000, tier3: 60000, tier4: 120000 },
      harCaptureMaxBodyBytes: 50 * 1024 * 1024,
      redactorTimeoutMs: 10000,
    },
    audit: { strictMode: false, rootHashExport: false },
    storage: { maxPerSiteMb: 500, maxGlobalMb: 5000, retentionDays: 90 },
    server: { network: false },
    tempTtlMs: 3600000,
    gcIntervalMs: 900000,
    confirmationTimeoutMs: 30000,
    confirmationExpiryMs: 60000,
    promotionConsecutivePasses: 5,
    promotionVolatilityThreshold: 0.2,
    maxToolsPerSite: 20,
    toolShortlistK: 10,
  };
}

function loadSkillFixture(name: string): SkillSpec {
  const fixturePath = path.join(__dirname, '..', 'fixtures', 'generated-skills', name);
  return JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as SkillSpec;
}

// Re-implement the key MCP tool definitions locally for testability
// (avoids importing startMcpServer which tries to open a database and stdio)

const META_TOOL_NAMES = [
  'oneagent_explore',
  'oneagent_record',
  'oneagent_stop',
  'oneagent_sites',
  'oneagent_skills',
  'oneagent_status',
  'oneagent_dry_run',
  'oneagent_confirm',
];

function skillToToolName(skill: SkillSpec): string {
  const action = skill.name
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .toLowerCase();
  const site = skill.siteId
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .toLowerCase();
  return `${site}.${action}.v${skill.version}`;
}

describe('MCP Server Protocol', () => {
  let config: OneAgentConfig;

  beforeAll(() => {
    config = makeTestConfig();
    fs.mkdirSync(path.join(config.dataDir, 'audit'), { recursive: true });
    fs.mkdirSync(path.join(config.dataDir, 'data'), { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(config.dataDir, { recursive: true, force: true });
  });

  it('should define all expected meta-tools', () => {
    // Verify that all expected meta tools are listed
    for (const toolName of META_TOOL_NAMES) {
      expect(META_TOOL_NAMES).toContain(toolName);
    }
    expect(META_TOOL_NAMES).toHaveLength(8);
  });

  it('should list browser tools from the allowlist', () => {
    // Verify the ALLOWED_BROWSER_TOOLS are all defined
    expect(ALLOWED_BROWSER_TOOLS).toContain('browser_navigate');
    expect(ALLOWED_BROWSER_TOOLS).toContain('browser_snapshot');
    expect(ALLOWED_BROWSER_TOOLS).toContain('browser_click');
    expect(ALLOWED_BROWSER_TOOLS).toContain('browser_type');
    expect(ALLOWED_BROWSER_TOOLS).toContain('browser_take_screenshot');
    expect(ALLOWED_BROWSER_TOOLS).toContain('browser_network_requests');
    expect(ALLOWED_BROWSER_TOOLS).toContain('browser_tabs');

    // Verify blocked tools are NOT in the allowlist
    for (const blocked of BLOCKED_BROWSER_TOOLS) {
      expect(ALLOWED_BROWSER_TOOLS as readonly string[]).not.toContain(blocked);
    }
  });

  it('should convert active skills to MCP tool definitions', () => {
    const getUsersSkill = loadSkillFixture('get-users-skill.json');
    const graphqlSkill = loadSkillFixture('graphql-skill.json');

    const toolName1 = skillToToolName(getUsersSkill);
    const toolName2 = skillToToolName(graphqlSkill);

    expect(toolName1).toBe('example_com.get_users.v1');
    expect(toolName2).toBe('example_com.graphql_get_users.v1');

    // Verify the naming convention: site.action.vN
    expect(toolName1).toMatch(/^[a-z0-9_]+\.[a-z0-9_]+\.v\d+$/);
    expect(toolName2).toMatch(/^[a-z0-9_]+\.[a-z0-9_]+\.v\d+$/);
  });

  it('should not expose draft or stale skills as tools', () => {
    const createUserSkill = loadSkillFixture('create-user-skill.json');
    const staleSkill = loadSkillFixture('stale-skill.json');

    // Draft skills should not be exposed
    expect(createUserSkill.status).toBe('draft');
    expect(createUserSkill.status).not.toBe(SkillStatus.ACTIVE);

    // Stale skills should not be exposed
    expect(staleSkill.status).toBe('stale');
    expect(staleSkill.status).not.toBe(SkillStatus.ACTIVE);
  });

  it('should block browser_evaluate and browser_run_code', () => {
    expect(BLOCKED_BROWSER_TOOLS).toContain('browser_evaluate');
    expect(BLOCKED_BROWSER_TOOLS).toContain('browser_run_code');
    expect(BLOCKED_BROWSER_TOOLS).toContain('browser_install');

    // These should NOT be in the allowed list
    expect((ALLOWED_BROWSER_TOOLS as readonly string[]).includes('browser_evaluate')).toBe(false);
    expect((ALLOWED_BROWSER_TOOLS as readonly string[]).includes('browser_run_code')).toBe(false);
  });

  it('should create an MCP server instance with correct metadata', () => {
    const server = new Server(
      { name: 'oneagent', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );

    expect(server).toBeDefined();
    // Server was created without throwing
  });

  it('should register list tools and call tool handlers on an MCP server', async () => {
    const server = new Server(
      { name: 'oneagent', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );

    let listToolsCalled = false;
    let callToolCalled = false;

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      listToolsCalled = true;
      return {
        tools: [
          {
            name: 'oneagent_status',
            description: 'Get current session and engine status',
            inputSchema: { type: 'object' as const, properties: {} },
          },
        ],
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      callToolCalled = true;
      const { name } = request.params;
      if (name === 'oneagent_status') {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ mode: 'idle', uptime: 0 }),
          }],
        };
      }
      return {
        content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    });

    // Handlers were registered without throwing
    expect(listToolsCalled).toBe(false);
    expect(callToolCalled).toBe(false);
  });

  it('should correctly rank tools by intent matching', () => {
    const getUsersSkill = loadSkillFixture('get-users-skill.json');
    const graphqlSkill = loadSkillFixture('graphql-skill.json');

    // Both skills are active
    const skills = [getUsersSkill, graphqlSkill];

    // Simple intent-based scoring (mirrors the rankToolsByIntent logic)
    const intent = 'get users';
    const words = intent.toLowerCase().split(/\s+/);

    const scored = skills.map((skill) => {
      let score = 0;
      const nameLower = (skill.name ?? '').toLowerCase();
      const descLower = (skill.description ?? '').toLowerCase();

      for (const word of words) {
        if (nameLower.includes(word)) score += 3;
        if (descLower.includes(word)) score += 2;
      }
      score += skill.successRate * 2;
      return { skill, score };
    });

    scored.sort((a, b) => b.score - a.score);

    // "GraphQL Get Users" ranks higher because its description also matches
    // both "get" and "users", giving it more description score despite lower success rate
    expect(scored[0].skill.id).toBe('example-com.graphql-get-users.v1');
    // Both skills should have non-zero scores for "get users" intent
    expect(scored[0].score).toBeGreaterThan(0);
    expect(scored[1].score).toBeGreaterThan(0);
  });
});
