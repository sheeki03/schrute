import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────

vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock fs so loadConfig and saveConfig don't touch the real filesystem
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import * as fs from 'node:fs';
import {
  loadConfig,
  resetConfigCache,
  getConfig,
  setConfigValue,
  ConfigError,
} from '../../src/core/config.js';

// ─── Helpers ────────────────────────────────────────────────────

const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string): void {
  if (!(key in savedEnv)) {
    savedEnv[key] = process.env[key];
  }
  process.env[key] = value;
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  // Clear saved entries
  for (const key of Object.keys(savedEnv)) {
    delete savedEnv[key];
  }
}

// ─── Tests ──────────────────────────────────────────────────────

describe('proxy/geo config validation', () => {
  beforeEach(() => {
    resetConfigCache();
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  afterEach(() => {
    restoreEnv();
    resetConfigCache();
  });

  // ─── Proxy Server Formats ──────────────────────────────────

  describe('valid proxy server formats', () => {
    it.each([
      'http://proxy.example.com:8080',
      'https://proxy.example.com:443',
      'socks4://proxy.example.com:1080',
      'socks5://proxy.example.com:1080',
    ])('accepts %s', (server) => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ browser: { proxy: { server } } }),
      );
      expect(() => loadConfig()).not.toThrow();
    });
  });

  describe('invalid proxy server formats', () => {
    it('rejects proxy server without protocol', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ browser: { proxy: { server: 'proxy.example.com:8080' } } }),
      );
      expect(() => loadConfig()).toThrow(/proxy/i);
    });

    it('rejects empty string proxy server', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ browser: { proxy: { server: '' } } }),
      );
      expect(() => loadConfig()).toThrow(/proxy/i);
    });

    it('rejects proxy server with path components', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ browser: { proxy: { server: 'http://proxy.example.com/some/path' } } }),
      );
      expect(() => loadConfig()).toThrow(/proxy/i);
    });

    it('rejects proxy server with URL userinfo (credentials in URL)', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ browser: { proxy: { server: 'http://user:pass@proxy.example.com:8080' } } }),
      );
      expect(() => loadConfig()).toThrow(/proxy/i);
    });
  });

  // ─── Geolocation ───────────────────────────────────────────

  describe('geolocation validation', () => {
    it('rejects latitude out of range (> 90)', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          browser: { geo: { geolocation: { latitude: 91, longitude: 0 } } },
        }),
      );
      expect(() => loadConfig()).toThrow(/latitude/i);
    });

    it('rejects latitude out of range (< -90)', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          browser: { geo: { geolocation: { latitude: -91, longitude: 0 } } },
        }),
      );
      expect(() => loadConfig()).toThrow(/latitude/i);
    });

    it('rejects longitude out of range (> 180)', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          browser: { geo: { geolocation: { latitude: 0, longitude: 181 } } },
        }),
      );
      expect(() => loadConfig()).toThrow(/longitude/i);
    });

    it('rejects longitude out of range (< -180)', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          browser: { geo: { geolocation: { latitude: 0, longitude: -181 } } },
        }),
      );
      expect(() => loadConfig()).toThrow(/longitude/i);
    });

    it('accepts valid geolocation', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          browser: { geo: { geolocation: { latitude: 40.7128, longitude: -74.006 } } },
        }),
      );
      expect(() => loadConfig()).not.toThrow();
    });
  });

  // ─── Timezone ──────────────────────────────────────────────

  describe('timezone validation', () => {
    it.each(['America/New_York', 'Europe/London', 'UTC', 'Etc/UTC'])(
      'accepts valid timezoneId: %s',
      (tz) => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(
          JSON.stringify({ browser: { geo: { timezoneId: tz } } }),
        );
        expect(() => loadConfig()).not.toThrow();
      },
    );

    it('rejects invalid timezoneId', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ browser: { geo: { timezoneId: 'Mars/Olympus' } } }),
      );
      expect(() => loadConfig()).toThrow(/timezone/i);
    });
  });

  // ─── Locale ────────────────────────────────────────────────

  describe('locale validation', () => {
    it.each(['en-US', 'fr-FR', 'ja-JP'])('accepts valid locale: %s', (locale) => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ browser: { geo: { locale } } }),
      );
      expect(() => loadConfig()).not.toThrow();
    });

    it('rejects empty string locale', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ browser: { geo: { locale: '' } } }),
      );
      expect(() => loadConfig()).toThrow(/locale/i);
    });

    it('rejects numeric locale', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ browser: { geo: { locale: '123' } } }),
      );
      expect(() => loadConfig()).toThrow(/locale/i);
    });
  });

  // ─── Strict Float Parsing (env vars) ───────────────────────

  describe('strict float parsing for env vars', () => {
    it('rejects "12abc" for latitude', () => {
      setEnv('ONEAGENT_GEO_LATITUDE', '12abc');
      expect(() => {
        resetConfigCache();
        getConfig();
      }).toThrow(ConfigError);
    });

    it('accepts "12.5" for latitude', () => {
      setEnv('ONEAGENT_GEO_LATITUDE', '12.5');
      expect(() => {
        resetConfigCache();
        getConfig();
      }).not.toThrow();
    });

    it('empty string for latitude parses to 0 (Number("") === 0)', () => {
      // Number('') === 0, which is a valid finite number in [-90,90]
      // so the float parser accepts it — this matches JavaScript semantics
      setEnv('ONEAGENT_GEO_LATITUDE', '');
      resetConfigCache();
      const cfg = getConfig();
      expect(cfg.browser?.geo?.geolocation?.latitude).toBe(0);
    });
  });

  // ─── Env Var Overrides ─────────────────────────────────────

  describe('env var overrides', () => {
    it('ONEAGENT_PROXY_SERVER overrides config', () => {
      setEnv('ONEAGENT_PROXY_SERVER', 'socks5://myproxy:1080');
      resetConfigCache();
      const cfg = getConfig();
      expect(cfg.browser?.proxy?.server).toBe('socks5://myproxy:1080');
    });

    it('ONEAGENT_TIMEZONE overrides config', () => {
      setEnv('ONEAGENT_TIMEZONE', 'Asia/Tokyo');
      resetConfigCache();
      const cfg = getConfig();
      expect(cfg.browser?.geo?.timezoneId).toBe('Asia/Tokyo');
    });

    it('ONEAGENT_LOCALE overrides config', () => {
      setEnv('ONEAGENT_LOCALE', 'de-DE');
      resetConfigCache();
      const cfg = getConfig();
      expect(cfg.browser?.geo?.locale).toBe('de-DE');
    });

    it('invalid ONEAGENT_PROXY_SERVER fails fast with ConfigError', () => {
      setEnv('ONEAGENT_PROXY_SERVER', 'not-a-url');
      expect(() => {
        resetConfigCache();
        getConfig();
      }).toThrow(ConfigError);
    });

    it('invalid ONEAGENT_TIMEZONE fails fast with ConfigError', () => {
      setEnv('ONEAGENT_TIMEZONE', 'Mars/Olympus');
      expect(() => {
        resetConfigCache();
        getConfig();
      }).toThrow(ConfigError);
    });

    it('invalid ONEAGENT_LOCALE fails fast with ConfigError', () => {
      setEnv('ONEAGENT_LOCALE', '');
      expect(() => {
        resetConfigCache();
        getConfig();
      }).toThrow(ConfigError);
    });
  });

  // ─── Config File with proxy/geo ────────────────────────────

  describe('config file with proxy/geo loads correctly', () => {
    it('loads proxy and geo from config file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          browser: {
            proxy: { server: 'http://proxy.example.com:8080', bypass: '*.local' },
            geo: {
              geolocation: { latitude: 48.8566, longitude: 2.3522 },
              timezoneId: 'Europe/Paris',
              locale: 'fr-FR',
            },
          },
        }),
      );

      const cfg = loadConfig();
      expect(cfg.browser?.proxy?.server).toBe('http://proxy.example.com:8080');
      expect(cfg.browser?.proxy?.bypass).toBe('*.local');
      expect(cfg.browser?.geo?.geolocation?.latitude).toBe(48.8566);
      expect(cfg.browser?.geo?.geolocation?.longitude).toBe(2.3522);
      expect(cfg.browser?.geo?.timezoneId).toBe('Europe/Paris');
      expect(cfg.browser?.geo?.locale).toBe('fr-FR');
    });
  });

  // ─── setConfigValue validates proxy/geo ────────────────────

  describe('setConfigValue validates proxy/geo fields', () => {
    it('rejects invalid proxy server via setConfigValue', () => {
      expect(() => setConfigValue('browser.proxy.server', 'not-a-url')).toThrow();
    });

    it('rejects out-of-range latitude via setConfigValue', () => {
      expect(() => setConfigValue('browser.geo.geolocation.latitude', 100)).toThrow(/latitude/i);
    });

    it('rejects out-of-может longitude via setConfigValue', () => {
      expect(() => setConfigValue('browser.geo.geolocation.longitude', 200)).toThrow(/longitude/i);
    });

    it('rejects invalid timezone via setConfigValue', () => {
      expect(() => setConfigValue('browser.geo.timezoneId', 'Mars/Olympus')).toThrow(/timezone/i);
    });

    it('rejects invalid locale via setConfigValue', () => {
      expect(() => setConfigValue('browser.geo.locale', '')).toThrow(/locale/i);
    });

    it('accepts valid proxy server via setConfigValue', () => {
      expect(() => setConfigValue('browser.proxy.server', 'http://proxy:8080')).not.toThrow();
    });
  });
});
