# Schrute + OpenClaw Integration

Integrate Schrute's pre-learned web skills into OpenClaw agents for fast API-level execution (5ms) instead of full browser automation.

## How It Works

Schrute replays pre-learned API skills. It does **not** learn automatically from agent browser sessions.

- **Pre-learned skills**: Schrute searches its skill library and replays matching API calls directly.
- **Unknown sites**: If no skill matches, the agent falls back to normal browser automation.
- **"Unknown site" errors**: This means no one has pre-learned skills for that site yet. Schrute will not automatically learn from OpenClaw's browser sessions.

## Prerequisites

1. Install Schrute globally:

   ```bash
   npm install -g schrute
   ```

2. Pre-learn skills for the sites your agents will interact with. This must be done separately in a terminal — it cannot be triggered from within an agent session:

   ```bash
   schrute explore <url>                    # Open a site in Schrute's browser
   schrute record --name <action-name>     # Start recording interactions
   # Perform the actions you want to capture...
   schrute stop                            # Stop recording and save the skill
   ```

3. Copy the `skills/schrute` directory into your OpenClaw skills folder:

   ```bash
   cp -r integrations/openclaw/skills/schrute <your-openclaw-skills-dir>/schrute
   ```

## Teaching Schrute New Sites

To teach Schrute new sites, use `schrute explore <url>` + `schrute record --name <action-name>` + `schrute stop` from a terminal. Learning requires Schrute's own browser session and cannot be triggered from an OpenClaw agent.

## Routing Pattern

The skill follows a search-first routing pattern:

1. **Search** for skills matching the intent: `./scripts/search.sh "bitcoin price"`
2. **Execute** if a match is found: `./scripts/execute.sh www_coingecko_com.get_24_hours_json.v1`
3. **Fall back** to normal browser automation if no match is found
4. **Check status** if needed: `./scripts/status.sh`
