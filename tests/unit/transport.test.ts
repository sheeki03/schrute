/**
 * Transport Tests — Fixes 1 & 2
 *
 * Fix 1: wreq transport delegates to native when pinnedIp is set
 *         (wreqFetch must NOT be called; native pathway must be used)
 * Fix 2: wreq available() uses createRequire(import.meta.url) for ESM compat
 *         (bare require() would throw ReferenceError in ESM)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { EventEmitter } from 'node:events';

// ─── Mock logger ────────────────────────────────────────────────
vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../src/core/config.js', () => ({
  getConfig: () => ({}),
}));

// ─── Mock tls-client (CycleTLS) ─────────────────────────────────
vi.mock('../../src/replay/tls-client.js', () => ({
  isCycleTlsAvailable: vi.fn().mockReturnValue(false),
  closeTlsClient: vi.fn().mockResolvedValue(undefined),
  tlsFetch: vi.fn(),
}));

// ─── Mock native tls-fetch module ───────────────────────────────
// Intercepts: dynamic import('../native/tls-fetch.js') in wreq.fetch()
const mockWreqFetch = vi.fn();
const mockIsWreqAvailable = vi.fn();

vi.mock('../../src/native/tls-fetch.js', () => ({
  wreqFetch: mockWreqFetch,
  isWreqAvailable: mockIsWreqAvailable,
}));

// ─── Mock node:module to intercept createRequire ────────────────
// wreq.available() calls createRequire(import.meta.url)('../native/tls-fetch.js')
// which is a CJS require — vi.mock only intercepts ESM imports.
// We mock createRequire to return a function that returns our mock module.
const mockCreateRequire = vi.fn();

vi.mock('node:module', () => ({
  createRequire: (...args: unknown[]) => mockCreateRequire(...args),
}));

// ─── Mock node:https to prevent real network calls ──────────────
// pinnedIpFetch() uses node:https.request() — we need to intercept it.
const mockHttpsRequest = vi.fn();

vi.mock('node:https', () => ({
  default: { request: (...args: unknown[]) => mockHttpsRequest(...args) },
  request: (...args: unknown[]) => mockHttpsRequest(...args),
}));

import {
  createWreqTransport,
  createNativeFetchTransport,
  createCycleTlsTransport,
  type TransportRequest,
  type TransportOptions,
} from '../../src/replay/transport.js';

// ─── Helpers ────────────────────────────────────────────────────

function makeRequest(overrides: Partial<TransportRequest> = {}): TransportRequest {
  return {
    url: 'https://api.example.com/data',
    method: 'GET',
    headers: { accept: 'application/json' },
    ...overrides,
  };
}

function makeOptions(overrides: Partial<TransportOptions> = {}): TransportOptions {
  return {
    maxResponseBytes: 10 * 1024 * 1024,
    timeoutMs: 30000,
    ...overrides,
  };
}

/**
 * Set up mockHttpsRequest to simulate a successful HTTPS response.
 * Returns the mock request object for assertion.
 */
function setupMockHttpsResponse(status = 200, body = 'ok', headers: Record<string, string> = {}) {
  const mockReq = new EventEmitter() as EventEmitter & {
    setTimeout: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
  mockReq.setTimeout = vi.fn();
  mockReq.write = vi.fn();
  mockReq.end = vi.fn();
  mockReq.destroy = vi.fn();

  mockHttpsRequest.mockImplementation((_opts: unknown, callback: (res: unknown) => void) => {
    // Simulate async response delivery
    process.nextTick(() => {
      const res = new EventEmitter() as EventEmitter & {
        statusCode: number;
        headers: Record<string, string>;
      };
      res.statusCode = status;
      res.headers = headers;
      callback(res);
      // Deliver body chunk then end
      process.nextTick(() => {
        res.emit('data', Buffer.from(body));
        res.emit('end');
      });
    });
    return mockReq;
  });

  return mockReq;
}

// ─── Tests ──────────────────────────────────────────────────────

afterEach(() => {
  vi.restoreAllMocks();
  mockWreqFetch.mockReset();
  mockIsWreqAvailable.mockReset();
  mockHttpsRequest.mockReset();
  mockCreateRequire.mockReset();
});

// ═══════════════════════════════════════════════════════════════
// Fix 1: wreq pinnedIp delegation to native
// ═══════════════════════════════════════════════════════════════

describe('wreq transport — pinnedIp delegation (Fix 1)', () => {
  it('delegates to native when pinnedIp is set — wreqFetch is NOT called', async () => {
    // Arrange: set up the HTTPS mock so pinnedIpFetch succeeds
    setupMockHttpsResponse(200, '{"delegated":true}', { 'content-type': 'application/json' });

    const wreq = createWreqTransport();
    const req = makeRequest();
    const opts = makeOptions({ pinnedIp: '93.184.216.34' });

    // Act
    const result = await wreq.fetch(req, opts);

    // Assert: wreqFetch must NOT be called when pinnedIp is set
    expect(mockWreqFetch).not.toHaveBeenCalled();
    // The native HTTPS pathway was invoked instead
    expect(mockHttpsRequest).toHaveBeenCalledOnce();
    expect(result.status).toBe(200);
    expect(result.body).toContain('delegated');
  });

  it('calls wreqFetch when pinnedIp is NOT set', async () => {
    // Arrange
    mockWreqFetch.mockReturnValueOnce({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
    });

    const wreq = createWreqTransport();
    const req = makeRequest();
    const opts = makeOptions(); // no pinnedIp

    // Act
    const result = await wreq.fetch(req, opts);

    // Assert: wreqFetch should have been called
    expect(mockWreqFetch).toHaveBeenCalledOnce();
    expect(mockWreqFetch).toHaveBeenCalledWith(
      { url: req.url, method: req.method, headers: req.headers, body: undefined },
      { timeoutMs: opts.timeoutMs, maxResponseBytes: opts.maxResponseBytes },
    );
    // HTTPS mock should NOT have been called
    expect(mockHttpsRequest).not.toHaveBeenCalled();
    expect(result.status).toBe(200);
    expect(result.body).toBe('{"ok":true}');
  });

  it('throws when wreqFetch returns null and pinnedIp is not set', async () => {
    // Arrange: wreqFetch returns null (module not loaded)
    mockWreqFetch.mockReturnValueOnce(null);

    const wreq = createWreqTransport();
    const req = makeRequest();
    const opts = makeOptions();

    // Act & Assert
    await expect(wreq.fetch(req, opts)).rejects.toThrow(
      'wreq native binding returned null',
    );
  });
});

describe('CycleTLS transport — pinnedIp delegation', () => {
  it('delegates to native when pinnedIp is set — does not call tlsFetch', async () => {
    // Arrange
    setupMockHttpsResponse(200, 'native-response');

    const cycleTls = createCycleTlsTransport();
    const req = makeRequest();
    const opts = makeOptions({ pinnedIp: '93.184.216.34' });

    // Act
    const result = await cycleTls.fetch(req, opts);

    // Assert: native HTTPS was used, not CycleTLS
    expect(mockHttpsRequest).toHaveBeenCalledOnce();
    expect(result.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════
// Fix 2: wreq ESM availability check via createRequire
// ═══════════════════════════════════════════════════════════════

describe('wreq transport — ESM available() check (Fix 2)', () => {
  it('returns true when native binding exists', () => {
    // Arrange: createRequire returns a require function that resolves the module
    mockCreateRequire.mockReturnValue(() => ({
      isWreqAvailable: () => true,
    }));

    const wreq = createWreqTransport();

    // Act
    const result = wreq.available();

    // Assert
    expect(result).toBe(true);
    // createRequire should have been called (ESM compat path)
    expect(mockCreateRequire).toHaveBeenCalled();
  });

  it('returns false when native binding is missing (require throws)', () => {
    // Arrange: createRequire returns a require function that throws
    mockCreateRequire.mockReturnValue(() => {
      throw new Error('Cannot find module ../native/tls-fetch.js');
    });

    const wreq = createWreqTransport();

    // Act
    const result = wreq.available();

    // Assert: should catch and return false
    expect(result).toBe(false);
  });

  it('returns false when isWreqAvailable() returns false', () => {
    // Arrange
    mockCreateRequire.mockReturnValue(() => ({
      isWreqAvailable: () => false,
    }));

    const wreq = createWreqTransport();

    // Act
    const result = wreq.available();

    // Assert
    expect(result).toBe(false);
  });

  it('returns false when createRequire itself throws', () => {
    // Arrange: createRequire throws (unlikely but defensive)
    mockCreateRequire.mockImplementation(() => {
      throw new Error('createRequire failed');
    });

    const wreq = createWreqTransport();

    // Act
    const result = wreq.available();

    // Assert
    expect(result).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// Basics / smoke tests
// ═══════════════════════════════════════════════════════════════

describe('transport — provider names', () => {
  it('native transport name is "native"', () => {
    expect(createNativeFetchTransport().name).toBe('native');
  });

  it('native available() always returns true', () => {
    expect(createNativeFetchTransport().available()).toBe(true);
  });

  it('wreq transport name is "wreq"', () => {
    expect(createWreqTransport().name).toBe('wreq');
  });

  it('cycletls transport name is "cycletls"', () => {
    expect(createCycleTlsTransport().name).toBe('cycletls');
  });
});
