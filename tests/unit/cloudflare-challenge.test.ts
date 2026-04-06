import { describe, it, expect } from 'vitest';
import { isCloudflareChallengeSignal } from '../../src/shared/cloudflare-challenge.js';

describe('isCloudflareChallengeSignal', () => {
  // --- cf-mitigated header (existing behavior) ---

  it('returns true when cf-mitigated header is "challenge"', () => {
    expect(isCloudflareChallengeSignal({
      headers: { 'cf-mitigated': 'challenge' },
    })).toBe(true);
  });

  it('returns true when cf-mitigated header is "Challenge" (case-insensitive)', () => {
    expect(isCloudflareChallengeSignal({
      headers: { 'cf-mitigated': 'Challenge' },
    })).toBe(true);
  });

  // --- cf-challenge header (new signal) ---

  it('returns true when cf-challenge header is present', () => {
    expect(isCloudflareChallengeSignal({
      headers: { 'cf-challenge': '1' },
    })).toBe(true);
  });

  it('returns true when cf-challenge header is empty string', () => {
    expect(isCloudflareChallengeSignal({
      headers: { 'cf-challenge': '' },
    })).toBe(true);
  });

  it('returns true when CF-Challenge header uses different casing', () => {
    expect(isCloudflareChallengeSignal({
      headers: { 'CF-Challenge': 'abc' },
    })).toBe(true);
  });

  // --- cf-chl-bypass header (new signal) ---

  it('returns true when cf-chl-bypass header is present', () => {
    expect(isCloudflareChallengeSignal({
      headers: { 'cf-chl-bypass': '1' },
    })).toBe(true);
  });

  it('returns true when cf-chl-bypass header is empty string', () => {
    expect(isCloudflareChallengeSignal({
      headers: { 'cf-chl-bypass': '' },
    })).toBe(true);
  });

  it('returns true when CF-Chl-Bypass header uses different casing', () => {
    expect(isCloudflareChallengeSignal({
      headers: { 'CF-Chl-Bypass': 'token' },
    })).toBe(true);
  });

  // --- URL / location-based detection (existing behavior) ---

  it('returns true for cdn-cgi challenge-platform URL', () => {
    expect(isCloudflareChallengeSignal({
      url: 'https://example.com/cdn-cgi/challenge-platform/scripts/jsd/main.js',
    })).toBe(true);
  });

  it('returns true for cdn-cgi in location header', () => {
    expect(isCloudflareChallengeSignal({
      headers: { location: 'https://example.com/cdn-cgi/challenge-platform/h/g' },
    })).toBe(true);
  });

  // --- Content-based detection (existing behavior) ---

  it('returns true when content contains __cf_chl_ token', () => {
    expect(isCloudflareChallengeSignal({
      content: '<input name="__cf_chl_tk" value="abc">',
    })).toBe(true);
  });

  it('returns true for challenge text with cloudflare server header', () => {
    expect(isCloudflareChallengeSignal({
      headers: { server: 'cloudflare' },
      content: 'Just a moment...',
    })).toBe(true);
  });

  it('returns true for challenge text with cf-ray header', () => {
    expect(isCloudflareChallengeSignal({
      headers: { 'cf-ray': '12345' },
      content: 'Checking your browser before accessing',
    })).toBe(true);
  });

  // --- Negative cases ---

  it('returns false for empty signals', () => {
    expect(isCloudflareChallengeSignal({})).toBe(false);
  });

  it('returns false for normal page with no CF indicators', () => {
    expect(isCloudflareChallengeSignal({
      url: 'https://example.com/',
      headers: { server: 'nginx', 'content-type': 'text/html' },
      content: '<html><body>Hello</body></html>',
    })).toBe(false);
  });

  it('returns false for challenge text without cloudflare server/cf-ray', () => {
    expect(isCloudflareChallengeSignal({
      headers: { server: 'nginx' },
      content: 'Just a moment...',
    })).toBe(false);
  });

  it('returns false when headers is undefined', () => {
    expect(isCloudflareChallengeSignal({
      content: 'normal page',
    })).toBe(false);
  });
});
