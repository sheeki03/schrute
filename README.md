<p align="center">
  <img src="assets/logo.png" alt="Schrute" width="350">
</p>

<h1 align="center">Schrute</h1>

<p align="center">
Teach your AI a website once. After that, it replays the same backend requests directly — no browser needed.
</p>

Schrute watches real browser traffic, turns repeatable actions into MCP tools, and reuses browser auth when needed. No hand-written API integration, and often no API keys, because Schrute learns from the requests your browser already knows how to make.

- Faster repeated tasks
- Less brittle than selector-only browser automation
- No hand-written API integration for every site

Measured on repeated runs of tested workflows:

```
Execution 1:   Browser-proxied fetch ........... 1,029ms
Execution 3:   Browser-proxied (warm) ............ 777ms
Execution 5:   Browser-proxied (optimized) ....... 273ms
Execution 20+: Direct HTTP (promoted) ........... ~5-50ms
```

See [benchmarks](#benchmarks) for methodology.

## Why this exists

Browser agents are great at discovering how to use a site, but terrible at repeating the same task quickly. Every repeat run pays the DOM tax again: page loads, clicks, waits, selectors, retries.

Schrute keeps the discovery power of browser automation for the first run, then shifts repeatable actions to direct HTTP replay whenever it is safe and reliable to do so.

That means:
- less latency on repeated calls
- fewer brittle UI steps
- lower runtime cost
- reusable tools instead of one-off automations

## Quick start

```bash
npm install -g schrute
schrute setup
```

Add to your MCP client config (Claude Code, Cursor, Windsurf, Cline, or any MCP client):

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

Your AI agent now has `schrute_explore`, `schrute_record`, and 40+ other tools.

## See it work in 60 seconds

```bash
# Start Schrute
schrute serve

# Open a browser and record an API interaction
schrute explore https://httpbin.org
schrute record --name get_ip
# navigate to httpbin.org/ip in the browser
schrute stop

# Schrute generates: httpbin_org.get_ip.v1
# 4 requests captured, 4 signal, 0 noise

# Execute the learned skill
schrute execute httpbin_org.get_ip.v1 --yes
```

Result:
- First run: **1,029ms** (browser-proxied fetch)
- Fifth run: **273ms** (browser-proxied, optimized)
- Learned skill: `httpbin_org.get_ip.v1`
- What changed: Schrute learned the exact `GET /ip` endpoint and replays it without DOM interaction

## Tested workflows

Every example below was recorded on 2026-03-17, on macOS (Apple Silicon), over WiFi, using Playwright Chromium.

### 1. Public API learning — httpbin.org

**User task:** "Get my public IP address"

**Site:** httpbin.org (developer tools)

**Why this workflow matters:** Shows Schrute learning clean REST endpoints with zero noise and no auth requirements.

**First run:**
- Path: `schrute explore` → navigate to `/get`, `/ip`, `/user-agent`, `/headers` → `schrute stop`
- Execution mode: browser automation
- Pipeline result: 4 requests captured, 4 signal, 0 noise, **4 skills generated**

**Learned skills:**
- `httpbin_org.get_ip.v1` — `GET /ip`
- `httpbin_org.get_get.v1` — `GET /get`
- `httpbin_org.get_headers.v1` — `GET /headers`
- `httpbin_org.get_user_agent.v1` — `GET /user-agent`
- Auth used: none (public)
- Safety class: read-only

**Repeated runs:**

| Run | Latency | Method |
|-----|--------:|--------|
| 1 | 1,029ms | Browser-proxied (Tier 3) |
| 2 | 1,186ms | Browser-proxied (Tier 3) |
| 3 | 777ms | Browser-proxied (Tier 3) |
| 4 | 1,033ms | Browser-proxied (Tier 3) |
| 5 | 273ms | Browser-proxied (Tier 3) |

**Returned:** `{"origin": "49.43.xxx.x"}`

**What changed after learning:** Four browser navigations became four replayable MCP tools. Each call returns JSON directly — no page load, no DOM parsing, no selectors.

---

### 2. Parameterized API discovery — Wikipedia

**User task:** "Search Wikipedia for articles about artificial intelligence"

**Site:** en.wikipedia.org (knowledge/reference)

**Why this workflow matters:** Shows Schrute automatically discovering which query parameters vary (the search term) and which are constants (action, format, list type) — without being told.

**First run:**
- Path: `schrute explore` → navigate to Wikipedia API with `srsearch=machine+learning`, then `srsearch=artificial+intelligence`, then with `titles=Machine_learning` → `schrute stop`
- Pipeline result: 4 requests captured, 4 signal, 0 noise, **2 skills generated**

**Learned skills:**
- `en_wikipedia_org.get_api_php.v1` — `GET /w/api.php`
  - Discovered parameter: `query.srsearch` (varies between requests — classified as input)
  - Baked-in constants: `action=query`, `list=search`, `format=json`, `origin=*` (same across all requests — classified as constants)
- `en_wikipedia_org.create_events.v1` — analytics endpoint, correctly classified as **draft** (not activated)
- Auth used: none (public)
- Safety class: read-only

**Repeated run:**
- Execution mode: Browser-proxied (Tier 3)
- Time: **1,033ms**
- Returned: Full Wikipedia search results (10 articles with titles, snippets, page IDs)

**What changed after learning:** A single MCP tool that takes a search query and returns structured Wikipedia results. The agent calls `schrute_execute({ skillId: "en_wikipedia_org.get_api_php.v1", params: { "query.srsearch": "quantum computing" } })` instead of navigating Wikipedia's UI.

---

### 3. Noise filtering — dog.ceo

**User task:** "List all dog breeds and get a random dog image"

**Site:** dog.ceo (entertainment/fun API)

**Why this workflow matters:** Shows Schrute separating real API calls from page chrome (CSS, images, scripts) on a site that mixes both.

**First run:**
- Path: `schrute explore` → navigate to `/api/breeds/image/random`, `/api/breeds/list/all`, `/api/breed/labrador/images/random` → `schrute stop`
- Pipeline result: 6 requests captured, **3 signal, 3 noise**, **2 skills generated**

**Learned skills:**
- `dog_ceo.get_all.v1` — `GET /api/breeds/list/all`
- `dog_ceo.get_random.v1` — `GET /api/breed/labrador/images/random`
- Auth used: none (public)
- Safety class: read-only

**Repeated runs:**

| Run | Skill | Latency | Returned |
|-----|-------|--------:|----------|
| 1 | get_all | 551ms | Full breed list (98 breeds with sub-breeds) |
| 2 | get_random | 558ms | `https://images.dog.ceo/breeds/labrador/Fury_02.jpg` |
| 3 | get_random | 472ms | `https://images.dog.ceo/breeds/labrador/n02099712_1414.jpg` |

**What changed after learning:** The 3 noise requests (page CSS, favicon, scripts) were discarded. Only the 3 JSON API calls became skills. Each execution returns structured JSON in ~500ms instead of loading the full dog.ceo web page.

---

### 4. Cloudflare-protected site — CoinGecko

**User task:** "Get Bitcoin 24-hour price data"

**Site:** www.coingecko.com (finance/crypto)

**Why this workflow matters:** Shows how Schrute handles sites behind Cloudflare. Direct HTTP fails — the skill stays at Tier 3 (browser-proxied) and uses the browser's Cloudflare clearance cookies.

**First run:**
- Path: `schrute explore` → agent navigates CoinGecko, clicks on Bitcoin, views price charts → `schrute stop`
- Pipeline result: **5 skills generated** from the captured API calls

**Learned skills:**
- `www_coingecko_com.get_24_hours_json.v1` — `GET /price_charts/bitcoin/usd/24_hours.json`
- `www_coingecko_com.get_max_longer_cache_json.v1` — `GET /price_charts/bitcoin/usd/max_longer_cache.json`
- `www_coingecko_com.get_insight_annotations.v1` — `GET /price_charts/bitcoin/insight_annotations`
- Plus 2 more (user info, OTP center)
- Auth used: Cloudflare cookies (browser session)
- Safety class: read-only

**Direct HTTP attempt:** Failed after 9,129ms — Cloudflare returns a challenge page, not JSON.

**Why it still works:** At Tier 3, Schrute executes the `fetch()` inside the browser context, which already has Cloudflare clearance cookies. The request succeeds where direct HTTP cannot. This skill will not promote to Tier 1 because the endpoint requires Cloudflare cookies — Schrute detects this and keeps it at the browser-proxied tier.

**What this shows:** Not every skill promotes to direct HTTP. Schrute adapts to the site's security model instead of breaking against it.

---

### 5. Server-rendered site — Hacker News (no skills generated)

**User task:** "Get the front page of Hacker News"

**Site:** news.ycombinator.com (news/tech)

**Why this matters:** Shows what happens when Schrute encounters a site that does not use JSON APIs behind its UI.

**Result:**
- 12 requests captured
- 0 signal, 10 noise (CSS, images, static assets), 2 document navigations
- **0 skills generated**

**Why:** Hacker News is fully server-rendered HTML. There are no `fetch()` calls to JSON APIs — every page is a full HTML document. Schrute correctly identifies there is nothing to learn and does not generate broken skills.

## Benchmarks

| Site | Skill | Run 1 | Run 3 | Run 5 | Auth | Noise filtered |
|------|-------|------:|------:|------:|------|---------------:|
| httpbin.org | `get_ip` | 1,029ms | 777ms | 273ms | None | 0/4 |
| dog.ceo | `get_all` | 551ms | — | — | None | 3/6 |
| dog.ceo | `get_random` | 558ms | 472ms | — | None | 3/6 |
| en.wikipedia.org | `get_api_php` | 1,033ms | — | — | None | 0/4 |
| www.coingecko.com | `get_24_hours_json` | 9,129ms (fail) | — | — | Cloudflare cookies | — |

All runs at Tier 3 (browser-proxied). Skills promote to Tier 1 (direct HTTP, ~5-50ms) after 5+ consecutive successful validations. Cloudflare-protected skills remain at Tier 3.

**Methodology:**
- Machine: MacBook (Apple Silicon)
- Network: WiFi, India
- Browser engine: Playwright Chromium
- Cache state: warm (browser session open)
- Timing: `latencyMs` field from Schrute execution result
- Date tested: 2026-03-17

## Where Schrute works best

Schrute works best when:
- the site uses JSON, GraphQL, or predictable HTTP requests behind the UI
- the task is repeated often enough to justify learning
- the browser session already has the right auth state
- the workflow can be represented as a stable request or request chain

Schrute is a worse fit when:
- the site is fully server-rendered HTML with no JSON API calls (like Hacker News)
- the workflow depends heavily on WebSockets, canvas state, or anti-bot challenges on every request
- the task is a one-off and not worth recording
- the action is too risky to replay automatically (destructive mutations without confirmation)

## How Schrute differs from other approaches

### Browser-only agents (Playwright, Puppeteer, Selenium)
Great for first-time discovery, slower and more brittle for repeated workflows. Every repeat pays the full DOM tax.

### Hand-written API integrations
Fast and reliable once built, but require documentation, API keys, auth handling, and custom code per site.

### Schrute
Uses the browser to discover the workflow once, then promotes repeatable actions toward direct HTTP replay. No per-site code. Auth comes from the browser session. Skills self-heal when APIs change.

## Trust and safety

Schrute does not blindly replay arbitrary browser traffic.

Before a learned skill executes, Schrute enforces:
- **Domain allowlists** — only approved domains, SSRF prevention
- **Method restrictions** — GET/HEAD by default, mutations require approval
- **One-time confirmation** — every new skill needs user approval before first execution
- **Path risk heuristics** — destructive-looking paths (`/delete`, `/logout`) are blocked
- **Rate limiting** — 10 QPS default per site
- **Redirect validation** — every redirect hop must pass policy
- **Audit logging** — every execution recorded to SQLite

Dangerous browser tools (`browser_evaluate`, `browser_run_code`) are blocked entirely.

For the full 9-gate security model, see [SECURITY.md](SECURITY.md).

## Auth, cookies, and storage

Schrute reuses the auth state already present in your browser session.

- Cookies are stored in the **OS keychain** (macOS Keychain, Linux Secret Service) — not in plaintext files
- Exported skill bundles never include credentials
- Audit logs are stored locally in SQLite
- Auth detection is automatic: Bearer tokens, API keys, OAuth2, session cookies
- JWT TTLs are extracted and used for proactive refresh

Connect to an existing Chrome session to reuse your logged-in state:

```bash
# Launch Chrome with debugging
chrome --remote-debugging-port=9222

# Connect Schrute
schrute_connect_cdp({ port: 9222, name: "my-chrome" })
```

## Self-healing

APIs change. Auth tokens expire. Schrute handles this automatically.

A background validation loop runs every 10 minutes:
- Tests skills with last-known-good parameters
- Schema drift detected → re-infer the response schema
- Auth expired → refresh via browser re-login
- Missing parameter → add it from recent traffic
- Still failing → escalate to browser tier (fall back to safety)
- Permanently broken → mark as stale, stop executing

Every amendment is applied on cooldown, evaluated over a test window, and rolled back if it makes things worse.

## Cold-start discovery

Schrute can discover APIs without recording anything:

```bash
schrute discover https://api.example.com
```

It probes for OpenAPI specs, GraphQL introspection, platform signatures (Shopify, Stripe, WordPress, Firebase, Supabase, Next.js), sitemaps, and WebMCP tools. Discovered endpoints become draft skills ranked by trust level.

## REST API and client SDKs

Start Schrute with HTTP transport for programmatic access from any language:

```bash
schrute config set server.authToken my-secret
schrute serve --http --port 3000
```

```bash
# Execute a learned skill
curl -X POST http://127.0.0.1:3000/api/sites/httpbin.org/skills/get_ip \
  -H "Authorization: Bearer my-secret" \
  -H "Content-Type: application/json" \
  -d '{"params": {}}'

# Search for skills
curl -X POST http://127.0.0.1:3000/api/v1/skills/search \
  -H "Authorization: Bearer my-secret" \
  -H "Content-Type: application/json" \
  -d '{"query": "dog breeds", "limit": 5}'
```

Client SDKs available for **Python** (zero-dependency, `pip install schrute-client`) and **TypeScript** (`npm install @schrute/client`).

Full REST API reference: [docs/rest-api.md](docs/rest-api.md)

## Docs

For detailed reference documentation:

- [MCP tools reference](docs/tools.md) — All 40+ MCP tools with parameters
- [CLI reference](docs/cli.md) — Every CLI command and flag
- [REST API](docs/rest-api.md) — 19 HTTP endpoints with examples
- [Security model](SECURITY.md) — Full 9-gate policy engine
- [Architecture](docs/architecture.md) — System design and internals
- [Configuration](docs/configuration.md) — Environment variables, config file, precedence
- [Development](docs/development.md) — Building from source, testing, project structure
- [Client SDKs](docs/sdks.md) — Python and TypeScript usage

<details>
<summary><strong>Multi-client setup</strong></summary>

Works with Claude Code (`.mcp.json`), Claude Desktop, Cursor (`.cursor/mcp.json`), Windsurf (`.codeium/windsurf/mcp_config.json`), Cline, Continue, or any MCP client via stdio: `npx -y schrute serve`
</details>

<details>
<summary><strong>Claude Code plugin</strong></summary>

When installed as a plugin: `/schrute:explore`, `/schrute:record`, `/schrute:skills`, `/schrute:doctor`, `/schrute:status`. Includes specialized agents for skill validation, exploration guidance, and debugging.
</details>

## Development

**Prerequisites:** Node.js >= 22

```bash
git clone https://github.com/sheeki03/schrute.git
cd schrute && npm install && npx playwright install chromium && npm run build
```

```bash
npm run build          # Compile TypeScript
npx vitest run         # Run tests
npm run dev            # Watch mode
```

## License

[Apache-2.0](LICENSE)
