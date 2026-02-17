---
description: "List, inspect, or manage OneAgent skills"
argument-hint: "[list|show <id>|validate <id>]"
allowed-tools: ["mcp__oneagent__oneagent_skills", "mcp__oneagent__oneagent_sites", "mcp__oneagent__oneagent_dry_run"]
---

The user wants to view or manage OneAgent skills.

Parse the subcommand from arguments:

**`list` (default if no args)**:
1. Call `mcp__oneagent__oneagent_skills` to get all skills.
2. Present them in a table: Name, Site, Method, Path, Status, Tier, Success Rate.
3. If there are many skills, group by site.

**`show <id>`**:
1. Call `mcp__oneagent__oneagent_skills` and find the matching skill.
2. Show full details: parameters, input schema, allowed domains, side-effect class, tier lock status.
3. Optionally run `mcp__oneagent__oneagent_dry_run` to show what a request would look like.

**`validate <id>`**:
1. Call `mcp__oneagent__oneagent_dry_run` with the skill ID in `developer-debug` mode.
2. Show the full request preview: method, URL, headers, body (all redacted).
3. Show the volatility report and tier decision rationale.

If no subcommand matches, default to `list`.
