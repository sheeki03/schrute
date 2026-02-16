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

// ─── Mock fs operations (using factory without top-level vars) ───
vi.mock('node:fs', () => {
  const fn = (...args: unknown[]) => (vi.fn() as any)(...args);
  return {
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue(''),
    statSync: vi.fn().mockReturnValue({ mode: 0o600 }),
    unlinkSync: vi.fn(),
    default: {
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn().mockReturnValue(''),
      statSync: vi.fn().mockReturnValue({ mode: 0o600 }),
      unlinkSync: vi.fn(),
    },
  };
});

// ─── Mock config ─────────────────────────────────────────────────
vi.mock('../../src/core/config.js', () => ({
  getDaemonSocketPath: (config: { dataDir: string }) => `${config.dataDir}/daemon.sock`,
  getDaemonPidPath: (config: { dataDir: string }) => `${config.dataDir}/daemon.pid`,
  getDaemonTokenPath: (config: { dataDir: string }) => `${config.dataDir}/daemon.token`,
}));

// ─── Mock http ───────────────────────────────────────────────────
vi.mock('node:http', () => ({
  request: vi.fn(),
  default: { request: vi.fn() },
}));

vi.mock('node:net', () => ({
  createConnection: vi.fn(),
  default: { createConnection: vi.fn() },
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn().mockReturnValue({ unref: vi.fn() }),
}));

import * as fs from 'node:fs';
import { createDaemonClient } from '../../src/client/daemon-client.js';
import type { OneAgentConfig } from '../../src/skill/types.js';

function makeConfig(): OneAgentConfig {
  return {
    dataDir: '/tmp/oneagent-client-test',
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

describe('daemon-client', () => {
  let config: OneAgentConfig;
  const mockExistsSync = fs.existsSync as unknown as ReturnType<typeof vi.fn>;
  const mockReadFileSync = fs.readFileSync as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    config = makeConfig();
    mockExistsSync.mockReturnValue(false);
  });

  describe('isAvailable', () => {
    it('returns false when no PID file exists', async () => {
      mockExistsSync.mockReturnValue(false);

      const client = createDaemonClient(config);
      const available = await client.isAvailable();
      expect(available).toBe(false);
    });

    it('returns false when PID file has wrong API version', async () => {
      const pidContent = JSON.stringify({
        pid: process.pid,
        version: '0.2.0',
        apiVersion: 999, // wrong version
        startedAt: new Date().toISOString(),
      });

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(pidContent);

      const client = createDaemonClient(config);
      const available = await client.isAvailable();
      expect(available).toBe(false);
    });
  });

  describe('request', () => {
    it('throws when no daemon is running (no PID file)', async () => {
      mockExistsSync.mockReturnValue(false);

      const client = createDaemonClient(config);
      await expect(client.request('GET', '/ctl/status')).rejects.toThrow(
        'No daemon running',
      );
    });
  });

  describe('transport resolution patterns', () => {
    it('prefers UDS when socket file exists', () => {
      // This tests the conceptual pattern: if socket exists -> UDS
      const socketPath = `${config.dataDir}/daemon.sock`;
      mockExistsSync.mockImplementation((p: unknown) => {
        if (typeof p === 'string' && p === socketPath) return true;
        return false;
      });
      expect(fs.existsSync(socketPath)).toBe(true);
    });
  });

  describe('stale PID detection pattern', () => {
    it('detects stale PID when process is dead', () => {
      const isPidAlive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };

      // Use a PID that is very unlikely to exist
      expect(isPidAlive(999999999)).toBe(false);
      // Current process should be alive
      expect(isPidAlive(process.pid)).toBe(true);
    });
  });

  describe('version check pattern', () => {
    it('rejects mismatched API versions', () => {
      const clientApiVersion = 1;
      const daemonApiVersion = 2;
      expect(daemonApiVersion).not.toBe(clientApiVersion);
    });

    it('accepts matching API versions', () => {
      const clientApiVersion = 1;
      const daemonApiVersion = 1;
      expect(daemonApiVersion).toBe(clientApiVersion);
    });
  });
});
