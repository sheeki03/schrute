import { describe, it, expect } from 'vitest';
import {
  filterRequests,
  isObviousNoise,
  shouldCaptureResponseBody,
  isLearnableHost,
} from '../../src/capture/noise-filter.js';
import type { HarEntry } from '../../src/capture/har-extractor.js';

function makeEntry(overrides: Partial<{
  method: string;
  url: string;
  bodySize: number;
  postDataText: string;
  responseContentType: string;
  responseStatus: number;
  responseBodySize: number;
  startedDateTime: string;
}>): HarEntry {
  const {
    method = 'GET',
    url = 'https://api.example.com/data',
    bodySize = 0,
    postDataText,
    responseContentType = 'application/json',
    responseStatus = 200,
    responseBodySize = 100,
    startedDateTime = '2025-01-01T00:00:00Z',
  } = overrides;

  return {
    startedDateTime,
    time: 100,
    request: {
      method,
      url,
      httpVersion: 'HTTP/1.1',
      headers: [],
      queryString: [],
      headersSize: 0,
      bodySize,
      ...(postDataText ? { postData: { mimeType: 'application/json', text: postDataText } } : {}),
    },
    response: {
      status: responseStatus,
      statusText: 'OK',
      httpVersion: 'HTTP/1.1',
      headers: [{ name: 'content-type', value: responseContentType }],
      content: { size: responseBodySize, mimeType: responseContentType },
      redirectURL: '',
      headersSize: 0,
      bodySize: responseBodySize,
    },
    timings: { send: 0, wait: 50, receive: 50 },
  };
}

describe('noise-filter', () => {
  describe('isObviousNoise', () => {
    it('flags analytics domains as obvious noise', () => {
      expect(isObviousNoise(
        'https://api.segment.io/v1/track',
        'POST',
        200,
        'www.example.com',
      )).toEqual({ obvious: true, reason: 'analytics' });
    });

    it('flags static assets as obvious noise', () => {
      expect(isObviousNoise(
        'https://static.example.com/app.js',
        'GET',
        200,
        'www.example.com',
        'script',
      )).toEqual({ obvious: true, reason: 'static_asset' });
    });

    it('flags cloudflare challenge infrastructure as obvious noise', () => {
      expect(isObviousNoise(
        'https://challenges.cloudflare.com/turnstile/v0/api.js',
        'GET',
        200,
        'www.example.com',
      )).toEqual({ obvious: true, reason: 'cdn_infra' });
    });

    it('flags unrelated cross-origin requests as obvious noise', () => {
      expect(isObviousNoise(
        'https://tracker.evil.net/collect',
        'GET',
        200,
        'www.example.com',
      )).toEqual({ obvious: true, reason: 'cross_origin' });
    });

    it('flags websocket resource types as obvious noise', () => {
      expect(isObviousNoise(
        'wss://api.example.com/socket',
        'GET',
        101,
        'www.example.com',
        'websocket',
      )).toEqual({ obvious: true, reason: 'resource_type' });
    });

    it('allows same-root API subdomains', () => {
      expect(isObviousNoise(
        'https://api.example.com/users',
        'GET',
        200,
        'www.example.com',
        'fetch',
      )).toEqual({ obvious: false });
    });
  });

  describe('shouldCaptureResponseBody', () => {
    it('captures successful JSON responses', () => {
      expect(shouldCaptureResponseBody(
        'https://api.example.com/users',
        'GET',
        200,
        'application/json; charset=utf-8',
        'www.example.com',
        'fetch',
      )).toBe(true);
    });

    it('does not capture html responses', () => {
      expect(shouldCaptureResponseBody(
        'https://www.example.com/page',
        'GET',
        200,
        'text/html; charset=utf-8',
        'www.example.com',
        'document',
      )).toBe(false);
    });

    it('does not capture redirects', () => {
      expect(shouldCaptureResponseBody(
        'https://api.example.com/login',
        'POST',
        302,
        'application/json',
        'www.example.com',
        'fetch',
      )).toBe(false);
    });

    it('does not capture obvious noise even if the content is json', () => {
      expect(shouldCaptureResponseBody(
        'https://api.segment.io/v1/track',
        'POST',
        200,
        'application/json',
        'www.example.com',
        'fetch',
      )).toBe(false);
    });
  });

  describe('analytics domains', () => {
    it('filters segment.io', () => {
      const result = filterRequests([makeEntry({ url: 'https://api.segment.io/v1/track' })]);
      expect(result.noise).toHaveLength(1);
      expect(result.signal).toHaveLength(0);
    });

    it('filters google-analytics.com', () => {
      const result = filterRequests([makeEntry({ url: 'https://www.google-analytics.com/collect' })]);
      expect(result.noise).toHaveLength(1);
      expect(result.signal).toHaveLength(0);
    });
  });

  describe('feature flag domains', () => {
    it('filters launchdarkly.com', () => {
      const result = filterRequests([makeEntry({ url: 'https://app.launchdarkly.com/sdk/eval' })]);
      expect(result.noise).toHaveLength(1);
      expect(result.signal).toHaveLength(0);
    });
  });

  describe('static assets', () => {
    it('filters .js files', () => {
      const result = filterRequests([makeEntry({ url: 'https://cdn.example.com/app.js' })]);
      expect(result.noise).toHaveLength(1);
    });

    it('filters .css files', () => {
      const result = filterRequests([makeEntry({ url: 'https://cdn.example.com/style.css' })]);
      expect(result.noise).toHaveLength(1);
    });

    it('filters .png files', () => {
      const result = filterRequests([makeEntry({ url: 'https://cdn.example.com/logo.png' })]);
      expect(result.noise).toHaveLength(1);
    });

    it('filters .woff2 files', () => {
      const result = filterRequests([makeEntry({ url: 'https://cdn.example.com/font.woff2' })]);
      expect(result.noise).toHaveLength(1);
    });
  });

  describe('API calls', () => {
    it('passes through API GET calls', () => {
      const result = filterRequests([makeEntry({ url: 'https://api.example.com/users' })]);
      expect(result.signal).toHaveLength(1);
      expect(result.noise).toHaveLength(0);
    });

    it('passes through API POST calls', () => {
      const result = filterRequests([makeEntry({
        method: 'POST',
        url: 'https://api.example.com/users',
        bodySize: 50,
        postDataText: '{"name":"test"}',
      })]);
      expect(result.signal).toHaveLength(1);
    });
  });

  describe('tracking endpoint detection', () => {
    it('filters pixel.gif as tracking endpoint', () => {
      const result = filterRequests([makeEntry({ url: 'https://example.com/track/pixel.gif' })]);
      expect(result.noise).toHaveLength(1);
      expect(result.signal).toHaveLength(0);
    });

    it('filters /decision with small body as tracking endpoint', () => {
      const result = filterRequests([makeEntry({
        url: 'https://api.example.com/api/v1/decision/',
        responseBodySize: 100,
      })]);
      expect(result.noise).toHaveLength(1);
      expect(result.signal).toHaveLength(0);
    });

    it('does NOT filter /decision with large body (real API)', () => {
      const result = filterRequests([makeEntry({
        url: 'https://api.example.com/api/v1/decision/',
        responseBodySize: 500,
      })]);
      expect(result.noise).toHaveLength(0);
      expect(result.signal).toHaveLength(1);
    });

    it('filters 204 response to /collect as tracking endpoint', () => {
      const result = filterRequests([makeEntry({
        url: 'https://api.example.com/collect',
        responseStatus: 204,
        responseBodySize: 0,
      })]);
      expect(result.noise).toHaveLength(1);
      expect(result.signal).toHaveLength(0);
    });
  });

  describe('ambiguous requests', () => {
    it('classifies HTML content-type as ambiguous', () => {
      const result = filterRequests([makeEntry({
        url: 'https://example.com/page',
        responseContentType: 'text/html',
      })]);
      expect(result.ambiguous).toHaveLength(1);
      expect(result.signal).toHaveLength(0);
      expect(result.noise).toHaveLength(0);
    });
  });

  describe('isLearnableHost', () => {
    it('allows same-root subdomain (pro-api.coingecko.com)', () => {
      expect(isLearnableHost('pro-api.coingecko.com', 'www.coingecko.com')).toBe(true);
    });

    it('blocks entirely different domain (challenges.cloudflare.com)', () => {
      expect(isLearnableHost('challenges.cloudflare.com', 'www.coingecko.com')).toBe(false);
    });

    it('allows api subdomain', () => {
      expect(isLearnableHost('api.coingecko.com', 'www.coingecko.com')).toBe(true);
    });

    it('allows data subdomain', () => {
      expect(isLearnableHost('data.coingecko.com', 'www.coingecko.com')).toBe(true);
    });

    it('allows exact match', () => {
      expect(isLearnableHost('www.coingecko.com', 'www.coingecko.com')).toBe(true);
    });

    it('blocks google-analytics.com', () => {
      expect(isLearnableHost('google-analytics.com', 'www.coingecko.com')).toBe(false);
    });
  });

  describe('site-aware filterRequests', () => {
    it('classifies cross-origin cloudflare request as noise when siteHost provided', () => {
      const result = filterRequests(
        [makeEntry({ url: 'https://challenges.cloudflare.com/turnstile/v0/api.js' })],
        [],
        'www.coingecko.com',
      );
      expect(result.noise).toHaveLength(1);
      expect(result.signal).toHaveLength(0);
    });

    it('keeps same-site API request as signal when siteHost provided', () => {
      const result = filterRequests(
        [makeEntry({ url: 'https://www.coingecko.com/api/v3/coins' })],
        [],
        'www.coingecko.com',
      );
      expect(result.signal).toHaveLength(1);
      expect(result.noise).toHaveLength(0);
    });

    it('keeps same-root api subdomain as signal when siteHost provided', () => {
      const result = filterRequests(
        [makeEntry({ url: 'https://api.coingecko.com/api/v3/coins' })],
        [],
        'www.coingecko.com',
      );
      expect(result.signal).toHaveLength(1);
      expect(result.noise).toHaveLength(0);
    });

    it('does not filter cross-origin when siteHost is not provided', () => {
      const result = filterRequests(
        [makeEntry({ url: 'https://challenges.cloudflare.com/turnstile/v0/api.js' })],
      );
      // Without siteHost, Cloudflare is caught by CDN_INFRA domain list, not cross-origin
      expect(result.noise).toHaveLength(1);
    });

    it('site override takes priority over cross-origin gating', () => {
      const result = filterRequests(
        [makeEntry({ url: 'https://external-api.otherdomain.com/data' })],
        [{ domain: 'external-api.otherdomain.com', classification: 'signal' }],
        'www.coingecko.com',
      );
      // Override whitelists the non-same-root host — should NOT be classified as noise
      expect(result.signal).toHaveLength(1);
      expect(result.noise).toHaveLength(0);
    });
  });
});
