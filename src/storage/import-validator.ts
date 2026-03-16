/**
 * Import validation for skill and site bundles.
 *
 * Re-creates the validation logic used by skill-repository.ts and
 * site-repository.ts so that import data is checked *before* touching
 * the database.  All constants are sourced from skill/types.ts.
 */

import {
  SkillStatus,
  TierState,
  SideEffectClass,
  MasteryLevel,
  ExecutionTier,
} from '../skill/types.js';

// ─── Cached value sets ──────────────────────────────────────────────
const VALID_SKILL_STATUSES: Set<string> = new Set(Object.values(SkillStatus));
const VALID_TIER_STATES: Set<string> = new Set(Object.values(TierState));
const VALID_SIDE_EFFECT_CLASSES: Set<string> = new Set(Object.values(SideEffectClass));
const VALID_AUTH_TYPES: Set<string> = new Set(['bearer', 'cookie', 'api_key', 'oauth2']);
const VALID_REPLAY_STRATEGIES: Set<string> = new Set(['prefer_tier_1', 'prefer_tier_3', 'tier_3_only']);
const VALID_MASTERY_LEVELS: Set<string> = new Set(Object.values(MasteryLevel));
const VALID_EXECUTION_TIERS: Set<string> = new Set(Object.values(ExecutionTier));

// ─── Helpers ────────────────────────────────────────────────────────

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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
