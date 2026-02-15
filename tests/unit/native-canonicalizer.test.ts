import { describe, it, expect } from 'vitest';
import { canonicalizeRequestNative } from '../../src/native/canonicalizer.js';
import { canonicalizeRequest } from '../../src/capture/canonicalizer.js';
import type { StructuredRequest } from '../../src/capture/har-extractor.js';

describe('native canonicalizer (TS fallback)', () => {
  it('strips tracking params from URL', () => {
    const req: StructuredRequest = {
      method: 'GET',
      url: 'https://example.com/page?q=test&utm_source=email&fbclid=abc123',
      headers: {},
      queryParams: { q: 'test', utm_source: 'email', fbclid: 'abc123' },
    };

    const result = canonicalizeRequestNative(req);
    expect(result.canonicalUrl).not.toContain('utm_source');
    expect(result.canonicalUrl).not.toContain('fbclid');
    expect(result.canonicalUrl).toContain('q=test');
  });

  it('lowercases hostname', () => {
    const req: StructuredRequest = {
      method: 'GET',
      url: 'https://EXAMPLE.COM/path',
      headers: {},
      queryParams: {},
    };

    const result = canonicalizeRequestNative(req);
    expect(result.canonicalUrl).toContain('example.com');
  });

  it('uppercases method', () => {
    const req: StructuredRequest = {
      method: 'post',
      url: 'https://api.example.com/data',
      headers: {},
      queryParams: {},
    };

    const result = canonicalizeRequestNative(req);
    expect(result.method).toBe('POST');
  });

  it('canonicalizes JSON body by sorting keys and removing ephemeral fields', () => {
    const req: StructuredRequest = {
      method: 'POST',
      url: 'https://api.example.com/data',
      headers: {},
      body: '{"z_field":"z","a_field":"a","timestamp":"123","nonce":"abc"}',
      contentType: 'application/json',
      queryParams: {},
    };

    const result = canonicalizeRequestNative(req);
    expect(result.canonicalBody).toBeDefined();
    const parsed = JSON.parse(result.canonicalBody!);
    // Ephemeral fields should be removed
    expect(parsed.timestamp).toBeUndefined();
    expect(parsed.nonce).toBeUndefined();
    // Remaining fields should be present
    expect(parsed.a_field).toBe('a');
    expect(parsed.z_field).toBe('z');
  });

  it('canonicalizes GraphQL queries', () => {
    const req: StructuredRequest = {
      method: 'POST',
      url: 'https://api.example.com/graphql',
      headers: {},
      body: JSON.stringify({
        query: '  query GetUser($id: ID!) {\n  user(id: $id) {\n    name\n  }\n}',
        variables: { id: '123' },
        operationName: 'GetUser',
      }),
      contentType: 'application/json',
      queryParams: {},
    };

    const result = canonicalizeRequestNative(req);
    expect(result.canonicalBody).toBeDefined();
    const parsed = JSON.parse(result.canonicalBody!);
    // Query should have collapsed whitespace
    expect(parsed.query).not.toContain('\n');
    expect(parsed.operationName).toBe('GetUser');
  });

  it('matches TS canonicalizeRequest output', () => {
    const req: StructuredRequest = {
      method: 'GET',
      url: 'https://Example.COM/api/v1?b=2&a=1&utm_source=test',
      headers: {},
      queryParams: { b: '2', a: '1', utm_source: 'test' },
    };

    const nativeResult = canonicalizeRequestNative(req);
    const tsResult = canonicalizeRequest(req);

    expect(nativeResult.method).toBe(tsResult.method);
    // Both should strip utm_source
    expect(nativeResult.canonicalUrl).not.toContain('utm_source');
    expect(tsResult.canonicalUrl).not.toContain('utm_source');
  });
});
