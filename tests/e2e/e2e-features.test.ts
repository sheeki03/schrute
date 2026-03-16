/**
 * End-to-end feature tests (converted from scripts/e2e-features.mjs).
 *
 * Exercises:
 * 1. Geo emulation via explore
 * 2. Context override mismatch detection
 * 3. Force-close session during exploring
 * 4. Re-explore with new overrides after force-close
 * 5. CDP auto-discovery (mocked)
 * 6. Proxy validation (input rejection)
 * 7. Geo validation (bounds, timezone, locale)
 * 8. SDK library exports
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

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

vi.mock('../../src/core/config.js', () => ({
  getConfig: () => ({
    dataDir: '/tmp/schrute-e2e-features',
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
  maxSkillsPerRecording: 15,
  toolShortlistK: 10,
  }),
  loadConfig: vi.fn().mockReturnValue({
    dataDir: '/tmp/schrute-e2e-features',
    logLevel: 'silent',
    daemon: { port: 19420, autoStart: false },
  }),
  ensureDirectories: vi.fn(),
  getDbPath: () => ':memory:',
  getDataDir: () => '/tmp/schrute-e2e-features',
  getBrowserDataDir: () => '/tmp/schrute-e2e-features/browser-data',
  getTmpDir: () => '/tmp/schrute-e2e-features/tmp',
  getAuditDir: () => '/tmp/schrute-e2e-features/audit',
  getSkillsDir: () => '/tmp/schrute-e2e-features/skills',
  getConfigPath: () => '/tmp/schrute-e2e-features/config.json',
  setConfigValue: vi.fn(),
  resetConfigCache: vi.fn(),
}));

// Mock database
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
    getAll: vi.fn().mockReturnValue([]),
    getByStatus: vi.fn().mockReturnValue([]),
    update: vi.fn(),
    delete: vi.fn(),
    updateConfidence: vi.fn(),
    updateTier: vi.fn(),
  })),
}));

// Mock SiteRepository
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
    attachDatabase: vi.fn(),
    persistBackoffs: vi.fn(),
  })),
}));

// Mock BrowserManager
const mockBrowserManager = {
  launchBrowser: vi.fn().mockResolvedValue({}),
  getOrCreateContext: vi.fn().mockResolvedValue({
    pages: () => [],
    newPage: vi.fn().mockResolvedValue({
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue('https://httpbin.org/get'),
      evaluate: vi.fn().mockResolvedValue('Europe/Paris'),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  }),
  getSelectedOrFirstPage: vi.fn().mockImplementation(async (_siteId: string, context?: { pages?: () => unknown[]; newPage?: () => Promise<unknown> }) => {
    const pages = context?.pages?.() ?? [];
    if (pages.length > 0) return pages[0];
    return context?.newPage?.();
  }),
  hasContext: vi.fn().mockReturnValue(false),
  tryGetContext: vi.fn().mockReturnValue(undefined),
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
  setAuthIntegration: vi.fn(),
};

vi.mock('../../src/browser/manager.js', () => {
  class ContextOverrideMismatchError extends Error {
    constructor(siteId: string) {
      super(`Context for '${siteId}' already exists with different proxy/geo settings. Close the session first, then re-explore with new settings.`);
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

// Mock PlaywrightMcpAdapter
vi.mock('../../src/browser/playwright-mcp-adapter.js', () => ({
  PlaywrightMcpAdapter: vi.fn(),
}));

// Mock session manager
const mockSessionCreate = vi.fn().mockResolvedValue({
  session: {
    id: 'sess-e2e-1',
    siteId: 'httpbin.org',
    url: 'https://httpbin.org/get',
    createdAt: Date.now(),
  },
});
const mockSessionResume = vi.fn().mockResolvedValue({
  id: 'sess-e2e-1',
  siteId: 'httpbin.org',
  url: 'https://httpbin.org/get',
  createdAt: Date.now(),
});
const mockSessionClose = vi.fn().mockResolvedValue(undefined);
const mockSessionListActive = vi.fn().mockReturnValue([]);
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

// Mock multi-session manager
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
    setOnSessionChanged: vi.fn(),
    setAuthIntegration: vi.fn(),
    sweepIdleSessions: vi.fn().mockReturnValue(0),
    setActive: vi.fn(),
  })),
}));

// Mock remaining capture/pipeline dependencies
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
  discoverSite: vi.fn().mockResolvedValue({ siteId: 'httpbin.org', sources: [], endpoints: [] }),
}));
vi.mock('../../src/core/policy.js', () => ({
  checkCapability: vi.fn().mockReturnValue({ allowed: true }),
  enforceDomainAllowlist: vi.fn().mockReturnValue({ allowed: true }),
  checkMethodAllowed: vi.fn().mockReturnValue(true),
  checkPathRisk: vi.fn().mockReturnValue({ blocked: false }),
  getSitePolicy: vi.fn().mockReturnValue({ domainAllowlist: ['httpbin.org'], capabilities: [] }),
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
  monitorSkills: vi.fn().mockReturnValue([{ status: 'healthy', successRate: 1.0, trend: 0, windowSize: 0 }]),
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

// ─── Tests ──────────────────────────────────────────────────────

describe('e2e features', () => {
  let engine: InstanceType<typeof Engine>;

  const makeConfig = () => ({
    dataDir: '/tmp/schrute-e2e-features',
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
    maxSkillsPerRecording: 15,
    toolShortlistK: 10,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionCreate.mockResolvedValue({
      session: {
        id: 'sess-e2e-1',
        siteId: 'httpbin.org',
        url: 'https://httpbin.org/get',
        createdAt: Date.now(),
      },
    });
  });

  // ─── Feature 1: Geo Emulation ─────────────────────────────────

  describe('Feature 1: Geo Emulation via explore', () => {
    it('explore with geo overrides returns sessionId and correct siteId', async () => {
      engine = new Engine(makeConfig() as any);

      const result = await engine.explore('https://httpbin.org/get', {
        geo: {
          timezoneId: 'Europe/Paris',
          locale: 'fr-FR',
          geolocation: { latitude: 48.8566, longitude: 2.3522 },
        },
      });

      expect(result.sessionId).toBeTruthy();
      expect(result.siteId).toBe('httpbin.org');
      expect(engine.getStatus().mode).toBe('exploring');
    });
  });

  // ─── Feature 2: Context Override Mismatch ─────────────────────

  describe('Feature 2: Context Override Mismatch', () => {
    it('throws when re-exploring same site with different overrides', async () => {
      engine = new Engine(makeConfig() as any);

      // First explore succeeds
      await engine.explore('https://httpbin.org/get', {
        geo: { timezoneId: 'Europe/Paris', locale: 'fr-FR' },
      });

      // On second explore with different overrides, the mock session manager sees
      // same siteId → tries getOrCreateContext → should throw mismatch
      mockSessionGetSession.mockReturnValue({
        id: 'sess-e2e-1',
        siteId: 'httpbin.org',
        url: 'https://httpbin.org/get',
        createdAt: Date.now(),
      });

      // Make getOrCreateContext throw ContextOverrideMismatchError
      mockBrowserManager.getOrCreateContext.mockRejectedValueOnce(
        new ContextOverrideMismatchError('httpbin.org'),
      );

      await expect(
        engine.explore('https://httpbin.org/get', {
          geo: { timezoneId: 'Asia/Tokyo', locale: 'ja-JP' },
        }),
      ).rejects.toThrow(/different overrides/);
    });
  });

  // ─── Feature 3: Force-Close Session ───────────────────────────

  describe('Feature 3: Force-Close Session', () => {
    it('engine mode is idle after force-close and no active session', async () => {
      engine = new Engine(makeConfig() as any);

      await engine.explore('https://httpbin.org/get');
      expect(engine.getStatus().mode).toBe('exploring');
      expect(engine.getActiveSessionId()).toBeTruthy();

      const sessionId = engine.getActiveSessionId();
      // Simulate force-close: close multiSessionManager + resetExploreState
      engine.resetExploreState(sessionId);

      expect(engine.getStatus().mode).toBe('idle');
      expect(engine.getActiveSessionId()).toBeNull();
    });
  });

  // ─── Feature 4: Re-Explore After Force-Close ──────────────────

  describe('Feature 4: Re-Explore with New Overrides', () => {
    it('re-explore with different geo succeeds after force-close', async () => {
      engine = new Engine(makeConfig() as any);

      // First explore with Paris geo
      await engine.explore('https://httpbin.org/get', {
        geo: { timezoneId: 'Europe/Paris', locale: 'fr-FR' },
      });

      // Force-close
      const sessionId = engine.getActiveSessionId();
      engine.resetExploreState(sessionId);
      expect(engine.getStatus().mode).toBe('idle');

      // Re-explore with Tokyo geo
      mockSessionCreate.mockResolvedValueOnce({
        session: {
          id: 'sess-e2e-2',
          siteId: 'httpbin.org',
          url: 'https://httpbin.org/get',
          createdAt: Date.now(),
        },
      });

      const result2 = await engine.explore('https://httpbin.org/get', {
        geo: { timezoneId: 'Asia/Tokyo', locale: 'ja-JP' },
      });

      expect(result2.sessionId).toBeTruthy();
      expect(engine.getStatus().mode).toBe('exploring');
    });
  });

  // ─── Feature 5: CDP Auto-Discovery ────────────────────────────

  describe('Feature 5: CDP Auto-Discovery (mocked)', () => {
    it('discoverCdpPort returns null when no CDP servers running', async () => {
      // Import the real module — it calls fetch() which will fail for local ports
      const { discoverCdpPort } = await import('../../src/browser/cdp-connector.js');

      const found = await discoverCdpPort({ probeTimeoutMs: 200 });
      expect(found).toBeNull();
    });

    it('connectViaCDP with autoDiscover throws descriptive error', async () => {
      const { connectViaCDP } = await import('../../src/browser/cdp-connector.js');

      await expect(
        connectViaCDP({ autoDiscover: true }),
      ).rejects.toThrow(/No Chrome debugging endpoint found/);
    });
  });

  // ─── Feature 6: Proxy Validation ──────────────────────────────

  describe('Feature 6: Proxy Validation', () => {
    // Use the real setConfigValue from config module for validation tests
    let realConfigModule: typeof import('../../src/core/config.js');

    beforeAll(async () => {
      // Import the actual config module to test its validation logic
      realConfigModule = await vi.importActual<typeof import('../../src/core/config.js')>('../../src/core/config.js');
    });

    it('accepts valid HTTP proxy', () => {
      expect(() => realConfigModule.setConfigValueInMemory('browser.proxy.server', 'http://proxy.example.com:8080')).not.toThrow();
    });

    it('accepts valid SOCKS5 proxy', () => {
      expect(() => realConfigModule.setConfigValueInMemory('browser.proxy.server', 'socks5://proxy.example.com:1080')).not.toThrow();
    });

    it('rejects invalid proxy (not a URL)', () => {
      expect(() => realConfigModule.setConfigValueInMemory('browser.proxy.server', 'not-a-url')).toThrow();
    });

    it('rejects proxy with path/query', () => {
      expect(() => realConfigModule.setConfigValueInMemory('browser.proxy.server', 'http://proxy.example.com/path?token=secret')).toThrow();
    });
  });

  // ─── Feature 7: Geo Validation ────────────────────────────────

  describe('Feature 7: Geo Validation', () => {
    let realConfigModule: typeof import('../../src/core/config.js');

    beforeAll(async () => {
      realConfigModule = await vi.importActual<typeof import('../../src/core/config.js')>('../../src/core/config.js');
    });

    it('accepts valid timezone', () => {
      expect(() => realConfigModule.setConfigValueInMemory('browser.geo.timezoneId', 'Europe/Paris')).not.toThrow();
    });

    it('rejects invalid timezone', () => {
      expect(() => realConfigModule.setConfigValueInMemory('browser.geo.timezoneId', 'Mars/Olympus')).toThrow();
    });

    it('accepts valid locale', () => {
      expect(() => realConfigModule.setConfigValueInMemory('browser.geo.locale', 'fr-FR')).not.toThrow();
    });

    it('rejects latitude > 90', () => {
      expect(() => realConfigModule.setConfigValueInMemory('browser.geo.geolocation.latitude', 91)).toThrow();
    });

    it('rejects longitude < -180', () => {
      expect(() => realConfigModule.setConfigValueInMemory('browser.geo.geolocation.longitude', -181)).toThrow();
    });
  });

  // ─── Feature 8: SDK Library Exports ───────────────────────────

  describe('Feature 8: SDK Library Exports', () => {
    it('exports Engine as a function', async () => {
      const lib = await import('../../src/lib.js');
      expect(typeof lib.Engine).toBe('function');
    });

    it('exports BrowserManager as a function', async () => {
      const lib = await import('../../src/lib.js');
      expect(typeof lib.BrowserManager).toBe('function');
    });

    it('exports MultiSessionManager as a function', async () => {
      const lib = await import('../../src/lib.js');
      expect(typeof lib.MultiSessionManager).toBe('function');
    });

    it('exports SkillRepository as a function', async () => {
      const lib = await import('../../src/lib.js');
      expect(typeof lib.SkillRepository).toBe('function');
    });

    it('exports getConfig as a function', async () => {
      const lib = await import('../../src/lib.js');
      expect(typeof lib.getConfig).toBe('function');
    });

    it('exports loadConfig as a function', async () => {
      const lib = await import('../../src/lib.js');
      expect(typeof lib.loadConfig).toBe('function');
    });

    it('exports startMcpServer as a function', async () => {
      const lib = await import('../../src/lib.js');
      expect(typeof lib.startMcpServer).toBe('function');
    });

    it('exports VERSION as a string', async () => {
      const lib = await import('../../src/lib.js');
      expect(typeof lib.VERSION).toBe('string');
    });
  });
});
