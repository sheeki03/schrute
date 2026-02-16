import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Mock logger ─────────────────────────────────────────────────
vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// We need to import config functions fresh each time because of cached state
let configModule: typeof import('../../src/core/config.js');

beforeEach(async () => {
  vi.resetModules();
  vi.mock('../../src/core/logger.js', () => ({
    getLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  }));
  configModule = await import('../../src/core/config.js');
  configModule.resetConfigCache();
});

describe('config', () => {
  describe('loadConfig', () => {
    it('returns default config when no config file exists', () => {
      const config = configModule.loadConfig('/nonexistent/path/config.json');
      expect(config.dataDir).toBeDefined();
      expect(config.logLevel).toBe('info');
      expect(config.toolBudget.maxToolCallsPerTask).toBe(50);
    });

    it('returns default config when config file is invalid JSON', () => {
      const tmpPath = path.join('/tmp', `oneagent-test-config-${Date.now()}.json`);
      fs.writeFileSync(tmpPath, 'not json at all{{{', 'utf-8');

      try {
        const config = configModule.loadConfig(tmpPath);
        expect(config.dataDir).toBeDefined();
      } finally {
        fs.unlinkSync(tmpPath);
      }
    });

    it('deep-merges config file with defaults', () => {
      const tmpPath = path.join('/tmp', `oneagent-test-config-${Date.now()}.json`);
      fs.writeFileSync(
        tmpPath,
        JSON.stringify({
          logLevel: 'debug',
          toolBudget: { maxToolCallsPerTask: 100 },
        }),
        'utf-8',
      );

      try {
        const config = configModule.loadConfig(tmpPath);
        expect(config.logLevel).toBe('debug');
        expect(config.toolBudget.maxToolCallsPerTask).toBe(100);
        // Other defaults should be preserved
        expect(config.toolBudget.maxConcurrentCalls).toBe(3);
      } finally {
        fs.unlinkSync(tmpPath);
      }
    });

    it('throws on invalid config sections (payloadLimits)', () => {
      const tmpPath = path.join('/tmp', `oneagent-test-config-${Date.now()}.json`);
      fs.writeFileSync(
        tmpPath,
        JSON.stringify({ payloadLimits: 'not an object' }),
        'utf-8',
      );

      try {
        expect(() => configModule.loadConfig(tmpPath)).toThrow('Invalid config');
      } finally {
        fs.unlinkSync(tmpPath);
      }
    });
  });

  describe('deepMerge (tested via loadConfig)', () => {
    it('merges nested objects correctly', () => {
      const tmpPath = path.join('/tmp', `oneagent-test-merge-${Date.now()}.json`);
      fs.writeFileSync(
        tmpPath,
        JSON.stringify({
          payloadLimits: {
            maxResponseBodyBytes: 999,
          },
        }),
        'utf-8',
      );

      try {
        const config = configModule.loadConfig(tmpPath);
        expect(config.payloadLimits.maxResponseBodyBytes).toBe(999);
        // Other payloadLimits fields preserved
        expect(config.payloadLimits.maxRequestBodyBytes).toBe(5 * 1024 * 1024);
        expect(config.payloadLimits.redactorTimeoutMs).toBe(10000);
      } finally {
        fs.unlinkSync(tmpPath);
      }
    });

    it('does not merge arrays (replaces them)', () => {
      const tmpPath = path.join('/tmp', `oneagent-test-array-${Date.now()}.json`);
      fs.writeFileSync(
        tmpPath,
        JSON.stringify({
          features: { webmcp: true },
        }),
        'utf-8',
      );

      try {
        const config = configModule.loadConfig(tmpPath);
        expect(config.features.webmcp).toBe(true);
      } finally {
        fs.unlinkSync(tmpPath);
      }
    });
  });

  describe('setConfigValue', () => {
    it('throws for unknown top-level keys', () => {
      expect(() => configModule.setConfigValue('unknownKey', 'value')).toThrow('Unknown config key');
    });

    it('coerces string "true" to boolean true', () => {
      const config = configModule.setConfigValue('features.webmcp', 'true');
      expect(config.features.webmcp).toBe(true);
    });

    it('coerces string "false" to boolean false', () => {
      const config = configModule.setConfigValue('features.webmcp', 'false');
      expect(config.features.webmcp).toBe(false);
    });

    it('coerces numeric strings for allowlisted keys', () => {
      const config = configModule.setConfigValue('toolBudget.maxToolCallsPerTask', '100');
      expect(config.toolBudget.maxToolCallsPerTask).toBe(100);
    });

    it('does not coerce non-allowlisted string values to numbers', () => {
      const config = configModule.setConfigValue('logLevel', '42');
      expect(config.logLevel).toBe('42');
    });

    it('sets nested values', () => {
      const config = configModule.setConfigValue('payloadLimits.redactorTimeoutMs', '5000');
      expect(config.payloadLimits.redactorTimeoutMs).toBe(5000);
    });

    it('accepts valid browser.engine values', () => {
      for (const engine of ['playwright', 'patchright', 'camoufox']) {
        const config = configModule.setConfigValue('browser.engine', engine);
        expect(config.browser?.engine).toBe(engine);
      }
    });

    it('rejects invalid browser.engine values', () => {
      expect(() => configModule.setConfigValue('browser.engine', 'selenium')).toThrow(
        'Invalid value for browser.engine',
      );
    });

    it('creates browser parent object when absent', () => {
      const config = configModule.setConfigValue('browser.engine', 'playwright');
      expect(config.browser).toBeDefined();
      expect(config.browser?.engine).toBe('playwright');
    });
  });

  describe('path helpers', () => {
    it('getDaemonSocketPath returns path under dataDir', () => {
      const config = { dataDir: '/test/data' } as import('../../src/skill/types.js').OneAgentConfig;
      const result = configModule.getDaemonSocketPath(config);
      expect(result).toBe('/test/data/daemon.sock');
    });

    it('getDaemonPidPath returns path under dataDir', () => {
      const config = { dataDir: '/test/data' } as import('../../src/skill/types.js').OneAgentConfig;
      const result = configModule.getDaemonPidPath(config);
      expect(result).toBe('/test/data/daemon.pid');
    });

    it('getDaemonTokenPath returns path under dataDir', () => {
      const config = { dataDir: '/test/data' } as import('../../src/skill/types.js').OneAgentConfig;
      const result = configModule.getDaemonTokenPath(config);
      expect(result).toBe('/test/data/daemon.token');
    });
  });
});
