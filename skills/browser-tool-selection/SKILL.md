---
name: browser-tool-selection
description: Decision guide for choosing between Schrute skill recording and direct browser automation. Compares approaches based on task repeatability, latency needs, and API extraction goals. Use when user asks "which browser tool", "automate this website", "should I use schrute", "browser automation options", or needs help deciding how to approach a browser task.
user-invocable: true
argument-hint: "[task-description]"
metadata:
  author: Schrute Contributors
  version: 0.1.0
  mcp-server: schrute
---

# Browser Tool Selection Guide

When a task requires browser interaction, choose the right approach based on the task characteristics.

## Decision Framework

### Use Schrute When:
- **Repeated API calls**: The same action will be performed multiple times
- **Learning patterns**: You want to record and optimize browser interactions
- **Progressive optimization**: Start with browser automation, automatically promote to direct HTTP
- **Skill replay**: You need to replay a previously recorded action with different parameters
- **API extraction**: You want to discover and extract API endpoints from a website

### Use Direct Browser Automation When:
- **One-off interactions**: The action will only be performed once
- **UI testing**: You need to verify visual elements or layout
- **Screenshots**: You need to capture what the page looks like
- **Form filling**: Simple form submission without API extraction
- **Navigation exploration**: Browsing around to understand a site's structure

## Quick Decision Guide

| Question | Yes → | No → |
|----------|-------|------|
| Will this action be repeated? | Schrute | Direct browser |
| Do I need to optimize latency? | Schrute | Either |
| Am I just looking at the page? | Direct browser | Either |
| Do I want to learn the API? | Schrute | Direct browser |
| Is this a one-time data extraction? | Direct browser | Schrute |
| Will I reuse this across sessions? | Schrute | Direct browser |

## Schrute Workflow

1. **Explore**: `schrute_explore` with the target URL to start a browser session
2. **Navigate**: Use browser tools to interact with the page
3. **Record**: `schrute_record` to capture an action (names the API interaction)
4. **Stop**: `schrute_stop` to process the recording into a skill
5. **Replay**: The generated skill appears as an MCP tool for future use

## Execution Tiers

Schrute skills start at Tier 3 (browser-proxied) and can promote to Tier 1 (direct HTTP) after validation:

| Tier | Method | Latency | Promotion Criteria |
|------|--------|---------|-------------------|
| 1 | Direct HTTP fetch | 1-50ms | 5 consecutive validations, low volatility |
| 2 | Cookie refresh + fetch | 5-100ms | Auth-required endpoints |
| 3 | Browser-proxied fetch | 100-500ms | Default starting tier |
| 4 | Full Playwright automation | 1-10s | Fallback for complex interactions |

## Combining Approaches

You can use both approaches together:
- Start with direct browser tools to explore a site
- Switch to Schrute recording when you identify repeatable actions
- Use recorded skills for subsequent calls while using browser tools for new exploration
