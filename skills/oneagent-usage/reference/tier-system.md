# Execution Tier System — Deep Reference

## Tier Architecture

OneAgent skills execute through a 4-tier cascading system. Each tier represents a different execution strategy with varying latency, reliability, and capability tradeoffs.

### Tier 1: Direct HTTP Fetch
- **Latency**: 1-50ms
- **Method**: Raw HTTP fetch with strict headers copied from the recorded session
- **When used**: After 5 consecutive successful validations with low volatility
- **Strengths**: Fastest, lowest overhead, no browser dependency
- **Limitations**: Cannot handle dynamic cookies, CSRF tokens, or JavaScript-rendered content
- **Demotion trigger**: Any validation failure demotes back to Tier 3

### Tier 2: Cookie Refresh
- **Latency**: 5-100ms
- **Method**: HTTP fetch with automatic cookie refresh from browser context
- **When used**: When Tier 1 fails due to expired cookies but response structure is stable
- **Strengths**: Handles cookie-based auth without full browser overhead
- **Limitations**: Cannot handle CSRF tokens or JS-dependent request construction

### Tier 3: Browser Proxied (Default Start)
- **Latency**: 100-500ms
- **Method**: Request executed through browser context's fetch API
- **When used**: Default starting tier for all new skills
- **Strengths**: Full cookie jar, proper CORS handling, JavaScript execution context
- **Limitations**: Slower than direct, requires active browser context

### Tier 4: Full Browser Automation
- **Latency**: 1-10 seconds
- **Method**: Full Playwright page automation (navigate, click, fill, wait)
- **When used**: When API-level replay fails (SPAs, multi-step flows)
- **Strengths**: Can handle any web interaction, JavaScript rendering, dynamic content
- **Limitations**: Slowest, highest resource usage, most fragile to UI changes

## Promotion Algorithm

Skills start at Tier 3 and can be promoted based on:
1. **Consecutive successes**: 5 successful executions at current tier
2. **Low volatility**: Response structure matches expected schema (field names, types, nesting)
3. **Stable headers**: No new required headers detected between executions

Promotion path: Tier 3 → Tier 2 → Tier 1 (never promotes to Tier 4; that's a fallback only)

## Demotion

Any validation failure triggers immediate demotion:
- Tier 1 → Tier 3 (skips Tier 2 for safety)
- Tier 2 → Tier 3
- Tier 3 → Tier 4 (only after retry exhaustion)

## Tier Lock

Skills can be permanently locked to a tier via `tierLock` in the skill definition. Use cases:
- Lock to Tier 4 for UI-dependent flows that can never be pure API
- Lock to Tier 3 minimum for CSRF-protected endpoints
