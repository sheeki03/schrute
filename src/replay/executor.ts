import { getLogger } from '../core/logger.js';
import { withTimeout } from '../core/utils.js';
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
import { redactString } from '../storage/redactor.js';
import { parseResponse } from './response-parser.js';
import { checkSemanticNative as checkSemantic } from '../native/semantic-diff.js';
import { AuditLog } from './audit-log.js';
import { ToolBudgetTracker } from './tool-budget.js';
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
  config?: import('../skill/types.js').OneAgentConfig;
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
      return failureResult(startTime, startingTier, FailureCause.UNKNOWN);
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
    const redactedUrl = await redactString(skill.pathTemplate);
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
    const redactedOutcomeUrl = await redactString(skill.pathTemplate);
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

  // ── Fix 1: Policy / security gates before any network call ──

  // 1a. Capability check
  const capCheck = checkCapability(skill.siteId, tierToCapability(tier), options?.config);
  if (!capCheck.allowed) {
    log.warn({ skillId: skill.id, tier, rule: capCheck.rule }, 'Capability not allowed');
    return failureResult(startTime, tier, FailureCause.UNKNOWN);
  }

  // 1b. Domain allowlist check
  const requestDomain = extractDomain(request.url);
  if (requestDomain) {
    const policy = getSitePolicy(skill.siteId, options?.config);
    if (policy.domainAllowlist.length === 0) {
      // No explicit policy — use skill's declared domains + site host
      const rawDomains = [...new Set([...skill.allowedDomains, skill.siteId])];
      const implicitAllowlist = sanitizeImplicitAllowlist(rawDomains);
      if (implicitAllowlist.length === 0) {
        log.warn({ skillId: skill.id, rule: 'domain.implicit_empty_after_sanitize' },
          'Implicit allowlist empty after sanitization — blocking');
        return failureResult(startTime, tier, FailureCause.UNKNOWN);
      }
      // Persist derived allowlist for audit
      if (options?.policyDecision) {
        options.policyDecision.derivedAllowlist = implicitAllowlist;
      }
      if (!matchesDomainAllowlist(requestDomain, implicitAllowlist)) {
        log.warn({ skillId: skill.id, domain: requestDomain, rule: 'domain.implicit_skill_allowlist' },
          'Domain not in skill allowlist (no explicit policy)');
        return failureResult(startTime, tier, FailureCause.UNKNOWN);
      }
    } else {
      const domainCheck = enforceDomainAllowlist(skill.siteId, requestDomain, options?.config);
      if (!domainCheck.allowed) {
        log.warn({ skillId: skill.id, domain: requestDomain, rule: domainCheck.rule }, 'Domain not allowlisted');
        return failureResult(startTime, tier, FailureCause.UNKNOWN);
      }
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
      return failureResult(startTime, tier, FailureCause.UNKNOWN);
    }
    resolvedIp = ipCheck.ip;
  }

  // Determine max response size for body capping
  const maxResponseBytes = options?.budgetTracker
    ? options.budgetTracker.getMaxResponseBytes()
    : (options?.config ?? getConfig()).payloadLimits.maxResponseBodyBytes;

  let response: SealedFetchResponse;
  try {
    if (tier === ExecutionTier.DIRECT) {
      response = await withTimeout(directFetch(request, maxResponseBytes, options?.fetchFn, resolvedIp), timeoutMs);
    } else if (tier === ExecutionTier.BROWSER_PROXIED) {
      if (!options?.browserProvider) {
        log.warn({ skillId: skill.id, tier }, 'browser_proxied tier requested but no browser provider available');
        return failureResult(startTime, tier, FailureCause.UNKNOWN);
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
      response = await withTimeout(directFetch(request, maxResponseBytes, options?.fetchFn, resolvedIp), timeoutMs);
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
      const redirectPolicy = getSitePolicy(skill.siteId, options?.config);
      if (redirectPolicy.domainAllowlist.length === 0) {
        const rawDomains = [...new Set([...skill.allowedDomains, skill.siteId])];
        const implicitAllowlist = sanitizeImplicitAllowlist(rawDomains);
        if (!matchesDomainAllowlist(redirectDomain, implicitAllowlist)) {
          log.warn({ skillId: skill.id, location: resolvedUrl, rule: 'redirect.implicit_skill_allowlist' },
            'Redirect to domain not in skill allowlist');
          return failureResult(startTime, tier, FailureCause.UNKNOWN);
        }
      } else {
        const redirectCheck = checkRedirectAllowed(skill.siteId, resolvedUrl, currentUrl, options?.config);
        if (!redirectCheck.allowed) {
          log.warn({ skillId: skill.id, location: resolvedUrl, rule: redirectCheck.rule },
            'Redirect to disallowed domain blocked');
          return failureResult(startTime, tier, FailureCause.UNKNOWN);
        }
      }

      // IP check — also pin the resolved IP for the redirect fetch
      const ipCheck = await resolveAndValidate(redirectDomain);
      if (!ipCheck.allowed) {
        log.warn({ skillId: skill.id, domain: redirectDomain, ip: ipCheck.ip }, 'Redirect to private IP blocked');
        return failureResult(startTime, tier, FailureCause.UNKNOWN);
      }
      resolvedIp = ipCheck.ip;
    }

    const redirectResp = await directFetch(
      { ...request, url: resolvedUrl },
      maxResponseBytes,
      options?.fetchFn,
      resolvedIp,
    );
    finalResponse = redirectResp;
    currentUrl = resolvedUrl;  // Update for next hop
    redirectCount++;
  }

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

  // 2.5: Server errors (5xx) — map to UNKNOWN with better logging
  if (response.status >= 500 && response.status < 600) {
    log.info({ skillId: skill.id, status: response.status }, 'Server error (5xx) — classified as UNKNOWN');
    return FailureCause.UNKNOWN;
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

// ─── Fetch Implementations ──────────────────────────────────────

async function directFetch(
  request: SealedFetchRequest & { url: string; method: string; headers: Record<string, string>; body?: string },
  maxResponseBytes: number,
  fetchFn?: (req: SealedFetchRequest) => Promise<SealedFetchResponse>,
  pinnedIp?: string,
): Promise<SealedFetchResponse> {
  if (fetchFn) {
    return fetchFn(request);
  }

  // CR-01: Pin to the resolved IP to prevent DNS rebinding TOCTOU attacks.
  // Replace the hostname in the URL with the resolved IP, and set the Host
  // header to the original hostname for correct routing and TLS SNI.
  let fetchUrl = request.url;
  const fetchHeaders = { ...request.headers };
  if (pinnedIp) {
    try {
      const parsed = new URL(request.url);
      const originalHost = parsed.host; // includes port if non-default
      // For IPv6 addresses, wrap in brackets
      const ipForUrl = pinnedIp.includes(':') ? `[${pinnedIp}]` : pinnedIp;
      parsed.hostname = ipForUrl;
      fetchUrl = parsed.toString();
      // Set Host header so the server routes correctly
      if (!fetchHeaders['Host'] && !fetchHeaders['host']) {
        fetchHeaders['Host'] = originalHost;
      }
    } catch (err) {
      log.warn({ url: request.url, pinnedIp, err }, 'Failed to pin IP in URL — falling back to original hostname');
    }
  }

  const response = await fetch(fetchUrl, {
    method: request.method,
    headers: fetchHeaders,
    body: request.body,
    redirect: 'manual',  // never auto-follow redirects
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

  // No matching request found in browser network traffic — fail explicitly
  // rather than returning a fabricated { status: 0 } response that would
  // be indistinguishable from a network-level failure.
  log.error({ skillId: skill.id }, 'Browser execution failed: no matching request found in network traffic');
  throw new Error(`Full browser execution found no matching request for ${skill.method} ${skill.pathTemplate}`);
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

// withTimeout imported from core/utils.ts
