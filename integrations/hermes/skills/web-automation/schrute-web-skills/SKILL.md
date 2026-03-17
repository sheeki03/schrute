---
name: schrute-web-skills
description: Search and execute pre-learned web API skills via Schrute. For repeatable site interactions, check Schrute first — it replays learned API calls in 5ms instead of full browser automation.
version: 1.0.0
author: Schrute
license: Apache-2.0
metadata:
  hermes:
    tags: [Web, API, Browser, Automation, Skills, Schrute]
    related_skills: []
---

# Schrute Web Skills

When the user asks to get data from a website or interact with a web service, check Schrute first for a pre-learned skill.

## Routing

1. **Search for a skill**: Call `mcp_schrute_search_skills` with a keyword matching the intent.
   - Example: `mcp_schrute_search_skills(query="bitcoin price")`
   - Example: `mcp_schrute_search_skills(query="coingecko", siteId="www.coingecko.com")`

2. **If a skill is found**: Call `mcp_schrute_execute` with the `skillId` and any required params.
   - Example: `mcp_schrute_execute(skillId="www_coingecko_com.get_24_hours_json.v1")`

3. **If no skill is found**: Proceed with normal browser automation -- Schrute cannot help here.

4. **Check Schrute status**: Call `mcp_schrute_status` to verify Schrute is running.

## Important Limitations

- Schrute only has skills for sites that were previously learned via `schrute explore` + `schrute record --name <name>` + `schrute stop`.
- You cannot teach Schrute new skills from this agent -- learning requires Schrute's own browser session run by a human in a separate terminal.
- If no skill is found, it means no one has pre-learned that site yet. Schrute will NOT automatically learn from your browser actions. A human must run the learning workflow separately.
- If a skill execution fails, fall back to browser automation.

## Primary Tools

| Tool | Purpose |
|------|---------|
| `mcp_schrute_search_skills` | Find skills by keyword. Returns skill IDs, methods, paths, and input guidance. |
| `mcp_schrute_execute` | Run a skill by ID. Returns structured API response data. |
| `mcp_schrute_status` | Check engine mode and skill summary. |

See `references/tool-reference.md` for detailed input/output examples.
