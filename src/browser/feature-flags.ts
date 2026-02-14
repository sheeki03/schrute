import type { OneAgentConfig } from '../skill/types.js';

// ─── Browser Feature Flags ──────────────────────────────────────
// Runtime kill switches per phase — disable any feature without code changes.

export interface BrowserFeatureFlags {
  snapshotMode: 'annotated' | 'full' | 'none';
  incrementalDiffs: boolean;
  modalTracking: boolean;
  screenshotResize: boolean;
  batchActions: boolean;
}

export const DEFAULT_FLAGS: BrowserFeatureFlags = {
  snapshotMode: 'annotated',
  incrementalDiffs: true,
  modalTracking: true,
  screenshotResize: true,
  batchActions: true,
};

export const VALID_SNAPSHOT_MODES = new Set<string>(['annotated', 'full', 'none']);

/**
 * Resolve feature flags from config with validation.
 * Merge order: DEFAULT_FLAGS → config file → env overrides
 * (env is already baked into config by loadConfig() + applyEnvOverrides())
 */
export function getFlags(config: OneAgentConfig): BrowserFeatureFlags {
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
  const boolFlags = ['incrementalDiffs', 'modalTracking', 'screenshotResize', 'batchActions'] as const;
  for (const key of boolFlags) {
    if (typeof merged[key] !== 'boolean') {
      throw new Error(
        `browser.features.${key} must be a boolean, got ${typeof merged[key]}.`,
      );
    }
  }

  return merged;
}
