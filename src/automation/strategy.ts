import { getLogger } from '../core/logger.js';
import type { ExecutionTierName } from '../skill/types.js';
import { ExecutionTier } from '../skill/types.js';

const log = getLogger();

// ─── Types ────────────────────────────────────────────────────────

export interface SiteStrategy {
  defaultTier: ExecutionTierName;
  overrides: Record<string, ExecutionTierName>;
}

export interface StrategyObservation {
  skillId: string;
  tier: ExecutionTierName;
  success: boolean;
  latencyMs: number;
  failureCause?: string;
}

// ─── In-Memory Strategy Store ───────────────────────────────────

const MAX_STRATEGY_CACHE_SIZE = 500;

const strategies = new Map<string, SiteStrategy>();

const tierSuccessCounts = new Map<string, Map<ExecutionTierName, { success: number; total: number }>>();

/** Evict oldest entry (FIFO) if the map exceeds MAX_STRATEGY_CACHE_SIZE. */
function evictIfNeeded<K, V>(map: Map<K, V>): void {
  if (map.size > MAX_STRATEGY_CACHE_SIZE) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) {
      map.delete(oldest);
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────

export function getStrategy(siteId: string): SiteStrategy {
  const existing = strategies.get(siteId);
  if (existing) return existing;

  const defaultStrategy: SiteStrategy = {
    defaultTier: ExecutionTier.BROWSER_PROXIED,
    overrides: {},
  };
  strategies.set(siteId, defaultStrategy);
  evictIfNeeded(strategies);
  return defaultStrategy;
}

export function updateStrategy(
  siteId: string,
  observation: StrategyObservation,
): void {
  const strategy = getStrategy(siteId);

  // Track success rates per tier for this site
  if (!tierSuccessCounts.has(siteId)) {
    tierSuccessCounts.set(siteId, new Map());
    evictIfNeeded(tierSuccessCounts);
  }
  const siteCounts = tierSuccessCounts.get(siteId)!;

  if (!siteCounts.has(observation.tier)) {
    siteCounts.set(observation.tier, { success: 0, total: 0 });
  }
  const counts = siteCounts.get(observation.tier)!;
  counts.total++;
  if (observation.success) counts.success++;

  // Promote skill to lower tier if consistently succeeding at direct fetch
  if (
    observation.tier === ExecutionTier.DIRECT &&
    observation.success &&
    counts.success >= 3 &&
    counts.success / counts.total >= 0.8
  ) {
    strategy.overrides[observation.skillId] = ExecutionTier.DIRECT;
    log.debug(
      { siteId, skillId: observation.skillId },
      'Skill promoted to direct tier based on success pattern',
    );
  }

  // Demote skill if failing at current tier
  if (
    observation.tier === ExecutionTier.DIRECT &&
    !observation.success &&
    counts.total >= 3 &&
    counts.success / counts.total < 0.5
  ) {
    strategy.overrides[observation.skillId] = ExecutionTier.BROWSER_PROXIED;
    log.debug(
      { siteId, skillId: observation.skillId },
      'Skill demoted to browser-proxied tier based on failure pattern',
    );
  }

  // Update default tier if enough evidence
  const allTierEntries = Array.from(siteCounts.entries());
  const bestTier = allTierEntries
    .filter(([, c]) => c.total >= 5)
    .sort((a, b) => (b[1].success / b[1].total) - (a[1].success / a[1].total))
    [0];

  if (bestTier && bestTier[1].success / bestTier[1].total >= 0.8) {
    strategy.defaultTier = bestTier[0];
  }

  strategies.set(siteId, strategy);
  evictIfNeeded(strategies);
}

/** Clear all strategy caches. Useful for testing. */
export function resetStrategyCache(): void {
  strategies.clear();
  tierSuccessCounts.clear();
}
