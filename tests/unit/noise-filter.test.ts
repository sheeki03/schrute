import { describe, it, expect } from 'vitest';
import { filterRequests } from '../../src/capture/noise-filter.js';
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
});
