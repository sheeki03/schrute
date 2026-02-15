import { describe, it, expect } from 'vitest';
import { detectAuth } from '../../src/capture/auth-detector.js';
import type { StructuredRecord } from '../../src/capture/har-extractor.js';

// ─── Helpers ──────────────────────────────────────────────────────

function makeRecord(
  overrides: {
    reqHeaders?: Record<string, string>;
    queryParams?: Record<string, string>;
    url?: string;
    method?: string;
    body?: string;
    respStatus?: number;
    respHeaders?: Record<string, string>;
  } = {},
): StructuredRecord {
  return {
    request: {
      method: overrides.method ?? 'GET',
      url: overrides.url ?? 'https://api.example.com/data',
      headers: overrides.reqHeaders ?? {},
      queryParams: overrides.queryParams ?? {},
      body: overrides.body,
      contentType: overrides.body ? 'application/json' : undefined,
    },
    response: {
      status: overrides.respStatus ?? 200,
      statusText: 'OK',
      headers: overrides.respHeaders ?? {},
    },
    startedAt: Date.now(),
    duration: 50,
  };
}

// ─── Tests ────────────────────────────────────────────────────────

describe('auth-detector', () => {
  describe('detectAuth', () => {
    it('returns null for empty request list', () => {
      expect(detectAuth([])).toBeNull();
    });

    it('detects bearer token auth', () => {
      const records = [
        makeRecord({ reqHeaders: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig' } }),
        makeRecord({ reqHeaders: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig' } }),
      ];

      const recipe = detectAuth(records);
      expect(recipe).not.toBeNull();
      expect(recipe!.type).toBe('bearer');
      expect(recipe!.injection.location).toBe('header');
      expect(recipe!.injection.key).toBe('Authorization');
      expect(recipe!.injection.prefix).toBe('Bearer ');
    });

    it('detects API key in header', () => {
      const records = [
        makeRecord({ reqHeaders: { 'x-api-key': 'my-secret-key-123' } }),
        makeRecord({ reqHeaders: { 'x-api-key': 'my-secret-key-123' } }),
        makeRecord({ reqHeaders: { 'x-api-key': 'my-secret-key-123' } }),
      ];

      const recipe = detectAuth(records);
      expect(recipe).not.toBeNull();
      expect(recipe!.type).toBe('api_key');
      expect(recipe!.injection.location).toBe('header');
      expect(recipe!.injection.key).toBe('x-api-key');
    });

    it('detects API key in query param', () => {
      const records = [
        makeRecord({ queryParams: { api_key: 'secret123' } }),
        makeRecord({ queryParams: { api_key: 'secret123' } }),
        makeRecord({ queryParams: { api_key: 'secret123' } }),
      ];

      const recipe = detectAuth(records);
      expect(recipe).not.toBeNull();
      expect(recipe!.type).toBe('api_key');
      expect(recipe!.injection.location).toBe('query');
      expect(recipe!.injection.key).toBe('api_key');
    });

    it('detects cookie auth with session cookie', () => {
      const records = [
        makeRecord({ reqHeaders: { cookie: 'session=abc123; other=val' } }),
        makeRecord({ reqHeaders: { cookie: 'session=abc123; other=val' } }),
        makeRecord({ reqHeaders: { cookie: 'session=abc123; other=val' } }),
        makeRecord({ reqHeaders: { cookie: 'session=abc123; other=val' } }),
      ];

      const recipe = detectAuth(records);
      expect(recipe).not.toBeNull();
      expect(recipe!.type).toBe('cookie');
      expect(recipe!.injection.location).toBe('cookie');
    });

    it('detects cookie auth with PHPSESSID pattern', () => {
      const records = [
        makeRecord({ reqHeaders: { cookie: 'PHPSESSID=deadbeef123' } }),
        makeRecord({ reqHeaders: { cookie: 'PHPSESSID=deadbeef123' } }),
        makeRecord({ reqHeaders: { cookie: 'PHPSESSID=deadbeef123' } }),
        makeRecord({ reqHeaders: { cookie: 'PHPSESSID=deadbeef123' } }),
      ];

      const recipe = detectAuth(records);
      expect(recipe).not.toBeNull();
      expect(recipe!.type).toBe('cookie');
      expect(recipe!.injection.key).toBe('PHPSESSID');
    });

    it('detects OAuth2 pattern with token exchange + bearer', () => {
      const records = [
        makeRecord({
          method: 'POST',
          url: 'https://auth.example.com/oauth/token',
          body: 'grant_type=authorization_code&client_id=myapp',
          reqHeaders: {},
        }),
        makeRecord({ reqHeaders: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig' } }),
        makeRecord({ reqHeaders: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig' } }),
      ];

      const recipe = detectAuth(records);
      expect(recipe).not.toBeNull();
      expect(recipe!.type).toBe('oauth2');
      expect(recipe!.refreshMethod).toBe('oauth_refresh');
      expect(recipe!.refreshFlow).toBeDefined();
      expect(recipe!.refreshFlow!.url).toContain('oauth/token');
    });

    it('returns null when no auth patterns are detected', () => {
      const records = [
        makeRecord({ reqHeaders: { 'content-type': 'application/json' } }),
        makeRecord({ reqHeaders: { 'content-type': 'application/json' } }),
      ];

      expect(detectAuth(records)).toBeNull();
    });
  });

  describe('refresh trigger detection', () => {
    it('detects 401 refresh trigger', () => {
      const records = [
        makeRecord({ reqHeaders: { authorization: 'Bearer tok' }, respStatus: 401 }),
        makeRecord({ reqHeaders: { authorization: 'Bearer tok' } }),
      ];

      const recipe = detectAuth(records);
      expect(recipe).not.toBeNull();
      expect(recipe!.refreshTriggers).toContain('401');
    });

    it('detects 403 refresh trigger', () => {
      const records = [
        makeRecord({ reqHeaders: { authorization: 'Bearer tok' }, respStatus: 403 }),
        makeRecord({ reqHeaders: { authorization: 'Bearer tok' } }),
      ];

      const recipe = detectAuth(records);
      expect(recipe).not.toBeNull();
      expect(recipe!.refreshTriggers).toContain('403');
    });

    it('detects redirect_to_login trigger', () => {
      const records = [
        makeRecord({
          reqHeaders: { authorization: 'Bearer tok' },
          respStatus: 302,
          respHeaders: { location: 'https://example.com/login' },
        }),
        makeRecord({ reqHeaders: { authorization: 'Bearer tok' } }),
      ];

      const recipe = detectAuth(records);
      expect(recipe).not.toBeNull();
      expect(recipe!.refreshTriggers).toContain('redirect_to_login');
    });

    it('defaults to 401 trigger when no trigger signals found', () => {
      const records = [
        makeRecord({ reqHeaders: { authorization: 'Bearer tok' } }),
        makeRecord({ reqHeaders: { authorization: 'Bearer tok' } }),
      ];

      const recipe = detectAuth(records);
      expect(recipe).not.toBeNull();
      expect(recipe!.refreshTriggers).toContain('401');
    });
  });
});
