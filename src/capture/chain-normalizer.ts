import type { SkillSpec } from '../skill/types.js';
import { getLogger } from '../core/logger.js';

const log = getLogger();

/**
 * Resolve unresolved chain refs ("METHOD host /path" or legacy "METHOD /path")
 * to actual skill IDs by matching method + allowedDomains[0] + pathTemplate.
 * Returns count of refs changed.
 */
export function normalizeChainRefs(skills: SkillSpec[]): number {
  let changed = 0;

  // Build lookup maps for resolution
  const byMethodHostPath = new Map<string, SkillSpec>(); // "METHOD host /path" → best matching skill
  const byMethodPath = new Map<string, SkillSpec>();     // "METHOD /path" → best matching skill (legacy fallback)

  for (const skill of skills) {
    const host = skill.allowedDomains?.[0] ?? '';
    const key = `${skill.method} ${host} ${skill.pathTemplate}`;
    const existingExact = byMethodHostPath.get(key);
    if (!existingExact || shouldPreferCandidate(existingExact, skill)) {
      byMethodHostPath.set(key, skill);
    }

    const legacyKey = `${skill.method} ${skill.pathTemplate}`;
    const existingLegacy = byMethodPath.get(legacyKey);
    if (!existingLegacy || shouldPreferCandidate(existingLegacy, skill)) {
      byMethodPath.set(legacyKey, skill);
    }
  }

  for (const skill of skills) {
    if (!skill.chainSpec) continue;

    for (const step of skill.chainSpec.steps) {
      // Already resolved (no spaces = skill ID)
      if (!step.skillRef || !step.skillRef.includes(' ')) continue;

      // Try new format: "METHOD host /path"
      let resolved = byMethodHostPath.get(step.skillRef)?.id;

      if (!resolved) {
        // Legacy fallback: "METHOD /path" — match by method+path only
        const parts = step.skillRef.split(' ');
        if (parts.length === 2) {
          resolved = byMethodPath.get(step.skillRef)?.id;
        } else if (parts.length === 3) {
          // Try legacy key without host
          const legacyKey = `${parts[0]} ${parts[2]}`;
          resolved = byMethodPath.get(legacyKey)?.id;
        }
      }

      if (resolved) {
        step.skillRef = resolved;
        changed++;
      }
      // Unresolvable refs left as-is
    }
  }

  if (changed > 0) {
    log.info({ refsNormalized: changed }, 'Normalized chain refs to skill IDs');
  }

  return changed;
}

const RESOLUTION_STATUS_PRIORITY: Record<string, number> = {
  active: 0,
  stale: 1,
  broken: 2,
  draft: 3,
};

function shouldPreferCandidate(existing: SkillSpec, candidate: SkillSpec): boolean {
  const existingPriority = RESOLUTION_STATUS_PRIORITY[existing.status] ?? 9;
  const candidatePriority = RESOLUTION_STATUS_PRIORITY[candidate.status] ?? 9;
  if (candidatePriority !== existingPriority) {
    return candidatePriority < existingPriority;
  }
  if (candidate.version !== existing.version) {
    return candidate.version > existing.version;
  }
  return candidate.id < existing.id;
}
