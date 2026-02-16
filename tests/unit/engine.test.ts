import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock all heavy dependencies ─────────────────────────────────

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
    dataDir: '/tmp/oneagent-engine-test',
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
  }),
  ensureDirectories: vi.fn(),
  getDbPath: () => ':memory:',
  getDataDir: () => '/tmp/oneagent-engine-test',
  getBrowserDataDir: () => '/tmp/oneagent-engine-test/browser-data',
  getTmpDir: () => '/tmp/oneagent-engine-test/tmp',
  getAuditDir: () => '/tmp/oneagent-engine-test/audit',
  getSkillsDir: () => '/tmp/oneagent-engine-test/skills',
}));

// Mock database singleton
const mockDb = {
  run: vi.fn().mockReturnValue({ changes: 0 }),
  get: vi.fn().mockReturnValue(undefined),
  all: vi.fn().mockReturnValue([]),
  exec: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  transaction: vi.fn((fn: () => unknown) => fn()),
};

vi.mock('../../src/storage/database.js', () => ({
  getDatabase: () => mockDb,
  closeDatabase: vi.fn(),
  AgentDatabase: vi.fn().mockImplementation(() => mockDb),
}));

// Mock SkillRepository
vi.mock('../../src/storage/skill-repository.js', () => ({
  SkillRepository: vi.fn().mockImplementation(() => ({
    getById: vi.fn().mockReturnValue(undefined),
    create: vi.fn(),
    getBySiteId: vi.fn().mockReturnValue([]),
    getActive: vi.fn().mockReturnValue([]),
    update: vi.fn(),
    delete: vi.fn(),
  })),
}));

// Mock MetricsRepository
vi.mock('../../src/storage/metrics-repository.js', () => ({
  MetricsRepository: vi.fn().mockImplementation(() => ({
    record: vi.fn(),
    getForSkill: vi.fn().mockReturnValue([]),
  })),
}));

// Mock audit log
vi.mock('../../src/replay/audit-log.js', () => ({
  AuditLog: vi.fn().mockImplementation(() => ({
    initHmacKey: vi.fn().mockResolvedValue(undefined),
    append: vi.fn(),
  })),
}));

// Mock tool budget
vi.mock('../../src/replay/tool-budget.js', () => ({
  ToolBudgetTracker: vi.fn().mockImplementation(() => ({
    setDomainAllowlist: vi.fn(),
    checkBudget: vi.fn().mockReturnValue({ allowed: true }),
    recordCall: vi.fn(),
  })),
}));

// Mock rate limiter
vi.mock('../../src/automation/rate-limiter.js', () => ({
  RateLimiter: vi.fn().mockImplementation(() => ({
    checkRate: vi.fn().mockReturnValue({ allowed: true }),
    recordResponse: vi.fn(),
    setQps: vi.fn(),
  })),
}));

// Mock BrowserManager
const mockBrowserManager = {
  launchBrowser: vi.fn().mockResolvedValue({}),
  getOrCreateContext: vi.fn().mockResolvedValue({
    pages: () => [],
    newPage: vi.fn().mockResolvedValue({}),
  }),
  hasContext: vi.fn().mockReturnValue(false),
  closeContext: vi.fn().mockResolvedValue(undefined),
  closeBrowser: vi.fn().mockResolvedValue(undefined),
  getHarPath: vi.fn().mockReturnValue(null),
};

vi.mock('../../src/browser/manager.js', () => ({
  BrowserManager: vi.fn().mockImplementation(() => mockBrowserManager),
}));

// Mock PlaywrightMcpAdapter
vi.mock('../../src/browser/playwright-mcp-adapter.js', () => ({
  PlaywrightMcpAdapter: vi.fn(),
}));

// Mock session manager dependencies
const mockSessionCreate = vi.fn().mockResolvedValue({
  id: 'sess-1',
  siteId: 'example.com',
  url: 'https://example.com',
  createdAt: Date.now(),
});
const mockSessionResume = vi.fn().mockResolvedValue({
  id: 'sess-1',
  siteId: 'example.com',
  url: 'https://example.com',
  createdAt: Date.now(),
});
const mockSessionClose = vi.fn().mockResolvedValue(undefined);
const mockSessionListActive = vi.fn().mockReturnValue([]);

vi.mock('../../src/core/session.js', () => ({
  SessionManager: vi.fn().mockImplementation(() => ({
    create: mockSessionCreate,
    resume: mockSessionResume,
    close: mockSessionClose,
    listActive: mockSessionListActive,
    getBrowserManager: () => mockBrowserManager,
    getHarPath: vi.fn().mockReturnValue(null),
  })),
}));

// Mock capture pipeline dependencies
vi.mock('../../src/capture/auth-detector.js', () => ({
  detectAuth: vi.fn().mockReturnValue(null),
}));
vi.mock('../../src/native/param-discoverer.js', () => ({
  discoverParamsNative: vi.fn().mockReturnValue([]),
}));
vi.mock('../../src/capture/chain-detector.js', () => ({
  detectChains: vi.fn().mockReturnValue([]),
}));
vi.mock('../../src/capture/har-extractor.js', () => ({
  parseHar: vi.fn().mockReturnValue({ log: { entries: [] } }),
  extractRequestResponse: vi.fn().mockReturnValue({}),
}));
vi.mock('../../src/native/noise-filter.js', () => ({
  filterRequestsNative: vi.fn().mockReturnValue({ signal: [], noise: [] }),
}));
vi.mock('../../src/capture/api-extractor.js', () => ({
  clusterEndpoints: vi.fn().mockReturnValue([]),
}));
vi.mock('../../src/skill/generator.js', () => ({
  generateSkill: vi.fn(),
}));
vi.mock('../../src/replay/executor.js', () => ({
  executeSkill: vi.fn(),
}));
vi.mock('../../src/replay/retry.js', () => ({
  retryWithEscalation: vi.fn(),
}));
vi.mock('../../src/automation/cookie-refresh.js', () => ({
  refreshCookies: vi.fn().mockResolvedValue(undefined),
}));

// Mock policy functions
vi.mock('../../src/core/policy.js', () => ({
  checkCapability: vi.fn().mockReturnValue({ allowed: true }),
  enforceDomainAllowlist: vi.fn().mockReturnValue({ allowed: true }),
  checkMethodAllowed: vi.fn().mockReturnValue(true),
  checkPathRisk: vi.fn().mockReturnValue({ blocked: false }),
  getSitePolicy: vi.fn().mockReturnValue({
    domainAllowlist: ['example.com'],
    capabilities: [],
  }),
  setSitePolicy: vi.fn(),
}));

// Mock fs for session state
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue(''),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import { Engine } from '../../src/core/engine.js';
import { checkMethodAllowed, checkPathRisk } from '../../src/core/policy.js';
import { SkillRepository } from '../../src/storage/skill-repository.js';
import { retryWithEscalation } from '../../src/replay/retry.js';
import type { OneAgentConfig, SkillSpec } from '../../src/skill/types.js';

function makeConfig(): OneAgentConfig {
  return {
    dataDir: '/tmp/oneagent-engine-test',
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

describe('Engine', () => {
  let engine: Engine;

  beforeEach(() => {
    vi.clearAllMocks();
    engine = new Engine(makeConfig());
  });

  afterEach(async () => {
    try {
      await engine.close();
    } catch {
      // ignore cleanup errors
    }
  });

  // ─── State Machine: Initial State ──────────────────────────────

  describe('initial state', () => {
    it('starts in idle mode', () => {
      const status = engine.getStatus();
      expect(status.mode).toBe('idle');
    });

    it('has no active session initially', () => {
      const status = engine.getStatus();
      expect(status.activeSession).toBeNull();
    });

    it('has no current recording initially', () => {
      const status = engine.getStatus();
      expect(status.currentRecording).toBeNull();
    });

    it('reports uptime >= 0', () => {
      const status = engine.getStatus();
      expect(status.uptime).toBeGreaterThanOrEqual(0);
    });
  });

  // ─── State Machine: idle -> exploring ──────────────────────────

  describe('explore()', () => {
    it('transitions from idle to exploring', async () => {
      const result = await engine.explore('https://example.com');
      expect(result.siteId).toBe('example.com');
      expect(result.sessionId).toBe('sess-1');
      expect(engine.getStatus().mode).toBe('exploring');
    });

    it('creates a browser session', async () => {
      await engine.explore('https://example.com');
      expect(mockSessionCreate).toHaveBeenCalledWith('example.com', 'https://example.com');
    });

    it('rolls back on session creation failure', async () => {
      mockSessionCreate.mockRejectedValueOnce(new Error('Browser launch failed'));
      await expect(engine.explore('https://example.com')).rejects.toThrow('Browser launch failed');
      expect(engine.getStatus().mode).toBe('idle');
    });
  });

  // ─── State Machine: exploring -> recording ─────────────────────

  describe('startRecording()', () => {
    it('transitions from exploring to recording', async () => {
      await engine.explore('https://example.com');
      const recording = await engine.startRecording('test-recording');
      expect(recording.name).toBe('test-recording');
      expect(engine.getStatus().mode).toBe('recording');
    });

    it('throws if not in exploring mode', async () => {
      await expect(engine.startRecording('test')).rejects.toThrow(
        "Cannot start recording in 'idle' mode",
      );
    });

    it('preserves mode on failure', async () => {
      await engine.explore('https://example.com');
      mockSessionResume.mockRejectedValueOnce(new Error('Resume failed'));
      await expect(engine.startRecording('test')).rejects.toThrow('Resume failed');
      expect(engine.getStatus().mode).toBe('exploring');
    });
  });

  // ─── State Machine: recording -> exploring (stopRecording) ─────

  describe('stopRecording()', () => {
    it('throws when no active recording', async () => {
      await expect(engine.stopRecording()).rejects.toThrow('No active recording to stop');
    });

    it('throws when in idle mode', async () => {
      await expect(engine.stopRecording()).rejects.toThrow('No active recording to stop');
    });
  });

  // ─── executeSkill() ────────────────────────────────────────────

  describe('executeSkill()', () => {
    it('returns error when skill not found', async () => {
      const result = await engine.executeSkill('nonexistent', {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('returns error when method is not allowed by policy', async () => {
      // Set up skill repo to return a skill
      const mockSkill = {
        id: 'example.com.delete_user.v1',
        siteId: 'example.com',
        name: 'delete_user',
        method: 'DELETE',
        pathTemplate: '/api/users/:id',
        sideEffectClass: 'non-idempotent',
        allowedDomains: ['example.com'],
        currentTier: 'tier_1',
        tierLock: null,
      };
      const repoInstance = (SkillRepository as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value;
      if (repoInstance) {
        repoInstance.getById.mockReturnValueOnce(mockSkill);
      }
      // Make checkMethodAllowed return false
      (checkMethodAllowed as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);

      const result = await engine.executeSkill('example.com.delete_user.v1', {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('Policy blocked');
      expect(result.error).toContain('method');
    });

    it('returns error when path is flagged as risky', async () => {
      const mockSkill = {
        id: 'example.com.logout.v1',
        siteId: 'example.com',
        name: 'logout',
        method: 'GET',
        pathTemplate: '/api/logout',
        sideEffectClass: 'read-only',
        allowedDomains: ['example.com'],
        currentTier: 'tier_1',
        tierLock: null,
      };
      const repoInstance = (SkillRepository as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value;
      if (repoInstance) {
        repoInstance.getById.mockReturnValueOnce(mockSkill);
      }
      (checkMethodAllowed as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);
      (checkPathRisk as ReturnType<typeof vi.fn>).mockReturnValueOnce({ blocked: true, reason: 'Destructive GET pattern detected' });

      const result = await engine.executeSkill('example.com.logout.v1', {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('Policy blocked');
    });

    it('returns error when rate limited', async () => {
      const mockSkill = {
        id: 'example.com.get_data.v1',
        siteId: 'example.com',
        name: 'get_data',
        method: 'GET',
        pathTemplate: '/api/data',
        sideEffectClass: 'read-only',
        allowedDomains: ['example.com'],
        currentTier: 'tier_1',
        tierLock: null,
      };
      const repoInstance = (SkillRepository as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value;
      if (repoInstance) {
        repoInstance.getById.mockReturnValueOnce(mockSkill);
      }
      (checkMethodAllowed as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);
      (checkPathRisk as ReturnType<typeof vi.fn>).mockReturnValueOnce({ blocked: false });

      // The RateLimiter mock needs to return not-allowed
      const { RateLimiter } = await import('../../src/automation/rate-limiter.js');
      const rateLimiterInstance = (RateLimiter as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value;
      if (rateLimiterInstance) {
        rateLimiterInstance.checkRate.mockReturnValueOnce({ allowed: false, retryAfterMs: 5000 });
      }

      const result = await engine.executeSkill('example.com.get_data.v1', {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('Rate limited');
    });

    it('delegates to retryWithEscalation for read-only skills', async () => {
      const mockSkill = {
        id: 'example.com.get_users.v1',
        siteId: 'example.com',
        name: 'get_users',
        method: 'GET',
        pathTemplate: '/api/users',
        sideEffectClass: 'read-only',
        allowedDomains: ['example.com'],
        currentTier: 'tier_1',
        tierLock: null,
        authType: undefined,
      };
      const repoInstance = (SkillRepository as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value;
      if (repoInstance) {
        repoInstance.getById.mockReturnValueOnce(mockSkill);
      }
      (checkMethodAllowed as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);
      (checkPathRisk as ReturnType<typeof vi.fn>).mockReturnValueOnce({ blocked: false });

      // Mock the retry function to return success
      (retryWithEscalation as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        success: true,
        tier: 'direct',
        status: 200,
        data: { users: [] },
        rawBody: '{"users":[]}',
        headers: { 'content-type': 'application/json' },
        latencyMs: 42,
        schemaMatch: true,
        semanticPass: true,
        retryDecisions: [],
      });

      const result = await engine.executeSkill('example.com.get_users.v1', {});
      expect(result.success).toBe(true);
      expect(retryWithEscalation).toHaveBeenCalled();
    });
  });

  // ─── close() ──────────────────────────────────────────────────

  describe('close()', () => {
    it('transitions back to idle mode', async () => {
      await engine.close();
      expect(engine.getStatus().mode).toBe('idle');
    });

    it('handles close when already idle', async () => {
      await engine.close();
      expect(engine.getStatus().mode).toBe('idle');
    });

    it('closes active session on close', async () => {
      await engine.explore('https://example.com');
      await engine.close();
      expect(engine.getStatus().mode).toBe('idle');
    });
  });

  // ─── Invalid Transitions ───────────────────────────────────────

  describe('invalid state transitions', () => {
    it('cannot record from idle', async () => {
      await expect(engine.startRecording('test')).rejects.toThrow();
    });
  });
});
