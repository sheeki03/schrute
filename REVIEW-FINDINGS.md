# Schrute Codebase Review — Verified Findings

Generated: 2026-03-04
Verified: 2026-03-04 — each finding checked against actual code. False positives, design decisions, and non-issues removed.

---

## Removed Findings (with reasons)

| # | Original Finding | Reason Removed |
|---|-----------------|----------------|
| 8 | IPv6 blacklist instead of whitelist | **False positive.** Code at policy.ts:345 has `return range === 'unicast'` as the final guard for BOTH IPv4 and IPv6. Plus explicit CIDR checks for `fc00::/7`, `fe80::/10`, `::1/128` etc at lines 288-294. This is defense-in-depth, not a gap. |
| 10 | Patchright fallback masks installation failures | **Design decision.** Code at engine.ts:59 explicitly checks `isModuleNotFound(importErr, 'patchright')` — only falls back when the package is not installed. Non-installation errors (line 75: `throw importErr`) are re-thrown. The warn log is actionable with install instructions. |
| 11 | Keychain degrades cookies to in-memory | **Design decision.** CookieJar is an optional enhancement layer, not the primary persistence. Browser cookies persist via `storage-state.json` (manager.ts:507-514). Keytar is for cross-session cookie jar only. The warn log at line 57 is appropriate. |
| 12 | Redaction salt ephemeral fallback | **Design decision.** The warn log at redactor.ts:22-24 explicitly states "HMAC redaction will not be stable across restarts." This is the documented graceful degradation path — crashing would be worse than ephemeral salt. |
| 13 | Confirmation HMAC ephemeral fallback | **Design decision.** Same pattern as redactor. The warn at confirmation.ts:31 says "will not survive daemon restart." Confirmation tokens are DB-backed (ConfirmationManager class), the HMAC is signing protection, not the primary gate. |
| 14 | Audit HMAC derived key fallback | **Design decision.** audit-log.ts:70-74 explicitly documents the fallback. The derived key is deterministic (stable across restarts from same data dir), not random. This is acceptable degradation. |
| 15 | Policy loading falls back to restrictive defaults | **Design decision (fail-closed).** Falling back to restrictive defaults on DB error is the correct security posture. The error is logged at `error` level (policy.ts:97). This prevents a corrupted DB from opening access. |
| 16 | Executor broad catch classifies as UNKNOWN | **Already handled.** The catch at executor.ts:165-167 logs at `error` level with the full error object. The `UNKNOWN` cause is returned alongside the error. Callers (engine.ts) can inspect `result.error`. The outer `executeTier` catch is intentionally a last-resort safety net. |
| 17 | semantic-check empty catch | **False positive.** The catch at semantic-check.ts:102-103 is correct — `checkErrorSignatures` probes whether the body is JSON with error fields. Non-JSON bodies should return empty (no signatures found), not throw. The function already handles non-JSON via regex checks on lines 106-107. |
| 19 | closeAll mutating map during iteration | **False positive in practice.** V8's Map iteration spec (ES2015 §23.1.3.5) guarantees that deleted entries are skipped and no crash occurs. The `for...of` over Map is safe per spec. Additionally, `close()` at multi-session.ts:143 only deletes the current entry, not others. |
| 23 | sharedBrowserManager singleton race | **Design decision.** Cookie refresh is called from a single-threaded scheduler (rate-limiter). The function signature accepts an optional `browserManager` param precisely to avoid the singleton in concurrent contexts. The singleton is for the simple CLI case. |
| 24 | ToolBudgetTracker never resets | **Correct behavior.** The budget is per-engine-lifetime by design — `maxToolCallsPerTask` is a safety limit on total tool calls, not per-MCP-session. The engine is short-lived (one `serve` session). The `reset()` method exists for testing. |
| 25 | DNS cache 60s TOCTOU | **Design decision with mitigation.** The 60s TTL is for performance. IP pinning (executor.ts:545-558) provides the actual rebinding protection by substituting the resolved IP into the request URL at fetch time. The cache is an optimization layer, not the security boundary. |
| 27 | fullBrowserExecution hardcoded 2s delay | **Acceptable tradeoff.** Comments at executor.ts:615-617 explain: "navigate() resolves on DOMContentLoaded, which fires before most async API calls complete." This is a Tier 4 (full browser) path for last-resort execution. The 2s settle time is a pragmatic choice for an uncommon code path. |
| 29 | parseDomainEntries allows port | **By design.** `new URL('http://example.com:8080').hostname` returns `example.com` — extracting the hostname is intentional. Domain allowlists are host-based, not port-scoped. The comment in tool-dispatch.ts (webmcp section) explicitly documents port-agnostic behavior. |
| 30 | Empty catch in idleShutdown | **Acceptable.** manager.ts:271-274 already nulls the browser ref synchronously before the close. The close is best-effort cleanup of a detached reference. Adding debug logging would be harmless but the browser process is already unreferenced. |
| 31 | CDP reconnect abort close catch | **Acceptable.** manager.ts:692-696 — when reconnect is aborted, we're tearing down. The browser ref is local, not stored. If close fails, the process will be cleaned up on exit. This is teardown code. |
| 32 | detectAndWaitForChallenge catches all errors | **Already fixed.** This was addressed in review round 3 — the catch at base-browser-adapter.ts:70 now handles the pre-check error case. Returning false (no challenge) when the page context is destroyed is correct — you can't detect challenges on a dead page. |
| 38 | navigateFireAndForget failure invisible | **Design decision.** The function name explicitly says "FireAndForget." The explore() response at engine.ts:328 returns the sessionId — the user calls `browser_snapshot` next, which shows the current page state. If navigation failed, the snapshot shows a blank/error page which is self-evident. |
| 42 | IP pinning fallback to hostname | **False positive.** executor.ts:556-557 — this catch block only fires if `new URL()` fails to substitute the pinned IP into the URL, which is a URL construction error (e.g., malformed URL), not a DNS failure. DNS resolution has already succeeded at this point (pinnedIp is set). |
| 43 | WebMCP scan false negative | **Acceptable.** The scan runs on cold-start (fire-and-forget). Returning `available: false` on error is fail-closed — it prevents executing unverified tools. The warn log at webmcp-scanner.ts:89 provides diagnostics. |
| 44 | GraphQL scanner SSRF empty catch | **False positive.** graphql-scanner.ts:77-78 — the catch lets the fetch below handle the error. The fetch itself goes through the same DNS/IP validation pipeline. The URL parse here is a pre-check optimization, not the security boundary. The comment says "let the fetch below handle it." |
| 46 | Challenge timeout discards error | **Already fixed.** This was a finding from review round 3 that was addressed by adding the error to the log. |
| 47 | Recording listener cleanup empty catches | **Acceptable.** engine.ts:432-433 and 450-451 — these run during error recovery (line 426 catch block) and stop-recording (line 440). The listeners are page event handlers that may already be detached if the page closed. Throwing here would mask the original error. |
| 48 | cf_clearance parse at debug | **Acceptable.** manager.ts:444-445 — this is a non-critical advisory check. The storage state has already been loaded and applied to the browser context. This catch only affects the informational log message about cf_clearance. |
| 49 | Timezone verification at debug | **Acceptable.** manager.ts:418-419 — the timezone has already been set (line 393-395). This is a post-hoc verification. The warn on line 416 fires when verification succeeds but doesn't match. The debug catch is for when verification itself fails (page closed, etc). |
| 50 | safeProxyUrl returns [invalid-url] | **Design decision.** This function is ONLY used for logging (line 450). The proxy server URL has already been validated during config parsing. This is a display-safe fallback for the rare case where a previously-valid URL becomes unparseable. |
| 52 | JPEG-to-PNG fallback unlogged | **Minor.** The mimeType is returned to the caller who can see it changed. Adding a debug log would be fine but this is viewport-screenshot code that rarely triggers the oversized path (default viewport is 1280x720, well under limits). |
| 53 | snapshotWithScreenshot error not logged | **Acceptable.** The error message is propagated to the MCP client via `screenshotError` field. The client (Claude) sees the error and can report it. Server-side logging would duplicate information already in the response. |
| 54 | parseDomainEntries discards parse error | **Acceptable.** The replacement error message is more actionable — it tells the user which entry is invalid and what format is expected, rather than showing raw URL parser internals. |
| 55 | DB insert noise filter no circuit breaker | **Acceptable.** Individual entry failures during recording should not stop the recording. The warn log per-entry is appropriate for a recording pipeline that processes hundreds of entries. |
| 56 | Invalid logLevel silently replaced | **Acceptable.** config.ts:395-399 — the warn log fires before the level is changed, so it will be visible at whatever level was previously configured. The fallback to 'info' is the safe default. |
| 57 | Modal auto-dismiss empty catch | **File doesn't exist at reported location.** modal-state.ts has no empty catch at line 77-82. The modal handling is inside base-browser-adapter.ts's `withModalRace`. |
| 58 | HAR recorder fire-and-forget | **Design decision.** The `void` prefix is intentional — HAR recording is supplementary and must not block browser disconnect handling. The HAR data has already been written incrementally during recording. |
| 59 | Storage state parse failure | **Acceptable.** manager.ts:443-446 — the storage state is an optimization (restoring cookies). Starting clean is the safe fallback. The warn log at line 517 covers save failures. |
| 62 | CycleTLS import catch | **Design decision.** tls-client.ts — CycleTLS is an optional dependency. The code correctly differentiates between "not installed" and "installed but broken" isn't needed because the user explicitly opts into CycleTLS via config. |
| 63 | Response parser JSON fallback | **Design decision.** response-parser.ts — treating unparseable JSON as raw string is correct. The semantic check downstream handles validation. Throwing would break the entire replay pipeline for a content-type mismatch (servers frequently mislabel content types). |
| 64 | Skill repo parseJson fallback | **Design decision.** The function is used for optional metadata fields (parameters, headers). The warn log provides the context. Throwing would prevent loading skills with slightly corrupted optional fields. |
| 65 | Skill compiler status 0 | **Acceptable.** `status: 0` correctly indicates "no HTTP response received." Callers check `success: false`, not status codes. The error message is also returned. |
| 66-78 | All P3 findings | **Quality nits.** These are all stylistic preferences (debug logging, thread safety in single-threaded code, performance of binary search on small lists, etc). None represent bugs or security issues. Removed for clarity. |

---

## Verified Findings — Must Fix

### P1 — Critical / Security (6 findings)

#### 1. REST API `/api/import-cookies` missing `sanitizeSiteId` — Path Traversal
**File:** `src/server/rest-server.ts:355`
**Confidence:** 0.95

Confirmed: `siteId` from request body passed directly to `browserManager.importCookies()`. The MCP path at `tool-dispatch.ts:609` calls `sanitizeSiteId()`. This is a real path traversal vector.

#### 2. REST API `/api/cdp/connect` missing `sanitizeSiteId` — Path Traversal
**File:** `src/server/rest-server.ts:318`
**Confidence:** 0.93

Confirmed: `const siteId = userSiteId ?? 'cdp-${name}'` — no sanitization. MCP path at `tool-dispatch.ts:520` sanitizes.

#### 3. REST API `/api/cdp/connect` missing domain allowlist and policy setup
**File:** `src/server/rest-server.ts:307-328`
**Confidence:** 0.92

Confirmed: MCP handler at tool-dispatch.ts:469-558 calls `setSitePolicy()` with domain allowlist, validates `name !== 'default'`, parses domain entries. REST handler has none of this.

#### 4. CSS Selector Injection via Unsanitized Input
**File:** `src/browser/snapshot-refs.ts:451`, `src/browser/base-browser-adapter.ts:554`
**Confidence:** 0.90

Confirmed: `entry.name` and `ref` are interpolated directly into CSS attribute selectors without escaping. A name containing `"]` breaks out of the selector.

#### 5. `setSitePolicy` only caches in memory — policies evaporate
**File:** `src/core/policy.ts:122-125`
**Confidence:** 0.90

Confirmed: `setSitePolicy()` only writes to in-memory Map. No DB persist. After 5-minute TTL (`POLICY_CACHE_TTL_MS`) or restart, `getSitePolicy()` falls back to `DEFAULT_SITE_POLICY` via `loadPolicyFromDb()` which finds nothing.

#### 6. Mutating shared `config` object
**File:** `src/index.ts:507`
**Confidence:** 0.91

Confirmed: `config.server.network = true` mutates the shared config object after REST server (line 500) is already created and running. The auth hook reads `config.server.network` at request time.

### P2 — Important / Logic (8 findings)

#### 7. REST API `/api/explore` bypasses proxy/geo validation
**File:** `src/server/rest-server.ts:235-238`
**Confidence:** 0.95

Confirmed: `{ proxy: request.body.proxy as any, geo: request.body.geo as any }` — zero validation. MCP path has 80+ lines of validation (protocol, URL, lat/lng, timezone, locale).

#### 8. DNS Rebinding for Browser-Proxied Tiers
**File:** `src/replay/executor.ts:282-292`
**Confidence:** 0.85

Confirmed: `resolvedIp` is passed to `directFetch` but NOT to `browserProvider.evaluateFetch(request)`. The browser does its own DNS resolution. This is a real TOCTOU window for Tier 3/4.

#### 9. `schrute_webmcp_call` lacks `toolName` validation
**File:** `src/server/tool-dispatch.ts:679`
**Confidence:** 0.84

Confirmed: `const toolName = args?.toolName as string` — no type check. If undefined/null, `executeWebMcpTool` gets wrong-typed value.

#### 10. Response Body Truncation Character vs Byte
**File:** `src/replay/executor.ts:320-322`
**Confidence:** 0.83

Confirmed: `Buffer.byteLength(response.body)` for check, `response.body.slice(0, maxResponseBytes)` for truncation. `string.slice` operates on characters, not bytes.

#### 11. `notify().catch(() => {})` — 5 empty catch blocks
**File:** `src/core/engine.ts:606, 751, 768, 923, 926`
**Confidence:** HIGH

Confirmed: Five instances of `.catch(() => {})`. Notification system failures are invisible. Should at minimum be `.catch(err => log.debug({ err }, '...'))`.

#### 12. `schrute_status` WebMCP catch returns fake data
**File:** `src/server/tool-dispatch.ts:357-359`
**Confidence:** HIGH

Confirmed: Catch returns `{ enabled: true, toolCount: 0, tools: [] }`. Indistinguishable from "working but no tools found." Should include `error` field or set `enabled: false`.

#### 13. `coldStartDiscovery` at debug level
**File:** `src/core/engine.ts:319-321`
**Confidence:** HIGH

Confirmed: `.catch(err => this.log.debug(...))`. Invisible at default `info` level. This means discovery failures are silently swallowed in production. Should be `warn`.

#### 14. Path Traversal in skill doc reader
**File:** `src/server/mcp-handlers.ts:120-137`
**Confidence:** 0.80

Confirmed: `siteId` from URI (line 120) used in `path.join(skillsDir, siteId)` without validating the resolved path stays within `skillsDir`. A siteId of `../../etc` would escape.

### Silent Failures — Worth Fixing (5 findings)

#### 15. `listSkillDocResources` swallows all filesystem errors
**File:** `src/server/mcp-handlers.ts:141-143`
**Confidence:** HIGH

Confirmed: Bare `catch {}` returning empty list. EACCES/ENOSPC masked. Should log at `warn`.

#### 16. Shutdown handler swallows MCP close errors
**File:** `src/index.ts:529-531`
**Confidence:** HIGH

Confirmed: `try { await handle.close(); } catch { /* ignore */ }`. Should log at `warn` — if MCP transport doesn't flush, responses are lost.

#### 17. Skill doc persistence at debug level
**File:** `src/core/engine.ts:659-661`
**Confidence:** HIGH

Confirmed: `this.log.debug({ err: docsErr }, 'Failed to persist skill docs (non-blocking)')`. Docs silently never generated in production. Should be `warn`.

#### 18. `fillForm` silently uses `first()` with multiple matches
**File:** `src/browser/base-browser-adapter.ts:1474-1483`
**Confidence:** HIGH

Confirmed: `getByLabel(key)` with count > 1 → silently uses `.first()`. Should log when ambiguous.

#### 19. Audit entry ID uses Math.random()
**File:** `src/replay/executor.ts:133`
**Confidence:** 0.82

Confirmed: `Math.random().toString(36).slice(2, 8)` in HMAC-signed audit chain. Should use `crypto.randomUUID()` for consistency with rest of codebase.

---

## Summary

| Category | Count |
|----------|-------|
| P1 — Critical/Security | 6 |
| P2 — Important/Logic | 8 |
| Silent Failures — Worth Fixing | 5 |
| **Total verified findings** | **19** |
| Removed (false positives / design decisions / acceptable) | **59** |

### Top Priority Fixes

1. **REST API path traversal** (#1, #2) — add `sanitizeSiteId()` calls
2. **REST API validation parity** (#3, #7) — extract shared validation from tool-dispatch
3. **CSS selector injection** (#4) — escape `entry.name` and `ref` in CSS selectors
4. **Ephemeral policies** (#5) — persist to DB in `setSitePolicy()`
5. **Config mutation** (#6) — clone config before mutating
