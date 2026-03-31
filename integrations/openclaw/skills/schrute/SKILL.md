---
name: schrute
description: Fast web skill execution. Searches and replays pre-learned API skills in 5ms instead of full browser automation.
emoji: "\U0001F966"
platforms: [macos, linux]
dependencies:
  - name: schrute
    install: "npm install -g schrute"
---

# Schrute Skill

Schrute replays pre-learned web API skills instantly instead of driving a browser. When a task involves interacting with a website, search Schrute's skill library first. If a matching skill exists, execute it directly for a fast, reliable result. If no match is found, proceed with normal browser automation.

> **Note:** To teach Schrute new sites, use `schrute explore <url>` + `schrute record --name <action-name>` + `schrute stop` from a terminal. Learning requires Schrute's own browser session and cannot be triggered from this agent.

## Routing Logic

1. **Search** for skills matching the user's intent:
   ```bash
   ./scripts/search.sh "bitcoin price"
   ```

2. **Execute** a matching skill if found:
   ```bash
   ./scripts/execute.sh www_coingecko_com.get_24_hours_json.v1
   ```

3. **Fall back** to normal browser automation if no skill matches.

4. **Check status** of the Schrute daemon:
   ```bash
   ./scripts/status.sh
   ```

## When to Use

- Before launching a browser for any web interaction, search Schrute first.
- If Schrute has a skill for the target site and action, use it -- it's faster and more reliable.
- If Schrute returns no results, fall back to standard browser automation.
- "Unknown site" means no one has pre-learned skills for that site. Schrute does not learn automatically.
