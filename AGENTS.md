# Schrute — Universal Self-Learning Browser Agent

## What This Is

Schrute is an MCP server that learns API behaviors by observing browser interactions and generates replayable "skills." It records HAR traffic during browser sessions, extracts API patterns, and replays them with progressive tier optimization (full browser → direct HTTP).

## Prerequisites

- **Node.js >= 22** (required)
- **Playwright Chromium**: `npx playwright install chromium`
- Data directories (`~/.schrute/`) are auto-created on first run

## Architecture

```
CLI (index.ts) → Daemon (daemon.ts) → Engine (engine.ts) → BrowserManager (manager.ts)
                                     ↓                     ↓
                              SkillRepository          PlaywrightMcpAdapter
                                     ↓                     ↓
                              Executor (executor.ts)   HAR Capture Pipeline
```

### Key Modules

| Module | Path | Purpose |
|--------|------|---------|
| Engine | `src/core/engine.ts` | Session orchestration — explore, record, stop, execute |
| Policy | `src/core/policy.ts` | 9-gate security enforcement |
| Executor | `src/replay/executor.ts` | Tier-based skill replay |
| Daemon | `src/server/daemon.ts` | Unix domain socket control channel |
| MCP Stdio | `src/server/mcp-stdio.ts` | MCP server for stdio transport |
| MCP HTTP | `src/server/mcp-http.ts` | REST + MCP-HTTP for web clients |
| BrowserManager | `src/browser/manager.ts` | Playwright context lifecycle + HAR recording |
| SkillRepository | `src/storage/skill-repository.ts` | SQLite-backed skill CRUD |
| Capture Pipeline | `src/capture/` | HAR → noise filter → auth detect → param discover → skill generate |

### Execution Tiers

Skills execute through 4 tiers with automatic promotion/demotion:
- **Tier 1**: Direct HTTP fetch (1-50ms)
- **Tier 2**: Cookie refresh + fetch (5-100ms)
- **Tier 3**: Browser-proxied fetch (100-500ms) — default start
- **Tier 4**: Full Playwright automation (1-10s) — fallback

### Security Model

9 policy gates on every execution: capability check, domain allowlist, method restriction, path risk heuristics, rate limiting, SSRF prevention, redirect validation, budget tracking, audit logging.

## Development

```bash
npm run build        # Compile TypeScript
npx tsc --noEmit     # Type check only
npx vitest run       # Run all tests
npx vitest run tests/unit/engine.test.ts  # Run specific test
```

### Database

SQLite via better-sqlite3. Schema in `src/storage/database.ts`. Migrations run automatically. Data directory: `~/.schrute/data/`.

### Testing Patterns

- Tests use vitest with `vi.mock()` for dependency injection
- Config objects in tests must include `daemon: { port: 19420, autoStart: false }`
- Browser tests mock Playwright via `vi.mock('playwright')`

## MCP Tools

**Meta**: `schrute_explore`, `schrute_record`, `schrute_stop`, `schrute_sites`, `schrute_skills`, `schrute_status`, `schrute_dry_run`, `schrute_confirm`

**Browser** (19 allowed): `browser_navigate`, `browser_click`, `browser_type`, `browser_snapshot`, `browser_fill_form`, `browser_press_key`, `browser_hover`, `browser_drag`, `browser_select_option`, `browser_file_upload`, `browser_handle_dialog`, `browser_tabs`, `browser_take_screenshot`, `browser_wait_for`, `browser_close`, `browser_resize`, `browser_console_messages`, `browser_network_requests`, `browser_navigate_back`

**Blocked**: `browser_evaluate`, `browser_run_code`, `browser_install`

## MCP Resources

| URI | Description |
|-----|-------------|
| `schrute://status` | Engine mode, uptime, active session |
| `schrute://skills` | Redacted skill catalog (no credentials) |
| `schrute://sites` | Known sites with mastery level |

## MCP Prompts

| Name | Description |
|------|-------------|
| `explore-site` | Guided workflow to discover a site's API |
| `record-action` | Guided workflow to record a browser action as a skill |

## Configuration

Config file: `~/.schrute/config.json`

Environment variable overrides (take precedence over config file):

| Variable | Config Key | Example |
|----------|-----------|---------|
| `SCHRUTE_DATA_DIR` | `dataDir` | `/custom/data` |
| `SCHRUTE_LOG_LEVEL` | `logLevel` | `debug` |
| `SCHRUTE_AUTH_TOKEN` | `server.authToken` | `secret-token` |
| `SCHRUTE_NETWORK` | `server.network` | `true` or `false` |
| `SCHRUTE_HTTP_PORT` | `server.httpPort` | `8080` |
| `SCHRUTE_HTTP_TRANSPORT` | `features.httpTransport` | `true` or `false` |

## Dual Nature

This project serves two roles:

1. **MCP Server** (universal) — The core MCP server (`src/server/`) works with any MCP client: Claude Desktop, Cursor, Windsurf, Cline, Continue, or any other client that supports the Model Context Protocol. It exposes tools, resources, and prompts via stdio or HTTP transport.

2. **Claude Code Plugin** (Claude-specific) — The plugin layer (`.claude-plugin/`, `commands/`, `skills/`, `agents/`, `hooks/`, `prompts/`) adds Claude Code-specific UX: slash commands, autonomous agents, knowledge skills, and event-driven hooks. These are only active when Schrute is loaded as a Claude Code plugin.

The MCP server layer has zero dependency on the plugin layer. You can use Schrute with any MCP client without the plugin files.
