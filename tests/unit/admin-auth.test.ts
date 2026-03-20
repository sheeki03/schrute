import { describe, it, expect } from 'vitest';
import { isAdminCaller } from '../../src/shared/admin-auth.js';
import type { SchruteConfig } from '../../src/skill/types.js';

function makeConfig(network: boolean, mcpHttpAdmin = false): SchruteConfig {
  return {
    dataDir: '/tmp/schrute-admin-auth-test',
    logLevel: 'silent',
    features: { webmcp: false, httpTransport: false },
    toolBudget: {
      maxToolCallsPerTask: 50,
      maxConcurrentCalls: 3,
      crossDomainCalls: false,
      secretsToNonAllowlisted: false,
    },
    payloadLimits: {
      maxResponseBodyBytes: 10 * 1024 * 1024,
      maxRequestBodyBytes: 5 * 1024 * 1024,
      replayTimeoutMs: { tier1: 30000, tier3: 60000, tier4: 120000 },
      harCaptureMaxBodyBytes: 50 * 1024 * 1024,
      redactorTimeoutMs: 10000,
    },
    audit: { strictMode: true, rootHashExport: true },
    storage: { maxPerSiteMb: 500, maxGlobalMb: 5000, retentionDays: 90 },
    server: { network, mcpHttpAdmin },
    daemon: { port: 19420, autoStart: false },
    tempTtlMs: 3600000,
    gcIntervalMs: 900000,
    confirmationTimeoutMs: 30000,
    confirmationExpiryMs: 60000,
    promotionConsecutivePasses: 5,
    promotionVolatilityThreshold: 0.2,
    maxToolsPerSite: 20,
    toolShortlistK: 10,
  } as SchruteConfig;
}

describe('isAdminCaller', () => {
  describe('network=false (localhost-only)', () => {
    const config = makeConfig(false);

    it('returns true for any callerId', () => {
      expect(isAdminCaller('stdio', config)).toBe(true);
      expect(isAdminCaller('daemon', config)).toBe(true);
      expect(isAdminCaller('mcp-http-abc', config)).toBe(true);
      expect(isAdminCaller(undefined, config)).toBe(true);
    });
  });

  describe('network=true (multi-user mode)', () => {
    const config = makeConfig(true);

    it('returns true for "stdio" (local CLI)', () => {
      expect(isAdminCaller('stdio', config)).toBe(true);
    });

    it('returns true for "daemon" (local daemon socket)', () => {
      expect(isAdminCaller('daemon', config)).toBe(true);
    });

    it('returns true for undefined callerId (legacy/CLI)', () => {
      expect(isAdminCaller(undefined, config)).toBe(true);
    });

    it('returns false for MCP HTTP sessions', () => {
      expect(isAdminCaller('mcp-http:session-123', config)).toBe(false);
      expect(isAdminCaller('mcp-http:abc', config)).toBe(false);
    });

    it('returns false for unknown callerIds', () => {
      expect(isAdminCaller('rest-api', config)).toBe(false);
      expect(isAdminCaller('random', config)).toBe(false);
    });
  });

  describe('network=true with mcpHttpAdmin=true', () => {
    const config = makeConfig(true, true);

    it('returns true for mcp-http: prefixed callerIds', () => {
      expect(isAdminCaller('mcp-http:session-123', config)).toBe(true);
      expect(isAdminCaller('mcp-http:unknown', config)).toBe(true);
    });

    it('still returns true for stdio and daemon', () => {
      expect(isAdminCaller('stdio', config)).toBe(true);
      expect(isAdminCaller('daemon', config)).toBe(true);
    });

    it('still returns false for non-mcp-http callerIds', () => {
      expect(isAdminCaller('rest-api', config)).toBe(false);
      expect(isAdminCaller('random', config)).toBe(false);
    });
  });

  describe('network=true with mcpHttpAdmin=false (default)', () => {
    const config = makeConfig(true, false);

    it('returns false for mcp-http: prefixed callerIds', () => {
      expect(isAdminCaller('mcp-http:session-123', config)).toBe(false);
      expect(isAdminCaller('mcp-http:unknown', config)).toBe(false);
    });
  });
});
