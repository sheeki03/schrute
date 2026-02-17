# OneAgent — Claude Code Project Instructions

Read `AGENTS.md` for full project documentation (architecture, build commands, testing patterns, MCP tools, security model).

## Claude Code Plugin Structure

This project is also a Claude Code plugin. These files are only active when loaded as a plugin:

```
.claude-plugin/plugin.json  — Plugin manifest
.mcp.json                   — MCP server registration
commands/                   — Slash commands (/oneagent:explore, etc.)
skills/                     — Knowledge skills
agents/                     — Autonomous sub-agents
hooks/                      — Event-driven hooks
prompts/                    — Expert context for Codex delegation
```

## Testing

```bash
npm run build        # Compile TypeScript
npx tsc --noEmit     # Type check only
npx vitest run       # Run all tests
```

- Config objects in tests must include `daemon: { port: 19420, autoStart: false }`
- Browser tests mock Playwright via `vi.mock('playwright')`
