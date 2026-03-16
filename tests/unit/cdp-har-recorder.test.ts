import { describe, it, expect, beforeEach } from 'vitest';
import { CdpHarRecorder } from '../../src/capture/cdp-har-recorder.js';
import type { NetworkEntry } from '../../src/skill/types.js';

describe('CdpHarRecorder', () => {
  let recorder: CdpHarRecorder;

  beforeEach(() => {
    recorder = new CdpHarRecorder();
  });

  function makeNetworkEntry(overrides?: Partial<NetworkEntry>): NetworkEntry {
    return {
      url: 'https://api.example.com/users',
      method: 'GET',
      status: 200,
      requestHeaders: { 'accept': 'application/json' },
      responseHeaders: { 'content-type': 'application/json' },
      requestBody: undefined,
      responseBody: '{"users":[]}',
      timing: {
        startTime: Date.now(),
        endTime: Date.now() + 100,
        duration: 100,
      },
      ...overrides,
    };
  }

  it('starts and stops recording', async () => {
    expect(recorder.isRecording()).toBe(false);
    recorder.start();
    expect(recorder.isRecording()).toBe(true);
    const har = await recorder.stop();
    expect(recorder.isRecording()).toBe(false);
    expect(har.version).toBe('1.2');
    expect(har.entries).toHaveLength(0);
  });

  it('ingests network entries and converts to HAR', async () => {
    recorder.start();
    recorder.ingestNetworkEntries([makeNetworkEntry()]);
    const har = await recorder.stop();

    expect(har.entries).toHaveLength(1);
    expect(har.entries[0].request.method).toBe('GET');
    expect(har.entries[0].request.url).toBe('https://api.example.com/users');
    expect(har.entries[0].response.status).toBe(200);
  });

  it('ignores entries when not recording', async () => {
    recorder.ingestNetworkEntries([makeNetworkEntry()]);
    recorder.start();
    const har = await recorder.stop();
    expect(har.entries).toHaveLength(0);
  });

  it('converts POST with body', async () => {
    recorder.start();
    recorder.ingestNetworkEntries([
      makeNetworkEntry({
        method: 'POST',
        requestBody: '{"name":"test"}',
        url: 'https://api.example.com/users',
        status: 201,
      }),
    ]);
    const har = await recorder.stop();

    expect(har.entries[0].request.method).toBe('POST');
    expect(har.entries[0].request.postData?.text).toBe('{"name":"test"}');
    expect(har.entries[0].response.status).toBe(201);
  });

  it('parses query string from URL', async () => {
    recorder.start();
    recorder.ingestNetworkEntries([
      makeNetworkEntry({ url: 'https://api.example.com/users?page=1&limit=10' }),
    ]);
    const har = await recorder.stop();

    expect(har.entries[0].request.queryString).toEqual([
      { name: 'page', value: '1' },
      { name: 'limit', value: '10' },
    ]);
  });

  it('handles multiple entries', async () => {
    recorder.start();
    recorder.ingestNetworkEntries([
      makeNetworkEntry({ url: 'https://api.example.com/users' }),
      makeNetworkEntry({ url: 'https://api.example.com/posts', method: 'POST' }),
    ]);
    const har = await recorder.stop();
    expect(har.entries).toHaveLength(2);
  });

  it('returns direct structured records and auditable entries', async () => {
    recorder.start();
    recorder.ingestNetworkEntries([
      makeNetworkEntry({
        method: 'POST',
        url: 'https://api.example.com/users?page=1',
        requestBody: '{"name":"alice"}',
        responseBody: '{"id":"u_123"}',
        status: 201,
      }),
    ]);

    const result = await recorder.stopAsStructuredRecords();

    expect(result.totalCount).toBe(1);
    expect(result.records).toHaveLength(1);
    expect(result.auditEntries).toHaveLength(1);

    expect(result.records[0].request.method).toBe('POST');
    expect(result.records[0].request.queryParams).toEqual({ page: '1' });
    expect(result.records[0].request.body).toBe('{"name":"alice"}');
    expect(result.records[0].response.status).toBe(201);

    expect(result.auditEntries[0].request.method).toBe('POST');
    expect(result.auditEntries[0].request.postData?.text).toBe('{"name":"alice"}');
    expect(result.auditEntries[0].response.status).toBe(201);
    expect(result.auditEntries[0].response.content.mimeType).toBe('application/json');
  });
});
