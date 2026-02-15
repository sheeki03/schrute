import { describe, it, expect } from 'vitest';
import {
  canonicalizeUrl,
  canonicalizeJsonBody,
  canonicalizeGraphQL,
  canonicalizeRequest,
} from '../../src/capture/canonicalizer.js';

describe('canonicalizer', () => {
  describe('canonicalizeUrl', () => {
    it('strips tracking params (utm_source, fbclid)', () => {
      const url = 'https://example.com/page?utm_source=google&fbclid=abc123&q=test';
      const result = canonicalizeUrl(url);
      expect(result).not.toContain('utm_source');
      expect(result).not.toContain('fbclid');
      expect(result).toContain('q=test');
    });

    it('lowercases host', () => {
      const url = 'https://EXAMPLE.COM/path';
      const result = canonicalizeUrl(url);
      expect(result).toContain('example.com');
      expect(result).not.toContain('EXAMPLE.COM');
    });

    it('sorts query params', () => {
      const url = 'https://example.com/api?z=1&a=2&m=3';
      const result = canonicalizeUrl(url);
      const parsed = new URL(result);
      const keys = Array.from(parsed.searchParams.keys());
      expect(keys).toEqual(['a', 'm', 'z']);
    });
  });

  describe('canonicalizeJsonBody', () => {
    it('sorts JSON body keys', () => {
      const body = JSON.stringify({ z: 1, a: 2, m: 3 });
      const result = canonicalizeJsonBody(body);
      const keys = Object.keys(JSON.parse(result!));
      expect(keys).toEqual(['a', 'm', 'z']);
    });

    it('strips ephemeral fields (timestamp, requestId, nonce)', () => {
      const body = JSON.stringify({
        data: 'value',
        timestamp: 1234567890,
        requestId: 'abc-123',
        nonce: 'xyz',
      });
      const result = canonicalizeJsonBody(body);
      const parsed = JSON.parse(result!);
      expect(parsed).not.toHaveProperty('timestamp');
      expect(parsed).not.toHaveProperty('requestId');
      expect(parsed).not.toHaveProperty('nonce');
      expect(parsed).toHaveProperty('data', 'value');
    });

    it('returns undefined for undefined body', () => {
      expect(canonicalizeJsonBody(undefined)).toBeUndefined();
    });

    it('returns non-JSON body as-is', () => {
      expect(canonicalizeJsonBody('not json')).toBe('not json');
    });
  });

  describe('canonicalizeGraphQL', () => {
    it('normalizes whitespace', () => {
      const query = `
        query   GetUser($id:   ID!)  {
          user(id:  $id)   {
            name
            email
          }
        }
      `;
      const result = canonicalizeGraphQL(query);
      expect(result).toBe('query GetUser($id: ID!) { user(id: $id) { name email } }');
    });

    it('strips comments', () => {
      const query = `
        # This is a comment
        query GetUser {
          user { name } # inline comment
        }
      `;
      const result = canonicalizeGraphQL(query);
      expect(result).not.toContain('#');
      expect(result).toContain('query GetUser');
    });
  });

  describe('canonicalizeRequest', () => {
    it('canonicalizes full request with JSON body', () => {
      const result = canonicalizeRequest({
        method: 'post',
        url: 'https://EXAMPLE.COM/api?utm_source=test&q=hello',
        headers: {},
        body: JSON.stringify({ z: 1, a: 2, timestamp: 123 }),
        contentType: 'application/json',
        queryParams: {},
      });
      expect(result.method).toBe('POST');
      expect(result.canonicalUrl).toContain('example.com');
      expect(result.canonicalUrl).not.toContain('utm_source');
      const bodyParsed = JSON.parse(result.canonicalBody!);
      expect(Object.keys(bodyParsed)).toEqual(['a', 'z']);
      expect(bodyParsed).not.toHaveProperty('timestamp');
    });
  });
});
