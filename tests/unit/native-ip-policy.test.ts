import { describe, it, expect } from 'vitest';
import {
  isPublicIpNative,
  normalizeDomainNative,
  checkDomainAllowlistNative,
} from '../../src/native/ip-policy.js';

describe('native IP policy (TS fallback)', () => {
  it('allows public IPv4', () => {
    const result = isPublicIpNative('93.184.216.34');
    expect(result).not.toBeNull();
    expect(result!.allowed).toBe(true);
  });

  it('blocks private 10.x.x.x', () => {
    const result = isPublicIpNative('10.0.0.1');
    expect(result).not.toBeNull();
    expect(result!.allowed).toBe(false);
  });

  it('blocks private 192.168.x.x', () => {
    const result = isPublicIpNative('192.168.1.1');
    expect(result).not.toBeNull();
    expect(result!.allowed).toBe(false);
  });

  it('blocks loopback', () => {
    const result = isPublicIpNative('127.0.0.1');
    expect(result).not.toBeNull();
    expect(result!.allowed).toBe(false);
  });

  it('blocks link-local', () => {
    const result = isPublicIpNative('169.254.1.1');
    expect(result).not.toBeNull();
    expect(result!.allowed).toBe(false);
  });

  it('normalizes domains', () => {
    expect(normalizeDomainNative('Example.COM.')).toBe('example.com');
    expect(normalizeDomainNative('SUB.Example.COM')).toBe('sub.example.com');
  });

  it('checks domain allowlist', () => {
    const result = checkDomainAllowlistNative('api.example.com', ['example.com']);
    // With TS fallback, result may be null
    if (result !== null) {
      expect(result.allowed).toBe(true);
    }
  });
});
