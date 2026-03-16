import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NetworkRingBuffer } from '../../src/capture/network-ring-buffer.js';
import type { NetworkEntry } from '../../src/skill/types.js';

function makeEntry(url: string): NetworkEntry {
  return {
    url,
    method: 'GET',
    status: 200,
    requestHeaders: {},
    responseHeaders: {},
    timing: { startTime: 0, endTime: 0, duration: 0 },
  };
}

describe('NetworkRingBuffer', () => {
  it('stores and retrieves entries', () => {
    const buf = new NetworkRingBuffer();
    buf.push(makeEntry('https://example.com/a'));
    buf.push(makeEntry('https://example.com/b'));
    expect(buf.snapshot()).toHaveLength(2);
  });

  it('evicts by max count', () => {
    const buf = new NetworkRingBuffer({ maxEntries: 2, maxAgeMs: 60_000 });
    buf.push(makeEntry('https://example.com/1'));
    buf.push(makeEntry('https://example.com/2'));
    buf.push(makeEntry('https://example.com/3'));
    const snap = buf.snapshot();
    expect(snap).toHaveLength(2);
    expect(snap[0].url).toBe('https://example.com/2');
  });

  it('evicts by age', () => {
    vi.useFakeTimers();
    const buf = new NetworkRingBuffer({ maxEntries: 500, maxAgeMs: 100 });
    buf.push(makeEntry('https://example.com/old'));

    vi.advanceTimersByTime(200);
    const snap = buf.snapshot();
    expect(snap).toHaveLength(0);
    vi.useRealTimers();
  });

  it('snapshot with sinceMs filter', () => {
    vi.useFakeTimers({ now: 1000 });
    const buf = new NetworkRingBuffer({ maxEntries: 500, maxAgeMs: 60_000 });
    buf.push(makeEntry('https://example.com/old'));
    vi.advanceTimersByTime(5000);
    buf.push(makeEntry('https://example.com/new'));
    // Only get entries from last 3 seconds
    const snap = buf.snapshot(3000);
    expect(snap).toHaveLength(1);
    expect(snap[0].url).toBe('https://example.com/new');
    vi.useRealTimers();
  });

  it('clear empties the buffer', () => {
    const buf = new NetworkRingBuffer();
    buf.push(makeEntry('https://example.com/a'));
    buf.clear();
    expect(buf.size).toBe(0);
  });
});
