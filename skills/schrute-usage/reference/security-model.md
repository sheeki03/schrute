# Security Model — Deep Reference

## 9 Policy Enforcement Gates

Every skill execution passes through these gates in order. Failure at any gate blocks execution.

### Gate 1: Capability Check
Verifies the skill's required tier capability is enabled in config. Some capabilities are disabled by default (e.g., Tier 1 direct fetch for non-idempotent methods).

### Gate 2: Domain Allowlist
Checks the target domain against the site's domain allowlist. If no explicit policy exists, bootstraps from `skill.allowedDomains + siteId`. Wildcards are rejected in implicit allowlists.

### Gate 3: Method Restriction
Validates the HTTP method is permitted. By default: GET, HEAD, OPTIONS are always allowed. POST, PUT, PATCH, DELETE require explicit confirmation.

### Gate 4: Path Risk Heuristics
Analyzes the URL path for destructive patterns (e.g., `/delete`, `/drop`, `/destroy`, `/admin/reset`). High-risk paths require extra confirmation regardless of method.

### Gate 5: Rate Limiting
Per-site rate limiter prevents hammering. Default: 60 requests/minute per site. Configurable via site policy.

### Gate 6: SSRF Prevention
Blocks requests to private IP ranges (10.x, 172.16-31.x, 192.168.x, 127.x, ::1, link-local). CIDR matching uses fail-closed semantics — parse errors block the request.

### Gate 7: Redirect Validation
Each redirect hop is independently validated: domain allowlist, IP check, and max hop count (default: 10). Relative redirects are resolved against the current hop's URL.

### Gate 8: Budget Tracking
Enforces per-session tool call budgets. Default: 100 tool calls per session. Prevents runaway automation.

### Gate 9: Audit Logging
All executions are recorded in an append-only JSONL audit log with HMAC hash chaining (when strict mode is enabled). Failed executions are logged with failure cause.

## Confirmation System

ALL newly-activated skills require one-time human confirmation before first execution. This applies regardless of side-effect class (read-only, idempotent, non-idempotent).

Confirmation flow:
1. Skill activation triggers a confirmation prompt with a unique token
2. User reviews the skill's method, URL pattern, and domains
3. User calls `schrute_confirm` with the token to approve or deny
4. Confirmation is persisted in the database — one-time per skill

## Credential Handling

- Credentials detected during recording are redacted before storage
- Auth tokens, API keys, and session cookies are stored in the system keychain
- Redaction is tracked in the audit log via `redactionsApplied` count
- PII detection flags entries that required redaction
