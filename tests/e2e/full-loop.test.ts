import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Engine } from '../../src/core/engine.js';
import { executeSkill } from '../../src/replay/executor.js';
import type { OneAgentConfig, SkillSpec, SealedFetchRequest, SealedFetchResponse } from '../../src/skill/types.js';
import { Capability } from '../../src/skill/types.js';
import { createRestMockServer } from '../fixtures/mock-sites/rest-mock-server.js';
import { setSitePolicy } from '../../src/core/policy.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

// Mock resolveAndValidate to avoid real DNS lookups in tests
vi.mock('../../src/core/policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/policy.js')>();
  return {
    ...actual,
    resolveAndValidate: vi.fn().mockResolvedValue({ ip: '127.0.0.1', allowed: true, category: 'unicast' }),
  };
});

// Mock the database module to avoid better-sqlite3 native module issues
vi.mock('../../src/storage/database.js', () => {
  const mockDb = {
    prepare: () => ({
      run: () => ({ changes: 1 }),
      get: () => undefined,
      all: () => [],
    }),
    exec: () => {},
    close: () => {},
  };
  class MockAgentDatabase {
    open() {}
    close() {}
    run() { return { changes: 1 }; }
    get() { return undefined; }
    all() { return []; }
    exec() {}
  }
  return {
    AgentDatabase: MockAgentDatabase,
    getDatabase: () => new MockAgentDatabase(),
    closeDatabase: () => {},
  };
});

function makeTestConfig(): OneAgentConfig {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oneagent-e2e-full-'));
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
    daemon: { port: 19420, autoStart: false },
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

describe('Full Loop E2E', () => {
  let config: OneAgentConfig;
  let engine: Engine;

  beforeEach(() => {
    config = makeTestConfig();
    // Ensure data directories exist
    fs.mkdirSync(path.join(config.dataDir, 'audit'), { recursive: true });
    fs.mkdirSync(path.join(config.dataDir, 'data'), { recursive: true });
    engine = new Engine(config);

    // Set up site policies so executor policy gates pass
    const defaultCaps = [
      Capability.NET_FETCH_DIRECT,
      Capability.NET_FETCH_BROWSER_PROXIED,
      Capability.BROWSER_AUTOMATION,
      Capability.STORAGE_WRITE,
      Capability.SECRETS_USE,
    ];
    setSitePolicy({
      siteId: 'example.com',
      allowedMethods: ['GET', 'HEAD', 'POST'],
      maxQps: 10,
      maxConcurrent: 3,
      readOnlyDefault: true,
      requireConfirmation: [],
      domainAllowlist: ['example.com', 'localhost', '127.0.0.1'],
      redactionRules: [],
      capabilities: defaultCaps,
    });
  });

  afterEach(async () => {
    if (engine) await engine.close();
    fs.rmSync(config.dataDir, { recursive: true, force: true });
  });

  it('should explore a URL and create a session', async () => {
    const result = await engine.explore('https://example.com/app');

    expect(result.sessionId).toBeDefined();
    expect(result.siteId).toBe('example.com');
    expect(result.url).toBe('https://example.com/app');

    const status = engine.getStatus();
    expect(status.mode).toBe('exploring');
    expect(status.activeSession).not.toBeNull();
  }, 10000);

  it('should go through explore -> record -> stop cycle', async () => {
    await engine.explore('https://example.com/api');

    const recording = await engine.startRecording('get-users', { page: '1' });
    expect(recording.name).toBe('get-users');
    expect(recording.siteId).toBe('example.com');
    expect(recording.inputs).toEqual({ page: '1' });

    let status = engine.getStatus();
    expect(status.mode).toBe('recording');
    expect(status.currentRecording).not.toBeNull();

    const stopped = await engine.stopRecording();
    expect(stopped.name).toBe('get-users');

    status = engine.getStatus();
    expect(status.mode).toBe('exploring');
    expect(status.currentRecording).toBeNull();
  }, 10000);

  it('should reject recording when not in exploring mode', async () => {
    // Engine starts idle
    await expect(
      engine.startRecording('test-action'),
    ).rejects.toThrow(/Cannot start recording in 'idle' mode/);

    // After explore, recording is allowed
    await engine.explore('https://example.com');
    const recording = await engine.startRecording('test-action');
    expect(recording).toBeDefined();

    // While recording, cannot start another recording
    await expect(
      engine.startRecording('another-action'),
    ).rejects.toThrow(/Cannot start recording in 'recording' mode/);
  }, 10000);

  it('should reject stopping when not recording', async () => {
    await expect(engine.stopRecording()).rejects.toThrow(/No active recording to stop/);
  }, 10000);

  it('should execute a skill against the REST mock server using tier 1 (direct fetch)', async () => {
    const server = await createRestMockServer();

    try {
      const skill = loadSkillFixture('get-users-skill.json');
      const serverHostname = new URL(server.url).hostname;
      // Point the skill at our mock server
      skill.allowedDomains = [serverHostname];
      skill.pathTemplate = `${server.url}/api/users`;

      // Set up site policy for the fixture's siteId
      setSitePolicy({
        siteId: skill.siteId,
        allowedMethods: ['GET', 'HEAD', 'POST'],
        maxQps: 10,
        maxConcurrent: 3,
        readOnlyDefault: true,
        requireConfirmation: [],
        domainAllowlist: [serverHostname, 'localhost', '127.0.0.1'],
        redactionRules: [],
        capabilities: [
          Capability.NET_FETCH_DIRECT,
          Capability.NET_FETCH_BROWSER_PROXIED,
          Capability.BROWSER_AUTOMATION,
          Capability.STORAGE_WRITE,
          Capability.SECRETS_USE,
        ],
      });
      // Replace the template token with a real one for the mock server
      skill.requiredHeaders = {
        Accept: 'application/json',
        Authorization: 'Bearer token123',
      };

      const fetchFn = async (req: SealedFetchRequest): Promise<SealedFetchResponse> => {
        const resp = await fetch(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body,
        });
        const body = await resp.text();
        const headers: Record<string, string> = {};
        resp.headers.forEach((value, key) => { headers[key] = value; });
        return { status: resp.status, headers, body };
      };

      const result = await executeSkill(skill, { page: 1, limit: 10 }, {
        fetchFn,
        forceTier: 'direct',
      });

      expect(result.status).toBe(200);
      expect(result.tier).toBe('direct');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);

      // Parse the data to verify it's the expected users
      const data = result.data as Array<Record<string, unknown>>;
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThan(0);
      expect(data[0]).toHaveProperty('name');
      expect(data[0]).toHaveProperty('email');
    } finally {
      await server.close();
    }
  }, 15000);

  it('should handle skill execution with tier 3 (browser proxied) via mock', async () => {
    const server = await createRestMockServer();

    try {
      const skill = loadSkillFixture('get-users-skill.json');
      const serverHostname = new URL(server.url).hostname;
      skill.allowedDomains = [serverHostname];
      skill.pathTemplate = `${server.url}/api/users`;
      skill.currentTier = 'tier_3';

      // Set up site policy for the fixture's siteId
      setSitePolicy({
        siteId: skill.siteId,
        allowedMethods: ['GET', 'HEAD', 'POST'],
        maxQps: 10,
        maxConcurrent: 3,
        readOnlyDefault: true,
        requireConfirmation: [],
        domainAllowlist: [serverHostname, 'localhost', '127.0.0.1'],
        redactionRules: [],
        capabilities: [
          Capability.NET_FETCH_DIRECT,
          Capability.NET_FETCH_BROWSER_PROXIED,
          Capability.BROWSER_AUTOMATION,
          Capability.STORAGE_WRITE,
          Capability.SECRETS_USE,
        ],
      });
      // Replace the template token with a real one
      skill.requiredHeaders = {
        Accept: 'application/json',
        Authorization: 'Bearer token123',
      };

      // Create a mock browser provider that delegates to fetch
      const mockBrowserProvider = {
        navigate: async () => {},
        snapshot: async () => ({ url: '', title: '', content: '' }),
        click: async () => {},
        type: async () => {},
        evaluateFetch: async (req: SealedFetchRequest): Promise<SealedFetchResponse> => {
          const resp = await fetch(req.url, {
            method: req.method,
            headers: req.headers,
            body: req.body,
          });
          const body = await resp.text();
          const headers: Record<string, string> = {};
          resp.headers.forEach((value, key) => { headers[key] = value; });
          return { status: resp.status, headers, body };
        },
        screenshot: async () => Buffer.from(''),
        networkRequests: async () => [],
      };

      const result = await executeSkill(skill, { page: 1, limit: 10 }, {
        browserProvider: mockBrowserProvider,
        forceTier: 'browser_proxied',
      });

      expect(result.status).toBe(200);
      expect(result.tier).toBe('browser_proxied');
      const data = result.data as Array<Record<string, unknown>>;
      expect(Array.isArray(data)).toBe(true);
    } finally {
      await server.close();
    }
  }, 15000);

  it('should close engine and clean up state', async () => {
    await engine.explore('https://example.com');
    await engine.startRecording('test');

    const statusBefore = engine.getStatus();
    expect(statusBefore.mode).toBe('recording');

    await engine.close();

    const statusAfter = engine.getStatus();
    expect(statusAfter.mode).toBe('idle');
    expect(statusAfter.activeSession).toBeNull();
    expect(statusAfter.currentRecording).toBeNull();
  }, 15000);
});
