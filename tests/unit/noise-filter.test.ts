import { describe, it, expect } from 'vitest';
import { filterRequests } from '../../src/capture/noise-filter.js';
import type { HarEntry } from '../../src/capture/har-extractor.js';

function makeEntry(overrides: Partial<{
  method: string;
  url: string;
  bodySize: number;
  postDataText: string;
  responseContentType: string;
  startedDateTime: string;
}>): HarEntry {
  const {
    method = 'GET',
    url = 'https://api.example.com/data',
    bodySize = 0,
    postDataText,
    responseContentType = 'application/json',
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
      status: 200,
      statusText: 'OK',
      httpVersion: 'HTTP/1.1',
      headers: [{ name: 'content-type', value: responseContentType }],
      content: { size: 100, mimeType: responseContentType },
      redirectURL: '',
      headersSize: 0,
      bodySize: 100,
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
