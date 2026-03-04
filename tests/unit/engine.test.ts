import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createMockDb,
  createMockSiteRepoInstance,
  createMockBrowserManager,
  createMockSessionFns,
  makeConfig,
  getConfigMockValue,
} from '../helpers/engine-mocks.js';

// ─── Mock all heavy dependencies ─────────────────────────────────
// Mock object instances are created via shared helpers (tests/helpers/engine-mocks.ts)
// to keep engine.test.ts and engine-capture.test.ts in sync.

vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../src/core/config.js', () => ({
  getConfig: () => getConfigMockValue(),
  ensureDirectories: vi.fn(),
  getDbPath: () => ':memory:',
  getDataDir: () => '/tmp/oneagent-engine-test',
  getBrowserDataDir: () => '/tmp/oneagent-engine-test/browser-data',
  getTmpDir: () => '/tmp/oneagent-engine-test/tmp',
  getAuditDir: () => '/tmp/oneagent-engine-test/audit',
  getSkillsDir: () => '/tmp/oneagent-engine-test/skills',
}));

// Mock database singleton
const mockDb = createMockDb();

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
    updateConfidence: vi.fn(),
    updateTier: vi.fn(),
  })),
}));

// Mock SiteRepository
const mockSiteRepoInstance = createMockSiteRepoInstance();

vi.mock('../../src/storage/site-repository.js', () => ({
  SiteRepository: vi.fn().mockImplementation(() => mockSiteRepoInstance),
}));

// Mock MasteryLevel and ExecutionTier used by explore() site upsert
vi.mock('../../src/skill/types.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/skill/types.js')>('../../src/skill/types.js');
  return actual;
});

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
const mockBrowserManager = createMockBrowserManager();

vi.mock('../../src/browser/manager.js', () => {
  class ContextOverrideMismatchError extends Error {
    constructor(siteId: string) {
      super(`Context for '${siteId}' already exists with different proxy/geo settings.`);
      this.name = 'ContextOverrideMismatchError';
    }
  }
  return {
    BrowserManager: vi.fn().mockImplementation(() => mockBrowserManager),
    ContextOverrideMismatchError,
  };
});

// Mock PlaywrightMcpAdapter
vi.mock('../../src/browser/playwright-mcp-adapter.js', () => ({
  PlaywrightMcpAdapter: vi.fn(),
}));

// Mock detectAndWaitForChallenge from base-browser-adapter
const mockDetectAndWaitForChallenge = vi.fn().mockResolvedValue(false);
vi.mock('../../src/browser/base-browser-adapter.js', () => ({
  detectAndWaitForChallenge: (...args: unknown[]) => mockDetectAndWaitForChallenge(...args),
}));

// Mock session manager dependencies
const { mockSessionCreate, mockSessionResume, mockSessionClose, mockSessionListActive } = createMockSessionFns();

const mockSessionGetSession = vi.fn().mockReturnValue(undefined);
const mockSessionUpdateUrl = vi.fn();
const mockSessionRemove = vi.fn();

vi.mock('../../src/core/session.js', () => ({
  SessionManager: vi.fn().mockImplementation(() => ({
    create: mockSessionCreate,
    resume: mockSessionResume,
    close: mockSessionClose,
    listActive: mockSessionListActive,
    getBrowserManager: () => mockBrowserManager,
    getHarPath: vi.fn().mockReturnValue(null),
    getSession: mockSessionGetSession,
    updateUrl: mockSessionUpdateUrl,
    remove: mockSessionRemove,
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
  filterRequestsNative: vi.fn().mockReturnValue({ signal: [], noise: [], ambiguous: [] }),
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

// Mock classifier (wired into capture pipeline)
vi.mock('../../src/automation/classifier.js', () => ({
  classifySite: vi.fn().mockReturnValue({
    recommendedTier: 'direct',
    authRequired: false,
    dynamicFieldsDetected: false,
    graphqlDetected: false,
  }),
}));

// Mock strategy (wired into executeSkill)
vi.mock('../../src/automation/strategy.js', () => ({
  updateStrategy: vi.fn(),
  getStrategy: vi.fn().mockReturnValue({ defaultTier: 'browser_proxied', overrides: {} }),
}));

// Mock cold-start discovery (wired into explore)
vi.mock('../../src/discovery/cold-start.js', () => ({
  discoverSite: vi.fn().mockResolvedValue({
    siteId: 'example.com',
    sources: [],
    endpoints: [],
    trustRanking: {},
  }),
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

// Mock promotion module
vi.mock('../../src/core/promotion.js', () => ({
  canPromote: vi.fn().mockReturnValue({ eligible: false }),
  promoteSkill: vi.fn(),
}));

// Mock tiering module
vi.mock('../../src/core/tiering.js', () => ({
  handleFailure: vi.fn().mockReturnValue({
    newTier: 'tier_3',
    tierLock: { type: 'permanent', reason: 'js_computed_field', evidence: 'test' },
    reason: 'test',
  }),
}));

// Mock diff-engine
vi.mock('../../src/healing/diff-engine.js', () => ({
  detectDrift: vi.fn().mockReturnValue({ drifted: false, breaking: false, changes: [] }),
}));

// Mock monitor
vi.mock('../../src/healing/monitor.js', () => ({
  monitorSkills: vi.fn().mockReturnValue([{ skillId: 'test', status: 'healthy', successRate: 1.0, trend: 0, windowSize: 0 }]),
}));

// Mock notification
vi.mock('../../src/healing/notification.js', () => ({
  notify: vi.fn().mockResolvedValue(undefined),
  createEvent: vi.fn().mockReturnValue({ type: 'test', skillId: 'test', siteId: 'test', details: {}, timestamp: Date.now() }),
}));

// Mock graphql-extractor
vi.mock('../../src/capture/graphql-extractor.js', () => ({
  clusterByOperation: vi.fn().mockReturnValue([]),
  canReplayPersistedQuery: vi.fn().mockReturnValue(true),
  extractGraphQLInfo: vi.fn().mockReturnValue({ operationName: null, operationType: null, variables: null, query: null, isPersistedQuery: false }),
  isGraphQL: vi.fn().mockReturnValue(false),
}));

// Mock canonicalizer
vi.mock('../../src/capture/canonicalizer.js', () => ({
  canonicalizeRequest: vi.fn().mockImplementation((req: any) => ({
    method: req.method?.toUpperCase() ?? 'GET',
    canonicalUrl: req.url ?? '',
    canonicalBody: req.body,
  })),
}));

// Mock noise-filter's recordFilteredEntries
vi.mock('../../src/capture/noise-filter.js', () => ({
  recordFilteredEntries: vi.fn(),
}));

// Mock schema-inferrer
vi.mock('../../src/capture/schema-inferrer.js', () => ({
  inferSchema: vi.fn().mockReturnValue({ type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] }),
  mergeSchemas: vi.fn().mockImplementation((a: any, b: any) => ({ ...a, ...b })),
}));

// Mock webmcp-scanner
vi.mock('../../src/discovery/webmcp-scanner.js', () => ({
  loadCachedTools: vi.fn().mockReturnValue([]),
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

import { Engine, buildEnforcementSchema } from '../../src/core/engine.js';
import { ContextOverrideMismatchError } from '../../src/browser/manager.js';
import { checkMethodAllowed, checkPathRisk } from '../../src/core/policy.js';
import { SkillRepository } from '../../src/storage/skill-repository.js';
import { retryWithEscalation } from '../../src/replay/retry.js';
import { updateStrategy } from '../../src/automation/strategy.js';
import { discoverSite } from '../../src/discovery/cold-start.js';
import { canPromote, promoteSkill } from '../../src/core/promotion.js';
import { handleFailure } from '../../src/core/tiering.js';
import { detectDrift } from '../../src/healing/diff-engine.js';
import { monitorSkills } from '../../src/healing/monitor.js';
import { notify, createEvent } from '../../src/healing/notification.js';
import { inferSchema, mergeSchemas } from '../../src/capture/schema-inferrer.js';
import type { SkillSpec } from '../../src/skill/types.js';

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
      expect(mockSessionCreate).toHaveBeenCalledWith('example.com', 'https://example.com', undefined);
    });

    it('rolls back on session creation failure', async () => {
      mockSessionCreate.mockRejectedValueOnce(new Error('Browser launch failed'));
      await expect(engine.explore('https://example.com')).rejects.toThrow('Browser launch failed');
      expect(engine.getStatus().mode).toBe('idle');
    });

    it('registers site in DB when site does not exist', async () => {
      mockSiteRepoInstance.getById.mockReturnValueOnce(undefined);
      await engine.explore('https://example.com');
      expect(mockSiteRepoInstance.create).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'example.com',
          displayName: 'example.com',
        }),
      );
    });

    it('updates lastVisited when site already exists', async () => {
      mockSiteRepoInstance.getById.mockReturnValueOnce({
        id: 'example.com',
        displayName: 'example.com',
        firstSeen: 1000,
        lastVisited: 1000,
        masteryLevel: 'explore',
        recommendedTier: 'browser_proxied',
        totalRequests: 5,
        successfulRequests: 3,
      });
      await engine.explore('https://example.com');
      expect(mockSiteRepoInstance.create).not.toHaveBeenCalled();
      expect(mockSiteRepoInstance.update).toHaveBeenCalledWith(
        'example.com',
        expect.objectContaining({ lastVisited: expect.any(Number) }),
      );
    });

    it('triggers cold-start discovery after explore', async () => {
      await engine.explore('https://example.com');
      // Give the fire-and-forget promise a tick to resolve
      await new Promise(r => setTimeout(r, 10));
      expect(discoverSite).toHaveBeenCalledWith('https://example.com', expect.any(Object), undefined, expect.anything());
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

    it('rejects recording when active session is not default', async () => {
      await engine.explore('https://example.com');
      const msm = engine.getMultiSessionManager();
      msm.getOrCreate('other-session');
      msm.setActive('other-session');
      await expect(engine.startRecording('test')).rejects.toThrow(
        /Recording is only supported on the default session/,
      );
      // Restore for other tests
      msm.setActive('default');
    });

    it('counts responses via context-level listener across new pages', async () => {
      // Set up a mock context that supports on/off at context level
      const contextHandlers: Record<string, Function[]> = {};
      const mockContext = {
        pages: () => [],
        newPage: vi.fn().mockResolvedValue({}),
        on: vi.fn((event: string, handler: Function) => {
          if (!contextHandlers[event]) contextHandlers[event] = [];
          contextHandlers[event].push(handler);
        }),
        off: vi.fn(),
      };
      mockBrowserManager.tryGetContext.mockReturnValue(mockContext);

      await engine.explore('https://example.com');
      await engine.startRecording('context-counting');

      // Simulate responses from the context (covers pages created after recording start)
      const responseHandlers = contextHandlers['response'] ?? [];
      expect(responseHandlers.length).toBe(1);

      // Fire 3 response events
      responseHandlers[0]();
      responseHandlers[0]();
      responseHandlers[0]();

      // Check internal recording via getStatus() — startRecording returns a copy
      expect(engine.getStatus().currentRecording!.requestCount).toBe(3);

      // Restore mock
      mockBrowserManager.tryGetContext.mockReturnValue(undefined);
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

    it('calls updateStrategy after successful skill execution', async () => {
      const mockSkill = {
        id: 'example.com.get_items.v1',
        siteId: 'example.com',
        name: 'get_items',
        method: 'GET',
        pathTemplate: '/api/items',
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

      (retryWithEscalation as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        success: true,
        tier: 'direct',
        status: 200,
        data: {},
        rawBody: '{}',
        headers: {},
        latencyMs: 10,
        schemaMatch: true,
        semanticPass: true,
        retryDecisions: [],
      });

      await engine.executeSkill('example.com.get_items.v1', {});
      expect(updateStrategy).toHaveBeenCalledWith('example.com', expect.objectContaining({
        skillId: 'example.com.get_items.v1',
        tier: 'direct',
        success: true,
      }));
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

    it('forces cleanup when stopRecording hangs beyond timeout', async () => {
      // Put engine into recording state
      await engine.explore('https://example.com');
      await engine.startRecording('hang-test');
      expect(engine.getStatus().mode).toBe('recording');

      // Make closeContext hang forever so stopRecording never completes.
      // This simulates an unresponsive browser during shutdown.
      mockBrowserManager.closeContext.mockImplementation(() => new Promise(() => {}));

      // close() should still complete due to 8-second timeout.
      // We use vi.useFakeTimers to avoid waiting the full 8 seconds.
      vi.useFakeTimers();
      const closePromise = engine.close();

      // Advance past the 8-second timeout
      await vi.advanceTimersByTimeAsync(9000);

      await closePromise;
      vi.useRealTimers();

      // Restore closeContext mock so subsequent tests are not affected
      mockBrowserManager.closeContext.mockResolvedValue(undefined);

      // Engine should be in idle mode after forced cleanup
      expect(engine.getStatus().mode).toBe('idle');
      expect(engine.getStatus().currentRecording).toBeNull();
    });

    it('still transitions to idle when stopRecording throws', async () => {
      await engine.explore('https://example.com');
      await engine.startRecording('error-test');
      expect(engine.getStatus().mode).toBe('recording');

      // Make closeContext throw so that stopRecording() fails during close().
      // The close() method catches this error and continues cleanup.
      mockBrowserManager.closeContext.mockRejectedValueOnce(new Error('Browser crashed'));

      await engine.close();

      // Engine should still be in idle mode despite the error
      expect(engine.getStatus().mode).toBe('idle');
      expect(engine.getStatus().currentRecording).toBeNull();
    });

    it('isClosing flag prevents re-opening browser context during shutdown', async () => {
      await engine.explore('https://example.com');
      await engine.startRecording('closing-test');

      // Configure mocks: getHarPath returns null so capture pipeline exits early
      mockBrowserManager.getHarPath.mockReturnValue(null);

      // Track getOrCreateContext calls before close
      const callsBefore = mockBrowserManager.getOrCreateContext.mock.calls.length;

      await engine.close();

      // After close sets isClosing=true, stopRecording should NOT
      // call getOrCreateContext to re-open the browser context.
      // The re-open call only happens when !this.isClosing.
      const callsAfter = mockBrowserManager.getOrCreateContext.mock.calls.length;
      // No new getOrCreateContext calls should have been made during close
      expect(callsAfter).toBe(callsBefore);
      expect(engine.getStatus().mode).toBe('idle');
    });
  });

  // ─── Invalid Transitions ───────────────────────────────────────

  describe('invalid state transitions', () => {
    it('cannot record from idle', async () => {
      await expect(engine.startRecording('test')).rejects.toThrow();
    });
  });

  // ─── Wiring: Skill Lifecycle ────────────────────────────────────

  describe('wiring: skill lifecycle', () => {
    function setupSkillExecution(skillOverrides: Partial<SkillSpec>, executionResult: any) {
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
        authType: undefined,
        confidence: 0.5,
        consecutiveValidations: 2,
        sampleCount: 5,
        outputSchema: undefined,
        successRate: 0.8,
        ...skillOverrides,
      };
      const repoInstance = (SkillRepository as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value;
      if (repoInstance) {
        repoInstance.getById.mockReturnValueOnce(mockSkill);
      }
      (checkMethodAllowed as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);
      (checkPathRisk as ReturnType<typeof vi.fn>).mockReturnValueOnce({ blocked: false });
      (retryWithEscalation as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        success: true,
        tier: 'direct',
        status: 200,
        data: { id: 1 },
        rawBody: '{"id":1}',
        headers: { 'content-type': 'application/json' },
        latencyMs: 10,
        schemaMatch: true,
        semanticPass: true,
        retryDecisions: [],
        ...executionResult,
      });
      return { mockSkill, repoInstance };
    }

    it('increments validation counters on success', async () => {
      const { repoInstance } = setupSkillExecution(
        { confidence: 0.5, consecutiveValidations: 2 },
        { success: true },
      );
      await engine.executeSkill('example.com.get_data.v1', {});
      expect(repoInstance.updateConfidence).toHaveBeenCalledWith(
        'example.com.get_data.v1',
        0.6,
        3,
      );
    });

    it('resets validation counters on failure', async () => {
      const { repoInstance } = setupSkillExecution(
        { confidence: 0.5, consecutiveValidations: 2 },
        { success: false, failureCause: 'unknown' },
      );
      await engine.executeSkill('example.com.get_data.v1', {});
      expect(repoInstance.updateConfidence).toHaveBeenCalledWith(
        'example.com.get_data.v1',
        0.3,
        0,
      );
    });

    it('calls handleFailure on structural failure cause', async () => {
      setupSkillExecution(
        {},
        { success: false, failureCause: 'js_computed_field' },
      );
      await engine.executeSkill('example.com.get_data.v1', {});
      expect(handleFailure).toHaveBeenCalled();
    });

    it('infers schema on first successful execution', async () => {
      setupSkillExecution(
        { outputSchema: undefined, consecutiveValidations: 0 },
        { success: true, data: { id: 1, name: 'test' } },
      );
      await engine.executeSkill('example.com.get_data.v1', {});
      expect(inferSchema).toHaveBeenCalledWith([{ id: 1, name: 'test' }]);
    });

    it('accumulates schema when effectiveValidations < 3', async () => {
      setupSkillExecution(
        {
          outputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
          consecutiveValidations: 1,
        },
        { success: true, data: { id: 1, name: 'test' } },
      );
      await engine.executeSkill('example.com.get_data.v1', {});
      expect(mergeSchemas).toHaveBeenCalled();
      expect(detectDrift).not.toHaveBeenCalled();
    });

    it('runs drift detection when effectiveValidations >= 3', async () => {
      setupSkillExecution(
        {
          outputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
          consecutiveValidations: 4,
        },
        { success: true, data: { id: 1 } },
      );
      await engine.executeSkill('example.com.get_data.v1', {});
      expect(detectDrift).toHaveBeenCalled();
    });

    it('demotes skill on breaking drift', async () => {
      (detectDrift as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        drifted: true,
        breaking: true,
        changes: [{ path: '$.field', type: 'field_removed', breaking: true }],
      });
      const { repoInstance } = setupSkillExecution(
        {
          outputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
          consecutiveValidations: 5,
        },
        { success: true, data: { id: 1 } },
      );
      await engine.executeSkill('example.com.get_data.v1', {});
      expect(repoInstance.update).toHaveBeenCalledWith(
        'example.com.get_data.v1',
        expect.objectContaining({ status: 'stale', consecutiveValidations: 0 }),
      );
      expect(notify).toHaveBeenCalled();
    });

    it('marks skill as broken when health monitor detects broken status', async () => {
      (monitorSkills as ReturnType<typeof vi.fn>).mockReturnValueOnce([
        { skillId: 'example.com.get_data.v1', status: 'broken', successRate: 0.1, trend: -0.5, windowSize: 10 },
      ]);
      const { repoInstance } = setupSkillExecution({}, { success: true, data: { id: 1 } });
      await engine.executeSkill('example.com.get_data.v1', {});
      expect(repoInstance.update).toHaveBeenCalledWith(
        'example.com.get_data.v1',
        expect.objectContaining({ status: 'broken', consecutiveValidations: 0 }),
      );
    });

    it('sends degraded notification when health is degrading', async () => {
      (monitorSkills as ReturnType<typeof vi.fn>).mockReturnValueOnce([
        { skillId: 'example.com.get_data.v1', status: 'degrading', successRate: 0.6, trend: -0.2, windowSize: 50 },
      ]);
      setupSkillExecution({}, { success: true, data: { id: 1 } });
      await engine.executeSkill('example.com.get_data.v1', {});
      expect(notify).toHaveBeenCalled();
    });

    it('createEvent uses correct event type for broken skill', async () => {
      (monitorSkills as ReturnType<typeof vi.fn>).mockReturnValueOnce([
        { skillId: 'example.com.get_data.v1', status: 'broken', successRate: 0.1, trend: -0.5, windowSize: 10 },
      ]);
      setupSkillExecution({}, { success: true, data: { id: 1 } });
      await engine.executeSkill('example.com.get_data.v1', {});
      expect(createEvent).toHaveBeenCalledWith('skill_broken', 'example.com.get_data.v1', 'example.com',
        expect.objectContaining({ successRate: 0.1 }));
    });

    it('persists tier lock via updateTier on structural failure', async () => {
      const { repoInstance } = setupSkillExecution(
        {},
        { success: false, failureCause: 'js_computed_field' },
      );
      await engine.executeSkill('example.com.get_data.v1', {});
      expect(repoInstance.updateTier).toHaveBeenCalledWith(
        'example.com.get_data.v1',
        'tier_3',
        expect.objectContaining({ type: 'permanent', reason: 'js_computed_field' }),
      );
    });

    it('does not call handleFailure for non-structural failures', async () => {
      setupSkillExecution({}, { success: false, failureCause: 'rate_limited' });
      await engine.executeSkill('example.com.get_data.v1', {});
      expect(handleFailure).not.toHaveBeenCalled();
    });

    it('merges schema on non-breaking drift without demotion', async () => {
      (detectDrift as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        drifted: true,
        breaking: false,
        changes: [{ path: '$.newField', type: 'field_added', breaking: false }],
      });
      const { repoInstance } = setupSkillExecution(
        {
          outputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
          consecutiveValidations: 5,
        },
        { success: true, data: { id: 1, newField: 'hello' } },
      );
      await engine.executeSkill('example.com.get_data.v1', {});
      // Should merge schema (inferSchema + mergeSchemas called)
      expect(mergeSchemas).toHaveBeenCalled();
      // Should NOT demote
      expect(repoInstance.update).not.toHaveBeenCalledWith(
        'example.com.get_data.v1',
        expect.objectContaining({ status: 'stale' }),
      );
    });

    it('skips drift enforcement when high sampleCount but low consecutiveValidations', async () => {
      setupSkillExecution(
        {
          outputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
          sampleCount: 100,
          consecutiveValidations: 1, // Low — post-increment will be 2, still < 3
        },
        { success: true, data: { id: 1 } },
      );
      await engine.executeSkill('example.com.get_data.v1', {});
      // Should accumulate (mergeSchemas), not enforce (detectDrift)
      expect(mergeSchemas).toHaveBeenCalled();
      expect(detectDrift).not.toHaveBeenCalled();
    });

    it('enforces drift on 3rd consecutive success (post-increment)', async () => {
      setupSkillExecution(
        {
          outputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
          consecutiveValidations: 2, // Post-increment = 3, enforcement starts
        },
        { success: true, data: { id: 1 } },
      );
      await engine.executeSkill('example.com.get_data.v1', {});
      expect(detectDrift).toHaveBeenCalled();
    });

    it('passes enforcement schema (required-only) to detectDrift', async () => {
      (detectDrift as ReturnType<typeof vi.fn>).mockReturnValueOnce({ drifted: false, breaking: false, changes: [] });
      setupSkillExecution(
        {
          outputSchema: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
              name: { type: 'string' },
              optionalField: { type: 'string' },
            },
            required: ['id', 'name'], // optionalField is NOT required
          },
          consecutiveValidations: 5,
        },
        { success: true, data: { id: 1, name: 'test' } },
      );
      await engine.executeSkill('example.com.get_data.v1', {});
      // Verify detectDrift was called with enforcement schema (only required props)
      const enforcementSchema = (detectDrift as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(enforcementSchema.properties).toHaveProperty('id');
      expect(enforcementSchema.properties).toHaveProperty('name');
      expect(enforcementSchema.properties).not.toHaveProperty('optionalField');
      expect(enforcementSchema.required).toEqual(['id', 'name']);
    });

    it('sends skill_demoted notification with schema_drift reason on breaking drift', async () => {
      (detectDrift as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        drifted: true,
        breaking: true,
        changes: [{ path: '$.id', type: 'field_removed', breaking: true }],
      });
      setupSkillExecution(
        {
          outputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
          consecutiveValidations: 5,
        },
        { success: true, data: {} },
      );
      await engine.executeSkill('example.com.get_data.v1', {});
      expect(createEvent).toHaveBeenCalledWith('skill_demoted', 'example.com.get_data.v1', 'example.com',
        expect.objectContaining({ reason: 'schema_drift', changes: 1 }));
    });

    it('sends skill_degraded notification with successRate and trend', async () => {
      (monitorSkills as ReturnType<typeof vi.fn>).mockReturnValueOnce([
        { skillId: 'example.com.get_data.v1', status: 'degrading', successRate: 0.6, trend: -0.2, windowSize: 50 },
      ]);
      setupSkillExecution({}, { success: true, data: { id: 1 } });
      await engine.executeSkill('example.com.get_data.v1', {});
      expect(createEvent).toHaveBeenCalledWith('skill_degraded', 'example.com.get_data.v1', 'example.com',
        expect.objectContaining({ successRate: 0.6, trend: -0.2 }));
    });

    it('skips schema inference and drift detection on failed execution', async () => {
      setupSkillExecution(
        {
          outputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
          consecutiveValidations: 10,
        },
        { success: false, failureCause: 'unknown', data: null },
      );
      await engine.executeSkill('example.com.get_data.v1', {});
      expect(inferSchema).not.toHaveBeenCalled();
      expect(mergeSchemas).not.toHaveBeenCalled();
      expect(detectDrift).not.toHaveBeenCalled();
    });

    it('skips schema inference when result.data is null', async () => {
      setupSkillExecution(
        { outputSchema: undefined, consecutiveValidations: 0 },
        { success: true, data: null },
      );
      await engine.executeSkill('example.com.get_data.v1', {});
      expect(inferSchema).not.toHaveBeenCalled();
    });
  });

  // ─── Explore Navigation ────────────────────────────────────────

  describe('explore navigation', () => {
    it('calls navigateFireAndForget via getOrCreateContext on explore', async () => {
      await engine.explore('https://example.com');
      // navigateFireAndForget calls bm.withLease which calls getOrCreateContext
      // The first getOrCreateContext is from session.create, the second from navigateFireAndForget
      expect(mockBrowserManager.getOrCreateContext).toHaveBeenCalled();
      expect(mockBrowserManager.withLease).toHaveBeenCalled();
    });

    it('returns appliedOverrides when proxy is provided', async () => {
      const overrides = { proxy: { server: 'http://proxy.example.com:8080' } };
      const result = await engine.explore('https://example.com', overrides);
      expect(result.appliedOverrides).toBeDefined();
      expect(result.appliedOverrides!.proxy).toEqual({ server: 'http://proxy.example.com:8080' });
    });

    it('returns appliedOverrides with geo when provided', async () => {
      const overrides = { geo: { timezoneId: 'America/New_York', locale: 'en-US' } };
      const result = await engine.explore('https://example.com', overrides);
      expect(result.appliedOverrides).toBeDefined();
      expect(result.appliedOverrides!.geo).toEqual({ timezoneId: 'America/New_York', locale: 'en-US' });
    });

    it('returns undefined appliedOverrides when none provided', async () => {
      const result = await engine.explore('https://example.com');
      expect(result.appliedOverrides).toBeUndefined();
    });
  });

  // ─── Re-explore Reuse ──────────────────────────────────────────

  describe('re-explore same site', () => {
    it('reuses session for same siteId', async () => {
      // First explore creates session
      await engine.explore('https://example.com/page1');

      // Mock getSession to return the session for re-explore check
      mockSessionGetSession.mockReturnValueOnce({
        id: 'sess-1',
        siteId: 'example.com',
        url: 'https://example.com/page1',
        startedAt: Date.now(),
        browserContextId: 'ctx-1',
      });

      // Second explore to same site should reuse
      const result = await engine.explore('https://example.com/page2');
      expect(result.reused).toBe(true);
      expect(result.sessionId).toBe('sess-1');
      // sessionManager.create should only have been called once (first explore)
      expect(mockSessionCreate).toHaveBeenCalledTimes(1);
    });

    it('throws descriptive error on ContextOverrideMismatchError during re-explore', async () => {
      await engine.explore('https://example.com/page1');

      mockSessionGetSession.mockReturnValueOnce({
        id: 'sess-1',
        siteId: 'example.com',
        url: 'https://example.com/page1',
        startedAt: Date.now(),
        browserContextId: 'ctx-1',
      });

      // Mock getOrCreateContext to throw ContextOverrideMismatchError
      mockBrowserManager.getOrCreateContext.mockRejectedValueOnce(
        new ContextOverrideMismatchError('example.com'),
      );

      await expect(
        engine.explore('https://example.com/page2', { proxy: { server: 'http://new-proxy:8080' } }),
      ).rejects.toThrow(/already has an active session with different overrides/);
    });
  });

  // ─── Status with activeNamedSession ─────────────────────────────

  describe('status activeNamedSession', () => {
    it('includes activeNamedSession when overrides are set', async () => {
      const overrides = { proxy: { server: 'http://proxy:8080' } };
      await engine.explore('https://example.com', overrides);
      const status = engine.getStatus();
      expect(status.activeNamedSession).toBeDefined();
      expect(status.activeNamedSession!.name).toBe('default');
      expect(status.activeNamedSession!.overrides).toEqual(overrides);
    });

    it('includes activeNamedSession when non-default session is active', async () => {
      await engine.explore('https://example.com');
      const msm = engine.getMultiSessionManager();
      const sess = msm.getOrCreate('cdp-session');
      msm.setActive('cdp-session');
      const status = engine.getStatus();
      expect(status.activeNamedSession).toBeDefined();
      expect(status.activeNamedSession!.name).toBe('cdp-session');
      // Restore
      msm.setActive('default');
    });

    it('omits activeNamedSession for default session without overrides', async () => {
      await engine.explore('https://example.com');
      const status = engine.getStatus();
      expect(status.activeNamedSession).toBeUndefined();
    });
  });

  // ─── updateUrl ─────────────────────────────────────────────────

  describe('updateUrl via session manager', () => {
    it('updateUrl is called during navigate fire-and-forget', async () => {
      // navigateFireAndForget calls page.goto then sessionManager.updateUrl
      // We can verify via the withLease mock
      const mockPage = {
        goto: vi.fn().mockResolvedValue(undefined),
        url: vi.fn().mockReturnValue('https://example.com/navigated'),
      };
      const mockContext = {
        pages: () => [mockPage],
        newPage: vi.fn(),
      };
      mockBrowserManager.getOrCreateContext.mockResolvedValue(mockContext);
      mockBrowserManager.withLease.mockImplementation(async (fn: () => Promise<unknown>) => fn());

      await engine.explore('https://example.com');

      // Give the fire-and-forget a tick
      await new Promise(r => setTimeout(r, 10));

      expect(mockSessionUpdateUrl).toHaveBeenCalled();

      // Restore default mock
      mockBrowserManager.getOrCreateContext.mockResolvedValue({
        pages: () => [],
        newPage: vi.fn().mockResolvedValue({}),
      });
    });

    it('calls detectAndWaitForChallenge after page.goto in fire-and-forget', async () => {
      const mockPage = {
        goto: vi.fn().mockResolvedValue(undefined),
        url: vi.fn().mockReturnValue('https://example.com/navigated'),
      };
      const mockContext = {
        pages: () => [mockPage],
        newPage: vi.fn(),
      };
      mockBrowserManager.getOrCreateContext.mockResolvedValue(mockContext);
      mockBrowserManager.withLease.mockImplementation(async (fn: () => Promise<unknown>) => fn());
      mockDetectAndWaitForChallenge.mockClear();

      await engine.explore('https://example.com');

      // Give the fire-and-forget a tick
      await new Promise(r => setTimeout(r, 10));

      expect(mockDetectAndWaitForChallenge).toHaveBeenCalledWith(mockPage, 3000);

      // Restore default mock
      mockBrowserManager.getOrCreateContext.mockResolvedValue({
        pages: () => [],
        newPage: vi.fn().mockResolvedValue({}),
      });
    });
  });

  // ─── buildEnforcementSchema ──────────────────────────────────────

  describe('buildEnforcementSchema', () => {
    it('strips optional properties from object schema', () => {
      const schema = {
        type: 'object',
        properties: {
          a: { type: 'integer' },
          b: { type: 'string' },
          c: { type: 'boolean' },
        },
        required: ['a', 'b'],
      };
      const result = buildEnforcementSchema(schema);
      expect(result).toEqual({
        type: 'object',
        properties: {
          a: { type: 'integer' },
          b: { type: 'string' },
        },
        required: ['a', 'b'],
      });
    });

    it('handles array schema by filtering items', () => {
      const schema = {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
            optional: { type: 'string' },
          },
          required: ['id', 'name'],
        },
      };
      const result = buildEnforcementSchema(schema);
      expect(result).toEqual({
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
          },
          required: ['id', 'name'],
        },
      });
    });

    it('passes through primitive schema unchanged', () => {
      const schema = { type: 'string' };
      expect(buildEnforcementSchema(schema)).toEqual({ type: 'string' });
    });

    it('passes through object schema without properties', () => {
      const schema = { type: 'object' };
      expect(buildEnforcementSchema(schema)).toEqual({ type: 'object' });
    });

    it('returns empty properties when no fields are required', () => {
      const schema = {
        type: 'object',
        properties: {
          a: { type: 'string' },
          b: { type: 'integer' },
        },
        // no required field
      };
      const result = buildEnforcementSchema(schema);
      expect(result).toEqual({
        type: 'object',
        properties: {},
        required: [],
      });
    });
  });
});
