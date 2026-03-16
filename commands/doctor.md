---
description: "Run Schrute health checks and diagnostics"
allowed-tools: ["Bash", "mcp__schrute__schrute_status"]
---

The user wants to run Schrute health diagnostics.

1. Run the doctor command:
   ```bash
   cd "${CLAUDE_PLUGIN_ROOT}" && node dist/index.js doctor
   ```

2. Also check the MCP server status by calling `mcp__schrute__schrute_status`.

3. Present results clearly:
   - Health check results (pass/warn/fail for each check)
   - Current engine status (mode, active sessions, uptime)
   - Any issues found and recommended fixes

4. If critical issues are found, suggest specific remediation steps:
   - Missing Playwright: "Run `schrute setup` to install Chromium"
   - Database issues: "Check ~/.schrute/data/ permissions"
   - Keychain issues: "Verify keytar is installed and accessible"

If the system keychain (keytar) is unavailable, doctor reports a warning. Schrute still functions with reduced credential storage.
