/**
 * Import validation for skill and site bundles.
 *
 * Re-creates the validation logic used by skill-repository.ts and
 * site-repository.ts so that import data is checked *before* touching
 * the database.  All constants are sourced from skill/types.ts.
 */

import {
  Capability,
  SkillStatus,
  TierState,
  SideEffectClass,
  MasteryLevel,
  ExecutionTier,
  V01_DEFAULT_CAPABILITIES,
} from '../skill/types.js';
import type { CapabilityName, HttpMethod, SitePolicy } from '../skill/types.js';

// ─── Cached value sets ──────────────────────────────────────────────
const VALID_SKILL_STATUSES: Set<string> = new Set(Object.values(SkillStatus));
const VALID_TIER_STATES: Set<string> = new Set(Object.values(TierState));
const VALID_SIDE_EFFECT_CLASSES: Set<string> = new Set(Object.values(SideEffectClass));
const VALID_AUTH_TYPES: Set<string> = new Set(['bearer', 'cookie', 'api_key', 'oauth2']);
const VALID_REPLAY_STRATEGIES: Set<string> = new Set(['prefer_tier_1', 'prefer_tier_3', 'tier_3_only']);
const VALID_MASTERY_LEVELS: Set<string> = new Set(Object.values(MasteryLevel));
const VALID_EXECUTION_TIERS: Set<string> = new Set(Object.values(ExecutionTier));
const VALID_HTTP_METHODS: Set<string> = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const VALID_CAPABILITIES: Set<string> = new Set(Object.values(Capability));
const POLICY_DEFAULTS: Omit<SitePolicy, 'siteId'> = {
  allowedMethods: ['GET', 'HEAD'],
  maxQps: 10,
  maxConcurrent: 3,
  minGapMs: 100,
  readOnlyDefault: true,
  requireConfirmation: [],
  domainAllowlist: [],
  redactionRules: [],
  capabilities: [...V01_DEFAULT_CAPABILITIES],
  browserRequired: false,
};

// ─── Helpers ────────────────────────────────────────────────────────

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateOutputTransform(value: unknown, fieldName: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${fieldName} must be an object`);
    return;
  }

  if (typeof value.type !== 'string') {
    errors.push(`${fieldName}.type must be a string`);
    return;
  }

  switch (value.type) {
    case 'jsonpath':
      if (typeof value.expression !== 'string') {
        errors.push(`${fieldName}.expression must be a string`);
      }
      break;
    case 'regex':
      if (typeof value.expression !== 'string') {
        errors.push(`${fieldName}.expression must be a string`);
      }
      if (value.flags !== undefined && typeof value.flags !== 'string') {
        errors.push(`${fieldName}.flags must be a string`);
      }
      break;
    case 'css':
      if (typeof value.selector !== 'string') {
        errors.push(`${fieldName}.selector must be a string`);
      }
      if (value.mode !== undefined && !['text', 'html', 'attr', 'list'].includes(String(value.mode))) {
        errors.push(`${fieldName}.mode must be one of: text, html, attr, list`);
      }
      if (value.attr !== undefined && typeof value.attr !== 'string') {
        errors.push(`${fieldName}.attr must be a string`);
      }
      if (value.fields !== undefined) {
        if (!isRecord(value.fields)) {
          errors.push(`${fieldName}.fields must be an object`);
        } else {
          for (const [key, field] of Object.entries(value.fields)) {
            if (!isRecord(field)) {
              errors.push(`${fieldName}.fields.${key} must be an object`);
              continue;
            }
            if (typeof field.selector !== 'string') {
              errors.push(`${fieldName}.fields.${key}.selector must be a string`);
            }
            if (field.mode !== undefined && !['text', 'attr', 'html'].includes(String(field.mode))) {
              errors.push(`${fieldName}.fields.${key}.mode must be one of: text, attr, html`);
            }
            if (field.attr !== undefined && typeof field.attr !== 'string') {
              errors.push(`${fieldName}.fields.${key}.attr must be a string`);
            }
          }
        }
      }
      break;
    default:
      errors.push(`${fieldName}.type must be one of: jsonpath, regex, css`);
  }
}

function validateWorkflowSpec(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('workflowSpec must be an object');
    return;
  }
  if (!Array.isArray(value.steps)) {
    errors.push('workflowSpec: missing required field "steps" (array)');
    return;
  }
  for (let index = 0; index < value.steps.length; index++) {
    const step = value.steps[index];
    if (!isRecord(step)) {
      errors.push(`workflowSpec.steps[${index}] must be an object`);
      continue;
    }
    if (typeof step.skillId !== 'string') {
      errors.push(`workflowSpec.steps[${index}].skillId must be a string`);
    }
    if (step.name !== undefined && typeof step.name !== 'string') {
      errors.push(`workflowSpec.steps[${index}].name must be a string`);
    }
    if (step.paramMapping !== undefined) {
      if (!isRecord(step.paramMapping)) {
        errors.push(`workflowSpec.steps[${index}].paramMapping must be an object`);
      } else {
        for (const [param, source] of Object.entries(step.paramMapping)) {
          if (typeof source !== 'string') {
            errors.push(`workflowSpec.steps[${index}].paramMapping.${param} must be a string`);
          }
        }
      }
    }
    if (step.transform !== undefined) {
      validateOutputTransform(step.transform, `workflowSpec.steps[${index}].transform`, errors);
    }
    if (step.cache !== undefined) {
      if (!isRecord(step.cache) || typeof step.cache.ttlMs !== 'number') {
        errors.push(`workflowSpec.steps[${index}].cache.ttlMs must be a number`);
      }
    }
  }
}

// ─── Skill validator ────────────────────────────────────────────────

export function validateImportableSkill(skill: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!isRecord(skill)) {
    return { valid: false, errors: ['skill is not an object'] };
  }

  // --- Structural checks ---
  if (!isNonEmptyString(skill.id)) {
    errors.push('id must be a non-empty string');
  }
  if (!isNonEmptyString(skill.siteId)) {
    errors.push('siteId must be a non-empty string');
  }
  // name is NOT NULL in the database schema — must be present or derivable
  if (skill.name !== undefined && typeof skill.name !== 'string') {
    errors.push('name must be a string if provided');
  }
  if (typeof skill.method !== 'string') {
    errors.push('method must be a string');
  }
  if (typeof skill.pathTemplate !== 'string') {
    errors.push('pathTemplate must be a string');
  }
  if (typeof skill.version !== 'number') {
    errors.push('version must be a number');
  }

  // --- Enum fields ---
  if (typeof skill.status === 'string' && !VALID_SKILL_STATUSES.has(skill.status)) {
    errors.push(
      `invalid status "${skill.status}". Expected one of: ${[...VALID_SKILL_STATUSES].join(', ')}`,
    );
  }

  if (typeof skill.currentTier === 'string' && !VALID_TIER_STATES.has(skill.currentTier)) {
    errors.push(
      `invalid currentTier "${skill.currentTier}". Expected one of: ${[...VALID_TIER_STATES].join(', ')}`,
    );
  }

  if (
    typeof skill.sideEffectClass === 'string' &&
    !VALID_SIDE_EFFECT_CLASSES.has(skill.sideEffectClass)
  ) {
    errors.push(
      `invalid sideEffectClass "${skill.sideEffectClass}". Expected one of: ${[...VALID_SIDE_EFFECT_CLASSES].join(', ')}`,
    );
  }

  if (skill.authType !== undefined && skill.authType !== null) {
    if (typeof skill.authType === 'string' && !VALID_AUTH_TYPES.has(skill.authType)) {
      errors.push(
        `invalid authType "${skill.authType}". Expected one of: ${[...VALID_AUTH_TYPES].join(', ')}`,
      );
    }
  }

  if (typeof skill.replayStrategy === 'string' && !VALID_REPLAY_STRATEGIES.has(skill.replayStrategy)) {
    errors.push(
      `invalid replayStrategy "${skill.replayStrategy}". Expected one of: ${[...VALID_REPLAY_STRATEGIES].join(', ')}`,
    );
  }

  // --- Shape validators ---

  // tierLock
  if (skill.tierLock !== undefined && skill.tierLock !== null) {
    if (!isRecord(skill.tierLock)) {
      errors.push('tierLock must be an object or null');
    } else {
      const tl = skill.tierLock;
      if (tl.type === 'permanent') {
        if (typeof tl.reason !== 'string' || typeof tl.evidence !== 'string') {
          errors.push('tierLock (permanent): missing required fields "reason" and "evidence"');
        }
      } else if (tl.type === 'temporary_demotion') {
        if (typeof tl.since !== 'string' || typeof tl.demotions !== 'number') {
          errors.push('tierLock (temporary_demotion): missing required fields "since" and "demotions"');
        }
      } else {
        errors.push(`tierLock: unknown type "${String(tl.type)}"`);
      }
    }
  }

  // parameterEvidence
  if (skill.parameterEvidence !== undefined && skill.parameterEvidence !== null) {
    if (!Array.isArray(skill.parameterEvidence)) {
      errors.push('parameterEvidence must be an array');
    } else {
      for (let i = 0; i < skill.parameterEvidence.length; i++) {
        const item = skill.parameterEvidence[i];
        if (
          !isRecord(item) ||
          typeof item.fieldPath !== 'string' ||
          typeof item.classification !== 'string'
        ) {
          errors.push(
            `parameterEvidence[${i}]: missing required fields "fieldPath" and "classification"`,
          );
        }
      }
    }
  }

  // allowedDomains — must be an array of strings (not a bare string or object)
  if (skill.allowedDomains !== undefined && skill.allowedDomains !== null) {
    if (!Array.isArray(skill.allowedDomains)) {
      errors.push('allowedDomains must be an array');
    } else {
      for (let i = 0; i < skill.allowedDomains.length; i++) {
        if (typeof skill.allowedDomains[i] !== 'string') {
          errors.push(`allowedDomains[${i}] must be a string`);
          break;
        }
      }
    }
  }

  // chainSpec
  if (skill.chainSpec !== undefined && skill.chainSpec !== null) {
    if (!isRecord(skill.chainSpec)) {
      errors.push('chainSpec must be an object');
    } else {
      const cs = skill.chainSpec;
      if (!Array.isArray(cs.steps)) {
        errors.push('chainSpec: missing required field "steps" (array)');
      }
      if (typeof cs.canReplayWithCookiesOnly !== 'boolean') {
        errors.push('chainSpec: missing required field "canReplayWithCookiesOnly" (boolean)');
      }
    }
  }

  if (skill.outputTransform !== undefined && skill.outputTransform !== null) {
    validateOutputTransform(skill.outputTransform, 'outputTransform', errors);
  }

  if (skill.responseContentType !== undefined && skill.responseContentType !== null && typeof skill.responseContentType !== 'string') {
    errors.push('responseContentType must be a string');
  }

  if (skill.workflowSpec !== undefined && skill.workflowSpec !== null) {
    validateWorkflowSpec(skill.workflowSpec, errors);
  }

  return { valid: errors.length === 0, errors };
}

// ─── Site validator ─────────────────────────────────────────────────

export function validateImportableSite(site: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!isRecord(site)) {
    return { valid: false, errors: ['site is not an object'] };
  }

  if (!isNonEmptyString(site.id)) {
    errors.push('id must be a non-empty string');
  }

  if (typeof site.masteryLevel === 'string' && !VALID_MASTERY_LEVELS.has(site.masteryLevel)) {
    errors.push(
      `invalid masteryLevel "${site.masteryLevel}". Expected one of: ${[...VALID_MASTERY_LEVELS].join(', ')}`,
    );
  }

  // The bundle uses 'recommendedTier' which maps to the DB column 'recommended_tier'
  // validated against ExecutionTier values.
  if (typeof site.recommendedTier === 'string' && !VALID_EXECUTION_TIERS.has(site.recommendedTier)) {
    errors.push(
      `invalid recommendedTier "${site.recommendedTier}". Expected one of: ${[...VALID_EXECUTION_TIERS].join(', ')}`,
    );
  }

  // Numeric fields written directly to SQLite and read back as timestamps/counters.
  // A non-finite value here will crash `new Date(lastVisited)` in the CLI sites command.
  if (site.firstSeen !== undefined && site.firstSeen !== null) {
    if (typeof site.firstSeen !== 'number' || !Number.isFinite(site.firstSeen)) {
      errors.push('firstSeen must be a finite number (epoch ms)');
    }
  }
  if (site.lastVisited !== undefined && site.lastVisited !== null) {
    if (typeof site.lastVisited !== 'number' || !Number.isFinite(site.lastVisited)) {
      errors.push('lastVisited must be a finite number (epoch ms)');
    }
  }
  if (site.totalRequests !== undefined && site.totalRequests !== null) {
    if (typeof site.totalRequests !== 'number' || !Number.isFinite(site.totalRequests)) {
      errors.push('totalRequests must be a finite number');
    }
  }
  if (site.successfulRequests !== undefined && site.successfulRequests !== null) {
    if (typeof site.successfulRequests !== 'number' || !Number.isFinite(site.successfulRequests)) {
      errors.push('successfulRequests must be a finite number');
    }
  }

  return { valid: errors.length === 0, errors };
}

const VALID_EXECUTION_BACKENDS: Set<string> = new Set(['playwright', 'agent-browser', 'live-chrome']);

function validateStringArrayField(
  value: unknown,
  fieldName: string,
  errors: string[],
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    errors.push(`${fieldName} must be an array`);
    return undefined;
  }

  const normalized: string[] = [];
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== 'string') {
      errors.push(`${fieldName}[${i}] must be a string`);
      return undefined;
    }
    normalized.push(value[i]);
  }
  return normalized;
}

export function validateAndNormalizeImportablePolicy(
  policy: unknown,
  siteId: string,
): { valid: boolean; errors: string[]; value?: SitePolicy } {
  const errors: string[] = [];

  if (!isRecord(policy)) {
    return { valid: false, errors: ['policy is not an object'] };
  }

  let allowedMethods: HttpMethod[] | undefined;
  if (policy.allowedMethods !== undefined && policy.allowedMethods !== null) {
    if (!Array.isArray(policy.allowedMethods)) {
      errors.push('allowedMethods must be an array');
    } else {
      const normalizedMethods: HttpMethod[] = [];
      for (let i = 0; i < policy.allowedMethods.length; i++) {
        const method = policy.allowedMethods[i];
        if (typeof method !== 'string') {
          errors.push(`allowedMethods[${i}] must be a string`);
          break;
        }
        if (!VALID_HTTP_METHODS.has(method)) {
          errors.push(`allowedMethods[${i}] has invalid HTTP method "${method}"`);
          break;
        }
        normalizedMethods.push(method as HttpMethod);
      }
      if (errors.length === 0 || normalizedMethods.length === policy.allowedMethods.length) {
        allowedMethods = normalizedMethods;
      }
    }
  }

  let maxQps: number | undefined;
  if (policy.maxQps !== undefined && policy.maxQps !== null) {
    if (typeof policy.maxQps !== 'number' || !Number.isFinite(policy.maxQps)) {
      errors.push('maxQps must be a finite number when provided');
    } else {
      maxQps = policy.maxQps;
    }
  }

  let maxConcurrent: number | undefined;
  if (policy.maxConcurrent !== undefined && policy.maxConcurrent !== null) {
    if (typeof policy.maxConcurrent !== 'number' || !Number.isFinite(policy.maxConcurrent)) {
      errors.push('maxConcurrent must be a finite number when provided');
    } else {
      maxConcurrent = policy.maxConcurrent;
    }
  }

  let minGapMs: number | undefined;
  if (policy.minGapMs !== undefined && policy.minGapMs !== null) {
    if (typeof policy.minGapMs !== 'number' || !Number.isFinite(policy.minGapMs) || policy.minGapMs < 0) {
      errors.push('minGapMs must be a finite number >= 0 when provided');
    } else {
      minGapMs = policy.minGapMs;
    }
  }

  let readOnlyDefault: boolean | undefined;
  if (policy.readOnlyDefault !== undefined && policy.readOnlyDefault !== null) {
    if (typeof policy.readOnlyDefault !== 'boolean') {
      errors.push('readOnlyDefault must be a boolean when provided');
    } else {
      readOnlyDefault = policy.readOnlyDefault;
    }
  }

  const requireConfirmation = validateStringArrayField(policy.requireConfirmation, 'requireConfirmation', errors);
  const domainAllowlist = validateStringArrayField(policy.domainAllowlist, 'domainAllowlist', errors);
  const redactionRules = validateStringArrayField(policy.redactionRules, 'redactionRules', errors);

  let capabilities: CapabilityName[] | undefined;
  if (policy.capabilities !== undefined && policy.capabilities !== null) {
    if (!Array.isArray(policy.capabilities)) {
      errors.push('capabilities must be an array');
    } else {
      const normalizedCapabilities: CapabilityName[] = [];
      for (let i = 0; i < policy.capabilities.length; i++) {
        const capability = policy.capabilities[i];
        if (typeof capability !== 'string') {
          errors.push(`capabilities[${i}] must be a string`);
          break;
        }
        if (!VALID_CAPABILITIES.has(capability)) {
          errors.push(`capabilities[${i}] has invalid capability "${capability}"`);
          break;
        }
        normalizedCapabilities.push(capability as CapabilityName);
      }
      if (errors.length === 0 || normalizedCapabilities.length === policy.capabilities.length) {
        capabilities = normalizedCapabilities;
      }
    }
  }

  if (policy.browserRequired !== undefined && typeof policy.browserRequired !== 'boolean') {
    errors.push('browserRequired must be a boolean when provided');
  }

  if (policy.executionBackend !== undefined && policy.executionBackend !== null) {
    if (typeof policy.executionBackend !== 'string' || !VALID_EXECUTION_BACKENDS.has(policy.executionBackend)) {
      errors.push(
        `invalid executionBackend "${String(policy.executionBackend)}". Expected one of: ${[...VALID_EXECUTION_BACKENDS].join(', ')}`,
      );
    }
  }

  if (policy.executionSessionName !== undefined && policy.executionSessionName !== null) {
    if (typeof policy.executionSessionName !== 'string') {
      errors.push('executionSessionName must be a string when provided');
    } else if (policy.executionBackend !== 'playwright' && policy.executionBackend !== 'live-chrome') {
      errors.push(`executionSessionName requires executionBackend='playwright' or 'live-chrome'`);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const normalized: SitePolicy = {
    siteId,
    allowedMethods: allowedMethods ?? [...POLICY_DEFAULTS.allowedMethods],
    maxQps: maxQps ?? POLICY_DEFAULTS.maxQps,
    maxConcurrent: maxConcurrent ?? POLICY_DEFAULTS.maxConcurrent,
    minGapMs: minGapMs ?? POLICY_DEFAULTS.minGapMs,
    readOnlyDefault: readOnlyDefault ?? POLICY_DEFAULTS.readOnlyDefault,
    requireConfirmation: requireConfirmation ?? [...POLICY_DEFAULTS.requireConfirmation],
    domainAllowlist: domainAllowlist ?? [...POLICY_DEFAULTS.domainAllowlist],
    redactionRules: redactionRules ?? [...POLICY_DEFAULTS.redactionRules],
    capabilities: capabilities ?? [...POLICY_DEFAULTS.capabilities],
    browserRequired: policy.browserRequired === true,
    ...(typeof policy.executionBackend === 'string'
      ? { executionBackend: policy.executionBackend as SitePolicy['executionBackend'] }
      : {}),
    ...(typeof policy.executionSessionName === 'string'
      ? { executionSessionName: policy.executionSessionName }
      : {}),
  };

  return {
    valid: true,
    errors: [],
    value: normalized,
  };
}
