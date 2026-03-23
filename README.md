<p align="center">
  <img src="assets/logo.png" alt="Schrute" width="350">
</p>

<h1 align="center">Schrute</h1>

<p align="center">
Teach your AI a website once. After that, it can repeat the job much faster.
</p>

Schrute is for repeated website tasks.

It supports both paths: you can teach it by having it watch what happens in a real browser, or you can let it discover useful backend structure on its own when a site exposes it. Schrute can do either well, and it is up to you which path to use for a given site or task. Either way, it turns what it finds into reusable tools. That means the first run can happen in the browser, or you can start from direct discovery when that fits better, and later runs can often skip the UI and go straight to the site's backend.

If you keep asking an AI to do the same website task over and over, Schrute is the layer that helps it stop starting from scratch every time.

- Learn from a real browser session
- Reuse your logged-in state
- Replay repeatable tasks without brittle click scripts
- Fall back to the browser when direct replay is not possible
- Use it from MCP, CLI, REST, Python, or TypeScript

## Why People Use It

Without Schrute:

- An agent opens the site again
- Clicks through the UI again
- Waits for the page again
- Pays the same latency again

With Schrute:

- You teach it the task once
- Schrute learns the request pattern behind the page
- The next run can often call the learned action directly

That is especially useful for things like:

- pulling the same dashboard data every day
- checking prices or market pages repeatedly
- searching a site with the same flow many times
- reusing internal tools that only work when you are already logged in

## Quick Start

```bash
npm install -g schrute
schrute setup
```

If you want to use Schrute from an AI client over MCP:

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

## Ways To Use Schrute

You can use the same learned skills in different ways depending on your workflow:

- **MCP**
  Best when you want Claude Code, Cursor, Cline, Windsurf, or another MCP client to call learned website actions as tools.

- **CLI**
  Best when you want to explore, record, inspect, and run skills manually from the terminal.

- **REST API**
  Best when you want another app, script, or backend service to call Schrute over HTTP.

- **Python and TypeScript clients**
  Best when you want a lightweight client package instead of calling raw HTTP endpoints yourself.

So Schrute is not tied to one interface. You can teach it a task once, then reuse that same learned task from the interface that fits your workflow.

## First Run In 2 Minutes

```bash
# 1. Start Schrute
schrute serve

# 2. Open a site in a browser session
schrute explore https://httpbin.org

# 3. Start recording a task
schrute record --name get_ip

# 4. In the opened browser, go to:
#    https://httpbin.org/ip

# 5. Stop recording
schrute stop

# 6. Poll the background pipeline job until skill generation completes
schrute pipeline <job-id>

# 7. Run the learned skill
schrute execute httpbin_org.get_ip.v1 --yes
```

What just happened:

1. Schrute watched the browser traffic for that action.
2. It found the real request behind the page.
3. It saved that request as a reusable skill.
4. You can now run that learned action again without manually driving the page.

## Commands Most People Will Use

```bash
schrute explore https://example.com
schrute record --name my_action
schrute stop
schrute pipeline <job-id>
schrute execute my_skill.v1

schrute skills list --status active
schrute skills search "bitcoin price"
schrute skills show <skill-id>

schrute workflow create --site example.com --name summary --spec '{"steps":[...]}'
schrute workflow run example_com.summary.v1

schrute discover https://api.example.com
schrute doctor
schrute trust
```

## What Schrute Can Do Today

Schrute is no longer just "record and replay." Here is what the current product does, in practical terms:

- **Learns reusable skills from real browsing**
  You do the task once in a browser. Schrute turns what it learned into named actions you can run again later.

- **Generates skills in the background**
  When you run `schrute stop`, Schrute does not make you wait for all processing to finish in the foreground. It gives you a pipeline job and keeps building the skills in the background. You can check progress with `schrute pipeline <job-id>`.

- **Searches and explains what it has already learned**
  Once you have multiple skills, Schrute helps you find the right one with `skills search`, inspect it with `skills show`, validate it, export it, and manage it without digging through raw data.

- **Builds workflows from multiple skills**
  If one reusable action is not enough, Schrute can chain several read-only skills together into a larger workflow. That is useful for multi-step tasks like "get account info, then fetch usage, then return a summary."

- **Discovers APIs even before you record**
  Schrute can scan a site for useful backend clues such as OpenAPI specs, GraphQL endpoints, sitemaps, platform fingerprints, and WebMCP tools. That helps you start faster on sites that already expose a structured backend.

- **Reuses the browser session you already trust**
  If you are already logged into Chrome or an Electron app, Schrute can attach to that session instead of forcing you through login again. This is especially useful for internal tools and dashboards.

- **Supports more than one browser session**
  You are not limited to one browser context. Schrute can manage multiple named sessions so different sites, accounts, or attached browsers do not all get mixed together.

- **Handles sites that still need a live browser**
  Some sites cannot be cleanly replayed as direct HTTP calls because of Cloudflare, anti-bot checks, or other browser-only behavior. Schrute does not pretend otherwise. It keeps those tasks on a browser-backed path so they still work.

- **Lets you call the same learned skills from different places**
  The same learned actions can be used from MCP, the CLI, REST, and the Python or TypeScript client packages. That means you do not have to re-teach the task separately for each integration.

- **Lets you move and maintain what you learned**
  Schrute can export and import learned site bundles, run health checks with `doctor`, show a trust posture report with `trust`, and keep an audit trail of executions.

- **Can improve and maintain learned actions over time**
  Schrute can validate skills, track amendments, run optimization on degraded skills, and keep using safer fallback paths when a direct path stops being reliable.

- **Can work with site-declared tools as well as learned traffic**
  On some sites, Schrute can discover useful backend structure such as WebMCP tools, OpenAPI specs, or GraphQL endpoints in addition to what it learns from browser traffic.

## Feature Overview

If you are trying to understand "what is actually included here?", this is the practical feature map:

- **Explore and record**
  Open a site, perform an action, and let Schrute watch the traffic behind it.

- **Background processing**
  Generate skills after recording without blocking the terminal.

- **Skill catalog**
  List, search, inspect, validate, export, revoke, delete, and manage learned skills.

- **Execution**
  Run learned skills directly from CLI, MCP, REST, or client SDKs.

- **Workflow building**
  Combine multiple read-only skills into one higher-level reusable flow.

- **Discovery**
  Scan a site for OpenAPI, GraphQL, sitemaps, platform patterns, WebMCP tools, and other useful backend signals.

- **Browser session reuse**
  Attach to a browser you already have open and logged into.

- **Multi-session support**
  Keep separate browser sessions for different sites, accounts, or experiments.

- **Fallback execution**
  Keep browser-backed execution for sites that cannot safely or reliably use direct replay.

- **Import and export**
  Move learned site bundles between environments without shipping credentials.

- **Operational tools**
  Use doctor, trust reporting, audit logs, and pipeline status to understand what Schrute is doing.

- **Client access**
  Use the same learned actions through MCP, CLI, REST, Python, and TypeScript.

## How Schrute Runs A Task

Schrute tries to use the simplest reliable path:

1. **Browser first** while the task is still being learned
2. **Direct replay later** when the request is stable and safe to reuse
3. **Browser fallback** when the site truly requires a live browser

So the goal is not "force everything into direct HTTP." The goal is "use the fastest safe execution mode that actually works."

That is why sites behind Cloudflare or other anti-bot systems can still be useful in Schrute. If direct replay is blocked, Schrute keeps them on a browser-backed path instead of pretending they should work the same way as a public API.

## Where It Fits Best

Schrute is a strong fit when:

- the site makes predictable HTTP or JSON requests behind the UI
- the task is repeated often
- you already have the right browser auth state
- you want reusable tools instead of one-off browser scripts

Schrute is a weaker fit when:

- the site is mostly server-rendered HTML with no meaningful backend calls to learn
- the workflow depends heavily on canvas, WebSockets, or visual-only interactions
- the task is truly one-time and not worth teaching

## Common Use Cases

Schrute is especially useful for:

- **Repeated internal dashboard checks**
  Example: pull the same account, usage, or reporting view every day without re-clicking the whole UI.

- **Logged-in business tools**
  Example: use your existing browser session to access an internal admin panel, support tool, CMS, or analytics product.

- **Price, market, and listing lookups**
  Example: repeatedly fetch the same market page or structured data endpoint after teaching the browser path once.

- **Search and lookup workflows**
  Example: teach a site search flow once, then reuse it with different inputs.

- **Agent tool creation**
  Example: turn a repeated browser task into a reusable MCP tool for an AI coding or operations workflow.

- **Multi-step read-only automations**
  Example: fetch one piece of data, use it in a second call, and return a final combined answer through a workflow skill.

- **Sites with a mix of easy and hard paths**
  Example: let Schrute use direct replay where it works, but keep a live-browser fallback for the parts that truly need it.

## Reusing Your Logged-In Browser

If you already have a browser session with the right login state, Schrute can attach to it instead of making you sign in again.

Typical pattern:

```bash
chrome --remote-debugging-port=9222
```

After that, Schrute can connect to the running browser through CDP using its MCP or REST surfaces.

This is especially useful for:

- internal dashboards
- admin tools
- sites with multi-step login flows
- flows where the browser already has the right cookies and session state

## REST API And SDKs

If you want to call Schrute from scripts or apps:

```bash
schrute config set server.authToken my-secret
schrute serve --http --port 3000
```

Then call it over HTTP:

```bash
curl -X POST http://127.0.0.1:3000/api/v1/execute \
  -H "Authorization: Bearer my-secret" \
  -H "Content-Type: application/json" \
  -d '{"skillId":"httpbin_org.get_ip.v1","params":{}}'
```

Client packages:

- TypeScript: `npm install @schrute/client`
- Python: `pip install schrute-client`

MCP HTTP is also available at:

```text
http://127.0.0.1:3001/mcp
```

## Safety And Storage

Schrute does not blindly replay everything it sees.

Before a learned skill runs, Schrute applies safeguards such as:

- domain allowlists
- redirect validation
- method and path checks
- approval for first execution when needed
- audit logging
- rate limiting

Credentials are not exported with skill bundles, and dangerous raw browser execution tools are blocked.

For the full security model, see [SECURITY.md](SECURITY.md).

## Development

**Prerequisites:** Node.js >= 22

```bash
git clone https://github.com/sheeki03/schrute.git
cd schrute
npm install
npm run build
```

Useful commands:

```bash
npm run build
npm test
npm run dev
```

## More

- [SECURITY.md](SECURITY.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)

## License

[Apache-2.0](LICENSE)
