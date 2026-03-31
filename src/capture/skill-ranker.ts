import type { SkillSpec } from '../skill/types.js';

// ─── In-Memory Cluster Metadata (NOT persisted) ─────────────────
export interface ClusterMetadata {
  pathSegments: string[];
  responseContentType?: string;
  sampleCount: number;
  hasAuthHeaders: boolean;
  canonicalHost?: string;
}

// ─── Auth/Session Suppression Patterns ──────────────────────────
const SUPPRESS_PATTERNS = /csrf|logged_in|session|onboarding|user_info/i;

/**
 * Determine whether a skill should be suppressed (auth/session noise).
 */
export function shouldSuppressSkill(
  skill: SkillSpec,
  _metadata?: ClusterMetadata,
): { suppress: boolean; reason?: string } {
  if (SUPPRESS_PATTERNS.test(skill.pathTemplate)) {
    return { suppress: true, reason: `Auth/session endpoint: ${skill.pathTemplate}` };
  }
  return { suppress: false };
}

// ─── Path-Template Dedup ────────────────────────────────────────

/**
 * Deduplicate new skill candidates against all existing site skills.
 * Two skills are duplicates when they share the same method, the same
 * allowedDomains[0], and their path templates differ only in the last
 * segment.  Only new candidates are mutated — existing active skills
 * are never touched.
 */
export function deduplicateByPathTemplate(
  newSkills: SkillSpec[],
  allSiteSkills: SkillSpec[],
): { keep: SkillSpec[]; suppressed: Array<{ skill: SkillSpec; reason: string }> } {
  const keep: SkillSpec[] = [];
  const suppressed: Array<{ skill: SkillSpec; reason: string }> = [];

  // Build a lookup from existing skills: key = method|host|parentPath
  const existingKeys = new Set<string>();
  for (const s of allSiteSkills) {
    const key = dedupKey(s);
    if (key) existingKeys.add(key);
  }

  // Track keys from new candidates we've already kept
  const keptKeys = new Set<string>();

  for (const skill of newSkills) {
    const key = dedupKey(skill);
    if (key && (existingKeys.has(key) || keptKeys.has(key))) {
      suppressed.push({ skill, reason: `Duplicate path variant: ${skill.pathTemplate}` });
    } else {
      keep.push(skill);
      if (key) keptKeys.add(key);
    }
  }

  return { keep, suppressed };
}

function dedupKey(skill: SkillSpec): string | null {
  if (!skill.pathTemplate) return null;
  const segments = skill.pathTemplate.split('/').filter(Boolean);
  // Require at least 2 segments — single-segment paths like /login, /health, /status
  // should never be deduped against each other (they share empty parentPath)
  if (segments.length < 2) return null;
  const parentPath = segments.slice(0, -1).join('/');
  const host = skill.allowedDomains?.[0] ?? '';
  return `${skill.method}|${host}|${parentPath}`;
}
