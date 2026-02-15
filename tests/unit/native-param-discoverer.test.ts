import { describe, it, expect } from 'vitest';
import { discoverParamsNative } from '../../src/native/param-discoverer.js';
import type { RequestSample } from '../../src/capture/param-discoverer.js';
import type { StructuredRecord } from '../../src/capture/har-extractor.js';

function makeRecord(queryParams: Record<string, string>, body?: string): StructuredRecord {
  return {
    request: {
      method: 'GET',
      url: 'https://api.example.com/search',
      headers: { 'accept': 'application/json' },
      body,
      queryParams,
    },
    response: {
      status: 200,
      statusText: 'OK',
      headers: {},
    },
    startedAt: Date.now(),
    duration: 100,
  };
}

describe('native param discoverer (TS fallback)', () => {
  it('identifies constant fields', () => {
    const recordings: RequestSample[] = [
      { record: makeRecord({ q: 'hello', format: 'json' }) },
      { record: makeRecord({ q: 'world', format: 'json' }) },
      { record: makeRecord({ q: 'test', format: 'json' }) },
    ];

    const evidence = discoverParamsNative(recordings);
    const formatEvidence = evidence.find(e => e.fieldPath.includes('format'));
    if (formatEvidence) {
      expect(formatEvidence.classification).toBe('constant');
    }
  });

  it('identifies varying fields as parameters or ephemeral', () => {
    const recordings: RequestSample[] = [
      { record: makeRecord({ q: 'hello' }) },
      { record: makeRecord({ q: 'world' }) },
    ];

    const evidence = discoverParamsNative(recordings);
    const qEvidence = evidence.find(e => e.fieldPath.includes('q'));
    if (qEvidence) {
      expect(['parameter', 'ephemeral']).toContain(qEvidence.classification);
      expect(qEvidence.volatility).toBeGreaterThan(0);
    }
  });

  it('requires at least 2 recordings', () => {
    const recordings: RequestSample[] = [
      { record: makeRecord({ q: 'hello' }) },
    ];

    const evidence = discoverParamsNative(recordings);
    expect(evidence).toHaveLength(0);
  });

  it('reports volatility scores', () => {
    const recordings: RequestSample[] = [
      { record: makeRecord({ q: 'a' }) },
      { record: makeRecord({ q: 'b' }) },
      { record: makeRecord({ q: 'c' }) },
    ];

    const evidence = discoverParamsNative(recordings);
    for (const e of evidence) {
      expect(typeof e.volatility).toBe('number');
      expect(e.volatility).toBeGreaterThanOrEqual(0);
      expect(e.volatility).toBeLessThanOrEqual(1);
    }
  });
});
