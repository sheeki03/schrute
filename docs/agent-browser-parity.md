# Agent-Browser Parity Matrix

Status: PENDING VERIFICATION

## Execution Gates

| Method | agent-browser Command | Status | Notes |
|--------|----------------------|--------|-------|
| navigate(url) | `open <url>` | PENDING | Verify domain allowlist enforcement |
| evaluateFetch(req) | `eval '<sealed fetch>'` | PENDING | Verify no arbitrary JS beyond sealed template |
| networkRequests() | `network requests --json` | PENDING | Verify response body + headers + timing |
| getCurrentUrl() | `get url` | PENDING | |
| Cookie get/set/clear | `cookies get/set/clear` | PENDING | Verify domain scoping, httpOnly handling |
| Session isolation | `--session <name>` | PENDING | Verify cross-session isolation |
| Lightpanda engine | `--engine lightpanda` | PENDING | Verify same security constraints as Chrome |

## Security Gates

| Check | Status | Notes |
|-------|--------|-------|
| Private IP / SSRF blocking | PENDING | Verify agent-browser blocks private IPs |
| Domain allowlist | PENDING | Verify navigation restricted to allowed domains |
| Header scoping | PENDING | Verify hop-by-hop headers blocked |
| Redirect behavior | PENDING | Verify evaluateFetch() does NOT auto-follow redirects |

## Explore-Only (Not Required for Execution)

| Method | agent-browser Command | Status |
|--------|----------------------|--------|
| snapshot() | `snapshot -i` | N/A (explore only) |
| click/type | `click/fill` | N/A (explore only) |
| screenshot() | `screenshot` | N/A (explore only) |
