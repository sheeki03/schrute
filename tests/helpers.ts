/**
 * Shared test helpers and fixtures for OneAgent tests.
 */

import type {
  SkillSpec,
  SiteManifest,
  OneAgentConfig,
  SitePolicy,
  PolicyDecision,
  AuditEntry,
} from '../src/skill/types.js';
import {
  SkillStatus,
  SideEffectClass,
  TierState,
  ExecutionTier,
  Capability,
  MasteryLevel,
} from '../src/skill/types.js';

// ─── Default test config ──────────────────────────────────────────

export function makeTestConfig(overrides?: Partial<OneAgentConfig>): OneAgentConfig {
  return {
    dataDir: '/tmp/oneagent-test-' + Math.random().toString(36).slice(2),
    logLevel: 'silent',
    features: {
      webmcp: false,
      httpTransport: false,
    },
    toolBudget: {
      maxToolCallsPerTask: 50,
      maxConcurrentCalls: 3,
      crossDomainCalls: false,
      secretsToNonAllowlisted: false,
    },
    payloadLimits: {
      maxResponseBodyBytes: 10 * 1024 * 1024,
      maxRequestBodyBytes: 5 * 1024 * 1024,
      replayTimeoutMs: {
        tier1: 30000,
        tier3: 60000,
        tier4: 120000,
      },
      harCaptureMaxBodyBytes: 50 * 1024 * 1024,
      redactorTimeoutMs: 10000,
    },
    audit: {
      strictMode: true,
      rootHashExport: true,
    },
    storage: {
      maxPerSiteMb: 500,
      maxGlobalMb: 5000,
      retentionDays: 90,
    },
    server: {
      network: false,
    },
    tempTtlMs: 3600000,
    gcIntervalMs: 900000,
    confirmationTimeoutMs: 30000,
    confirmationExpiryMs: 60000,
    promotionConsecutivePasses: 5,
    promotionVolatilityThreshold: 0.2,
    maxToolsPerSite: 20,
    toolShortlistK: 10,
    ...overrides,
  };
}

// ─── Skill fixtures ───────────────────────────────────────────────

export function makeSkill(overrides?: Partial<SkillSpec>): SkillSpec {
  const now = Date.now();
  return {
    id: 'example.com.get_users.v1',
    version: 1,
    status: SkillStatus.ACTIVE,
    currentTier: TierState.TIER_1_PROMOTED,
    tierLock: null,
    allowedDomains: ['example.com'],
    requiredCapabilities: [Capability.NET_FETCH_DIRECT],
    parameters: [
      { name: 'page', type: 'number', source: 'user_input', evidence: ['query param'] },
    ],
    validation: {
      semanticChecks: ['status_2xx'],
      customInvariants: [],
    },
    redaction: {
      piiClassesFound: [],
      fieldsRedacted: 0,
    },
    replayStrategy: 'prefer_tier_1',
    sideEffectClass: SideEffectClass.READ_ONLY,
    sampleCount: 10,
    consecutiveValidations: 5,
    confidence: 0.95,
    method: 'GET',
    pathTemplate: '/api/users',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'number' },
      },
    },
    isComposite: false,
    siteId: 'example.com',
    name: 'get_users',
    description: 'Get list of users',
    successRate: 0.98,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function makeDangerousSkill(overrides?: Partial<SkillSpec>): SkillSpec {
  return makeSkill({
    id: 'example.com.delete_user.v1',
    name: 'delete_user',
    method: 'DELETE',
    pathTemplate: '/api/users/:id',
    sideEffectClass: SideEffectClass.NON_IDEMPOTENT,
    ...overrides,
  });
}

export function makeUnvalidatedSkill(overrides?: Partial<SkillSpec>): SkillSpec {
  return makeSkill({
    id: 'example.com.new_endpoint.v1',
    name: 'new_endpoint',
    consecutiveValidations: 0,
    confidence: 0.5,
    ...overrides,
  });
}

// ─── Site fixtures ────────────────────────────────────────────────

export function makeSite(overrides?: Partial<SiteManifest>): SiteManifest {
  const now = Date.now();
  return {
    id: 'example.com',
    displayName: 'Example Site',
    firstSeen: now,
    lastVisited: now,
    masteryLevel: MasteryLevel.FULL,
    recommendedTier: ExecutionTier.DIRECT,
    totalRequests: 100,
    successfulRequests: 98,
    ...overrides,
  };
}

// ─── Policy fixture ───────────────────────────────────────────────

export function makeSitePolicy(overrides?: Partial<SitePolicy>): SitePolicy {
  return {
    siteId: 'example.com',
    allowedMethods: ['GET', 'HEAD'],
    maxQps: 10,
    maxConcurrent: 3,
    readOnlyDefault: true,
    requireConfirmation: [],
    domainAllowlist: ['example.com'],
    redactionRules: [],
    capabilities: [
      Capability.NET_FETCH_DIRECT,
      Capability.NET_FETCH_BROWSER_PROXIED,
      Capability.BROWSER_AUTOMATION,
      Capability.STORAGE_WRITE,
      Capability.SECRETS_USE,
    ],
    ...overrides,
  };
}

// ─── Audit entry fixture ──────────────────────────────────────────

export function makeAuditEntry(overrides?: Partial<AuditEntry>): AuditEntry {
  return {
    id: 'audit-' + Math.random().toString(36).slice(2),
    timestamp: Date.now(),
    skillId: 'example.com.get_users.v1',
    executionTier: ExecutionTier.DIRECT,
    success: true,
    latencyMs: 42,
    capabilityUsed: Capability.NET_FETCH_DIRECT,
    policyDecision: {
      proposed: 'GET /api/users',
      policyResult: 'allowed',
      policyRule: 'engine.executeSkill',
      userConfirmed: null,
      redactionsApplied: [],
    },
    previousHash: '0'.repeat(64),
    entryHash: 'a'.repeat(64),
    ...overrides,
  };
}

// ─── Policy decision fixture ──────────────────────────────────────

export function makePolicyDecision(
  overrides?: Partial<PolicyDecision>,
): PolicyDecision {
  return {
    proposed: 'GET /api/users',
    policyResult: 'allowed',
    policyRule: 'engine.executeSkill',
    userConfirmed: null,
    redactionsApplied: [],
    ...overrides,
  };
}
