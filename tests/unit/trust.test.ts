import { describe, it, expect } from 'vitest';
import { formatTrustReport, type TrustPosture } from '../../src/trust.js';

function makePosture(overrides: Partial<TrustPosture> = {}): TrustPosture {
  return {
    network: {
      transport: 'local-only (MCP stdio)',
      allowedHosts: 3,
      publicIpsOnly: true,
    },
    secrets: {
      keychainOk: true,
      storedSessions: 2,
      exportExcludesCreds: true,
    },
    redaction: {
      lastScanClean: true,
      violations: 0,
    },
    skills: {
      active: 10,
      stale: 2,
      locked: 1,
      broken: 0,
    },
    retention: {
      usedMb: 125.5,
      globalCapMb: 5000,
      oldestFrameDays: 30,
    },
    ...overrides,
  };
}

describe('trust', () => {
  describe('formatTrustReport', () => {
    it('generates network line with transport and host info', () => {
      const posture = makePosture();
      const report = formatTrustReport(posture);
      expect(report).toContain('Network:');
      expect(report).toContain('local-only (MCP stdio)');
      expect(report).toContain('3 allowed hosts');
      expect(report).toContain('allow-only-public IPs');
    });

    it('warns when non-public IPs are allowed', () => {
      const posture = makePosture({
        network: { transport: 'network (HTTP)', allowedHosts: 5, publicIpsOnly: false },
      });
      const report = formatTrustReport(posture);
      expect(report).toContain('WARNING: non-public IPs allowed');
    });

    it('generates secrets line with keychain status', () => {
      const posture = makePosture();
      const report = formatTrustReport(posture);
      expect(report).toContain('Secrets:');
      expect(report).toContain('keychain OK');
      expect(report).toContain('2 stored sessions');
      expect(report).toContain('excludes');
    });

    it('reports keychain unavailable', () => {
      const posture = makePosture({
        secrets: { keychainOk: false, storedSessions: 0, exportExcludesCreds: true },
      });
      const report = formatTrustReport(posture);
      expect(report).toContain('keychain UNAVAILABLE');
    });

    it('generates redaction line', () => {
      const posture = makePosture({
        redaction: { lastScanClean: false, violations: 5 },
      });
      const report = formatTrustReport(posture);
      expect(report).toContain('Redaction:');
      expect(report).toContain('DIRTY');
      expect(report).toContain('5 violations');
    });

    it('generates skills line with all categories', () => {
      const posture = makePosture();
      const report = formatTrustReport(posture);
      expect(report).toContain('Skills:');
      expect(report).toContain('10 active');
      expect(report).toContain('2 stale');
      expect(report).toContain('1 locked');
      expect(report).toContain('0 broken');
    });

    it('generates retention line with oldest frame', () => {
      const posture = makePosture();
      const report = formatTrustReport(posture);
      expect(report).toContain('Retention:');
      expect(report).toContain('125.5MB');
      expect(report).toContain('5GB global cap');
      expect(report).toContain('30 days');
    });

    it('shows "none" when no oldest frame exists', () => {
      const posture = makePosture({
        retention: { usedMb: 0, globalCapMb: 5000, oldestFrameDays: null },
      });
      const report = formatTrustReport(posture);
      expect(report).toContain('oldest frame: none');
    });
  });
});
