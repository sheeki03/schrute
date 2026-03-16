import { getLogger } from '../core/logger.js';
import type {
  SkillSpec,
  RedactionMode,
  ExecutionTierName,
  PolicyDecision,
  FieldVolatility,
} from '../skill/types.js';
import { buildRequest } from './request-builder.js';
import {
  redactHeaders as canonicalRedactHeaders,
  redactBody as canonicalRedactBody,
  redactString,
} from '../storage/redactor.js';

const log = getLogger();

// ─── Types ──────────────────────────────────────────────────────

interface DryRunResult {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  policyDecision: PolicyDecision;
  tier: ExecutionTierName;
  volatilityReport?: FieldVolatility[];
  tierDecision?: string;
}

// ─── Dry Run ────────────────────────────────────────────────────

export async function dryRun(
  skill: SkillSpec,
  params: Record<string, unknown>,
  mode: RedactionMode,
  options?: {
    tier?: ExecutionTierName;
    volatilityReport?: FieldVolatility[];
    policyDecision?: PolicyDecision;
  },
): Promise<DryRunResult> {
  // Determine tier
  const tier: ExecutionTierName = options?.tier ?? tierFromSkill(skill);

  // Build the request that would be sent
  const request = buildRequest(skill, params, tier);

  // Build policy decision
  const policyDecision: PolicyDecision = options?.policyDecision ?? {
    proposed: `${request.method} ${request.url}`,
    policyResult: 'allowed',
    policyRule: 'dry_run.preview',
    userConfirmed: null,
    redactionsApplied: [],
  };

  // NEVER show raw unredacted request — always redact using the canonical redactor
  const redactedHeaders = await canonicalRedactHeaders(request.headers);
  const redactedBody = request.body ? await canonicalRedactBody(request.body) : undefined;
  const redactedUrl = await redactUrl(request.url);

  const redactionsApplied: string[] = [];
  if (JSON.stringify(redactedHeaders) !== JSON.stringify(request.headers)) {
    redactionsApplied.push('headers');
  }
  if (redactedBody !== request.body) {
    redactionsApplied.push('body');
  }
  if (redactedUrl !== request.url) {
    redactionsApplied.push('url');
  }

  const result: DryRunResult = {
    method: request.method,
    url: redactedUrl,
    headers: redactedHeaders,
    body: redactedBody,
    policyDecision: {
      ...policyDecision,
      redactionsApplied,
    },
    tier,
  };

  // developer-debug mode includes extra info
  if (mode === 'developer-debug') {
    result.volatilityReport = options?.volatilityReport;
    result.tierDecision = describeTierDecision(skill);
  }

  log.debug(
    { skillId: skill.id, mode, tier },
    'Dry run preview generated',
  );

  return result;
}

// ─── Redaction Helpers ──────────────────────────────────────────

async function redactUrl(url: string): Promise<string> {
  try {
    const parsed = new URL(url);
    for (const [key, value] of parsed.searchParams.entries()) {
      parsed.searchParams.set(key, await redactString(value));
    }
    return parsed.toString();
  } catch {
    return redactString(url);
  }
}

function tierFromSkill(skill: SkillSpec): ExecutionTierName {
  if (skill.currentTier === 'tier_1') {
    return 'direct';
  }
  return 'browser_proxied';
}

function describeTierDecision(skill: SkillSpec): string {
  const parts: string[] = [];
  parts.push(`currentTier=${skill.currentTier}`);
  parts.push(`replayStrategy=${skill.replayStrategy}`);

  if (skill.tierLock) {
    parts.push(`tierLock.type=${skill.tierLock.type}`);
    if (skill.tierLock.type === 'permanent') {
      parts.push(`tierLock.reason=${skill.tierLock.reason}`);
    }
  } else {
    parts.push('tierLock=none');
  }

  parts.push(`confidence=${skill.confidence}`);
  parts.push(`consecutiveValidations=${skill.consecutiveValidations}`);

  return parts.join(', ');
}
