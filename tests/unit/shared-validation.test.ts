import { describe, it, expect, vi } from 'vitest';

// ─── Mock dependencies required by shared-validation.ts ─────────
vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

const { mockSetSitePolicy } = vi.hoisted(() => {
  const mockSetSitePolicy = vi.fn();
  return { mockSetSitePolicy };
});

vi.mock('../../src/core/policy.js', () => ({
  setSitePolicy: mockSetSitePolicy,
  sanitizeImplicitAllowlist: vi.fn((domains: string[]) => domains),
}));

// parseDomainEntries is not exported, so we test it indirectly through setupCdpSitePolicy
// validateProxyConfig and validateGeoConfig are exported directly

import {
  setupCdpSitePolicy,
  validateProxyConfig,
  validateGeoConfig,
} from '../../src/server/shared-validation.js';

// ─── parseDomainEntries (tested via setupCdpSitePolicy) ─────────

describe('setupCdpSitePolicy (parseDomainEntries)', () => {
  it('accepts valid domain entries', () => {
    expect(() => setupCdpSitePolicy('test-site', ['example.com', 'api.example.com'])).not.toThrow();
    expect(mockSetSitePolicy).toHaveBeenCalled();
  });

  it('normalizes IPv6 addresses (wraps in brackets)', () => {
    expect(() => setupCdpSitePolicy('test-site', ['::1'])).not.toThrow();
  });

  it('rejects URL-like entries (path, query, fragment, credentials, whitespace)', () => {
    expect(() => setupCdpSitePolicy('test-site', ['example.com/path'])).toThrow(/must be a host/);
    expect(() => setupCdpSitePolicy('test-site', ['example.com?q=1'])).toThrow(/must be a host/);
    expect(() => setupCdpSitePolicy('test-site', ['example.com#frag'])).toThrow(/must be a host/);
    expect(() => setupCdpSitePolicy('test-site', ['user@example.com'])).toThrow(/must be a host/);
    expect(() => setupCdpSitePolicy('test-site', ['example .com'])).toThrow(/must be a host/);
  });
});

// ─── validateProxyConfig ─────────────────────────────────────────

describe('validateProxyConfig', () => {
  it('accepts a valid proxy config', () => {
    const result = validateProxyConfig({ server: 'http://proxy.example.com:8080' });
    expect(result.server).toBe('http://proxy.example.com:8080');
  });

  it('accepts proxy with separate username/password fields', () => {
    const result = validateProxyConfig({
      server: 'http://proxy.example.com:8080',
      username: 'user',
      password: 'pass',
    });
    expect(result.username).toBe('user');
    expect(result.password).toBe('pass');
  });

  it('accepts socks5 proxy', () => {
    const result = validateProxyConfig({ server: 'socks5://proxy.example.com:1080' });
    expect(result.server).toBe('socks5://proxy.example.com:1080');
  });

  it('rejects missing server', () => {
    expect(() => validateProxyConfig({})).toThrow(/proxy\.server is required/);
  });

  it('rejects non-string server', () => {
    expect(() => validateProxyConfig({ server: 123 })).toThrow(/proxy\.server is required/);
  });

  it('rejects credentials embedded in URL', () => {
    expect(() => validateProxyConfig({ server: 'http://user:pass@proxy.example.com:8080' })).toThrow(
      /no path, query, fragment, or credentials/,
    );
  });

  it('rejects unsupported protocol', () => {
    expect(() => validateProxyConfig({ server: 'ftp://proxy.example.com' })).toThrow(
      /must use http:\/\/, https:\/\/, socks4:\/\/, or socks5:\/\//,
    );
  });

  it('rejects server with path', () => {
    expect(() => validateProxyConfig({ server: 'http://proxy.example.com:8080/some/path' })).toThrow(
      /host-only/,
    );
  });

  it('rejects non-string bypass', () => {
    expect(() => validateProxyConfig({ server: 'http://proxy.example.com:8080', bypass: 123 })).toThrow(
      /proxy\.bypass must be a string/,
    );
  });
});

// ─── validateGeoConfig ───────────────────────────────────────────

describe('validateGeoConfig', () => {
  it('returns a valid geo config with geolocation', () => {
    const result = validateGeoConfig({
      geolocation: { latitude: 37.7749, longitude: -122.4194 },
    });
    expect(result).toBeDefined();
    expect(result!.geolocation!.latitude).toBe(37.7749);
    expect(result!.geolocation!.longitude).toBe(-122.4194);
  });

  it('returns undefined when no fields are set', () => {
    expect(validateGeoConfig({})).toBeUndefined();
  });

  it('rejects out-of-range latitude', () => {
    expect(() => validateGeoConfig({
      geolocation: { latitude: 91, longitude: 0 },
    })).toThrow(/latitude must be between -90 and 90/);

    expect(() => validateGeoConfig({
      geolocation: { latitude: -91, longitude: 0 },
    })).toThrow(/latitude must be between -90 and 90/);
  });

  it('rejects out-of-range longitude', () => {
    expect(() => validateGeoConfig({
      geolocation: { latitude: 0, longitude: 181 },
    })).toThrow(/longitude must be between -180 and 180/);

    expect(() => validateGeoConfig({
      geolocation: { latitude: 0, longitude: -181 },
    })).toThrow(/longitude must be between -180 and 180/);
  });

  it('rejects invalid timezoneId', () => {
    expect(() => validateGeoConfig({
      timezoneId: 'Not/A/Real/Timezone',
    })).toThrow(/invalid timezoneId/);
  });

  it('accepts valid timezoneId', () => {
    const result = validateGeoConfig({ timezoneId: 'America/New_York' });
    expect(result!.timezoneId).toBe('America/New_York');
  });

  it('accepts valid locale', () => {
    const result = validateGeoConfig({ locale: 'en-US' });
    expect(result!.locale).toBe('en-US');
  });

  it('rejects non-object geolocation', () => {
    expect(() => validateGeoConfig({ geolocation: 'not-an-object' })).toThrow(
      /geo\.geolocation must be an object/,
    );
  });

  it('rejects non-numeric coordinates', () => {
    expect(() => validateGeoConfig({
      geolocation: { latitude: 'north', longitude: 0 },
    })).toThrow(/numeric latitude and longitude/);
  });
});
