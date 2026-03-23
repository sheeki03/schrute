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
  getDataDir: () => '/tmp/schrute-engine-test',
  getBrowserDataDir: () => '/tmp/schrute-engine-test/browser-data',
  getTmpDir: () => '/tmp/schrute-engine-test/tmp',
  getAuditDir: () => '/tmp/schrute-engine-test/audit',
  getSkillsDir: () => '/tmp/schrute-engine-test/skills',
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
    getAll: vi.fn().mockReturnValue([]),
    getByStatus: vi.fn().mockReturnValue([]),
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
    waitForPermit: vi.fn().mockResolvedValue({ allowed: true }),
    recordResponse: vi.fn(),
    setQps: vi.fn(),
    attachDatabase: vi.fn(),
    persistBackoffs: vi.fn(),
  })),
}));

// Mock BrowserManager
const mockBrowserManager = createMockBrowserManager();

vi.mock('../../src/browser/manager.js', () => ({
  BrowserManager: vi.fn().mockImplementation(() => mockBrowserManager),
}));

// Mock PlaywrightMcpAdapter
vi.mock('../../src/browser/playwright-mcp-adapter.js', () => ({
  PlaywrightMcpAdapter: vi.fn(),
}));

// Mock session manager dependencies
const { mockSessionCreate, mockSessionResume, mockSessionClose, mockSessionListActive } = createMockSessionFns();

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
vi.mock('../../src/capture/chain-detector.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/capture/chain-detector.js')>('../../src/capture/chain-detector.js');
  return {
    ...actual,
    detectChains: vi.fn().mockReturnValue([]),
  };
});
vi.mock('../../src/capture/har-extractor.js', () => ({
  parseHar: vi.fn().mockReturnValue({ log: { entries: [] } }),
  extractRequestResponse: vi.fn().mockReturnValue({}),
}));
vi.mock('../../src/native/noise-filter.js', () => ({
  filterRequestsNative: vi.fn().mockReturnValue({ signal: [], noise: [], ambiguous: [] }),
}));
vi.mock('../../src/capture/api-extractor.js', () => ({
  clusterEndpoints: vi.fn().mockReturnValue([]),
  scoreAndRankClusters: vi.fn().mockImplementation((clusters: any[]) => clusters),
}));
vi.mock('../../src/skill/generator.js', () => ({
  generateSkill: vi.fn(),
  generateActionName: vi.fn((method: string, path: string) => {
    const segment = path.split('/').filter(Boolean).pop() || 'action';
    const prefix = method === 'GET' ? 'get' : method === 'POST' ? 'create' : method === 'PUT' ? 'update' : method === 'DELETE' ? 'delete' : 'call';
    return `${prefix}_${segment.replace(/[^a-z0-9]/gi, '_')}`;
  }),
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
  mergeSitePolicy: vi.fn().mockReturnValue({ merged: {}, prior: {}, persisted: false }),
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
  checkPromotion: vi.fn().mockReturnValue({ promote: false, reason: 'test' }),
  getEffectiveTier: vi.fn().mockImplementation((skill: any) => skill.currentTier),
  sanitizeSiteRecommendedTier: vi.fn().mockImplementation((recommendedTier: string, browserRequired: boolean) => {
    if (browserRequired) {
      return recommendedTier === 'full_browser' ? 'full_browser' : 'browser_proxied';
    }
    return recommendedTier === 'cookie_refresh' ? 'browser_proxied' : recommendedTier;
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

// Mock noise-filter exports used by the async pipeline path
vi.mock('../../src/capture/noise-filter.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/capture/noise-filter.js')>('../../src/capture/noise-filter.js');
  return {
    ...actual,
    filterRequests: vi.fn().mockReturnValue({ signal: [], noise: [], ambiguous: [] }),
    recordFilteredEntries: vi.fn(),
  };
});

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

// ─── Imports (after all vi.mock blocks) ───────────────────────────

import { Engine } from '../../src/core/engine.js';
import { existsSync } from 'node:fs';
import { parseHar, extractRequestResponse } from '../../src/capture/har-extractor.js';
import { clusterEndpoints } from '../../src/capture/api-extractor.js';
import { generateSkill, generateActionName } from '../../src/skill/generator.js';
import { SkillRepository } from '../../src/storage/skill-repository.js';
import { canonicalizeRequest } from '../../src/capture/canonicalizer.js';
import { isGraphQL, clusterByOperation, extractGraphQLInfo, canReplayPersistedQuery } from '../../src/capture/graphql-extractor.js';
import { canPromote, promoteSkill } from '../../src/core/promotion.js';
import { notify, createEvent } from '../../src/healing/notification.js';
import { filterRequests, recordFilteredEntries, isLearnableHost } from '../../src/capture/noise-filter.js';
import { discoverSite } from '../../src/discovery/cold-start.js';
import { loadCachedTools } from '../../src/discovery/webmcp-scanner.js';
import { getSitePolicy, mergeSitePolicy } from '../../src/core/policy.js';
// ─── Helpers ──────────────────────────────────────────────────────
// makeConfig is imported from tests/helpers/engine-mocks.ts

async function setupRecordingState(engine: Engine) {
  await engine.explore('https://example.com');
  await engine.startRecording('test-recording');
}

function getSkillRepoInstance() {
  return (SkillRepository as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value;
}

function configurePipelineMocks(overrides: {
  harEntries?: any[];
  signalEntries?: any[];
  clusters?: any[];
  existingSkills?: any[];
  gqlClusters?: any[];
} = {}) {
  const entries = overrides.harEntries ?? [
    { request: { method: 'GET', url: 'https://example.com/api/users' }, response: { status: 200 } },
  ];

  // fs.existsSync returns true for HAR path
  (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);

  // parseHar returns entries
  (parseHar as ReturnType<typeof vi.fn>).mockReturnValue({ log: { entries } });

  // extractRequestResponse converts entry to StructuredRecord
  (extractRequestResponse as ReturnType<typeof vi.fn>).mockImplementation((entry: any) => ({
    request: {
      method: entry.request?.method ?? 'GET',
      url: entry.request?.url ?? 'https://example.com/api/data',
      headers: {},
      queryParams: {},
      body: entry.request?.body,
    },
    response: {
      status: entry.response?.status ?? 200,
      statusText: 'OK',
      headers: {},
      body: '{}',
    },
    startedAt: Date.now(),
    duration: 100,
  }));

  // Worker-side filterRequests returns signal
  (filterRequests as ReturnType<typeof vi.fn>).mockReturnValue({
    signal: overrides.signalEntries ?? entries,
    noise: [],
    ambiguous: [],
  });

  // clusterEndpoints returns clusters
  (clusterEndpoints as ReturnType<typeof vi.fn>).mockReturnValue(overrides.clusters ?? []);

  // generateSkill returns skill-like objects
  let genCount = 0;
  (generateSkill as ReturnType<typeof vi.fn>).mockImplementation((siteId: string, opts: any) => ({
    id: `${siteId}.${opts.actionName ?? 'skill_' + genCount++}.v1`,
    siteId,
    name: opts.actionName ?? 'test_skill',
    method: opts.method ?? 'GET',
    pathTemplate: opts.pathTemplate ?? '/api/data',
    sideEffectClass: 'read-only',
    status: 'draft',
    version: 1,
    sampleCount: opts.sampleCount ?? 1,
    consecutiveValidations: 0,
    confidence: 0.5,
    allowedDomains: [siteId],
    currentTier: 'tier_1',
    tierLock: null,
  }));

  // BrowserManager.getHarPath returns a path
  mockBrowserManager.getHarPath.mockReturnValue('/tmp/test.har');

  // Configure existing skills on the repo instance
  const repoInstance = getSkillRepoInstance();
  if (overrides.existingSkills && repoInstance) {
    repoInstance.getBySiteId.mockReturnValue(overrides.existingSkills);
  }

  // GraphQL clusters
  if (overrides.gqlClusters) {
    (clusterByOperation as ReturnType<typeof vi.fn>).mockReturnValue(overrides.gqlClusters);
  }

  return { repoInstance };
}

async function stopRecordingAndWaitForPipeline(engine: Engine) {
  const stopped = await engine.stopRecording();
  const pipelineJobId = stopped.pipelineJobId;
  expect(pipelineJobId).toBeTruthy();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const job = engine.getPipelineJob(pipelineJobId!);
    if (job?.status === 'completed') {
      return { stopped, job };
    }
    if (job?.status === 'failed') {
      throw new Error(job.error ?? `Pipeline job ${pipelineJobId} failed`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  throw new Error(`Pipeline job ${pipelineJobId} did not complete`);
}

// ─── Test Suite ───────────────────────────────────────────────────

describe('Engine capture pipeline', () => {
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

  // ─── Noise filter persistence ─────────────────────────────────

  describe('capture pipeline: noise filter persistence', () => {
    it('falls back to HAR pipeline when the direct pipeline rejects asynchronously', async () => {
      const directCaptureResult = { records: [], auditEntries: [], totalCount: 1 };
      const recording = {
        id: 'rec-1',
        name: 'test-recording',
        siteId: 'example.com',
        startedAt: Date.now(),
        requestCount: 1,
      };
      const directSpy = vi.spyOn(engine as any, 'runCapturePipelineDirect')
        .mockRejectedValueOnce(new Error('direct failed'));
      const harSpy = vi.spyOn(engine as any, 'runCapturePipelineFromHar')
        .mockResolvedValueOnce({
          skillsGenerated: 1,
          signalCount: 1,
          noiseCount: 0,
          totalCount: 1,
        });

      const result = await (engine as any).runCapturePipeline(recording, directCaptureResult, '/tmp/test.har');

      expect(directSpy).toHaveBeenCalledWith(recording, directCaptureResult);
      expect(harSpy).toHaveBeenCalledWith(recording, '/tmp/test.har');
      expect(result).toEqual({
        skillsGenerated: 1,
        signalCount: 1,
        noiseCount: 0,
        totalCount: 1,
      });
    });

    it('creates action_frames row with correct columns', async () => {
      configurePipelineMocks();
      await setupRecordingState(engine);
      await stopRecordingAndWaitForPipeline(engine);
      expect(mockDb.run).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO action_frames'),
        expect.any(String),   // recording.id
        'example.com',        // site_id
        'test-recording',     // name
        expect.any(Number),   // started_at
        expect.any(Number),   // ended_at
        expect.any(Number),   // request_count
        expect.any(Number),   // signal_count
        0,                    // skill_count (initial)
      );
    });

    it('calls recordFilteredEntries with db and recording id', async () => {
      configurePipelineMocks();
      await setupRecordingState(engine);
      await stopRecordingAndWaitForPipeline(engine);
      expect(recordFilteredEntries).toHaveBeenCalledWith(
        expect.anything(),    // db
        expect.any(String),   // recording.id
        expect.any(Array),    // entries
        [],                   // overrides
        'example.com',        // siteHost
      );
    });

    it('updates action_frame skill_count after generation', async () => {
      configurePipelineMocks({
        clusters: [{
          method: 'GET',
          pathTemplate: '/api/users',
          requests: [{ request: { method: 'GET', url: 'https://example.com/api/users' } }],
          commonHeaders: {},
          commonQueryParams: [],
        }],
      });
      const repoInstance = getSkillRepoInstance();
      // Skill doesn't exist yet, so it will be created
      repoInstance.getById.mockReturnValue(undefined);

      await setupRecordingState(engine);
      await stopRecordingAndWaitForPipeline(engine);
      expect(mockDb.run).toHaveBeenCalledWith(
        'UPDATE action_frames SET skill_count = ? WHERE id = ?',
        expect.any(Number),   // generatedCount > 0
        expect.any(String),   // recording.id
      );
    });
  });

  // ─── Canonicalization and dedup ────────────────────────────────

  describe('capture pipeline: canonicalization and dedup', () => {
    it('deduplicates requests via canonicalizeRequest', async () => {
      const entries = [
        { request: { method: 'GET', url: 'https://example.com/api/users?a=1' }, response: { status: 200 } },
        { request: { method: 'GET', url: 'https://example.com/api/users?a=2' }, response: { status: 200 } },
      ];
      // Mock canonicalizer to return same canonical for both
      (canonicalizeRequest as ReturnType<typeof vi.fn>).mockReturnValue({
        method: 'GET',
        canonicalUrl: 'https://example.com/api/users',
        canonicalBody: undefined,
      });
      configurePipelineMocks({ harEntries: entries, signalEntries: entries });
      await setupRecordingState(engine);
      await stopRecordingAndWaitForPipeline(engine);
      // clusterEndpoints should receive deduplicated records (1, not 2)
      expect((clusterEndpoints as ReturnType<typeof vi.fn>).mock.calls[0][0]).toHaveLength(1);
    });

    it('splits REST and GraphQL records', async () => {
      const entries = [
        { request: { method: 'GET', url: 'https://example.com/api/users' }, response: { status: 200 } },
        { request: { method: 'POST', url: 'https://example.com/graphql', body: '{"query":"{ users { id } }"}' }, response: { status: 200 } },
      ];
      // Mock isGraphQL to return true for graphql URL
      (isGraphQL as ReturnType<typeof vi.fn>).mockImplementation((req: any) =>
        req.url?.includes('/graphql') ?? false
      );
      configurePipelineMocks({ harEntries: entries, signalEntries: entries });
      await setupRecordingState(engine);
      await stopRecordingAndWaitForPipeline(engine);
      // REST clusterEndpoints should only get REST records
      const restRecordsArg = (clusterEndpoints as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? [];
      // All records passed to clusterEndpoints should NOT have /graphql URL
      for (const r of restRecordsArg) {
        expect(r.request.url).not.toContain('/graphql');
      }
    });
  });

  // ─── sampleCount increment ────────────────────────────────────

  describe('capture pipeline: sampleCount increment', () => {
    it('increments sampleCount for pre-existing skills matching cluster', async () => {
      const existingSkill = {
        id: 'example_com.get_users.v1',
        siteId: 'example.com',
        name: 'get_users',
        method: 'GET',
        pathTemplate: '/api/users',
        allowedDomains: ['example.com'],
        version: 1,
        sampleCount: 5,
        status: 'draft',
        consecutiveValidations: 0,
        confidence: 0.5,
      };
      configurePipelineMocks({
        clusters: [{
          method: 'GET',
          pathTemplate: '/api/users',
          canonicalHost: 'example.com',
          requests: [{ request: { method: 'GET', url: 'https://example.com/api/users' } }],
          commonHeaders: {},
          commonQueryParams: [],
        }],
        existingSkills: [existingSkill],
      });
      const repoInstance = getSkillRepoInstance();
      // Skill already exists, so it won't be created
      repoInstance.getById.mockReturnValue(existingSkill);
      await setupRecordingState(engine);
      await stopRecordingAndWaitForPipeline(engine);
      // Should update sampleCount for the pre-existing skill
      expect(repoInstance.update).toHaveBeenCalledWith(
        existingSkill.id,
        expect.objectContaining({ sampleCount: 6 }), // 5 + 1 new request
      );
    });

    it('does NOT increment sampleCount for newly created skills', async () => {
      // No existing skills - all skills generated will be new
      configurePipelineMocks({
        clusters: [{
          method: 'GET',
          pathTemplate: '/api/items',
          requests: [{ request: { method: 'GET', url: 'https://example.com/api/items' } }],
          commonHeaders: {},
          commonQueryParams: [],
        }],
        existingSkills: [], // Empty - no pre-existing skills
      });
      const repoInstance = getSkillRepoInstance();
      repoInstance.getById.mockReturnValue(undefined); // Skill doesn't exist, will be created
      await setupRecordingState(engine);
      await stopRecordingAndWaitForPipeline(engine);
      // Should NOT have been called with sampleCount update (only create, no update)
      const updateCalls = repoInstance.update.mock.calls;
      const sampleCountUpdates = updateCalls.filter((call: any[]) =>
        call[1] && 'sampleCount' in call[1]
      );
      expect(sampleCountUpdates).toHaveLength(0);
    });
  });

  // ─── Promotion ────────────────────────────────────────────────

  describe('capture pipeline: promotion', () => {
    it('calls canPromote for all site skills after generation', async () => {
      const existingSkill = {
        id: 'example.com._api_data_.v1', siteId: 'example.com', name: '_api_data_',
        method: 'GET', status: 'draft', sampleCount: 5, consecutiveValidations: 10,
        sideEffectClass: 'read-only', version: 1, confidence: 0.9,
      };
      configurePipelineMocks({ existingSkills: [existingSkill] });
      (canPromote as ReturnType<typeof vi.fn>).mockReturnValue({ eligible: true });
      (promoteSkill as ReturnType<typeof vi.fn>).mockReturnValue({
        skillId: existingSkill.id,
        previousStatus: 'draft',
        newStatus: 'active',
        timestamp: Date.now(),
        skill: { ...existingSkill, status: 'active', confidence: 1.0, lastVerified: Date.now() },
      });
      await setupRecordingState(engine);
      await stopRecordingAndWaitForPipeline(engine);
      expect(canPromote).toHaveBeenCalled();
      expect(promoteSkill).toHaveBeenCalled();
    });

    it('applies partial update (status, confidence, lastVerified) on promotion', async () => {
      const existingSkill = {
        id: 'example.com._api_data_.v1', siteId: 'example.com', name: '_api_data_',
        method: 'GET', status: 'draft', sampleCount: 5, consecutiveValidations: 10,
        sideEffectClass: 'read-only', version: 1, confidence: 0.9,
      };
      configurePipelineMocks({ existingSkills: [existingSkill] });
      (canPromote as ReturnType<typeof vi.fn>).mockReturnValue({ eligible: true });
      const now = Date.now();
      (promoteSkill as ReturnType<typeof vi.fn>).mockReturnValue({
        skillId: existingSkill.id, previousStatus: 'draft', newStatus: 'active', timestamp: now,
        skill: { ...existingSkill, status: 'active', confidence: 1.0, lastVerified: now },
      });
      const repoInstance = getSkillRepoInstance();
      await setupRecordingState(engine);
      await stopRecordingAndWaitForPipeline(engine);
      expect(repoInstance.update).toHaveBeenCalledWith(
        existingSkill.id,
        expect.objectContaining({ status: 'active', confidence: 1.0 }),
      );
    });

    it('sends skill_promoted notification on promotion', async () => {
      const existingSkill = {
        id: 'example.com._api_data_.v1', siteId: 'example.com', name: '_api_data_',
        method: 'GET', status: 'draft', sampleCount: 5, consecutiveValidations: 10,
        sideEffectClass: 'read-only', version: 1, confidence: 0.9,
      };
      configurePipelineMocks({ existingSkills: [existingSkill] });
      (canPromote as ReturnType<typeof vi.fn>).mockReturnValue({ eligible: true });
      (promoteSkill as ReturnType<typeof vi.fn>).mockReturnValue({
        skillId: existingSkill.id, previousStatus: 'draft', newStatus: 'active',
        timestamp: Date.now(),
        skill: { ...existingSkill, status: 'active', confidence: 1.0, lastVerified: Date.now() },
      });
      await setupRecordingState(engine);
      await stopRecordingAndWaitForPipeline(engine);
      expect(createEvent).toHaveBeenCalledWith('skill_promoted', existingSkill.id, 'example.com',
        expect.objectContaining({ previousStatus: 'draft' }));
      expect(notify).toHaveBeenCalled();
    });
  });

  // ─── GraphQL clustering ───────────────────────────────────────

  describe('capture pipeline: GraphQL clustering', () => {
    it('generates GraphQL catalog skills from gql clusters', async () => {
      // Mock isGraphQL to identify GraphQL requests
      (isGraphQL as ReturnType<typeof vi.fn>).mockImplementation((req: any) =>
        req.url?.includes('/graphql') ?? false
      );

      const gqlEntry = { request: { method: 'POST', url: 'https://example.com/graphql' }, response: { status: 200 } };

      (clusterByOperation as ReturnType<typeof vi.fn>).mockReturnValue([{
        operationName: 'GetUsers',
        operationType: 'query',
        skillName: 'GetUsers',
        requests: [{
          request: { method: 'POST', url: 'https://example.com/graphql', headers: {}, queryParams: {} },
          response: { status: 200, statusText: 'OK', headers: {}, body: '{}' },
          startedAt: Date.now(), duration: 50,
        }],
        variableShape: { userId: 'string' },
        hasPersistedQueries: false,
      }]);

      configurePipelineMocks({
        harEntries: [
          { request: { method: 'GET', url: 'https://example.com/api/health' }, response: { status: 200 } },
          gqlEntry,
        ],
        signalEntries: [
          { request: { method: 'GET', url: 'https://example.com/api/health' }, response: { status: 200 } },
          gqlEntry,
        ],
      });

      const repoInstance = getSkillRepoInstance();
      repoInstance.getById.mockReturnValue(undefined); // Skills don't exist yet

      await setupRecordingState(engine);
      await stopRecordingAndWaitForPipeline(engine);

      // generateSkill should have been called with GraphQL-specific args
      const gqlCalls = (generateSkill as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: any[]) => call[1]?.isGraphQL === true
      );
      expect(gqlCalls.length).toBeGreaterThan(0);
      expect(gqlCalls[0][1].graphqlOperationName).toBe('GetUsers');
    });

    it('skips GraphQL cluster when ALL requests are unreplayable APQ', async () => {
      (isGraphQL as ReturnType<typeof vi.fn>).mockImplementation((req: any) =>
        req.url?.includes('/graphql') ?? false
      );
      (extractGraphQLInfo as ReturnType<typeof vi.fn>).mockReturnValue({
        operationName: 'GetUsers', operationType: 'query', variables: null,
        query: null, isPersistedQuery: true, persistedQueryHash: 'abc123',
      });
      (canReplayPersistedQuery as ReturnType<typeof vi.fn>).mockReturnValue(false); // ALL unreplayable

      (clusterByOperation as ReturnType<typeof vi.fn>).mockReturnValue([{
        operationName: 'GetUsers', operationType: 'query', skillName: 'GetUsers',
        requests: [{
          request: { method: 'POST', url: 'https://example.com/graphql', headers: {}, queryParams: {} },
          response: { status: 200, statusText: 'OK', headers: {}, body: '{}' },
          startedAt: Date.now(), duration: 50,
        }],
        variableShape: {},
        hasPersistedQueries: true,
      }]);

      const gqlEntry = { request: { method: 'POST', url: 'https://example.com/graphql' }, response: { status: 200 } };
      configurePipelineMocks({
        harEntries: [gqlEntry],
        signalEntries: [gqlEntry],
      });

      await setupRecordingState(engine);
      await stopRecordingAndWaitForPipeline(engine);

      // generateSkill should NOT have been called with isGraphQL
      const gqlCalls = (generateSkill as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: any[]) => call[1]?.isGraphQL === true
      );
      expect(gqlCalls).toHaveLength(0);
    });
  });

  // ─── WebMCP cold-start ────────────────────────────────────────

  describe('capture pipeline: WebMCP cold-start', () => {
    it('passes db to discoverSite in cold-start discovery', async () => {
      await engine.explore('https://example.com');
      await new Promise(r => setTimeout(r, 20));
      expect(discoverSite).toHaveBeenCalledWith(
        'https://example.com',
        expect.any(Object),  // config
        undefined,           // browserProvider (hasContext returns false)
        expect.anything(),   // db object
        undefined,           // origin
        expect.any(Function), // scrapeContextFactory
      );
    });

    it('calls loadCachedTools after cold-start discovery', async () => {
      await engine.explore('https://example.com');
      await new Promise(r => setTimeout(r, 20));
      expect(loadCachedTools).toHaveBeenCalledWith('example.com', expect.anything());
    });
  });

  // ─── Scheme guard ────────────────────────────────────────────────

  describe('capture pipeline: scheme guard', () => {
    it('skips clusters with scheme-like pathTemplate', async () => {
      configurePipelineMocks({
        clusters: [
          {
            method: 'GET',
            pathTemplate: 'https:/challenges.cloudflare.com/{uuid}',
            requests: [{ request: { method: 'GET', url: 'https://challenges.cloudflare.com/abc' } }],
            commonHeaders: {},
            commonQueryParams: [],
          },
          {
            method: 'GET',
            pathTemplate: '/api/v3/coins/{id}',
            requests: [{ request: { method: 'GET', url: 'https://api.coingecko.com/api/v3/coins/bitcoin' } }],
            commonHeaders: {},
            commonQueryParams: [],
          },
        ],
      });
      const repoInstance = getSkillRepoInstance();
      repoInstance.getById.mockReturnValue(undefined);

      await setupRecordingState(engine);
      await stopRecordingAndWaitForPipeline(engine);

      // generateSkill should only be called for the valid pathTemplate
      const genCalls = (generateSkill as ReturnType<typeof vi.fn>).mock.calls;
      const pathTemplates = genCalls.map((call: any[]) => call[1]?.pathTemplate);
      expect(pathTemplates).not.toContain('https:/challenges.cloudflare.com/{uuid}');
      expect(pathTemplates).toContain('/api/v3/coins/{id}');
    });
  });

  // ─── Host filtering ─────────────────────────────────────────────

  describe('capture pipeline: host filtering', () => {
    it('filters cross-origin REST records before clustering', async () => {
      // The pipeline worker returns records with mixed hosts
      // But engine.ts filters them via isLearnableHost before clustering
      const entries = [
        { request: { method: 'GET', url: 'https://api.coingecko.com/api/v3/coins' }, response: { status: 200 } },
        { request: { method: 'GET', url: 'https://challenges.cloudflare.com/turnstile' }, response: { status: 200 } },
      ];

      configurePipelineMocks({
        harEntries: entries,
        signalEntries: entries,
      });

      await setupRecordingState(engine);
      await stopRecordingAndWaitForPipeline(engine);

      // clusterEndpoints receives only the learnable records
      const clusterArgs = (clusterEndpoints as ReturnType<typeof vi.fn>).mock.calls;
      if (clusterArgs.length > 0) {
        const records = clusterArgs[0][0];
        for (const rec of records) {
          const host = new URL(rec.request.url).hostname;
          // All records passed to clustering should be same-root as the siteId
          expect(host).not.toContain('cloudflare');
        }
      }
    });
  });

  // ─── Challenge-dominated warning ────────────────────────────────

  describe('capture pipeline: challenge-dominated warning', () => {
    it('sets warning when all signal is third-party', async () => {
      // Pipeline returns records but all are cross-origin
      const thirdPartyEntries = [
        { request: { method: 'GET', url: 'https://challenges.cloudflare.com/check' }, response: { status: 200 } },
      ];

      configurePipelineMocks({
        harEntries: thirdPartyEntries,
        signalEntries: thirdPartyEntries,
      });

      await setupRecordingState(engine);
      const { job } = await stopRecordingAndWaitForPipeline(engine);

      expect(job.result?.warning).toContain('third-party infrastructure');
    });

    it('sets warning on early-return path when all requests become noise', async () => {
      // Simulate the real scenario: worker classifies everything as noise,
      // so signalRecords is empty and runPipelineCore takes the early return
      const thirdPartyEntries = [
        { request: { method: 'GET', url: 'https://challenges.cloudflare.com/check' }, response: { status: 200 } },
      ];

      configurePipelineMocks({
        harEntries: thirdPartyEntries,
        signalEntries: [], // empty — worker classified all as noise
      });

      // Override filterRequests mock to return all noise (matching real behavior)
      (filterRequests as ReturnType<typeof vi.fn>).mockReturnValue({
        signal: [],
        noise: thirdPartyEntries,
        ambiguous: [],
      });

      await setupRecordingState(engine);
      const { job } = await stopRecordingAndWaitForPipeline(engine);

      expect(job.result?.warning).toContain('third-party infrastructure');
    });

    it('does not set warning when learnable requests exist', async () => {
      const entries = [
        { request: { method: 'GET', url: 'https://example.com/api/data' }, response: { status: 200 } },
      ];

      configurePipelineMocks({
        harEntries: entries,
        signalEntries: entries,
        clusters: [{
          method: 'GET',
          pathTemplate: '/api/data',
          requests: [{ request: { method: 'GET', url: 'https://example.com/api/data' } }],
          commonHeaders: {},
          commonQueryParams: [],
        }],
      });
      const repoInstance = getSkillRepoInstance();
      repoInstance.getById.mockReturnValue(undefined);

      await setupRecordingState(engine);
      const { job } = await stopRecordingAndWaitForPipeline(engine);

      expect(job.result?.warning).toBeUndefined();
    });
  });

  // ─── GQL empty-cluster guard ────────────────────────────────────

  describe('capture pipeline: GQL empty-cluster guard', () => {
    it('does not crash on GraphQL cluster with zero replayable requests', async () => {
      (isGraphQL as ReturnType<typeof vi.fn>).mockImplementation((req: any) =>
        req.url?.includes('/graphql') ?? false
      );
      (extractGraphQLInfo as ReturnType<typeof vi.fn>).mockReturnValue({
        operationName: 'GetData', operationType: 'query', variables: null,
        query: null, isPersistedQuery: true, persistedQueryHash: 'abc',
      });
      (canReplayPersistedQuery as ReturnType<typeof vi.fn>).mockReturnValue(false);

      (clusterByOperation as ReturnType<typeof vi.fn>).mockReturnValue([{
        operationName: 'GetData', operationType: 'query', skillName: 'GetData',
        requests: [{
          request: { method: 'POST', url: 'https://example.com/graphql', headers: {}, queryParams: {} },
          response: { status: 200, statusText: 'OK', headers: {}, body: '{}' },
          startedAt: Date.now(), duration: 50,
        }],
        variableShape: {},
        hasPersistedQueries: true,
      }]);

      const gqlEntry = { request: { method: 'POST', url: 'https://example.com/graphql' }, response: { status: 200 } };
      configurePipelineMocks({
        harEntries: [gqlEntry],
        signalEntries: [gqlEntry],
      });

      await setupRecordingState(engine);
      // Should not throw — the empty-cluster guard prevents the crash
      await expect(stopRecordingAndWaitForPipeline(engine)).resolves.toBeDefined();
    });
  });

  // ─── canonicalHost pass-through ──────────────────────────────────

  describe('capture pipeline: canonicalHost pass-through', () => {
    it('passes canonicalHost from cluster to generateActionName', async () => {
      configurePipelineMocks({
        clusters: [{
          method: 'GET',
          pathTemplate: '/api/v3/coins/{id}',
          canonicalHost: 'api.coingecko.com',
          requests: [{ request: { method: 'GET', url: 'https://api.coingecko.com/api/v3/coins/bitcoin' } }],
          commonHeaders: {},
          commonQueryParams: [],
        }],
      });
      const repoInstance = getSkillRepoInstance();
      repoInstance.getById.mockReturnValue(undefined);

      await setupRecordingState(engine);
      await stopRecordingAndWaitForPipeline(engine);

      // generateActionName should have been called with canonicalHost and siteId
      expect(generateActionName).toHaveBeenCalledWith(
        'GET',
        '/api/v3/coins/{id}',
        'api.coingecko.com',
        'example.com',
      );
    });

    it('passes canonicalHost through to generateSkill cluster info', async () => {
      configurePipelineMocks({
        clusters: [{
          method: 'GET',
          pathTemplate: '/api/data',
          canonicalHost: 'api.example.com',
          requests: [{ request: { method: 'GET', url: 'https://api.example.com/api/data' } }],
          commonHeaders: {},
          commonQueryParams: [],
        }],
      });
      const repoInstance = getSkillRepoInstance();
      repoInstance.getById.mockReturnValue(undefined);

      await setupRecordingState(engine);
      await stopRecordingAndWaitForPipeline(engine);

      // generateSkill should receive canonicalHost in the cluster info
      const genCalls = (generateSkill as ReturnType<typeof vi.fn>).mock.calls;
      expect(genCalls.length).toBeGreaterThan(0);
      expect(genCalls[0][0]).toBe('example.com');
      expect(genCalls[0][1]).toEqual(expect.objectContaining({ canonicalHost: 'api.example.com' }));
    });
  });

  // ─── sampleParams extraction ─────────────────────────────────────

  describe('capture pipeline: sampleParams extraction', () => {
    it('extracts sampleParams from path template with params', async () => {
      configurePipelineMocks({
        clusters: [{
          method: 'GET',
          pathTemplate: '/coins/{id}',
          canonicalHost: 'example.com',
          requests: [{
            request: { method: 'GET', url: 'https://example.com/coins/bitcoin' },
            response: { status: 200 },
          }],
          commonHeaders: {},
          commonQueryParams: [],
        }],
      });
      const repoInstance = getSkillRepoInstance();
      repoInstance.getById.mockReturnValue(undefined);

      // Make generateSkill return a mutable skill object
      (generateSkill as ReturnType<typeof vi.fn>).mockImplementation((siteId: string, opts: any) => ({
        id: `${siteId}.${opts.actionName ?? 'test_skill'}.v1`,
        siteId,
        name: opts.actionName ?? 'test_skill',
        method: opts.method ?? 'GET',
        pathTemplate: opts.pathTemplate ?? '/coins/{id}',
        sideEffectClass: 'read-only',
        status: 'draft',
        version: 1,
        sampleCount: opts.sampleCount ?? 1,
        consecutiveValidations: 0,
        confidence: 0.5,
        allowedDomains: [siteId],
        currentTier: 'tier_1',
        tierLock: null,
      }));

      await setupRecordingState(engine);
      await stopRecordingAndWaitForPipeline(engine);

      // The skill created via repo should have sampleParams set
      const createCalls = repoInstance.create.mock.calls;
      const skillWithSample = createCalls.find((call: any[]) =>
        call[0]?.pathTemplate === '/coins/{id}' && call[0]?.sampleParams,
      );
      expect(skillWithSample).toBeDefined();
      expect(skillWithSample![0].sampleParams).toEqual({ id: 'bitcoin' });
    });

    it('does not set sampleParams when path has no template params', async () => {
      configurePipelineMocks({
        clusters: [{
          method: 'GET',
          pathTemplate: '/coins/markets',
          canonicalHost: 'example.com',
          requests: [{
            request: { method: 'GET', url: 'https://example.com/coins/markets' },
            response: { status: 200 },
          }],
          commonHeaders: {},
          commonQueryParams: [],
        }],
      });
      const repoInstance = getSkillRepoInstance();
      repoInstance.getById.mockReturnValue(undefined);

      (generateSkill as ReturnType<typeof vi.fn>).mockImplementation((siteId: string, opts: any) => ({
        id: `${siteId}.${opts.actionName ?? 'test_skill'}.v1`,
        siteId,
        name: opts.actionName ?? 'test_skill',
        method: opts.method ?? 'GET',
        pathTemplate: opts.pathTemplate ?? '/coins/markets',
        sideEffectClass: 'read-only',
        status: 'draft',
        version: 1,
        sampleCount: opts.sampleCount ?? 1,
        consecutiveValidations: 0,
        confidence: 0.5,
        allowedDomains: [siteId],
        currentTier: 'tier_1',
        tierLock: null,
      }));

      await setupRecordingState(engine);
      await stopRecordingAndWaitForPipeline(engine);

      // The created skill should NOT have sampleParams
      const createCalls = repoInstance.create.mock.calls;
      const skillCreated = createCalls.find((call: any[]) =>
        call[0]?.pathTemplate === '/coins/markets',
      );
      if (skillCreated) {
        expect(skillCreated[0].sampleParams).toBeUndefined();
      }
    });
  });

  // ─── Domain allowlist auto-population ────────────────────────────

  describe('capture pipeline: domain allowlist auto-population', () => {
    it('calls mergeSitePolicy with collected domains after skill generation', async () => {
      // Configure getSitePolicy to return only localhost entries (triggers auto-population)
      (getSitePolicy as ReturnType<typeof vi.fn>).mockReturnValue({
        domainAllowlist: ['127.0.0.1', 'localhost', '[::1]'],
        capabilities: [],
      });

      configurePipelineMocks({
        clusters: [{
          method: 'GET',
          pathTemplate: '/api/data',
          canonicalHost: 'api.example.com',
          requests: [{ request: { method: 'GET', url: 'https://api.example.com/api/data' } }],
          commonHeaders: {},
          commonQueryParams: [],
        }],
      });
      const repoInstance = getSkillRepoInstance();
      repoInstance.getById.mockReturnValue(undefined);

      // After generation, getBySiteId is called again to collect domains
      repoInstance.getBySiteId.mockReturnValue([{
        id: 'example.com.get_data.v1',
        siteId: 'example.com',
        allowedDomains: ['api.example.com', 'example.com'],
      }]);

      await setupRecordingState(engine);
      await stopRecordingAndWaitForPipeline(engine);

      // mergeSitePolicy should have been called with the collected domains
      expect(mergeSitePolicy).toHaveBeenCalledWith(
        'example.com',
        expect.objectContaining({
          domainAllowlist: expect.arrayContaining(['example.com', 'api.example.com']),
        }),
        expect.anything(),
      );
    });

    it('does not auto-populate when real domains already exist in policy', async () => {
      // getSitePolicy returns a real domain (not just localhost)
      (getSitePolicy as ReturnType<typeof vi.fn>).mockReturnValue({
        domainAllowlist: ['example.com'],
        capabilities: [],
      });

      configurePipelineMocks({
        clusters: [{
          method: 'GET',
          pathTemplate: '/api/data',
          canonicalHost: 'example.com',
          requests: [{ request: { method: 'GET', url: 'https://example.com/api/data' } }],
          commonHeaders: {},
          commonQueryParams: [],
        }],
      });
      const repoInstance = getSkillRepoInstance();
      repoInstance.getById.mockReturnValue(undefined);

      await setupRecordingState(engine);
      await stopRecordingAndWaitForPipeline(engine);

      // mergeSitePolicy should NOT be called for domain auto-population
      // (it may be called for other reasons like recovery, so check the specific call)
      const mergeCallsWithDomainAllowlist = (mergeSitePolicy as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: any[]) => call[0] === 'example.com' && call[1]?.domainAllowlist,
      );
      expect(mergeCallsWithDomainAllowlist).toHaveLength(0);
    });
  });
});
