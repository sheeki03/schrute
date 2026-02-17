---
description: "Start a browser session to explore a website and discover its API endpoints"
argument-hint: "<url>"
disable-model-invocation: true
allowed-tools: ["mcp__oneagent__oneagent_explore", "mcp__oneagent__oneagent_status", "mcp__oneagent__browser_snapshot", "mcp__oneagent__browser_navigate", "mcp__oneagent__browser_click"]
---

The user wants to explore a website using OneAgent.

1. Call `mcp__oneagent__oneagent_explore` with the provided URL to start a browser session.
2. After the session starts, take a `mcp__oneagent__browser_snapshot` to see the current page state.
3. Report what was found: the site ID, session details, and a summary of the page content.
4. Let the user know they can now:
   - Navigate and interact with the page using browser tools
   - Start recording an action with `/oneagent:record`
   - The browser session stays open until they close it

If the URL is missing, ask the user for it.
