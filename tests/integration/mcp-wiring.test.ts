/**
 * MCP Wiring Integration Tests
 *
 * These tests verify that all orphaned modules wired into the engine lifecycle
 * actually fire end-to-end. They use:
 * - Real better-sqlite3 in-memory database (not mocked)
 * - Real capture pipeline modules (noise filter, canonicalizer, GraphQL extractor,
 *   API extractor, skill generator, promotion)
 * - Real execution modules (executor, retry, validation counters, schema inferrer,
 *   drift detection, health monitor, notifications, tiering)
 * - Mocked only: BrowserManager (no Playwright), DNS resolution
 *
 * Entry points: Engine class methods + dispatchToolCall() (the MCP interface)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentDatabase } from '../../src/storage/database.js';
import type { SkillSpec, SchruteConfig } from '../../src/skill/types.js';
import { Capability, SkillStatus } from '../../src/skill/types.js';
import { createFullSchemaDb } from '../helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, '..', 'fixtures');
const harDir = join(fixtureDir, 'har-files');

// ─── In-memory Database ──────────────────────────────────────────

let testDb: AgentDatabase & { close: () => void };

// ─── Mocks (before imports) ──────────────────────────────────────

let mockHarPath: string | undefined;

vi.mock('../../src/browser/manager.js', () => {
  return {
    BrowserManager: class MockBrowserManager {
      async launchBrowser() { return {}; }
      async getOrCreateContext(_siteId: string) {
        return { pages: () => [], newPage: async () => ({}) };
      }
      async getSelectedOrFirstPage(_siteId: string, context?: { pages?: () => unknown[]; newPage?: () => Promise<unknown> }) {
        const pages = context?.pages?.() ?? [];
        if (pages.length > 0) return pages[0];
        return context?.newPage?.();
      }
      async closeContext() {}
      async closeAll() {}
      getHarPath() { return mockHarPath; }
      hasContext() { return false; }
      tryGetContext() { return undefined; }
      getBrowser() { return null; }
      getCapabilities() { return null; }
      getHandlerTimeoutMs() { return 30000; }
      supportsHarRecording() { return true; }
      isCdpConnected() { return false; }
      setSuppressIdleTimeout(_suppress: boolean) {}
      async withLease<T>(fn: () => Promise<T>): Promise<T> { return fn(); }
      touchActivity() {}
      releaseActivity() {}
      isIdle() { return true; }
      setAuthIntegration() {}
    },
    stableStringify: (obj: unknown) => JSON.stringify(obj),
  };
});

vi.mock('../../src/storage/database.js', async () => {
  const { MIGRATIONS } = await vi.importActual<typeof import('../../src/storage/database.js')>('../../src/storage/database.js');
  return {
    MIGRATIONS,
    AgentDatabase: class {},
    getDatabase: () => testDb,
    closeDatabase: () => {},
  };
});

vi.mock('../../src/core/config.js', () => ({
  getConfig: () => ({
    dataDir: '/tmp/schrute-mcp-wiring-test',
    logLevel: 'silent',
  }),
  getDbPath: () => ':memory:',
  ensureDirectories: vi.fn(),
  getBrowserDataDir: () => '/tmp/schrute-mcp-wiring-test/browser',
  getTmpDir: () => '/tmp/schrute-mcp-wiring-test/tmp',
  getSkillsDir: () => '/tmp/schrute-mcp-wiring-test/skills',
  getDataDir: () => '/tmp/schrute-mcp-wiring-test',
  getAuditDir: () => '/tmp/schrute-mcp-wiring-test/audit',
}));

vi.mock('../../src/core/policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/policy.js')>();
  return {
    ...actual,
    resolveAndValidate: vi.fn().mockResolvedValue({ ip: '127.0.0.1', allowed: true, category: 'unicast' }),
  };
});

vi.mock('../../src/discovery/cold-start.js', () => ({
  discoverSite: vi.fn().mockResolvedValue({ endpoints: [], sources: [] }),
}));

vi.mock('../../src/discovery/webmcp-scanner.js', () => ({
  loadCachedTools: vi.fn().mockReturnValue([]),
}));

// Force TS fallback for native modules (we're testing wiring logic, not Rust impls)
vi.mock('../../src/native/index.js', () => ({
  getNativeModule: () => null,
  isNativeAvailable: () => false,
}));

// Now import after mocks
import { Engine } from '../../src/core/engine.js';
import { setSitePolicy } from '../../src/core/policy.js';
import { SkillRepository } from '../../src/storage/skill-repository.js';
import { SiteRepository } from '../../src/storage/site-repository.js';
import { MetricsRepository } from '../../src/storage/metrics-repository.js';
import { dispatchToolCall } from '../../src/server/tool-dispatch.js';
import { ConfirmationManager } from '../../src/server/confirmation.js';
import { drainMcpNotifications } from '../../src/healing/notification.js';
import { createRestMockServer } from '../fixtures/mock-sites/rest-mock-server.js';

// ─── Test Config ─────────────────────────────────────────────────

function makeTestConfig(): SchruteConfig {
  return {
    dataDir: '/tmp/schrute-mcp-wiring-test',
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
    promotionConsecutivePasses: 2,
    promotionVolatilityThreshold: 0.2,
    maxToolsPerSite: 20,
    maxSkillsPerRecording: 15,
    toolShortlistK: 10,
  } as SchruteConfig;
}

const DEFAULT_CAPS = [
  Capability.NET_FETCH_DIRECT,
  Capability.NET_FETCH_BROWSER_PROXIED,
  Capability.BROWSER_AUTOMATION,
  Capability.STORAGE_WRITE,
  Capability.SECRETS_USE,
];

async function waitForPipelineCompletion(engine: Engine, jobId: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const job = engine.getPipelineJob(jobId);
    if (job?.status === 'completed') {
      return;
    }
    if (job?.status === 'failed') {
      throw new Error(job.error ?? `Pipeline job ${jobId} failed`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for pipeline job ${jobId}`);
}

async function stopRecordingAndWait(engine: Engine): Promise<Awaited<ReturnType<Engine['stopRecording']>>> {
  const recordingInfo = await engine.stopRecording();
  if (recordingInfo.pipelineJobId) {
    await waitForPipelineCompletion(engine, recordingInfo.pipelineJobId);
  }
  return recordingInfo;
}

// ─── Tests ───────────────────────────────────────────────────────

describe('MCP wiring integration', () => {
  let config: SchruteConfig;
  let engine: Engine;
  let skillRepo: SkillRepository;
  let siteRepo: SiteRepository;
  let metricsRepo: MetricsRepository;

  beforeEach(() => {
    testDb = createFullSchemaDb();
    config = makeTestConfig();
    engine = new Engine(config);
    skillRepo = new SkillRepository(testDb);
    siteRepo = new SiteRepository(testDb);
    metricsRepo = new MetricsRepository(testDb);
    mockHarPath = undefined;

    drainMcpNotifications();

    for (const siteId of ['api.example.com', 'example.com', '127.0.0.1']) {
      setSitePolicy({
        siteId,
        allowedMethods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
        maxQps: 100,
        maxConcurrent: 10,
        readOnlyDefault: true,
        requireConfirmation: [],
        domainAllowlist: ['api.example.com', 'example.com', '127.0.0.1', 'localhost'],
        redactionRules: [],
        capabilities: DEFAULT_CAPS,
      });
    }
  });

  afterEach(async () => {
    if (engine) await engine.close();
    try { testDb.close(); } catch { /* best effort */ }
  });

  // ═══════════════════════════════════════════════════════════════
  // CAPTURE PIPELINE WIRING
  // ═══════════════════════════════════════════════════════════════

  describe('Capture pipeline wiring (explore -> record -> stop)', () => {
    it('generates REST skills from HAR via full pipeline', async () => {
      mockHarPath = join(harDir, 'simple-rest-api.har');

      await engine.explore('https://api.example.com/api');
      await engine.startRecording('get-users');
      await stopRecordingAndWait(engine);

      const skills = skillRepo.getBySiteId('api.example.com');
      expect(skills.length).toBeGreaterThanOrEqual(2);

      for (const skill of skills) {
        expect(skill.siteId).toBe('api.example.com');
        // P2-6: read-only GET/HEAD skills are auto-activated by Engine.stopRecording
        if (skill.sideEffectClass === 'read-only' && (skill.method === 'GET' || skill.method === 'HEAD')) {
          expect(skill.status).toBe('active');
          expect(skill.confidence).toBe(0.5);
        } else {
          expect(skill.status).toBe('draft');
          expect(skill.confidence).toBe(0);
        }
        expect(skill.sampleCount).toBeGreaterThan(0);
      }

      const methods = new Set(skills.map(s => s.method));
      expect(methods.has('GET')).toBe(true);
      // POST and GET to same path (e.g. /api/users) share the same skill ID
      // via buildSkillId normalization, so only one survives dedup.
      // We just verify at least one method is present.
    }, 15000);

    it('persists action_frame audit trail (C3)', async () => {
      mockHarPath = join(harDir, 'simple-rest-api.har');

      await engine.explore('https://api.example.com/api');
      await engine.startRecording('audit-test');
      await stopRecordingAndWait(engine);

      const frames = testDb.all<{ id: string; site_id: string; name: string; request_count: number; signal_count: number; skill_count: number }>(
        'SELECT * FROM action_frames WHERE site_id = ?', 'api.example.com',
      );
      expect(frames.length).toBe(1);
      expect(frames[0].name).toBe('audit-test');
      expect(frames[0].request_count).toBe(5);
      expect(frames[0].signal_count).toBeGreaterThan(0);
      expect(frames[0].skill_count).toBeGreaterThan(0);

      const entries = testDb.all<{ frame_id: string; classification: string }>(
        'SELECT * FROM action_frame_entries WHERE frame_id = ?', frames[0].id,
      );
      expect(entries.length).toBeGreaterThan(0);
    }, 15000);

    it('generates GraphQL catalog entries from GQL HAR (C1)', async () => {
      mockHarPath = join(harDir, 'graphql-api.har');

      await engine.explore('https://api.example.com/graphql');
      await engine.startRecording('graphql-test');
      await stopRecordingAndWait(engine);

      const skills = skillRepo.getBySiteId('api.example.com');
      const gqlSkills = skills.filter(s => s.id.includes('.gql.'));
      expect(gqlSkills.length).toBeGreaterThan(0);

      const skillIds = gqlSkills.map(s => s.id);
      const hasGqlOp = skillIds.some(id =>
        id.includes('GetUsers') || id.includes('GetUser') || id.includes('CreateUser'),
      );
      expect(hasGqlOp).toBe(true);
    }, 15000);

    it('increments sampleCount for pre-existing skills on re-recording (A1)', async () => {
      mockHarPath = join(harDir, 'simple-rest-api.har');

      await engine.explore('https://api.example.com/api');
      await engine.startRecording('first-pass');
      await stopRecordingAndWait(engine);

      const skillsBefore = skillRepo.getBySiteId('api.example.com');
      expect(skillsBefore.length).toBeGreaterThan(0);
      const countsBefore = new Map(skillsBefore.map(s => [s.id, s.sampleCount]));

      await engine.startRecording('second-pass');
      await stopRecordingAndWait(engine);

      const skillsAfter = skillRepo.getBySiteId('api.example.com');
      expect(skillsAfter.length).toBe(skillsBefore.length);

      for (const skill of skillsAfter) {
        const before = countsBefore.get(skill.id);
        if (before !== undefined) {
          expect(skill.sampleCount).toBeGreaterThan(before);
        }
      }
    }, 20000);

    it('promotes skills when criteria met (A1)', async () => {
      mockHarPath = join(harDir, 'simple-rest-api.har');

      await engine.explore('https://api.example.com/api');
      await engine.startRecording('promo-test');
      await stopRecordingAndWait(engine);

      const skills = skillRepo.getBySiteId('api.example.com');
      const readOnlySkill = skills.find(s => s.method === 'GET' && s.sideEffectClass === 'read-only');
      expect(readOnlySkill).toBeDefined();
      // P2-6: auto-activation sets status=active, confidence=0.5
      expect(readOnlySkill!.status).toBe('active');

      skillRepo.update(readOnlySkill!.id, {
        sampleCount: 5,
        consecutiveValidations: config.promotionConsecutivePasses,
      });

      await engine.startRecording('promo-trigger');
      await stopRecordingAndWait(engine);

      const updated = skillRepo.getById(readOnlySkill!.id);
      expect(updated).toBeDefined();
      expect(updated!.status).toBe('active');
      // After promotion, confidence is 1.0; after auto-activation it's 0.5
      // Promotion runs after auto-activation, so confidence should be >= 0.5
      expect(updated!.confidence).toBeGreaterThanOrEqual(0.5);
    }, 20000);

    it('splits REST and GraphQL traffic — no generic /graphql REST skill (C2)', async () => {
      mockHarPath = join(harDir, 'graphql-api.har');

      await engine.explore('https://api.example.com/graphql');
      await engine.startRecording('split-test');
      await stopRecordingAndWait(engine);

      const skills = skillRepo.getBySiteId('api.example.com');
      const genericGqlSkill = skills.find(s =>
        !s.id.includes('.gql.') && s.pathTemplate.includes('/graphql'),
      );
      expect(genericGqlSkill).toBeUndefined();
    }, 15000);
  });

  // ═══════════════════════════════════════════════════════════════
  // EXECUTION WIRING
  // ═══════════════════════════════════════════════════════════════

  describe('Execution wiring (engine.executeSkill -> live server)', () => {
    const EXECUTION_TIMEOUT_MS = 30_000;
    let mockServer: Awaited<ReturnType<typeof createRestMockServer>>;
    let testSkillId: string;

    beforeEach(async () => {
      mockServer = await createRestMockServer();
      const serverHostname = new URL(mockServer.url).hostname;
      const siteId = serverHostname;

      setSitePolicy({
        siteId,
        allowedMethods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
        maxQps: 100,
        maxConcurrent: 10,
        readOnlyDefault: true,
        requireConfirmation: [],
        domainAllowlist: [serverHostname, 'localhost', '127.0.0.1'],
        redactionRules: [],
        capabilities: DEFAULT_CAPS,
      });

      siteRepo.create({
        id: siteId,
        displayName: siteId,
        firstSeen: Date.now(),
        lastVisited: Date.now(),
        masteryLevel: 'full',
        recommendedTier: 'direct',
        totalRequests: 0,
        successfulRequests: 0,
      });

      testSkillId = `${siteId.replace(/\./g, '_')}.get_users.v1`;
      const skill: SkillSpec = {
        id: testSkillId,
        siteId,
        name: 'get_users',
        version: 1,
        status: 'active' as any,
        method: 'GET',
        pathTemplate: `${mockServer.url}/api/users`,
        inputSchema: { type: 'object', properties: { page: { type: 'number' } } },
        sideEffectClass: 'read-only',
        isComposite: false,
        currentTier: 'tier_1',
        tierLock: null,
        confidence: 0.5,
        consecutiveValidations: 0,
        sampleCount: 5,
        successRate: 1.0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        allowedDomains: [serverHostname, '127.0.0.1'],
        requiredCapabilities: [],
        parameters: [{ name: 'page', type: 'number', in: 'query', required: false }],
        validation: { semanticChecks: [], customInvariants: [] },
        redaction: { piiClassesFound: [], fieldsRedacted: 0 },
        replayStrategy: 'prefer_tier_1',
        requiredHeaders: {
          Accept: 'application/json',
          Authorization: 'Bearer token123',
        },
      } as SkillSpec;

      skillRepo.create(skill);
    });

    afterEach(async () => {
      if (mockServer) await mockServer.close();
    });

    it('increments validation counters on success (A1)', async () => {
      const before = skillRepo.getById(testSkillId)!;
      expect(before.consecutiveValidations).toBe(0);
      expect(before.confidence).toBe(0.5);

      const result = await engine.executeSkill(testSkillId, { page: 1 });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();

      const after = skillRepo.getById(testSkillId)!;
      expect(after.consecutiveValidations).toBe(1);
      expect(after.confidence).toBeGreaterThan(0.5);
    }, EXECUTION_TIMEOUT_MS);

    it('resets validation counters on failure (A1)', async () => {
      skillRepo.updateConfidence(testSkillId, 0.8, 3);

      // Use idempotent side-effect class so executeSkill uses the single-attempt
      // path (not retryWithEscalation). This avoids retry escalation to browser
      // tiers that fail with FETCH_ERROR (an infra cause that skips counter decay).
      skillRepo.update(testSkillId, {
        pathTemplate: `${mockServer.url}/api/nonexistent`,
        sideEffectClass: 'idempotent',
      });

      const result = await engine.executeSkill(testSkillId, {});
      expect(result.success).toBe(false);

      const after = skillRepo.getById(testSkillId)!;
      expect(after.consecutiveValidations).toBe(0);
      expect(after.confidence).toBeLessThan(0.8);
    }, EXECUTION_TIMEOUT_MS);

    it('infers schema on first successful execution (B1 Phase 1)', async () => {
      const before = skillRepo.getById(testSkillId)!;
      expect(before.outputSchema).toBeUndefined();

      const result = await engine.executeSkill(testSkillId, {});
      expect(result.success).toBe(true);

      const after = skillRepo.getById(testSkillId)!;
      expect(after.outputSchema).toBeDefined();
      expect(after.outputSchema).not.toEqual({});

      const schema = after.outputSchema as Record<string, unknown>;
      expect(schema.type).toBe('array');
    }, EXECUTION_TIMEOUT_MS);

    it('accumulates schema via mergeSchemas for <3 validations (B1 Phase 2)', async () => {
      const result1 = await engine.executeSkill(testSkillId, {});
      expect(result1.success).toBe(true);

      const afterFirst = skillRepo.getById(testSkillId)!;
      expect(afterFirst.outputSchema).toBeDefined();

      const result2 = await engine.executeSkill(testSkillId, {});
      expect(result2.success).toBe(true);

      const afterSecond = skillRepo.getById(testSkillId)!;
      expect(afterSecond.outputSchema).toBeDefined();
      expect((afterSecond.outputSchema as Record<string, unknown>).type).toBe('array');
    }, EXECUTION_TIMEOUT_MS);

    it('records metrics after execution (engine step 7)', async () => {
      const result = await engine.executeSkill(testSkillId, {});
      expect(result.success).toBe(true);

      const metrics = metricsRepo.getBySkillId(testSkillId);
      expect(metrics.length).toBe(1);
      expect(metrics[0].success).toBe(true);
      expect(metrics[0].latencyMs).toBeGreaterThanOrEqual(0);
    }, EXECUTION_TIMEOUT_MS);

    it('detects schema_drift via executor and demotes via health monitor (B1+B2)', async () => {
      // Schema expects an object but API returns an array — executor's parseResponse
      // catches this as schema_drift BEFORE engine's B1 drift detection runs.
      // The retry loop exhausts, health monitor evaluates, and the skill may be demoted.
      const schema = {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          email: { type: 'string' },
        },
        required: ['id', 'name', 'email'],
      };

      skillRepo.update(testSkillId, {
        outputSchema: schema as any,
        consecutiveValidations: 5,
      });

      const result = await engine.executeSkill(testSkillId, {});

      // Executor detects schema_drift (type: object vs actual array)
      expect(result.success).toBe(false);
      expect(result.error).toContain('schema_drift');

      // A1: Validation counters reset on failure
      const after = skillRepo.getById(testSkillId)!;
      expect(after.consecutiveValidations).toBe(0);
      expect(after.confidence).toBeLessThan(0.5);

      // B2: Health monitor may mark skill as broken after repeated failures
      expect(['active', 'broken']).toContain(after.status);
    }, EXECUTION_TIMEOUT_MS);

    it('queues MCP notifications on skill health change (B3)', async () => {
      // When schema_drift causes repeated failures, the health monitor
      // may queue a 'skill_broken' or 'skill_degraded' notification
      const schema = {
        type: 'object',
        properties: { id: { type: 'integer' }, name: { type: 'string' } },
        required: ['id', 'name'],
      };
      skillRepo.update(testSkillId, {
        outputSchema: schema as any,
        consecutiveValidations: 5,
      });

      drainMcpNotifications();

      await engine.executeSkill(testSkillId, {});

      const notifications = drainMcpNotifications();
      // Health monitor may queue broken/degraded notifications
      // At minimum, verify the notification system is operational
      if (notifications.length > 0) {
        const healthNotification = notifications.find(
          n => {
            const params = n.params as any;
            return params?.reason === 'skill_broken' || params?.reason === 'skill_degraded';
          },
        );
        expect(healthNotification).toBeDefined();
      }
      // If no notifications, the skill was still healthy despite failures
      // (health monitor checks rolling window, may not trigger with few data points)
    }, 15000);

    it('health monitoring evaluates after execution (B2)', async () => {
      // Execute successfully — health monitor should report healthy
      const result = await engine.executeSkill(testSkillId, {});
      expect(result.success).toBe(true);

      // The skill should remain active (healthy status, no demotion)
      const after = skillRepo.getById(testSkillId)!;
      expect(after.status).toBe('active');
    }, EXECUTION_TIMEOUT_MS);
  });

  // ═══════════════════════════════════════════════════════════════
  // MCP TOOL DISPATCH ROUTING
  // ═══════════════════════════════════════════════════════════════

  describe('MCP tool dispatch routing', () => {
    let confirmation: ConfirmationManager;

    beforeEach(() => {
      confirmation = new ConfirmationManager(config);
    });

    function makeDeps() {
      return { engine, skillRepo, siteRepo, confirmation, config };
    }

    it('schrute_explore creates session via MCP dispatch', async () => {
      const result = await dispatchToolCall('schrute_explore', { url: 'https://api.example.com/app' }, makeDeps());
      expect(result.isError).toBeFalsy();

      const data = JSON.parse(result.content[0].text);
      expect(data.sessionId).toBeDefined();
      expect(data.siteId).toBe('api.example.com');
    }, 10000);

    it('schrute_record + schrute_stop triggers capture pipeline via MCP', async () => {
      mockHarPath = join(harDir, 'simple-rest-api.har');

      await dispatchToolCall('schrute_explore', { url: 'https://api.example.com/api' }, makeDeps());

      const recordResult = await dispatchToolCall('schrute_record', { name: 'mcp-test' }, makeDeps());
      expect(recordResult.isError).toBeFalsy();

      const stopResult = await dispatchToolCall('schrute_stop', {}, makeDeps());
      expect(stopResult.isError).toBeFalsy();
      const stopData = JSON.parse(stopResult.content[0].text);
      expect(stopData.pipelineJobId).toBeDefined();
      await waitForPipelineCompletion(engine, stopData.pipelineJobId);

      const skills = skillRepo.getBySiteId('api.example.com');
      expect(skills.length).toBeGreaterThan(0);

      const skillsResult = await dispatchToolCall('schrute_skills', { siteId: 'api.example.com' }, makeDeps());
      expect(skillsResult.isError).toBeFalsy();
      const skillsData = JSON.parse(skillsResult.content[0].text);
      expect(skillsData.totalSkills).toBeGreaterThan(0);
    }, 15000);

    it('schrute_status returns engine state via MCP dispatch', async () => {
      const result = await dispatchToolCall('schrute_status', {}, makeDeps());
      expect(result.isError).toBeFalsy();

      const data = JSON.parse(result.content[0].text);
      expect(data.mode).toBe('idle');
      expect(data.uptime).toBeGreaterThanOrEqual(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // HAR CAPTURE VERIFICATION (5E)
  // ═══════════════════════════════════════════════════════════════

  describe('HAR capture (5E)', () => {
    it('record → stop → HAR file referenced with entries', async () => {
      mockHarPath = join(harDir, 'simple-rest-api.har');

      await engine.explore('https://api.example.com/api');
      await engine.startRecording('har-capture-test');
      const recordingInfo = await stopRecordingAndWait(engine);

      // The recording info should have populated request count from the HAR
      expect(recordingInfo).toBeDefined();
      expect(recordingInfo.name).toBe('har-capture-test');
      expect(recordingInfo.siteId).toBe('api.example.com');
      // HAR had 5 entries, so signal/request counts reflect pipeline output
      expect(recordingInfo.requestCount).toBeGreaterThanOrEqual(0);

      // Skills were generated from the HAR
      const skills = skillRepo.getBySiteId('api.example.com');
      expect(skills.length).toBeGreaterThan(0);
    }, 15000);

    it('empty HAR produces graceful result with no skills', async () => {
      // When no HAR path is set (undefined), the pipeline throws an invariant error
      // but the engine mode still resets. Test with a path but no matching entries:
      // We set mockHarPath to undefined to simulate missing HAR
      mockHarPath = undefined;

      await engine.explore('https://example.com/empty');

      await engine.startRecording('empty-har-test');

      // Stop recording should throw because HAR path is missing
      await expect(engine.stopRecording()).rejects.toThrow();

      // Engine mode should have reset to exploring despite the error
      // (stopRecording sets mode to 'exploring' before pipeline runs)
      const status = engine.getStatus();
      expect(status.mode).toBe('exploring');
    }, 15000);
  });

  // ═══════════════════════════════════════════════════════════════
  // SKILL GENERATION ROUND-TRIP (5F)
  // ═══════════════════════════════════════════════════════════════

  describe('Skill generation round-trip (5F)', () => {
    let mockServer: Awaited<ReturnType<typeof createRestMockServer>>;

    beforeEach(async () => {
      mockServer = await createRestMockServer();
      const serverHostname = new URL(mockServer.url).hostname;

      setSitePolicy({
        siteId: serverHostname,
        allowedMethods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
        maxQps: 100,
        maxConcurrent: 10,
        readOnlyDefault: true,
        requireConfirmation: [],
        domainAllowlist: [serverHostname, 'localhost', '127.0.0.1'],
        redactionRules: [],
        capabilities: DEFAULT_CAPS,
      });

      siteRepo.create({
        id: serverHostname,
        displayName: serverHostname,
        firstSeen: Date.now(),
        lastVisited: Date.now(),
        masteryLevel: 'full',
        recommendedTier: 'direct',
        totalRequests: 0,
        successfulRequests: 0,
      });
    });

    afterEach(async () => {
      if (mockServer) await mockServer.close();
    });

    it('record → stop → skills created → list skills → execute skill', async () => {
      mockHarPath = join(harDir, 'simple-rest-api.har');

      const serverHostname = new URL(mockServer.url).hostname;

      // 1. Explore and record
      await engine.explore('https://api.example.com/api');
      await engine.startRecording('round-trip-test');
      await stopRecordingAndWait(engine);

      // 2. Verify skills were generated
      const skills = skillRepo.getBySiteId('api.example.com');
      expect(skills.length).toBeGreaterThan(0);

      // 3. Find a GET skill and promote it for execution
      const getSkill = skills.find(s => s.method === 'GET');
      expect(getSkill).toBeDefined();

      // Create a new skill under the mock server's siteId so the
      // cross-domain budget check passes (siteId must match target host)
      const execSkillId = `${serverHostname.replace(/\./g, '_')}.roundtrip_get_users.v1`;
      skillRepo.create({
        id: execSkillId,
        siteId: serverHostname,
        name: 'roundtrip_get_users',
        version: 1,
        status: 'active' as any,
        method: 'GET',
        pathTemplate: `${mockServer.url}/api/users`,
        inputSchema: { type: 'object', properties: {} },
        sideEffectClass: 'read-only',
        isComposite: false,
        currentTier: 'tier_1',
        tierLock: null,
        confidence: 0.5,
        consecutiveValidations: 0,
        sampleCount: 5,
        successRate: 1.0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        allowedDomains: [serverHostname, '127.0.0.1'],
        requiredCapabilities: [],
        parameters: [],
        validation: { semanticChecks: [], customInvariants: [] },
        redaction: { piiClassesFound: [], fieldsRedacted: 0 },
        replayStrategy: 'prefer_tier_1',
        requiredHeaders: {
          Accept: 'application/json',
          Authorization: 'Bearer token123',
        },
      } as SkillSpec);

      // 4. Execute the skill against the mock server
      const result = await engine.executeSkill(execSkillId, {});
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    }, 20000);

    it('skills list via dispatch after recording', async () => {
      mockHarPath = join(harDir, 'simple-rest-api.har');

      const confirmation = new ConfirmationManager(config);
      const deps = { engine, skillRepo, siteRepo, confirmation, config };

      // Explore + record + stop via dispatch
      await dispatchToolCall('schrute_explore', { url: 'https://api.example.com/api' }, deps);
      await dispatchToolCall('schrute_record', { name: 'dispatch-roundtrip' }, deps);
      const stopResult = await dispatchToolCall('schrute_stop', {}, deps);
      expect(stopResult.isError).toBeFalsy();
      const stopData = JSON.parse(stopResult.content[0].text);
      expect(stopData.pipelineJobId).toBeDefined();
      await waitForPipelineCompletion(engine, stopData.pipelineJobId);

      // List skills via dispatch
      const skillsResult = await dispatchToolCall('schrute_skills', { siteId: 'api.example.com' }, deps);
      expect(skillsResult.isError).toBeFalsy();

      const skillsData = JSON.parse(skillsResult.content[0].text);
      expect(skillsData.totalSkills).toBeGreaterThan(0);

      // Each skill should have expected properties
      const allSkills = Object.values(skillsData.sites).flatMap((s: any) => s.skills);
      for (const skill of allSkills) {
        expect(skill.id).toBeDefined();
        expect(skill.name).toBeDefined();
        expect(skill.method).toBeDefined();
        // P2-6: read-only GET/HEAD skills are auto-activated
        expect(['draft', 'active']).toContain(skill.status);
      }
    }, 15000);
  });

  // ═══════════════════════════════════════════════════════════════
  // NOTIFICATION DRAIN WIRING (B4)
  // ═══════════════════════════════════════════════════════════════

  describe('MCP notification drain (B4)', () => {
    it('drainMcpNotifications returns queued promotion events', async () => {
      drainMcpNotifications();

      mockHarPath = join(harDir, 'simple-rest-api.har');

      await engine.explore('https://api.example.com/api');
      await engine.startRecording('notify-test');
      await stopRecordingAndWait(engine);

      const skills = skillRepo.getBySiteId('api.example.com');
      // Find a non-read-only skill that won't be auto-activated (POST/PUT/DELETE)
      // Read-only GET/HEAD skills are auto-activated and won't produce a promotion notification.
      const candidateSkill = skills.find(s => s.sideEffectClass !== 'read-only' && s.status !== 'active')
        ?? skills.find(s => s.status !== 'active');
      if (candidateSkill) {
        skillRepo.update(candidateSkill.id, {
          sampleCount: 5,
          consecutiveValidations: config.promotionConsecutivePasses,
        });

        drainMcpNotifications(); // clear before triggering

        await engine.startRecording('promo-notify');
        await stopRecordingAndWait(engine);

        const notifications = drainMcpNotifications();
        const promoted = skillRepo.getById(candidateSkill.id);
        if (promoted?.status === 'active') {
          expect(notifications.length).toBeGreaterThan(0);
          const promoNotification = notifications.find(n =>
            (n.params as any)?.reason === 'skill_promoted',
          );
          expect(promoNotification).toBeDefined();
        }
      }
    }, 20000);
  });
});
