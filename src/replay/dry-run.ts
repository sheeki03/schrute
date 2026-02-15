import { getLogger } from '../core/logger.js';
import type {
  SkillSpec,
  RedactionMode,
  ExecutionTierName,
  PolicyDecision,
  FieldVolatility,
} from '../skill/types.js';
import { buildRequest } from './request-builder.js';

const log = getLogger();

// ─── Types ──────────────────────────────────────────────────────

export interface DryRunResult {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  policyDecision: PolicyDecision;
  tier: ExecutionTierName;
  volatilityReport?: FieldVolatility[];
  tierDecision?: string;
}

// ─── Redaction Patterns ─────────────────────────────────────────

const SENSITIVE_HEADER_KEYS = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
];

const SENSITIVE_BODY_PATTERNS = [
  /("(?:password|secret|token|api_key|apiKey|access_token|refresh_token|private_key|client_secret)")\s*:\s*"[^"]*"/gi,
];

// ─── Dry Run ────────────────────────────────────────────────────

export function dryRun(
  skill: SkillSpec,
  params: Record<string, unknown>,
  mode: RedactionMode,
  options?: {
    tier?: ExecutionTierName;
    volatilityReport?: FieldVolatility[];
    policyDecision?: PolicyDecision;
  },
): DryRunResult {
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

  // NEVER show raw unredacted request — always redact
  const redactedHeaders = redactHeaders(request.headers);
  const redactedBody = request.body ? redactBody(request.body) : undefined;
  const redactedUrl = redactUrl(request.url);

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

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADER_KEYS.includes(key.toLowerCase())) {
      redacted[key] = '[REDACTED]';
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

function redactBody(body: string): string {
  let redacted = body;
  for (const pattern of SENSITIVE_BODY_PATTERNS) {
    redacted = redacted.replace(pattern, (match, keyPart) => {
      return `${keyPart}: "[REDACTED]"`;
    });
  }
  return redacted;
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const sensitiveParams = ['token', 'api_key', 'apiKey', 'access_token', 'secret', 'key'];
    for (const param of sensitiveParams) {
      if (parsed.searchParams.has(param)) {
        parsed.searchParams.set(param, '[REDACTED]');
      }
    }
    return parsed.toString();
  } catch {
    return url;
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
