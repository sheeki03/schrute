---
description: "Check Schrute daemon and engine status"
allowed-tools: ["mcp__schrute__schrute_status", "mcp__schrute__schrute_sites", "mcp__schrute__schrute_skills"]
---

The user wants to check the current state of Schrute.

1. Call `mcp__schrute__schrute_status` to get:
   - Engine mode (idle, exploring, recording, replaying)
   - Active session details (if any)
   - Uptime

2. Call `mcp__schrute__schrute_sites` to show known sites.

3. Call `mcp__schrute__schrute_skills` to get a skill count summary.

4. Present a concise status dashboard:
   ```
   Engine: idle | exploring <url> | recording <action>
   Uptime: Xh Ym
   Sites: N known
   Skills: N total (X active, Y pending confirmation)
   ```
