import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tlsFetch, isCycleTlsAvailable, _resetForTest } from '../../src/replay/tls-client.js';
import type { SealedFetchRequest } from '../../src/skill/types.js';

function makeRequest(overrides: Partial<SealedFetchRequest> = {}): SealedFetchRequest {
  return {
    url: 'https://api.example.com/data',
    method: 'GET',
    headers: { 'accept': 'application/json' },
    ...overrides,
  };
}

describe('tls-client', () => {
  beforeEach(() => {
    _resetForTest();
  });

  describe('tlsFetch with native fetch fallback', () => {
    it('falls back to native fetch when CycleTLS is unavailable', async () => {
      const mockResponse = new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

      const result = await tlsFetch(makeRequest());

      expect(result.status).toBe(200);
      expect(result.body).toContain('"ok"');
      expect(isCycleTlsAvailable()).toBe(false);

      vi.restoreAllMocks();
    });

    it('passes user-agent from options', async () => {
      const mockResponse = new Response('ok', { status: 200 });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

      await tlsFetch(makeRequest(), { userAgent: 'TestBot/1.0' });

      const calledHeaders = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
      expect(calledHeaders['user-agent']).toBe('TestBot/1.0');

      vi.restoreAllMocks();
    });

    it('passes timeout option to AbortController', async () => {
      const mockResponse = new Response('ok', { status: 200 });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

      await tlsFetch(makeRequest(), { timeout: 5000 });

      // Verify fetch was called with an abort signal
      const callArgs = fetchSpy.mock.calls[0][1];
      expect(callArgs?.signal).toBeDefined();

      vi.restoreAllMocks();
    });

    it('handles POST requests with body', async () => {
      const body = JSON.stringify({ key: 'value' });
      const mockResponse = new Response('created', { status: 201 });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

      const result = await tlsFetch(
        makeRequest({ method: 'POST', body }),
      );

      expect(result.status).toBe(201);
      expect(fetchSpy.mock.calls[0][1]?.method).toBe('POST');

      vi.restoreAllMocks();
    });
  });

  describe('isCycleTlsAvailable', () => {
    it('returns false before any fetch', () => {
      expect(isCycleTlsAvailable()).toBe(false);
    });

    it('returns false after a fetch that fell back to native', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('ok'));
      await tlsFetch(makeRequest());
      expect(isCycleTlsAvailable()).toBe(false);
      vi.restoreAllMocks();
    });
  });
});
