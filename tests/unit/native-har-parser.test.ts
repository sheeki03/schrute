import { describe, it, expect } from 'vitest';
import { extractRequestResponse } from '../../src/capture/har-extractor.js';
import type { HarEntry, HarData, StructuredRecord } from '../../src/capture/har-extractor.js';

// Import the native binding — will use TS fallback if Rust not compiled
import { parseHarNative } from '../../src/native/har-parser.js';

const FIXTURE_HAR: HarData = {
  log: {
    version: '1.2',
    creator: { name: 'test', version: '1.0' },
    entries: [
      {
        startedDateTime: '2024-01-15T12:00:00.000Z',
        time: 150,
        request: {
          method: 'GET',
          url: 'https://api.example.com/users?page=1',
          httpVersion: 'HTTP/1.1',
          headers: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Authorization', value: 'Bearer token123' },
          ],
          queryString: [{ name: 'page', value: '1' }],
          headersSize: -1,
          bodySize: 0,
        },
        response: {
          status: 200,
          statusText: 'OK',
          httpVersion: 'HTTP/1.1',
          headers: [{ name: 'Content-Type', value: 'application/json' }],
          content: {
            size: 42,
            mimeType: 'application/json',
            text: '{"users":[]}',
          },
          redirectURL: '',
          headersSize: -1,
          bodySize: 42,
        },
        timings: { send: 1, wait: 100, receive: 49 },
        serverIPAddress: '93.184.216.34',
      },
      {
        startedDateTime: '2024-01-15T12:00:01.000Z',
        time: 200,
        request: {
          method: 'POST',
          url: 'https://api.example.com/users',
          httpVersion: 'HTTP/1.1',
          headers: [{ name: 'Content-Type', value: 'application/json' }],
          queryString: [],
          postData: {
            mimeType: 'application/json',
            text: '{"name":"Alice"}',
          },
          headersSize: -1,
          bodySize: 16,
        },
        response: {
          status: 201,
          statusText: 'Created',
          httpVersion: 'HTTP/1.1',
          headers: [],
          content: {
            size: 30,
            mimeType: 'application/json',
            text: '{"id":1,"name":"Alice"}',
          },
          redirectURL: '',
          headersSize: -1,
          bodySize: 30,
        },
        timings: { send: 2, wait: 150, receive: 48 },
      },
    ],
  },
};

describe('native HAR parser (TS fallback)', () => {
  it('parses HAR and returns StructuredRecords', () => {
    const harJson = JSON.stringify(FIXTURE_HAR);
    const records = parseHarNative(harJson);

    expect(records).toHaveLength(2);
    expect(records[0].request.method).toBe('GET');
    expect(records[0].request.url).toBe('https://api.example.com/users?page=1');
    expect(records[0].response.status).toBe(200);
    expect(records[0].serverIp).toBe('93.184.216.34');
    expect(records[0].duration).toBe(150);
  });

  it('extracts headers as lowercase keyed map', () => {
    const harJson = JSON.stringify(FIXTURE_HAR);
    const records = parseHarNative(harJson);

    expect(records[0].request.headers['content-type']).toBe('application/json');
    expect(records[0].request.headers['authorization']).toBe('Bearer token123');
  });

  it('extracts query params', () => {
    const harJson = JSON.stringify(FIXTURE_HAR);
    const records = parseHarNative(harJson);

    expect(records[0].request.queryParams['page']).toBe('1');
  });

  it('extracts POST body and content type', () => {
    const harJson = JSON.stringify(FIXTURE_HAR);
    const records = parseHarNative(harJson);

    expect(records[1].request.body).toBe('{"name":"Alice"}');
    expect(records[1].request.contentType).toBe('application/json');
    expect(records[1].response.status).toBe(201);
  });

  it('matches TS extractRequestResponse output', () => {
    const harJson = JSON.stringify(FIXTURE_HAR);
    const nativeRecords = parseHarNative(harJson);
    const tsRecords = FIXTURE_HAR.log.entries.map(extractRequestResponse);

    // Compare structure (native may have slight timestamp differences due to parsing)
    expect(nativeRecords.length).toBe(tsRecords.length);

    for (let i = 0; i < nativeRecords.length; i++) {
      expect(nativeRecords[i].request.method).toBe(tsRecords[i].request.method);
      expect(nativeRecords[i].request.url).toBe(tsRecords[i].request.url);
      expect(nativeRecords[i].response.status).toBe(tsRecords[i].response.status);
      expect(nativeRecords[i].request.body).toBe(tsRecords[i].request.body);
      expect(nativeRecords[i].duration).toBe(tsRecords[i].duration);
    }
  });
});
