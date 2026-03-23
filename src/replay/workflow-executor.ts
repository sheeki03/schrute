import { stableStringify } from '../browser/manager.js';
import type { SkillExecutionResult } from '../core/engine.js';
import { SideEffectClass, SkillStatus, type WorkflowSpec, type SkillSpec } from '../skill/types.js';
import type { SkillRepository } from '../storage/skill-repository.js';
import { applyTransform } from './transform.js';

export interface WorkflowStepResult {
  skillId: string;
  name?: string;
  success: boolean;
  data?: unknown;
  error?: string;
  failureCause?: string;
  latencyMs: number;
}

export interface WorkflowSuccessResult {
  success: true;
  data: unknown;
  stepResults: WorkflowStepResult[];
  totalLatencyMs: number;
}

export interface WorkflowFailureResult {
  success: false;
  data: { steps: WorkflowStepResult[] };
  error: string;
  failureCause?: string;
  failedAtStep?: string;
  stepResults: WorkflowStepResult[];
  totalLatencyMs: number;
}

export type WorkflowResult =
  | WorkflowSuccessResult
  | WorkflowFailureResult
  | (SkillExecutionResult & { status: 'browser_handoff_required' });

export interface WorkflowCacheEntry {
  createdAt: number;
  result: SkillExecutionResult;
}

export interface WorkflowStepCacheStore {
  get(key: string): WorkflowCacheEntry | undefined;
  set(key: string, value: WorkflowCacheEntry): unknown;
  delete(key: string): boolean;
  entries(): IterableIterator<[string, WorkflowCacheEntry]>;
}

const WORKFLOW_CACHE_MAX_ENTRY_AGE_MS = 24 * 60 * 60 * 1000;

export async function executeWorkflow(
  workflow: WorkflowSpec,
  initialParams: Record<string, unknown>,
  executeStep: (skillId: string, params: Record<string, unknown>) => Promise<SkillExecutionResult>,
  skillRepo: SkillRepository,
  cacheStore: WorkflowStepCacheStore = new Map(),
): Promise<WorkflowResult> {
  const startedAt = Date.now();
  pruneExpiredWorkflowCache(cacheStore);
  const preflight = validateWorkflowPreflight(workflow, skillRepo);
  if (!preflight.valid) {
    return {
      success: false,
      data: { steps: [] },
      error: preflight.error,
      failedAtStep: preflight.failedAtStep,
      stepResults: [],
      totalLatencyMs: Date.now() - startedAt,
    };
  }

  const namedSteps = new Map<string, SkillExecutionResult>();
  const stepResults: WorkflowStepResult[] = [];
  let previousResult: SkillExecutionResult | undefined;

  for (const step of workflow.steps) {
    const stepName = step.name ?? step.skillId;
    let stepParams: Record<string, unknown>;
    try {
      stepParams = resolveStepParams(step.paramMapping, initialParams, previousResult, namedSteps);
    } catch (err) {
      return {
        success: false,
        data: { steps: stepResults },
        error: err instanceof Error ? err.message : String(err),
        failedAtStep: stepName,
        stepResults,
        totalLatencyMs: Date.now() - startedAt,
      };
    }

    const cacheKey = step.cache ? buildWorkflowCacheKey(step.skillId, stepParams) : undefined;
    let rawStepResult = cacheKey && step.cache
      ? getCachedWorkflowStepResult(cacheStore, cacheKey, step.cache.ttlMs)
      : undefined;

    if (!rawStepResult) {
      rawStepResult = await executeWorkflowStepWithRetry(step.skillId, stepParams, executeStep);
      if (rawStepResult.status === 'browser_handoff_required') {
        return rawStepResult as SkillExecutionResult & { status: 'browser_handoff_required' };
      }
      if (cacheKey && step.cache && rawStepResult.success) {
        cacheStore.set(cacheKey, {
          createdAt: Date.now(),
          result: rawStepResult,
        });
      }
    }

    const stepResult = await applyWorkflowStepTransform(rawStepResult, step.transform);

    stepResults.push({
      skillId: step.skillId,
      name: step.name,
      success: stepResult.success,
      data: stepResult.data,
      error: stepResult.error,
      failureCause: stepResult.failureCause,
      latencyMs: stepResult.latencyMs,
    });

    if (!stepResult.success) {
      return {
        success: false,
        data: { steps: stepResults },
        error: stepResult.error ?? `Workflow step '${stepName}' failed`,
        failureCause: stepResult.failureCause,
        failedAtStep: stepName,
        stepResults,
        totalLatencyMs: Date.now() - startedAt,
      };
    }

    previousResult = stepResult;
    if (step.name) {
      namedSteps.set(step.name, stepResult);
    }
  }

  return {
    success: true,
    data: previousResult?.data,
    stepResults,
    totalLatencyMs: Date.now() - startedAt,
  };
}

function buildWorkflowCacheKey(skillId: string, params: Record<string, unknown>): string {
  return `${skillId}|${stableStringify(params)}`;
}

async function executeWorkflowStepWithRetry(
  skillId: string,
  params: Record<string, unknown>,
  executeStep: (skillId: string, params: Record<string, unknown>) => Promise<SkillExecutionResult>,
): Promise<SkillExecutionResult> {
  let result = await executeStep(skillId, params);
  if (result.status === 'browser_handoff_required' || result.success || result.failureCause !== 'rate_limited') {
    return result;
  }

  const waitMs = parseRateLimitRetryAfterMs(result.failureDetail);
  await new Promise(resolve => setTimeout(resolve, waitMs + 50));
  result = await executeStep(skillId, params);
  return result;
}

function parseRateLimitRetryAfterMs(failureDetail?: string): number {
  const parsed = Number.parseInt(failureDetail?.match(/(\d+)ms/)?.[1] ?? '1000', 10);
  const retryAfterMs = Number.isFinite(parsed) ? parsed : 1000;
  return Math.min(Math.max(retryAfterMs, 100), 30_000);
}

function getCachedWorkflowStepResult(
  cacheStore: WorkflowStepCacheStore,
  cacheKey: string,
  ttlMs: number,
): SkillExecutionResult | undefined {
  const cached = cacheStore.get(cacheKey);
  if (!cached) {
    return undefined;
  }
  const ageMs = Date.now() - cached.createdAt;
  if (ageMs > WORKFLOW_CACHE_MAX_ENTRY_AGE_MS) {
    cacheStore.delete(cacheKey);
    return undefined;
  }
  return ageMs <= ttlMs ? cached.result : undefined;
}

function pruneExpiredWorkflowCache(cacheStore: WorkflowStepCacheStore): void {
  const now = Date.now();
  for (const [key, entry] of cacheStore.entries()) {
    if (now - entry.createdAt > WORKFLOW_CACHE_MAX_ENTRY_AGE_MS) {
      cacheStore.delete(key);
    }
  }
}

async function applyWorkflowStepTransform(
  stepResult: SkillExecutionResult,
  transform: WorkflowSpec['steps'][number]['transform'],
): Promise<SkillExecutionResult> {
  if (!stepResult.success || !transform) {
    return stepResult;
  }

  const transformed = await applyTransform(stepResult.data, transform);
  return {
    ...stepResult,
    data: transformed.data,
    ...(transformed.transformApplied ? { transformApplied: true, transformLabel: transformed.label } : {}),
  };
}

function validateWorkflowPreflight(
  workflow: WorkflowSpec,
  skillRepo: SkillRepository,
): { valid: true } | { valid: false; error: string; failedAtStep?: string } {
  const seenNames = new Set<string>();
  let hasPreviousStep = false;

  for (const step of workflow.steps) {
    const stepName = step.name ?? step.skillId;
    for (const ref of Object.values(step.paramMapping ?? {})) {
      const referenceError = validateWorkflowReference(ref, seenNames, hasPreviousStep);
      if (referenceError) {
        return { valid: false, error: referenceError, failedAtStep: stepName };
      }
    }

    if (step.name) {
      if (seenNames.has(step.name)) {
        return { valid: false, error: `Duplicate workflow step name '${step.name}'`, failedAtStep: step.name };
      }
    }

    const skill = skillRepo.getById(step.skillId);
    if (!skill) {
      return { valid: false, error: `Workflow step skill '${step.skillId}' not found`, failedAtStep: stepName };
    }
    if (skill.status !== SkillStatus.ACTIVE) {
      return { valid: false, error: `Workflow step '${stepName}' is not active (status: ${skill.status})`, failedAtStep: stepName };
    }
    if (skill.sideEffectClass !== SideEffectClass.READ_ONLY) {
      return { valid: false, error: `Workflow step '${stepName}' is not read-only`, failedAtStep: stepName };
    }
    if (skill.workflowSpec) {
      return { valid: false, error: `Workflow step '${stepName}' cannot reference another workflow`, failedAtStep: stepName };
    }
    const upperMethod = skill.method.toUpperCase();
    if (upperMethod !== 'GET' && upperMethod !== 'HEAD') {
      return { valid: false, error: `Workflow step '${stepName}' must use GET or HEAD`, failedAtStep: stepName };
    }

    if (step.name) {
      seenNames.add(step.name);
    }
    hasPreviousStep = true;
  }

  return { valid: true };
}

function validateWorkflowReference(
  ref: string,
  availableStepNames: Set<string>,
  hasPreviousStep: boolean,
): string | undefined {
  if (ref === '$initial' || ref.startsWith('$initial.')) {
    return undefined;
  }

  if (ref === '$prev' || ref.startsWith('$prev.')) {
    return hasPreviousStep
      ? undefined
      : `Workflow reference '${ref}' is invalid because there is no previous step result`;
  }

  if (ref.startsWith('$steps.')) {
    const remainder = ref.slice('$steps.'.length);
    const stepName = remainder.split('.', 1)[0];
    if (!stepName) {
      return `Workflow reference '${ref}' is missing a step name`;
    }
    if (!availableStepNames.has(stepName)) {
      return `Workflow reference '${ref}' points to unknown step '${stepName}'`;
    }
    return undefined;
  }

  return `Unsupported workflow reference '${ref}'`;
}

function resolveStepParams(
  paramMapping: Record<string, string> | undefined,
  initialParams: Record<string, unknown>,
  previousResult: SkillExecutionResult | undefined,
  namedSteps: Map<string, SkillExecutionResult>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  if (!paramMapping) {
    return resolved;
  }

  for (const [key, ref] of Object.entries(paramMapping)) {
    resolved[key] = resolveReference(ref, initialParams, previousResult, namedSteps);
  }

  return resolved;
}

function resolveReference(
  ref: string,
  initialParams: Record<string, unknown>,
  previousResult: SkillExecutionResult | undefined,
  namedSteps: Map<string, SkillExecutionResult>,
): unknown {
  if (ref === '$initial' || ref.startsWith('$initial.')) {
    return getPathValue(initialParams, ref.slice('$initial'.length), ref);
  }

  if (ref === '$prev' || ref.startsWith('$prev.')) {
    if (!previousResult) {
      throw new Error(`Workflow reference '${ref}' is invalid because there is no previous step result`);
    }
    return getPathValue(previousResult, ref.slice('$prev'.length), ref);
  }

  if (ref.startsWith('$steps.')) {
    const remainder = ref.slice('$steps.'.length);
    const stepName = remainder.split('.', 1)[0];
    if (!stepName) {
      throw new Error(`Workflow reference '${ref}' is missing a step name`);
    }
    const stepResult = namedSteps.get(stepName);
    if (!stepResult) {
      throw new Error(`Workflow reference '${ref}' points to unknown step '${stepName}'`);
    }
    return getPathValue(stepResult, remainder.slice(stepName.length), ref);
  }

  throw new Error(`Unsupported workflow reference '${ref}'`);
}

function getPathValue(source: unknown, rawPath: string, ref: string): unknown {
  if (!rawPath) {
    return source;
  }

  const normalized = rawPath.replace(/^\./, '').replace(/\[(\d+)\]/g, '.$1');
  const segments = normalized.split('.').filter(Boolean);
  let current: unknown = source;

  for (const segment of segments) {
    if (current === null || current === undefined) {
      throw new Error(`Workflow reference '${ref}' resolved to undefined at '${segment}'`);
    }

    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new Error(`Workflow reference '${ref}' has invalid array index '${segment}'`);
      }
      current = current[index];
      continue;
    }

    if (typeof current !== 'object' || !(segment in (current as Record<string, unknown>))) {
      throw new Error(`Workflow reference '${ref}' resolved to undefined at '${segment}'`);
    }

    current = (current as Record<string, unknown>)[segment];
  }

  if (current === undefined) {
    throw new Error(`Workflow reference '${ref}' resolved to undefined`);
  }
  return current;
}
