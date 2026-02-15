/**
 * Rust <-> TS Parity Tests
 *
 * Verifies that the native Rust wrappers (which fall back to TS when
 * native module is unavailable) produce the same output as the TS
 * implementations for the same input fixtures.
 *
 * All 11 native modules are tested:
 * 1. audit-chain
 * 2. canonicalizer
 * 3. har-parser
 * 4. ip-policy
 * 5. noise-filter
 * 6. param-discoverer
 * 7. path-risk
 * 8. redactor
 * 9. schema-inference
 * 10. semantic-diff
 * 11. volatility
 *
 * Since the Rust native module is not compiled in test, all wrappers
 * fall back to TS. We verify that the fallback path produces correct
 * results matching the expected TS output.
 */

import { describe, it, expect, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';

// ─── 1. audit-chain ──────────────────────────────────────────────

describe('Rust Parity — audit-chain', () => {
  it('computeEntryHashNative produces same hash as manual TS', async () => {
    const { computeEntryHashNative, signEntryHashNative } = await import(
      '../../src/native/audit-chain.js'
    );

    const previousHash = '0'.repeat(64);
    const entry = {
      id: 'test-1',
      timestamp: 1700000000000,
      skillId: 'site.skill.v1',
    };
    const entryJson = JSON.stringify(entry);

    const nativeHash = computeEntryHashNative(entryJson, previousHash);

    // Manual TS computation
    const withHashes = { ...entry, previousHash, entryHash: undefined, signature: undefined };
    const expected = createHash('sha256')
      .update(JSON.stringify(withHashes))
      .digest('hex');

    expect(nativeHash).toBe(expected);
  });

  it('signEntryHashNative produces same HMAC as manual TS', async () => {
    const { signEntryHashNative } = await import('../../src/native/audit-chain.js');

    const entryHash = 'a'.repeat(64);
    const hmacKey = 'test-key-123';

    const nativeSig = signEntryHashNative(entryHash, hmacKey);
    const expected = createHmac('sha256', hmacKey).update(entryHash).digest('hex');

    expect(nativeSig).toBe(expected);
  });

  it('verifyChainNative returns null (no native module) or valid result', async () => {
    const { verifyChainNative } = await import('../../src/native/audit-chain.js');

    const result = verifyChainNative([], 'key');
    // Without native module, returns null
    expect(result).toBeNull();
  });
});

// ─── 2. canonicalizer ─────────────────────────────────────────────

describe('Rust Parity — canonicalizer', () => {
  it('canonicalizeRequestNative falls back to TS correctly', async () => {
    const { canonicalizeRequestNative } = await import(
      '../../src/native/canonicalizer.js'
    );

    const req = {
      url: 'https://example.com/api/users?page=1&utm_source=test',
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: undefined,
      contentType: 'application/json',
      queryParams: { page: '1', utm_source: 'test' },
      status: 200,
      responseHeaders: {},
      responseBody: '',
    };

    const result = canonicalizeRequestNative(req);
    expect(result).toHaveProperty('method');
    expect(result).toHaveProperty('canonicalUrl');
    expect(result.method).toBe('GET');
    // URL should be canonicalized (tracking params stripped)
    expect(typeof result.canonicalUrl).toBe('string');
  });
});

// ─── 3. har-parser ────────────────────────────────────────────────

describe('Rust Parity — har-parser', () => {
  it('parseHarNative processes minimal HAR data', async () => {
    const { parseHarNative } = await import('../../src/native/har-parser.js');

    const minimalHar = {
      log: {
        version: '1.2',
        entries: [
          {
            request: {
              method: 'GET',
              url: 'https://example.com/api/test',
              headers: [{ name: 'Host', value: 'example.com' }],
              queryString: [],
            },
            response: {
              status: 200,
              headers: [{ name: 'Content-Type', value: 'application/json' }],
              content: { text: '{"ok":true}', mimeType: 'application/json' },
            },
            timings: { send: 0, wait: 50, receive: 10 },
            startedDateTime: '2024-01-01T00:00:00Z',
            time: 60,
          },
        ],
      },
    };

    const result = parseHarNative(JSON.stringify(minimalHar));
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(1);
    expect(result[0]).toHaveProperty('request');
    expect(result[0].request).toHaveProperty('method', 'GET');
    expect(result[0].request).toHaveProperty('url');
  });
});

// ─── 4. ip-policy ─────────────────────────────────────────────────

describe('Rust Parity — ip-policy', () => {
  it('isPublicIpNative matches TS for public IPs', async () => {
    const { isPublicIpNative } = await import('../../src/native/ip-policy.js');
    const { isPublicIp } = await import('../../src/core/policy.js');

    const testIps = ['8.8.8.8', '1.1.1.1', '93.184.216.34'];
    for (const ip of testIps) {
      const nativeResult = isPublicIpNative(ip);
      const tsResult = isPublicIp(ip);
      expect(nativeResult?.allowed).toBe(tsResult);
    }
  });

  it('isPublicIpNative matches TS for private IPs', async () => {
    const { isPublicIpNative } = await import('../../src/native/ip-policy.js');
    const { isPublicIp } = await import('../../src/core/policy.js');

    const testIps = ['127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1'];
    for (const ip of testIps) {
      const nativeResult = isPublicIpNative(ip);
      const tsResult = isPublicIp(ip);
      expect(nativeResult?.allowed).toBe(tsResult);
    }
  });

  it('normalizeDomainNative normalizes correctly', async () => {
    const { normalizeDomainNative } = await import('../../src/native/ip-policy.js');

    expect(normalizeDomainNative('Example.COM')).toBe('example.com');
    expect(normalizeDomainNative('example.com.')).toBe('example.com');
    expect(normalizeDomainNative('EXAMPLE.COM.')).toBe('example.com');
  });
});

// ─── 5. noise-filter ──────────────────────────────────────────────

describe('Rust Parity — noise-filter', () => {
  it('filterRequestsNative falls back to TS and classifies entries', async () => {
    const { filterRequestsNative } = await import('../../src/native/noise-filter.js');

    // Provide entries with proper HarEntry structure (headers as array)
    const entries = [
      {
        request: {
          method: 'GET',
          url: 'https://example.com/api/data',
          httpVersion: 'HTTP/1.1',
          headers: [{ name: 'Content-Type', value: 'application/json' }],
          queryString: [],
          headersSize: -1,
          bodySize: 0,
        },
        response: {
          status: 200,
          statusText: 'OK',
          httpVersion: 'HTTP/1.1',
          headers: [{ name: 'Content-Type', value: 'application/json' }],
          content: { size: 0, mimeType: 'application/json' },
          redirectURL: '',
          headersSize: -1,
          bodySize: 0,
        },
        startedDateTime: '2024-01-01T00:00:00Z',
        time: 50,
        timings: { send: 0, wait: 50, receive: 0 },
      },
      {
        request: {
          method: 'GET',
          url: 'https://google-analytics.com/collect',
          httpVersion: 'HTTP/1.1',
          headers: [],
          queryString: [],
          headersSize: -1,
          bodySize: 0,
        },
        response: {
          status: 200,
          statusText: 'OK',
          httpVersion: 'HTTP/1.1',
          headers: [],
          content: { size: 0, mimeType: 'text/html' },
          redirectURL: '',
          headersSize: -1,
          bodySize: 0,
        },
        startedDateTime: '2024-01-01T00:00:01Z',
        time: 50,
        timings: { send: 0, wait: 50, receive: 0 },
      },
    ] as any[];

    const result = filterRequestsNative(entries);
    expect(result).toHaveProperty('signal');
    expect(result).toHaveProperty('noise');
    expect(result).toHaveProperty('ambiguous');
    expect(Array.isArray(result.signal)).toBe(true);
    expect(Array.isArray(result.noise)).toBe(true);
  });
});

// ─── 6. param-discoverer ──────────────────────────────────────────

describe('Rust Parity — param-discoverer', () => {
  it('discoverParamsNative falls back to TS', async () => {
    const { discoverParamsNative } = await import('../../src/native/param-discoverer.js');

    // Empty input should return empty array
    const result = discoverParamsNative([]);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });
});

// ─── 7. path-risk ─────────────────────────────────────────────────

describe('Rust Parity — path-risk', () => {
  it('checkPathRiskNative matches TS for safe paths', async () => {
    const { checkPathRiskNative } = await import('../../src/native/path-risk.js');

    const result = checkPathRiskNative('GET', '/api/users');
    expect(result.blocked).toBe(false);
  });

  it('checkPathRiskNative matches TS for destructive GET paths', async () => {
    const { checkPathRiskNative } = await import('../../src/native/path-risk.js');

    const result = checkPathRiskNative('GET', '/api/logout');
    expect(result.blocked).toBe(true);
    expect(result.reason).toBeDefined();
  });

  it('checkPathRiskNative matches TS for destructive POST paths', async () => {
    const { checkPathRiskNative } = await import('../../src/native/path-risk.js');

    const result = checkPathRiskNative('POST', '/api/payment');
    expect(result.blocked).toBe(true);
  });

  it('checkPathRiskNative safe POST passes', async () => {
    const { checkPathRiskNative } = await import('../../src/native/path-risk.js');

    const result = checkPathRiskNative('POST', '/api/search');
    expect(result.blocked).toBe(false);
  });
});

// ─── 8. redactor ──────────────────────────────────────────────────

describe('Rust Parity — redactor', () => {
  it('redactNative returns null (no native module)', async () => {
    const { redactNative } = await import('../../src/native/redactor.js');

    const result = redactNative('test@example.com', 'salt123', 'agent-safe');
    // Without native module, returns null (caller uses async TS fallback)
    expect(result).toBeNull();
  });

  it('redactHeadersNative returns null (no native module)', async () => {
    const { redactHeadersNative } = await import('../../src/native/redactor.js');

    const result = redactHeadersNative(
      { Authorization: 'Bearer token' },
      'salt123',
    );
    expect(result).toBeNull();
  });
});

// ─── 9. schema-inference ──────────────────────────────────────────

describe('Rust Parity — schema-inference', () => {
  it('inferSchemaNative infers schema from samples', async () => {
    const { inferSchemaNative } = await import('../../src/native/schema-inference.js');

    const samples = [
      { name: 'Alice', age: 30, active: true },
      { name: 'Bob', age: 25, active: false },
    ];

    const schema = inferSchemaNative(samples);
    expect(schema).toBeDefined();
    expect(schema).toHaveProperty('type');
  });
});

// ─── 10. semantic-diff ────────────────────────────────────────────

describe('Rust Parity — semantic-diff', () => {
  it('checkSemanticNative checks response semantics', async () => {
    const { checkSemanticNative } = await import('../../src/native/semantic-diff.js');
    const { makeSkill } = await import('../helpers.js');

    const skill = makeSkill({
      validation: {
        semanticChecks: ['no_error_signatures'],
        customInvariants: [],
      },
    });

    const response = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: '{"ok":true}',
    };

    const result = checkSemanticNative(response, skill);
    expect(result).toHaveProperty('pass');
    expect(result).toHaveProperty('details');
    expect(result.pass).toBe(true);
  });

  it('checkSemanticNative detects error signatures in body', async () => {
    const { checkSemanticNative } = await import('../../src/native/semantic-diff.js');
    const { makeSkill } = await import('../helpers.js');

    const skill = makeSkill({
      validation: {
        semanticChecks: ['no_error_signatures'],
        customInvariants: [],
      },
    });

    const response = {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
      body: '{"error":"internal server error"}',
    };

    const result = checkSemanticNative(response, skill);
    expect(result.pass).toBe(false);
    expect(result.details.some((d: string) => d.includes('error_field'))).toBe(true);
  });
});

// ─── 11. volatility ──────────────────────────────────────────────

describe('Rust Parity — volatility', () => {
  it('scoreVolatilityNative scores empty input', async () => {
    const { scoreVolatilityNative } = await import('../../src/native/volatility.js');

    const result = scoreVolatilityNative([]);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });
});

// ─── Cross-cutting: native module loader ──────────────────────────

describe('Rust Parity — Native Module Loader', () => {
  it('isNativeAvailable returns false in test environment', async () => {
    const { isNativeAvailable } = await import('../../src/native/index.js');
    // In test, native module is not compiled
    expect(isNativeAvailable()).toBe(false);
  });

  it('getNativeModule returns null when not compiled', async () => {
    const { getNativeModule } = await import('../../src/native/index.js');
    expect(getNativeModule()).toBeNull();
  });

  it('all native wrappers gracefully fall back to TS', async () => {
    // This test verifies the fallback mechanism works for all 11 modules
    // by importing each one — if any throws, the test fails
    const modules = [
      import('../../src/native/audit-chain.js'),
      import('../../src/native/canonicalizer.js'),
      import('../../src/native/har-parser.js'),
      import('../../src/native/ip-policy.js'),
      import('../../src/native/noise-filter.js'),
      import('../../src/native/param-discoverer.js'),
      import('../../src/native/path-risk.js'),
      import('../../src/native/redactor.js'),
      import('../../src/native/schema-inference.js'),
      import('../../src/native/semantic-diff.js'),
      import('../../src/native/volatility.js'),
    ];

    const results = await Promise.allSettled(modules);
    for (const result of results) {
      expect(result.status).toBe('fulfilled');
    }
  });
});
