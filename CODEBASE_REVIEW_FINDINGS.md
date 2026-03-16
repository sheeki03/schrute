# Codebase Review Findings (Verified)

**Date**: 2026-03-16
**Codebase**: Schrute / OneAgent
**Reviewed by**: 7 specialized agents, verified line-by-line against source
**Scope**: Full codebase (~130+ source files)

> Items marked as false positives, intentional design decisions, or not
> reproducible in actual code have been removed. Only actionable findings remain.

---

## Table of Contents

1. [Silent Failures](#1-silent-failures)
2. [Code Quality & Bugs](#2-code-quality--bugs)
3. [Code Simplification](#3-code-simplification)
4. [Comment Accuracy](#4-comment-accuracy)
5. [Test Coverage Gaps](#5-test-coverage-gaps)
6. [Type Design](#6-type-design)

---

## Summary

| Category | Critical | High | Medium | Low | Total |
|----------|----------|------|--------|-----|-------|
| Silent Failures | 5 | 5 | 6 | - | 16 |
| Code Quality & Bugs | 1 | 5 | - | - | 6 |
| Code Simplification | 2 | - | 3 | 3 | 8 |
| Comment Accuracy | 4 | 3 | 2 | - | 9 |
| Test Coverage | 5 | 5 | 2 | - | 12 |
| Type Design | - | 2 | 2 | - | 4 |
| **Totals** | **17** | **20** | **15** | **3** | **55** |

---

## 1. Silent Failures

### CRITICAL

#### SF-1: Session Eviction Swallows All Errors
- **File**: `src/server/mcp-http.ts:66`
- **Code**: `.catch(() => {})`
- **Verified**: Line 66 confirms empty catch on session transport/server close during BoundedMap eviction.
- **Impact**: Resource leaks (open FDs, SSE connections) accumulate silently until server degrades.
- **Fix**: `.catch(e => log.warn({ e }, 'MCP session eviction cleanup failed'))`.

#### SF-2: Browser Context Close Swallows All Errors
- **File**: `src/browser/manager.ts:857`
- **Code**: `managed.context.close().catch(() => {})`
- **Verified**: Line 857 in `discardContext` confirms empty catch. Note: the normal `closeContext` at line 840 DOES log errors — only `discardContext` silently swallows.
- **Impact**: Zombie Chromium processes accumulate with no diagnostic trail.
- **Fix**: `.catch(err => log.debug({ err, siteId }, 'Browser context discard failed'))`.

#### SF-3: CDP HAR Recorder Body Failure Silent
- **File**: `src/capture/cdp-har-recorder.ts:118`
- **Code**: `.catch(() => { /* body unavailable — entry already recorded without it */ })`
- **Verified**: Line 118 confirms zero logging on body read failure.
- **Impact**: Skills generated from recordings with missing bodies produce unexplainably failed replays.
- **Fix**: `.catch(err => log.debug({ err }, 'Response body unavailable during HAR recording'))`.

#### SF-4: WebMCP Skill Fallback Browser Creation Swallows Errors
- **File**: `src/core/engine.ts:1716`
- **Code**: `} catch { /* no fallback available */ }`
- **Verified**: Line 1716 confirms. The outer catch at 1711 DOES log, but this inner fallback catch is silent.
- **Impact**: Users get generic "No browser context available" when the real problem is missing Playwright/broken binary.
- **Fix**: Log the error before falling through to the "No browser context" response.

#### SF-5: AgentBrowserBackend Shutdown Swallows Errors
- **File**: `src/browser/agent-browser-backend.ts:220`
- **Code**: `} catch { /* best effort */ }`
- **Verified**: Line 220 confirms. Provider close AND IPC close errors both swallowed.
- **Impact**: Agent-browser processes may become orphaned after "successful" shutdown.
- **Fix**: `} catch (err) { log.debug({ err }, 'Agent browser session close failed during shutdown'); }`.

### HIGH

#### SF-6: Policy Database Write Failure Silently Continues
- **File**: `src/core/policy.ts:162-165`
- **Verified**: Line 162-165 confirms. Error is logged as `warn` but caller receives no indication of failure. Policy exists only in memory cache — lost on restart.
- **Impact**: Security-critical domain allowlists silently lost on daemon restart while user believes they're protected.
- **Fix**: Propagate error or return status indicating persistence failure.

#### SF-7: Robots.txt Fetch Failure Allows All Crawling at DEBUG Level
- **File**: `src/discovery/robots.ts:129-130`
- **Code**: `log.debug({ err, origin }, 'Failed to fetch robots.txt — allowing all')`
- **Verified**: Line 130 confirms DEBUG level. ANY network error defaults to allow-all.
- **Impact**: Network glitches cause crawling of explicitly disallowed paths. `respectRobotsTxt` feature gives false sense of compliance.
- **Fix**: Log at `warn` level. Consider shorter cache TTL with retry.

#### SF-8: Native Module Fallback Logged at DEBUG Only
- **File**: `src/native/index.ts` and all `src/native/*.ts` wrappers
- **Verified**: The individual wrappers log at debug level with a once-per-process guard.
- **Impact**: In production (no debug logs), zero visibility into whether running fast native path or 10-100x slower TS fallback.
- **Fix**: Log first occurrence at `info` level.

#### SF-9: PlaywrightBackend.createProvider Returns undefined on ALL Errors
- **File**: `src/browser/playwright-backend.ts:74-77`
- **Verified**: Line 74-77 catches all exceptions including TypeError/ReferenceError and returns `undefined`.
- **Impact**: Programming bugs in PlaywrightMcpAdapter constructor silently cause all skills to fall back with generic "no browser" error.
- **Fix**: Re-throw TypeError and ReferenceError; only catch operational errors.

#### SF-10: Multiple Empty Catch Blocks in Cleanup Paths
- **Files** (verified):
  - `src/browser/agent-browser-backend.ts:220,274,282`
  - `src/browser/manager.ts:857`
  - `src/browser/pool.ts:90`
  - `src/server/rest-server.ts:417,438,469`
  - `src/browser/engine.ts:131`
- **Impact**: Resource leak diagnosis impossible across cleanup paths.
- **Fix**: Add at minimum `log.debug()` to each.

### MEDIUM

#### SF-11: CDP HAR Recorder URL Parse Failure Silent
- **File**: `src/capture/cdp-har-recorder.ts:135-137`
- **Code**: `catch { // Invalid URL — skip query parsing }`
- **Verified**: Line 135-137 confirms zero logging. Query parameters silently dropped.
- **Fix**: Log at debug level with the malformed URL.

#### SF-12: Modal State Dialog Dismiss Failure
- **File**: `src/browser/modal-state.ts:80-82`
- **Verified**: Line 80 has `catch { // Best-effort }`. Note: line 79 DOES have `.catch(err => log.debug(...))` on the inner promise — but the outer synchronous try/catch at 80 swallows different errors.
- **Impact**: Dialog could remain visible while tracking system thinks it's cleared.

#### SF-13: Skill Repository JSON Parse Returns Silent Fallback
- **File**: `src/storage/skill-repository.ts:166-169`
- **Verified**: Logged as `warn` — acceptable severity. However, corrupted security-sensitive fields (`allowedDomains`, `validation`) silently use defaults.
- **Impact**: Corrupted skill data silently uses defaults with different security properties.

#### SF-14: Engine Listener Cleanup Swallows Errors
- **File**: `src/core/engine.ts:828,846`
- **Code**: `try { cleanup(); } catch { /* ignore */ }`
- **Verified**: Zero logging in cleanup catch blocks.

#### SF-15: Site Import Delete Failure Silent
- **File**: `src/index.ts:1288,1338`
- **Code**: `try { siteRepo.delete(...); } catch { /* row may not exist */ }`
- **Verified**: Zero logging. Could mask DB corruption.

#### SF-16: CDP Connector File Read Failure Silent
- **File**: `src/browser/cdp-connector.ts:87`
- **Code**: `} catch { /* file doesn't exist or unreadable */ }`
- **Verified**: Zero logging.

---

## 2. Code Quality & Bugs

### CRITICAL

#### CQ-1: Security Scanner Global Regex `lastIndex` Not Reset on Non-Match
- **File**: `src/skill/security-scanner.ts:56-59`
- **Verified**: Lines 22-23 have patterns with `/g` flag. Line 59 resets `lastIndex` only INSIDE the `if (pattern.re.test(value))` block. If a global regex matches, `lastIndex` advances, and it IS reset at line 59. But `test()` on a global regex that DOES match also advances `lastIndex` — and the reset at 59 happens after `push`, before the next field iteration. This is actually safe in the current synchronous loop. However, if `test()` returns `true` but the value has multiple matches, the second call to `test()` on the SAME pattern for the NEXT field will start from `lastIndex=0` (reset at 59). **This is correct for the current code.** BUT: if `.test()` returns `false`, `lastIndex` auto-resets to 0 per spec. So this is actually **not a bug in the current code**.
- **Verdict**: **DOWNGRADE to LOW** — the code works correctly today but the pattern is fragile. The reset-after-match-only is unnecessary but not harmful.

### HIGH

#### CQ-2: `searchFts` LIKE Fallback Doesn't Escape SQL Wildcards
- **File**: `src/storage/skill-repository.ts:443`
- **Code**: `const likePattern = '%${query}%'`
- **Verified**: Line 443 confirms. Query is parameterized (no SQL injection), but `%` and `_` in user input are interpreted as LIKE wildcards. A query of `%` matches every skill.
- **Fix**: Escape LIKE wildcards: `query.replace(/[%_]/g, '\\$&')` + `ESCAPE '\\'` in SQL.

#### CQ-3: `loadConfig` Shallow Spread Shares Nested Object References
- **File**: `src/core/config.ts:367`
- **Code**: `return { ...DEFAULT_CONFIG };`
- **Verified**: Line 367. `DEFAULT_CONFIG` has nested objects (`features`, `toolBudget`, `payloadLimits`, etc.). Shallow spread means mutations to returned config's nested properties corrupt `DEFAULT_CONFIG` for subsequent calls.
- **Fix**: `return structuredClone(DEFAULT_CONFIG);`

#### CQ-4: REST Server OpenAPI Trusts `x-forwarded-proto` Without Validation
- **File**: `src/server/rest-server.ts:583`
- **Code**: `const protocol = (request.headers['x-forwarded-proto'] as string) ?? 'http';`
- **Verified**: Line 583. Arbitrary values (including `javascript:`) injected into OpenAPI spec URL.
- **Fix**: Validate against `['http', 'https']`.

#### CQ-5: Audit Log `loadLastHash` Reads Entire File into Memory
- **File**: `src/replay/audit-log.ts:291`
- **Code**: `const content = readFileSync(this.auditFilePath, 'utf-8').trim();`
- **Verified**: Line 291. Reads entire file, splits all lines, uses only last line. Unbounded growth for long-running daemons.
- **Fix**: Read from end of file or use a streaming approach.

#### CQ-6: MCP HTTP Session Double-Close Race
- **File**: `src/server/mcp-http.ts:62-67` and `170-177`
- **Verified**: When `transport.onclose` fires during normal (non-shutdown) operation: (1) `session?.server.close()` called at line 176, (2) `sessions.delete(sid)` at line 177 triggers `onEvict` which calls `session.server.close()` AGAIN async at line 65. The `.catch(() => {})` at line 66 masks any double-close error. Most MCP SDK `Server.close()` is idempotent, but this is still a race condition.
- **Fix**: Either remove `onEvict` callback (cleanup is already explicit in `onclose` + shutdown) or skip `delete` in `onclose` to avoid triggering eviction.

---

## 3. Code Simplification

### HIGH

#### CS-1: Duplicated Domain-Matching Logic
- **Files**: `src/core/policy.ts:262-304` vs `src/shared/domain-utils.ts:9-21`
- **Verified**: `policy.ts` has `enforceDomainAllowlist` and `matchesDomainAllowlist` using `normalizeDomain()` (handles IPv6, IDN, trailing dots). `domain-utils.ts` has `isDomainMatch` using only `toLowerCase()`. Same matching logic, different normalization depth.
- **Risk**: A domain passing one check might fail the other.
- **Fix**: Consolidate into `shared/domain-utils.ts` with full normalization.

#### CS-2: Duplicated `checkPathRisk` in Two Files
- **Files**: `src/core/policy.ts:467-492` vs `src/skill/path-risk.ts:43-95`
- **Verified**: Both export `checkPathRisk`. `policy.ts` version uses flat `Set<string>` allowlist. `path-risk.ts` version uses `Map<string, Set<string>>` keyed by siteId (more granular).
- **Risk**: Callers must know which to use. Maintenance hazard.
- **Fix**: Consolidate into single module with siteId-scoped allowlist.

### MEDIUM

#### CS-3: Duplicated Config Setter Logic
- **File**: `src/core/config.ts:626-690`
- **Verified**: `setConfigValue` (line 626) and `setConfigValueInMemory` (line 659) share ~30 lines of identical key traversal, boolean/number coercion, and validation logic.
- **Fix**: Extract shared helper for the common traversal + coercion + validation.

#### CS-4: Nested try/catch Pyramids in trust.ts
- **File**: `src/trust.ts:48-62`
- **Verified**: 4 functions (`getNetworkInfo`, `getSecretsInfo`, `getSkillsInfo`, `getRetentionInfo`) all follow identical 2-level try/catch: check DB path exists → try getDatabase → try query → catch warn.
- **Fix**: Extract `withDatabase(config, callback)` helper.

#### CS-5: Invariant Evaluator Duplication
- **File**: `src/shared/invariant-utils.ts:23-94`
- **Verified**: Colon-delimited format (`must_include_field:X`) and natural-language format (`must include field X`) are separate handlers with identical logic.
- **Fix**: Normalize input format first, then run single handler.

### LOW

#### CS-6: Dead Code — `setLogLevel` Not Exported
- **File**: `src/core/logger.ts:29`
- **Verified**: Defined but not exported. Cannot be called externally.

#### CS-7: Dead Code — `updateConfidenceDecay`
- **File**: `src/skill/versioning.ts:67-72`
- **Verified**: Defined but not exported or referenced.

#### CS-8: Dead Code — `TransportMode` Type
- **File**: `src/shared/daemon-types.ts:11`
- **Verified**: `type TransportMode = 'uds' | 'tcp'` defined but never used. `TransportConfig` uses literal strings directly.

---

## 4. Comment Accuracy

### CRITICAL (Factually Wrong)

#### CA-1: `webmcp` Default Comment Says `false`, Actual Default is `true`
- **File**: `src/skill/types.ts:599`
- **Comment**: `webmcp: boolean; // default: false`
- **Verified**: `src/core/config.ts:33` sets `webmcp: true`.
- **Fix**: Change comment to `// default: true`.

#### CA-2: IPv6 "Blacklist Approach" Comment is Wrong
- **File**: `src/core/policy.ts:315-316`
- **Comment**: "IPv6: Blacklist approach — specific ranges are blocked. Implication: New IPv6 range types are allowed by default."
- **Verified**: Line 401 returns `range === 'unicast'` for IPv6 — this IS a whitelist, not a blacklist. The `BLOCKED_IPV6_RANGES` at line 318 is defense-in-depth early-exit, not the primary gate.
- **Fix**: Rewrite to reflect both IPv4 and IPv6 ultimately require `range === 'unicast'`.

#### CA-3: Audit Log Fallback Key Called "Stronger" — It's Weaker
- **File**: `src/replay/audit-log.ts:43`
- **Comment**: "Fallback key: stronger derivation using dataDir + hostname"
- **Verified**: Line 44 shows it's deterministic from known values (`dataDir + hostname`). The keychain key (random) is objectively stronger.
- **Fix**: Change "stronger" to "deterministic fallback" or "weaker fallback".

#### CA-4: Doctor.ts Log Message Says "stat" But Operation is "rmSync"
- **File**: `src/doctor.ts:191`
- **Code**: `log.debug({ err }, 'Failed to stat file during stale check')`
- **Verified**: Line 188 shows the operation is `fs.rmSync`, not `fs.statSync`.
- **Fix**: Change log message to `'Failed to remove stale entry during cleanup'`.

### HIGH (Misleading)

#### CA-5: Daemon Config Intersection Type is Redundant
- **File**: `src/core/config.ts:28-29`
- **Comment**: "Daemon config merged into default config alongside all other settings"
- **Verified**: `SchruteConfig` interface at `types.ts:648-651` already includes `daemon: { port: number; autoStart: boolean }`. The `& { daemon: ... }` intersection is redundant.
- **Fix**: Remove the intersection type; use plain `SchruteConfig`.

#### CA-6: HAR Recorder Pipeline Comment Inaccurate
- **File**: `src/browser/har-recorder.ts:22`
- **Comment**: "Pipeline: raw HAR -> redactor.redact() -> durable store commit"
- **Verified**: Line 29 shows actual function is `this.redactFn()` (a pluggable function via `setRedactor()`), not `redactor.redact()`.
- **Fix**: Change to "Pipeline: raw HAR -> redactFn() -> durable store commit".

#### CA-7: BoundedMap Size Threshold Estimate Outdated
- **File**: `src/shared/bounded-map.ts:4`
- **Comment**: "O(n) eviction scan is acceptable for maps up to ~5 000 entries"
- **Verified**: Multiple callers create maps with `maxSize: 10000`.
- **Fix**: Update threshold estimate or note that 10K entries are within bounds.

### MEDIUM

#### CA-8: Historical Dedup Comments in utils.ts Add Clutter
- **File**: `src/core/utils.ts:7-9,23-24,54-57,85-87,106-108,123-126`
- **Verified**: Multiple comments like "(was duplicated in compiler.ts, executor.ts, redactor.ts)" referencing completed refactoring.
- **Fix**: Remove historical notes; the canonical location is self-evident.

#### CA-9: `withTimeout` Historical Comparison No Longer Relevant
- **File**: `src/core/utils.ts:54-57`
- **Comment**: "redactor.ts previously accepted a thunk; callers should wrap with withTimeout(fn(), ms) instead."
- **Verified**: This describes a past refactoring. `redactor.ts` already uses the current API.
- **Fix**: Remove. Keep only the JSDoc.

---

## 5. Test Coverage Gaps

### CRITICAL (No Test Coverage for Security/Data-Critical Modules)

#### TA-1: `src/server/mcp-handlers.ts` — Zero tests (Severity 9/10)
- **Verified**: No test file found.
- **Untested security surface**: Path traversal defense, credential redaction via `redactSkill`, `truncateList` binary search for payload sizing.

#### TA-2: `src/capture/har-extractor.ts` — Zero tests (Severity 8/10)
- **Verified**: No test file found.
- **Risk**: Entry point for entire capture pipeline. Malformed HAR silently corrupts skill generation.

#### TA-3: `src/storage/database.ts` — Zero tests (Severity 8/10)
- **Verified**: No test file found.
- **Risk**: 11 SQL migrations, singleton guard, exit handler lifecycle all untested.

#### TA-4: `src/storage/skill-repository.ts` — Zero tests (Severity 8/10)
- **Verified**: No test file found.
- **Risk**: Six type validators, four shape assertions, dynamic UPDATE SQL construction, FTS5-to-LIKE fallback.

#### TA-5: `src/browser/manager.ts` — Effectively untested (Severity 8/10)
- **Verified**: Test files exist but test mock infrastructure, not actual manager behavior.
- **Risk**: 1000+ line module managing browser lifecycle, proxy config, network interception, cleanup.

### HIGH (Important Untested Paths)

#### TA-6: Pinned IP Fetch Bypassed by Mocks (Severity 7/10)
- **File**: `src/replay/executor.ts:599-765`
- **Verified**: All executor tests inject mock `fetchFn`, completely bypassing `pinnedIpFetch` SSRF protection.

#### TA-7: Socket Validation and TCP Fallback Untested (Severity 7/10)
- **File**: `src/server/daemon.ts:79-136`
- **Verified**: `validateAndCleanSocket`, stale socket detection, `writeTokenFile` symlink protection all untested.

#### TA-8: IPv4-Mapped IPv6 SSRF Bypass Untested (Severity 6/10)
- **File**: `src/core/policy.ts:389-393`
- **Verified**: The `isIPv4MappedAddress()` recursive check path exists but no test uses `::ffff:10.0.0.1` etc.

#### TA-9: Policy Test Uses Real DNS (Flaky)
- **File**: `tests/unit/policy.test.ts:354-371`
- **Verified**: `resolveAndValidate('localhost')` does real DNS lookup. Flaky in CI without network.
- **Fix**: Mock `dns.lookup` or use `vi.useFakeTimers()`.

#### TA-10: Confirmation Test 1ms Expiry Window
- **File**: `tests/unit/confirmation.test.ts:158-170`
- **Verified**: Uses `confirmationExpiryMs: 1` — extremely tight, fragile under load.
- **Fix**: Use `vi.useFakeTimers()` or increase to 50ms.

### MEDIUM

#### TA-11: Engine Test Over-Mocking
- **File**: `tests/unit/engine.test.ts`
- **Verified**: Mocks ~20 dependencies. If interfaces diverge, tests provide false confidence.

#### TA-12: Executor Tests Bypass All Real Fetch Paths
- **File**: `tests/unit/executor.test.ts`
- **Verified**: Mock `fetchFn` bypasses `directFetch`, `pinnedIpFetch`, `fullBrowserExecution`.

---

## 6. Type Design

### HIGH

#### TD-1: `getConfig()` Returns Mutable Cached Singleton
- **File**: `src/core/config.ts`
- **Verified**: `getConfig()` returns the cached reference directly. Any caller mutating nested properties corrupts shared state.
- **Fix**: Return `structuredClone` or `DeepReadonly<SchruteConfig>`.

#### TD-2: SDK Types Manually Mirror Server Enums — Drift Risk
- **File**: `src/client/typescript/types.ts`
- **Verified**: Re-declares `SkillStatus`, `ExecutionTier`, etc. as standalone string unions without importing from server types.
- **Fix**: Generate from server types or add a sync test.

### MEDIUM

#### TD-3: `SitePolicy.allowedMethods` Typed as `string[]`
- **File**: `src/skill/types.ts:456`
- **Verified**: No validation that method values are valid HTTP methods.
- **Fix**: Narrow to union type: `Array<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'>`.

#### TD-4: `BoundedMap.clear()` Doesn't Call `onEvict`
- **File**: `src/shared/bounded-map.ts:98-100`
- **Verified**: `delete()` calls `onEvict` (line 94). `clear()` does NOT (line 99). In `mcp-http.ts`, this inconsistency is intentionally used during shutdown (comment at line 180-181), but the `BoundedMap` class itself has no documentation about this behavior difference.
- **Fix**: Document the intentional difference in the class, or make `clear()` accept an `{ skipEvict?: boolean }` option.

---

## Removed Findings (False Positives / Design Decisions)

The following findings from the initial review were removed after source verification:

| ID | Reason Removed |
|----|---------------|
| FD-1 (Budget tracker leak) | **False positive.** Line 153-154 of `executor.ts` explicitly calls `releaseCall` in the strict-mode early-return path before returning at line 158. The `finally` at 172 handles the `executeTier` path. Both paths are covered. |
| FD-3 (LifecycleGuard.drainLock) | **By design.** The promise chain is transitive — the last promise depends on all prior completions. This is correct. |
| FD-8 (writeTokenFile containment) | **Defense-in-depth, not a bug.** The first `startsWith` check covers subdirectories; the second OR condition adds direct-child check. Combined, they correctly restrict to dataDir. |
| FD-9 (Audit non-strict invalid entries) | **Design decision.** Non-strict mode explicitly chooses availability over correctness. Documented behavior. |
| FD-10 (Skill delete redundant cascades) | **Defensive coding.** The comment "no FK cascade guarantee" is intentional — the manual deletes ensure safety even if FK pragmas are misconfigured. |
| FD-6 (verifyBearerToken length check) | **Standard pattern.** `timingSafeEqual` REQUIRES equal-length buffers (throws otherwise). The length check is not a side channel — it's required API usage. Daemon tokens are fixed-length. |
| CR-2 (setLogLevel dead code) | Moved to CS-6 (dead code). Not a code quality bug per se. |
| CR-5 (BoundedMap iterator mutation) | **Safe by JavaScript spec.** Deleting entries from a Map during `for...of` iteration is explicitly supported — deleted entries won't be revisited. This is documented behavior. |
| CS-8 (doctor.ts `as const`) | **Style nit, not actionable.** `'warning' as const` is harmless. |
| CS-9 (nested ternary in formatDoctorReport) | **Style nit.** A 3-branch ternary for pass/fail/warn is readable and idiomatic. |
| CS-11 (engine check in doctor.ts) | **Intentional.** Warning about engine fallback IS useful information for operators. |
| CS-12 (FAILURE_CAUSE_PRECEDENCE unused) | **Used as documentation.** The array documents the canonical precedence order and is referenced by executor tests. |
| CS-14 (sequential DB queries in monitor) | **Acceptable.** 150 rows × N skills is bounded by design. N is small in practice. |
| CS-19 (UNSUPPORTED_PROTOCOLS) | **Intentional documentation as code.** Serves as both runtime reference and docs. |
| CS-20 (generateEvidenceReport not exported) | **Called internally** within generator.ts by other functions. It IS used. |
| CA-6 (patchright supportsConsoleEvents) | **Correct.** Patchright uses Chromium under the hood but its JS bindings don't expose console events the same way. The capability is accurately set. |
| CA-7 (version.ts references non-existent script) | **False positive.** `scripts/sync-version.js` EXISTS in the scripts directory. |
| CA-10 (BrowserProviderFactory comment) | **Accurate.** The comment says "supports ... AgentBrowserAdapter" as a class-level design note, not claiming the factory creates them. Accurate as extension-point documentation. |
| SF-9 (Config parse error fallback) | **Intentional resilience.** Logging at `error` level (line 488) is appropriate. Throwing would prevent daemon startup entirely. |
| SF-11 (Database policy load fallback) | **Intentional fail-closed.** Returns null → restrictive defaults. Logged at `error`. This is the correct security behavior. |
| TD-3 related (ConfirmationToken, SkillSpec) | **Deliberate flat design.** Line 352 of types.ts explicitly documents: "Flat interface by design — factory construction and Zod validation are applied at creation boundaries." |
| TD-4 (BoundedMap clear/onEvict) | Moved to verified TD-4 with nuance about intentional mcp-http usage. |
| All "engine.ts:1385 fall through" (SF-4) | **Partially by design.** The outer catch at line 1373-1375 DOES log. Line 1385 is only the lazy factory lambda — a secondary fallback path. **However**, the lambda catch is still silent, so SF-4 finding stands but downgraded from the original report's framing. The main path logs. |

### Findings Merged / Deduplicated

Several findings appeared in multiple agents. The canonical entry is kept; duplicates removed:
- `setLogLevel` dead code: reported by PR Code Reviewer AND Code Simplifier → kept as CS-6
- `BoundedMap.clear()` vs `onEvict`: reported by Code Reviewer, Type Analyzer, Feature Dev → kept as TD-4
- Domain matching duplication: reported by Code Simplifier → kept as CS-1
- Empty catch blocks: consolidated into SF-10 from multiple agent reports
