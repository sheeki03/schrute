import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock keytar-backed secrets store before importing redactor
vi.mock('../../src/storage/secrets.js', () => ({
  retrieve: vi.fn().mockResolvedValue('test-salt-0123456789abcdef0123456789abcdef'),
  store: vi.fn().mockResolvedValue(undefined),
}));

import {
  redactString,
  redactHeaders,
  redactBody,
  redactForOutput,
} from '../../src/storage/redactor.js';

describe('redactor', () => {
  describe('redactString', () => {
    it('strips email addresses', async () => {
      const result = await redactString('user@example.com');
      expect(result).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
      expect(result).not.toContain('user@example.com');
    });

    it('strips JWT tokens', async () => {
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456';
      const result = await redactString(jwt);
      expect(result).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
    });

    it('strips phone numbers', async () => {
      const result = await redactString('+1-555-123-4567');
      expect(result).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
    });

    it('strips UUIDs', async () => {
      const result = await redactString('550e8400-e29b-41d4-a716-446655440000');
      expect(result).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
    });

    it('strips MongoDB ObjectIds', async () => {
      const result = await redactString('507f1f77bcf86cd799439011');
      expect(result).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
    });

    it('strips AWS-style API keys', async () => {
      const result = await redactString('AKIAIOSFODNN7EXAMPLE');
      expect(result).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
    });

    it('strips generic API keys', async () => {
      const result = await redactString('api_key=sk_live_abc123def456ghi789jkl012');
      expect(result).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
    });

    it('preserves safe short values', async () => {
      expect(await redactString('true')).toBe('true');
      expect(await redactString('42')).toBe('42');
      expect(await redactString('active')).toBe('active');
    });

    it('masks long token-like strings that are not PII', async () => {
      // 25 chars -- long enough to trigger mask but not matching aws_secret (40 chars)
      const token = 'xK7mN2pQ9rT4wY6zA1cE3fG5h';
      const result = await redactString(token);
      // maskValue: first 2 chars + *** + last 2 chars
      expect(result).toBe('xK***5h');
    });
  });

  describe('redactHeaders', () => {
    it('strips Bearer tokens from Authorization header', async () => {
      const headers = { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig' };
      const result = await redactHeaders(headers);
      expect(result.Authorization).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
    });

    it('strips Cookie header values', async () => {
      const headers = { Cookie: 'session=abc123' };
      const result = await redactHeaders(headers);
      expect(result.Cookie).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
    });

    it('strips x-api-key header values', async () => {
      const headers = { 'x-api-key': 'sk_live_1234567890abcdef' };
      const result = await redactHeaders(headers);
      expect(result['x-api-key']).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
    });

    it('passes safe non-sensitive headers through', async () => {
      const headers = { 'content-type': 'application/json' };
      const result = await redactHeaders(headers);
      expect(result['content-type']).toBe('application/json');
    });
  });

  describe('redactBody', () => {
    it('redacts PII in JSON body', async () => {
      const body = JSON.stringify({ email: 'user@example.com', name: 'safe' });
      const result = await redactBody(body);
      const parsed = JSON.parse(result!);
      expect(parsed.email).toMatch(/^\[REDACTED:[a-f0-9]{12}\]$/);
      expect(parsed.name).toBe('safe');
    });

    it('returns undefined for undefined body', async () => {
      expect(await redactBody(undefined)).toBeUndefined();
    });
  });

  describe('redactForOutput', () => {
    it('agent-safe mode returns redacted output', async () => {
      const data = { email: 'user@example.com', count: 5 };
      const result = (await redactForOutput(data, 'agent-safe')) as Record<string, unknown>;
      expect(result.email).toMatch(/^\[REDACTED:/);
      expect(result.count).toBe(5);
    });

    it('developer-debug mode includes type traces but still redacted', async () => {
      const data = 'user@example.com';
      const result = await redactForOutput(data, 'developer-debug');
      expect(result).toMatch(/\[REDACTED:[a-f0-9]{12}\]/);
      expect(result).toMatch(/\[was:email\]/);
      expect(result).not.toContain('user@example.com');
    });

    it('developer-debug mode passes non-PII strings through', async () => {
      const result = await redactForOutput('hello world', 'developer-debug');
      expect(result).toBe('hello world');
    });
  });

  describe('fail-closed timeout', () => {
    it('timeout parameter is accepted by redactString', async () => {
      // Verify that the function accepts a timeout parameter and still
      // processes correctly when given adequate time
      const result = await redactString('user@example.com', 5000);
      expect(result).toMatch(/^\[REDACTED:/);
    });

    it('timeout parameter is accepted by redactHeaders', async () => {
      const result = await redactHeaders({ Authorization: 'Bearer tok' }, 5000);
      expect(result.Authorization).toMatch(/^\[REDACTED:/);
    });

    it('timeout parameter is accepted by redactBody', async () => {
      const body = JSON.stringify({ email: 'user@example.com' });
      const result = await redactBody(body, 5000);
      expect(result).toBeDefined();
      const parsed = JSON.parse(result!);
      expect(parsed.email).toMatch(/^\[REDACTED:/);
    });
  });
});
