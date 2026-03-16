import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SchruteClient, SchruteError } from '../../src/client/typescript/index.js';

// ─── Mock fetch ─────────────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
    headers: new Headers(),
  } as unknown as Response;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('SchruteClient', () => {
  const client = new SchruteClient({ baseUrl: 'http://localhost:3000' });

  describe('constructor', () => {
    it('strips trailing slash from baseUrl', () => {
      const c = new SchruteClient({ baseUrl: 'http://localhost:3000/' });
      mockFetch.mockResolvedValueOnce(mockResponse({ status: 'ok' }));
      c.getHealth();
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/health',
        expect.anything(),
      );
    });

    it('adds Authorization header when apiKey is provided', () => {
      const c = new SchruteClient({
        baseUrl: 'http://localhost:3000',
        apiKey: 'test-key',
      });
      mockFetch.mockResolvedValueOnce(mockResponse({ status: 'ok' }));
      c.getHealth();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-key',
          }),
        }),
      );
    });
  });

  describe('listSites', () => {
    it('returns array of sites', async () => {
      const sites = [
        { id: 'example.com', masteryLevel: 'explore', totalRequests: 10 },
      ];
      mockFetch.mockResolvedValueOnce(mockResponse(sites));

      const result = await client.listSites();
      expect(result).toEqual(sites);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/sites',
        expect.objectContaining({ method: 'GET' }),
      );
    });
  });

  describe('getSite', () => {
    it('fetches a single site by ID', async () => {
      const site = { id: 'example.com', masteryLevel: 'full' };
      mockFetch.mockResolvedValueOnce(mockResponse(site));

      const result = await client.getSite('example.com');
      expect(result).toEqual(site);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/sites/example.com',
        expect.anything(),
      );
    });

    it('throws SchruteError on 404', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ error: "Site 'unknown' not found" }, 404),
      );

      try {
        await client.getSite('unknown');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(SchruteError);
        expect((err as SchruteError).statusCode).toBe(404);
        expect((err as SchruteError).message).toBe("Site 'unknown' not found");
      }
    });
  });

  describe('listSkills', () => {
    it('fetches skills for a site', async () => {
      const skills = [
        { id: 'example.com.getUser.v1', name: 'getUser', status: 'active' },
      ];
      mockFetch.mockResolvedValueOnce(mockResponse(skills));

      const result = await client.listSkills('example.com');
      expect(result).toEqual(skills);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/sites/example.com/skills',
        expect.anything(),
      );
    });

    it('adds status query param when provided', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse([]));

      await client.listSkills('example.com', 'active');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/sites/example.com/skills?status=active',
        expect.anything(),
      );
    });
  });

  describe('executeSkill', () => {
    it('posts to the skill execution endpoint', async () => {
      const response = { success: true, data: { result: 'ok' } };
      mockFetch.mockResolvedValueOnce(mockResponse(response));

      const result = await client.executeSkill('example.com', 'getUser', {
        userId: '123',
      });
      expect(result).toEqual(response);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/sites/example.com/skills/getUser',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ params: { userId: '123' } }),
        }),
      );
    });
  });

  describe('dryRun', () => {
    it('posts to the dry-run endpoint', async () => {
      const response = {
        method: 'GET',
        url: 'https://api.example.com/user/123',
        headers: {},
        sideEffectClass: 'read-only',
        currentTier: 'tier_1',
        note: 'This is a preview only.',
      };
      mockFetch.mockResolvedValueOnce(mockResponse(response));

      const result = await client.dryRun('example.com', 'getUser', {
        userId: '123',
      });
      expect(result.note).toContain('preview');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/sites/example.com/skills/getUser/dry-run',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('validate', () => {
    it('posts to the validate endpoint', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ success: true }),
      );

      const result = await client.validate('example.com', 'getUser');
      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/sites/example.com/skills/getUser/validate',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('explore', () => {
    it('posts URL to the explore endpoint', async () => {
      const response = { siteId: 'example.com', sources: [], endpoints: [] };
      mockFetch.mockResolvedValueOnce(mockResponse(response));

      const result = await client.explore('https://example.com');
      expect(result.siteId).toBe('example.com');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/explore',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ url: 'https://example.com' }),
        }),
      );
    });
  });

  describe('record', () => {
    it('starts a recording session', async () => {
      const response = { frameId: 'f1', name: 'login', siteId: 'example.com' };
      mockFetch.mockResolvedValueOnce(mockResponse(response));

      const result = await client.record('login', { username: 'test' });
      expect(result.name).toBe('login');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/record',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'login', inputs: { username: 'test' } }),
        }),
      );
    });
  });

  describe('stop', () => {
    it('stops recording', async () => {
      const response = { frameId: 'f1', skills: [] };
      mockFetch.mockResolvedValueOnce(mockResponse(response));

      const result = await client.stop();
      expect(result.frameId).toBe('f1');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/stop',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('getHealth', () => {
    it('returns health status', async () => {
      const response = { status: 'ok', uptime: 1234, mode: 'idle' };
      mockFetch.mockResolvedValueOnce(mockResponse(response));

      const result = await client.getHealth();
      expect(result.status).toBe('ok');
    });
  });

  describe('getOpenApiSpec', () => {
    it('returns OpenAPI spec', async () => {
      const spec = { openapi: '3.1.0', info: { title: 'Schrute API' } };
      mockFetch.mockResolvedValueOnce(mockResponse(spec));

      const result = await client.getOpenApiSpec();
      expect(result).toHaveProperty('openapi', '3.1.0');
    });
  });

  describe('error handling', () => {
    it('throws SchruteError with status code and body', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ error: 'Server error' }, 500),
      );

      try {
        await client.getHealth();
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(SchruteError);
        const oaErr = err as SchruteError;
        expect(oaErr.statusCode).toBe(500);
        expect(oaErr.message).toBe('Server error');
        expect(oaErr.body).toEqual({ error: 'Server error' });
      }
    });

    it('handles non-JSON error responses', async () => {
      const resp = {
        ok: false,
        status: 502,
        text: async () => 'Bad Gateway',
        headers: new Headers(),
      } as unknown as Response;
      mockFetch.mockResolvedValueOnce(resp);

      try {
        await client.getHealth();
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(SchruteError);
        expect((err as SchruteError).statusCode).toBe(502);
      }
    });
  });
});
