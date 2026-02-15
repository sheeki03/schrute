import { getLogger } from '../core/logger.js';
import type {
  OneAgentConfig,
  ToolBudgetConfig,
  PayloadLimits,
  ExecutionTierName,
} from '../skill/types.js';
import { ExecutionTier } from '../skill/types.js';

const log = getLogger();

// ─── Types ──────────────────────────────────────────────────────

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
  rule?: string;
}

export interface BudgetStats {
  totalCalls: number;
  activeConcurrent: number;
  callsBySkill: Record<string, number>;
  callsBySite: Record<string, number>;
}

// ─── Tool Budget Tracker ────────────────────────────────────────

export class ToolBudgetTracker {
  private config: ToolBudgetConfig;
  private limits: PayloadLimits;
  private totalCalls: number = 0;
  private activeConcurrent: number = 0;
  private activeBySite: Map<string, number> = new Map();
  private callsBySkill: Map<string, number> = new Map();
  private callsBySite: Map<string, number> = new Map();
  private domainAllowlist: Set<string> = new Set();

  constructor(config: OneAgentConfig) {
    this.config = config.toolBudget;
    this.limits = config.payloadLimits;
  }

  setDomainAllowlist(domains: string[]): void {
    this.domainAllowlist = new Set(domains.map((d) => d.toLowerCase()));
  }

  checkBudget(
    skillId: string,
    siteId: string,
    options?: {
      targetDomain?: string;
      hasSecrets?: boolean;
      requestBodyBytes?: number;
    },
  ): BudgetCheckResult {
    // Max tool calls per task
    if (this.totalCalls >= this.config.maxToolCallsPerTask) {
      return {
        allowed: false,
        reason: `Max tool calls per task exceeded (${this.config.maxToolCallsPerTask})`,
        rule: 'budget.max_calls_per_task',
      };
    }

    // Max concurrent calls (global)
    if (this.activeConcurrent >= this.config.maxConcurrentCalls) {
      return {
        allowed: false,
        reason: `Max concurrent calls exceeded (${this.config.maxConcurrentCalls})`,
        rule: 'budget.max_concurrent_global',
      };
    }

    // Max concurrent per site (default 1)
    const siteActive = this.activeBySite.get(siteId) ?? 0;
    if (siteActive >= 1) {
      return {
        allowed: false,
        reason: `Max concurrent calls per site exceeded (1) for site '${siteId}'`,
        rule: 'budget.max_concurrent_per_site',
      };
    }

    // Cross-domain check
    if (options?.targetDomain) {
      const normalizedTarget = options.targetDomain.toLowerCase();
      const normalizedSite = siteId.toLowerCase();
      const isSameDomain =
        normalizedTarget === normalizedSite ||
        normalizedTarget.endsWith('.' + normalizedSite) ||
        normalizedSite.endsWith('.' + normalizedTarget);

      if (!isSameDomain && !this.config.crossDomainCalls) {
        return {
          allowed: false,
          reason: `Cross-domain calls denied: ${normalizedTarget} != ${normalizedSite}`,
          rule: 'budget.cross_domain_denied',
        };
      }
    }

    // Secrets to non-allowlisted domain: HARD DENY (never overridable)
    if (options?.hasSecrets && options?.targetDomain) {
      const normalizedTarget = options.targetDomain.toLowerCase();
      if (!this.domainAllowlist.has(normalizedTarget)) {
        // Also check subdomain matching
        let isAllowlisted = false;
        for (const allowed of this.domainAllowlist) {
          if (normalizedTarget.endsWith('.' + allowed)) {
            isAllowlisted = true;
            break;
          }
        }
        if (!isAllowlisted) {
          return {
            allowed: false,
            reason: `HARD DENY: secrets to non-allowlisted domain '${normalizedTarget}'`,
            rule: 'budget.secrets_non_allowlisted',
          };
        }
      }
    }

    // Request body size
    if (options?.requestBodyBytes && options.requestBodyBytes > this.limits.maxRequestBodyBytes) {
      return {
        allowed: false,
        reason: `Request body too large: ${options.requestBodyBytes} > ${this.limits.maxRequestBodyBytes}`,
        rule: 'budget.request_body_too_large',
      };
    }

    return { allowed: true };
  }

  recordCall(skillId: string, siteId: string): void {
    this.totalCalls++;
    this.activeConcurrent++;
    this.activeBySite.set(siteId, (this.activeBySite.get(siteId) ?? 0) + 1);
    this.callsBySkill.set(skillId, (this.callsBySkill.get(skillId) ?? 0) + 1);
    this.callsBySite.set(siteId, (this.callsBySite.get(siteId) ?? 0) + 1);

    log.debug(
      { skillId, siteId, totalCalls: this.totalCalls, concurrent: this.activeConcurrent },
      'Recorded tool call',
    );
  }

  releaseCall(siteId: string): void {
    this.activeConcurrent = Math.max(0, this.activeConcurrent - 1);
    const siteActive = this.activeBySite.get(siteId) ?? 0;
    if (siteActive > 0) {
      this.activeBySite.set(siteId, siteActive - 1);
    }
  }

  getTimeoutMs(tier: ExecutionTierName): number {
    switch (tier) {
      case ExecutionTier.DIRECT:
        return this.limits.replayTimeoutMs.tier1;
      case ExecutionTier.BROWSER_PROXIED:
        return this.limits.replayTimeoutMs.tier3;
      case ExecutionTier.FULL_BROWSER:
        return this.limits.replayTimeoutMs.tier4;
      default:
        return this.limits.replayTimeoutMs.tier3;
    }
  }

  getMaxResponseBytes(): number {
    return this.limits.maxResponseBodyBytes;
  }

  getCurrent(): BudgetStats {
    return {
      totalCalls: this.totalCalls,
      activeConcurrent: this.activeConcurrent,
      callsBySkill: Object.fromEntries(this.callsBySkill),
      callsBySite: Object.fromEntries(this.callsBySite),
    };
  }

  reset(): void {
    this.totalCalls = 0;
    this.activeConcurrent = 0;
    this.activeBySite.clear();
    this.callsBySkill.clear();
    this.callsBySite.clear();
  }
}
