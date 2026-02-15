import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('../../src/capture/noise-filter.js', () => ({
  filterRequests: vi.fn().mockReturnValue({
    signal: [],
    noise: [],
    ambiguous: [],
  }),
  recordFilteredEntries: vi.fn().mockReturnValue({
    signal: [],
    noise: [],
    ambiguous: [],
  }),
}));

import {
  startFrame,
  addEntriesToFrame,
  stopFrame,
  getMainRequests,
  getInputsForFrame,
} from '../../src/capture/action-frame.js';
import type { HarEntry } from '../../src/capture/har-extractor.js';
import { filterRequests, recordFilteredEntries } from '../../src/capture/noise-filter.js';

// ─── Mock DB ──────────────────────────────────────────────────────

function makeMockDb() {
  return {
    run: vi.fn(),
    all: vi.fn().mockReturnValue([]),
    get: vi.fn(),
  };
}

function makeHarEntry(method = 'GET', url = 'https://api.example.com/data', status = 200): HarEntry {
  return {
    startedDateTime: new Date().toISOString(),
    time: 100,
    request: {
      method,
      url,
      httpVersion: 'HTTP/1.1',
      headers: [{ name: 'accept', value: 'application/json' }],
      queryString: [],
      headersSize: -1,
      bodySize: 0,
    },
    response: {
      status,
      statusText: 'OK',
      httpVersion: 'HTTP/1.1',
      headers: [],
      content: { size: 0, mimeType: 'application/json' },
      redirectURL: '',
      headersSize: -1,
      bodySize: 0,
    },
    timings: { send: 0, wait: 50, receive: 50 },
  };
}

// ─── Tests ────────────────────────────────────────────────────────

describe('action-frame', () => {
  let db: ReturnType<typeof makeMockDb>;

  beforeEach(() => {
    db = makeMockDb();
    vi.clearAllMocks();
  });

  describe('startFrame', () => {
    it('returns a UUID frame ID', () => {
      const frameId = startFrame(db as any, 'example.com', 'login-flow');
      expect(frameId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('inserts a row into the database', () => {
      startFrame(db as any, 'example.com', 'login-flow');
      expect(db.run).toHaveBeenCalledTimes(1);
      expect(db.run.mock.calls[0][0]).toContain('INSERT INTO action_frames');
    });

    it('stores inputs when provided', () => {
      const frameId = startFrame(db as any, 'example.com', 'search', { query: 'shoes' });
      const inputs = getInputsForFrame(frameId);
      expect(inputs).toEqual({ query: 'shoes' });
    });
  });

  describe('addEntriesToFrame', () => {
    it('adds entries to a live frame', () => {
      const frameId = startFrame(db as any, 'example.com', 'test');
      const entries = [makeHarEntry(), makeHarEntry('POST', 'https://api.example.com/submit')];

      addEntriesToFrame(frameId, entries);
      // Verify entries are stored by checking stopFrame uses them
      vi.mocked(recordFilteredEntries).mockReturnValueOnce({
        signal: entries,
        noise: [],
        ambiguous: [],
      } as any);

      const frame = stopFrame(db as any, frameId);
      expect(frame.requestCount).toBe(2);
    });

    it('silently ignores unknown frame IDs', () => {
      // Should not throw
      addEntriesToFrame('nonexistent-frame-id', [makeHarEntry()]);
    });
  });

  describe('stopFrame', () => {
    it('throws for unknown frame ID', () => {
      expect(() => stopFrame(db as any, 'nonexistent-frame-id'))
        .toThrow('No live frame with id nonexistent-frame-id');
    });

    it('returns an ActionFrame with correct fields', () => {
      const frameId = startFrame(db as any, 'example.com', 'checkout');
      addEntriesToFrame(frameId, [makeHarEntry()]);

      vi.mocked(recordFilteredEntries).mockReturnValueOnce({
        signal: [makeHarEntry()],
        noise: [],
        ambiguous: [],
      } as any);

      const frame = stopFrame(db as any, frameId);

      expect(frame.id).toBe(frameId);
      expect(frame.siteId).toBe('example.com');
      expect(frame.name).toBe('checkout');
      expect(frame.requestCount).toBe(1);
      expect(frame.signalCount).toBe(1);
      expect(frame.endedAt).toBeGreaterThanOrEqual(frame.startedAt);
      expect(typeof frame.qualityScore).toBe('number');
    });

    it('updates the database row on stop', () => {
      const frameId = startFrame(db as any, 'example.com', 'test');
      vi.mocked(recordFilteredEntries).mockReturnValueOnce({
        signal: [],
        noise: [],
        ambiguous: [],
      } as any);
      stopFrame(db as any, frameId);

      // First call is INSERT, second is UPDATE
      expect(db.run).toHaveBeenCalledTimes(2);
      expect(db.run.mock.calls[1][0]).toContain('UPDATE action_frames');
    });
  });

  describe('getInputsForFrame', () => {
    it('returns undefined for unknown frame', () => {
      expect(getInputsForFrame('nonexistent')).toBeUndefined();
    });

    it('returns inputs for a live frame', () => {
      const frameId = startFrame(db as any, 'example.com', 'test', { x: '1' });
      expect(getInputsForFrame(frameId)).toEqual({ x: '1' });
    });
  });

  describe('getMainRequests', () => {
    it('returns signal entries from a live frame', () => {
      const frameId = startFrame(db as any, 'example.com', 'test');
      const signalEntry = makeHarEntry('GET', 'https://api.example.com/users');
      addEntriesToFrame(frameId, [signalEntry]);

      vi.mocked(filterRequests).mockReturnValueOnce({
        signal: [signalEntry],
        noise: [],
        ambiguous: [],
      } as any);

      const requests = getMainRequests(db as any, frameId);
      expect(requests.length).toBe(1);
      expect(requests[0].classification).toBe('signal');
      expect(requests[0].url).toContain('/users');
    });

    it('queries DB for stopped frame', () => {
      db.all.mockReturnValueOnce([
        { request_hash: 'hash1', classification: 'signal' },
      ]);

      const requests = getMainRequests(db as any, 'stopped-frame-id');
      expect(db.all).toHaveBeenCalled();
      expect(requests).toHaveLength(1);
    });
  });
});
