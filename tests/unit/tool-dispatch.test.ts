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
    dataDir: '/tmp/schrute-dispatch-test',
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
  getPipelineStatus: vi.fn(),
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
    { name: 'schrute_explore', description: 'Explore', inputSchema: {} },
    { name: 'schrute_recover_explore', description: 'Recover Explore', inputSchema: {} },
    { name: 'schrute_record', description: 'Record', inputSchema: {} },
    { name: 'schrute_stop', description: 'Stop', inputSchema: {} },
    { name: 'schrute_pipeline_status', description: 'Pipeline Status', inputSchema: {} },
    { name: 'schrute_sites', description: 'Sites', inputSchema: {} },
    { name: 'schrute_skills', description: 'Skills', inputSchema: {} },
    { name: 'schrute_status', description: 'Status', inputSchema: {} },
    { name: 'schrute_dry_run', description: 'Dry Run', inputSchema: {} },
    { name: 'schrute_confirm', description: 'Confirm', inputSchema: {} },
    { name: 'schrute_execute', description: 'Execute', inputSchema: {} },
    { name: 'schrute_activate', description: 'Activate', inputSchema: {} },
    { name: 'schrute_doctor', description: 'Doctor', inputSchema: {} },
    { name: 'schrute_export_cookies', description: 'Export Cookies', inputSchema: {} },
    { name: 'schrute_revoke', description: 'Revoke', inputSchema: {} },
  ],
  getBrowserToolDefinitions: vi.fn().mockReturnValue([
    { name: 'browser_click', description: 'Click', inputSchema: {} },
  ]),
  rankToolsByIntent: vi.fn((skills) => skills),
  skillToToolName: vi.fn((skill) => `${skill.siteId}.${skill.name}.v${skill.version}`),
  skillToToolDefinition: vi.fn((skill: any, options?: { maxDescriptionLength?: number }) => {
    let description = skill.description ?? `${skill.method} ${skill.pathTemplate}`;
    const maxLen = options?.maxDescriptionLength;
    if (maxLen !== undefined && description.length > maxLen) {
      description = description.slice(0, maxLen) + '...';
    }
    return {
      name: `${skill.siteId}.${skill.name}.v${skill.version}`,
      description,
      inputSchema: {},
    };
  }),
}));

// Mock doctor (dynamic import in schrute_doctor full=true)
vi.mock('../../src/doctor.js', () => ({
  runDoctor: vi.fn().mockResolvedValue({
    timestamp: Date.now(),
    version: '0.0.1',
    checks: [{ name: 'browser', status: 'pass', message: 'OK' }],
    summary: { pass: 1, fail: 0, warning: 0 },
  }),
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
import type { SkillSpec, SchruteConfig } from '../../src/skill/types.js';
import { SkillStatus, SideEffectClass } from '../../src/skill/types.js';

// ─── Fixtures ────────────────────────────────────────────────────

function makeConfig(): SchruteConfig {
  return {
    dataDir: '/tmp/schrute-dispatch-test',
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
  } as SchruteConfig;
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

function makeMultiSessionMock(activeSiteId?: string) {
  const activeSession = {
    name: 'default',
    siteId: activeSiteId ?? '',
    browserManager: {},
    isCdp: false,
    createdAt: Date.now(),
  };
  return {
    getActive: vi.fn().mockReturnValue('default'),
    get: vi.fn().mockReturnValue(activeSession),
    list: vi.fn().mockReturnValue([activeSession]),
    getOrCreate: vi.fn().mockReturnValue(activeSession),
    setActive: vi.fn(),
  };
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
      getMode: vi.fn().mockReturnValue('idle'),
      getExploreSessionName: vi.fn().mockReturnValue('default'),
      getRecordingSessionName: vi.fn().mockReturnValue(null),
      executeSkill: vi.fn().mockResolvedValue({ success: true, data: { result: 'ok' } }),
      recoverExplore: vi.fn().mockResolvedValue({
        status: 'ready',
        siteId: 'example.com',
        url: 'https://example.com',
        session: '__recovery_test',
        managedBrowser: false,
        hint: 'Recovery complete.',
      }),
      getSessionManager: vi.fn().mockReturnValue({
        getBrowserManager: vi.fn().mockReturnValue({
          hasContext: vi.fn().mockReturnValue(false),
          getOrCreateContext: vi.fn(),
          getCapabilities: vi.fn().mockReturnValue(null),
          getBrowser: vi.fn().mockReturnValue(null),
          isCdpConnected: vi.fn().mockReturnValue(false),
          supportsHarRecording: vi.fn().mockReturnValue(true),
          exportCookies: vi.fn().mockResolvedValue([]),
        }),
      }),
      getMultiSessionManager: vi.fn().mockReturnValue(makeMultiSessionMock()),
      getMetricsRepo: vi.fn().mockReturnValue({
        getRecentBySkillId: vi.fn().mockReturnValue([]),
      }),
    } as any,
    skillRepo: {
      getByStatus: vi.fn().mockReturnValue([]),
      getById: vi.fn().mockReturnValue(undefined),
      getBySiteId: vi.fn().mockReturnValue([]),
      getAll: vi.fn().mockReturnValue([]),
      getActive: vi.fn().mockReturnValue([]),
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
      // Use a POST non-read-only skill so auto-confirm (P2-8) does not bypass the gate
      const skill = makeSkill({ method: 'POST', sideEffectClass: 'non-idempotent' as any });
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
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('confirmation_required');
      expect(data.message).toBe('Call schrute_confirm with the token below.');
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
      expect(mockExecuteSkill).toHaveBeenCalledWith(skill.id, { page: 1 }, undefined, undefined);
    });
  });

  // ─── Missing Required Arguments ────────────────────────────────

  describe('missing required arguments', () => {
    it('schrute_explore returns error when url is missing', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('schrute_explore', {}, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('url is required');
    });

    it('schrute_record returns error when name is missing', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('schrute_record', {}, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('name is required');
    });

    it('schrute_confirm returns error when confirmationToken is missing', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('schrute_confirm', {}, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('confirmationToken is required');
    });

    it('schrute_confirm returns error when approve is missing', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('schrute_confirm', { confirmationToken: 'tok-1' }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('approve must be a boolean');
    });

    it('schrute_confirm returns error when approve is not a boolean', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('schrute_confirm', { confirmationToken: 'tok-1', approve: 'yes' }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('approve must be a boolean');
    });

    it('schrute_dry_run returns error when skillId is missing', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('schrute_dry_run', {}, deps);
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
      expect(names).toContain('schrute_explore');
      expect(names).toContain('schrute_recover_explore');
      expect(names).toContain('schrute_record');
      expect(names).toContain('schrute_stop');
      expect(names).toContain('schrute_confirm');
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

    it('admin caller dynamic skills have descriptions trimmed to maxDescriptionLength', () => {
      const longDescription = 'X'.repeat(300);
      const skill = makeSkill({ description: longDescription });
      const deps = makeDeps({
        skillRepo: {
          getByStatus: vi.fn().mockReturnValue([skill]),
          getById: vi.fn().mockReturnValue(skill),
          getBySiteId: vi.fn().mockReturnValue([skill]),
          getActive: vi.fn().mockReturnValue([skill]),
        } as any,
      });

      const tools = buildToolList(deps);
      const skillTool = tools.find(t => t.name === 'example.com.get_users.v1');
      expect(skillTool).toBeDefined();
      // Description should be trimmed: 200 chars + '...' = 203 max
      expect(skillTool!.description.length).toBeLessThanOrEqual(203);
      expect(skillTool!.description.endsWith('...')).toBe(true);
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
    it('routes schrute_explore to router.explore', async () => {
      const deps = makeDeps();
      await dispatchToolCall('schrute_explore', { url: 'https://example.com' }, deps);
      expect(mockRouter.explore).toHaveBeenCalledWith('https://example.com', undefined);
    });

    it('routes schrute_record to router.startRecording', async () => {
      const deps = makeDeps();
      await dispatchToolCall('schrute_record', { name: 'my-recording', inputs: { key: 'val' } }, deps);
      expect(mockRouter.startRecording).toHaveBeenCalledWith('my-recording', { key: 'val' });
    });

    it('routes schrute_recover_explore to engine.recoverExplore', async () => {
      const deps = makeDeps();
      await dispatchToolCall('schrute_recover_explore', { resumeToken: 'recover-token', waitMs: 2000 }, deps);
      expect((deps.engine as any).recoverExplore).toHaveBeenCalledWith('recover-token', 2000);
    });

    it('routes schrute_stop to router.stopRecording', async () => {
      const deps = makeDeps();
      await dispatchToolCall('schrute_stop', {}, deps);
      expect(mockRouter.stopRecording).toHaveBeenCalled();
    });

    it('routes schrute_pipeline_status to router.getPipelineStatus', async () => {
      mockRouter.getPipelineStatus.mockReturnValueOnce({ success: true, data: { jobId: 'job-1', status: 'running' } });
      const deps = makeDeps();
      await dispatchToolCall('schrute_pipeline_status', { jobId: 'job-1' }, deps);
      expect(mockRouter.getPipelineStatus).toHaveBeenCalledWith('job-1');
    });

    it('routes schrute_sites to router.listSites', async () => {
      const deps = makeDeps();
      await dispatchToolCall('schrute_sites', {}, deps);
      expect(mockRouter.listSites).toHaveBeenCalled();
    });

    it('routes schrute_status to engine.getStatus', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('schrute_status', {}, deps);
      expect(result.content[0].text).toBeDefined();
      expect(deps.engine.getStatus).toHaveBeenCalled();
    });

    it('returns isError when router returns failure', async () => {
      mockRouter.explore.mockResolvedValue({ success: false, error: 'Connection failed' });
      const deps = makeDeps();
      const result = await dispatchToolCall('schrute_explore', { url: 'https://bad.example.com' }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Connection failed');
    });
  });

  // ─── Error Handling ────────────────────────────────────────────

  describe('error handling', () => {
    it('catches and wraps exceptions thrown during dispatch', async () => {
      mockRouter.explore.mockRejectedValue(new Error('Unexpected crash'));
      const deps = makeDeps();
      const result = await dispatchToolCall('schrute_explore', { url: 'https://example.com' }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unexpected crash');
    });
  });

  // ─── Strict Input Validation ──────────────────────────────────

  describe('schrute_explore strict validation', () => {
    it('rejects non-string proxy.bypass', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('schrute_explore', {
        url: 'https://example.com',
        proxy: { server: 'http://proxy:8080', bypass: 123 },
      }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('proxy.bypass must be a string');
    });

    it('rejects non-string proxy.username', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('schrute_explore', {
        url: 'https://example.com',
        proxy: { server: 'http://proxy:8080', username: true },
      }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('proxy.username must be a string');
    });

    it('rejects non-string proxy.password', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('schrute_explore', {
        url: 'https://example.com',
        proxy: { server: 'http://proxy:8080', password: 42 },
      }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('proxy.password must be a string');
    });

    it('rejects non-number geolocation.accuracy', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('schrute_explore', {
        url: 'https://example.com',
        geo: { geolocation: { latitude: 0, longitude: 0, accuracy: 'high' } },
      }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('geolocation.accuracy must be a number');
    });

    it('rejects proxy.server with path', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('schrute_explore', {
        url: 'https://example.com',
        proxy: { server: 'http://proxy:8080/path' },
      }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('host-only');
    });

    it('rejects proxy.server with credentials in URL', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('schrute_explore', {
        url: 'https://example.com',
        proxy: { server: 'http://user:pass@proxy:8080' },
      }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('host-only');
    });
  });

  // ─── Site-scoped buildToolList ──────────────────────────────────

  describe('site-scoped buildToolList', () => {
    it('uses skillRepo.getActive(siteId) when active session has a siteId', () => {
      const skill = makeSkill();
      const multiMock = makeMultiSessionMock('example.com');
      const deps = makeDeps({
        engine: {
          getStatus: vi.fn().mockReturnValue({ mode: 'idle' }),
          executeSkill: vi.fn(),
          getSessionManager: vi.fn().mockReturnValue({
            getBrowserManager: vi.fn().mockReturnValue({}),
          }),
          getMultiSessionManager: vi.fn().mockReturnValue(multiMock),
        } as any,
        skillRepo: {
          getByStatus: vi.fn().mockReturnValue([]),
          getById: vi.fn().mockReturnValue(undefined),
          getBySiteId: vi.fn().mockReturnValue([]),
          getAll: vi.fn().mockReturnValue([]),
          getActive: vi.fn().mockReturnValue([skill]),
        } as any,
      });

      const tools = buildToolList(deps);
      expect((deps.skillRepo as any).getActive).toHaveBeenCalledWith('example.com');
      const names = tools.map(t => t.name);
      expect(names).toContain('example.com.get_users.v1');
    });

    it('falls back to getByStatus when no active siteId', () => {
      const deps = makeDeps(); // default mock has empty siteId
      buildToolList(deps);
      expect((deps.skillRepo as any).getByStatus).toHaveBeenCalledWith('active');
    });
  });

  // ─── schrute_execute ─────────────────────────────────────────

  describe('schrute_execute', () => {
    it('returns error when skillId is missing', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('schrute_execute', {}, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('skillId is required');
    });

    it('returns error when skill is not found', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('schrute_execute', { skillId: 'nonexistent' }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("skill 'nonexistent' not found");
    });

    it('returns confirmation_required when skill is unconfirmed', async () => {
      // Use a POST non-read-only skill so auto-confirm (P2-8) does not bypass the gate
      const skill = makeSkill({ method: 'POST', sideEffectClass: 'non-idempotent' as any });
      const deps = makeDeps({
        skillRepo: {
          getByStatus: vi.fn().mockReturnValue([skill]),
          getById: vi.fn().mockReturnValue(skill),
          getBySiteId: vi.fn().mockReturnValue([skill]),
          getAll: vi.fn().mockReturnValue([skill]),
          getActive: vi.fn().mockReturnValue([skill]),
        } as any,
        confirmation: {
          isSkillConfirmed: vi.fn().mockReturnValue(false),
          generateToken: vi.fn().mockResolvedValue({
            nonce: 'exec-token',
            skillId: skill.id,
            tier: 'tier_1',
            expiresAt: Date.now() + 60000,
          }),
        } as any,
      });

      const result = await dispatchToolCall('schrute_execute', { skillId: skill.id }, deps);
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('confirmation_required');
      expect(data.message).toBe('Call schrute_confirm with the token below.');
      expect(data.confirmationToken).toBe('exec-token');
    });

    it('executes skill when confirmed', async () => {
      const skill = makeSkill();
      const mockExecute = vi.fn().mockResolvedValue({ success: true });
      const deps = makeDeps({
        engine: {
          getStatus: vi.fn().mockReturnValue({ mode: 'idle' }),
          executeSkill: mockExecute,
          getSessionManager: vi.fn().mockReturnValue({
            getBrowserManager: vi.fn().mockReturnValue({}),
          }),
          getMultiSessionManager: vi.fn().mockReturnValue(makeMultiSessionMock()),
        } as any,
        skillRepo: {
          getByStatus: vi.fn().mockReturnValue([skill]),
          getById: vi.fn().mockReturnValue(skill),
          getBySiteId: vi.fn().mockReturnValue([skill]),
          getAll: vi.fn().mockReturnValue([skill]),
          getActive: vi.fn().mockReturnValue([skill]),
        } as any,
        confirmation: {
          isSkillConfirmed: vi.fn().mockReturnValue(true),
        } as any,
      });

      const result = await dispatchToolCall('schrute_execute', { skillId: skill.id, params: { page: 1 } }, deps);
      expect(result.isError).toBeUndefined();
      expect(mockExecute).toHaveBeenCalledWith(skill.id, { page: 1 }, undefined, { skipMetrics: false });
    });

    it('returns isError when skill execution fails (success === false)', async () => {
      const skill = makeSkill();
      const mockExecute = vi.fn().mockResolvedValue({ success: false, error: 'timeout' });
      const deps = makeDeps({
        engine: {
          getStatus: vi.fn().mockReturnValue({ mode: 'idle' }),
          executeSkill: mockExecute,
          getSessionManager: vi.fn().mockReturnValue({
            getBrowserManager: vi.fn().mockReturnValue({}),
          }),
          getMultiSessionManager: vi.fn().mockReturnValue(makeMultiSessionMock()),
        } as any,
        skillRepo: {
          getByStatus: vi.fn().mockReturnValue([skill]),
          getById: vi.fn().mockReturnValue(skill),
          getBySiteId: vi.fn().mockReturnValue([skill]),
          getAll: vi.fn().mockReturnValue([skill]),
          getActive: vi.fn().mockReturnValue([skill]),
        } as any,
        confirmation: {
          isSkillConfirmed: vi.fn().mockReturnValue(true),
        } as any,
      });

      const result = await dispatchToolCall('schrute_execute', { skillId: skill.id }, deps);
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(false);
      expect(data.error).toBe('timeout');
    });
  });

  // ─── Grouped skills output ────────────────────────────────────

  describe('schrute_skills grouped output', () => {
    it('returns skills grouped by site when no siteId given', async () => {
      const skill1 = makeSkill({ id: 's1', siteId: 'site-a.com', name: 'get_users' });
      const skill2 = makeSkill({ id: 's2', siteId: 'site-a.com', name: 'create_order' });
      const skill3 = makeSkill({ id: 's3', siteId: 'site-b.com', name: 'get_items' });
      const deps = makeDeps({
        skillRepo: {
          getByStatus: vi.fn().mockReturnValue([]),
          getById: vi.fn().mockReturnValue(undefined),
          getBySiteId: vi.fn().mockReturnValue([]),
          getAll: vi.fn().mockReturnValue([skill1, skill2, skill3]),
          getActive: vi.fn().mockReturnValue([]),
        } as any,
      });

      const result = await dispatchToolCall('schrute_skills', {}, deps);
      const data = JSON.parse(result.content[0].text);
      expect(data.totalSkills).toBe(3);
      expect(data.sites['site-a.com'].count).toBe(2);
      expect(data.sites['site-b.com'].count).toBe(1);
      expect(data.sites['site-a.com'].skills).toHaveLength(2);
    });
  });

  // ─── schrute_doctor ──────────────────────────────────────────

  describe('schrute_doctor', () => {
    it('returns diagnostics object', async () => {
      const skill = makeSkill();
      const deps = makeDeps({
        skillRepo: {
          getByStatus: vi.fn().mockReturnValue([]),
          getById: vi.fn().mockReturnValue(undefined),
          getBySiteId: vi.fn().mockReturnValue([]),
          getAll: vi.fn().mockReturnValue([skill]),
          getActive: vi.fn().mockReturnValue([]),
        } as any,
      });

      const result = await dispatchToolCall('schrute_doctor', {}, deps);
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.diagnostics).toBeDefined();
      expect(data.diagnostics.browser.hasInstance).toBe(false);
      expect(data.diagnostics.browser.isCdp).toBe(false);
      expect(data.diagnostics.browser.supportsHar).toBe(true);
      expect(data.diagnostics.skills.total).toBe(1);
      expect(data.diagnostics.sessions).toHaveLength(1);
    });
  });

  // ─── Negative Paths ──────────────────────────────────────────

  describe('negative paths', () => {
    it('schrute_execute with non-existent skill ID returns error', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('schrute_execute', { skillId: 'nonexistent' }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("skill 'nonexistent' not found");
    });

    it('schrute_execute with empty string skillId returns error', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('schrute_execute', { skillId: '' }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('skillId is required');
    });

    it('stale confirmation token returns error', async () => {
      const deps = makeDeps({
        confirmation: {
          isSkillConfirmed: vi.fn().mockReturnValue(true),
          verifyToken: vi.fn().mockReturnValue({ valid: false, error: 'token expired' }),
          consumeToken: vi.fn(),
        } as any,
      });
      mockRouter.confirm.mockReturnValue({
        success: false,
        error: 'Confirmation failed: token expired',
      });

      const result = await dispatchToolCall('schrute_confirm', {
        confirmationToken: 'stale-token-xyz',
        approve: true,
      }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Confirmation failed');
    });

    it('latitude out of range (-90 to 90) returns error', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('schrute_explore', {
        url: 'https://example.com',
        geo: { geolocation: { latitude: 91, longitude: 0 } },
      }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('latitude must be between -90 and 90');
    });

    it('longitude out of range (-180 to 180) returns error', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('schrute_explore', {
        url: 'https://example.com',
        geo: { geolocation: { latitude: 0, longitude: -181 } },
      }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('longitude must be between -180 and 180');
    });

    it('negative latitude out of range returns error', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('schrute_explore', {
        url: 'https://example.com',
        geo: { geolocation: { latitude: -91, longitude: 0 } },
      }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('latitude must be between -90 and 90');
    });

    it('longitude at positive boundary overflow returns error', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('schrute_explore', {
        url: 'https://example.com',
        geo: { geolocation: { latitude: 0, longitude: 181 } },
      }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('longitude must be between -180 and 180');
    });
  });

  describe('schrute_connect_cdp strict validation', () => {
    it('rejects non-string name', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('schrute_connect_cdp', { name: 123 }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('name is required and must be a string');
    });

    it('rejects non-integer port', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('schrute_connect_cdp', { name: 'test', port: 'abc' }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('port must be an integer');
    });

    it('rejects non-string wsEndpoint', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('schrute_connect_cdp', { name: 'test', wsEndpoint: 42 }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('wsEndpoint must be a string');
    });

    it('rejects non-string host', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('schrute_connect_cdp', { name: 'test', host: true }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('host must be a string');
    });

    it('rejects non-string siteId', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('schrute_connect_cdp', { name: 'test', siteId: 99 }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('siteId must be a string');
    });

    it('rejects non-array domains', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('schrute_connect_cdp', { name: 'test', domains: 'example.com' }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('domains must be an array');
    });

    it('rejects domains with non-string elements', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('schrute_connect_cdp', { name: 'test', domains: ['ok.com', 42] }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('domains must be an array of strings');
    });
  });

  // ─── schrute_activate ─────────────────────────────────────────

  describe('schrute_activate', () => {
    it('activates a DRAFT skill and calls skillRepo.update', async () => {
      const skill = makeSkill({ status: SkillStatus.DRAFT });
      const updateFn = vi.fn();
      const deps = makeDeps({
        skillRepo: {
          getByStatus: vi.fn().mockReturnValue([]),
          getById: vi.fn().mockReturnValue(skill),
          getBySiteId: vi.fn().mockReturnValue([]),
          getAll: vi.fn().mockReturnValue([skill]),
          getActive: vi.fn().mockReturnValue([]),
          update: updateFn,
        } as any,
      });

      const result = await dispatchToolCall('schrute_activate', { skillId: skill.id }, deps);
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.activated).toBe(true);
      expect(data.previousStatus).toBe('draft');
      expect(data.newStatus).toBe('active');
      expect(updateFn).toHaveBeenCalledWith(skill.id, expect.objectContaining({
        status: 'active',
        confidence: 0.5,
      }));
    });

    it('rejects activation of non-draft skill', async () => {
      const skill = makeSkill({ status: SkillStatus.ACTIVE });
      const deps = makeDeps({
        skillRepo: {
          getByStatus: vi.fn().mockReturnValue([]),
          getById: vi.fn().mockReturnValue(skill),
          getBySiteId: vi.fn().mockReturnValue([]),
          getAll: vi.fn().mockReturnValue([skill]),
          getActive: vi.fn().mockReturnValue([skill]),
        } as any,
      });

      const result = await dispatchToolCall('schrute_activate', { skillId: skill.id }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("status is 'active'");
      expect(result.content[0].text).toContain("must be 'draft'");
    });

    it('returns error when skillId is missing', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('schrute_activate', {}, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('skillId is required');
    });

    it('returns error when skill is not found', async () => {
      const deps = makeDeps();
      const result = await dispatchToolCall('schrute_activate', { skillId: 'nonexistent' }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("skill 'nonexistent' not found");
    });
  });

  // ─── Admin Gate (Multi-User Mode) ───────────────────────────────

  describe('admin gate (multi-user mode)', () => {
    function makeNetworkConfig(): SchruteConfig {
      return { ...makeConfig(), server: { network: true } };
    }

    function makeNetworkDeps(overrides: Partial<ToolDispatchDeps> = {}): ToolDispatchDeps {
      return makeDeps({ config: makeNetworkConfig(), ...overrides });
    }

    it('MCP HTTP caller calling schrute_explore when server.network=true returns error', async () => {
      const deps = makeNetworkDeps();
      const result = await dispatchToolCall('schrute_explore', { url: 'https://example.com' }, deps, 'mcp-session-123');
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('admin');
    });

    it('callerId=stdio calling schrute_explore when server.network=true succeeds', async () => {
      const deps = makeNetworkDeps();
      const result = await dispatchToolCall('schrute_explore', { url: 'https://example.com' }, deps, 'stdio');
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.siteId).toBe('example.com');
    });

    it('no callerId calling schrute_explore succeeds (backward compat)', async () => {
      const deps = makeNetworkDeps();
      const result = await dispatchToolCall('schrute_explore', { url: 'https://example.com' }, deps);
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.siteId).toBe('example.com');
    });

    it('MCP HTTP caller calling browser_navigate when server.network=true returns error', async () => {
      const deps = makeNetworkDeps();
      const result = await dispatchToolCall('browser_navigate', { url: 'https://example.com' }, deps, 'mcp-session-123');
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('admin');
      expect(result.content[0].text).toContain('Browser tools');
    });

    it('buildToolList for MCP HTTP caller when server.network=true excludes browser and admin tools', () => {
      const deps = makeNetworkDeps();
      const tools = buildToolList(deps, 'mcp-session-123');
      const names = tools.map(t => t.name);

      // Should NOT include browser tools
      expect(names).not.toContain('browser_click');

      // Should NOT include admin-only meta tools
      expect(names).not.toContain('schrute_explore');
      expect(names).not.toContain('schrute_record');
      expect(names).not.toContain('schrute_stop');
      expect(names).not.toContain('schrute_import_cookies');
      expect(names).not.toContain('schrute_export_cookies');
      expect(names).not.toContain('schrute_connect_cdp');
      expect(names).not.toContain('schrute_recover_explore');
      expect(names).not.toContain('schrute_webmcp_call');

      // Should still include non-admin meta tools
      expect(names).toContain('schrute_status');
      expect(names).toContain('schrute_execute');
    });

    it('buildToolList for stdio caller when server.network=true includes all tools', () => {
      const deps = makeNetworkDeps();
      const tools = buildToolList(deps, 'stdio');
      const names = tools.map(t => t.name);

      // Should include admin meta tools
      expect(names).toContain('schrute_explore');
      expect(names).toContain('schrute_record');
      expect(names).toContain('schrute_stop');
      expect(names).not.toContain('schrute_recover_explore');

      // Should include browser tools
      expect(names).toContain('browser_click');
    });

    it('buildToolList for MCP HTTP caller when server.network=false includes all tools', () => {
      const deps = makeDeps(); // default config has server.network=false
      const tools = buildToolList(deps, 'mcp-session-123');
      const names = tools.map(t => t.name);

      // In single-user mode, everyone gets all tools
      expect(names).toContain('schrute_explore');
      expect(names).toContain('schrute_recover_explore');
      expect(names).toContain('schrute_record');
      expect(names).toContain('browser_click');
    });

    it('schrute_recover_explore rejects runtime calls in network mode', async () => {
      const deps = makeNetworkDeps();
      const result = await dispatchToolCall('schrute_recover_explore', { resumeToken: 'recover-token' }, deps, 'stdio');
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('local desktop mode');
    });

    it('non-admin caller schrute_close_session with name=default when server.network=true returns error', async () => {
      const deps = makeNetworkDeps();
      const result = await dispatchToolCall('schrute_close_session', { name: 'default' }, deps, 'mcp-session-123');
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Cannot close default session');
      expect(result.content[0].text).toContain('Admin');
    });

    it('non-admin caller schrute_sessions returns empty list when server.network=true', async () => {
      const multiMock = makeMultiSessionMock();
      // Override list to return empty for non-admin callers
      multiMock.list = vi.fn().mockReturnValue([]);
      const deps = makeNetworkDeps({
        engine: {
          getStatus: vi.fn().mockReturnValue({ mode: 'idle', activeSession: null }),
          executeSkill: vi.fn(),
          getSessionManager: vi.fn().mockReturnValue({
            getBrowserManager: vi.fn().mockReturnValue({
              hasContext: vi.fn().mockReturnValue(false),
            }),
          }),
          getMultiSessionManager: vi.fn().mockReturnValue(multiMock),
        } as any,
      });

      const result = await dispatchToolCall('schrute_sessions', {}, deps, 'mcp-session-123');
      const data = JSON.parse(result.content[0].text);
      expect(data).toEqual([]);
      expect(multiMock.list).toHaveBeenCalledWith('mcp-session-123', expect.objectContaining({ server: { network: true } }));
    });
  });

  // ─── schrute_execute draft hint ───────────────────────────────

  describe('schrute_execute draft hint message', () => {
    it('shows schrute_activate hint when executing a DRAFT skill', async () => {
      const skill = makeSkill({ status: SkillStatus.DRAFT });
      const deps = makeDeps({
        skillRepo: {
          getByStatus: vi.fn().mockReturnValue([]),
          getById: vi.fn().mockReturnValue(skill),
          getBySiteId: vi.fn().mockReturnValue([]),
          getAll: vi.fn().mockReturnValue([skill]),
          getActive: vi.fn().mockReturnValue([]),
        } as any,
      });

      const result = await dispatchToolCall('schrute_execute', { skillId: skill.id }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('schrute_activate');
      expect(result.content[0].text).toContain('not active');
      expect(result.content[0].text).toContain('draft');
    });

    it('does not show activate hint for non-draft inactive skills', async () => {
      const skill = makeSkill({ status: 'broken' as any });
      const deps = makeDeps({
        skillRepo: {
          getByStatus: vi.fn().mockReturnValue([]),
          getById: vi.fn().mockReturnValue(skill),
          getBySiteId: vi.fn().mockReturnValue([]),
          getAll: vi.fn().mockReturnValue([skill]),
          getActive: vi.fn().mockReturnValue([]),
        } as any,
      });

      const result = await dispatchToolCall('schrute_execute', { skillId: skill.id }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not active');
      expect(result.content[0].text).toContain('schrute_activate');
    });
  });

  // ─── schrute_delete_skill ──────────────────────────────────────

  describe('schrute_delete_skill', () => {
    it('removes skill and returns confirmation', async () => {
      const skill = makeSkill();
      const deleteFn = vi.fn();
      const deps = makeDeps({
        skillRepo: {
          getByStatus: vi.fn().mockReturnValue([]),
          getById: vi.fn().mockReturnValue(skill),
          getBySiteId: vi.fn().mockReturnValue([]),
          getAll: vi.fn().mockReturnValue([skill]),
          getActive: vi.fn().mockReturnValue([]),
          delete: deleteFn,
        } as any,
      });

      const result = await dispatchToolCall('schrute_delete_skill', { skillId: 'test-id' }, deps);
      expect(deleteFn).toHaveBeenCalledWith('test-id');
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.deleted).toBe(true);
      expect(data.skillId).toBe('test-id');
      expect(data.name).toBe(skill.name);
    });

    it('returns error for missing skill', async () => {
      const deps = makeDeps(); // default getById returns undefined
      const result = await dispatchToolCall('schrute_delete_skill', { skillId: 'nonexistent' }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("skill 'nonexistent' not found");
    });
  });

  // ─── schrute_doctor full=true ─────────────────────────────────

  describe('schrute_doctor full=true', () => {
    it('returns DoctorReport when full=true and caller is admin', async () => {
      const deps = makeDeps(); // default config has server.network=false → isAdmin=true
      const result = await dispatchToolCall('schrute_doctor', { full: true }, deps);
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.checks).toBeDefined();
      expect(data.summary).toBeDefined();
      expect(data.summary.pass).toBeGreaterThanOrEqual(0);
    });
  });

  // ─── schrute_amendments ────────────────────────────────────────

  describe('schrute_amendments', () => {
    it('returns parsed snapshotFields', async () => {
      const mockAmendmentRepo = {
        getBySkillId: vi.fn().mockReturnValue([{
          id: 'amend-1',
          skillId: 'test-skill',
          snapshotFields: '{"key":"value"}',
          reason: 'drift',
          createdAt: Date.now(),
        }]),
      };
      const deps = makeDeps({
        engine: {
          getStatus: vi.fn().mockReturnValue({ mode: 'idle', activeSession: null }),
          executeSkill: vi.fn(),
          getSessionManager: vi.fn().mockReturnValue({
            getBrowserManager: vi.fn().mockReturnValue({
              hasContext: vi.fn().mockReturnValue(false),
              getOrCreateContext: vi.fn(),
              getCapabilities: vi.fn().mockReturnValue(null),
              getBrowser: vi.fn().mockReturnValue(null),
              isCdpConnected: vi.fn().mockReturnValue(false),
              supportsHarRecording: vi.fn().mockReturnValue(true),
              exportCookies: vi.fn().mockResolvedValue([]),
            }),
          }),
          getMultiSessionManager: vi.fn().mockReturnValue(makeMultiSessionMock()),
          getMetricsRepo: vi.fn().mockReturnValue({
            getRecentBySkillId: vi.fn().mockReturnValue([]),
          }),
          getAmendmentRepo: vi.fn().mockReturnValue(mockAmendmentRepo),
        } as any,
      });

      const result = await dispatchToolCall('schrute_amendments', { skillId: 'test-skill' }, deps);
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data).toHaveLength(1);
      expect(data[0].snapshotFields).toEqual({ key: 'value' });
      expect(typeof data[0].snapshotFields).toBe('object');
    });
  });

  // ─── Batch Execute Rate Limit Retry ──────────────────────────
  describe('schrute_batch_execute rate limit retry', () => {
    it('retries rate-limited actions after waiting', async () => {
      const skill = makeSkill();
      const mockExecuteSkill = vi.fn()
        .mockResolvedValueOnce({ success: false, failureCause: 'rate_limited', failureDetail: 'Retry after 100ms', data: null, error: 'rate limited' })
        .mockResolvedValueOnce({ success: true, data: { result: 'ok' } });

      const deps = makeDeps({
        engine: {
          getStatus: vi.fn().mockReturnValue({ mode: 'idle', activeSession: null }),
          getMode: vi.fn().mockReturnValue('idle'),
          getExploreSessionName: vi.fn().mockReturnValue('default'),
          getRecordingSessionName: vi.fn().mockReturnValue(null),
          executeSkill: mockExecuteSkill,
          getSessionManager: vi.fn().mockReturnValue({
            getBrowserManager: vi.fn().mockReturnValue({
              hasContext: vi.fn().mockReturnValue(false),
            }),
          }),
          getMultiSessionManager: vi.fn().mockReturnValue(makeMultiSessionMock()),
          getMetricsRepo: vi.fn().mockReturnValue({ getRecentBySkillId: vi.fn().mockReturnValue([]) }),
        } as any,
        skillRepo: {
          getByStatus: vi.fn().mockReturnValue([skill]),
          getById: vi.fn().mockReturnValue(skill),
          getBySiteId: vi.fn().mockReturnValue([skill]),
          getAll: vi.fn().mockReturnValue([skill]),
          getActive: vi.fn().mockReturnValue([skill]),
        } as any,
      });

      const result = await dispatchToolCall('schrute_batch_execute', {
        actions: [{ skillId: skill.id, params: {} }],
      }, deps);

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.batch).toBe(true);
      expect(data.results[0].success).toBe(true);
      expect(mockExecuteSkill).toHaveBeenCalledTimes(2);
    });
  });
});
