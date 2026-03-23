# Security Policy

## Reporting a Vulnerability

Please report security issues privately.

### Preferred Channel

Use [GitHub Security Advisories](https://github.com/sheeki03/schrute/security/advisories/new) to submit a private report.

### If Advisories Are Not Available

Contact the maintainers privately through the repository's listed contact channels. Do not open a public GitHub issue for an undisclosed vulnerability.

### What To Include

- A clear description of the issue
- Affected version, commit, or deployment context
- Reproduction steps or a proof of concept
- Expected impact
- Any suggested mitigation or patch idea

### Response Targets

- Initial acknowledgment within 48 hours
- A status update within 7 days
- A fix or mitigation plan as soon as the issue is confirmed and triaged

## Scope

### In Scope

- Authentication or authorization bypass in network mode
- Policy or confirmation gate bypass
- SSRF or private-network access through discovery or replay
- Credential leakage, token exposure, or cookie isolation failures
- Command injection, path traversal, or unsafe local file access
- Audit-log tampering or integrity bypass

### Out of Scope

- Social engineering
- Vulnerabilities that depend on physical access to the machine
- Issues only affecting third-party dependencies without a Schrute-specific exploit path
- Pure availability issues on a local-only deployment with no confidentiality or integrity impact

## Security Model At A Glance

Schrute is designed to fail closed. Important protections in the codebase include:

- Policy checks around skill execution and browser-backed actions
- Domain allowlists and request-shaping controls
- SSRF protections, including private-IP blocking and redirect validation
- Confirmation requirements for sensitive or newly learned actions
- Audit logging and redaction for execution visibility
- Timing-safe token verification for authenticated HTTP access
- Separation of stored site data from runtime credentials where possible
