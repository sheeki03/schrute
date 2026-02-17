# OneAgent

Universal Self-Learning Browser Agent — record browser interactions, learn API patterns, and replay them as optimized MCP tools.

## What It Does

1. **Record** — Open a browser, perform actions, and OneAgent captures the underlying API calls
2. **Learn** — The capture pipeline extracts parameters, detects auth patterns, and generates replayable skills
3. **Replay** — Skills execute through a 4-tier optimization system, starting at browser-proxied and promoting to direct HTTP

## Quick Start

```bash
# Run directly with npx
npx oneagent serve

# Or install globally
npm install -g oneagent
oneagent serve
```

## Installation

### npm (recommended)

```bash
npm install -g oneagent
oneagent setup  # Installs Playwright Chromium
```

### npx (no install)

```bash
npx oneagent serve
```

### From Source

```bash
git clone https://github.com/user/oneagent.git
cd oneagent
npm install
npx playwright install chromium
npm run build
node dist/index.js serve
```

## Multi-Client Setup

OneAgent works with any MCP client. Configure your preferred client:

### Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "oneagent": {
      "command": "npx",
      "args": ["-y", "oneagent", "serve"]
    }
  }
}
```

Or if installed as a plugin, use the built-in `.mcp.json` with `${CLAUDE_PLUGIN_ROOT}`.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "oneagent": {
      "command": "npx",
      "args": ["-y", "oneagent", "serve"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "oneagent": {
      "command": "npx",
      "args": ["-y", "oneagent", "serve"]
    }
  }
}
```

### Windsurf

Add to `.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "oneagent": {
      "command": "npx",
      "args": ["-y", "oneagent", "serve"]
    }
  }
}
```

### Cline

Add to `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "oneagent": {
      "command": "npx",
      "args": ["-y", "oneagent", "serve"]
    }
  }
}
```

### Generic (any MCP client)

Use stdio transport with the command: `npx -y oneagent serve`

## MCP Tools

### Meta Tools

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `oneagent_explore` | Start a browser session on a URL | `url` (required) |
| `oneagent_record` | Begin recording an action | `name` (required), `inputs` (optional) |
| `oneagent_stop` | Stop recording and process captures | — |
| `oneagent_skills` | List learned skills | `site` (optional filter) |
| `oneagent_sites` | List known sites | — |
| `oneagent_status` | Engine status and session info | — |
| `oneagent_dry_run` | Preview a skill execution | `skill_id` (required), `params` (optional) |
| `oneagent_confirm` | Approve a pending skill confirmation | `token` (required), `approve` (boolean) |

### Browser Tools (19 available)

`browser_navigate`, `browser_click`, `browser_type`, `browser_snapshot`, `browser_fill_form`, `browser_press_key`, `browser_hover`, `browser_drag`, `browser_select_option`, `browser_file_upload`, `browser_handle_dialog`, `browser_tabs`, `browser_take_screenshot`, `browser_wait_for`, `browser_close`, `browser_resize`, `browser_console_messages`, `browser_network_requests`, `browser_navigate_back`

**Blocked for security**: `browser_evaluate`, `browser_run_code`, `browser_install`

### Dynamic Skill Tools

As you record actions, OneAgent generates new MCP tools automatically. These appear with names like `oneagent_skill_<site>_<action>` and can be called with their discovered parameters.

## MCP Resources

| URI | Description |
|-----|-------------|
| `oneagent://status` | Engine mode, uptime, active session info |
| `oneagent://skills` | Skill catalog with redacted summaries |
| `oneagent://sites` | Known sites with visit history |

## MCP Prompts

| Name | Description | Arguments |
|------|-------------|-----------|
| `explore-site` | Guided workflow for exploring a website | `url` (required) |
| `record-action` | Guided workflow for recording a browser action | `url` (required), `action_name` (required) |

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ONEAGENT_DATA_DIR` | Data directory path | `~/.oneagent` |
| `ONEAGENT_LOG_LEVEL` | Log level | `info` |
| `ONEAGENT_AUTH_TOKEN` | Auth token for HTTP transport | — |
| `ONEAGENT_NETWORK` | Enable network mode (`true`/`false`) | `false` |
| `ONEAGENT_HTTP_TRANSPORT` | Enable HTTP transport (`true`/`false`) | `false` |
| `ONEAGENT_HTTP_PORT` | HTTP server port | `3000` |

### Config File

Settings persist in `~/.oneagent/config.json`. Manage with:

```bash
oneagent config set server.authToken my-secret
oneagent config get server
```

### Precedence

CLI flags > Environment variables > Config file > Defaults

## Security Model

OneAgent enforces 9 security gates on every skill execution:

1. **Capability check** — Is the tier's capability enabled?
2. **Domain allowlist** — Is the target domain permitted?
3. **Method restriction** — Is the HTTP method allowed?
4. **Path risk heuristics** — Does the path look destructive?
5. **Rate limiting** — Is the site being hammered?
6. **SSRF prevention** — Is the target a private IP?
7. **Redirect validation** — Does each redirect hop pass policy?
8. **Budget tracking** — Are tool call limits respected?
9. **Audit logging** — Is the execution properly recorded?

All newly-activated skills require one-time confirmation before first execution.

## Claude Code Plugin

When used as a Claude Code plugin, additional features are available:

### Commands

| Command | Description |
|---------|-------------|
| `/oneagent:explore <url>` | Start browser exploration |
| `/oneagent:record` | Record an action |
| `/oneagent:skills` | List skills |
| `/oneagent:doctor` | Run health diagnostics |
| `/oneagent:status` | Check engine status |

### Agents

- **skill-validator** — Validates recorded skills for correctness
- **exploration-guide** — Interactive browser exploration assistant
- **skill-debugger** — Diagnoses failing skill executions

### Skills

- **oneagent-usage** — Comprehensive usage guide
- **browser-tool-selection** — Decision guide for choosing browser approach

## Development

### Prerequisites

- Node.js >= 22
- Playwright Chromium: `npx playwright install chromium`

### Build & Test

```bash
npm run build          # Compile TypeScript
npx tsc --noEmit       # Type check only
npx vitest run         # Run tests
npm run dev            # Watch mode
```

### Project Structure

```
src/
  core/        — Engine, config, policy, logging
  server/      — MCP stdio/HTTP, REST API, daemon
  browser/     — Playwright adapter, browser manager
  capture/     — HAR pipeline, auth detection, parameter discovery
  replay/      — Tier-based executor, dry run, audit log
  skill/       — Types, validator, skill lifecycle
  storage/     — SQLite database, repositories, migrations
  discovery/   — Cold-start API discovery
```

## Before Publishing

- [ ] Update repository URL in `package.json` and `.claude-plugin/plugin.json`
- [ ] Verify `npm pack --dry-run` includes all necessary files
- [ ] Run full test suite: `npx vitest run`
- [ ] Run type check: `npx tsc --noEmit`

## License

[MIT](LICENSE)
