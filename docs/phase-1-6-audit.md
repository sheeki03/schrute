# Phase 1–6 Comprehensive Codebase Audit (Verified)

**Generated:** 2026-03-15 | **Verified:** 2026-03-15
**Scope:** All TypeScript source files in `src/` (~131 files), all test files in `tests/` (~135 files)
**Method:** 7 audit agents generated 148 raw findings. 4 verification agents checked every finding against actual source code. False positives, design decisions, duplicates, and not-worth-fixing items were removed.

**Result: 148 raw findings reduced to 68 verified actionable issues.**
**Mechanical cleanup: 150 additional issues from desloppify v0.9.9 (unused imports, dead exports).**

---

## Table of Contents

1. [Silent Failure Audit](#1-silent-failure-audit) (8 verified)
2. [Code Quality & Security Review](#2-code-quality--security-review) (6 verified)
3. [Code Simplification Opportunities](#3-code-simplification-opportunities) (8 verified)
4. [Comment Accuracy Audit](#4-comment-accuracy-audit) (7 verified)
5. [Test Coverage & Quality Audit](#5-test-coverage--quality-audit) (15 verified)
6. [Type Design Audit](#6-type-design-audit) (3 verified)
7. [Architecture & Performance Review](#7-architecture--performance-review) (6 verified, deduplicated)
8. [Mechanical Cleanup — Desloppify](#8-mechanical-cleanup--desloppify) (~150 verified)
9. [Cross-Cutting Themes](#9-cross-cutting-themes)
10. [Previous Audit Findings (Retained)](#10-previous-audit-findings-retained)
11. [Dismissed Findings](#11-dismissed-findings)

---

## 1. Silent Failure Audit

**Verified: 8 real issues** (1 CRITICAL, 4 HIGH, 3 MEDIUM)

18 of the original 36 findings were dismissed as design decisions (cleanup/shutdown/exit paths where swallowing errors is correct) or false positives.

### CRITICAL

#### SF-C1: Empty catch swallows ALL errors in recording pipeline
- **File:** `src/core/engine.ts:713`
- **Code:** `} catch { /* non-blocking */ }`
- **Impact:** During recording, network entries are raw material for skill generation. Silently dropped entries produce incomplete skills with no diagnostic trail.
- **Fix:** `} catch (err) { log.debug({ err, url: response.url() }, 'Response capture failed during recording'); }`

### HIGH

#### SF-H4: JSON parse failure returns raw string without warning
- **File:** `src/client/daemon-client.ts:146`
- **Impact:** Callers treat raw HTML error pages as structured success payloads. No warning logged.
- **Fix:** Log at debug when JSON parse fails.

#### SF-H6: Cloudflare interstitial strategies swallow ALL errors (4 locations)
- **File:** `src/browser/base-browser-adapter.ts:163,186,194,197`
- **Impact:** Impossible to distinguish "button not found" from "page crashed" from "JS exception" when debugging CF bypass failures.
- **Fix:** Add `log.debug({ err }, 'CF strategy N failed')` to each catch.

#### SF-H7: `page.title().catch(() => '')` hides crash vs empty title
- **File:** `src/browser/base-browser-adapter.ts:189,219`
- **Impact:** Cannot distinguish page crash from genuine empty title in post-mortem diagnosis.

#### SF-H12: `isPidAlive` treats EPERM as "not alive"
- **File:** `src/client/daemon-client.ts:45`
- **Impact:** Security-relevant: a daemon owned by another user is treated as dead, enabling competing daemon start and socket file cleanup.
- **Fix:** Check `(err as NodeJS.ErrnoException).code === 'EPERM'` and return `true`.

### MEDIUM

#### SF-H9: Inline spec parse silently dropped
- **File:** `src/discovery/cold-start.ts:170`
- **Fix:** Add `log.debug({ err })` — zero-cost improvement.

#### SF-M6: `extractSiteId` returns raw URL on parse failure
- **File:** `src/discovery/cold-start.ts:698`
- **Impact:** Raw string with path/query components becomes a siteId used in filesystem paths and DB keys.

#### SF-M7: cf_clearance cookie check logs without error object
- **File:** `src/browser/manager.ts:619`
- **Fix:** Add `err` to the existing `log.debug()` call — one-character fix.

---

## 2. Code Quality & Security Review

**Verified: 6 real issues** (2 CRITICAL, 4 HIGH)

5 of the original 11 findings were dismissed: CQ-C1 (hardcoded strings with no user input), CQ-H2 (Promise constructor runs synchronously — no deadlock), CQ-H4 (no interleaving in hot path), CQ-H5 (intentional fire-and-forget with logging), CQ-H8 (correct for production lifecycle).

### CRITICAL

#### CQ-C2: Unbounded DNS and policy caches — memory leak
- **File:** `src/core/policy.ts:58, 387`
- **Impact:** `sitePolicies` Map and `DNS_CACHE` Map grow without bounds. `BoundedMap` exists in the codebase but is not used here.
- **Fix:** Replace with `BoundedMap`.

#### CQ-C3: Unbounded `pathAllowlist` Set
- **File:** `src/core/policy.ts:439-447`
- **Impact:** Grows without limit; entries never cleaned up. (Lower practical severity since entries come from static config, not runtime traffic.)
- **Fix:** Add size cap or site-lifecycle cleanup.

### HIGH

#### CQ-H1: `defaultFetch` missing `redirect: 'manual'`
- **File:** `src/core/utils.ts:20-38`
- **Impact:** A sealed request that redirects to a private host bypasses DNS/SSRF re-validation entirely.
- **Fix:** Add `redirect: 'manual'` or ensure all callers use pre-validated URLs.

#### CQ-H3: Audit dirs created without `mode: 0o700`
- **File:** `src/replay/audit-log.ts:274-282`
- **Impact:** Audit directories with HMAC-signed data may be world-readable.
- **Fix:** Add `mode: 0o700` to `mkdirSync`.

#### CQ-H6: Vacuous `expect(true).toBe(true)` test
- **File:** `tests/integration/mcp-wiring.test.ts:711`
- **Impact:** Test always passes regardless of health monitoring behavior.

#### CQ-H7: `getAuditLog` reads entire file into memory
- **File:** `src/server/router.ts:269-301`
- **Impact:** Full `readFileSync` + reverse + copy for pagination. Memory spike on every call for large audit logs.

---

## 3. Code Simplification Opportunities

**Verified: 8 real issues** (2 HIGH, 3 MEDIUM, 3 LOW)

12 of the original 20 findings were dismissed as design decisions or not worth fixing (churn exceeds benefit).

### HIGH

#### CS-H1: Duplicated config validation logic (~75 lines copy-pasted)
- **File:** `src/core/config.ts:541-637` and `672-747`
- **Fix:** Extract `validateConfigValue(keyPath, value)` function.

#### CS-H2: Quadruplicated inactive-skills search pattern (10 lines x 4)
- **Files:** `src/server/daemon.ts`, `src/server/tool-dispatch.ts`, `src/server/rest-server.ts`, `src/index.ts`
- **Fix:** Extract `findInactiveMatches()` into `src/server/skill-helpers.ts`.

### MEDIUM

#### CS-M1: Duplicated domain matching with inconsistent normalization
- **Files:** `src/shared/domain-utils.ts` vs `src/core/policy.ts:278-288`
- **Impact:** `isDomainMatch` only lowercases; `matchesDomainAllowlist` also normalizes IDN/punycode. `EXAMPLE.COM.` matches via policy but not via domain-utils.

#### CS-M2: Triplicated auto-confirm gate (security-relevant)
- **Files:** `src/server/tool-dispatch.ts:147`, `src/server/router.ts:101`, `src/app/service.ts:133`
- **Impact:** Security decision in 3 independent copies.

#### CS-M3: Triplicated skill search + map pipeline
- **Files:** `src/server/daemon.ts`, `src/server/tool-dispatch.ts`, `src/server/rest-server.ts`
- **Fix:** Extract shared `searchSkills()` function.

### LOW

#### CS-L3: `withKeytarTimeout` duplicates `withTimeout` from utils
- **File:** `src/storage/secrets.ts:19-29`

#### CS-L4: `consumeToken` is dead wrapper discarding return value
- **File:** `src/server/confirmation.ts:281-283`

#### CS-L8: `_cfg` prefix misleading — parameter is actually used
- **File:** `src/doctor.ts:398`

---

## 4. Comment Accuracy Audit

**Verified: 7 real issues** (3 HIGH, 4 MEDIUM)

12 of the original 19 findings were dismissed as not worth fixing (minor gaps, positive findings, or churn exceeding benefit).

### HIGH

#### CA-H1: Tiering comment contains phantom "manual | auto" discriminators
- **File:** `src/core/tiering.ts:39-46`
- **Impact:** Developer forms fundamentally wrong mental model. Actual discriminators are `permanent` and `temporary_demotion`.

#### CA-H2: utils.ts provenance comments replace functional descriptions
- **File:** `src/core/utils.ts` (5 functions)
- **Impact:** Functions lack any description of purpose — only refactoring history.

#### CA-H3: `schrute_activate` tool description says "DRAFT" but handles BROKEN too
- **File:** `src/server/tool-registry.ts:387-388`
- **Impact:** User-facing MCP tool listing — users with BROKEN skills won't discover activation.

### MEDIUM

#### CA-M1: Promotion JSDoc hardcodes "5" for configurable threshold
- **File:** `src/core/tiering.ts:160-161`

#### CA-M2: `checkPromotion` JSDoc hardcodes both thresholds
- **File:** `src/core/tiering.ts:50-58`

#### CA-M3: "user-configured allowlist" is actually programmatic
- **File:** `src/core/policy.ts:452-453`

#### CA-M4: `forcePromote` JSDoc attributes confirmation to wrong layer
- **File:** `src/core/promotion.ts:114-116`

---

## 5. Test Coverage & Quality Audit

**Verified: 15 real issues** (7 CRITICAL, 4 HIGH, 4 test quality)

All test findings were confirmed as real.

### CRITICAL — Security Boundaries Without Tests

#### TC-C1: `src/shared/auth-utils.ts` — zero tests for HTTP auth gate
- `verifyBearerToken()` is the sole HTTP authentication gate. The only reference in tests mocks it as `vi.fn().mockReturnValue(true)`. A regression opens the API.

#### TC-C2: `src/shared/admin-auth.ts` — zero tests for admin privilege gate
- `isAdminCaller()` gates admin operations in multi-user mode. Zero test coverage.

#### TC-C3: `src/server/shared-validation.ts` — zero tests for input validation
- Domain parsing, proxy validation, geo validation — the trust boundary for user-supplied data.

#### TC-C4: `src/server/mcp-handlers.ts` — path traversal prevention untested
- `../` prevention exists in code but no test sends a malicious siteId to verify rejection.

#### TC-C5: `src/storage/database.ts` — migration system untested
- `storage.test.ts` inlines SQL for migrations 001 and 003 only, missing 002, 004, 005, 006.

#### TC-C6: `src/shared/invariant-utils.ts` — 6 invariant formats untested
- Unknown invariant fallback passes by default — could mask misconfigured invariants.

#### TC-C7: `src/storage/import-validator.ts` — import trust boundary untested

### HIGH

| ID | File | Summary |
|----|------|---------|
| TC-H1 | `src/storage/metrics-repository.ts` | Success rate division-by-zero guard untested |
| TC-H2 | `src/browser/feature-flags.ts` | Runtime kill-switch validation untested |
| TC-H3 | `src/server/skill-helpers.ts` | Skill executability check untested |
| TC-H4 | 3 test files | Manually inlined schemas diverge from real 6-migration system |

### Test Quality Issues

| ID | File:Line | Issue |
|----|-----------|-------|
| TC-Q1 | `tests/integration/mcp-wiring.test.ts:711` | `expect(true).toBe(true)` — vacuous |
| TC-Q2 | `tests/unit/rust-parity.test.ts:311,327` | `expect(true).toBe(true)` — native results discarded |
| TC-Q3 | `tests/unit/policy.test.ts:362-372` | `resolveAndValidate` checks shape only, not behavior |
| TC-Q4 | `tests/unit/executor.test.ts:11-21` | Over-mocked `buildRequest` — integration seam untested |

---

## 6. Type Design Audit

**Verified: 3 real issues** (0 CRITICAL, 0 HIGH, 3 MEDIUM)

17 of the original 20 findings were dismissed: TD-C1 (documented design decision — "Flat interface by design"), TD-H1-H4 (not worth fixing or duplicates), TD-M1 (required for MCP SDK), TD-M4-M7 (pragmatic/design decisions), TD-M9-M11 (acceptable pragmatism), TD-L1-L4 (not worth fixing).

### MEDIUM

#### TD-M2: `browserContextId` is dead — phantom UUID
- **File:** `src/core/session.ts:8-14`
- **Impact:** Field set to `randomUUID()` but never used by any other file. Misleads developers.

#### TD-M3: `NamedSession.browserManager` leaked, bypassing MultiSessionManager
- **File:** `src/browser/multi-session.ts:14-23`
- **Impact:** `service.ts:253,258` accesses `session.browserManager.exportCookies()` directly, bypassing session management invariants.

#### TD-M8: `PoolEntry.maxSessions` accepts 0 or negative
- **File:** `src/browser/pool.ts:7-13`
- **Impact:** `maxSessions: 0` permanently starves all callers.
- **Fix:** One-line constructor guard: `if (maxSessions < 1) throw`.

---

## 7. Architecture & Performance Review

**Verified: 6 real issues** (0 CRITICAL, 5 HIGH, 1 MEDIUM) — after deduplication

AR-C1 (duplicate of CQ-C2), AR-C2 (false positive — DB-presence verification, not HMAC recomputation), AR-C3 (duplicate of CQ-H2), AR-H1 (duplicate of CS-H1), AR-H3 (duplicate of CQ-H4), AR-H5 (duplicate of CQ-H7) were removed.

### HIGH

#### AR-H2: `dispatchToolCall` creates new Router on every MCP tool call
- **File:** `src/server/tool-dispatch.ts:200`
- **Impact:** Unnecessary closure allocation on every hot-path call. Only 5 of many switch cases use it.
- **Fix:** Create router once at startup.

#### AR-H4: `appendFileSync` blocks event loop in hot path
- **File:** `src/replay/audit-log.ts:137`
- **Impact:** Called twice per skill execution. Blocks entire event loop during disk write.
- **Fix:** Use async append queue.

#### AR-H6: `browserContextId` stores phantom UUID
- **File:** `src/core/session.ts:31-55`
- **Impact:** Same as TD-M2 — field has no mapping to any real browser context.

#### AR-H7: `createLogger` mutates singleton; early callers get stale reference
- **File:** `src/core/logger.ts:14-27`
- **Impact:** `daemon.ts` captures `getLogger()` at module scope before `createLogger` runs. User's configured log level is silently ignored for daemon logging.

#### AR-H8: `listSkills(siteId, status)` fetches all then filters in JS
- **File:** `src/app/service.ts:104-108`
- **Fix:** Add `getByStatusAndSiteId()` to SkillRepository.

### MEDIUM

#### AR-M6: MCP HTTP session maps have no size limit
- **File:** `src/server/mcp-http.ts:50-51`
- **Impact:** Unauthenticated clients can grow transport/session maps without bound by connecting without session reuse.

---

## 8. Mechanical Cleanup — Desloppify

**Source:** [desloppify](https://github.com/peteromallet/desloppify) v0.9.9 scan (572 raw findings, verified down to ~150 real issues)
**Objective score:** 90.8/100

> Desloppify's security (13), code smell (185), orphaned file (2), and logging (4) findings were ALL false positives or design decisions after line-by-line verification. Only unused code and dead exports remain as genuine issues. See [Dismissed Desloppify Findings](#dismissed-desloppify-findings) for details.

### Unused Imports & Variables (~105 issues — HIGH)

Detected by the TypeScript compiler. Spot-check of 31 findings confirmed ~85% accuracy. Confirmed false positives (variables that ARE used downstream) were removed.

**Top offenders:**

| File | Unused Symbols |
|------|---------------|
| `tests/e2e/v02-rest-api.test.ts` | `skills`, `sites`, `sql`, `args` (6x), `skillId`, `params` |
| `tests/unit/mcp-http.test.ts` | `startAndCreateSession`, `req`, `res`, `http` (3x), `address`, `ServerMock` |
| `tests/unit/executor.test.ts` | `params`, `tier`, `ExecutorOptions`, `ExecutionResult`, `TierState`, `req` |
| `tests/unit/retry.test.ts` | `params`, `tier`, `RetryOptions`, `FailureCause`, `SideEffectClass` |
| `tests/unit/policy.test.ts` | `vi`, `invalidatePolicyCache`, `TIER1_ALLOWED_HEADERS`, `BLOCKED_HOP_BY_HOP_HEADERS` |
| `src/index.ts` | `loadConfig`, `log` |
| `src/core/engine.ts` | `allRecords`, `ambiguous` |
| `src/replay/executor.ts` | `FAILURE_CAUSE_PRECEDENCE`, `TierState` |
| `src/core/policy.ts` | `getConfig` |
| `src/core/promotion.ts` | `ConfirmationStatus` |
| `src/server/mcp-handlers.ts` | `deps` |
| `src/server/tool-dispatch.ts` | `parseDomainEntries` |
| `src/healing/relearner.ts` | `metricsRepo` |
| `src/capture/cdp-har-recorder.ts` | `startTime` (assigned but never read) |
| `src/capture/action-frame.ts` | `noise`, `ambiguous` |
| `src/skill/compiler.ts` | `TierState` |
| `src/skill/generator.ts` | `SideEffectClass` |
| `src/browser/agent-browser-adapter.ts` | `NetworkEntry` |
| `src/browser/agent-browser-provider.ts` | `origin` |
| `src/browser/benchmark.ts` | `tool` |
| `src/browser/manager.ts` | `siteId` (line 658, parameter unused in function body) |
| `src/client/daemon-client.ts` | `net` |
| `src/client/remote-client.ts` | `log` |
| `src/native/ip-policy.ts` | `IpValidationResult` |
| `src/native/redactor.ts` | entire import (line 14) |
| `src/storage/exemplar-repository.ts` | `log` |
| `src/automation/bot-auth.ts` | `createHash` |
| `src/app/service.ts` | `log` |

Plus ~50 more across test files (unused `vi`, `beforeEach`, `afterEach` explicit imports where vitest globals suffice, and unused test variables).

**Fix:** `desloppify autofix` or manually remove.

### Dead Exports (~45 issues — HIGH)

133 flagged dead exports verified down to ~45 genuine ones. Removed as false positives:
- **Public SDK API** (12 in `src/client/typescript/index.ts`) — intentional for external consumers
- **Public API contracts** (types in validator, gepa, config, etc.) — used as return/param types
- **Test helpers** (`tests/helpers.ts`) — used across test suite
- **Library entry points** (`src/lib.ts`) — consumed by npm users

**Confirmed genuinely dead:**

| File | Dead Exports |
|------|-------------|
| `src/app/service.ts` | `ConfirmResult`, `ExecuteSkillResult`, `ExportedCookie`, `SessionInfo`, `StatusInfo` |
| `src/storage/secrets.ts` | `exists`, `getLockedModeStatus`, `removeSiteSecret`, `retrieveSiteSecret`, `storeSiteSecret` |
| `src/core/policy.ts` | `normalizeDomain` |
| `src/automation/strategy.ts` | `SiteStrategy`, `resetStrategyCache` |
| `src/automation/classifier.ts` | `SiteClassification` |
| `src/automation/rate-limiter.ts` | `RateCheckResult` |
| `src/browser/multi-session.ts` | `NamedSession` |
| `src/browser/auth-coordinator.ts` | `AuthPublishEvent` |
| `src/browser/auth-store.ts` | `SiteAuthState` |
| `src/browser/screenshot-resize.ts` | `ResizeOptions`, `ResizeResult` |
| `src/browser/netscape-cookie-parser.ts` | `NetscapeCookie` |
| `src/browser/snapshot-refs.ts` | `TreeDiff` |
| `src/browser/benchmark.ts` | `BrowserMetrics` |
| `src/capture/graphql-extractor.ts` | `GraphQLInfo`, `GraphQLOperationCluster` |
| `src/capture/deduplicator.ts` | `DeduplicatedSample` |
| `src/shared/daemon-types.ts` | `TransportMode` |
| `src/shared/bounded-map.ts` | `BoundedMapOptions` |
| `src/replay/retry.ts` | `RetryDecision`, `RetryStepResult` |
| `src/server/router.ts` | `Router` |

**Fix:** Remove unused exports, or convert to non-exported types if used only within the same file.

---

## 9. Cross-Cutting Themes

### Theme 1: Unbounded Collections in Long-Running Daemon (VERIFIED)

| Collection | File | Type |
|-----------|------|------|
| `DNS_CACHE` | `src/core/policy.ts:387` | `Map` — unbounded |
| `sitePolicies` | `src/core/policy.ts:58` | `Map` — unbounded |
| `pathAllowlist` | `src/core/policy.ts:439` | `Set` — unbounded (low practical severity) |
| MCP `transports` | `src/server/mcp-http.ts:50` | `Map` — unbounded |
| MCP `sessionServers` | `src/server/mcp-http.ts:51` | `Map` — unbounded |

### Theme 2: Security-Critical Code Without Tests (VERIFIED)

- `src/shared/auth-utils.ts` (bearer token verification)
- `src/shared/admin-auth.ts` (admin privilege gate)
- `src/server/shared-validation.ts` (input validation boundary)

### Theme 3: Duplicated Business Logic Across Transports (VERIFIED)

- Auto-confirm gate (3 copies)
- Skill search pipeline (3 copies)
- Inactive-skills surface (4 copies)

### Theme 4: Synchronous I/O in Audit Subsystem (VERIFIED)

`appendFileSync` and `readFileSync` are the only sync file operations in the codebase.

---

## Summary by Severity (Verified Only)

| Severity | SF | CQ | CS | CA | TC | TD | AR | DS | **Total** |
|----------|----|----|----|----|----|----|-----|-----|-----------|
| CRITICAL | 1 | 2 | — | — | 7 | — | — | — | **10** |
| HIGH | 4 | 4 | 2 | 3 | 4 | — | 5 | ~150 | **~172** |
| MEDIUM | 3 | — | 3 | 4 | — | 3 | 1 | — | **14** |
| LOW | — | — | 3 | — | 4 | — | — | — | **7** |
| **Total** | **8** | **6** | **8** | **7** | **15** | **3** | **6** | **~150** | **~203** |

*DS = Desloppify mechanical cleanup (~105 unused imports/vars + ~45 dead exports).*
*15 semantic findings appear in multiple sections (duplicates across agents). After deduplication the unique verified count is ~45 semantic + ~150 mechanical = ~195.*

### Top 10 Priority Fixes

1. **Auth/admin tests** (TC-C1, TC-C2) — security boundary with zero coverage
2. **Unbounded caches** (CQ-C2) — replace `DNS_CACHE` and `sitePolicies` with `BoundedMap`
3. **Input validation tests** (TC-C3, TC-C4) — SSRF/path traversal boundary untested
4. **Recording catch block** (SF-C1) — add debug logging to recording pipeline
5. **SSRF via defaultFetch** (CQ-H1) — add `redirect: 'manual'`
6. **isPidAlive EPERM** (SF-H12) — treat EPERM as "alive"
7. **Audit log async** (AR-H4) — stop blocking event loop with `appendFileSync`
8. **Config validation dedup** (CS-H1) — extract shared validation function
9. **Migration system tests** (TC-C5) — test through real `AgentDatabase.open()`
10. **CF bypass logging** (SF-H6) — add debug logging to 4 bare catch blocks

---

## 10. Previous Audit Findings (Retained)

### P1 — Must Fix

| ID | File | Summary | Status |
|----|------|---------|--------|
| ENGINE-1 | `src/core/engine.ts:1597-1665` | `Engine.close()` never shuts down execution backends | Open |
| FINDING-2.1 | `src/core/engine.ts:769-835` | `cdpHarRecorder` not cleared on error path in `stopRecording` | Open |
| FINDING-3.1 | `src/core/engine.ts:1298-1302, 1488-1495` | Amendment tracking skipped on hard-throw paths | Open |

### P2 — Should Fix

| ID | File | Summary | Status |
|----|------|---------|--------|
| EXPLORE-1 | `src/browser/manager.ts:395,420,872,897` | Browser disconnect orphans auth coordinator participants | Open |
| PW-2 | `src/browser/playwright-backend.ts:122-129` | `discardSession()` bypasses `manager.closeContext()` | Open |
| FINDING-1.2 | `src/core/engine.ts:1257` | Lazy factory `?? undefined` operates on Promise (dead code) | Open |
| FINDING-2.2 | `src/core/engine.ts:778-787` | Dead code block in CDP `stopRecording` path | Open |
| IMPORT-1 | `src/browser/manager.ts:1037-1077` | `importCookies()` does not snapshot to auth store | Open |

---

## 11. Dismissed Findings

The following were verified against the actual code and determined to be false positives, intentional design decisions, or not worth fixing:

### False Positives (code doesn't match the claim)
- **CQ-C1**: `execSync` commands are hardcoded string literals with no user input interpolation
- **CQ-H2**: `LifecycleGuard.withLock` — Promise constructor runs synchronously, `release!()` is always assigned
- **CQ-H4**: `BrowserPool.acquire` — no interleaving between filter and increment in hot path
- **AR-C2**: HMAC key race — tokens verified by DB presence, not HMAC recomputation
- **SF-H11**: Native fallback already logs at `info` level (visible at default log level)
- **SF-M8**: WebMCP status response includes explicit `error` field (not indistinguishable from success)
- **SF-M15**: `req.resolve()` only produces `MODULE_NOT_FOUND` errors
- **CS-L9**: Binary search is O(log n) in `JSON.stringify` calls; linear scan would be slower

### Design Decisions (intentional, documented, or correct behavior)
- **SF-C2, SF-C3, SF-C4**: Cleanup/shutdown/exit paths where swallowing errors is correct
- **SF-H1, SF-H2, SF-H3**: Browser close in teardown — browser already nulled/disconnected
- **SF-H5**: URL parse guard for best-effort referrer spoofing — `about:blank` legitimately fails
- **SF-H8**: Page context destroyed → no challenge to detect → `false` is correct
- **CQ-H5**: `sweepIdleSessions` intentionally fire-and-forget with `.catch(log.warn)`
- **CQ-H8**: Module-level key caching correct for production; vitest isolates per worker
- **CS-M4**: Nested try/catch in trust.ts reflects two distinct failure modes
- **CS-M5**: Engine monolith is an intentional architectural choice (35 fields, documented)
- **TD-C1**: "Flat interface by design" — documented on line 346 of types.ts
- **TD-M1**: Index signature required for MCP SDK `CallToolResult` compatibility
- **TD-M6**: `TierLock | null` is idiomatic TypeScript for optional discriminated unions
- **TD-M9**: `Record<string, unknown>` for JSON Schema is common pragmatic pattern
- **SF-M1-M5, SF-M9-M10, SF-M12-M16**: Various expected-error catches in polling, CLI, navigation

### Not Worth Fixing (real but churn exceeds benefit)
- **CS-M6, CS-L1, CS-L2, CS-L5-L7, CS-L10-L12**: Minor simplifications with high churn risk
- **TD-H1, TD-H2**: Type imprecision compensated by runtime validation
- **TD-H3, TD-H4**: Duplicates of other findings
- **TD-M4, TD-M5, TD-M7, TD-M10, TD-M11**: Pragmatic type gaps with low practical impact
- **TD-L1-L4**: Minor type design observations
- **CA-M5-M10, CA-L1-L6**: Minor comment gaps or positive findings

### Dismissed Desloppify Findings (422 of 572 raw findings)

**Security — all 13 dismissed:**
- Hardcoded `password` in `scripts/benchmark-3-sites.ts` (2x) — test fixture credentials against `createAuthMockServer()`
- `tokenUrl` in `src/server/openapi-server.ts` — OAuth2 endpoint path, not a secret
- `SECRETS_USE` in `src/skill/types.ts` — capability identifier string, not a secret
- All 8 unguarded `JSON.parse` — all try-catch wrapped, parsing trusted internal data, or with validation guards
- Sensitive data logging in `src/index.ts:1209` — message says "credentials are never exported" (informational)

**Code smells — all 185 dismissed:**
- `as any` (14) / explicit `any` (5) — justified for Playwright, native modules, CDP protocol interfaces
- Async without await (23) — interface implementations that must be async for the contract
- High cyclomatic complexity (20) — intrinsic to policy/config/discovery/validation domains
- Monster functions (3) — long switch/case or handler registration; splitting reduces readability
- `console.error` without throw (37) — CLI entry point pattern, all call `process.exit(1)` after
- Silent failures (4) — all return typed `{ success: false }` result objects; callers inspect results
- `.sort()` without comparator (7) — all sort strings; default lexicographic sort is correct
- Hardcoded URLs (4) — `new URL(path, 'http://localhost')` relative URL parsing trick
- Nested closures (3) — standard Node.js server/handler patterns
- `@ts-expect-error` (1) — optional native dependency, correct TypeScript pattern

**Orphaned files — both dismissed:**
- `src/browser/provider.ts` — public API factory for external consumers
- `src/lib.ts` — library entry point for npm package consumers

**Logging — all 4 dismissed:**
- Tagged log calls in CLI entry point — standard CLI output pattern

**Dead exports — 88 of 133 dismissed:**
- 12 in `src/client/typescript/index.ts` — public SDK API for external consumers
- Types in validator, gepa, config, etc. — used as return/param types in public API contracts
- `tests/helpers.ts` exports — used across test suite
- Various module types kept as library contracts
