import { describe, it, expect } from 'vitest';
import { sanitizeSiteId } from '../../src/core/utils.js';

describe('Path traversal rejection (TC-C4)', () => {
  describe('sanitizeSiteId', () => {
    it('strips path separators from siteId', () => {
      const sanitized = sanitizeSiteId('../etc/passwd');
      expect(sanitized).not.toContain('/');
      expect(sanitized).not.toContain('\\');
      expect(sanitized).not.toContain('..');
    });

    it('strips backslash path separators', () => {
      const sanitized = sanitizeSiteId('..\\windows\\system32');
      expect(sanitized).not.toContain('\\');
      expect(sanitized).not.toContain('..');
    });

    it('collapses consecutive dots', () => {
      const sanitized = sanitizeSiteId('..example..com');
      expect(sanitized).not.toContain('..');
    });

    it('handles simple valid domains unchanged (lowercased)', () => {
      const sanitized = sanitizeSiteId('example.com');
      expect(sanitized).toBe('example.com');
    });

    it('rejects empty string after sanitization', () => {
      expect(() => sanitizeSiteId('...')).toThrow(/cannot be empty/);
    });

    it('strips control characters', () => {
      const sanitized = sanitizeSiteId('example\x00.com');
      expect(sanitized).not.toContain('\x00');
    });

    it('replaces path-unsafe characters with dashes', () => {
      const sanitized = sanitizeSiteId('site:with*unsafe?"chars');
      expect(sanitized).not.toContain(':');
      expect(sanitized).not.toContain('*');
      expect(sanitized).not.toContain('?');
      expect(sanitized).not.toContain('"');
    });
  });

  describe('mcp-handlers resource URI path traversal regex', () => {
    // The regex used in mcp-handlers.ts line 247:
    // /[/\\]|\.\./.test(siteId)
    const traversalRegex = /[/\\]|\.\./;

    it('detects ../ in siteId', () => {
      expect(traversalRegex.test('../etc/passwd')).toBe(true);
    });

    it('detects ..\\ in skillId', () => {
      expect(traversalRegex.test('..\\windows\\system32')).toBe(true);
    });

    it('detects bare .. in siteId', () => {
      expect(traversalRegex.test('..')).toBe(true);
    });

    it('allows normal siteId', () => {
      expect(traversalRegex.test('example.com')).toBe(false);
    });

    it('allows siteId with single dot', () => {
      expect(traversalRegex.test('api.example.com')).toBe(false);
    });
  });
});
