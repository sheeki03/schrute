# Schrute + Hermes Integration

Schrute serves as an MCP server that gives Hermes access to **pre-learned web automation skills**. These skills replay captured API calls in ~5ms instead of driving a full browser.

## How It Works

Schrute does **not** learn automatically from Hermes browser sessions. Skills must be pre-learned by a human in a separate terminal using Schrute's own browser session:

```bash
# 1. Explore a site (opens Schrute's browser, discovers API endpoints)
npx schrute explore https://www.coingecko.com

# 2. Record specific interactions you want to automate
npx schrute record --name learn-coingecko-btc

# 3. Stop recording and save the skill
npx schrute stop
```

Once a skill is learned, Hermes can execute it via MCP tools like `mcp_schrute_search_skills`, `mcp_schrute_execute`, and `mcp_schrute_status`.

If Hermes encounters a site with no pre-learned skills, Schrute cannot help. The agent should fall back to normal browser automation. A human must run the learning workflow separately before Schrute can serve skills for that site.

## Setup

### 1. Install Schrute

```bash
npm install -g schrute
# or use npx (no install needed)
```

### 2. Configure MCP Server

Add the following to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  schrute:
    command: npx
    args: ["schrute", "serve", "--stdio"]
    timeout: 30
```

### 3. Install Hermes Skill

Copy the skill directory into your Hermes skills folder:

```bash
cp -r integrations/hermes/skills/web-automation/ ~/.hermes/skills/web-automation/
```

### 4. Pre-Learn Skills

Before Hermes can use Schrute, you need to teach it about the sites you want to automate. In a separate terminal:

```bash
npx schrute explore https://example.com
npx schrute record --name learn-example-action
# Interact with the site in the browser that opens...
npx schrute stop
```

Repeat for each site you want Hermes to be able to query.

## Available MCP Tools

Hermes gets access to Schrute's full MCP tool surface. The three primary tools for skill execution are:

| Tool | Purpose |
|------|---------|
| `mcp_schrute_search_skills` | Find skills by keyword or site. Returns skill IDs and metadata. |
| `mcp_schrute_execute` | Run a skill by ID. Returns structured API response data. |
| `mcp_schrute_status` | Check if Schrute is running, engine mode, and skill summary. |

## Limitations

- **No automatic learning**: Schrute will NOT learn from Hermes browser sessions. Learning requires Schrute's own browser session via `schrute explore`.
- **Unknown site = no help**: If no skill exists for a site, Schrute returns empty results. The agent should use normal browser tools instead.
- **Skills are site-specific**: A skill learned on `www.coingecko.com` only works for that domain.
- **Skills can break**: If a site changes its API, existing skills may fail. Re-learn them with `schrute explore <url>` + `schrute record --name <name>` + `schrute stop`.
