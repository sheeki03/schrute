import type { SchruteConfig } from '../skill/types.js';

// ─── Browser Feature Flags ──────────────────────────────────────
// Runtime kill switches per phase — disable any feature without code changes.

export interface BrowserFeatureFlags {
  snapshotMode: 'annotated' | 'full' | 'none';
  incrementalDiffs: boolean;
  modalTracking: boolean;
  screenshotResize: boolean;
  batchActions: boolean;
  screenshotFormat: 'jpeg' | 'png';
  screenshotQuality: number;
  fingerprintProfile: boolean;
  referrerSpoofing: boolean;
  humanCursor: boolean;
  assetBlocking: boolean;
}

export const DEFAULT_FLAGS: BrowserFeatureFlags = {
  snapshotMode: 'annotated',
  incrementalDiffs: true,
  modalTracking: true,
  screenshotResize: true,
  batchActions: true,
  screenshotFormat: 'jpeg',
  screenshotQuality: 80,
  fingerprintProfile: false,
  referrerSpoofing: false,
  humanCursor: false,
  assetBlocking: false,
};

export const VALID_SNAPSHOT_MODES = new Set<string>(['annotated', 'full', 'none']);

/**
 * Resolve feature flags from config with validation.
 * Merge order: DEFAULT_FLAGS → config file → env overrides
 * (env is already baked into config by loadConfig() + applyEnvOverrides())
 */
export function getFlags(config: SchruteConfig): BrowserFeatureFlags {
  const overrides = config.browser?.features;
  if (!overrides) return { ...DEFAULT_FLAGS };

  const merged = { ...DEFAULT_FLAGS, ...overrides };

  // Validate snapshotMode
  if (!VALID_SNAPSHOT_MODES.has(merged.snapshotMode)) {
    throw new Error(
      `Invalid browser.features.snapshotMode: "${merged.snapshotMode}". ` +
      `Must be one of: ${[...VALID_SNAPSHOT_MODES].join(', ')}.`,
    );
  }

  // Validate boolean flags — reject non-boolean types (prevents "false" string truthy coercion)
  const boolFlags = ['incrementalDiffs', 'modalTracking', 'screenshotResize', 'batchActions', 'fingerprintProfile', 'referrerSpoofing', 'humanCursor', 'assetBlocking'] as const;
  for (const key of boolFlags) {
    if (typeof merged[key] !== 'boolean') {
      throw new Error(
        `browser.features.${key} must be a boolean, got ${typeof merged[key]}.`,
      );
    }
  }

  // Validate screenshotFormat
  const validFormats = new Set(['jpeg', 'png']);
  if (!validFormats.has(merged.screenshotFormat)) {
    throw new Error(
      `Invalid browser.features.screenshotFormat: "${merged.screenshotFormat}". Must be 'jpeg' or 'png'.`,
    );
  }

  // Validate screenshotQuality
  if (typeof merged.screenshotQuality !== 'number' || !Number.isFinite(merged.screenshotQuality)) {
    throw new Error(
      `browser.features.screenshotQuality must be a finite number, got ${typeof merged.screenshotQuality}.`,
    );
  }
  if (merged.screenshotQuality < 1 || merged.screenshotQuality > 100) {
    throw new Error(
      `browser.features.screenshotQuality must be a number between 1 and 100, got ${merged.screenshotQuality}.`,
    );
  }

  return merged;
}
