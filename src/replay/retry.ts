import { getLogger } from '../core/logger.js';
import { getEffectiveTier } from '../core/tiering.js';
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
  /** Site-recommended tier passed from engine (which owns siteRepo) */
  siteRecommendedTier?: ExecutionTierName;
  /** Site policy can suppress all automatic direct probes */
  directAllowed?: boolean;
  /** WS-4: Force execution to start at this tier (canary probe support) */
  forceStartTier?: ExecutionTierName;
  /** WS-4: Marks this execution as a canary probe */
  isCanaryProbe?: boolean;
}

interface RetryDecision {
  attempt: number;
  tier: ExecutionTierName;
  action: 'retry' | 'escalate' | 'abort';
  reason: string;
  backoffMs: number;
}

/** Per-attempt execution metadata for trajectory capture. */
interface RetryStepResult {
  tier: ExecutionTierName;
  status: number;
  latencyMs: number;
  failureCause?: FailureCauseName;
  success: boolean;
}

// ─── Retry With Escalation ──────────────────────────────────────

export async function retryWithEscalation(
  skill: SkillSpec,
  params: Record<string, unknown>,
  options?: RetryOptions,
): Promise<ExecutionResult & { retryDecisions: RetryDecision[]; startingTier: ExecutionTierName; stepResults: RetryStepResult[] }> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDecisions: RetryDecision[] = [];
  const stepResults: RetryStepResult[] = [];

  // Side-effect-free only — NEVER retry writes
  if (skill.sideEffectClass !== SideEffectClass.READ_ONLY) {
    log.info(
      { skillId: skill.id, sideEffectClass: skill.sideEffectClass },
      'Skipping retry for non-read-only skill',
    );

    const result = await executeSkill(skill, params, options);
    const startTier = options?.forceTier ?? determineStartingTier(skill);
    return { ...result, retryDecisions: [], startingTier: startTier, stepResults: [] };
  }

  // Determine tier cascade based on skill
  const tierCascade = buildTierCascade(skill, options?.siteRecommendedTier, options?.directAllowed ?? true);
  let currentTierIndex = 0;

  // WS-4: Honor forceStartTier — start from its position in cascade, or prepend it
  if (options?.forceStartTier) {
    const idx = tierCascade.indexOf(options.forceStartTier);
    if (idx >= 0) {
      currentTierIndex = idx;
    } else {
      tierCascade.unshift(options.forceStartTier);
      // currentTierIndex stays 0
    }
  }

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

    // Record per-attempt metadata for trajectory capture
    stepResults.push({
      tier: currentTier,
      status: lastResult.status,
      latencyMs: lastResult.latencyMs,
      failureCause: lastResult.failureCause,
      success: lastResult.success,
    });

    if (lastResult.success) {
      log.info(
        { skillId: skill.id, attempt, tier: currentTier },
        'Skill execution succeeded',
      );
      return { ...lastResult, retryDecisions, startingTier: tierCascade[0], stepResults };
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

  return { ...(lastResult ?? failureDefault()), retryDecisions, startingTier: tierCascade[0], stepResults };
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
  const currentTier = tierCascade[currentTierIndex];
  const nextTierIndex = Math.min(currentTierIndex + 1, tierCascade.length - 1);
  const canEscalate = nextTierIndex > currentTierIndex;

  function decision(action: RetryDecision['action'], tier: ExecutionTierName, reason: string, backoffMs = 0): RetryDecision {
    return { attempt, tier, action, reason, backoffMs };
  }

  if (attempt >= maxRetries) {
    return decision('abort', currentTier, 'Max retries exceeded');
  }

  const cause = failureCause ?? FailureCause.UNKNOWN;

  // Rate limited: exponential backoff, same tier
  if (cause === FailureCause.RATE_LIMITED) {
    return decision('retry', currentTier, 'Rate limited — exponential backoff',
      Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS));
  }

  // Endpoint removed: no point retrying
  if (cause === FailureCause.ENDPOINT_REMOVED) {
    return decision('abort', currentTier, 'Endpoint removed — no retry possible');
  }

  // Policy denied: capability blocked, domain not allowlisted, or private IP — non-retryable
  if (cause === FailureCause.POLICY_DENIED) {
    return decision('abort', currentTier, 'Policy denied — non-retryable violation');
  }

  // Fetch error: escalate immediately (no same-tier retry for network errors)
  if (cause === FailureCause.FETCH_ERROR) {
    if (canEscalate) {
      return decision('escalate', tierCascade[nextTierIndex], 'Fetch error — escalating tier');
    }
    return decision('abort', currentTier, 'Fetch error — all tiers exhausted');
  }

  if (cause === FailureCause.CLOUDFLARE_CHALLENGE) {
    if (canEscalate) {
      return decision('escalate', tierCascade[nextTierIndex], 'Cloudflare challenge — escalating tier');
    }
    return decision('abort', currentTier, 'Cloudflare challenge — all tiers exhausted');
  }

  // JS computed field, protocol sensitivity, signed payload: escalate tier
  if (
    cause === FailureCause.JS_COMPUTED_FIELD ||
    cause === FailureCause.PROTOCOL_SENSITIVITY ||
    cause === FailureCause.SIGNED_PAYLOAD
  ) {
    if (!canEscalate) {
      return decision('abort', currentTier, `${cause} — already at highest tier`);
    }
    return decision('escalate', tierCascade[nextTierIndex], `${cause} — escalating to ${tierCascade[nextTierIndex]}`);
  }

  // Schema drift: retry same tier (might be transient)
  if (cause === FailureCause.SCHEMA_DRIFT) {
    return decision('retry', currentTier, 'Schema drift — retrying same tier', SCHEMA_DRIFT_BACKOFF_MS);
  }

  // Auth expired: no point retrying without re-auth
  if (cause === FailureCause.AUTH_EXPIRED) {
    return decision('abort', currentTier, 'Auth expired — needs re-authentication');
  }

  // Cookie refresh: escalate to browser tier for cookie refresh
  if (cause === FailureCause.COOKIE_REFRESH) {
    return decision('escalate', tierCascade[nextTierIndex], 'Cookie refresh needed — escalating tier');
  }

  // UNKNOWN: backoff-then-escalate with per-tier cap
  if (consecutiveFailuresAtTier < MAX_RETRIES_PER_TIER) {
    return decision('retry', currentTier, 'Unknown failure — retrying same tier with backoff',
      BASE_BACKOFF_MS * Math.pow(2, attempt));
  }
  if (canEscalate) {
    return decision('escalate', tierCascade[nextTierIndex], 'Unknown failure — escalating after same-tier retry');
  }
  return decision('abort', currentTier, 'Unknown failure — all tiers exhausted');
}

// ─── Tier Cascade ───────────────────────────────────────────────

function buildTierCascade(
  skill: SkillSpec,
  siteRecommendedTier?: ExecutionTierName,
  directAllowed: boolean = true,
): ExecutionTierName[] {
  if (isBrowserRequiredSkill(skill)) {
    return [ExecutionTier.BROWSER_PROXIED, ExecutionTier.FULL_BROWSER];
  }
  if (skill.tierLock?.type === 'permanent' || skill.tierLock?.type === 'temporary_demotion') {
    return [ExecutionTier.BROWSER_PROXIED, ExecutionTier.FULL_BROWSER];
  }
  const effectiveTier = getEffectiveTier(skill);
  if (effectiveTier === 'tier_1' && directAllowed) {
    return [ExecutionTier.DIRECT, ExecutionTier.BROWSER_PROXIED, ExecutionTier.FULL_BROWSER];
  }
  if (effectiveTier === 'tier_1') {
    return [ExecutionTier.BROWSER_PROXIED, ExecutionTier.FULL_BROWSER];
  }
  // tier_3 but site recommends direct — try direct first, fall back to browser
  if (siteRecommendedTier === ExecutionTier.DIRECT && directAllowed) {
    return [ExecutionTier.DIRECT, ExecutionTier.BROWSER_PROXIED, ExecutionTier.FULL_BROWSER];
  }
  return [ExecutionTier.BROWSER_PROXIED, ExecutionTier.FULL_BROWSER];
}

function determineStartingTier(skill: SkillSpec): ExecutionTierName {
  if (isBrowserRequiredSkill(skill)) {
    return ExecutionTier.BROWSER_PROXIED;
  }
  return getEffectiveTier(skill) === 'tier_1'
    ? ExecutionTier.DIRECT
    : ExecutionTier.BROWSER_PROXIED;
}

function isBrowserRequiredSkill(skill: SkillSpec): boolean {
  return skill.tierLock?.type === 'permanent' && skill.tierLock.reason === 'browser_required';
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
