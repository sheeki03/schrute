---
description: "Start recording a browser action to generate an API skill"
argument-hint: "<action-name> [--input key=value ...]"
disable-model-invocation: true
allowed-tools: ["mcp__schrute__schrute_record", "mcp__schrute__schrute_stop", "mcp__schrute__schrute_status", "mcp__schrute__browser_snapshot", "mcp__schrute__browser_navigate", "mcp__schrute__browser_click", "mcp__schrute__browser_type", "mcp__schrute__browser_fill_form"]
---

The user wants to record a browser action to generate a replayable API skill.

1. First check `mcp__schrute__schrute_status` to confirm there is an active explore session.
   - If no session is active, tell the user to run `/schrute:explore <url>` first.

2. Parse the arguments:
   - First argument is the action name (required)
   - Any `key=value` pairs after `--input` become the inputs map

3. Call `mcp__schrute__schrute_record` with the action name and any inputs.

4. Inform the user that recording has started. They should now perform the action in the browser:
   - Navigate to the relevant page
   - Fill forms, click buttons, etc.
   - All network traffic is being captured

5. When the user indicates they are done (or says "stop"), call `mcp__schrute__schrute_stop` to:
   - Stop recording
   - Process the HAR capture
   - Generate skills from the recorded interactions

6. Report the results: how many skills were generated, their names, methods, and paths.

If the action name is missing, ask the user for it.
