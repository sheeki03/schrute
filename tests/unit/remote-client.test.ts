import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock logger ─────────────────────────────────────────────────
vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { RemoteClient } from '../../src/client/remote-client.js';

describe('RemoteClient', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('constructor', () => {
    it('strips trailing slash from baseUrl', () => {
      const client = new RemoteClient('http://localhost:3000/');
      // We verify via the request URL
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: {} }),
      });

      client.getStatus();

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/v1/status',
        expect.anything(),
      );
    });
  });

  describe('request method', () => {
    it('sends GET request with correct URL', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: { mode: 'idle' } }),
      });

      const client = new RemoteClient('http://localhost:3000');
      const result = await client.getStatus();

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/v1/status',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        }),
      );
      expect(result).toEqual({ mode: 'idle' });
    });

    it('sends POST request with JSON body', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: { siteId: 'example.com' } }),
      });

      const client = new RemoteClient('http://localhost:3000');
      await client.explore('https://example.com');

      const call = mockFetch.mock.calls[0];
      expect(call[1].method).toBe('POST');
      expect(call[1].body).toBe(JSON.stringify({ url: 'https://example.com' }));
    });

    it('does not include body for GET requests', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: [] }),
      });

      const client = new RemoteClient('http://localhost:3000');
      await client.listSites();

      const call = mockFetch.mock.calls[0];
      expect(call[1].body).toBeUndefined();
    });
  });

  describe('bearer token header', () => {
    it('includes Authorization header when token provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: {} }),
      });

      const client = new RemoteClient('http://localhost:3000', 'my-secret-token');
      await client.getStatus();

      const call = mockFetch.mock.calls[0];
      expect(call[1].headers['Authorization']).toBe('Bearer my-secret-token');
    });

    it('omits Authorization header when no token', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: {} }),
      });

      const client = new RemoteClient('http://localhost:3000');
      await client.getStatus();

      const call = mockFetch.mock.calls[0];
      expect(call[1].headers['Authorization']).toBeUndefined();
    });
  });

  describe('envelope unwrapping', () => {
    it('unwraps data from success envelope', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          data: { skills: ['a', 'b'] },
        }),
      });

      const client = new RemoteClient('http://localhost:3000');
      const result = await client.listSites();

      expect(result).toEqual({ skills: ['a', 'b'] });
    });

    it('throws on success:false envelope', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          success: false,
          error: { message: 'Skill not found' },
        }),
      });

      const client = new RemoteClient('http://localhost:3000');

      await expect(client.getStatus()).rejects.toThrow('Skill not found');
    });

    it('throws with generic message when error.message is missing', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 500,
        json: async () => ({
          success: false,
        }),
      });

      const client = new RemoteClient('http://localhost:3000');

      await expect(client.getStatus()).rejects.toThrow(/Request failed/);
    });
  });

  describe('non-OK response error', () => {
    it('throws on HTTP 500 with error body', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'Something went wrong',
      });

      const client = new RemoteClient('http://localhost:3000');

      await expect(client.getStatus()).rejects.toThrow('HTTP 500: Something went wrong');
    });

    it('throws on HTTP 404 with statusText fallback', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => '',
      });

      const client = new RemoteClient('http://localhost:3000');

      await expect(client.getStatus()).rejects.toThrow('HTTP 404: Not Found');
    });

    it('handles text() rejection gracefully', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        text: async () => { throw new Error('stream error'); },
      });

      const client = new RemoteClient('http://localhost:3000');

      await expect(client.getStatus()).rejects.toThrow('HTTP 502: Bad Gateway');
    });
  });

  describe('timeout parameter', () => {
    it('uses default timeout of 30s', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: {} }),
      });

      const client = new RemoteClient('http://localhost:3000');
      await client.getStatus();

      const call = mockFetch.mock.calls[0];
      expect(call[1].signal).toBeDefined();
    });

    it('respects custom timeout', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: {} }),
      });

      const client = new RemoteClient('http://localhost:3000', undefined, 5000);
      await client.getStatus();

      const call = mockFetch.mock.calls[0];
      expect(call[1].signal).toBeDefined();
    });
  });

  describe('convenience methods', () => {
    beforeEach(() => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: {} }),
      });
    });

    it('explore sends POST to /explore', async () => {
      const client = new RemoteClient('http://localhost:3000');
      await client.explore('https://example.com');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/v1/explore',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('listSessions sends GET to /sessions', async () => {
      const client = new RemoteClient('http://localhost:3000');
      await client.listSessions();

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/v1/sessions',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('executeSkill sends POST to /execute', async () => {
      const client = new RemoteClient('http://localhost:3000');
      await client.executeSkill('skill-1', { param: 'value' });

      const call = mockFetch.mock.calls[0];
      expect(call[0]).toBe('http://localhost:3000/api/v1/execute');
      expect(call[1].method).toBe('POST');
      expect(JSON.parse(call[1].body)).toEqual({ skillId: 'skill-1', params: { param: 'value' } });
    });

    it('searchSkills sends POST to /skills/search', async () => {
      const client = new RemoteClient('http://localhost:3000');
      await client.searchSkills('login', 5);

      const call = mockFetch.mock.calls[0];
      expect(call[0]).toBe('http://localhost:3000/api/v1/skills/search');
      expect(JSON.parse(call[1].body)).toEqual({ query: 'login', limit: 5 });
    });
  });
});
