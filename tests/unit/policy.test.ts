import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock DNS to avoid real network lookups in tests ────────────
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (hostname: string) => {
    const hostMap: Record<string, string> = {
      'localhost': '127.0.0.1',
      'example.com': '93.184.216.34',
    };
    const address = hostMap[hostname];
    if (!address) {
      const err = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
      (err as NodeJS.ErrnoException).code = 'ENOTFOUND';
      throw err;
    }
    return { address, family: 4 };
  }),
}));

import {
  isPublicIp,
  checkPathRisk,
  filterHeaders,
  enforceDomainAllowlist,
  checkCapability,
  checkMethodAllowed,
  checkRedirectAllowed,
  resolveAndValidate,
  setSitePolicy,
  getSitePolicy,
  invalidatePolicyCache,
} from '../../src/core/policy.js';
import {
  Capability,
  SideEffectClass,
  TIER1_ALLOWED_HEADERS,
  BLOCKED_HOP_BY_HOP_HEADERS,
} from '../../src/skill/types.js';
import type { SitePolicy } from '../../src/skill/types.js';

describe('policy', () => {
  describe('private IP blocking', () => {
    it('blocks 127.0.0.1 (loopback)', () => {
      expect(isPublicIp('127.0.0.1')).toBe(false);
    });

    it('blocks 10.0.0.1 (private class A)', () => {
      expect(isPublicIp('10.0.0.1')).toBe(false);
    });

    it('blocks 192.168.1.1 (private class C)', () => {
      expect(isPublicIp('192.168.1.1')).toBe(false);
    });

    it('blocks ::1 (IPv6 loopback)', () => {
      expect(isPublicIp('::1')).toBe(false);
    });

    it('blocks fe80::1 (IPv6 link-local)', () => {
      expect(isPublicIp('fe80::1')).toBe(false);
    });

    it('blocks 100.64.0.1 (CGNAT)', () => {
      expect(isPublicIp('100.64.0.1')).toBe(false);
    });

    it('allows 8.8.8.8 (public)', () => {
      expect(isPublicIp('8.8.8.8')).toBe(true);
    });

    it('allows 1.1.1.1 (public)', () => {
      expect(isPublicIp('1.1.1.1')).toBe(true);
    });

    it('blocks IPv4-mapped IPv6 private addresses', () => {
      expect(isPublicIp('::ffff:10.0.0.1')).toBe(false);
      expect(isPublicIp('::ffff:127.0.0.1')).toBe(false);
      expect(isPublicIp('::ffff:192.168.1.1')).toBe(false);
      expect(isPublicIp('::ffff:169.254.0.1')).toBe(false);
    });
  });

  describe('path-risk GET', () => {
    it('blocks /logout', () => {
      const result = checkPathRisk('GET', '/api/logout');
      expect(result.blocked).toBe(true);
    });

    it('blocks /delete', () => {
      const result = checkPathRisk('GET', '/users/delete');
      expect(result.blocked).toBe(true);
    });

    it('blocks /unsubscribe', () => {
      const result = checkPathRisk('GET', '/mail/unsubscribe');
      expect(result.blocked).toBe(true);
    });

    it('blocks /toggle', () => {
      const result = checkPathRisk('GET', '/settings/toggle');
      expect(result.blocked).toBe(true);
    });

    it('allows normal GET paths', () => {
      expect(checkPathRisk('GET', '/api/search').blocked).toBe(false);
      expect(checkPathRisk('GET', '/users').blocked).toBe(false);
    });
  });

  describe('path-risk POST', () => {
    it('blocks /mutation', () => {
      const result = checkPathRisk('POST', '/api/mutation');
      expect(result.blocked).toBe(true);
    });

    it('blocks /charge', () => {
      const result = checkPathRisk('POST', '/billing/charge');
      expect(result.blocked).toBe(true);
    });

    it('blocks /payment', () => {
      const result = checkPathRisk('POST', '/api/payment');
      expect(result.blocked).toBe(true);
    });

    it('allows normal POST paths', () => {
      expect(checkPathRisk('POST', '/api/search').blocked).toBe(false);
    });
  });

  describe('header filtering', () => {
    it('blocks hop-by-hop headers', () => {
      const headers: Record<string, string> = {
        'connection': 'keep-alive',
        'transfer-encoding': 'chunked',
        'accept': 'application/json',
      };
      const filtered = filterHeaders(headers, 1, ['example.com'], 'example.com');
      expect(filtered).not.toHaveProperty('connection');
      expect(filtered).not.toHaveProperty('transfer-encoding');
    });

    it('allows Tier 1 allowed headers', () => {
      const headers: Record<string, string> = {
        'accept': 'application/json',
        'content-type': 'application/json',
        'user-agent': 'Schrute/1.0',
      };
      const filtered = filterHeaders(headers, 1, ['example.com'], 'example.com');
      expect(filtered).toHaveProperty('accept');
      expect(filtered).toHaveProperty('content-type');
      expect(filtered).toHaveProperty('user-agent');
    });

    it('blocks non-allowlisted headers at tier 1', () => {
      const headers: Record<string, string> = {
        'x-custom-header': 'value',
        'accept': 'application/json',
      };
      const filtered = filterHeaders(headers, 1, [], '');
      expect(filtered).not.toHaveProperty('x-custom-header');
      expect(filtered).toHaveProperty('accept');
    });
  });

  describe('domain allowlist enforcement', () => {
    it('allows exact domain match', () => {
      setSitePolicy({
        siteId: 'test-site',
        allowedMethods: ['GET'],
        maxQps: 10,
        maxConcurrent: 3,
        readOnlyDefault: true,
        requireConfirmation: [],
        domainAllowlist: ['api.example.com'],
        redactionRules: [],
        capabilities: [],
      });
      const result = enforceDomainAllowlist('test-site', 'api.example.com');
      expect(result.allowed).toBe(true);
    });

    it('allows subdomain of allowlisted domain', () => {
      setSitePolicy({
        siteId: 'test-site-sub',
        allowedMethods: ['GET'],
        maxQps: 10,
        maxConcurrent: 3,
        readOnlyDefault: true,
        requireConfirmation: [],
        domainAllowlist: ['example.com'],
        redactionRules: [],
        capabilities: [],
      });
      const result = enforceDomainAllowlist('test-site-sub', 'api.example.com');
      expect(result.allowed).toBe(true);
    });

    it('blocks non-allowlisted domain', () => {
      setSitePolicy({
        siteId: 'test-site-block',
        allowedMethods: ['GET'],
        maxQps: 10,
        maxConcurrent: 3,
        readOnlyDefault: true,
        requireConfirmation: [],
        domainAllowlist: ['example.com'],
        redactionRules: [],
        capabilities: [],
      });
      const result = enforceDomainAllowlist('test-site-block', 'evil.com');
      expect(result.allowed).toBe(false);
    });

    it('blocks when no allowlist configured', () => {
      const result = enforceDomainAllowlist('no-policy-site', 'anything.com');
      expect(result.allowed).toBe(false);
    });
  });

  describe('capability check', () => {
    it('allows enabled capabilities', () => {
      setSitePolicy({
        siteId: 'cap-site',
        allowedMethods: ['GET'],
        maxQps: 10,
        maxConcurrent: 3,
        readOnlyDefault: true,
        requireConfirmation: [],
        domainAllowlist: [],
        redactionRules: [],
        capabilities: [Capability.NET_FETCH_DIRECT, Capability.STORAGE_WRITE],
      });
      const result = checkCapability('cap-site', Capability.NET_FETCH_DIRECT);
      expect(result.allowed).toBe(true);
    });

    it('blocks v0.1 disabled capabilities', () => {
      const result = checkCapability('cap-site', Capability.EXPORT_SKILLS);
      expect(result.allowed).toBe(false);
      expect(result.rule).toBe('capability.disabled_by_default');
    });

    it('blocks capabilities not granted to site', () => {
      setSitePolicy({
        siteId: 'no-cap-site',
        allowedMethods: ['GET'],
        maxQps: 10,
        maxConcurrent: 3,
        readOnlyDefault: true,
        requireConfirmation: [],
        domainAllowlist: [],
        redactionRules: [],
        capabilities: [Capability.NET_FETCH_DIRECT],
      });
      const result = checkCapability('no-cap-site', Capability.STORAGE_WRITE);
      expect(result.allowed).toBe(false);
      expect(result.rule).toBe('capability.not_granted');
    });
  });

  // ─── checkMethodAllowed ──────────────────────────────────────

  describe('checkMethodAllowed', () => {
    beforeEach(() => {
      // Set up policy that only allows GET and HEAD explicitly
      setSitePolicy({
        siteId: 'method-test-site',
        allowedMethods: ['GET', 'HEAD'],
        maxQps: 10,
        maxConcurrent: 3,
        readOnlyDefault: true,
        requireConfirmation: [],
        domainAllowlist: ['example.com'],
        redactionRules: [],
        capabilities: [],
      });
    });

    it('allows GET requests for any policy', () => {
      expect(checkMethodAllowed('method-test-site', 'GET')).toBe(true);
    });

    it('allows HEAD requests for any policy', () => {
      expect(checkMethodAllowed('method-test-site', 'HEAD')).toBe(true);
    });

    it('allows methods in policy allowedMethods list', () => {
      setSitePolicy({
        siteId: 'method-allow-post',
        allowedMethods: ['GET', 'HEAD', 'POST', 'PUT'],
        maxQps: 10,
        maxConcurrent: 3,
        readOnlyDefault: true,
        requireConfirmation: [],
        domainAllowlist: ['example.com'],
        redactionRules: [],
        capabilities: [],
      });
      expect(checkMethodAllowed('method-allow-post', 'POST')).toBe(true);
      expect(checkMethodAllowed('method-allow-post', 'PUT')).toBe(true);
    });

    it('blocks DELETE when not in allowedMethods', () => {
      expect(checkMethodAllowed('method-test-site', 'DELETE')).toBe(false);
    });

    it('blocks POST when not in allowedMethods and not read-only', () => {
      expect(checkMethodAllowed('method-test-site', 'POST', SideEffectClass.NON_IDEMPOTENT)).toBe(false);
    });

    it('allows POST with read-only side-effect class even if not in allowedMethods', () => {
      expect(checkMethodAllowed('method-test-site', 'POST', SideEffectClass.READ_ONLY)).toBe(true);
    });

    it('is case-insensitive for method names', () => {
      expect(checkMethodAllowed('method-test-site', 'get')).toBe(true);
      expect(checkMethodAllowed('method-test-site', 'head')).toBe(true);
    });

    it('blocks PATCH when not in allowedMethods', () => {
      expect(checkMethodAllowed('method-test-site', 'PATCH')).toBe(false);
    });
  });

  // ─── checkRedirectAllowed ────────────────────────────────────

  describe('checkRedirectAllowed', () => {
    beforeEach(() => {
      setSitePolicy({
        siteId: 'redirect-site',
        allowedMethods: ['GET'],
        maxQps: 10,
        maxConcurrent: 3,
        readOnlyDefault: true,
        requireConfirmation: [],
        domainAllowlist: ['example.com', 'cdn.example.com'],
        redactionRules: [],
        capabilities: [],
      });
    });

    it('allows same-domain redirects', () => {
      const result = checkRedirectAllowed('redirect-site', 'https://example.com/new-path');
      expect(result.allowed).toBe(true);
    });

    it('allows redirect to subdomain in allowlist', () => {
      const result = checkRedirectAllowed('redirect-site', 'https://cdn.example.com/asset');
      expect(result.allowed).toBe(true);
    });

    it('blocks cross-domain redirect to non-allowlisted domain', () => {
      const result = checkRedirectAllowed('redirect-site', 'https://evil.com/phishing');
      expect(result.allowed).toBe(false);
      expect(result.rule).toBe('domain.not_allowlisted');
    });

    it('blocks redirect to non-allowlisted domain', () => {
      const result = checkRedirectAllowed('redirect-site', 'https://other-site.net/api');
      expect(result.allowed).toBe(false);
    });

    it('handles relative redirects with base URL', () => {
      const result = checkRedirectAllowed('redirect-site', '/new-path', 'https://example.com/old-path');
      expect(result.allowed).toBe(true);
    });

    it('returns error for invalid redirect URLs', () => {
      const result = checkRedirectAllowed('redirect-site', ':::invalid');
      expect(result.allowed).toBe(false);
      expect(result.rule).toBe('redirect.invalid_url');
    });
  });

  // ─── resolveAndValidate ──────────────────────────────────────

  describe('resolveAndValidate', () => {

    it('rejects private IP 127.0.0.1 (loopback)', async () => {
      // DNS mock returns 127.0.0.1 for 'localhost'
      const result = await resolveAndValidate('localhost');
      expect(result.allowed).toBe(false);
      expect(result.ip).toBe('127.0.0.1');
    });

    it('allows public hostnames', async () => {
      // DNS mock returns 93.184.216.34 for 'example.com'
      const result = await resolveAndValidate('example.com');
      expect(result.ip).toBe('93.184.216.34');
      expect(result.allowed).toBe(true);
      expect(result.category).toBe('unicast');
    });

    it('returns dns_error for unresolvable hostnames', async () => {
      const result = await resolveAndValidate('does-not-exist.invalid');
      expect(result.allowed).toBe(false);
      expect(result.category).toBe('dns_error');
    });
  });

  // ─── Execution backend policy fields ────────────────────────────

  describe('executionBackend and executionSessionName', () => {
    it('persists executionBackend on SitePolicy', () => {
      const policy: SitePolicy = {
        siteId: 'exec-backend-site',
        allowedMethods: ['GET'],
        maxQps: 10,
        maxConcurrent: 3,
        readOnlyDefault: true,
        requireConfirmation: [],
        domainAllowlist: ['example.com'],
        redactionRules: [],
        capabilities: [],
        executionBackend: 'agent-browser',
      };
      setSitePolicy(policy);
      const loaded = getSitePolicy('exec-backend-site');
      expect(loaded.executionBackend).toBe('agent-browser');
    });

    it('persists executionBackend=playwright on SitePolicy', () => {
      const policy: SitePolicy = {
        siteId: 'exec-pw-site',
        allowedMethods: ['GET'],
        maxQps: 10,
        maxConcurrent: 3,
        readOnlyDefault: true,
        requireConfirmation: [],
        domainAllowlist: ['example.com'],
        redactionRules: [],
        capabilities: [],
        executionBackend: 'playwright',
      };
      setSitePolicy(policy);
      const loaded = getSitePolicy('exec-pw-site');
      expect(loaded.executionBackend).toBe('playwright');
    });

    it('persists executionSessionName on SitePolicy', () => {
      const policy: SitePolicy = {
        siteId: 'exec-session-site',
        allowedMethods: ['GET'],
        maxQps: 10,
        maxConcurrent: 3,
        readOnlyDefault: true,
        requireConfirmation: [],
        domainAllowlist: ['example.com'],
        redactionRules: [],
        capabilities: [],
        executionBackend: 'playwright',
        executionSessionName: 'shared-hard-site',
      };
      setSitePolicy(policy);
      const loaded = getSitePolicy('exec-session-site');
      expect(loaded.executionSessionName).toBe('shared-hard-site');
      expect(loaded.executionBackend).toBe('playwright');
    });

    it('defaults executionBackend to undefined when not set', () => {
      const policy: SitePolicy = {
        siteId: 'no-exec-backend',
        allowedMethods: ['GET'],
        maxQps: 10,
        maxConcurrent: 3,
        readOnlyDefault: true,
        requireConfirmation: [],
        domainAllowlist: [],
        redactionRules: [],
        capabilities: [],
      };
      setSitePolicy(policy);
      const loaded = getSitePolicy('no-exec-backend');
      expect(loaded.executionBackend).toBeUndefined();
      expect(loaded.executionSessionName).toBeUndefined();
    });

    it('throws when executionSessionName is set without executionBackend=playwright', () => {
      const policy: SitePolicy = {
        siteId: 'invalid-session-site',
        allowedMethods: ['GET'],
        maxQps: 10,
        maxConcurrent: 3,
        readOnlyDefault: true,
        requireConfirmation: [],
        domainAllowlist: [],
        redactionRules: [],
        capabilities: [],
        executionBackend: 'agent-browser',
        executionSessionName: 'some-session',
      };
      expect(() => setSitePolicy(policy)).toThrow(
        /executionSessionName requires executionBackend='playwright'/,
      );
    });

    it('throws when executionSessionName is set without any executionBackend', () => {
      const policy: SitePolicy = {
        siteId: 'no-backend-session-site',
        allowedMethods: ['GET'],
        maxQps: 10,
        maxConcurrent: 3,
        readOnlyDefault: true,
        requireConfirmation: [],
        domainAllowlist: [],
        redactionRules: [],
        capabilities: [],
        executionSessionName: 'some-session',
      };
      expect(() => setSitePolicy(policy)).toThrow(
        /executionSessionName requires executionBackend='playwright'/,
      );
    });
  });
});
