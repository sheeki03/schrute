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

const SCHRUTE_ENV_KEYS = [
  'SCHRUTE_DATA_DIR',
  'SCHRUTE_LOG_LEVEL',
  'SCHRUTE_AUTH_TOKEN',
  'SCHRUTE_NETWORK',
  'SCHRUTE_HTTP_TRANSPORT',
  'SCHRUTE_HTTP_PORT',
  'SCHRUTE_BROWSER_ENGINE',
  'SCHRUTE_SNAPSHOT_MODE',
  'SCHRUTE_INCREMENTAL_DIFFS',
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  // Save current SCHRUTE_* env vars (including global-setup's SCHRUTE_DATA_DIR)
  savedEnv = {};
  for (const key of SCHRUTE_ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }

  vi.resetModules();
  vi.mock('../../src/core/logger.js', () => ({
    getLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  }));
  // Clean env vars before each test
  for (const key of SCHRUTE_ENV_KEYS) {
    delete process.env[key];
  }

  configModule = await import('../../src/core/config.js');
  configModule.resetConfigCache();
});

afterEach(() => {
  // Restore saved env vars (preserves global-setup's SCHRUTE_DATA_DIR)
  for (const key of SCHRUTE_ENV_KEYS) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key];
    } else {
      delete process.env[key];
    }
  }
});

describe('config env overrides', () => {
  describe('SCHRUTE_DATA_DIR', () => {
    it('overrides dataDir', () => {
      process.env.SCHRUTE_DATA_DIR = '/custom/data';
      const config = configModule.getConfig();
      expect(config.dataDir).toBe('/custom/data');
    });
  });

  describe('SCHRUTE_LOG_LEVEL', () => {
    it('overrides logLevel', () => {
      process.env.SCHRUTE_LOG_LEVEL = 'debug';
      const config = configModule.getConfig();
      expect(config.logLevel).toBe('debug');
    });
  });

  describe('SCHRUTE_NETWORK', () => {
    it('accepts "true"', () => {
      process.env.SCHRUTE_NETWORK = 'true';
      const config = configModule.getConfig();
      expect(config.server.network).toBe(true);
    });

    it('accepts "false"', () => {
      process.env.SCHRUTE_NETWORK = 'false';
      const config = configModule.getConfig();
      expect(config.server.network).toBe(false);
    });

    it('rejects "1" with strict parse error', () => {
      process.env.SCHRUTE_NETWORK = '1';
      expect(() => configModule.getConfig()).toThrow(configModule.ConfigError);
      expect(() => configModule.getConfig()).toThrow(/Invalid boolean value/);
    });

    it('rejects "0" with strict parse error', () => {
      process.env.SCHRUTE_NETWORK = '0';
      expect(() => configModule.getConfig()).toThrow(configModule.ConfigError);
      expect(() => configModule.getConfig()).toThrow(/Invalid boolean value/);
    });

    it('rejects "yes" with strict parse error', () => {
      process.env.SCHRUTE_NETWORK = 'yes';
      expect(() => configModule.getConfig()).toThrow(configModule.ConfigError);
      expect(() => configModule.getConfig()).toThrow(/Invalid boolean value/);
    });

    it('rejects "on" with strict parse error', () => {
      process.env.SCHRUTE_NETWORK = 'on';
      expect(() => configModule.getConfig()).toThrow(configModule.ConfigError);
    });
  });

  describe('SCHRUTE_BROWSER_ENGINE', () => {
    it('accepts valid engine values', () => {
      for (const engine of ['playwright', 'patchright', 'camoufox']) {
        process.env.SCHRUTE_BROWSER_ENGINE = engine;
        configModule.resetConfigCache();
        const config = configModule.getConfig();
        expect(config.browser?.engine).toBe(engine);
      }
    });

    it('rejects invalid engine values', () => {
      process.env.SCHRUTE_BROWSER_ENGINE = 'selenium';
      configModule.resetConfigCache();
      expect(() => configModule.getConfig()).toThrow(configModule.ConfigError);
    });
  });

  describe('SCHRUTE_HTTP_PORT', () => {
    it('accepts valid port number', () => {
      process.env.SCHRUTE_HTTP_PORT = '8080';
      const config = configModule.getConfig();
      expect(config.server.httpPort).toBe(8080);
    });

    it('rejects non-integer', () => {
      process.env.SCHRUTE_HTTP_PORT = 'abc';
      expect(() => configModule.getConfig()).toThrow(configModule.ConfigError);
      expect(() => configModule.getConfig()).toThrow(/Invalid port value/);
    });

    it('rejects port 0', () => {
      process.env.SCHRUTE_HTTP_PORT = '0';
      expect(() => configModule.getConfig()).toThrow(configModule.ConfigError);
    });

    it('rejects port > 65535', () => {
      process.env.SCHRUTE_HTTP_PORT = '70000';
      expect(() => configModule.getConfig()).toThrow(configModule.ConfigError);
    });

    it('rejects float', () => {
      process.env.SCHRUTE_HTTP_PORT = '3000.5';
      expect(() => configModule.getConfig()).toThrow(configModule.ConfigError);
    });
  });

  describe('missing env var', () => {
    it('leaves config unchanged when env var is not set', () => {
      // Use loadConfig with nonexistent path to get clean defaults (avoids real ~/.schrute/config.json)
      const config = configModule.loadConfig('/nonexistent/path/config.json');
      expect(config.server.network).toBe(false);
      expect(config.logLevel).toBe('info');
    });
  });

  describe('env overlay isolation', () => {
    it('env overrides do not persist to disk via setConfigValue', () => {
      process.env.SCHRUTE_AUTH_TOKEN = 'env-secret';

      const tmpDir = `/tmp/schrute-env-test-${Date.now()}`;
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmpPath = path.join(tmpDir, 'config.json');
      fs.writeFileSync(tmpPath, JSON.stringify({ logLevel: 'info' }), 'utf-8');

      try {
        // getConfig should apply env overlay
        const config = configModule.getConfig();
        expect(config.server.authToken).toBe('env-secret');

        // setConfigValue should save to disk WITHOUT env values
        configModule.setConfigValue('logLevel', 'debug');

        // Read the file directly — should NOT contain authToken
        const raw = fs.readFileSync(
          path.join(config.dataDir, 'config.json'),
          'utf-8',
        ).toString();

        // The saved config should NOT contain env-secret
        expect(raw).not.toContain('env-secret');
      } finally {
        // Cleanup
        try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
      }
    });
  });

  describe('ConfigError', () => {
    it('is an instance of Error', () => {
      const err = new configModule.ConfigError('test');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('ConfigError');
      expect(err.message).toBe('test');
    });
  });
});
