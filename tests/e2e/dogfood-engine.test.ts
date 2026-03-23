/**
 * Dogfood E2E: Engine API (non-MCP)
 *
 * Exercises every Engine method as a power user would, via direct API.
 * Uses mocked browser (no Playwright), real config validation, real state machine.
 *
 * Scenarios:
 *   1. Full lifecycle: idle → explore → record → stop → explore
 *   2. State machine exhaustive: every invalid transition
 *   3. Re-explore same site reuses session
 *   4. Re-explore with different overrides → mismatch error
 *   5. Force-close → re-explore
 *   6. Geo/proxy override propagation
 *   7. Recording with inputs + request count tracking
 *   8. Doctor diagnostics
 *   9. Multi-session lifecycle
 *  10. Close during recording
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

// ─── Mocks ──────────────────────────────────────────────────────

vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  }),
}));

vi.mock('../../src/core/config.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/core/config.js')>('../../src/core/config.js');
  return {
    ...actual,
    getConfig: () => ({
      dataDir: '/tmp/schrute-dogfood',
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
      daemon: { port: 19420, autoStart: false },
      tempTtlMs: 3600000,
      gcIntervalMs: 900000,
      confirmationTimeoutMs: 30000,
      confirmationExpiryMs: 60000,
      promotionConsecutivePasses: 5,
      promotionVolatilityThreshold: 0.2,
      maxToolsPerSite: 20,
      maxSkillsPerRecording: 15,
      toolShortlistK: 10,
    }),
    ensureDirectories: vi.fn(),
    getDbPath: () => ':memory:',
    getDataDir: () => '/tmp/schrute-dogfood',
    getBrowserDataDir: () => '/tmp/schrute-dogfood/browser-data',
    getTmpDir: () => '/tmp/schrute-dogfood/tmp',
    getAuditDir: () => '/tmp/schrute-dogfood/audit',
    getSkillsDir: () => '/tmp/schrute-dogfood/skills',
    getConfigPath: () => '/tmp/schrute-dogfood/config.json',
  };
});

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

vi.mock('../../src/storage/skill-repository.js', () => ({
  SkillRepository: vi.fn().mockImplementation(() => ({
    getById: vi.fn().mockReturnValue(undefined),
    create: vi.fn(),
    getBySiteId: vi.fn().mockReturnValue([]),
    getActive: vi.fn().mockReturnValue([]),
    getByStatus: vi.fn().mockReturnValue([]),
    getAll: vi.fn().mockReturnValue([]),
    update: vi.fn(),
    delete: vi.fn(),
    updateConfidence: vi.fn(),
    updateTier: vi.fn(),
  })),
}));

vi.mock('../../src/storage/site-repository.js', () => ({
  SiteRepository: vi.fn().mockImplementation(() => ({
    getById: vi.fn().mockReturnValue(undefined),
    create: vi.fn(),
    update: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
    delete: vi.fn(),
    updateMetrics: vi.fn(),
  })),
}));

vi.mock('../../src/storage/metrics-repository.js', () => ({
  MetricsRepository: vi.fn().mockImplementation(() => ({
    record: vi.fn(),
    getForSkill: vi.fn().mockReturnValue([]),
  })),
}));

vi.mock('../../src/replay/audit-log.js', () => ({
  AuditLog: vi.fn().mockImplementation(() => ({
    initHmacKey: vi.fn().mockResolvedValue(undefined),
    append: vi.fn(),
  })),
}));

vi.mock('../../src/replay/tool-budget.js', () => ({
  ToolBudgetTracker: vi.fn().mockImplementation(() => ({
    setDomainAllowlist: vi.fn(),
    checkBudget: vi.fn().mockReturnValue({ allowed: true }),
    recordCall: vi.fn(),
  })),
}));

vi.mock('../../src/automation/rate-limiter.js', () => ({
  RateLimiter: vi.fn().mockImplementation(() => ({
    checkRate: vi.fn().mockReturnValue({ allowed: true }),
    waitForPermit: vi.fn().mockResolvedValue({ allowed: true }),
    recordResponse: vi.fn(),
    setQps: vi.fn(),
    attachDatabase: vi.fn(),
    persistBackoffs: vi.fn(),
  })),
}));

// Mock the page with response event support
function createMockPage(url = 'https://example.com') {
  const listeners: Record<string, Function[]> = {};
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue(url),
    evaluate: vi.fn().mockResolvedValue('America/New_York'),
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn().mockImplementation((event: string, handler: Function) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    }),
    off: vi.fn().mockImplementation((event: string, handler: Function) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter(h => h !== handler);
      }
    }),
    emit: (event: string, ...args: unknown[]) => {
      (listeners[event] || []).forEach(h => h(...args));
    },
    _listeners: listeners,
  };
}

function createMockContext(page?: ReturnType<typeof createMockPage>) {
  const mockPage = page || createMockPage();
  const listeners: Record<string, Function[]> = {};
  return {
    pages: vi.fn().mockReturnValue([mockPage]),
    newPage: vi.fn().mockResolvedValue(mockPage),
    on: vi.fn().mockImplementation((event: string, handler: Function) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    }),
    off: vi.fn().mockImplementation((event: string, handler: Function) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter(h => h !== handler);
      }
    }),
    _page: mockPage,
    _listeners: listeners,
  };
}

const mockContext = createMockContext();

const mockBrowserManager = {
  launchBrowser: vi.fn().mockResolvedValue({}),
  getOrCreateContext: vi.fn().mockResolvedValue(mockContext),
  getSelectedOrFirstPage: vi.fn().mockImplementation(async (_siteId: string, context?: { pages?: () => unknown[]; newPage?: () => Promise<unknown> }) => {
    const pages = context?.pages?.() ?? [];
    if (pages.length > 0) return pages[0];
    return context?.newPage?.();
  }),
  hasContext: vi.fn().mockReturnValue(true),
  tryGetContext: vi.fn().mockReturnValue(mockContext),
  closeContext: vi.fn().mockResolvedValue(undefined),
  closeBrowser: vi.fn().mockResolvedValue(undefined),
  closeAll: vi.fn().mockResolvedValue(undefined),
  getHarPath: vi.fn().mockReturnValue(null),
  getCapabilities: vi.fn().mockReturnValue(null),
  getHandlerTimeoutMs: vi.fn().mockReturnValue(30000),
  supportsHarRecording: vi.fn().mockReturnValue(true),
  isCdpConnected: vi.fn().mockReturnValue(false),
  setSuppressIdleTimeout: vi.fn(),
  withLease: vi.fn().mockImplementation(async (fn: () => Promise<unknown>) => fn()),
  touchActivity: vi.fn(),
  releaseActivity: vi.fn(),
  isIdle: vi.fn().mockReturnValue(true),
  getBrowser: vi.fn().mockReturnValue(null),
  importCookies: vi.fn().mockResolvedValue(3),
  exportCookies: vi.fn().mockResolvedValue([]),
  setAuthIntegration: vi.fn(),
};

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
    stableStringify: vi.fn(),
    safeProxyUrl: vi.fn(),
  };
});

vi.mock('../../src/browser/playwright-mcp-adapter.js', () => ({
  PlaywrightMcpAdapter: vi.fn(),
}));

const mockSessionCreate = vi.fn().mockResolvedValue({
  session: {
    id: 'sess-1',
    siteId: 'example.com',
    url: 'https://example.com',
    startedAt: Date.now(),
  },
});
const mockSessionResume = vi.fn().mockResolvedValue({
  id: 'sess-1',
  siteId: 'example.com',
  url: 'https://example.com',
  createdAt: Date.now(),
});
const mockSessionClose = vi.fn().mockResolvedValue(undefined);
const mockSessionGetSession = vi.fn().mockReturnValue(undefined);
const mockSessionUpdateUrl = vi.fn();
const mockSessionRemove = vi.fn();

vi.mock('../../src/core/session.js', () => ({
  SessionManager: vi.fn().mockImplementation(() => ({
    create: mockSessionCreate,
    resume: mockSessionResume,
    close: mockSessionClose,
    listActive: vi.fn().mockReturnValue([]),
    getBrowserManager: () => mockBrowserManager,
    getHarPath: vi.fn().mockReturnValue(null),
    getSession: mockSessionGetSession,
    updateUrl: mockSessionUpdateUrl,
    remove: mockSessionRemove,
  })),
}));

vi.mock('../../src/browser/multi-session.js', () => ({
  DEFAULT_SESSION_NAME: 'default',
  MultiSessionManager: vi.fn().mockImplementation(() => ({
    getOrCreate: vi.fn().mockReturnValue({
      name: 'default',
      siteId: '',
      browserManager: mockBrowserManager,
      isCdp: false,
      createdAt: Date.now(),
    }),
    get: vi.fn().mockReturnValue({
      name: 'default',
      siteId: '',
      browserManager: mockBrowserManager,
      isCdp: false,
      createdAt: Date.now(),
    }),
    getActive: vi.fn().mockReturnValue('default'),
    close: vi.fn().mockResolvedValue(undefined),
    closeAll: vi.fn().mockResolvedValue(undefined),
    updateSiteId: vi.fn(),
    updateContextOverrides: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    connectCDP: vi.fn().mockRejectedValue(new Error('No CDP endpoint found')),
    setActive: vi.fn(),
    setOnSessionChanged: vi.fn(),
    setAuthIntegration: vi.fn(),
    sweepIdleSessions: vi.fn().mockReturnValue(0),
  })),
}));

// Mock capture/pipeline dependencies
vi.mock('../../src/capture/auth-detector.js', () => ({ detectAuth: vi.fn().mockReturnValue(null) }));
vi.mock('../../src/native/param-discoverer.js', () => ({ discoverParamsNative: vi.fn().mockReturnValue([]) }));
vi.mock('../../src/capture/chain-detector.js', () => ({ detectChains: vi.fn().mockReturnValue([]) }));
vi.mock('../../src/capture/har-extractor.js', () => ({
  parseHar: vi.fn().mockReturnValue({ log: { entries: [] } }),
  extractRequestResponse: vi.fn().mockReturnValue({}),
}));
vi.mock('../../src/native/noise-filter.js', () => ({
  filterRequestsNative: vi.fn().mockReturnValue({ signal: [], noise: [], ambiguous: [] }),
}));
vi.mock('../../src/capture/api-extractor.js', () => ({ clusterEndpoints: vi.fn().mockReturnValue([]) }));
vi.mock('../../src/skill/generator.js', () => ({
  generateSkill: vi.fn(),
  generateSkillReferences: vi.fn().mockReturnValue([]),
  generateSkillTemplates: vi.fn().mockReturnValue([]),
  generateActionName: vi.fn().mockImplementation((method: string, pathTemplate: string) => {
    const prefixes: Record<string, string> = { GET: 'get', POST: 'create', PUT: 'update', DELETE: 'delete', PATCH: 'update' };
    const verb = prefixes[method?.toUpperCase()] || method?.toLowerCase() || 'action';
    const segments = pathTemplate?.replace(/^\//, '').split('/').filter((s: string) => !s.startsWith('{') && !/^(api|v\d+)$/i.test(s)) || [];
    const noun = segments.pop() || 'resource';
    return `${verb}_${noun}`;
  }),
}));
vi.mock('../../src/replay/executor.js', () => ({ executeSkill: vi.fn() }));
vi.mock('../../src/replay/retry.js', () => ({ retryWithEscalation: vi.fn() }));
vi.mock('../../src/automation/cookie-refresh.js', () => ({ refreshCookies: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/automation/classifier.js', () => ({
  classifySite: vi.fn().mockReturnValue({ recommendedTier: 'direct', authRequired: false }),
}));
vi.mock('../../src/automation/strategy.js', () => ({
  updateStrategy: vi.fn(),
  getStrategy: vi.fn().mockReturnValue({ defaultTier: 'browser_proxied', overrides: {} }),
}));
vi.mock('../../src/discovery/cold-start.js', () => ({
  discoverSite: vi.fn().mockResolvedValue({ siteId: 'example.com', sources: [], endpoints: [] }),
}));
vi.mock('../../src/core/policy.js', () => ({
  checkCapability: vi.fn().mockReturnValue({ allowed: true }),
  enforceDomainAllowlist: vi.fn().mockReturnValue({ allowed: true }),
  checkMethodAllowed: vi.fn().mockReturnValue(true),
  checkPathRisk: vi.fn().mockReturnValue({ blocked: false }),
  getSitePolicy: vi.fn().mockReturnValue({ domainAllowlist: ['example.com'], capabilities: [] }),
  setSitePolicy: vi.fn(),
}));
vi.mock('../../src/core/promotion.js', () => ({
  canPromote: vi.fn().mockReturnValue({ eligible: false }),
  promoteSkill: vi.fn(),
}));
vi.mock('../../src/core/tiering.js', () => ({
  handleFailure: vi.fn().mockReturnValue({ newTier: 'tier_3', tierLock: null, reason: 'test' }),
}));
vi.mock('../../src/healing/diff-engine.js', () => ({
  detectDrift: vi.fn().mockReturnValue({ drifted: false, breaking: false, changes: [] }),
}));
vi.mock('../../src/healing/monitor.js', () => ({
  monitorSkills: vi.fn().mockReturnValue([]),
}));
vi.mock('../../src/healing/notification.js', () => ({
  notify: vi.fn().mockResolvedValue(undefined),
  createEvent: vi.fn().mockReturnValue({ type: 'test', skillId: 'test', siteId: 'test', details: {}, timestamp: Date.now() }),
}));
vi.mock('../../src/capture/graphql-extractor.js', () => ({
  clusterByOperation: vi.fn().mockReturnValue([]),
  canReplayPersistedQuery: vi.fn().mockReturnValue(true),
  extractGraphQLInfo: vi.fn().mockReturnValue({ operationName: null, operationType: null, variables: null, query: null, isPersistedQuery: false }),
  isGraphQL: vi.fn().mockReturnValue(false),
}));
vi.mock('../../src/capture/canonicalizer.js', () => ({
  canonicalizeRequest: vi.fn().mockImplementation((req: any) => ({
    method: req.method?.toUpperCase() ?? 'GET',
    canonicalUrl: req.url ?? '',
    canonicalBody: req.body,
  })),
}));
vi.mock('../../src/capture/noise-filter.js', () => ({ recordFilteredEntries: vi.fn() }));
vi.mock('../../src/capture/schema-inferrer.js', () => ({
  inferSchema: vi.fn().mockReturnValue({}),
  mergeSchemas: vi.fn().mockImplementation((a: any, b: any) => ({ ...a, ...b })),
}));
vi.mock('../../src/discovery/webmcp-scanner.js', () => ({ loadCachedTools: vi.fn().mockReturnValue([]) }));
vi.mock('../../src/browser/feature-flags.js', () => ({
  getFlags: vi.fn().mockReturnValue({
    snapshotMode: 'annotated',
    incrementalDiffs: true,
    modalTracking: true,
    screenshotResize: true,
    batchActions: true,
  }),
  VALID_SNAPSHOT_MODES: new Set(['annotated', 'full', 'none']),
}));

vi.mock('../../src/replay/trajectory.js', () => ({
  TrajectoryRecorder: vi.fn().mockImplementation(() => ({
    record: vi.fn(),
    save: vi.fn(),
    load: vi.fn().mockReturnValue(null),
    getTrajectory: vi.fn().mockReturnValue(null),
  })),
}));
vi.mock('../../src/storage/exemplar-repository.js', () => ({
  ExemplarRepository: vi.fn().mockImplementation(() => ({
    getById: vi.fn().mockReturnValue(undefined),
    create: vi.fn(),
    getBySiteId: vi.fn().mockReturnValue([]),
    getBySkillId: vi.fn().mockReturnValue([]),
    getAll: vi.fn().mockReturnValue([]),
  })),
}));
vi.mock('../../src/storage/amendment-repository.js', () => ({
  AmendmentRepository: vi.fn().mockImplementation(() => ({
    getById: vi.fn().mockReturnValue(undefined),
    create: vi.fn(),
    getBySkillId: vi.fn().mockReturnValue([]),
    getAll: vi.fn().mockReturnValue([]),
    update: vi.fn(),
    delete: vi.fn(),
  })),
}));
vi.mock('../../src/healing/amendment.js', () => ({
  AmendmentEngine: vi.fn().mockImplementation(() => ({
    apply: vi.fn(),
    suggest: vi.fn().mockReturnValue([]),
  })),
}));
vi.mock('../../src/browser/auth-store.js', () => ({
  BrowserAuthStore: vi.fn().mockImplementation(() => ({
    getCredentials: vi.fn().mockReturnValue(null),
    setCredentials: vi.fn(),
    deleteCredentials: vi.fn(),
  })),
}));
vi.mock('../../src/browser/auth-coordinator.js', () => ({
  AuthCoordinator: vi.fn().mockImplementation(() => ({
    coordinate: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock('../../src/browser/agent-browser-backend.js', () => ({
  AgentBrowserBackend: vi.fn().mockImplementation(() => ({
    setAuthCoordinator: vi.fn(),
    execute: vi.fn().mockResolvedValue({ success: true }),
  })),
}));
vi.mock('../../src/browser/playwright-backend.js', () => ({
  PlaywrightBackend: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({ success: true }),
  })),
}));
vi.mock('../../src/browser/live-chrome-backend.js', () => ({
  LiveChromeBackend: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({ success: true }),
  })),
}));
vi.mock('../../src/capture/path-trie.js', () => ({
  PathTrie: vi.fn().mockImplementation(() => ({
    insert: vi.fn(),
    lookup: vi.fn().mockReturnValue(null),
  })),
}));
vi.mock('../../src/browser/pool.js', () => ({
  BrowserPool: vi.fn().mockImplementation(() => ({
    acquire: vi.fn(),
    release: vi.fn(),
  })),
}));
vi.mock('../../src/replay/param-validator.js', () => ({
  validateParams: vi.fn().mockReturnValue({ valid: true, errors: [] }),
}));
vi.mock('../../src/skill/security-scanner.js', () => ({
  scanSkill: vi.fn().mockReturnValue({ issues: [] }),
}));
vi.mock('../../src/skill/dependency-graph.js', () => ({
  buildDependencyGraph: vi.fn().mockReturnValue(new Map()),
  getCascadeAffected: vi.fn().mockReturnValue([]),
}));
vi.mock('../../src/browser/base-browser-adapter.js', () => ({
  detectAndWaitForChallenge: vi.fn().mockResolvedValue(false),
  isCloudflareChallengePage: vi.fn().mockResolvedValue(false),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue(''),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

vi.mock('../../src/skill/types.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/skill/types.js')>('../../src/skill/types.js');
  return actual;
});

import { Engine } from '../../src/core/engine.js';
import { ContextOverrideMismatchError } from '../../src/browser/manager.js';

// ─── Test Config ─────────────────────────────────────────────────

const makeConfig = () => ({
  dataDir: '/tmp/schrute-dogfood',
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
  daemon: { port: 19420, autoStart: false },
  tempTtlMs: 3600000,
  gcIntervalMs: 900000,
  confirmationTimeoutMs: 30000,
  confirmationExpiryMs: 60000,
  promotionConsecutivePasses: 5,
  promotionVolatilityThreshold: 0.2,
  maxToolsPerSite: 20,
  maxSkillsPerRecording: 15,
  toolShortlistK: 10,
});

// ─── Tests ──────────────────────────────────────────────────────

describe('Dogfood E2E: Engine API (non-MCP)', () => {
  let engine: Engine;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionCreate.mockResolvedValue({
      session: {
        id: 'sess-1',
        siteId: 'example.com',
        url: 'https://example.com',
        startedAt: Date.now(),
      },
    });
    mockSessionResume.mockResolvedValue({
      id: 'sess-1',
      siteId: 'example.com',
      url: 'https://example.com',
      createdAt: Date.now(),
    });
    mockSessionGetSession.mockReturnValue(undefined);
    mockBrowserManager.getHarPath.mockReturnValue(null);
    mockBrowserManager.tryGetContext.mockReturnValue(mockContext);
    mockBrowserManager.hasContext.mockReturnValue(true);
    mockBrowserManager.getOrCreateContext.mockResolvedValue(mockContext);
  });

  afterEach(async () => {
    if (engine) await engine.close();
  });

  // ═══════════════════════════════════════════════════════════════
  // 1. Full Lifecycle: idle → explore → record → stop → explore
  // ═══════════════════════════════════════════════════════════════

  describe('Full lifecycle', () => {
    it('idle → explore → record → stop → back to exploring', async () => {
      engine = new Engine(makeConfig() as any);

      // 1. Starts idle
      expect(engine.getStatus().mode).toBe('idle');
      expect(engine.getActiveSessionId()).toBeNull();

      // 2. Explore
      const exploreResult = await engine.explore('https://example.com/app');
      expect(exploreResult.sessionId).toBe('sess-1');
      expect(exploreResult.siteId).toBe('example.com');
      expect(exploreResult.url).toBe('https://example.com/app');
      expect(engine.getStatus().mode).toBe('exploring');
      expect(engine.getActiveSessionId()).toBe('sess-1');

      // 3. Record
      const recording = await engine.startRecording('get-data', { page: '1' });
      expect(recording.name).toBe('get-data');
      expect(recording.siteId).toBe('example.com');
      expect(recording.inputs).toEqual({ page: '1' });
      expect(recording.requestCount).toBe(0);
      expect(engine.getStatus().mode).toBe('recording');

      // 4. Stop — HarPath is null → throws "Missing HAR path"
      mockBrowserManager.getHarPath.mockReturnValue('/tmp/test.har');
      (fs.existsSync as any).mockReturnValue(true);
      (fs.readFileSync as any).mockReturnValue(JSON.stringify({
        log: { version: '1.2', creator: { name: 'test' }, entries: [] },
      }));

      const stopped = await engine.stopRecording();
      expect(stopped.name).toBe('get-data');
      expect(engine.getStatus().mode).toBe('exploring');

      // 5. Status reflects exploring with session
      const status = engine.getStatus();
      expect(status.mode).toBe('exploring');
      expect(status.currentRecording).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 2. State Machine: Every Invalid Transition
  // ═══════════════════════════════════════════════════════════════

  describe('State machine — invalid transitions', () => {
    it('record from idle → rejected', async () => {
      engine = new Engine(makeConfig() as any);
      await expect(engine.startRecording('test')).rejects.toThrow(/Cannot start recording in 'idle' mode/);
    });

    it('stop from idle → rejected', async () => {
      engine = new Engine(makeConfig() as any);
      await expect(engine.stopRecording()).rejects.toThrow(/No active recording to stop/);
    });

    it('double record → rejected', async () => {
      engine = new Engine(makeConfig() as any);
      await engine.explore('https://example.com');
      await engine.startRecording('first');
      await expect(engine.startRecording('second')).rejects.toThrow(/Cannot start recording in 'recording' mode/);
    });

    it('stop without record → rejected', async () => {
      engine = new Engine(makeConfig() as any);
      await engine.explore('https://example.com');
      await expect(engine.stopRecording()).rejects.toThrow(/No active recording to stop/);
    });

    it('explore with invalid URL → rejected', async () => {
      engine = new Engine(makeConfig() as any);
      await expect(engine.explore('not-a-url')).rejects.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 3. Re-explore Same Site Reuses Session
  // ═══════════════════════════════════════════════════════════════

  describe('Re-explore same site', () => {
    it('reuses session when exploring same siteId', async () => {
      engine = new Engine(makeConfig() as any);
      await engine.explore('https://example.com/page1');

      // Set up getSession to return current session
      mockSessionGetSession.mockReturnValue({
        id: 'sess-1',
        siteId: 'example.com',
        url: 'https://example.com/page1',
        createdAt: Date.now(),
      });

      const result = await engine.explore('https://example.com/page2');
      expect(result.reused).toBe(true);
      expect(result.sessionId).toBe('sess-1');
      expect(result.url).toBe('https://example.com/page2');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 4. Override Mismatch Error
  // ═══════════════════════════════════════════════════════════════

  describe('Override mismatch', () => {
    it('throws when re-exploring same site with different overrides', async () => {
      engine = new Engine(makeConfig() as any);
      await engine.explore('https://example.com', {
        geo: { timezoneId: 'Europe/Paris' },
      });

      mockSessionGetSession.mockReturnValue({
        id: 'sess-1',
        siteId: 'example.com',
        url: 'https://example.com',
        createdAt: Date.now(),
      });

      mockBrowserManager.getOrCreateContext.mockRejectedValueOnce(
        new ContextOverrideMismatchError('example.com'),
      );

      await expect(
        engine.explore('https://example.com', {
          geo: { timezoneId: 'Asia/Tokyo' },
        }),
      ).rejects.toThrow(/different overrides/);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 5. Force-Close → Re-Explore
  // ═══════════════════════════════════════════════════════════════

  describe('Force-close and re-explore', () => {
    it('force-close resets to idle, re-explore works', async () => {
      engine = new Engine(makeConfig() as any);
      await engine.explore('https://example.com');
      expect(engine.getStatus().mode).toBe('exploring');

      // Force-close
      engine.resetExploreState('sess-1');
      expect(engine.getStatus().mode).toBe('idle');
      expect(engine.getActiveSessionId()).toBeNull();

      // Re-explore
      mockSessionCreate.mockResolvedValueOnce({
        session: {
          id: 'sess-2',
          siteId: 'example.com',
          url: 'https://example.com',
          startedAt: Date.now(),
        },
      });

      const result = await engine.explore('https://example.com');
      expect(result.sessionId).toBe('sess-2');
      expect(engine.getStatus().mode).toBe('exploring');
    });

    it('resetExploreState is idempotent with wrong session ID', async () => {
      engine = new Engine(makeConfig() as any);
      await engine.explore('https://example.com');

      // Reset with wrong ID does nothing
      engine.resetExploreState('wrong-session-id');
      expect(engine.getStatus().mode).toBe('exploring');
      expect(engine.getActiveSessionId()).toBe('sess-1');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 6. Geo/Proxy Override Propagation
  // ═══════════════════════════════════════════════════════════════

  describe('Geo/proxy overrides', () => {
    it('explore returns appliedOverrides with proxy (credentials stripped)', async () => {
      engine = new Engine(makeConfig() as any);

      const result = await engine.explore('https://example.com', {
        proxy: { server: 'socks5://myproxy:1080', username: 'user', password: 'pass' },
      });

      expect(result.appliedOverrides).toBeDefined();
      expect(result.appliedOverrides!.proxy!.server).toBe('socks5://myproxy:1080');
      // Credentials should NOT be in appliedOverrides
      expect((result.appliedOverrides!.proxy as any).username).toBeUndefined();
      expect((result.appliedOverrides!.proxy as any).password).toBeUndefined();
    });

    it('explore returns appliedOverrides with geo', async () => {
      engine = new Engine(makeConfig() as any);

      const result = await engine.explore('https://example.com', {
        geo: {
          timezoneId: 'Europe/Paris',
          locale: 'fr-FR',
          geolocation: { latitude: 48.8566, longitude: 2.3522 },
        },
      });

      expect(result.appliedOverrides).toBeDefined();
      expect(result.appliedOverrides!.geo!.timezoneId).toBe('Europe/Paris');
      expect(result.appliedOverrides!.geo!.locale).toBe('fr-FR');
      expect(result.appliedOverrides!.geo!.geolocation!.latitude).toBe(48.8566);
    });

    it('explore without overrides has no appliedOverrides', async () => {
      engine = new Engine(makeConfig() as any);

      const result = await engine.explore('https://example.com');
      expect(result.appliedOverrides).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 7. Recording Request Count
  // ═══════════════════════════════════════════════════════════════

  describe('Recording request count tracking', () => {
    it('request counter increments via context-level response events', async () => {
      engine = new Engine(makeConfig() as any);
      await engine.explore('https://example.com');

      const recording = await engine.startRecording('track-requests');
      expect(recording.requestCount).toBe(0);

      // Simulate responses at the BrowserContext level (not per-page)
      const contextListeners = mockContext._listeners['response'] || [];
      expect(contextListeners.length).toBe(1);

      contextListeners[0]();
      contextListeners[0]();
      contextListeners[0]();

      const status = engine.getStatus();
      expect(status.currentRecording!.requestCount).toBe(3);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 8. Engine Status / Doctor
  // ═══════════════════════════════════════════════════════════════

  describe('Engine status', () => {
    it('returns uptime, mode, and session info', async () => {
      engine = new Engine(makeConfig() as any);
      const status = engine.getStatus();

      expect(status.mode).toBe('idle');
      expect(status.uptime).toBeGreaterThanOrEqual(0);
      expect(status.activeSession).toBeNull();
      expect(status.currentRecording).toBeNull();
    });

    it('status reflects recording details', async () => {
      engine = new Engine(makeConfig() as any);
      await engine.explore('https://example.com');
      await engine.startRecording('my-recording', { key: 'val' });

      const status = engine.getStatus();
      expect(status.mode).toBe('recording');
      expect(status.currentRecording).toBeDefined();
      expect(status.currentRecording!.name).toBe('my-recording');
      expect(status.currentRecording!.inputs).toEqual({ key: 'val' });
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 9. Close During Various States
  // ═══════════════════════════════════════════════════════════════

  describe('Engine close', () => {
    it('close from idle is clean', async () => {
      engine = new Engine(makeConfig() as any);
      await engine.close();
      expect(engine.getStatus().mode).toBe('idle');
    });

    it('close from exploring resets state', async () => {
      engine = new Engine(makeConfig() as any);
      await engine.explore('https://example.com');
      expect(engine.getStatus().mode).toBe('exploring');

      await engine.close();
      expect(engine.getStatus().mode).toBe('idle');
    });

    it('close from recording resets state', async () => {
      engine = new Engine(makeConfig() as any);
      await engine.explore('https://example.com');
      await engine.startRecording('test');
      expect(engine.getStatus().mode).toBe('recording');

      await engine.close();
      expect(engine.getStatus().mode).toBe('idle');
      expect(engine.getStatus().currentRecording).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 10. Explore Different Sites Creates New Session
  // ═══════════════════════════════════════════════════════════════

  describe('Explore different sites', () => {
    it('exploring a different site after force-close creates new session', async () => {
      engine = new Engine(makeConfig() as any);

      // Explore site A
      await engine.explore('https://example.com');
      expect(engine.getStatus().mode).toBe('exploring');

      engine.resetExploreState('sess-1');
      expect(engine.getStatus().mode).toBe('idle');

      // Explore site B
      mockSessionCreate.mockResolvedValueOnce({
        session: {
          id: 'sess-3',
          siteId: 'other-site.com',
          url: 'https://other-site.com',
          startedAt: Date.now(),
        },
      });

      const result = await engine.explore('https://other-site.com');
      expect(result.siteId).toBe('other-site.com');
      expect(result.sessionId).toBe('sess-3');
    });
  });
});
