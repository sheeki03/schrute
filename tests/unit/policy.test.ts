import { describe, it, expect, beforeEach } from 'vitest';
import {
  isPublicIp,
  checkPathRisk,
  filterHeaders,
  enforceDomainAllowlist,
  checkCapability,
  setSitePolicy,
} from '../../src/core/policy.js';
import {
  Capability,
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
      expect(result.rule).toBe('capability.v01_disabled');
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
});
