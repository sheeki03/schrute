import { describe, it, expect } from 'vitest';
import { isDomainMatch } from '../../src/shared/domain-utils.js';

describe('isDomainMatch', () => {
  it('returns true for exact domain match', () => {
    expect(isDomainMatch('example.com', ['example.com'])).toBe(true);
  });

  it('returns true for subdomain match', () => {
    expect(isDomainMatch('api.example.com', ['example.com'])).toBe(true);
  });

  it('returns false for non-matching domain with shared suffix', () => {
    // evil-example.com should NOT match example.com
    expect(isDomainMatch('evil-example.com', ['example.com'])).toBe(false);
  });

  it('performs case-insensitive matching', () => {
    expect(isDomainMatch('Example.COM', ['example.com'])).toBe(true);
  });

  it('performs case-insensitive matching on allowlist entries', () => {
    expect(isDomainMatch('example.com', ['Example.COM'])).toBe(true);
  });

  it('matches against multiple domains in allowlist', () => {
    const allowlist = ['example.com', 'other.org'];
    expect(isDomainMatch('api.example.com', allowlist)).toBe(true);
    expect(isDomainMatch('other.org', allowlist)).toBe(true);
    expect(isDomainMatch('evil.net', allowlist)).toBe(false);
  });

  it('returns false for empty allowlist', () => {
    expect(isDomainMatch('example.com', [])).toBe(false);
  });

  it('matches deep subdomains', () => {
    expect(isDomainMatch('a.b.c.example.com', ['example.com'])).toBe(true);
  });

  it('matches exact domain (not via subdomain logic)', () => {
    // When target === allowed, the exact match check fires first
    expect(isDomainMatch('example.com', ['example.com'])).toBe(true);
  });

  it('does not match a parent domain against a subdomain allowlist entry', () => {
    // example.com should NOT match api.example.com
    expect(isDomainMatch('example.com', ['api.example.com'])).toBe(false);
  });

  it('accepts iterable (Set) as allowlist', () => {
    const allowSet = new Set(['example.com', 'other.org']);
    expect(isDomainMatch('api.example.com', allowSet)).toBe(true);
    expect(isDomainMatch('evil.net', allowSet)).toBe(false);
  });

  it('does not match unrelated domains', () => {
    expect(isDomainMatch('totally-different.net', ['example.com'])).toBe(false);
  });

  it('handles single-label domains', () => {
    expect(isDomainMatch('localhost', ['localhost'])).toBe(true);
    expect(isDomainMatch('sub.localhost', ['localhost'])).toBe(true);
    expect(isDomainMatch('localhost', ['other'])).toBe(false);
  });
});
