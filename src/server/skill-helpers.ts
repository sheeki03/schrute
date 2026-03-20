import type { SkillSpec } from '../skill/types.js';
import type { BrowserManager } from '../browser/manager.js';
import type { SkillRepository } from '../storage/skill-repository.js';
import { getEffectiveTier } from '../core/tiering.js';
import { TierState, SkillStatus } from '../skill/types.js';
import { rankToolsByIntent, skillToToolDefinition } from './tool-registry.js';

// ─── Shared Return Types ─────────────────────────────────────────

export interface SkillSearchResult {
  id: string;
  name: string;
  siteId: string;
  method: string;
  pathTemplate: string;
  description: string;
  inputSchema: Record<string, unknown>;
  status: string;
  successRate: number;
  currentTier: string;
  executable: boolean;
  blockedReason?: string;
  avgLatencyMs?: number;
  lastSuccessfulTier?: string;
  promotionProgress?: string;
  provenance?: 'learned' | 'webmcp' | 'both';
}

// ─── Executability Check ─────────────────────────────────────────

export function getSkillExecutability(
  skill: SkillSpec,
  browserManager: BrowserManager,
): { executable: boolean; blockedReason?: string } {
  if (skill.status !== 'active') {
    return { executable: false, blockedReason: `Status is '${skill.status}', not active` };
  }
  const effectiveTier = getEffectiveTier(skill);
  if (effectiveTier === TierState.TIER_3_DEFAULT) {
    if (!browserManager.hasContext(skill.siteId)) {
      return {
        executable: false,
        blockedReason: `No browser context for site '${skill.siteId}'. Use schrute_explore first.`,
      };
    }
  }
  return { executable: true };
}

// ─── Promotion Progress ─────────────────────────────────────────

function buildPromotionProgress(skill: SkillSpec): string | undefined {
  if (skill.currentTier === 'tier_1') return 'Promoted to direct';
  if (skill.tierLock?.type === 'permanent') return `Locked: ${skill.tierLock.reason}`;
  if (skill.directCanaryEligible) return 'Ready for direct canary on next execution';
  if ((skill.directCanaryAttempts ?? 0) > 0 && !skill.directCanaryEligible) {
    return `Canary failed (${skill.lastCanaryErrorType ?? 'unknown'}), ${skill.directCanaryAttempts} attempts`;
  }
  const validations = skill.validationsSinceLastCanary ?? 0;
  if (validations > 0) return `${validations} browser validations toward canary eligibility`;
  return undefined;
}

// ─── Auto-Confirm Gate (CS-M2) ──────────────────────────────────

/**
 * Returns true when a skill is safe to auto-confirm (read-only GET/HEAD).
 */
export function shouldAutoConfirm(skill: SkillSpec): boolean {
  return skill.sideEffectClass === 'read-only' && (skill.method === 'GET' || skill.method === 'HEAD');
}

// ─── Inactive Matches (CS-H2) ───────────────────────────────────

/**
 * Find inactive skill matches (BROKEN/DRAFT/STALE) by query.
 * Returns a list of `{ id, status }` objects for surfacing as hints.
 */
export function findInactiveMatches(
  skillRepo: SkillRepository,
  query: string | undefined,
  limit: number,
  siteId?: string,
): Array<{ id: string; status: string }> {
  const inactiveStatuses = [SkillStatus.BROKEN, SkillStatus.DRAFT, SkillStatus.STALE] as const;
  const inactiveSkills = inactiveStatuses
    .flatMap(status => skillRepo.getByStatus(status))
    .filter(s => !siteId || s.siteId === siteId);
  return rankToolsByIntent(inactiveSkills, query, limit)
    .map(s => ({ id: s.id, status: s.status }));
}

// ─── Search & Project Pipeline (CS-M3) ──────────────────────────

/**
 * Full search pipeline: fetch skills → rank by intent → project to
 * SkillSearchResult[] with executability info, plus optional inactive
 * match hints.
 */
export function searchAndProjectSkills(
  skillRepo: SkillRepository,
  browserManager: BrowserManager,
  opts: {
    query?: string;
    siteId?: string;
    limit: number;
    includeInactive?: boolean;
  },
): { results: SkillSearchResult[]; matchType?: 'fts' | 'like'; inactiveMatches?: Array<{ id: string; status: string }>; inactiveHint?: string } {
  const { query, siteId, limit, includeInactive } = opts;

  let skills: SkillSpec[];
  let matchType: 'fts' | 'like' | undefined;

  // If query provided, try FTS first for better relevance ranking
  if (query) {
    const ftsResult = skillRepo.searchFts(query, { siteId, limit });
    if (ftsResult.skills.length > 0) {
      matchType = ftsResult.matchType;
      // Filter by status if not including inactive
      skills = includeInactive
        ? ftsResult.skills
        : ftsResult.skills.filter(s => s.status === SkillStatus.ACTIVE);
    } else {
      // FTS/LIKE returned nothing — fall through to full scan (no matchType)
      if (includeInactive) {
        skills = siteId
          ? skillRepo.getBySiteId(siteId)
          : skillRepo.getAll();
      } else {
        skills = siteId
          ? skillRepo.getActive(siteId)
          : skillRepo.getByStatus(SkillStatus.ACTIVE);
      }
    }
  } else {
    if (includeInactive) {
      skills = siteId
        ? skillRepo.getBySiteId(siteId)
        : skillRepo.getAll();
    } else {
      skills = siteId
        ? skillRepo.getActive(siteId)
        : skillRepo.getByStatus(SkillStatus.ACTIVE);
    }
  }

  const ranked = rankToolsByIntent(skills, query, limit, { preFiltered: !!matchType });
  const results: SkillSearchResult[] = ranked.map(s => {
    const toolDef = skillToToolDefinition(s);
    const execInfo = getSkillExecutability(s, browserManager);
    return {
      id: s.id,
      name: s.name,
      siteId: s.siteId,
      method: s.method,
      pathTemplate: s.pathTemplate,
      description: toolDef.description,
      inputSchema: toolDef.inputSchema,
      status: s.status,
      successRate: s.successRate,
      currentTier: s.currentTier,
      executable: execInfo.executable,
      ...(execInfo.blockedReason ? { blockedReason: execInfo.blockedReason } : {}),
      avgLatencyMs: s.avgLatencyMs,
      lastSuccessfulTier: s.lastSuccessfulTier,
      promotionProgress: buildPromotionProgress(s),
    };
  });

  // Annotate provenance
  for (const r of results) {
    r.provenance = r.method === 'WEBMCP' ? 'webmcp' : 'learned';
  }

  const response: { results: SkillSearchResult[]; matchType?: 'fts' | 'like'; inactiveMatches?: Array<{ id: string; status: string }>; inactiveHint?: string } = {
    results,
    ...(matchType ? { matchType } : {}),
  };

  if (!includeInactive) {
    const inactiveMatches = findInactiveMatches(skillRepo, query, limit, siteId);
    if (inactiveMatches.length > 0) {
      response.inactiveMatches = inactiveMatches;
      response.inactiveHint = 'Not active; use schrute_activate if appropriate.';
    }
  }

  return response;
}
