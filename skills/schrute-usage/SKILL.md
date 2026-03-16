---
name: schrute-usage
description: Comprehensive guide to Schrute's self-learning browser agent workflow, covering skill recording, execution tiers, tier promotion, confirmation system, and security model. Use when user asks "how does schrute work", "record a skill", "schrute tiers", "skill execution", "schrute workflow", "how do I use schrute", or needs help understanding the explore-record-replay cycle.
user-invocable: true
argument-hint: "[topic]"
allowed-tools: ["mcp__schrute__schrute_status", "mcp__schrute__schrute_skills", "mcp__schrute__schrute_sites"]
metadata:
  author: Schrute Contributors
  version: 0.1.0
  mcp-server: schrute
---

# Schrute Usage Guide

## Core Workflow

Schrute learns API behaviors by observing browser interactions and generates replayable "skills."

### Step 1: Explore
Start a browser session on a target site:
```
/schrute:explore https://api.example.com
```
This opens a Playwright browser context and begins monitoring network traffic.

### Step 2: Record
Name the action and perform it in the browser:
```
/schrute:record search-products --input query=laptop
```
All network requests during recording are captured in a HAR file.

### Step 3: Stop & Generate
Stop recording to process the capture:
```
/schrute:record  (then say "stop" when done)
```
The capture pipeline: HAR parsing → noise filtering → auth detection → parameter discovery → chain detection → endpoint clustering → skill generation.

### Step 4: Use Skills
Generated skills appear as MCP tools. They execute through the tier system:

| Tier | Name | Latency | Method |
|------|------|---------|--------|
| 1 | Direct | 1-50ms | HTTP fetch with strict headers |
| 2 | Cookie Refresh | 5-100ms | Fetch + auto cookie refresh |
| 3 | Browser Proxied | 100-500ms | Browser context fetch (default start) |
| 4 | Full Browser | 1-10s | Full Playwright page automation |

Skills start at Tier 3 and promote to Tier 1 after 5 consecutive successful validations with low volatility.

## Confirmation System

ALL newly-activated skills require one-time confirmation before first execution, regardless of their side-effect class. Use `schrute_confirm` with the provided token to approve or deny.

## Side-Effect Classes

- **read-only**: Safe GET requests, retryable
- **idempotent**: PUT/PATCH that produce same result on retry
- **non-idempotent**: POST/DELETE that modify state

## Key Commands

| Command | Purpose |
|---------|---------|
| `/schrute:explore <url>` | Start browser session |
| `/schrute:record <name>` | Record an action |
| `/schrute:skills` | List all skills |
| `/schrute:doctor` | Health diagnostics |
| `/schrute:status` | Engine/daemon status |

## Browser Tools

19 browser automation tools are available during exploration:
`browser_navigate`, `browser_click`, `browser_type`, `browser_snapshot`, `browser_fill_form`, `browser_press_key`, `browser_hover`, `browser_drag`, `browser_select_option`, `browser_file_upload`, `browser_handle_dialog`, `browser_tabs`, `browser_take_screenshot`, `browser_wait_for`, `browser_close`, `browser_resize`, `browser_console_messages`, `browser_network_requests`, `browser_navigate_back`.

Blocked for security: `browser_evaluate`, `browser_run_code`, `browser_install`.

## Policy Enforcement

9 security gates protect every skill execution:
1. Capability check (is the tier's capability enabled?)
2. Domain allowlist (is the target domain permitted?)
3. Method restriction (is the HTTP method allowed?)
4. Path risk heuristics (does the path look destructive?)
5. Rate limiting (is the site being hammered?)
6. SSRF prevention (is the target a private IP?)
7. Redirect validation (does each redirect hop pass policy?)
8. Budget tracking (are tool call limits respected?)
9. Audit logging (is the execution properly recorded?)

## Configuration

Config file: `~/.schrute/config.json`

Key settings:
- `toolShortlistK`: Max tools exposed at once (default: 10)
- `payloadLimits.maxResponseBodyBytes`: Response size cap (default: 10MB)
- `audit.strictMode`: Require HMAC-signed audit log (default: true)
- `confirmationTimeoutMs`: Approval window (default: 30s)

## Deep References

For detailed information on specific topics, see:
- **Tier system details**: `reference/tier-system.md` — promotion/demotion algorithm, tier lock, latency characteristics
- **Security model**: `reference/security-model.md` — 9 gates explained, confirmation flow, credential handling
- **Example workflow**: `examples/workflow-github.md` — full end-to-end recording walkthrough with GitHub
