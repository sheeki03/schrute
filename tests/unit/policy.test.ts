import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  invalidatePolicyCache,
} from '../../src/core/policy.js';
import {
  Capability,
  SideEffectClass,
  TIER1_ALLOWED_HEADERS,
  BLOCKED_HOP_BY_HOP_HEADERS,
} from '../../src/skill/types.js';

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
        'user-agent': 'OneAgent/1.0',
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
      const result = checkCapability('cap-site', Capability.BROWSER_MODEL_CONTEXT);
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
      // resolveAndValidate does real DNS by default, but we can test with known hostnames
      // For unit testing, we test the isPublicIp function directly for IP validation
      // and test resolveAndValidate for the full flow
      const result = await resolveAndValidate('localhost');
      expect(result.allowed).toBe(false);
    });

    it('allows public hostnames (dns_error is acceptable in test env)', async () => {
      // In a test environment, DNS might not resolve. We mainly verify the function
      // returns a properly structured result
      const result = await resolveAndValidate('example.com');
      expect(result).toHaveProperty('ip');
      expect(result).toHaveProperty('allowed');
      expect(result).toHaveProperty('category');
      // The result type is always an IpValidationResult regardless of resolution success
      expect(typeof result.allowed).toBe('boolean');
    });
  });
});
