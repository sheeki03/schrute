# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Schrute, please report it responsibly.

### How to Report

1. **GitHub Security Advisories** (preferred): Use [GitHub Security Advisories](https://github.com/user/schrute/security/advisories/new) to privately report the vulnerability.

2. **Email**: Send details to the repository maintainers via the email listed in the GitHub profile.

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### What to Expect

- Acknowledgment within 48 hours
- Status update within 7 days
- We aim to release fixes within 30 days of confirmed vulnerabilities

## Scope

### In Scope

- Authentication bypass in HTTP transport
- SSRF via skill execution
- Policy gate bypass
- Credential leakage (auth tokens, cookies)
- Command injection via skill parameters
- Audit log tampering
- Path traversal in data directory operations

### Out of Scope

- Denial of service (Schrute is a local tool)
- Issues requiring physical access
- Social engineering
- Issues in dependencies (report upstream)

## Security Architecture

Schrute's security model is documented in `CLAUDE.md`. Key protections:

- **9 policy gates** on every skill execution
- **Fail-closed auth** for network mode (HTTP transport)
- **HMAC-chained audit log** for tamper detection
- **Timing-safe token comparison** to prevent timing attacks
- **Domain allowlists** per site
- **SSRF prevention** blocking private IP targets
- **One-time confirmation** required for all new skills
- **Credential isolation** — auth tokens never persist to config files
