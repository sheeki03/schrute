---
description: "Check OneAgent daemon and engine status"
allowed-tools: ["mcp__oneagent__oneagent_status", "mcp__oneagent__oneagent_sites", "mcp__oneagent__oneagent_skills"]
---

The user wants to check the current state of OneAgent.

1. Call `mcp__oneagent__oneagent_status` to get:
   - Engine mode (idle, exploring, recording, replaying)
   - Active session details (if any)
   - Uptime

2. Call `mcp__oneagent__oneagent_sites` to show known sites.

3. Call `mcp__oneagent__oneagent_skills` to get a skill count summary.

4. Present a concise status dashboard:
   ```
   Engine: idle | exploring <url> | recording <action>
   Uptime: Xh Ym
   Sites: N known
   Skills: N total (X active, Y pending confirmation)
   ```
