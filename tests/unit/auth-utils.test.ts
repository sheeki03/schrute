import { describe, it, expect } from 'vitest';
import { verifyBearerToken } from '../../src/shared/auth-utils.js';
import type { IncomingMessage } from 'node:http';

function fakeReq(authorization?: string): IncomingMessage {
  return { headers: { ...(authorization !== undefined ? { authorization } : {}) } } as unknown as IncomingMessage;
}

describe('verifyBearerToken', () => {
  const TOKEN = 'test-secret-token-12345';

  it('returns true for a valid Bearer token', () => {
    expect(verifyBearerToken(fakeReq(`Bearer ${TOKEN}`), TOKEN)).toBe(true);
  });

  it('returns false when authorization header is missing', () => {
    expect(verifyBearerToken(fakeReq(), TOKEN)).toBe(false);
  });

  it('returns false for a malformed header (no Bearer prefix)', () => {
    expect(verifyBearerToken(fakeReq(TOKEN), TOKEN)).toBe(false);
  });

  it('returns false for the wrong token', () => {
    expect(verifyBearerToken(fakeReq('Bearer wrong-token'), TOKEN)).toBe(false);
  });

  it('returns false when token lengths differ (timing-safe guard)', () => {
    expect(verifyBearerToken(fakeReq('Bearer short'), TOKEN)).toBe(false);
  });

  it('handles case-insensitive Bearer prefix', () => {
    expect(verifyBearerToken(fakeReq(`bearer ${TOKEN}`), TOKEN)).toBe(true);
    expect(verifyBearerToken(fakeReq(`BEARER ${TOKEN}`), TOKEN)).toBe(true);
    expect(verifyBearerToken(fakeReq(`BeArEr ${TOKEN}`), TOKEN)).toBe(true);
  });
});
