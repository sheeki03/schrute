import { describe, it, expect } from 'vitest';
import { checkPathRiskNative } from '../../src/native/path-risk.js';
import { checkPathRisk } from '../../src/skill/path-risk.js';

describe('native path risk (TS fallback)', () => {
  it('blocks GET /logout', () => {
    const result = checkPathRiskNative('GET', '/api/logout');
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('Destructive GET');
  });

  it('blocks GET /delete', () => {
    const result = checkPathRiskNative('GET', '/admin/delete/user');
    expect(result.blocked).toBe(true);
  });

  it('blocks POST /payment', () => {
    const result = checkPathRiskNative('POST', '/api/payment');
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('Destructive POST');
  });

  it('blocks PUT (inherently destructive)', () => {
    const result = checkPathRiskNative('PUT', '/api/users/1');
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('inherently destructive');
  });

  it('blocks DELETE (inherently destructive)', () => {
    const result = checkPathRiskNative('DELETE', '/api/users/1');
    expect(result.blocked).toBe(true);
  });

  it('allows safe GET paths', () => {
    const result = checkPathRiskNative('GET', '/api/users');
    expect(result.blocked).toBe(false);
  });

  it('allows safe POST paths', () => {
    const result = checkPathRiskNative('POST', '/api/search');
    expect(result.blocked).toBe(false);
  });

  it('matches TS checkPathRisk output', () => {
    const paths = [
      { method: 'GET', path: '/api/users' },
      { method: 'GET', path: '/logout' },
      { method: 'POST', path: '/api/payment' },
      { method: 'POST', path: '/api/search' },
      { method: 'DELETE', path: '/api/users/1' },
    ];

    for (const { method, path } of paths) {
      const native = checkPathRiskNative(method, path);
      const ts = checkPathRisk(method, path);
      expect(native.blocked).toBe(ts.blocked);
    }
  });
});
