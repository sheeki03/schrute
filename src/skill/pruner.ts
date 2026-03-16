import type { SkillSpec, SchruteConfig } from './types.js';
import { SkillStatus } from './types.js';
import { getConfig } from '../core/config.js';
import { calculateConfidence, STALE_THRESHOLD } from './versioning.js';

// ─── Types ──────────────────────────────────────────────────────

interface PruneResult {
  visible: SkillSpec[];
  hidden: SkillSpec[];
}

interface ShortlistResult {
  skills: SkillSpec[];
  isFullCatalog: boolean;
  hint?: string;
}

// ─── Prune Skills ───────────────────────────────────────────────

/**
 * Filter skills for a site: only ACTIVE skills are visible.
 * Cap at maxToolsPerSite (default 20), sorted by usage frequency.
 */
export function pruneSkills(
  skills: SkillSpec[],
  config?: SchruteConfig,
): PruneResult {
  const cfg = config ?? getConfig();
  const maxTools = cfg.maxToolsPerSite;

  const visible: SkillSpec[] = [];
  const hidden: SkillSpec[] = [];

  for (const skill of skills) {
    if (skill.status === SkillStatus.ACTIVE) {
      // Recheck confidence — may have decayed
      const currentConfidence = calculateConfidence(skill);
      if (currentConfidence >= STALE_THRESHOLD) {
        visible.push(skill);
      } else {
        hidden.push(skill);
      }
    } else {
      hidden.push(skill);
    }
  }

  // Sort visible by usage frequency (lastUsed as proxy, most recent first)
  visible.sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0));

  // Cap at maxToolsPerSite
  if (visible.length > maxTools) {
    const overflow = visible.splice(maxTools);
    hidden.push(...overflow);
  }

  return { visible, hidden };
}

// ─── Per-task Shortlist ─────────────────────────────────────────

/**
 * Get top K skills ranked by intent match.
 * Falls back to full catalog with hint when no confident match.
 */
export function getShortlist(
  skills: SkillSpec[],
  intent?: string,
  k?: number,
  config?: SchruteConfig,
): ShortlistResult {
  const cfg = config ?? getConfig();
  const maxK = k ?? cfg.toolShortlistK;

  // Only consider active, non-stale skills
  const { visible } = pruneSkills(skills, cfg);

  if (visible.length === 0) {
    return { skills: [], isFullCatalog: false };
  }

  if (!intent) {
    // No intent — return full catalog up to cap
    return {
      skills: visible.slice(0, maxK),
      isFullCatalog: visible.length <= maxK,
    };
  }

  // Score each skill by intent match
  const scored = visible.map((skill) => ({
    skill,
    score: scoreIntentMatch(skill, intent),
  }));

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Check if top matches are confident
  const topScore = scored[0]?.score ?? 0;
  const confidenceThreshold = STALE_THRESHOLD;

  if (topScore < confidenceThreshold) {
    // Low confidence — expose full catalog with hint
    return {
      skills: visible.slice(0, maxK),
      isFullCatalog: true,
      hint: `No skill closely matches intent "${intent}". Showing all ${Math.min(visible.length, maxK)} available skills.`,
    };
  }

  // Return top K by score
  const shortlist = scored.slice(0, maxK).map((s) => s.skill);

  return {
    skills: shortlist,
    isFullCatalog: false,
  };
}

// ─── Intent Scoring ─────────────────────────────────────────────

function scoreIntentMatch(skill: SkillSpec, intent: string): number {
  const intentLower = intent.toLowerCase();
  const intentTokens = tokenize(intentLower);

  let score = 0;

  // Name match (highest weight)
  const nameLower = skill.name.toLowerCase();
  if (nameLower === intentLower) {
    score += 1.0;
  } else if (nameLower.includes(intentLower) || intentLower.includes(nameLower)) {
    score += 0.7;
  } else {
    const nameTokens = tokenize(nameLower);
    const overlap = tokenOverlap(intentTokens, nameTokens);
    score += overlap * 0.5;
  }

  // Description match
  if (skill.description) {
    const descLower = skill.description.toLowerCase();
    const descTokens = tokenize(descLower);
    const overlap = tokenOverlap(intentTokens, descTokens);
    score += overlap * 0.3;
  }

  // Path template match (lower weight)
  const pathTokens = tokenize(skill.pathTemplate.toLowerCase().replace(/[{}\/]/g, ' '));
  const pathOverlap = tokenOverlap(intentTokens, pathTokens);
  score += pathOverlap * 0.2;

  // Boost for higher confidence
  score *= 0.5 + (skill.confidence * 0.5);

  return Math.min(score, 1.0);
}

function tokenize(text: string): string[] {
  return text
    .split(/[\s_\-./]+/)
    .filter((t) => t.length > 1);
}

function tokenOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;

  let matches = 0;
  for (const token of a) {
    if (b.some((bt) => bt.includes(token) || token.includes(bt))) {
      matches++;
    }
  }

  return matches / Math.max(a.length, 1);
}
