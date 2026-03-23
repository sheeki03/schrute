import { randomUUID } from 'node:crypto';
import * as https from 'node:https';
import * as http from 'node:http';
import { getLogger } from '../core/logger.js';
import { withTimeout } from '../core/utils.js';
import { getEffectiveTier } from '../core/tiering.js';
import { redactNative } from '../native/redactor.js';
import { getCachedSalt } from '../storage/redactor.js';
import type {
  SkillSpec,
  ExecutionTierName,
  FailureCauseName,
  SealedFetchRequest,
  SealedFetchResponse,
  BrowserProvider,
  CapabilityName,
  PolicyDecision,
} from '../skill/types.js';
import {
  ExecutionTier,
  FailureCause,
  Capability,
} from '../skill/types.js';
import { buildRequest, extractDomain } from './request-builder.js';
import { redactString } from '../storage/redactor.js';
import { parseResponse } from './response-parser.js';
import { checkSemanticNative as checkSemantic } from '../native/semantic-diff.js';
import { AuditLog } from './audit-log.js';
import { ToolBudgetTracker } from './tool-budget.js';
import { isCloudflareChallengeSignal } from '../shared/cloudflare-challenge.js';
import {
  checkCapability,
  enforceDomainAllowlist,
  resolveAndValidate,
  checkRedirectAllowed,
  getSitePolicy,
  matchesDomainAllowlist,
  sanitizeImplicitAllowlist,
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
  failureDetail?: string;
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
  /** Config for policy scoping — avoids falling back to global singleton */
  config?: import('../skill/types.js').SchruteConfig;
  /** Lazy browser provider factory — creates provider on demand */
  browserProviderFactory?: () => Promise<BrowserProvider | undefined>;
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

  // Budget check — include targetDomain and requestBodyBytes for accurate budget tracking
  if (options?.budgetTracker) {
    const budgetCheck = options.budgetTracker.checkBudget(skill.id, skill.siteId, {
      hasSecrets: skill.authType != null,
      targetDomain,
      requestBodyBytes,
    });
    if (!budgetCheck.allowed) {
      log.warn({ skillId: skill.id, reason: budgetCheck.reason }, 'Budget check failed');
      return failureResult(startTime, startingTier, FailureCause.BUDGET_DENIED, `Budget exceeded for skill '${skill.id}': ${budgetCheck.reason}`);
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

  // Record audit intent before execution to ensure strict-mode audit trail completeness even on crash
  if (options?.auditLog) {
    const redactedUrl = await redactPathTemplate(skill.pathTemplate);
    const intentAudit = options.auditLog.appendEntry({
      id: `exec-${Date.now()}-${randomUUID()}`,
      timestamp: Date.now(),
      skillId: skill.id,
      executionTier: startingTier,
      success: false, // intent — not yet executed
      latencyMs: 0,
      capabilityUsed: tierToCapability(startingTier),
      policyDecision,
      requestSummary: {
        method: skill.method,
        url: redactedUrl,
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
    const redactedOutcomeUrl = await redactPathTemplate(skill.pathTemplate);
    const outcomeAudit = options.auditLog.appendEntry({
      id: `exec-outcome-${Date.now()}-${randomUUID()}`,
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
        url: redactedOutcomeUrl,
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

  // ── Policy and security gates run before any network call to prevent SSRF and unauthorized access ──

  // 1a. Capability check
  const capCheck = checkCapability(skill.siteId, tierToCapability(tier), options?.config);
  if (!capCheck.allowed) {
    log.warn({ skillId: skill.id, tier, rule: capCheck.rule }, 'Capability not allowed');
    return failureResult(startTime, tier, FailureCause.POLICY_DENIED, `Capability '${tierToCapability(tier)}' is not enabled for site '${skill.siteId}'`);
  }

  // 1b. Domain allowlist check
  const requestDomain = extractDomain(request.url);
  if (requestDomain) {
    const allowlist = getEffectiveAllowlist(skill, options?.config);
    if (!allowlist.explicit && allowlist.domains.length === 0) {
      log.warn({ skillId: skill.id, rule: 'domain.implicit_empty_after_sanitize' },
        'Implicit allowlist empty after sanitization — blocking');
      return failureResult(startTime, tier, FailureCause.POLICY_DENIED, `Domain allowlist empty after sanitization for skill '${skill.id}'`);
    }
    if (!allowlist.explicit && options?.policyDecision) {
      options.policyDecision.derivedAllowlist = allowlist.domains;
    }
    if (allowlist.explicit) {
      const domainCheck = enforceDomainAllowlist(skill.siteId, requestDomain, options?.config);
      if (!domainCheck.allowed) {
        log.warn({ skillId: skill.id, domain: requestDomain, rule: domainCheck.rule }, 'Domain not allowlisted');
        return failureResult(startTime, tier, FailureCause.POLICY_DENIED, `Domain '${requestDomain}' is not in the site policy allowlist for '${skill.siteId}'`);
      }
    } else if (!matchesDomainAllowlist(requestDomain, allowlist.domains)) {
      log.warn({ skillId: skill.id, domain: requestDomain, rule: 'domain.implicit_skill_allowlist' },
        'Domain not in skill allowlist (no explicit policy)');
      return failureResult(startTime, tier, FailureCause.POLICY_DENIED, `Domain '${requestDomain}' is not in the skill allowlist for '${skill.siteId}'`);
    }
  }

  // 1c. Private IP blocking (resolve hostname, reject if private)
  // Pin the resolved IP to prevent DNS rebinding TOCTOU attacks (CR-01):
  // resolveAndValidate returns the IP that passed validation. We substitute
  // it into the fetch URL so fetch() connects to the validated IP, not a
  // potentially different one from a second DNS lookup.
  let resolvedIp: string | undefined;
  if (requestDomain) {
    const ipCheck = await resolveAndValidate(requestDomain);
    if (!ipCheck.allowed) {
      log.warn({ skillId: skill.id, domain: requestDomain, ip: ipCheck.ip, category: ipCheck.category }, 'Private IP blocked');
      return failureResult(startTime, tier, FailureCause.POLICY_DENIED, `Domain '${requestDomain}' resolves to private IP ${ipCheck.ip} (SSRF protection)`);
    }
    resolvedIp = ipCheck.ip;
  }

  // Determine max response size for body capping
  const maxResponseBytes = options?.budgetTracker
    ? options.budgetTracker.getMaxResponseBytes()
    : (options?.config ?? getConfig()).payloadLimits.maxResponseBodyBytes;

  // Resolve browser provider once — used for both initial fetch and redirect following
  let resolvedBrowserProvider = options?.browserProvider;
  if (!resolvedBrowserProvider && options?.browserProviderFactory &&
      (tier === ExecutionTier.BROWSER_PROXIED || tier === ExecutionTier.FULL_BROWSER)) {
    resolvedBrowserProvider = await options.browserProviderFactory();
  }

  let response: SealedFetchResponse;
  try {
    if (tier === ExecutionTier.BROWSER_PROXIED || tier === ExecutionTier.FULL_BROWSER) {
      if (!resolvedBrowserProvider) {
        if (tier === ExecutionTier.BROWSER_PROXIED) {
          log.warn({ skillId: skill.id, tier }, 'browser_proxied tier requested but no browser provider available');
        }
        return failureResult(startTime, tier, FailureCause.POLICY_DENIED, `No browser session available for site '${skill.siteId}'. Start one with schrute_explore.`);
      }
      const fetchPromise = tier === ExecutionTier.FULL_BROWSER
        ? fullBrowserExecution(skill, resolvedBrowserProvider)
        : resolvedBrowserProvider.evaluateFetch(request);
      response = await withTimeout(fetchPromise, timeoutMs);

    // Post-fetch DNS re-check for browser-proxied tier (defense-in-depth).
    // Catches sustained DNS rebinding (not single-TTL attacks — accepted limitation).
    if (tier === ExecutionTier.BROWSER_PROXIED && requestDomain) {
      const postCheck = await resolveAndValidate(requestDomain);
      if (!postCheck.allowed) {
        log.warn({ skillId: skill.id, domain: requestDomain, ip: postCheck.ip },
          'DNS rebinding detected — domain resolved to private IP after browser fetch');
        return failureResult(startTime, tier, FailureCause.POLICY_DENIED, `DNS rebinding detected: '${requestDomain}' resolved to private IP after fetch`);
      }
    }
    } else {
      // ExecutionTier.DIRECT or unknown — use direct fetch.
      // Both paths handle their own timeout cancellation:
      // - Pinned IP: socket-level timeout via req.setTimeout() destroys the request
      // - Non-pinned: AbortController.abort() tears down the fetch connection
      // No outer withTimeout needed — avoids leaked I/O from promise races.
      response = await directFetch(request, maxResponseBytes, options?.fetchFn, resolvedIp, timeoutMs);
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
      failureCause: FailureCause.FETCH_ERROR,
      failureDetail: err instanceof Error ? err.message : String(err),
    };
  }

  // Enforce body size limit for browser tiers (directFetch enforces its own limit
  // via incremental reading, but browser tiers bypass that path)
  if (
    (tier === ExecutionTier.BROWSER_PROXIED || tier === ExecutionTier.FULL_BROWSER) &&
    response.body && maxResponseBytes > 0
  ) {
    const bodyBytes = Buffer.from(response.body, 'utf-8');
    if (bodyBytes.length > maxResponseBytes) {
      response = { ...response, body: bodyBytes.subarray(0, maxResponseBytes).toString('utf-8') };
      log.warn({ tier, bodySize: bodyBytes.length, maxResponseBytes }, 'Browser-tier response truncated');
    }
  }

  // 1d. Manual redirect loop: follow safe redirects, block disallowed domains/IPs
  //
  // Redirect chain handling:
  // - Max redirect hops: 5 (MAX_REDIRECTS). Exceeding this silently stops following.
  // - Cross-domain policy: Each hop's target domain is checked against the site's
  //   domain allowlist (explicit policy) or the skill's declared allowedDomains +
  //   siteId (implicit allowlist). If the redirect target is not allowlisted, the
  //   request is blocked and a failure result is returned.
  // - Private IP blocking: Each hop's target hostname is DNS-resolved and rejected
  //   if it points to a private/internal IP range (SSRF protection).
  // - Relative URL resolution: Location headers are resolved relative to the
  //   CURRENT hop's URL (not the original request URL), tracked via currentUrl.
  // - Why manual redirect handling: fetch's built-in redirect following would
  //   bypass domain allowlist checks, private IP validation, and per-hop auditing,
  //   which are all security-critical. We use `redirect: 'manual'` in directFetch
  //   and implement the redirect loop here with full policy enforcement per hop.
  let finalResponse = response;
  // FULL_BROWSER tier: browser handles navigation; domain allowlist + page sandbox provides security boundary.
  // For DIRECT and BROWSER_PROXIED tiers, we manually follow redirects with per-hop validation.
  if (tier !== ExecutionTier.FULL_BROWSER) {
  let redirectCount = 0;
  const MAX_REDIRECTS = 5;
  let currentUrl = request.url;  // Track current URL through redirect chain

  while (
    finalResponse.status >= 300 && finalResponse.status < 400 &&
    finalResponse.headers['location'] &&
    redirectCount < MAX_REDIRECTS
  ) {
    const locationHeader = finalResponse.headers['location'];
    // Resolve relative against CURRENT hop's URL, not initial request
    const resolvedUrl = new URL(locationHeader, currentUrl).toString();

    // Domain check: use implicit allowlist if no explicit policy
    const redirectDomain = extractDomain(resolvedUrl);
    if (redirectDomain) {
      const allowlist = getEffectiveAllowlist(skill, options?.config);
      if (allowlist.explicit) {
        const redirectCheck = checkRedirectAllowed(skill.siteId, resolvedUrl, currentUrl, options?.config);
        if (!redirectCheck.allowed) {
          log.warn({ skillId: skill.id, location: resolvedUrl, rule: redirectCheck.rule },
            'Redirect to disallowed domain blocked');
          return failureResult(startTime, tier, FailureCause.POLICY_DENIED, `Redirect to '${resolvedUrl}' blocked by policy rule '${redirectCheck.rule}' for '${skill.siteId}'`);
        }
      } else if (!matchesDomainAllowlist(redirectDomain, allowlist.domains)) {
        log.warn({ skillId: skill.id, location: resolvedUrl, rule: 'redirect.implicit_skill_allowlist' },
          'Redirect to domain not in skill allowlist');
        return failureResult(startTime, tier, FailureCause.POLICY_DENIED, `Redirect to domain '${redirectDomain}' not in skill allowlist [${allowlist.domains.join(', ')}]`);
      }

      // IP check — also pin the resolved IP for the redirect fetch
      const ipCheck = await resolveAndValidate(redirectDomain);
      if (!ipCheck.allowed) {
        log.warn({ skillId: skill.id, domain: redirectDomain, ip: ipCheck.ip }, 'Redirect to private IP blocked');
        return failureResult(startTime, tier, FailureCause.POLICY_DENIED, `Redirect target '${redirectDomain}' resolves to private IP ${ipCheck.ip} (SSRF protection)`);
      }
      resolvedIp = ipCheck.ip;
    }

    let redirectResp: SealedFetchResponse;
    if ((tier === ExecutionTier.BROWSER_PROXIED) && resolvedBrowserProvider) {
      // Follow redirect through browser context (preserves cookies, TLS, CORS)
      redirectResp = await withTimeout(resolvedBrowserProvider.evaluateFetch({ ...request, url: resolvedUrl }), timeoutMs);
    } else {
      redirectResp = await directFetch(
        { ...request, url: resolvedUrl },
        maxResponseBytes,
        options?.fetchFn,
        resolvedIp,
        timeoutMs,
      );
    }
    finalResponse = redirectResp;
    currentUrl = resolvedUrl;  // Update for next hop
    redirectCount++;
  }

  // Fail-closed: if a browser-proxied response is still 3xx but has no Location,
  // it means the redirect couldn't be followed (opaque redirect, CORS restriction).
  // Treat as failure rather than silently returning the 3xx.
  if (
    tier === ExecutionTier.BROWSER_PROXIED &&
    finalResponse.status >= 300 && finalResponse.status < 400 &&
    !finalResponse.headers['location']
  ) {
    log.warn({ skillId: skill.id, tier, status: finalResponse.status },
      'Browser-proxied fetch returned redirect without readable Location header — failing closed');
    return failureResult(startTime, tier, FailureCause.POLICY_DENIED, `Browser-proxied response returned status ${finalResponse.status} without Location header for '${skill.siteId}'`);
  }
  } // end if (tier !== ExecutionTier.FULL_BROWSER)

  const latencyMs = Date.now() - startTime;

  // Parse response
  const parsed = parseResponse(
    { status: finalResponse.status, headers: finalResponse.headers, body: finalResponse.body },
    skill,
  );

  // Semantic check
  const semantic = checkSemantic(
    { status: finalResponse.status, headers: finalResponse.headers, body: finalResponse.body },
    skill,
  );

  // Classify failure if not successful
  const httpSuccess = finalResponse.status >= 200 && finalResponse.status < 300;
  const overallSuccess = httpSuccess && parsed.schemaMatch && semantic.pass && parsed.errors.length === 0;

  let failureCause: FailureCauseName | undefined;
  if (!overallSuccess) {
    failureCause = await classifyFailure(finalResponse, parsed, semantic, skill, tier, params, options);
  }

  return {
    success: overallSuccess,
    tier,
    status: finalResponse.status,
    data: parsed.data,
    rawBody: finalResponse.body,
    headers: finalResponse.headers,
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

  if (isCloudflareChallengeResponse(response)) {
    return FailureCause.CLOUDFLARE_CHALLENGE;
  }

  // 2.5: Server errors (5xx) — map to UNKNOWN with better logging
  if (response.status >= 500 && response.status < 600) {
    log.info({ skillId: skill.id, status: response.status }, 'Server error (5xx) — classified as UNKNOWN');
    return FailureCause.UNKNOWN;
  }

  // 3-5. js_computed_field / protocol_sensitivity / signed_payload
  // First check if already known via permanent tier lock
  if (skill.tierLock?.type === 'permanent') {
    const lockCauseMap: Record<string, FailureCauseName> = {
      js_computed_field: FailureCause.JS_COMPUTED_FIELD,
      protocol_sensitivity: FailureCause.PROTOCOL_SENSITIVITY,
      signed_payload: FailureCause.SIGNED_PAYLOAD,
    };
    const lockCause = lockCauseMap[skill.tierLock.reason];
    if (lockCause) return lockCause;
  }

  // Live tier comparison: if Tier 1 fails, try Tier 3 and compare
  if (tier === ExecutionTier.DIRECT && options?.browserProvider) {
    try {
      const tier3Request = buildRequest(skill, params, ExecutionTier.BROWSER_PROXIED);
      const comparisonTimeout = options?.timeoutMs ?? 30000;
      const tier3Response = await withTimeout(options.browserProvider.evaluateFetch(tier3Request), comparisonTimeout);
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
      log.warn({ skillId: skill.id, err }, 'Tier comparison probe failed');
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

function isCloudflareChallengeResponse(response: SealedFetchResponse): boolean {
  return isCloudflareChallengeSignal({
    headers: response.headers,
    content: response.body,
  });
}

// ─── Fetch Implementations ──────────────────────────────────────

async function directFetch(
  request: SealedFetchRequest & { url: string; method: string; headers: Record<string, string>; body?: string },
  maxResponseBytes: number,
  fetchFn?: (req: SealedFetchRequest) => Promise<SealedFetchResponse>,
  pinnedIp?: string,
  timeoutMs?: number,
): Promise<SealedFetchResponse> {
  if (fetchFn) {
    // Injected fetch functions (e.g. test mocks) still need a timeout guard
    // since the caller no longer wraps directFetch in withTimeout.
    if (timeoutMs) {
      return withTimeout(fetchFn(request), timeoutMs);
    }
    return fetchFn(request);
  }

  // CR-01 + WS-1: When pinnedIp is set, use node:https/node:http directly.
  // This allows setting `servername` for correct TLS SNI while connecting to
  // the validated IP (preventing DNS rebinding TOCTOU attacks).
  // Using fetch() with an IP-rewritten URL breaks TLS because undici derives
  // SNI from the URL hostname, not the Host header.
  if (pinnedIp) {
    return pinnedIpFetch(request, pinnedIp, maxResponseBytes, timeoutMs);
  }

  // No pinned IP — use standard fetch() with redirect: 'manual'.
  // AbortSignal ensures the underlying connection is torn down on timeout
  // (without it, withTimeout races the promise but the fetch keeps running).
  const abortController = new AbortController();
  const abortTimeout = timeoutMs
    ? setTimeout(() => abortController.abort(), timeoutMs)
    : undefined;

  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'manual',  // never auto-follow redirects
      signal: abortController.signal,
    });
  } catch (err) {
    if (abortTimeout) clearTimeout(abortTimeout);
    throw err;
  }

  try {
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    // Read response body incrementally with size cap to prevent memory exhaustion.
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
  } finally {
    if (abortTimeout) clearTimeout(abortTimeout);
  }
}

/**
 * WS-1: Fetch using node:https/node:http with pinned IP and correct TLS SNI.
 *
 * Connects to `pinnedIp` (the pre-validated IP) while setting `servername`
 * to the original hostname so TLS certificate validation succeeds.
 * This fixes the cert mismatch that occurred when fetch() was given an
 * IP-rewritten URL (undici derives SNI from the URL hostname, ignoring Host).
 */
function pinnedIpFetch(
  request: SealedFetchRequest & { url: string; method: string; headers: Record<string, string>; body?: string },
  pinnedIp: string,
  maxResponseBytes: number,
  timeoutMs?: number,
): Promise<SealedFetchResponse> {
  return new Promise<SealedFetchResponse>((resolve, reject) => {
    const parsed = new URL(request.url);
    const isHttps = parsed.protocol === 'https:';
    const originalHost = parsed.hostname;
    const port = parsed.port
      ? Number(parsed.port)
      : (isHttps ? 443 : 80);
    const path = parsed.pathname + parsed.search;

    const reqHeaders: Record<string, string> = { ...request.headers };
    // Ensure Host header is set for correct virtual-host routing
    if (!reqHeaders['Host'] && !reqHeaders['host']) {
      reqHeaders['Host'] = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    }

    const baseOptions: http.RequestOptions = {
      hostname: pinnedIp,
      port,
      path,
      method: request.method,
      headers: reqHeaders,
    };

    // For HTTPS: set servername for correct TLS SNI and cert validation.
    // For IPv6 pinned IPs, hostname already works (node handles brackets internally).
    const options = isHttps
      ? { ...baseOptions, servername: originalHost, rejectUnauthorized: true } as https.RequestOptions
      : baseOptions;

    const transport = isHttps ? https : http;
    const effectiveTimeout = timeoutMs ?? 30_000;

    const req = transport.request(options, (res) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let aborted = false;

      res.on('data', (chunk: Buffer) => {
        if (aborted) return;
        totalBytes += chunk.length;
        if (totalBytes > maxResponseBytes) {
          aborted = true;
          res.destroy();
          reject(new Error(
            `Response body exceeded maxResponseBodyBytes (${maxResponseBytes}). ` +
            `Read ${totalBytes} bytes before aborting.`,
          ));
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        if (aborted) return;
        const headers: Record<string, string> = {};
        if (res.headers) {
          for (const [key, value] of Object.entries(res.headers)) {
            if (value != null) {
              headers[key] = Array.isArray(value) ? value.join(', ') : value;
            }
          }
        }
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve({ status: res.statusCode ?? 0, headers, body });
      });

      res.on('error', (err) => {
        if (!aborted) reject(err);
      });
    });

    req.setTimeout(effectiveTimeout, () => {
      req.destroy(new Error(`Request timed out after ${effectiveTimeout}ms`));
    });

    req.on('error', (err) => reject(err));

    if (request.body) {
      req.write(request.body);
    }
    req.end();
  });
}

async function fullBrowserExecution(
  skill: SkillSpec,
  browser: BrowserProvider,
): Promise<SealedFetchResponse> {
  // Navigate to the skill's domain
  const domain = skill.allowedDomains[0] ?? skill.siteId;
  await browser.navigate(`https://${domain}`);

  // Wait for in-flight XHR/fetch requests to settle. navigate() resolves on
  // DOMContentLoaded, which fires before most async API calls complete.
  // Without this delay, networkRequests() may return an incomplete list.
  await new Promise(resolve => setTimeout(resolve, 2000));

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

  // No matching request found in browser network traffic — fail explicitly
  // rather than returning a fabricated { status: 0 } response that would
  // be indistinguishable from a network-level failure.
  log.error({ skillId: skill.id }, 'Browser execution failed: no matching request found in network traffic');
  throw new Error(`Full browser execution found no matching request for ${skill.method} ${skill.pathTemplate}`);
}

// ─── Helpers ────────────────────────────────────────────────────

function determineTier(skill: SkillSpec): ExecutionTierName {
  if (skill.tierLock?.type === 'permanent' && skill.tierLock.reason === 'browser_required') {
    return ExecutionTier.BROWSER_PROXIED;
  }
  const tierState = getEffectiveTier(skill);
  return tierState === 'tier_1' ? ExecutionTier.DIRECT : ExecutionTier.BROWSER_PROXIED;
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

/**
 * Derive the effective domain allowlist for a skill: use the explicit
 * site policy if one exists, otherwise build an implicit list from the
 * skill's declared domains + siteId.
 */
function getEffectiveAllowlist(
  skill: SkillSpec,
  config?: import('../skill/types.js').SchruteConfig,
): { explicit: boolean; domains: string[] } {
  const policy = getSitePolicy(skill.siteId, config);
  if (policy.domainAllowlist.length > 0) {
    return { explicit: true, domains: policy.domainAllowlist };
  }
  const rawDomains = [...new Set([...skill.allowedDomains, skill.siteId])];
  return { explicit: false, domains: sanitizeImplicitAllowlist(rawDomains) };
}

function failureResult(startTime: number, tier: ExecutionTierName, cause: FailureCauseName, detail?: string): ExecutionResult {
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
    failureDetail: detail,
  };
}

// Shared redaction helper: prefers native (sync) redactor when salt is cached,
// falls back to async redactString otherwise. Avoids duplicating this
// salt-check-then-redact pattern at every audit call site.
async function redactPathTemplate(pathTemplate: string): Promise<string> {
  const salt = getCachedSalt();
  const nativeResult = salt ? redactNative(pathTemplate, salt) : null;
  return nativeResult != null ? String(nativeResult) : redactString(pathTemplate);
}
