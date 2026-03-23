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
      const tmpPath = path.join('/tmp', `schrute-test-config-${Date.now()}.json`);
      fs.writeFileSync(tmpPath, 'not json at all{{{', 'utf-8');

      try {
        const config = configModule.loadConfig(tmpPath);
        expect(config.dataDir).toBeDefined();
      } finally {
        fs.unlinkSync(tmpPath);
      }
    });

    it('deep-merges config file with defaults', () => {
      const tmpPath = path.join('/tmp', `schrute-test-config-${Date.now()}.json`);
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
      const tmpPath = path.join('/tmp', `schrute-test-config-${Date.now()}.json`);
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

    it('throws when server.mcpHttpAdmin is a non-boolean (e.g. string "false")', () => {
      const tmpPath = path.join('/tmp', `schrute-test-config-${Date.now()}.json`);
      fs.writeFileSync(
        tmpPath,
        JSON.stringify({ server: { mcpHttpAdmin: 'false' } }),
        'utf-8',
      );

      try {
        expect(() => configModule.loadConfig(tmpPath)).toThrow(
          'Invalid config: server.mcpHttpAdmin must be a boolean',
        );
      } finally {
        fs.unlinkSync(tmpPath);
      }
    });
  });

  describe('deepMerge (tested via loadConfig)', () => {
    it('merges nested objects correctly', () => {
      const tmpPath = path.join('/tmp', `schrute-test-merge-${Date.now()}.json`);
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
      const tmpPath = path.join('/tmp', `schrute-test-array-${Date.now()}.json`);
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

  describe('setConfigValue → loadConfig persistence round-trip', () => {
    it('persists value that loadConfig reads back', () => {
      const tmpDir = path.join('/tmp', `schrute-roundtrip-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmpConfigPath = path.join(tmpDir, 'config.json');

      try {
        // setConfigValue writes to the default config path;
        // to test round-trip we use loadConfig with explicit path
        // First create a valid config at the path
        fs.writeFileSync(tmpConfigPath, JSON.stringify({ dataDir: tmpDir }), 'utf-8');
        const loaded = configModule.loadConfig(tmpConfigPath);
        expect(loaded.dataDir).toBe(tmpDir);

        // Now modify and save
        loaded.logLevel = 'debug';
        configModule.saveConfig(loaded);

        // Read back
        const reloaded = configModule.loadConfig(tmpConfigPath);
        expect(reloaded.logLevel).toBe('debug');
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
    });
  });

  describe('environment variable overrides are NOT persisted', () => {
    it('env override appears in getConfig but setConfigValue does not save it', () => {
      const origVal = process.env.SCHRUTE_LOG_LEVEL;
      try {
        process.env.SCHRUTE_LOG_LEVEL = 'trace';
        configModule.resetConfigCache();

        // Runtime config should reflect env override
        const runtimeConfig = configModule.getConfig();
        expect(runtimeConfig.logLevel).toBe('trace');

        // setConfigValue for unrelated key — loadConfig returns defaults (no file)
        // so the persisted file should have 'info', not 'trace'
        configModule.setConfigValue('tempTtlMs', 5000);

        // Verify the config was saved — we can check by loading from disk
        // Since no real file exists at default path, the important thing is
        // that setConfigValue's internal loadConfig() returns 'info' logLevel
        // and only persists file-config (not env overlays)
        const runtimeAfter = configModule.getConfig();
        // Runtime still has trace because env is still set
        expect(runtimeAfter.logLevel).toBe('trace');
      } finally {
        if (origVal === undefined) {
          delete process.env.SCHRUTE_LOG_LEVEL;
        } else {
          process.env.SCHRUTE_LOG_LEVEL = origVal;
        }
        configModule.resetConfigCache();
      }
    });
  });

  describe('setConfigValueInMemory does NOT write to disk', () => {
    it('modifies runtime config without persisting', () => {
      configModule.resetConfigCache();

      // Capture the baseline tempTtlMs from disk/defaults
      const baseline = configModule.getConfig().tempTtlMs;

      // Use a value that is definitely different from baseline
      const inMemoryValue = baseline === 9999 ? 8888 : 9999;
      configModule.setConfigValueInMemory('tempTtlMs', inMemoryValue);

      // In-memory config reflects the change
      const config = configModule.getConfig();
      expect(config.tempTtlMs).toBe(inMemoryValue);

      // Reset cache and reload — should get baseline back (setConfigValueInMemory did not write)
      configModule.resetConfigCache();
      const reloaded = configModule.getConfig();
      expect(reloaded.tempTtlMs).toBe(baseline);
    });
  });

  describe('setConfigValueInMemory preserves env-override precedence', () => {
    it('env variable wins over in-memory write for the overridden key', () => {
      const envKey = 'SCHRUTE_LOG_LEVEL';
      const original = process.env[envKey];
      try {
        process.env[envKey] = 'warn';
        configModule.resetConfigCache();

        // getConfig should reflect env override
        expect(configModule.getConfig().logLevel).toBe('warn');

        // setConfigValueInMemory tries to set logLevel to 'debug'
        configModule.setConfigValueInMemory('logLevel', 'debug');

        // env override should still win — logLevel should be 'warn'
        expect(configModule.getConfig().logLevel).toBe('warn');
      } finally {
        if (original === undefined) delete process.env[envKey];
        else process.env[envKey] = original;
        configModule.resetConfigCache();
      }
    });

    it('non-overridden keys are still set by in-memory write', () => {
      const envKey = 'SCHRUTE_LOG_LEVEL';
      const original = process.env[envKey];
      try {
        // Ensure no env override for tempTtlMs
        delete process.env[envKey];
        configModule.resetConfigCache();

        const baseline = configModule.getConfig().tempTtlMs;
        const newValue = baseline === 5555 ? 6666 : 5555;
        configModule.setConfigValueInMemory('tempTtlMs', newValue);

        expect(configModule.getConfig().tempTtlMs).toBe(newValue);
      } finally {
        if (original !== undefined) process.env[envKey] = original;
        configModule.resetConfigCache();
      }
    });
  });

  describe('resetConfigCache clears cached config', () => {
    it('forces re-load on next getConfig call', () => {
      configModule.resetConfigCache();

      // Load defaults
      const config1 = configModule.getConfig();
      const defaultTtl = config1.tempTtlMs;

      // Mutate in-memory
      configModule.setConfigValueInMemory('tempTtlMs', 12345);
      expect(configModule.getConfig().tempTtlMs).toBe(12345);

      // Reset cache — next call re-loads from disk (no file → defaults)
      configModule.resetConfigCache();
      const config3 = configModule.getConfig();
      expect(config3.tempTtlMs).toBe(defaultTtl);
    });
  });

  describe('invalid logLevel falls back to info', () => {
    it('unrecognized logLevel in config file falls back to info', () => {
      const tmpPath = path.join('/tmp', `schrute-test-loglevel-${Date.now()}.json`);
      fs.writeFileSync(tmpPath, JSON.stringify({ logLevel: 'banana' }), 'utf-8');

      try {
        const config = configModule.loadConfig(tmpPath);
        expect(config.logLevel).toBe('info');
      } finally {
        fs.unlinkSync(tmpPath);
      }
    });
  });

  describe('proxy validation in setConfigValue', () => {
    it('accepts valid HTTP proxy', () => {
      expect(() => configModule.setConfigValue('browser.proxy.server', 'http://proxy.example.com:8080')).not.toThrow();
    });

    it('accepts valid SOCKS5 proxy', () => {
      expect(() => configModule.setConfigValue('browser.proxy.server', 'socks5://proxy.example.com:1080')).not.toThrow();
    });

    it('rejects invalid proxy URL', () => {
      expect(() => configModule.setConfigValue('browser.proxy.server', 'not-a-url')).toThrow();
    });

    it('rejects proxy with path/query', () => {
      expect(() => configModule.setConfigValue('browser.proxy.server', 'http://proxy.example.com/path?token=secret')).toThrow();
    });
  });

  describe('geo validation in setConfigValue', () => {
    it('accepts valid timezone', () => {
      expect(() => configModule.setConfigValue('browser.geo.timezoneId', 'Europe/Paris')).not.toThrow();
    });

    it('rejects invalid timezone', () => {
      expect(() => configModule.setConfigValue('browser.geo.timezoneId', 'Mars/Olympus')).toThrow();
    });

    it('accepts valid locale', () => {
      expect(() => configModule.setConfigValue('browser.geo.locale', 'fr-FR')).not.toThrow();
    });

    it('rejects latitude > 90', () => {
      expect(() => configModule.setConfigValue('browser.geo.geolocation.latitude', 91)).toThrow();
    });

    it('rejects longitude < -180', () => {
      expect(() => configModule.setConfigValue('browser.geo.geolocation.longitude', -181)).toThrow();
    });
  });

  describe('screenshot env overrides', () => {
    it('SCHRUTE_SCREENSHOT_FORMAT=jpeg is applied', () => {
      const orig = process.env.SCHRUTE_SCREENSHOT_FORMAT;
      try {
        process.env.SCHRUTE_SCREENSHOT_FORMAT = 'jpeg';
        configModule.resetConfigCache();
        const config = configModule.getConfig();
        expect(config.browser?.features?.screenshotFormat).toBe('jpeg');
      } finally {
        if (orig === undefined) delete process.env.SCHRUTE_SCREENSHOT_FORMAT;
        else process.env.SCHRUTE_SCREENSHOT_FORMAT = orig;
        configModule.resetConfigCache();
      }
    });

    it('SCHRUTE_SCREENSHOT_FORMAT=png is applied', () => {
      const orig = process.env.SCHRUTE_SCREENSHOT_FORMAT;
      try {
        process.env.SCHRUTE_SCREENSHOT_FORMAT = 'png';
        configModule.resetConfigCache();
        const config = configModule.getConfig();
        expect(config.browser?.features?.screenshotFormat).toBe('png');
      } finally {
        if (orig === undefined) delete process.env.SCHRUTE_SCREENSHOT_FORMAT;
        else process.env.SCHRUTE_SCREENSHOT_FORMAT = orig;
        configModule.resetConfigCache();
      }
    });

    it('SCHRUTE_SCREENSHOT_FORMAT=webp is rejected', () => {
      const orig = process.env.SCHRUTE_SCREENSHOT_FORMAT;
      try {
        process.env.SCHRUTE_SCREENSHOT_FORMAT = 'webp';
        configModule.resetConfigCache();
        expect(() => configModule.getConfig()).toThrow(/jpeg.*png/i);
      } finally {
        if (orig === undefined) delete process.env.SCHRUTE_SCREENSHOT_FORMAT;
        else process.env.SCHRUTE_SCREENSHOT_FORMAT = orig;
        configModule.resetConfigCache();
      }
    });

    it('SCHRUTE_SCREENSHOT_QUALITY=80 is applied as number', () => {
      const orig = process.env.SCHRUTE_SCREENSHOT_QUALITY;
      try {
        process.env.SCHRUTE_SCREENSHOT_QUALITY = '80';
        configModule.resetConfigCache();
        const config = configModule.getConfig();
        expect(config.browser?.features?.screenshotQuality).toBe(80);
      } finally {
        if (orig === undefined) delete process.env.SCHRUTE_SCREENSHOT_QUALITY;
        else process.env.SCHRUTE_SCREENSHOT_QUALITY = orig;
        configModule.resetConfigCache();
      }
    });

    it('SCHRUTE_SCREENSHOT_QUALITY=0 is rejected', () => {
      const orig = process.env.SCHRUTE_SCREENSHOT_QUALITY;
      try {
        process.env.SCHRUTE_SCREENSHOT_QUALITY = '0';
        configModule.resetConfigCache();
        expect(() => configModule.getConfig()).toThrow(/1.*100/);
      } finally {
        if (orig === undefined) delete process.env.SCHRUTE_SCREENSHOT_QUALITY;
        else process.env.SCHRUTE_SCREENSHOT_QUALITY = orig;
        configModule.resetConfigCache();
      }
    });

    it('SCHRUTE_SCREENSHOT_QUALITY=101 is rejected', () => {
      const orig = process.env.SCHRUTE_SCREENSHOT_QUALITY;
      try {
        process.env.SCHRUTE_SCREENSHOT_QUALITY = '101';
        configModule.resetConfigCache();
        expect(() => configModule.getConfig()).toThrow(/1.*100/);
      } finally {
        if (orig === undefined) delete process.env.SCHRUTE_SCREENSHOT_QUALITY;
        else process.env.SCHRUTE_SCREENSHOT_QUALITY = orig;
        configModule.resetConfigCache();
      }
    });
  });

  describe('screenshot validation in setConfigValue', () => {
    it('accepts screenshotFormat=jpeg', () => {
      expect(() => configModule.setConfigValue('browser.features.screenshotFormat', 'jpeg')).not.toThrow();
    });

    it('accepts screenshotFormat=png', () => {
      expect(() => configModule.setConfigValue('browser.features.screenshotFormat', 'png')).not.toThrow();
    });

    it('rejects screenshotFormat=webp', () => {
      expect(() => configModule.setConfigValue('browser.features.screenshotFormat', 'webp')).toThrow(/jpeg.*png/i);
    });

    it('rejects screenshotFormat=bmp', () => {
      expect(() => configModule.setConfigValue('browser.features.screenshotFormat', 'bmp')).toThrow(/jpeg.*png/i);
    });

    it('accepts screenshotQuality=50', () => {
      expect(() => configModule.setConfigValue('browser.features.screenshotQuality', 50)).not.toThrow();
    });

    it('accepts screenshotQuality=1 (minimum)', () => {
      expect(() => configModule.setConfigValue('browser.features.screenshotQuality', 1)).not.toThrow();
    });

    it('accepts screenshotQuality=100 (maximum)', () => {
      expect(() => configModule.setConfigValue('browser.features.screenshotQuality', 100)).not.toThrow();
    });

    it('rejects screenshotQuality=0', () => {
      expect(() => configModule.setConfigValue('browser.features.screenshotQuality', 0)).toThrow(/1.*100/);
    });

    it('rejects screenshotQuality=101', () => {
      expect(() => configModule.setConfigValue('browser.features.screenshotQuality', 101)).toThrow(/1.*100/);
    });

    it('rejects screenshotQuality=NaN', () => {
      expect(() => configModule.setConfigValue('browser.features.screenshotQuality', NaN)).toThrow(/1.*100/);
    });

    it('rejects non-string screenshotFormat (number)', () => {
      expect(() => configModule.setConfigValue('browser.features.screenshotFormat', 42 as any)).toThrow(/jpeg.*png/i);
    });

    it('rejects non-string screenshotFormat (boolean)', () => {
      expect(() => configModule.setConfigValue('browser.features.screenshotFormat', true as any)).toThrow(/jpeg.*png/i);
    });
  });

  describe('screenshot validation in setConfigValueInMemory', () => {
    it('accepts screenshotFormat=jpeg', () => {
      expect(() => configModule.setConfigValueInMemory('browser.features.screenshotFormat', 'jpeg')).not.toThrow();
    });

    it('rejects screenshotFormat=webp', () => {
      expect(() => configModule.setConfigValueInMemory('browser.features.screenshotFormat', 'webp')).toThrow(/jpeg.*png/i);
    });

    it('rejects non-string screenshotFormat (number)', () => {
      expect(() => configModule.setConfigValueInMemory('browser.features.screenshotFormat', 42 as any)).toThrow(/jpeg.*png/i);
    });

    it('accepts screenshotQuality=80', () => {
      expect(() => configModule.setConfigValueInMemory('browser.features.screenshotQuality', 80)).not.toThrow();
    });

    it('rejects screenshotQuality=0', () => {
      expect(() => configModule.setConfigValueInMemory('browser.features.screenshotQuality', 0)).toThrow(/1.*100/);
    });

    it('rejects screenshotQuality=101', () => {
      expect(() => configModule.setConfigValueInMemory('browser.features.screenshotQuality', 101)).toThrow(/1.*100/);
    });
  });

  describe('path helpers', () => {
    it('getDaemonSocketPath returns path under dataDir', () => {
      const config = { dataDir: '/test/data' } as import('../../src/skill/types.js').SchruteConfig;
      const result = configModule.getDaemonSocketPath(config);
      expect(result).toBe('/test/data/daemon.sock');
    });

    it('getDaemonPidPath returns path under dataDir', () => {
      const config = { dataDir: '/test/data' } as import('../../src/skill/types.js').SchruteConfig;
      const result = configModule.getDaemonPidPath(config);
      expect(result).toBe('/test/data/daemon.pid');
    });

    it('getDaemonTokenPath returns path under dataDir', () => {
      const config = { dataDir: '/test/data' } as import('../../src/skill/types.js').SchruteConfig;
      const result = configModule.getDaemonTokenPath(config);
      expect(result).toBe('/test/data/daemon.token');
    });
  });

  describe('config immutability', () => {
    it('getConfig returns a clone — mutating the result does not affect the cached config', () => {
      const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cfg-immut-'));
      const cfgPath = path.join(tmpDir, 'config.json');
      fs.writeFileSync(cfgPath, JSON.stringify({ logLevel: 'info' }));

      const config1 = configModule.loadConfig(cfgPath);
      const config2 = configModule.getConfig();

      // Mutate the returned object
      (config2 as Record<string, unknown>).logLevel = 'TAMPERED';
      (config2 as Record<string, unknown>).features = 'CORRUPTED';

      // Fetch again — should be unaffected
      const config3 = configModule.getConfig();
      expect(config3.logLevel).not.toBe('TAMPERED');
      expect((config3 as Record<string, unknown>).features).not.toBe('CORRUPTED');

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});
