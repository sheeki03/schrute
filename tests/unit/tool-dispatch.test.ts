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

vi.mock('../../src/core/config.js', () => ({
  getConfig: () => ({
    dataDir: '/tmp/oneagent-dispatch-test',
    logLevel: 'silent',
    daemon: { port: 19420, autoStart: false },
  }),
  getDbPath: () => ':memory:',
  ensureDirectories: vi.fn(),
}));

// Mock router
const mockRouter = {
  explore: vi.fn(),
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  listSites: vi.fn(),
  listSkills: vi.fn(),
  getStatus: vi.fn(),
  confirm: vi.fn(),
};

vi.mock('../../src/server/router.js', () => ({
  createRouter: vi.fn(() => mockRouter),
}));

// Mock dry-run
vi.mock('../../src/replay/dry-run.js', () => ({
  dryRun: vi.fn().mockResolvedValue({
    url: 'https://example.com/api/data',
    method: 'GET',
    headers: {},
    tier: 'direct',
    policyDecision: { proposed: 'GET /api/data', policyResult: 'allowed', policyRule: 'test', userConfirmed: null, redactionsApplied: [] },
  }),
}));

// Mock tool-registry
vi.mock('../../src/server/tool-registry.js', () => ({
  META_TOOLS: [
    { name: 'oneagent_explore', description: 'Explore', inputSchema: {} },
    { name: 'oneagent_record', description: 'Record', inputSchema: {} },
    { name: 'oneagent_stop', description: 'Stop', inputSchema: {} },
    { name: 'oneagent_sites', description: 'Sites', inputSchema: {} },
    { name: 'oneagent_skills', description: 'Skills', inputSchema: {} },
    { name: 'oneagent_status', description: 'Status', inputSchema: {} },
    { name: 'oneagent_dry_run', description: 'Dry Run', inputSchema: {} },
    { name: 'oneagent_confirm', description: 'Confirm', inputSchema: {} },
  ],
  getBrowserToolDefinitions: vi.fn().mockReturnValue([
    { name: 'browser_click', description: 'Click', inputSchema: {} },
  ]),
  rankToolsByIntent: vi.fn((skills) => skills),
  skillToToolName: vi.fn((skill) => `${skill.siteId}.${skill.name}.v${skill.version}`),
  skillToToolDefinition: vi.fn((skill) => ({
    name: `${skill.siteId}.${skill.name}.v${skill.version}`,
    description: skill.description ?? `${skill.method} ${skill.pathTemplate}`,
    inputSchema: {},
  })),
}));

// Mock browser adapter
vi.mock('../../src/browser/playwright-mcp-adapter.js', () => ({
  PlaywrightMcpAdapter: vi.fn(),
}));

vi.mock('../../src/browser/feature-flags.js', () => ({
  getFlags: vi.fn().mockReturnValue({}),
}));

vi.mock('../../src/core/policy.js', () => ({
  getSitePolicy: vi.fn().mockReturnValue({
    siteId: 'example.com',
    domainAllowlist: ['example.com'],
    capabilities: [],
  }),
}));

import { dispatchToolCall, buildToolList } from '../../src/server/tool-dispatch.js';
import type { ToolDispatchDeps } from '../../src/server/tool-dispatch.js';
import type { SkillSpec, OneAgentConfig } from '../../src/skill/types.js';
import { SkillStatus, SideEffectClass } from '../../src/skill/types.js';

// ─── Fixtures ────────────────────────────────────────────────────

function makeConfig(): OneAgentConfig {
  return {
    dataDir: '/tmp/oneagent-dispatch-test',
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
    audit: { strictMode: true, rootHashExport: true },
    storage: { maxPerSiteMb: 500, maxGlobalMb: 5000, retentionDays: 90 },
    server: { network: false },
    daemon: { port: 19420, autoStart: false },
    tempTtlMs: 3600000,
    gcIntervalMs: 900000,
    confirmationTimeoutMs: 30000,
    confirmationExpiryMs: 60000,
    promotionConsecutivePasses: 5,
    promotionVolatilityThreshold: 0.2,
    maxToolsPerSite: 20,
    toolShortlistK: 10,
  } as OneAgentConfig;
}

function makeSkill(overrides: Partial<SkillSpec> = {}): SkillSpec {
  return {
    id: 'example.com.get_users.v1',
    version: 1,
    status: SkillStatus.ACTIVE,
    currentTier: 'tier_1',
    tierLock: null,
    allowedDomains: ['example.com'],
    requiredCapabilities: [],
    parameters: [],
    validation: { semanticChecks: [], customInvariants: [] },
    redaction: { piiClassesFound: [], fieldsRedacted: 0 },
    replayStrategy: 'prefer_tier_1',
    sideEffectClass: SideEffectClass.READ_ONLY,
    sampleCount: 5,
    consecutiveValidations: 5,
    confidence: 0.9,
    method: 'GET',
    pathTemplate: '/api/users',
    inputSchema: {},
    isComposite: false,
    siteId: 'example.com',
    name: 'get_users',
    description: 'Get list of users',
    successRate: 0.98,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as SkillSpec;
}

function makeDeps(overrides: Partial<ToolDispatchDeps> = {}): ToolDispatchDeps {
  return {
    engine: {
      getStatus: vi.fn().mockReturnValue({
        mode: 'idle',
        activeSession: null,
        currentRecording: null,
        uptime: 100,
      }),
      executeSkill: vi.fn().mockResolvedValue({ success: true, data: { result: 'ok' } }),
      getSessionManager: vi.fn().mockReturnValue({
        getBrowserManager: vi.fn().mockReturnValue({
          hasContext: vi.fn().mockReturnValue(false),
          getOrCreateContext: vi.fn(),
          getCapabilities: vi.fn().mockReturnValue(null),
        }),
      }),
    } as any,
    skillRepo: {
      getByStatus: vi.fn().mockReturnValue([]),
      getById: vi.fn().mockReturnValue(undefined),
      getBySiteId: vi.fn().mockReturnValue([]),
    } as any,
    siteRepo: {
      getAll: vi.fn().mockReturnValue([]),
      getById: vi.fn().mockReturnValue(undefined),
    } as any,
    confirmation: {
      isSkillConfirmed: vi.fn().mockReturnValue(true),
      generateToken: vi.fn().mockResolvedValue({
        nonce: 'test-token-123',
        skillId: 'example.com.get_users.v1',
        tier: 'tier_1',
        expiresAt: Date.now() + 60000,
      }),
      verifyToken: vi.fn().mockReturnValue({ valid: true, token: { skillId: 'skill1', tier: 'tier_1' } }),
      consumeToken: vi.fn(),
    } as any,
    config: makeConfig(),
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────

describe('tool-dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset router mocks to default success
    mockRouter.explore.mockResolvedValue({ success: true, data: { siteId: 'example.com', sessionId: 'sess-1' } });
    mockRouter.startRecording.mockResolvedValue({ success: true, data: { name: 'test' } });
    mockRouter.stopRecording.mockResolvedValue({ success: true, data: { skills: [] } });
    mockRouter.listSites.mockReturnValue({ success: true, data: [] });
    mockRouter.listSkills.mockReturnValue({ success: true, data: [] });
    mockRouter.getStatus.mockReturnValue({ success: true, data: { mode: 'idle' } });
    mockRouter.confirm.mockReturnValue({ success: true, data: { status: 'approved' } });
  });

  // ─── Blocked Browser Tools ─────────────────────────────────────

  describe('blocked browser tools', () => {
    it('returns security error for browser_evaluate', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('browser_evaluate', {}, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('BLOCKED');
      expect(result.content[0].text).toContain('browser_evaluate');
    });

    it('returns security error for browser_run_code', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('browser_run_code', {}, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('BLOCKED');
    });

    it('returns security error for browser_install', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('browser_install', {}, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('BLOCKED');
      expect(result.content[0].text).toContain('security');
    });
  });

  // ─── Confirmation Gate Flow ────────────────────────────────────

  describe('confirmation gate', () => {
    it('returns confirmation_required when skill is unconfirmed', async () => {
      const skill = makeSkill();
      const deps = makeDeps({
        skillRepo: {
          getByStatus: vi.fn().mockReturnValue([skill]),
          getById: vi.fn().mockReturnValue(skill),
          getBySiteId: vi.fn().mockReturnValue([skill]),
        } as any,
        confirmation: {
          isSkillConfirmed: vi.fn().mockReturnValue(false),
          generateToken: vi.fn().mockResolvedValue({
            nonce: 'confirm-abc',
            skillId: skill.id,
            tier: 'tier_1',
            expiresAt: Date.now() + 60000,
          }),
        } as any,
      });

      const result = await dispatchToolCall('example.com.get_users.v1', { page: 1 }, deps);
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('confirmation_required');
      expect(data.confirmationToken).toBe('confirm-abc');
      expect(data.skillId).toBe(skill.id);
    });

    it('executes skill when already confirmed', async () => {
      const skill = makeSkill();
      const mockExecuteSkill = vi.fn().mockResolvedValue({ success: true, data: { users: [] } });
      const deps = makeDeps({
        engine: {
          getStatus: vi.fn().mockReturnValue({ mode: 'idle', activeSession: null }),
          executeSkill: mockExecuteSkill,
          getSessionManager: vi.fn().mockReturnValue({
            getBrowserManager: vi.fn().mockReturnValue({
              hasContext: vi.fn().mockReturnValue(false),
            }),
          }),
        } as any,
        skillRepo: {
          getByStatus: vi.fn().mockReturnValue([skill]),
          getById: vi.fn().mockReturnValue(skill),
          getBySiteId: vi.fn().mockReturnValue([skill]),
        } as any,
        confirmation: {
          isSkillConfirmed: vi.fn().mockReturnValue(true),
        } as any,
      });

      const result = await dispatchToolCall('example.com.get_users.v1', { page: 1 }, deps);
      expect(result.isError).toBeUndefined();
      expect(mockExecuteSkill).toHaveBeenCalledWith(skill.id, { page: 1 });
    });
  });

  // ─── Missing Required Arguments ────────────────────────────────

  describe('missing required arguments', () => {
    it('oneagent_explore returns error when url is missing', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('oneagent_explore', {}, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('url is required');
    });

    it('oneagent_record returns error when name is missing', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('oneagent_record', {}, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('name is required');
    });

    it('oneagent_confirm returns error when confirmationToken is missing', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('oneagent_confirm', {}, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('confirmationToken is required');
    });

    it('oneagent_confirm returns error when approve is missing', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('oneagent_confirm', { confirmationToken: 'tok-1' }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('approve must be a boolean');
    });

    it('oneagent_confirm returns error when approve is not a boolean', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('oneagent_confirm', { confirmationToken: 'tok-1', approve: 'yes' }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('approve must be a boolean');
    });

    it('oneagent_dry_run returns error when skillId is missing', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('oneagent_dry_run', {}, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('skillId is required');
    });
  });

  // ─── buildToolList ─────────────────────────────────────────────

  describe('buildToolList', () => {
    it('includes meta tools', () => {
      const deps = makeDeps();
      const tools = buildToolList(deps);
      const names = tools.map(t => t.name);
      expect(names).toContain('oneagent_explore');
      expect(names).toContain('oneagent_record');
      expect(names).toContain('oneagent_stop');
      expect(names).toContain('oneagent_confirm');
    });

    it('includes browser tools', () => {
      const deps = makeDeps();
      const tools = buildToolList(deps);
      const names = tools.map(t => t.name);
      expect(names).toContain('browser_click');
    });

    it('includes active skill tools', () => {
      const skill = makeSkill();
      const deps = makeDeps({
        skillRepo: {
          getByStatus: vi.fn().mockReturnValue([skill]),
          getById: vi.fn().mockReturnValue(skill),
          getBySiteId: vi.fn().mockReturnValue([skill]),
        } as any,
      });

      const tools = buildToolList(deps);
      const names = tools.map(t => t.name);
      expect(names).toContain('example.com.get_users.v1');
    });

    it('combines meta, browser, and skill tools', () => {
      const skill = makeSkill();
      const deps = makeDeps({
        skillRepo: {
          getByStatus: vi.fn().mockReturnValue([skill]),
          getById: vi.fn().mockReturnValue(skill),
          getBySiteId: vi.fn().mockReturnValue([skill]),
        } as any,
      });

      const tools = buildToolList(deps);
      // At least meta + browser + skill
      expect(tools.length).toBeGreaterThanOrEqual(10); // 8 meta + 1 browser + 1 skill
    });
  });

  // ─── Unknown Tool Fallback ─────────────────────────────────────

  describe('unknown tool fallback', () => {
    it('returns error for completely unknown tool name', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('nonexistent_tool_xyz', {}, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown tool');
      expect(result.content[0].text).toContain('nonexistent_tool_xyz');
    });
  });

  // ─── Meta Tool Routing ─────────────────────────────────────────

  describe('meta tool routing', () => {
    it('routes oneagent_explore to router.explore', async () => {
      const deps = makeDeps();
      await dispatchToolCall('oneagent_explore', { url: 'https://example.com' }, deps);
      expect(mockRouter.explore).toHaveBeenCalledWith('https://example.com');
    });

    it('routes oneagent_record to router.startRecording', async () => {
      const deps = makeDeps();
      await dispatchToolCall('oneagent_record', { name: 'my-recording', inputs: { key: 'val' } }, deps);
      expect(mockRouter.startRecording).toHaveBeenCalledWith('my-recording', { key: 'val' });
    });

    it('routes oneagent_stop to router.stopRecording', async () => {
      const deps = makeDeps();
      await dispatchToolCall('oneagent_stop', {}, deps);
      expect(mockRouter.stopRecording).toHaveBeenCalled();
    });

    it('routes oneagent_sites to router.listSites', async () => {
      const deps = makeDeps();
      await dispatchToolCall('oneagent_sites', {}, deps);
      expect(mockRouter.listSites).toHaveBeenCalled();
    });

    it('routes oneagent_status to router.getStatus', async () => {
      const deps = makeDeps();
      await dispatchToolCall('oneagent_status', {}, deps);
      expect(mockRouter.getStatus).toHaveBeenCalled();
    });

    it('returns isError when router returns failure', async () => {
      mockRouter.explore.mockResolvedValue({ success: false, error: 'Connection failed' });
      const deps = makeDeps();
      const result = await dispatchToolCall('oneagent_explore', { url: 'https://bad.example.com' }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Connection failed');
    });
  });

  // ─── Error Handling ────────────────────────────────────────────

  describe('error handling', () => {
    it('catches and wraps exceptions thrown during dispatch', async () => {
      mockRouter.explore.mockRejectedValue(new Error('Unexpected crash'));
      const deps = makeDeps();
      const result = await dispatchToolCall('oneagent_explore', { url: 'https://example.com' }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unexpected crash');
    });
  });
});
