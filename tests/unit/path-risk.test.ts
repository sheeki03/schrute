import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkPathRisk,
  addPathAllowlistEntry,
  clearPathAllowlist,
} from '../../src/skill/path-risk.js';

describe('path-risk', () => {
  beforeEach(() => {
    clearPathAllowlist();
  });

  describe('destructive GET paths', () => {
    it('blocks /logout', () => {
      expect(checkPathRisk('GET', '/api/logout').blocked).toBe(true);
    });

    it('blocks /delete', () => {
      expect(checkPathRisk('GET', '/users/delete').blocked).toBe(true);
    });

    it('blocks /unsubscribe', () => {
      expect(checkPathRisk('GET', '/mail/unsubscribe').blocked).toBe(true);
    });

    it('blocks /toggle', () => {
      expect(checkPathRisk('GET', '/settings/toggle').blocked).toBe(true);
    });

    it('blocks /signout', () => {
      expect(checkPathRisk('GET', '/auth/signout').blocked).toBe(true);
    });
  });

  describe('destructive POST paths', () => {
    it('blocks /mutation', () => {
      expect(checkPathRisk('POST', '/api/mutation').blocked).toBe(true);
    });

    it('blocks /charge', () => {
      expect(checkPathRisk('POST', '/billing/charge').blocked).toBe(true);
    });

    it('blocks /payment', () => {
      expect(checkPathRisk('POST', '/checkout/payment').blocked).toBe(true);
    });

    it('blocks /delete via POST', () => {
      expect(checkPathRisk('POST', '/api/delete').blocked).toBe(true);
    });
  });

  describe('safe paths', () => {
    it('allows GET /api/search', () => {
      expect(checkPathRisk('GET', '/api/search').blocked).toBe(false);
    });

    it('allows GET /users', () => {
      expect(checkPathRisk('GET', '/users').blocked).toBe(false);
    });

    it('allows POST /api/search', () => {
      expect(checkPathRisk('POST', '/api/search').blocked).toBe(false);
    });
  });

  describe('inherently destructive methods', () => {
    it('blocks PUT on any path', () => {
      expect(checkPathRisk('PUT', '/api/users/1').blocked).toBe(true);
    });

    it('blocks DELETE on any path', () => {
      expect(checkPathRisk('DELETE', '/api/users/1').blocked).toBe(true);
    });

    it('blocks PATCH on any path', () => {
      expect(checkPathRisk('PATCH', '/api/users/1').blocked).toBe(true);
    });
  });

  describe('custom allowlist overrides', () => {
    it('allows a normally-blocked path when allowlisted', () => {
      addPathAllowlistEntry('test-site', '/api/logout');
      const result = checkPathRisk('GET', '/api/logout', 'test-site');
      expect(result.blocked).toBe(false);
    });

    it('does not affect other sites', () => {
      addPathAllowlistEntry('site-a', '/api/logout');
      const result = checkPathRisk('GET', '/api/logout', 'site-b');
      expect(result.blocked).toBe(true);
    });
  });
});
