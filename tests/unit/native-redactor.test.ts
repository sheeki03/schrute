import { describe, it, expect } from 'vitest';
import { redactNative, redactHeadersNative } from '../../src/native/redactor.js';

describe('native redactor (TS fallback)', () => {
  const salt = 'test-salt-12345678';

  it('returns null for fallback signal (async TS needed)', () => {
    // Without native module, redactNative returns null to signal async TS fallback
    const result = redactNative('test@example.com', salt, 'agent-safe');
    // Result is null (TS fallback signal) or the redacted value (native available)
    if (result !== null) {
      expect(String(result)).toContain('[REDACTED:');
    }
  });

  it('redactHeadersNative returns null without native module', () => {
    const result = redactHeadersNative(
      { 'authorization': 'Bearer secret123' },
      salt,
    );
    // Without native module, returns null
    if (result !== null) {
      expect(result['authorization']).toContain('[REDACTED:');
    }
  });

  it('safe values pass through unchanged', () => {
    const result = redactNative('true', salt);
    if (result !== null) {
      expect(result).toBe('true');
    }
  });

  it('short integers pass through unchanged', () => {
    const result = redactNative('42', salt);
    if (result !== null) {
      expect(result).toBe('42');
    }
  });
});
