import { describe, it, expect } from 'vitest';
import { filterRequestsNative } from '../../src/native/noise-filter.js';
import type { HarEntry } from '../../src/capture/har-extractor.js';

function makeEntry(url: string, method = 'GET', bodySize = 0): HarEntry {
  return {
    startedDateTime: '2024-01-15T12:00:00.000Z',
    time: 100,
    request: {
      method,
      url,
      httpVersion: 'HTTP/1.1',
      headers: [],
      queryString: [],
      headersSize: -1,
      bodySize,
    },
    response: {
      status: 200,
      statusText: 'OK',
      httpVersion: 'HTTP/1.1',
      headers: [{ name: 'content-type', value: 'application/json' }],
      content: { size: 10, mimeType: 'application/json' },
      redirectURL: '',
      headersSize: -1,
      bodySize: 10,
    },
    timings: { send: 1, wait: 50, receive: 49 },
  };
}

describe('native noise filter (TS fallback)', () => {
  it('classifies analytics domains as noise', () => {
    const entries = [
      makeEntry('https://api.example.com/data'),
      makeEntry('https://google-analytics.com/collect'),
      makeEntry('https://segment.io/v1/track'),
    ];

    const result = filterRequestsNative(entries);
    expect(result.signal.length).toBe(1);
    expect(result.noise.length).toBe(2);
  });

  it('classifies static assets as noise', () => {
    const entries = [
      makeEntry('https://cdn.example.com/app.js'),
      makeEntry('https://cdn.example.com/style.css'),
      makeEntry('https://api.example.com/data'),
    ];

    const result = filterRequestsNative(entries);
    expect(result.noise.length).toBe(2);
    expect(result.signal.length).toBe(1);
  });

  it('classifies feature flag domains as noise', () => {
    const entries = [
      makeEntry('https://launchdarkly.com/api/eval'),
      makeEntry('https://api.example.com/data'),
    ];

    const result = filterRequestsNative(entries);
    expect(result.noise.length).toBe(1);
    expect(result.signal.length).toBe(1);
  });

  it('handles site overrides', () => {
    const entries = [
      makeEntry('https://custom-analytics.com/collect'),
    ];

    const result = filterRequestsNative(entries, [
      { domain: 'custom-analytics.com', classification: 'noise' },
    ]);
    expect(result.noise.length).toBe(1);
  });

  it('returns empty arrays for empty input', () => {
    const result = filterRequestsNative([]);
    expect(result.signal).toHaveLength(0);
    expect(result.noise).toHaveLength(0);
    expect(result.ambiguous).toHaveLength(0);
  });
});
