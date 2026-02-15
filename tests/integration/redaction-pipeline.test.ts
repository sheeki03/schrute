import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  redactString,
  redactBody,
  redactHeaders,
  redactForOutput,
} from '../../src/storage/redactor.js';

// Mock the secrets store to avoid keytar dependency
vi.mock('../../src/storage/secrets.js', () => ({
  retrieve: async () => 'test-salt-value-for-redaction',
  store: async () => {},
}));

describe('redaction pipeline integration', () => {
  it('strips email PII in agent-safe mode', async () => {
    const input = 'Contact john.doe@example.com for details';
    const result = await redactString(input);
    // The email should be detected and redacted
    expect(result).toContain('[REDACTED:');
    expect(result).not.toContain('john.doe@example.com');
  });

  it('strips SSN patterns', async () => {
    const input = 'SSN: 123-45-6789';
    const result = await redactString(input);
    expect(result).toContain('[REDACTED:');
    expect(result).not.toContain('123-45-6789');
  });

  it('strips JWT tokens', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMiLCJleHAiOjE3MzcwMjAwMDB9.fake-sig';
    const result = await redactString(jwt);
    expect(result).toContain('[REDACTED:');
    expect(result).not.toContain(jwt);
  });

  it('preserves safe values like short integers and booleans', async () => {
    expect(await redactString('42')).toBe('42');
    expect(await redactString('true')).toBe('true');
    expect(await redactString('false')).toBe('false');
    expect(await redactString('active')).toBe('active');
  });

  it('redacts PII from JSON body', async () => {
    const body = JSON.stringify({
      name: 'Alice Johnson',
      email: 'alice@example.com',
      role: 'admin',
      ssn: '123-45-6789',
      id: 42,
    });

    const result = await redactBody(body);
    expect(result).toBeDefined();
    const parsed = JSON.parse(result!);

    // Email should be redacted
    expect(parsed.email).toContain('[REDACTED:');
    // SSN should be redacted
    expect(parsed.ssn).toContain('[REDACTED:');
    // Numeric values should be preserved
    expect(parsed.id).toBe(42);
    // Role is a short enum-like string, should be preserved
    expect(parsed.role).toBe('admin');
  });

  it('redacts sensitive headers', async () => {
    const headers = {
      'content-type': 'application/json',
      'authorization': 'Bearer some-secret-token',
      'x-api-key': 'sk-1234567890abcdef',
      'accept': 'application/json',
    };

    const result = await redactHeaders(headers);

    // authorization should be redacted (it is in the sensitive headers set)
    expect(result['authorization']).toContain('[REDACTED:');
    // x-api-key should be redacted
    expect(result['x-api-key']).toContain('[REDACTED:');
    // content-type should be preserved (safe)
    expect(result['content-type']).toBe('application/json');
    // accept should be preserved
    expect(result['accept']).toBe('application/json');
  });

  it('agent-safe mode fully strips PII from structured data', async () => {
    const data = {
      users: [
        { id: 1, name: 'admin', email: 'admin@company.com' },
        { id: 2, name: 'user', email: 'user@company.com' },
      ],
      total: 2,
    };

    const result = await redactForOutput(data, 'agent-safe') as Record<string, unknown>;
    expect(result).toBeDefined();

    const users = result.users as Array<Record<string, unknown>>;
    for (const user of users) {
      // Email should be redacted
      expect(String(user.email)).toContain('[REDACTED:');
      // Numeric id should be preserved
      expect(typeof user.id).toBe('number');
    }
    expect(result.total).toBe(2);
  });

  it('developer-debug mode adds PII type annotations', async () => {
    const emailInput = 'user@example.com';
    const result = await redactForOutput(emailInput, 'developer-debug') as string;
    // Should contain redaction marker and the PII type
    expect(result).toContain('[REDACTED:');
    expect(result).toContain('[was:email]');
  });

  it('handles nested objects with mixed PII and safe values', async () => {
    const data = {
      config: {
        enabled: true,
        count: 5,
      },
      profile: {
        email: 'secret@corp.com',
        phone: '555-123-4567',
      },
    };

    const result = await redactForOutput(data, 'agent-safe') as Record<string, unknown>;
    const config = result.config as Record<string, unknown>;
    const profile = result.profile as Record<string, unknown>;

    // Config values should be preserved (boolean and small number)
    expect(config.enabled).toBe(true);
    expect(config.count).toBe(5);

    // PII should be redacted
    expect(String(profile.email)).toContain('[REDACTED:');
  });
});
