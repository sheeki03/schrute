import { getLogger } from '../core/logger.js';
import type {
  SkillSpec,
  ExecutionTierName,
  FailureCauseName,
  SealedFetchRequest,
  SealedFetchResponse,
  BrowserProvider,
  CapabilityName,
  AuditEntry,
  PolicyDecision,
} from '../skill/types.js';
import {
  ExecutionTier,
  FailureCause,
  FAILURE_CAUSE_PRECEDENCE,
  Capability,
  TierState,
} from '../skill/types.js';
import { buildRequest, extractDomain } from './request-builder.js';
import { parseResponse } from './response-parser.js';
import { checkSemanticNative as checkSemantic } from '../native/semantic-diff.js';
import { AuditLog } from './audit-log.js';
import { ToolBudgetTracker } from './tool-budget.js';
import {
  checkCapability,
  enforceDomainAllowlist,
  resolveAndValidate,
  checkRedirectAllowed,
} from '../core/policy.js';
import { getConfig } from '../core/config.js';
import type { MetricsRepository } from '../storage/metrics-repository.js';

const log = getLogger();

// ─── Types ──────────────────────────────────────────────────────

export interface ExecutionResult {
  success: boolean;
  tier: ExecutionTierName;
  status: number;
  data: unknown;
  rawBody: string;
  headers: Record<string, string>;
  latencyMs: number;
  schemaMatch: boolean;
  semanticPass: boolean;
  failureCause?: FailureCauseName;
  auditIncomplete?: boolean;
}

export interface ExecutorOptions {
  browserProvider?: BrowserProvider;
  auditLog?: AuditLog;
  budgetTracker?: ToolBudgetTracker;
  policyDecision?: PolicyDecision;
  /** Metrics repository for historical success lookups */
  metricsRepo?: MetricsRepository;
  /** Override fetch for testing */
  fetchFn?: (req: SealedFetchRequest) => Promise<SealedFetchResponse>;
  /** Force a specific tier */
  forceTier?: ExecutionTierName;
  timeoutMs?: number;
}

// ─── Execute Skill ──────────────────────────────────────────────

export async function executeSkill(
  skill: SkillSpec,
  params: Record<string, unknown>,
  options?: ExecutorOptions,
): Promise<ExecutionResult> {
  const startTime = Date.now();

  // Determine starting tier
  const startingTier = options?.forceTier ?? determineTier(skill);

  log.info(
    { skillId: skill.id, tier: startingTier, method: skill.method },
    'Executing skill',
  );

  // Extract target domain from pathTemplate for budget/policy checks
  const targetDomain = extractDomain(
    skill.pathTemplate.startsWith('http')
      ? skill.pathTemplate
      : `https://${skill.allowedDomains[0] ?? skill.siteId}${skill.pathTemplate}`,
  );

  // Pre-build request to get body size for budget check
  const preBuiltRequest = buildRequest(skill, params, startingTier);
  const requestBodyBytes = preBuiltRequest.body
    ? new TextEncoder().encode(preBuiltRequest.body).byteLength
    : 0;

  // Budget check (Fix 3: include targetDomain and requestBodyBytes)
  if (options?.budgetTracker) {
    const budgetCheck = options.budgetTracker.checkBudget(skill.id, skill.siteId, {
      hasSecrets: skill.authType != null,
      targetDomain,
      requestBodyBytes,
    });
    if (!budgetCheck.allowed) {
      log.warn({ skillId: skill.id, reason: budgetCheck.reason }, 'Budget check failed');
      return failureResult(startTime, startingTier, 'unknown' as FailureCauseName);
    }
    options.budgetTracker.recordCall(skill.id, skill.siteId);
  }

  // Build policy decision for audit
  const policyDecision: PolicyDecision = options?.policyDecision ?? {
    proposed: `${skill.method} ${skill.pathTemplate}`,
    policyResult: 'allowed',
    policyRule: 'executor.default',
    userConfirmed: null,
    redactionsApplied: [],
  };

  // Fix 2: Record audit intent BEFORE execution in strict mode
  if (options?.auditLog) {
    const intentAudit = options.auditLog.appendEntry({
      id: `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      skillId: skill.id,
      executionTier: startingTier,
      success: false, // intent — not yet executed
      latencyMs: 0,
      capabilityUsed: tierToCapability(startingTier),
      policyDecision,
      requestSummary: {
        method: skill.method,
        url: skill.pathTemplate,
      },
    });

    if ('type' in intentAudit && intentAudit.type === 'audit_write_error') {
      if (options.auditLog.isStrictMode()) {
        log.error({ skillId: skill.id }, 'Audit intent write failed in strict mode — aborting execution');
        if (options.budgetTracker) {
          options.budgetTracker.releaseCall(skill.siteId);
        }
        const abortResult = failureResult(startTime, startingTier, FailureCause.UNKNOWN);
        abortResult.auditIncomplete = true;
        return abortResult;
      } else {
        log.warn({ skillId: skill.id }, 'Audit intent write failed — flagged as audit_incomplete');
      }
    }
  }

  let result: ExecutionResult;
  try {
    result = await executeTier(skill, params, startingTier, options);
  } catch (err) {
    log.error({ skillId: skill.id, err }, 'Execution threw an error');
    result = failureResult(startTime, startingTier, FailureCause.UNKNOWN);
  } finally {
    if (options?.budgetTracker) {
      options.budgetTracker.releaseCall(skill.siteId);
    }
  }

  // Record audit outcome AFTER execution
  if (options?.auditLog) {
    const outcomeAudit = options.auditLog.appendEntry({
      id: `exec-outcome-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      skillId: skill.id,
      executionTier: result.tier,
      success: result.success,
      latencyMs: result.latencyMs,
      errorType: result.failureCause,
      capabilityUsed: tierToCapability(result.tier),
      policyDecision,
      requestSummary: {
        method: skill.method,
        url: skill.pathTemplate,
      },
      responseSummary: {
        status: result.status,
        schemaMatch: result.schemaMatch,
      },
    });

    if ('type' in outcomeAudit && outcomeAudit.type === 'audit_write_error') {
      if (options.auditLog.isStrictMode()) {
        result.success = false;
        result.auditIncomplete = true;
        log.error({ skillId: skill.id }, 'Audit outcome write failed in strict mode');
      } else {
        result.auditIncomplete = true;
        log.warn({ skillId: skill.id }, 'Audit outcome write failed — flagged as audit_incomplete');
      }
    }
  }

  return result;
}

// ─── Tier Execution ─────────────────────────────────────────────

async function executeTier(
  skill: SkillSpec,
  params: Record<string, unknown>,
  tier: ExecutionTierName,
  options?: ExecutorOptions,
): Promise<ExecutionResult> {
  const startTime = Date.now();
  const timeoutMs = options?.timeoutMs ??
    (options?.budgetTracker?.getTimeoutMs(tier) ?? 30000);

  const request = buildRequest(skill, params, tier);

  // ── Fix 1: Policy / security gates before any network call ──

  // 1a. Capability check
  const capCheck = checkCapability(skill.siteId, tierToCapability(tier));
  if (!capCheck.allowed) {
    log.warn({ skillId: skill.id, tier, rule: capCheck.rule }, 'Capability not allowed');
    return failureResult(startTime, tier, FailureCause.UNKNOWN);
  }

  // 1b. Domain allowlist check
  const requestDomain = extractDomain(request.url);
  if (requestDomain) {
    const domainCheck = enforceDomainAllowlist(skill.siteId, requestDomain);
    if (!domainCheck.allowed) {
      log.warn({ skillId: skill.id, domain: requestDomain, rule: domainCheck.rule }, 'Domain not allowlisted');
      return failureResult(startTime, tier, FailureCause.UNKNOWN);
    }
  }

  // 1c. Private IP blocking (resolve hostname, reject if private)
  if (requestDomain) {
    const ipCheck = await resolveAndValidate(requestDomain);
    if (!ipCheck.allowed) {
      log.warn({ skillId: skill.id, domain: requestDomain, ip: ipCheck.ip, category: ipCheck.category }, 'Private IP blocked');
      return failureResult(startTime, tier, FailureCause.UNKNOWN);
    }
  }

  // Determine max response size for body capping
  const maxResponseBytes = options?.budgetTracker
    ? options.budgetTracker.getMaxResponseBytes()
    : getConfig().payloadLimits.maxResponseBodyBytes;

  let response: SealedFetchResponse;
  try {
    if (tier === ExecutionTier.DIRECT) {
      response = await withTimeout(directFetch(request, maxResponseBytes, options?.fetchFn), timeoutMs);
    } else if (tier === ExecutionTier.BROWSER_PROXIED) {
      if (!options?.browserProvider) {
        // Fall back to direct fetch if no browser provider
        response = await withTimeout(directFetch(request, maxResponseBytes, options?.fetchFn), timeoutMs);
      } else {
        response = await withTimeout(options.browserProvider.evaluateFetch(request), timeoutMs);
      }
    } else if (tier === ExecutionTier.FULL_BROWSER) {
      if (!options?.browserProvider) {
        return failureResult(startTime, tier, FailureCause.UNKNOWN);
      }
      // Full browser automation: navigate + extract
      response = await withTimeout(fullBrowserExecution(skill, options.browserProvider), timeoutMs);
    } else {
      response = await withTimeout(directFetch(request, maxResponseBytes, options?.fetchFn), timeoutMs);
    }
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    log.warn({ skillId: skill.id, tier, err, latencyMs }, 'Tier execution failed');
    return {
      success: false,
      tier,
      status: 0,
      data: null,
      rawBody: '',
      headers: {},
      latencyMs,
      schemaMatch: false,
      semanticPass: false,
      failureCause: FailureCause.UNKNOWN,
    };
  }

  // 1d. Redirect validation: if response is 3xx with Location header, check domain
  if (response.status >= 300 && response.status < 400 && response.headers['location']) {
    const redirectCheck = checkRedirectAllowed(skill.siteId, response.headers['location']);
    if (!redirectCheck.allowed) {
      log.warn(
        { skillId: skill.id, location: response.headers['location'], rule: redirectCheck.rule },
        'Redirect to disallowed domain blocked',
      );
      return failureResult(startTime, tier, FailureCause.UNKNOWN);
    }
  }

  const latencyMs = Date.now() - startTime;

  // Parse response
  const parsed = parseResponse(
    { status: response.status, headers: response.headers, body: response.body },
    skill,
  );

  // Semantic check
  const semantic = checkSemantic(
    { status: response.status, headers: response.headers, body: response.body },
    skill,
  );

  // Classify failure if not successful
  const httpSuccess = response.status >= 200 && response.status < 300;
  const overallSuccess = httpSuccess && parsed.schemaMatch && semantic.pass && parsed.errors.length === 0;

  let failureCause: FailureCauseName | undefined;
  if (!overallSuccess) {
    failureCause = await classifyFailure(response, parsed, semantic, skill, tier, params, options);
  }

  return {
    success: overallSuccess,
    tier,
    status: response.status,
    data: parsed.data,
    rawBody: response.body,
    headers: response.headers,
    latencyMs,
    schemaMatch: parsed.schemaMatch,
    semanticPass: semantic.pass,
    failureCause,
  };
}

// ─── Failure Classification ─────────────────────────────────────

async function classifyFailure(
  response: SealedFetchResponse,
  parsed: ReturnType<typeof parseResponse>,
  semantic: ReturnType<typeof checkSemantic>,
  skill: SkillSpec,
  tier: ExecutionTierName,
  params: Record<string, unknown>,
  options?: ExecutorOptions,
): Promise<FailureCauseName> {
  // STRICT PRECEDENCE ORDER — first match wins

  // 1. rate_limited: 429 status only
  if (response.status === 429) {
    return FailureCause.RATE_LIMITED;
  }

  // 2. endpoint_removed: 404/410 only if the endpoint had 2+ historical successes
  if (response.status === 404 || response.status === 410) {
    if (options?.metricsRepo) {
      const metrics = options.metricsRepo.getBySkillId(skill.id);
      const historicalSuccessCount = metrics.filter((m) => m.success).length;
      if (historicalSuccessCount >= 2) {
        return FailureCause.ENDPOINT_REMOVED;
      }
    }
    // Without metrics data or insufficient history, fall through to UNKNOWN
  }

  // 3-5. js_computed_field / protocol_sensitivity / signed_payload
  // First check if already known via permanent tier lock
  if (skill.tierLock?.type === 'permanent' && skill.tierLock.reason === 'js_computed_field') {
    return FailureCause.JS_COMPUTED_FIELD;
  }
  if (skill.tierLock?.type === 'permanent' && skill.tierLock.reason === 'protocol_sensitivity') {
    return FailureCause.PROTOCOL_SENSITIVITY;
  }
  if (skill.tierLock?.type === 'permanent' && skill.tierLock.reason === 'signed_payload') {
    return FailureCause.SIGNED_PAYLOAD;
  }

  // Live tier comparison: if Tier 1 fails, try Tier 3 and compare
  if (tier === ExecutionTier.DIRECT && options?.browserProvider) {
    try {
      const tier3Request = buildRequest(skill, params, ExecutionTier.BROWSER_PROXIED);
      const tier3Response = await options.browserProvider.evaluateFetch(tier3Request);
      const tier3Parsed = parseResponse(
        { status: tier3Response.status, headers: tier3Response.headers, body: tier3Response.body },
        skill,
      );
      const tier3HttpOk = tier3Response.status >= 200 && tier3Response.status < 300;

      if (tier3HttpOk && tier3Parsed.schemaMatch) {
        // Tier 3 succeeds where Tier 1 failed
        if (!parsed.schemaMatch && tier3Parsed.schemaMatch) {
          // Schema mismatch on Tier 1 but match on Tier 3 => js_computed_field
          return FailureCause.JS_COMPUTED_FIELD;
        }
        if (tier3Response.body !== response.body) {
          // Different response bodies suggest protocol_sensitivity
          return FailureCause.PROTOCOL_SENSITIVITY;
        }
        // Tier 3 succeeds but can't distinguish => signed_payload as fallback
        return FailureCause.SIGNED_PAYLOAD;
      }
    } catch (err) {
      log.debug({ skillId: skill.id, err }, 'Tier comparison probe failed, continuing classification');
    }
  }

  // 6. schema_drift: 200 OK but response doesn't match stored schema
  if (response.status >= 200 && response.status < 300 && !parsed.schemaMatch) {
    return FailureCause.SCHEMA_DRIFT;
  }

  // 7-8. auth_expired vs cookie_refresh on 401/403
  if (response.status === 401 || response.status === 403) {
    // Token-based auth (bearer, api_key, oauth2) => auth_expired
    // Cookie-based auth or no explicit auth => cookie_refresh
    if (skill.authType && skill.authType !== 'cookie') {
      return FailureCause.AUTH_EXPIRED;
    }
    return FailureCause.COOKIE_REFRESH;
  }

  // 9. unknown: none matched
  return FailureCause.UNKNOWN;
}

// ─── Fetch Implementations ──────────────────────────────────────

async function directFetch(
  request: SealedFetchRequest & { url: string; method: string; headers: Record<string, string>; body?: string },
  maxResponseBytes: number,
  fetchFn?: (req: SealedFetchRequest) => Promise<SealedFetchResponse>,
): Promise<SealedFetchResponse> {
  if (fetchFn) {
    return fetchFn(request);
  }

  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  // Fix 4: Read response body incrementally with size cap enforcement.
  // If the body exceeds maxResponseBytes, abort reading and throw.
  let body: string;
  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxResponseBytes) {
          reader.cancel();
          throw new Error(
            `Response body exceeded maxResponseBodyBytes (${maxResponseBytes}). ` +
            `Read ${totalBytes} bytes before aborting.`,
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const decoder = new TextDecoder();
    body = chunks.map((c) => decoder.decode(c, { stream: true })).join('') +
      decoder.decode();
  } else {
    body = await response.text();
  }

  return { status: response.status, headers, body };
}

async function fullBrowserExecution(
  skill: SkillSpec,
  browser: BrowserProvider,
): Promise<SealedFetchResponse> {
  // Navigate to the skill's domain
  const domain = skill.allowedDomains[0] ?? skill.siteId;
  await browser.navigate(`https://${domain}`);

  // Take a snapshot and extract network requests
  const requests = await browser.networkRequests();

  // Find the matching request by path pattern
  const matching = requests.find((r) =>
    r.url.includes(skill.pathTemplate.split('{')[0]) &&
    r.method.toUpperCase() === skill.method.toUpperCase(),
  );

  if (matching && matching.responseBody) {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(matching.responseHeaders)) {
      headers[key.toLowerCase()] = value;
    }
    return {
      status: matching.status,
      headers,
      body: matching.responseBody,
    };
  }

  // Fallback: return empty response
  return { status: 0, headers: {}, body: '' };
}

// ─── Helpers ────────────────────────────────────────────────────

function determineTier(skill: SkillSpec): ExecutionTierName {
  // If there's a permanent tier lock, respect it
  if (skill.tierLock?.type === 'permanent') {
    return ExecutionTier.BROWSER_PROXIED; // locked to Tier 3+
  }

  // If tier lock is temporary demotion
  if (skill.tierLock?.type === 'temporary_demotion') {
    return ExecutionTier.BROWSER_PROXIED;
  }

  // Use current tier
  if (skill.currentTier === 'tier_1') {
    return ExecutionTier.DIRECT;
  }

  // Default to Tier 3
  return ExecutionTier.BROWSER_PROXIED;
}

function tierToCapability(tier: ExecutionTierName): CapabilityName {
  switch (tier) {
    case ExecutionTier.DIRECT:
      return Capability.NET_FETCH_DIRECT;
    case ExecutionTier.BROWSER_PROXIED:
      return Capability.NET_FETCH_BROWSER_PROXIED;
    case ExecutionTier.FULL_BROWSER:
      return Capability.BROWSER_AUTOMATION;
    default:
      return Capability.NET_FETCH_DIRECT;
  }
}

function failureResult(startTime: number, tier: ExecutionTierName, cause: FailureCauseName): ExecutionResult {
  return {
    success: false,
    tier,
    status: 0,
    data: null,
    rawBody: '',
    headers: {},
    latencyMs: Date.now() - startTime,
    schemaMatch: false,
    semanticPass: false,
    failureCause: cause,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Execution timed out after ${ms}ms`));
    }, ms);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}
