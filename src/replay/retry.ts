import { getLogger } from '../core/logger.js';
import type { SkillSpec, ExecutionTierName, FailureCauseName } from '../skill/types.js';
import { ExecutionTier, FailureCause, SideEffectClass } from '../skill/types.js';
import { executeSkill, type ExecutionResult, type ExecutorOptions } from './executor.js';

const log = getLogger();

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const SCHEMA_DRIFT_BACKOFF_MS = 1000;
const MAX_RETRIES_PER_TIER = 1;

// ─── Types ──────────────────────────────────────────────────────

export interface RetryOptions extends ExecutorOptions {
  maxRetries?: number;
}

export interface RetryDecision {
  attempt: number;
  tier: ExecutionTierName;
  action: 'retry' | 'escalate' | 'abort';
  reason: string;
  backoffMs: number;
}

// ─── Retry With Escalation ──────────────────────────────────────

export async function retryWithEscalation(
  skill: SkillSpec,
  params: Record<string, unknown>,
  options?: RetryOptions,
): Promise<ExecutionResult & { retryDecisions: RetryDecision[] }> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDecisions: RetryDecision[] = [];

  // Side-effect-free only — NEVER retry writes
  if (skill.sideEffectClass !== SideEffectClass.READ_ONLY) {
    log.info(
      { skillId: skill.id, sideEffectClass: skill.sideEffectClass },
      'Skipping retry for non-read-only skill',
    );

    const result = await executeSkill(skill, params, options);
    return { ...result, retryDecisions: [] };
  }

  // Determine tier cascade based on skill
  const tierCascade = buildTierCascade(skill);
  let currentTierIndex = 0;
  let attempt = 0;
  let consecutiveFailuresAtTier = 0;

  let lastResult: ExecutionResult | null = null;

  while (attempt <= maxRetries) {
    const currentTier = tierCascade[currentTierIndex];

    if (attempt > 0) {
      const decision = retryDecisions[retryDecisions.length - 1];
      if (decision && decision.backoffMs > 0) {
        await sleep(decision.backoffMs);
      }
    }

    lastResult = await executeSkill(skill, params, {
      ...options,
      forceTier: currentTier,
    });

    if (lastResult.success) {
      log.info(
        { skillId: skill.id, attempt, tier: currentTier },
        'Skill execution succeeded',
      );
      return { ...lastResult, retryDecisions };
    }

    // Decide what to do next
    const decision = decideRetry(
      attempt,
      maxRetries,
      lastResult.failureCause,
      currentTierIndex,
      tierCascade,
      consecutiveFailuresAtTier,
    );
    retryDecisions.push(decision);

    // Increment AFTER the decision
    consecutiveFailuresAtTier++;

    log.debug(
      {
        skillId: skill.id,
        attempt,
        failureCause: lastResult.failureCause,
        action: decision.action,
        nextTier: decision.tier,
      },
      'Retry decision',
    );

    if (decision.action === 'abort') {
      break;
    }

    if (decision.action === 'escalate') {
      currentTierIndex = tierCascade.indexOf(decision.tier);
      if (currentTierIndex < 0) currentTierIndex = tierCascade.length - 1;
      consecutiveFailuresAtTier = 0;  // Reset on tier change
    }

    attempt++;
  }

  log.warn(
    { skillId: skill.id, attempts: attempt, lastCause: lastResult?.failureCause },
    'All retries exhausted',
  );

  return { ...(lastResult ?? failureDefault()), retryDecisions };
}

// ─── Retry Decision Logic ───────────────────────────────────────

function decideRetry(
  attempt: number,
  maxRetries: number,
  failureCause: FailureCauseName | undefined,
  currentTierIndex: number,
  tierCascade: ExecutionTierName[],
  consecutiveFailuresAtTier: number,
): RetryDecision {
  if (attempt >= maxRetries) {
    return {
      attempt,
      tier: tierCascade[currentTierIndex],
      action: 'abort',
      reason: 'Max retries exceeded',
      backoffMs: 0,
    };
  }

  const cause = failureCause ?? FailureCause.UNKNOWN;

  // Rate limited: exponential backoff, same tier
  if (cause === FailureCause.RATE_LIMITED) {
    const backoffMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
    return {
      attempt,
      tier: tierCascade[currentTierIndex],
      action: 'retry',
      reason: 'Rate limited — exponential backoff',
      backoffMs,
    };
  }

  // Endpoint removed: no point retrying
  if (cause === FailureCause.ENDPOINT_REMOVED) {
    return {
      attempt,
      tier: tierCascade[currentTierIndex],
      action: 'abort',
      reason: 'Endpoint removed — no retry possible',
      backoffMs: 0,
    };
  }

  // JS computed field, protocol sensitivity, signed payload: escalate tier
  if (
    cause === FailureCause.JS_COMPUTED_FIELD ||
    cause === FailureCause.PROTOCOL_SENSITIVITY ||
    cause === FailureCause.SIGNED_PAYLOAD
  ) {
    const nextTierIndex = Math.min(currentTierIndex + 1, tierCascade.length - 1);
    if (nextTierIndex === currentTierIndex) {
      return {
        attempt,
        tier: tierCascade[currentTierIndex],
        action: 'abort',
        reason: `${cause} — already at highest tier`,
        backoffMs: 0,
      };
    }
    return {
      attempt,
      tier: tierCascade[nextTierIndex],
      action: 'escalate',
      reason: `${cause} — escalating to ${tierCascade[nextTierIndex]}`,
      backoffMs: 0, // immediate for tier escalation
    };
  }

  // Schema drift: retry same tier (might be transient)
  if (cause === FailureCause.SCHEMA_DRIFT) {
    return {
      attempt,
      tier: tierCascade[currentTierIndex],
      action: 'retry',
      reason: 'Schema drift — retrying same tier',
      backoffMs: SCHEMA_DRIFT_BACKOFF_MS,
    };
  }

  // Auth expired: no point retrying without re-auth
  if (cause === FailureCause.AUTH_EXPIRED) {
    return {
      attempt,
      tier: tierCascade[currentTierIndex],
      action: 'abort',
      reason: 'Auth expired — needs re-authentication',
      backoffMs: 0,
    };
  }

  // Cookie refresh: escalate to browser tier for cookie refresh
  if (cause === FailureCause.COOKIE_REFRESH) {
    const nextTierIndex = Math.min(currentTierIndex + 1, tierCascade.length - 1);
    return {
      attempt,
      tier: tierCascade[nextTierIndex],
      action: 'escalate',
      reason: 'Cookie refresh needed — escalating tier',
      backoffMs: 0,
    };
  }

  // UNKNOWN: backoff-then-escalate with per-tier cap
  if (consecutiveFailuresAtTier < MAX_RETRIES_PER_TIER) {
    return {
      attempt,
      tier: tierCascade[currentTierIndex],
      action: 'retry',
      reason: 'Unknown failure — retrying same tier with backoff',
      backoffMs: BASE_BACKOFF_MS * Math.pow(2, attempt),
    };
  }
  const unknownNextTierIndex = Math.min(currentTierIndex + 1, tierCascade.length - 1);
  if (unknownNextTierIndex > currentTierIndex) {
    return {
      attempt,
      tier: tierCascade[unknownNextTierIndex],
      action: 'escalate',
      reason: 'Unknown failure — escalating after same-tier retry',
      backoffMs: 0,
    };
  }
  return {
    attempt,
    tier: tierCascade[currentTierIndex],
    action: 'abort',
    reason: 'Unknown failure — all tiers exhausted',
    backoffMs: 0,
  };
}

// ─── Tier Cascade ───────────────────────────────────────────────

function buildTierCascade(skill: SkillSpec): ExecutionTierName[] {
  // If locked to Tier 3+, don't include Tier 1
  if (skill.tierLock?.type === 'permanent') {
    return [ExecutionTier.BROWSER_PROXIED, ExecutionTier.FULL_BROWSER];
  }

  if (skill.currentTier === 'tier_1') {
    // Tier 1 -> Tier 3 -> Tier 4
    return [ExecutionTier.DIRECT, ExecutionTier.BROWSER_PROXIED, ExecutionTier.FULL_BROWSER];
  }

  // Default: Tier 3 -> Tier 4
  return [ExecutionTier.BROWSER_PROXIED, ExecutionTier.FULL_BROWSER];
}

// ─── Helpers ────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function failureDefault(): ExecutionResult {
  return {
    success: false,
    tier: ExecutionTier.DIRECT,
    status: 0,
    data: null,
    rawBody: '',
    headers: {},
    latencyMs: 0,
    schemaMatch: false,
    semanticPass: false,
    failureCause: FailureCause.UNKNOWN,
  };
}
