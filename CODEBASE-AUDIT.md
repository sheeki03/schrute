# OneAgent Codebase Audit Report

**Date:** 2026-02-16
**Scope:** Full codebase scan (~97 source files, ~108 test files)
**Agents:** Code Reviewer, Silent Failure Hunter, Code Simplifier, Comment Analyzer, Test Coverage Analyzer, Type Design Analyzer
**Verification:** All 96 numbered findings verified against source code by 4 parallel agents (2026-02-16)
**Remediation:** 72 findings fixed by 6 parallel fix agents (2026-02-17). Build clean: 0 type errors, 1364 tests passing.

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Code Review — Bugs, Security & Logic Errors](#code-review--bugs-security--logic-errors)
3. [Silent Failures & Error Handling](#silent-failures--error-handling)
4. [Code Simplification Opportunities](#code-simplification-opportunities)
5. [Comment Accuracy & Quality](#comment-accuracy--quality)
6. [Test Coverage Gaps](#test-coverage-gaps)
7. [Type Design Issues](#type-design-issues)
8. [Summary Tables](#summary-tables)

---

## Executive Summary

### Verification Summary

Every numbered finding was verified by reading the actual source code at the referenced lines.

| Verdict | Count | Meaning |
|---------|-------|---------|
| **VALID** | 63 | Real issue that should be fixed |
| **ACCEPTABLE** | 19 | Minor issue / acceptable risk / not worth fixing |
| **DESIGN DECISION** | 6 | Intentional choice, self-documented |
| **FALSE POSITIVE** | 8 | Finding was wrong; code is correct |
| **Total verified** | **96** | |

### Remediation Summary (2026-02-17)

All 63 VALID findings fixed + 9 ACCEPTABLE findings also improved = **72 total fixes**.

| Category | Must Fix | Optional Fixed | Remaining | Total |
|----------|----------|----------------|-----------|-------|
| Code Review | 7/7 | 0 | 0 valid | 12 |
| Silent Failures | 12/12 | 5 | 0 valid | 24 |
| Simplification | 20/20 | 0 | 0 valid | 20 |
| Comments | 7/7 | 1 | 0 valid | 9 |
| Test Coverage | 10/10 | 1 | 0 valid | 12 |
| Type Design | 7/7 | 2 | 0 valid | 19 |
| **Total** | **63/63** | **9** | **0 valid** | **96** |

**New shared modules created:** `src/shared/daemon-types.ts`, `src/shared/auth-utils.ts`, `src/shared/invariant-utils.ts`, `src/shared/schema-validation.ts`, `src/shared/domain-utils.ts`

**New test files created:** `tests/unit/tool-dispatch.test.ts` (23 tests), `tests/unit/auth-repository.test.ts` (18 tests), `tests/unit/deduplicator.test.ts` (15 tests)

**Verification:** `npx tsc --noEmit` — 0 errors. `npx vitest run` — 110 files, 1364 tests, all passing.

### Severity Breakdown (Verified Findings Only)

| Category | Valid | Acceptable | Design | False Pos | Original |
|----------|-------|------------|--------|-----------|----------|
| Code Review | 7 | 1 | 1 | 3 | 12 |
| Silent Failures | 12 | 6 | 2 | 4 | 24 |
| Simplification | 20 | 0 | 0 | 0 | 20 |
| Comments | 7 | 2 | 0 | 0 | 9 |
| Test Coverage | 10 | 1 | 0 | 1 | 12 |
| Type Design | 7 | 9 | 3 | 0 | 19 |
| **Total** | **63** | **19** | **6** | **8** | **96** |

---

## Code Review — Bugs, Security & Logic Errors

### CRITICAL (Confidence 90-95%)

#### CR-01: DNS Rebinding TOCTOU SSRF Bypass — ✅ FIXED
**Files:** `src/core/policy.ts:341`, `src/replay/executor.ts:264-270`
**Confidence:** 95%

`resolveAndValidate()` resolves DNS to check for private IPs, then returns the hostname. `executor.ts` passes that hostname to `fetch()`, which resolves DNS again independently. Between the two resolutions, an attacker's DNS can rotate from a public IP to `127.0.0.1` (DNS rebinding). Since `executor.ts` forwards auth headers/cookies from the skill recipe, this is a full SSRF with credential forwarding.

**Impact:** Attacker-controlled skill can exfiltrate localhost services (cloud metadata, internal APIs) with the user's credentials attached.

**Resolution:** `directFetch()` now accepts a `pinnedIp` parameter. After `resolveAndValidate()` returns the resolved IP, all fetch calls use the IP directly with the original hostname in the `Host` header. IPv6 addresses are bracket-wrapped for URL compatibility. Redirect hops also pin to their per-hop resolved IP.

#### CR-02: `aws_secret` PII Pattern Extreme False Positives — ✅ FIXED
**File:** `src/storage/redactor.ts:54`
**Confidence:** 92%

Pattern `/[0-9a-zA-Z/+]{40}/g` matches ANY 40-character alphanumeric string. This redacts SHA-1 hashes, git commit SHAs, base64-encoded tokens, UUIDs without dashes, and random IDs throughout HAR recordings and audit logs, making them unreadable.

**Resolution:** Pattern now uses lookbehind assertions requiring AWS-specific context: must follow an `AKIA` access key ID or `aws_secret_access_key` keyword.

#### ~~CR-03: Unbounded Network Entry Accumulation / Memory Leak~~ FALSE POSITIVE
**File:** `src/browser/base-browser-adapter.ts:1039-1054`

**Verification:** `AgentBrowserAdapter` (the production subclass) already overrides `setupNetworkCapture()` with a 500-entry cap and `shift()` eviction.

#### CR-04: `verifySignature()` Misleading Name — Only Checks Format — ✅ FIXED
**File:** `src/automation/bot-auth.ts:91-122`
**Confidence:** 90%

**Resolution:** Renamed to `hasValidSignatureFormat()` with clear JSDoc stating it does NOT perform cryptographic verification. All callers updated.

### HIGH (Confidence 80-88%)

#### CR-05: Module-Level Mutable State Without Bounds — ✅ FIXED
**File:** `src/automation/strategy.ts:24-26`
**Confidence:** 88%

**Resolution:** Added `MAX_STRATEGY_CACHE_SIZE = 500` with FIFO eviction via `Map.keys().next().value`. Exposed `resetStrategyCache()` for testing.

#### CR-06: YAML Parser Silently Loses Nested OpenAPI Data — DESIGN DECISION
**File:** `src/discovery/openapi-scanner.ts:93-104`

**Verification:** Code has explicit self-documenting comments. Intentional minimal detector, not a full parser.

#### ~~CR-07: `resolveRefToLocator` Records Success Before Promise Resolves~~ FALSE POSITIVE
**File:** `src/browser/base-browser-adapter.ts:361-367`

**Verification:** `recordStaleRef(found: boolean)` tracks ref *resolution*, not action success.

#### CR-08: Audit Log Signature Verification Not Timing-Safe — ✅ FIXED
**File:** `src/replay/audit-log.ts:210-220`
**Confidence:** 84%

**Resolution:** Replaced `===` with `crypto.timingSafeEqual()` using Buffer conversion. Length check performed first.

#### ~~CR-09: `redactHeaders` Timeout Behavior Confusing~~ FALSE POSITIVE
**File:** `src/storage/redactor.ts:116-138`

**Verification:** `withTimeout()` throws on timeout — does NOT fail open.

#### CR-10: `loadConfig` Has Partial But Incomplete Schema Validation — ACCEPTABLE
**File:** `src/core/config.ts:247-257`

**Verification:** Has partial validation. TD-04 fix extended validation further (logLevel, server.network, server.httpPort checks added).

#### CR-11: `cookie-refresh.ts` Singleton BrowserManager Never Closed — ✅ FIXED
**File:** `src/automation/cookie-refresh.ts:10-17`
**Confidence:** 80%

**Resolution:** Added `finally` block that calls `sharedBrowserManager.closeAll()` and nulls the reference after each refresh cycle.

#### CR-12: `phone` PII Pattern High False-Positive Rate — ✅ FIXED
**File:** `src/storage/redactor.ts:48`
**Confidence:** 80%

**Resolution:** Pattern now requires at least one separator (dash, space, dot, parenthesis) between digit groups. No longer matches bare digit strings like timestamps or port numbers.

---

## Silent Failures & Error Handling

### CRITICAL

#### SF-01: Empty `.catch(() => {})` on Playwright Operations — ✅ FIXED
**Files:** `src/browser/base-browser-adapter.ts:192,201,204,1096`

**Resolution:** All 4 empty catches replaced with descriptive debug logging (waitForLoadState, response waiting, download handling).

#### SF-02: Systematic Silent Native Module Fallback (14 catch blocks) — ✅ FIXED
**Files:** All `src/native/*.ts`

**Resolution:** All 10 native wrapper files now have `getLogger()` + `_nativeFailureLogged` flag. First failure per module logged at `debug` level; subsequent failures silent.

#### SF-03: Silent Browser Cleanup Errors — ✅ FIXED
**Files:** `src/browser/engine.ts:123-125`, `src/doctor.ts:68`

**Resolution:** Both files now log cleanup failures at `debug` level.

#### SF-04: Native Module Loader Silently Swallows Load Errors — ✅ FIXED
**File:** `src/native/index.ts:34,38`

**Resolution:** Inner catch logs `debug` with candidate path. Outer catch logs `info` with actual error when native module is unavailable.

### HIGH

#### SF-05: Double-Silent Dialog Dismiss — ✅ FIXED
**File:** `src/browser/modal-state.ts:79-82`

**Resolution:** Inner `.catch(() => {})` on `dialog.dismiss()` replaced with debug logging.

#### SF-06: `verifySignature` Returns `false` on Decode Errors — DESIGN DECISION

**Verification:** Returning `false` for malformed base64 IS correct behavior for a format validator. Function renamed via CR-04.

#### SF-07: `parseSignatureInput` Returns `null` on Any Error — ✅ FIXED (Optional)
**File:** `src/automation/bot-auth.ts:236-253`

**Resolution:** Removed blanket try/catch. Added explicit input validation. Regex `match()` cannot throw.

#### SF-08: Schema Match Swallows Code Bugs — ✅ FIXED
**File:** `src/skill/validator.ts:210-228`

**Resolution:** Catch now re-throws `TypeError` and `ReferenceError` (code bugs). Only validation errors return `false`.

#### SF-09: Cookie Refresh Catches All Navigation Errors — DESIGN DECISION

**Verification:** Code DOES log at debug level. Intentional behavior.

#### SF-10: Audit Log `exportRootHash` Returns Path After Write Failure — ✅ FIXED
**File:** `src/replay/audit-log.ts:246-254`

**Resolution:** Returns `null` on write failure instead of the stale path. Return type updated to `string | null`.

#### SF-11: `loadLastHash` Resets Audit Chain on Corruption — ✅ FIXED (Optional)
**File:** `src/replay/audit-log.ts:297-305`

**Resolution:** Enriched log with `entryCount` context and clearer message about chain continuity.

#### SF-12: MCP Resource Handlers: Error Not Logged Server-Side — ✅ FIXED
**File:** `src/server/mcp-handlers.ts:201-212`

**Resolution:** Added `log.error({ err, uri }, 'MCP resource handler error')` before converting to client text.

#### SF-13: `extractJwtTtl` Returns `null` on Any Error — ✅ FIXED
**File:** `src/capture/auth-detector.ts:261-265`

**Resolution:** Split into narrower catches for base64 and JSON parse errors. Outer catch now logs at debug level.

#### SF-14: `ariaSnapshot` Failure Unlogged — ✅ FIXED
**File:** `src/browser/base-browser-adapter.ts:278-288`

**Resolution:** Added `log.debug({ err }, 'ariaSnapshot failed, falling back to innerText')` before fallback.

### MEDIUM

| # | File | Issue | Status |
|---|------|-------|--------|
| SF-15 | `daemon-client.ts:262-274` | Broad catch masks code bugs as "daemon unavailable" | ✅ FIXED — distinguishes connection errors from code bugs |
| SF-16 | `deduplicator.ts:85-92` | Empty string on any error in `buildBodyFingerprint` | ✅ FIXED (Optional) — added debug logging |
| ~~SF-17~~ | ~~`chain-detector.ts:229-235`~~ | ~~Bug in `searchJsonPath` hidden by catch-all~~ | FALSE POSITIVE |
| SF-18 | `graphql-scanner.ts`, `openapi-scanner.ts` | Silent probe failures (no debug logging) | ✅ FIXED — added debug logging with URL context |
| SF-19 | Multiple (5 locations) | JSON.parse fallback hides `undefined` body bugs | ✅ FIXED (Optional, partial) — debug logging in deduplicator |
| SF-20 | `side-effects.ts:20-33` | Silent GraphQL detection failure | ✅ FIXED (Optional) — added debug logging |
| ~~SF-21~~ | ~~`cookie-jar.ts:49-61`~~ | ~~Silent keychain degradation~~ | FALSE POSITIVE |
| ~~SF-22~~ | ~~`confirmation.ts:22-34`~~ | ~~Ephemeral HMAC key without notice~~ | FALSE POSITIVE |
| SF-23 | `base-browser-adapter.ts:227,256` | Detached frame catch too broad | ✅ FIXED (Optional) — added debug logging |
| ~~SF-24~~ | ~~`core/engine.ts:119-124`~~ | ~~HMAC fallback silently used~~ | FALSE POSITIVE |

---

## Code Simplification Opportunities

### Duplicated Code (12 findings) — ALL FIXED ✅

#### CS-01: Duplicated `withTimeout` Implementation — ✅ FIXED
**File:** `src/browser/har-recorder.ts`
**Resolution:** Replaced local method with import of `withTimeout` from `core/utils.ts`.

#### CS-02: Duplicated `VALID_SNAPSHOT_MODES` Set — ✅ FIXED
**Files:** `src/browser/feature-flags.ts:22`, `src/core/config.ts:110`
**Resolution:** Exported from `feature-flags.ts`, imported in `config.ts`.

#### CS-03: Duplicated "Get All Skills" Pattern (3 locations) — ✅ FIXED
**Files:** `src/index.ts`, `src/server/tool-dispatch.ts`, `src/server/mcp-handlers.ts`
**Resolution:** Added `getAll()` method to `SkillRepository`. All 3 callers refactored.

#### CS-04: Repetitive Modal-Racing Wrapper (7 tool handlers) — ✅ FIXED
**File:** `src/browser/base-browser-adapter.ts`
**Resolution:** Extracted `withModalRace(actionFn)` helper. All 7 handlers refactored.

#### CS-05: Duplicated Request-Building Logic (3 files) — ✅ FIXED
**Files:** `src/replay/request-builder.ts`, `src/skill/compiler.ts`, `src/skill/validator.ts`
**Resolution:** Extracted `resolveUrl()`, `buildDefaultHeaders()`, `buildBodyOrQuery()` as shared helpers in `request-builder.ts`.

#### CS-06: Duplicated `injectAuth` Function — ✅ FIXED
**Files:** `src/replay/request-builder.ts`, `src/skill/compiler.ts`
**Resolution:** Exported from `request-builder.ts`, imported in `compiler.ts`.

#### CS-07: Duplicated Custom Invariant Evaluation — ✅ FIXED
**Files:** `src/replay/semantic-check.ts`, `src/skill/validator.ts`
**Resolution:** Created shared `evaluateInvariant()` in `src/shared/invariant-utils.ts`.

#### CS-08: Duplicated `PidFileContent` Interface — ✅ FIXED
**Files:** `src/client/daemon-client.ts`, `src/server/daemon.ts`
**Resolution:** Moved to `src/shared/daemon-types.ts`.

#### CS-09: Duplicated `TransportMode`/`TransportConfig` Types — ✅ FIXED
**Files:** `src/client/daemon-client.ts`, `src/server/daemon.ts`
**Resolution:** Moved to `src/shared/daemon-types.ts`.

#### CS-10: Duplicated `SERVICE_NAME` Constant — ✅ FIXED
**Files:** `src/storage/secrets.ts`, `src/browser/cookie-jar.ts`
**Resolution:** Exported from `secrets.ts`, imported in `cookie-jar.ts`.

#### CS-11: Duplicated Timing-Safe Comparison (3 locations) — ✅ FIXED
**Files:** `src/server/mcp-http.ts`, `src/server/daemon.ts`, `src/server/rest-server.ts`
**Resolution:** Created shared `verifyBearerToken()` in `src/shared/auth-utils.ts`.

#### CS-12: Duplicated JSON Schema Validation — ✅ FIXED
**Files:** `src/replay/response-parser.ts`, `src/replay/semantic-check.ts`
**Resolution:** Created shared `validateJsonSchema()` in `src/shared/schema-validation.ts`.

### Dead Code (3 findings) — ALL FIXED ✅

#### CS-13: `checkBuildProfile()` Placeholder — ✅ FIXED
**File:** `src/doctor.ts:330-336`
**Resolution:** Removed the dead function and its caller.

#### CS-14: Stub LLM Adapters — ✅ FIXED
**Files:** `src/llm/adapters/anthropic.ts`, `src/llm/adapters/openai.ts`
**Resolution:** Deleted both unused stub files. Verified no imports reference them.

#### CS-15: `detectEnums` Exported but Never Called — ✅ FIXED
**File:** `src/capture/schema-inferrer.ts`
**Resolution:** Removed function, helper, and constant. Updated tests.

### Redundant Conditions (1 finding) — FIXED ✅

#### CS-16: Double `checkInputCorrelation` Call — ✅ FIXED
**File:** `src/capture/param-discoverer.ts:205,213`
**Resolution:** Removed the redundant second call.

### Unnecessary Comments (6 files) — FIXED ✅

#### CS-17: Redundant Import Echo Comments — ✅ FIXED
**Files:** 6 files across replay/, skill/, discovery/
**Resolution:** Removed 7 redundant comments restating import statements.

### Other — ALL FIXED ✅

#### CS-18: Unused `_config` Parameter — ✅ FIXED
**File:** `src/healing/relearner.ts:49`
**Resolution:** Removed parameter and unused import.

#### CS-19: Combinable Tier Lock Conditions — ✅ FIXED
**File:** `src/core/tiering.ts:216-224`
**Resolution:** Combined two if-blocks into single `permanent || temporary_demotion` condition.

#### CS-20: Duplicated Domain Matching Logic — ✅ FIXED
**Files:** `src/replay/tool-budget.ts`, `src/replay/request-builder.ts`
**Resolution:** Created shared `isDomainMatch()` in `src/shared/domain-utils.ts`.

---

## Comment Accuracy & Quality

### Critical Issues — ALL FIXED ✅

#### CA-01: JSDoc Says "Chromium" but Engine May Be Firefox — ✅ FIXED
**File:** `src/browser/manager.ts:45`
**Resolution:** Changed to `"Launch the shared browser instance."`

#### CA-02: Console Unavailability Notice Hardcodes "patchright" — ✅ FIXED
**File:** `src/browser/base-browser-adapter.ts:804`
**Resolution:** Now uses `this.capabilities?.effectiveEngine` dynamically.

#### CA-03: Camoufox Version Pinned in User-Facing Log — ✅ FIXED
**File:** `src/browser/engine.ts:91`
**Resolution:** Removed hardcoded version from log message.

#### CA-04: JSDoc Says "Encrypted Keychain" but No Encryption — ✅ FIXED
**File:** `src/browser/cookie-jar.ts:24`
**Resolution:** Changed to `"Cookie persistence with OS keychain storage."`

### Improvement Opportunities

#### CA-05: Provider JSDoc References "Future Adapters" That Already Exist — ✅ FIXED
**File:** `src/browser/provider.ts:28-34`
**Resolution:** Updated to reflect existing PlaywrightMcpAdapter and AgentBrowserAdapter.

#### CA-06: "~4x Reduction" Claim Without Evidence — ✅ FIXED (Optional)
**File:** `src/browser/agent-browser-adapter.ts:15-16`
**Resolution:** Changed to "approximate ~4x reduction".

#### CA-07: Setup Command Description Engine-Unaware — ✅ FIXED
**File:** `src/index.ts:330-331`
**Resolution:** Changed to `'Install browser engine and verify keychain'`.

#### CA-08: Stale TODO-Like Cleanup Instruction — ✅ FIXED
**File:** `src/doctor.ts:329`
**Resolution:** Removed along with `checkBuildProfile()` (CS-13).

#### CA-09: Config Double-Cast Comment Could List Validated Sections — ACCEPTABLE
**File:** `src/core/config.ts:251-253`
**Verification:** TD-04 fix updated the comment to list all validated sections.

### Positive Findings

The following comments are exemplary and should serve as models:
- `src/browser/har-recorder.ts:18-25` -- Pipeline description with FAIL-CLOSED security note
- `src/browser/base-browser-adapter.ts:46-58` -- SECURITY block documenting allowlist gate
- `src/browser/base-browser-adapter.ts:834-836` -- "Sealed fetch wrapper. NEVER exposes raw page.evaluate()"
- `src/core/config.ts:172` -- "Env overrides never persist to disk"
- `src/browser/manager.ts:157` -- "Preserve HAR path so it survives context close"
- `src/core/engine.ts:118` -- Fire-and-forget async initialization pattern explanation

---

## Test Coverage Gaps

### Critical Gaps (Criticality 8-10) — ALL FIXED ✅

#### TC-01: No Tests for `src/server/tool-dispatch.ts` (10/10) — ✅ FIXED
**Resolution:** Created `tests/unit/tool-dispatch.test.ts` with 23 tests covering blocked tools, confirmation gates, argument validation, buildToolList, unknown tool fallback.

#### TC-02: No Tests for `src/storage/auth-repository.ts` (9/10) — ✅ FIXED
**Resolution:** Created `tests/unit/auth-repository.test.ts` with 18 tests using real in-memory SQLite. Covers create, update, rowToAuthFlow, getBySiteId, delete.

#### TC-03: No Tests for `src/capture/deduplicator.ts` (8/10) — ✅ FIXED
**Resolution:** Created `tests/unit/deduplicator.test.ts` with 15 tests covering duplicate detection, fingerprinting, edge cases.

#### TC-04: Policy `checkMethodAllowed`, `checkRedirectAllowed`, `resolveAndValidate` Untested (9/10) — ✅ FIXED
**Resolution:** Added ~14 tests to `tests/unit/policy.test.ts` covering all three functions with positive and negative cases.

### Important Gaps (Criticality 5-7) — ALL FIXED ✅

#### TC-05: Engine `executeSkill` Minimal Coverage (7/10) — ✅ FIXED
**Resolution:** Added 4 tests for policy check failure, path risk detection, rate limiting, successful delegation.

#### TC-06: Executor Redirect Chain Untested (7/10) — ✅ FIXED
**Resolution:** Added tests for redirect following, cross-domain blocking, max redirect limit, per-hop SSRF validation.

#### TC-07: Executor Budget/Audit Flow Untested (7/10) — ✅ FIXED
**Resolution:** Added tests for budget exceeded, record/release on success/failure, intent+outcome writes, strict mode abort.

#### ~~TC-08: MCP Resource/Prompt Handlers Untested~~ FALSE POSITIVE

**Verification:** `tests/unit/mcp-protocol.test.ts` already tests these handlers.

### Test Quality Issues — ALL FIXED ✅

#### TC-09: Assertion-Free Test in retry.test.ts — ✅ FIXED
**Resolution:** Replaced empty test with real assertions on `retryDecisions`, escalation count, and `result.success`.

#### TC-10: Weak Assertion for Max Retries — ✅ FIXED
**Resolution:** Strengthened to `toBeGreaterThan(1)` + `toBeLessThanOrEqual(4)` + `retryDecisions.length` check.

#### TC-11: Engine Tests Over-Mock — ✅ FIXED
**Resolution:** Added behavioral tests that test real outcomes alongside mocks.

#### TC-12: Weak "Redacts Sensitive URL" Assertion — ✅ FIXED (Optional)
**Resolution:** Added assertions for `typeof result.url`, `result.url.length`, and full `policyDecision` structure.

### Files With Zero Test Coverage

| File | Purpose | Status |
|------|---------|--------|
| ~~`src/server/tool-dispatch.ts`~~ | ~~Central MCP tool routing~~ | ✅ 23 tests added |
| ~~`src/server/mcp-handlers.ts`~~ | ~~MCP resources/prompts~~ | FALSE POSITIVE — already tested |
| ~~`src/storage/auth-repository.ts`~~ | ~~Auth flow CRUD~~ | ✅ 18 tests added |
| ~~`src/capture/deduplicator.ts`~~ | ~~Request deduplication~~ | ✅ 15 tests added |
| ~~`src/llm/adapters/*.ts`~~ | ~~LLM stubs~~ | ✅ Deleted (CS-14) |

---

## Type Design Issues

### Critical

#### TD-01: `any` in Native Module Loader — ✅ FIXED (Optional)
**File:** `src/native/index.ts:15`
**Resolution:** Replaced `Record<string, (...args: any[]) => any>` with typed `NativeBindings` interface listing all 16 known functions.

#### TD-02: `as any` Casts for Browser Roles — DESIGN DECISION
**File:** `src/browser/base-browser-adapter.ts:326,331,333,342`
**Verification:** Intentional bridge between dynamic ARIA role strings and Playwright's nominal `AriaRole` type.

### High

#### TD-03: Pervasive Unsafe `as` Casts from Database Rows — ✅ FIXED
**Files:** All `src/storage/*-repository.ts`
**Resolution:** Added validator functions for every union type: `validateSkillStatus()`, `validateTierState()`, `validateSideEffectClass()`, `validateAuthType()`, `validateMasteryLevel()`, `validateExecutionTier()`. All `as` casts in `rowTo*()` functions replaced.

#### TD-04: Config Loading Double-Cast Bypasses Type Safety — ✅ FIXED
**File:** `src/core/config.ts:254-257`
**Resolution:** Extended runtime validation: logLevel (string check + known value warning), server.network (boolean check), server.httpPort (integer range check). Comment updated to list all validated sections.

#### TD-05: `parseJson<T>` Uses Unchecked Generic Cast — ✅ FIXED
**File:** `src/storage/skill-repository.ts:59-67`
**Resolution:** Added optional `shapeValidator` parameter. Created shape assertion helpers for `TierLock`, `ParameterEvidence[]`, and `RequestChain`.

### Medium

| # | File | Issue | Status |
|---|------|-------|--------|
| TD-06 | `engine.ts:57,95` | `as any`/`as unknown as Browser` for third-party interop | DESIGN DECISION |
| TD-07 | `base-browser-adapter.ts:1146` | `children: any[]` should use `SnapshotNode` | ✅ FIXED |
| TD-08 | `tool-dispatch.ts:43-47` | `ToolResult` index signature destroys type safety | ACCEPTABLE |
| TD-09 | `executor.ts:43-55` | `ExecutionResult` should be discriminated union | ACCEPTABLE |
| TD-10 | `router.ts:22-27` | `RouterResult.data?: unknown` -- make generic | ACCEPTABLE |
| TD-11 | `skill/types.ts:372-373` | JSON Schema as `Record<string, unknown>` | ACCEPTABLE |
| TD-12 | `skill/types.ts:607-643` | Zod schema duplicates interface | ✅ FIXED — derived types via `z.infer` |

### Low

| # | File | Issue | Status |
|---|------|-------|--------|
| TD-13 | `skill/types.ts:504` | `ConfirmationToken.tier` is `string` | ACCEPTABLE |
| TD-14 | `skill/types.ts:332-337` | `SkillParameter.type` is `string` | ACCEPTABLE |
| TD-15 | `skill/types.ts:137-142` | `SealedFetchRequest.method` is `string` | ACCEPTABLE |
| TD-16 | `discovery/types.ts:11` | `trustLevel: number` has no range constraint | ✅ FIXED — now `1 \| 2 \| 3 \| 4 \| 5` |
| TD-17 | `skill/types.ts:366,390` | `confidence`/`successRate` range not enforced | DESIGN DECISION |
| TD-18 | `executor.ts:112` | `'unknown' as FailureCauseName` | ✅ FIXED — uses `FailureCause.UNKNOWN` |
| TD-19 | `skill/types.ts:351-393` | `SkillSpec` 35+ fields god object | ACCEPTABLE |

### Positive

- Consistent `const object + derived union type` pattern (no TypeScript `enum`)
- `ToolBudgetConfig.secretsToNonAllowlisted: false` -- excellent type-level invariant
- `AgentDatabase` generics with `unknown` default force callers to specify types
- Module-level singletons have reset functions for testing

### Overall Type Ratings (Post-Fix)

| Dimension | Before | After |
|-----------|--------|-------|
| Type Safety | 6/10 | 8/10 |
| Interface Design | 7/10 | 8/10 |
| Invariant Enforcement | 6/10 | 8/10 |
| Encapsulation | 7/10 | 7/10 |

---

## Summary Tables

### Top 10 Highest-Impact Fixes — ALL RESOLVED ✅

| # | Finding | Resolution |
|---|---------|------------|
| 1 | **CR-01: DNS Rebinding TOCTOU SSRF** | `directFetch()` pins to resolved IP with `Host` header |
| 2 | **CR-02+CR-12: PII redactor false positives** | Tightened regex patterns (AWS context lookbehind, phone separators required) |
| 3 | SF-02: Native module fallback logging | 10 files now log first failure with `_nativeFailureLogged` flag |
| 4 | TC-01: tool-dispatch.ts tests | 23 new tests covering all dispatch paths |
| 5 | **CR-08: Timing-unsafe signature** | `crypto.timingSafeEqual()` with Buffer conversion |
| 6 | TD-03: Database row validation | Validator functions for 6 union types across 3 repositories |
| 7 | SF-01: Playwright operation logging | 4 empty catches replaced with debug logging |
| 8 | TC-02: auth-repository.ts tests | 18 new tests with real SQLite |
| 9 | **CR-05: Unbounded strategy Map** | 500-entry cap with FIFO eviction |
| 10 | SF-10: exportRootHash write failure | Returns `null` instead of stale path |

### Files Most Frequently Cited

| File | Fixed Findings | Dismissed |
|------|---------------|-----------|
| `src/browser/base-browser-adapter.ts` | ✅ SF-01, SF-14, CA-02, TD-07, CS-04, SF-23 | ~~CR-03~~, ~~CR-07~~, TD-02 |
| `src/storage/redactor.ts` | ✅ CR-02, CR-12 | ~~CR-09~~ |
| `src/core/policy.ts` | ✅ CR-01, TC-04 | |
| `src/replay/executor.ts` | ✅ CR-01, TC-06, TC-07, TD-18 | TD-09 |
| `src/automation/bot-auth.ts` | ✅ CR-04, SF-07 | SF-06 |
| `src/replay/audit-log.ts` | ✅ CR-08, SF-10, SF-11 | |
| `src/skill/types.ts` | ✅ TD-12, TD-16 | TD-11, TD-13–15, TD-17, TD-19 |
| `src/core/config.ts` | ✅ TD-04, CS-02 | CR-10, CA-09 |
| `src/server/tool-dispatch.ts` | ✅ TC-01, CS-03 | TD-08 |
| `src/storage/skill-repository.ts` | ✅ TD-03, TD-05, CS-03 | |
| `src/browser/engine.ts` | ✅ SF-03, CA-03 | TD-06 |
| `src/native/*.ts` (12 files) | ✅ SF-02, SF-04, TD-01 | |
| `src/automation/strategy.ts` | ✅ CR-05 | |
| `src/automation/cookie-refresh.ts` | ✅ CR-11 | SF-09 |

---

*Generated by 6 parallel PR review agents scanning the full OneAgent codebase (~97 source files). All 96 numbered findings verified against source code by 4 parallel verification agents. 8 false positives removed, 6 design decisions annotated, 19 acceptable-risk findings downgraded. 63 valid findings confirmed.*

*Remediated by 6 parallel fix agents (2026-02-17): 72 findings fixed (63 must-fix + 9 optional). 5 new shared utility modules created, 3 new test files (56 tests), ~50 source files modified. Final state: `npx tsc --noEmit` 0 errors, `npx vitest run` 110 files / 1364 tests all passing.*
