import { describe, it, expect } from 'vitest';
import { getFlags, DEFAULT_FLAGS } from '../../src/browser/feature-flags.js';
import type { SchruteConfig } from '../../src/skill/types.js';

function makeConfig(browserFeatures?: Record<string, unknown>): SchruteConfig {
  return {
    dataDir: '/tmp/schrute-ff-test',
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
    ...(browserFeatures ? { browser: { features: browserFeatures } } : {}),
  } as SchruteConfig;
}

describe('getFlags (BrowserFeatureFlags)', () => {
  it('returns default flags when no overrides', () => {
    const flags = getFlags(makeConfig());
    expect(flags).toEqual(DEFAULT_FLAGS);
  });

  it('merges valid overrides', () => {
    const flags = getFlags(makeConfig({
      snapshotMode: 'full',
      screenshotFormat: 'png',
      screenshotQuality: 95,
      batchActions: false,
    }));
    expect(flags.snapshotMode).toBe('full');
    expect(flags.screenshotFormat).toBe('png');
    expect(flags.screenshotQuality).toBe(95);
    expect(flags.batchActions).toBe(false);
    // Unset flags retain defaults
    expect(flags.incrementalDiffs).toBe(true);
    expect(flags.modalTracking).toBe(true);
  });

  // ─── Invalid snapshotMode ─────────────────────────────────────
  it('rejects invalid snapshotMode', () => {
    expect(() => getFlags(makeConfig({ snapshotMode: 'turbo' }))).toThrow(
      /Invalid browser\.features\.snapshotMode/,
    );
  });

  // ─── Invalid screenshotFormat ─────────────────────────────────
  it('rejects invalid screenshotFormat', () => {
    expect(() => getFlags(makeConfig({ screenshotFormat: 'gif' }))).toThrow(
      /Invalid browser\.features\.screenshotFormat/,
    );
  });

  // ─── Invalid screenshotQuality ────────────────────────────────
  it('rejects non-finite screenshotQuality', () => {
    expect(() => getFlags(makeConfig({ screenshotQuality: NaN }))).toThrow(
      /screenshotQuality must be a finite number/,
    );
  });

  it('rejects screenshotQuality out of range (below 1)', () => {
    expect(() => getFlags(makeConfig({ screenshotQuality: 0 }))).toThrow(
      /between 1 and 100/,
    );
  });

  it('rejects screenshotQuality out of range (above 100)', () => {
    expect(() => getFlags(makeConfig({ screenshotQuality: 101 }))).toThrow(
      /between 1 and 100/,
    );
  });

  // ─── Non-boolean boolean flags ────────────────────────────────
  it('rejects non-boolean batchActions', () => {
    expect(() => getFlags(makeConfig({ batchActions: 'yes' }))).toThrow(
      /batchActions must be a boolean/,
    );
  });

  it('rejects non-boolean incrementalDiffs', () => {
    expect(() => getFlags(makeConfig({ incrementalDiffs: 1 }))).toThrow(
      /incrementalDiffs must be a boolean/,
    );
  });

  it('rejects "false" string as boolean (truthy coercion prevention)', () => {
    expect(() => getFlags(makeConfig({ modalTracking: 'false' }))).toThrow(
      /modalTracking must be a boolean/,
    );
  });
});
