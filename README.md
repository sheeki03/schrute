<p align="center">
  <img src="assets/logo.png" alt="Schrute" width="200">
</p>

<h1 align="center">Schrute</h1>

<p align="center"><strong>Your AI uses a browser the first time. After that, it calls the API directly — 200x faster.</strong></p>

Schrute is an MCP server that watches your AI agent interact with websites, learns the underlying API calls, and replays them at HTTP speed. No API keys needed. No documentation reading. Just use a website once, and Schrute turns it into a fast, replayable tool.

```
Execution 1:   🌐 Browser automation .............. 3,200ms
Execution 10:  🔄 Browser-proxied fetch ............ 340ms
Execution 20:  🍪 Cookie-refreshed fetch ............ 48ms
Execution 50:  ⚡ Direct HTTP ........................ 5ms
```

## Why Schrute?

AI agents that browse the web are **slow**. Every click is 1-10 seconds. Every page load is another 2-5 seconds. A simple "check Bitcoin price on CoinGecko" takes 15 seconds through a browser but 5ms as an API call.

The problem: most websites don't have public APIs. And the ones that do require API keys, documentation, and boilerplate.

**Schrute solves this.** It watches network traffic during browser automation, learns the API patterns, and automatically generates MCP tools that replay those API calls directly. Your AI agent gets the speed of a hand-crafted API integration without anyone writing a single line of integration code.

## Quick Start

```bash
npm install -g schrute
schrute setup
```

Add to your MCP client config:

```json
{
  "mcpServers": {
    "schrute": {
      "command": "npx",
      "args": ["-y", "schrute", "serve"]
    }
  }
}
```

That's it. Your AI agent now has `schrute_explore`, `schrute_record`, and 40+ other tools available.

## How It Works: A Real Example

### Step 1: Explore a website

Tell your AI agent: *"Go to CoinGecko and get the Bitcoin price"*

Behind the scenes, Schrute opens a browser and records all network traffic:

```
Agent → schrute_explore({ url: "https://www.coingecko.com" })
Agent → browser_click({ element: "Bitcoin" })
Agent → schrute_record({ name: "get_bitcoin_price" })
Agent → browser_click({ element: "24h price data" })
Agent → schrute_stop()
```

### Step 2: Schrute learns the API

The capture pipeline automatically:
- **Filters noise** — Strips analytics (Google Analytics, Segment, Mixpanel), ads, CDN requests, Cloudflare challenges, polling — 50+ known noise domains
- **Detects auth** — Finds Bearer tokens, API keys, OAuth2 flows, session cookies, extracts JWT TTLs
- **Discovers parameters** — Identifies URL path params (`/coins/{id}`), query strings (`?vs_currency=usd`), body fields
- **Infers schemas** — Learns the JSON response structure so it can detect when APIs change
- **Detects chains** — Maps request dependencies (this call needs a token from that call)
- **Classifies side effects** — Marks skills as read-only, idempotent, or destructive

Output: a replayable **skill** exposed as a new MCP tool.

### Step 3: Next time, it's instant

```
Agent → www_coingecko_com_get_24_hours_json({ vs_currency: "usd" })
       → 5ms, direct HTTP, no browser
```

The skill starts at Tier 3 (browser-proxied, safe). After repeated successful executions, Schrute automatically promotes it:

| Tier | How It Works | Latency | When |
|------|-------------|---------|------|
| **Tier 3** | Browser evaluates `fetch()` | 100-500ms | Executions 1-10 |
| **Tier 2** | Refresh cookies, then direct `fetch()` | 5-100ms | After 10 successes |
| **Tier 1** | Direct HTTP, no browser | 1-50ms | After 20 successes |

If a promoted skill ever fails (API changed, auth expired), Schrute **automatically demotes** it back to a safer tier and attempts self-healing.

## Self-Healing Skills

APIs change. Auth tokens expire. Schrute handles this automatically:

```
Background validation loop (every 10 min):
  → Test skill with last-known-good params
  → Schema drift detected? → reinfer_schema
  → Auth expired? → refresh_auth (browser re-login)
  → Missing param? → add_param
  → Still failing? → escalate_tier (fall back to browser)
  → Permanently broken? → mark stale, notify
```

Every amendment is applied on cooldown, evaluated over a test window, and rolled back if it makes things worse.

## Cold-Start Discovery

Don't want to record anything? Schrute can discover APIs automatically:

```bash
schrute discover https://api.stripe.com
```

It probes for:
- **OpenAPI specs** — `/.well-known/openapi.json`, `/swagger.json`, `/api-docs`
- **GraphQL introspection** — `/graphql` with introspection query
- **Platform detection** — Recognizes Shopify, Stripe, WordPress, Firebase, Supabase, Next.js, Vercel
- **Sitemap/robots.txt** — URL pattern extraction
- **WebMCP tools** — Browser-native `navigator.modelContext` API (Chrome 146+)

Discovered endpoints are ranked by trust (OpenAPI: highest, WebMCP: lowest) and generated as draft skills without any browser interaction.

## Connect to Your Existing Browser

Already logged into a site in Chrome? Don't re-authenticate — connect directly:

```bash
# Launch Chrome with remote debugging
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# Connect Schrute to it
schrute_connect_cdp({ port: 9222, name: "my-chrome" })
```

Schrute reuses your existing cookies and auth state. It can also auto-discover Chrome's debug port, or connect to Electron apps via CDP.

## 9-Gate Security Model

Every skill execution passes through 9 security gates:

```
Request arrives
  │
  ├─ 1. Capability check     Is this tier even enabled?
  ├─ 2. Domain allowlist      SSRF prevention — only approved domains
  ├─ 3. Method restriction    GET/HEAD by default — mutations require approval
  ├─ 4. Path risk heuristics  /delete, /logout, /unsubscribe → blocked
  ├─ 5. Rate limiting         10 QPS default per site
  ├─ 6. SSRF prevention       Private IPs (127.0.0.1, 169.254.x, 10.x) → blocked
  ├─ 7. Redirect validation   Every redirect hop must pass policy
  ├─ 8. Budget tracking       Tool call limits per task
  └─ 9. Audit logging         Every execution → SQLite audit trail
```

New skills require **one-time user confirmation** before first execution. The AI agent sees the method, redacted URL, and parameters — and must get approval before proceeding.

Dangerous browser tools (`browser_evaluate`, `browser_run_code`) are **blocked entirely** — no arbitrary JavaScript execution.

## Cookie & Auth Management

```bash
# Import cookies from curl/browser export
schrute_import_cookies({ siteId: "github.com", cookieFile: "~/cookies.txt" })

# Export cookies (Netscape format)
schrute_export_cookies({ siteId: "github.com" })
```

Cookies are stored in your **OS keychain** (macOS Keychain, Linux Secret Service) — not in plaintext files. In-memory fallback with 2-hour TTL if keychain is unavailable.

Auth detection is automatic: Bearer tokens, API keys, OAuth2, session cookies. JWT TTLs are extracted and used for proactive refresh.

## Skill Management

```bash
# List all learned skills
schrute skills list

# Search by keyword
schrute skills search "bitcoin price" --limit 5

# Detailed skill info
schrute skills show www_coingecko_com.get_24_hours_json.v1 --verbose

# Preview without executing
schrute dry-run www_coingecko_com.get_24_hours_json.v1 vs_currency=usd

# Execute directly
schrute execute www_coingecko_com.get_24_hours_json.v1 vs_currency=usd

# Export skills (no credentials) for sharing
schrute export coingecko.com -o coingecko-skills.json

# Import on another machine
schrute import coingecko-skills.json

# Remove noisy infrastructure skills (Cloudflare, tracking pixels)
schrute skills prune-infra --site coingecko.com --yes
```

## Batch Execution

Execute multiple skills in one call:

```json
schrute_batch_execute({
  "actions": [
    { "skillId": "coingecko.get_bitcoin.v1", "params": { "vs_currency": "usd" } },
    { "skillId": "coingecko.get_ethereum.v1", "params": { "vs_currency": "usd" } },
    { "skillId": "coingecko.get_solana.v1", "params": { "vs_currency": "usd" } }
  ]
})
```

Up to 50 skills per batch. Confirmation is batched too — one approval for the whole sequence.

## Geo-Emulation & Proxy Support

Access geo-restricted content or route through proxies:

```json
schrute_explore({
  "url": "https://example.com",
  "proxy": {
    "server": "socks5://proxy:1080",
    "username": "user",
    "password": "pass"
  },
  "geo": {
    "geolocation": { "latitude": 35.6762, "longitude": 139.6503 },
    "timezoneId": "Asia/Tokyo",
    "locale": "ja-JP"
  }
})
```

## Multi-Client Setup

Schrute works with any MCP client:

<details>
<summary><strong>Claude Code</strong></summary>

Add to `.mcp.json`:
```json
{
  "mcpServers": {
    "schrute": {
      "command": "npx",
      "args": ["-y", "schrute", "serve"]
    }
  }
}
```
</details>

<details>
<summary><strong>Claude Desktop</strong></summary>

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):
```json
{
  "mcpServers": {
    "schrute": {
      "command": "npx",
      "args": ["-y", "schrute", "serve"]
    }
  }
}
```
</details>

<details>
<summary><strong>Cursor</strong></summary>

Add to `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "schrute": {
      "command": "npx",
      "args": ["-y", "schrute", "serve"]
    }
  }
}
```
</details>

<details>
<summary><strong>Windsurf</strong></summary>

Add to `.codeium/windsurf/mcp_config.json`:
```json
{
  "mcpServers": {
    "schrute": {
      "command": "npx",
      "args": ["-y", "schrute", "serve"]
    }
  }
}
```
</details>

<details>
<summary><strong>Cline / Continue / Any MCP Client</strong></summary>

Use stdio transport with: `npx -y schrute serve`
</details>

## MCP Tools Reference

### Core Tools

| Tool | Description |
|------|-------------|
| `schrute_explore` | Open a browser session on a URL |
| `schrute_record` | Start recording an action frame |
| `schrute_stop` | Stop recording, process HAR, generate skills |
| `schrute_execute` | Execute any skill by ID |
| `schrute_search_skills` | Find skills by keyword |
| `schrute_dry_run` | Preview a request without sending it |
| `schrute_confirm` | Approve a skill's first execution |
| `schrute_activate` | Activate a draft or broken skill |
| `schrute_skills` | List skills (optionally by site) |
| `schrute_sites` | List all known sites |
| `schrute_status` | Engine mode and session info |

### Session Management

| Tool | Description |
|------|-------------|
| `schrute_connect_cdp` | Connect to Chrome/Electron via CDP |
| `schrute_sessions` | List active browser sessions |
| `schrute_switch_session` | Switch between named sessions |
| `schrute_close_session` | Close a session |
| `schrute_list_tabs` | List tabs in a CDP session |
| `schrute_select_tab` | Switch tabs by URL or title |
| `schrute_recover_explore` | Recover from Cloudflare blocks |

### Advanced

| Tool | Description |
|------|-------------|
| `schrute_batch_execute` | Execute up to 50 skills in sequence |
| `schrute_capture_recent` | Generate skills from recent traffic (no pre-recording) |
| `schrute_import_cookies` | Import Netscape cookie file |
| `schrute_export_cookies` | Export cookies from a session |
| `schrute_amendments` | List auto-healing patches for a skill |
| `schrute_optimize` | Run offline optimization on a degraded skill |
| `schrute_delete_skill` | Permanently delete a skill |
| `schrute_revoke` | Revoke a skill's permanent approval |
| `schrute_performance_trace` | Browser performance tracing |
| `schrute_doctor` | Health diagnostics |
| `schrute_webmcp_call` | Call a WebMCP tool on the current site |
| `schrute_webmcp_directory` | Search all discovered WebMCP tools |

### Browser Tools (19 available)

`browser_navigate` · `browser_click` · `browser_type` · `browser_snapshot` · `browser_fill_form` · `browser_press_key` · `browser_hover` · `browser_drag` · `browser_select_option` · `browser_file_upload` · `browser_handle_dialog` · `browser_tabs` · `browser_take_screenshot` · `browser_wait_for` · `browser_close` · `browser_resize` · `browser_console_messages` · `browser_network_requests` · `browser_navigate_back`

### Dynamic Skill Tools

As skills are learned, new MCP tools appear automatically:
```
www_coingecko_com_get_24_hours_json_v1({ vs_currency: "usd" })
www_github_com_get_repos_v1({ owner: "torvalds" })
api_stripe_com_get_charges_v1({ limit: 10 })
```

## MCP Resources & Prompts

**Resources** (read-only context for agents):

| URI | Description |
|-----|-------------|
| `schrute://status` | Engine mode, uptime, active session |
| `schrute://skills` | Skill catalog with redacted summaries |
| `schrute://sites` | Known sites with visit history |

**Prompts** (guided workflows):

| Prompt | Description |
|--------|-------------|
| `explore-site` | Guided website exploration (args: `url`) |
| `record-action` | Guided action recording (args: `url`, `action_name`) |

## CLI Reference

```bash
# Browser sessions
schrute explore <url>              # Open browser, start recording traffic
schrute record --name <action>     # Mark the start of an action
schrute stop                       # Process traffic, generate skills
schrute status                     # Engine mode and session info
schrute sessions                   # List active sessions

# Skills
schrute skills list [site]         # List skills, optionally by site
schrute skills search <query>      # Full-text search
schrute skills show <id> [-v]      # Detailed info
schrute skills validate <id>       # Trigger validation
schrute skills report <id>         # Full evidence report
schrute skills amendments <id>     # List auto-healing patches
schrute skills optimize <id>       # Offline optimization
schrute skills prune-infra --site <s>  # Remove noise skills
schrute skills delete <id>         # Permanently delete
schrute skills revoke <id>         # Revoke approval

# Execution
schrute execute <id> [key=val...]  # Execute a skill
schrute dry-run <id> [key=val...]  # Preview without sending

# Sites
schrute sites list                 # List known sites
schrute sites delete <site>        # Delete site + all skills

# Discovery
schrute discover <url>             # Auto-discover APIs (no browser)

# Import/Export
schrute export <site> [-o file]    # Export skills (no credentials)
schrute import <file>              # Import skills bundle

# Server
schrute serve                      # Start MCP server (stdio)
schrute serve --http --port 3000   # HTTP transport
schrute daemon                     # Background daemon

# Config & Health
schrute setup                      # Install browser engine
schrute doctor                     # Run diagnostics
schrute trust                      # Security posture report
schrute config set <key> <val>     # Set config
schrute config get <key>           # Get config
schrute config list                # List all config
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SCHRUTE_DATA_DIR` | Data directory | `~/.schrute` |
| `SCHRUTE_LOG_LEVEL` | Log level (debug/info/warn/error) | `info` |
| `SCHRUTE_AUTH_TOKEN` | Auth token for HTTP transport | — |
| `SCHRUTE_NETWORK` | Enable network mode | `false` |
| `SCHRUTE_HTTP_TRANSPORT` | Enable HTTP transport | `false` |
| `SCHRUTE_HTTP_PORT` | HTTP server port | `3000` |

### Config File

Settings persist in `~/.schrute/config.json`:

```bash
schrute config set autoValidation.enabled true
schrute config set autoValidation.intervalMs 300000
schrute config set toolBudget.maxToolCallsPerTask 100
schrute config set browser.engine patchright    # playwright | patchright | camoufox
```

**Precedence:** CLI flags > Environment variables > Config file > Defaults

## Claude Code Plugin

When installed as a Claude Code plugin, additional features are available:

**Slash Commands:**
`/schrute:explore <url>` · `/schrute:record` · `/schrute:skills` · `/schrute:doctor` · `/schrute:status`

**Agents:**
- `skill-validator` — Validates recorded skills for correctness
- `exploration-guide` — Interactive browser exploration assistant
- `skill-debugger` — Diagnoses failing skill executions

**Knowledge Skills:**
- `schrute-usage` — Comprehensive usage guide
- `browser-tool-selection` — Decision guide for choosing browser approach

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        MCP Client                            │
│            (Claude, Cursor, Windsurf, Cline, ...)            │
└─────────────────────────┬────────────────────────────────────┘
                          │ MCP (stdio or HTTP)
┌─────────────────────────▼────────────────────────────────────┐
│                     Schrute MCP Server                       │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │  Meta    │  │  Browser │  │ Dynamic  │  │  Resources   │  │
│  │  Tools   │  │  Tools   │  │  Skills  │  │  & Prompts   │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────────────┘  │
│       │              │             │                           │
│  ┌────▼──────────────▼─────────────▼──────────────────────┐   │
│  │                    Engine                               │   │
│  │  ┌──────────┐  ┌──────────┐  ┌────────────────────┐    │   │
│  │  │ Session  │  │  Policy  │  │     Executor       │    │   │
│  │  │ Manager  │  │ (9-gate) │  │  (4-tier replay)   │    │   │
│  │  └──────────┘  └──────────┘  └────────────────────┘    │   │
│  └─────────────────────┬──────────────────────────────────┘   │
│                        │                                       │
│  ┌─────────────────────▼──────────────────────────────────┐   │
│  │               Capture Pipeline                          │   │
│  │  HAR → Noise Filter → Auth Detect → Param Discovery     │   │
│  │  → Schema Infer → Chain Detect → Skill Generation       │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  Browser    │  │   Storage    │  │     Healing          │  │
│  │  Manager    │  │  (SQLite)    │  │  (auto-validation,   │  │
│  │ (Playwright │  │              │  │   amendments,        │  │
│  │  CDP, Live) │  │              │  │   drift detection)   │  │
│  └─────────────┘  └──────────────┘  └──────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

## Development

**Prerequisites:** Node.js >= 22

```bash
git clone https://github.com/sheeki03/schrute.git
cd schrute
npm install
npx playwright install chromium
npm run build
```

```bash
npm run build          # Compile TypeScript
npx tsc --noEmit       # Type check
npx vitest run         # Run tests
npm run dev            # Watch mode
```

### Project Structure

```
src/
  core/         Engine, config, policy, session, tiering
  server/       MCP stdio/HTTP, REST API, daemon
  browser/      Playwright/CDP/agent-browser backends, HAR recording
  capture/      Pipeline: noise filter, auth, params, schema, chains
  replay/       4-tier executor, request builder, dry run, audit log
  skill/        Types, generator, compiler, validator, security scanner
  storage/      SQLite database, repositories, redactor
  discovery/    Cold-start: OpenAPI, GraphQL, platform, WebMCP, sitemap
  healing/      Auto-validation, amendments, drift detection, relearner
  native/       Rust-accelerated: param discovery, redaction, diffing
  automation/   Rate limiting, strategy selection, site classification
```

### Native Acceleration (Optional)

Performance-critical paths have Rust implementations with TypeScript fallbacks:

```bash
npm run build:native   # Requires Rust toolchain
```

Accelerated: parameter discovery, request canonicalization, PII redaction, semantic diffing.

## License

[Apache-2.0](LICENSE)
