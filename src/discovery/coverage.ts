// ─── API Surface Coverage ────────────────────────────────────────────
// Compares discovered endpoints against learned skills to compute
// coverage metrics. Host-level identity is intentional (existing model):
// localhost:3000 and localhost:4000 collapse to the same siteId.

import type { DiscoveryResult, DiscoveredEndpoint } from './types.js';
import type { SkillSpec } from '../skill/types.js';

export interface CoverageReport {
  discovered: number;
  active: number;
  stale: number;
  broken: number;
  uncovered: string[];
  coveragePercent: number;
}

/**
 * Normalize a parameterized path by stripping param names so that
 * `/users/{id}` and `/users/{userId}` are treated as equivalent.
 */
function normalizePath(path: string): string {
  return path.replace(/\{[^}]+\}/g, '{_}');
}

/**
 * Compute API surface coverage by matching discovered endpoints against
 * existing skills. Matching uses exact method + pathTemplate first, then
 * falls back to normalized parameterized paths.
 */
export function computeCoverage(
  discoveryResult: DiscoveryResult,
  skills: SkillSpec[],
  siteId?: string,
): CoverageReport {
  const discovered = discoveryResult.endpoints.length;

  if (discovered === 0) {
    return {
      discovered: 0,
      active: 0,
      stale: 0,
      broken: 0,
      uncovered: [],
      coveragePercent: 0,
    };
  }

  // Build lookup: keyed by method:path, prefer host-matching + higher-status skills.
  // Status priority: active > stale > broken > draft (draft = uncovered)
  const STATUS_PRIORITY: Record<string, number> = { active: 0, stale: 1, broken: 2, draft: 3 };

  // Store all skills per key for host-aware matching later
  const exactKeySkills = new Map<string, SkillSpec[]>();
  const normKeySkills = new Map<string, SkillSpec[]>();

  for (const skill of skills) {
    const exactKey = `${skill.method.toUpperCase()}:${skill.pathTemplate}`;
    const normKey = `${skill.method.toUpperCase()}:${normalizePath(skill.pathTemplate)}`;
    if (!exactKeySkills.has(exactKey)) exactKeySkills.set(exactKey, []);
    exactKeySkills.get(exactKey)!.push(skill);
    if (!normKeySkills.has(normKey)) normKeySkills.set(normKey, []);
    normKeySkills.get(normKey)!.push(skill);
  }

  function bestMatch(candidates: SkillSpec[] | undefined, discoveredHost?: string): SkillSpec | undefined {
    if (!candidates || candidates.length === 0) return undefined;
    // Prefer host-matching skills, then best status
    return candidates.slice().sort((a, b) => {
      const aHostMatch = discoveredHost && a.allowedDomains?.includes(discoveredHost) ? 0 : 1;
      const bHostMatch = discoveredHost && b.allowedDomains?.includes(discoveredHost) ? 0 : 1;
      if (aHostMatch !== bHostMatch) return aHostMatch - bHostMatch;
      return (STATUS_PRIORITY[a.status] ?? 9) - (STATUS_PRIORITY[b.status] ?? 9);
    })[0];
  }

  let active = 0;
  let stale = 0;
  let broken = 0;
  const uncovered: string[] = [];

  for (const ep of discoveryResult.endpoints) {
    const exactKey = `${ep.method.toUpperCase()}:${ep.path}`;
    const normKey = `${ep.method.toUpperCase()}:${normalizePath(ep.path)}`;
    // DiscoveredEndpoint has no host field — use siteId from discovery as default host
    const discoveredHost = siteId;

    const matched = bestMatch(exactKeySkills.get(exactKey), discoveredHost)
      ?? bestMatch(normKeySkills.get(normKey), discoveredHost);

    if (!matched) {
      uncovered.push(`${ep.method} ${ep.path}`);
      continue;
    }

    switch (matched.status) {
      case 'active':
        active++;
        break;
      case 'stale':
        stale++;
        break;
      case 'broken':
        broken++;
        break;
      default:
        // draft or other non-covered statuses
        uncovered.push(`${ep.method} ${ep.path}`);
        break;
    }
  }

  const covered = active + stale + broken;
  const coveragePercent = Math.round((covered / discovered) * 100);

  return {
    discovered,
    active,
    stale,
    broken,
    uncovered,
    coveragePercent,
  };
}
