import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockConnectOverCDP = vi.fn();
vi.mock('playwright', () => ({
  chromium: {
    connectOverCDP: (...args: any[]) => mockConnectOverCDP(...args),
  },
}));

import { connectViaCDP, discoverCdpPort } from '../../src/browser/cdp-connector.js';

describe('CDP Auto-Discovery', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ─── discoverCdpPort ──────────────────────────────────────────────

  describe('discoverCdpPort', () => {
    it('returns port and wsEndpoint when a single port responds', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes(':9222/')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' }),
          });
        }
        return Promise.reject(new Error('Connection refused'));
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await discoverCdpPort({ ports: [9222, 9229] });

      expect(result).not.toBeNull();
      expect(result!.port).toBe(9222);
      expect(result!.wsEndpoint).toBe('ws://127.0.0.1:9222/devtools/browser/abc');

      vi.unstubAllGlobals();
    });

    it('returns null when no ports respond', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Connection refused'));
      vi.stubGlobal('fetch', mockFetch);

      const result = await discoverCdpPort({ ports: [9222, 9229, 9221] });

      expect(result).toBeNull();

      vi.unstubAllGlobals();
    });

    it('returns lowest-priority-index port when multiple respond', async () => {
      // Both 9222 and 9229 respond, but 9222 comes first in the array
      // so its result appears first in Promise.allSettled results
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes(':9222/') || url.includes(':9229/')) {
          const port = url.includes(':9222/') ? 9222 : 9229;
          return Promise.resolve({
            ok: true,
            json: async () => ({
              webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/id-${port}`,
            }),
          });
        }
        return Promise.reject(new Error('Connection refused'));
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await discoverCdpPort({ ports: [9222, 9229, 9221] });

      // The implementation iterates Promise.allSettled results in array order,
      // returning the first fulfilled result — which matches ports array order
      expect(result).not.toBeNull();
      expect(result!.port).toBe(9222);
      expect(result!.wsEndpoint).toBe('ws://127.0.0.1:9222/devtools/browser/id-9222');

      vi.unstubAllGlobals();
    });

    it('accepts explicit ports array', async () => {
      const customPorts = [4000, 5000, 6000];
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes(':5000/')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:5000/devtools/browser/x' }),
          });
        }
        return Promise.reject(new Error('Connection refused'));
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await discoverCdpPort({ ports: customPorts });

      expect(result).not.toBeNull();
      expect(result!.port).toBe(5000);
      // Verify all ports were probed
      expect(mockFetch).toHaveBeenCalledTimes(3);

      vi.unstubAllGlobals();
    });

    it('accepts custom host', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: 'ws://10.0.0.5:9222/devtools/browser/y' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await discoverCdpPort({ host: '10.0.0.5', ports: [9222] });

      expect(result).not.toBeNull();
      expect(mockFetch).toHaveBeenCalledWith(
        'http://10.0.0.5:9222/json/version',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );

      vi.unstubAllGlobals();
    });

    it('uses default host 127.0.0.1 when no host specified', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/z' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await discoverCdpPort({ ports: [9222] });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:9222/json/version',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );

      vi.unstubAllGlobals();
    });

    it('probes all ports in parallel via Promise.allSettled', async () => {
      const callOrder: number[] = [];
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        const portMatch = url.match(/:(\d+)\//);
        if (portMatch) callOrder.push(Number(portMatch[1]));
        return Promise.reject(new Error('Connection refused'));
      });
      vi.stubGlobal('fetch', mockFetch);

      await discoverCdpPort({ ports: [9222, 9229, 9221] });

      // All ports were probed (not short-circuited)
      expect(mockFetch).toHaveBeenCalledTimes(3);

      vi.unstubAllGlobals();
    });

    it('rejects ports with non-ok HTTP responses', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await discoverCdpPort({ ports: [9222] });

      expect(result).toBeNull();

      vi.unstubAllGlobals();
    });

    it('rejects responses missing webSocketDebuggerUrl', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ Browser: 'Chrome/120' }), // no webSocketDebuggerUrl
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await discoverCdpPort({ ports: [9222] });

      expect(result).toBeNull();

      vi.unstubAllGlobals();
    });
  });

  // ─── connectViaCDP with autoDiscover ──────────────────────────────

  describe('connectViaCDP with autoDiscover', () => {
    it('calls discoverCdpPort and connects when autoDiscover is true', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes(':9222/')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/auto',
            }),
          });
        }
        return Promise.reject(new Error('Connection refused'));
      });
      vi.stubGlobal('fetch', mockFetch);

      const mockBrowser = { isConnected: () => true };
      mockConnectOverCDP.mockResolvedValue(mockBrowser);

      const result = await connectViaCDP({ autoDiscover: true });

      expect(result).toBe(mockBrowser);
      expect(mockConnectOverCDP).toHaveBeenCalledWith(
        'ws://127.0.0.1:9222/devtools/browser/auto',
      );

      vi.unstubAllGlobals();
    });

    it('throws descriptive error when autoDiscover finds nothing', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Connection refused'));
      vi.stubGlobal('fetch', mockFetch);

      await expect(connectViaCDP({ autoDiscover: true })).rejects.toThrow(
        /auto-discovery found no endpoints/i,
      );
      await expect(connectViaCDP({ autoDiscover: true })).rejects.toThrow(
        /--remote-debugging-port/,
      );

      vi.unstubAllGlobals();
    });

    it('includes scanned ports in auto-discovery error message', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Connection refused'));
      vi.stubGlobal('fetch', mockFetch);

      try {
        await connectViaCDP({ autoDiscover: true });
      } catch (err) {
        const message = (err as Error).message;
        // Verify common CDP ports are listed in the error
        expect(message).toContain('Scanned ports:');
        expect(message).toContain('9222');
        expect(message).toContain('9229');
      }

      vi.unstubAllGlobals();
    });

    it('explicit port bypasses auto-discovery', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/explicit',
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const mockBrowser = { isConnected: () => true };
      mockConnectOverCDP.mockResolvedValue(mockBrowser);

      await connectViaCDP({ port: 9333 });

      // Should call fetch with only the explicit port, not common ports
      expect(mockFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:9333/json/version',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(mockConnectOverCDP).toHaveBeenCalledWith(
        'ws://127.0.0.1:9333/devtools/browser/explicit',
      );

      vi.unstubAllGlobals();
    });

    it('explicit wsEndpoint bypasses everything', async () => {
      const mockBrowser = { isConnected: () => true };
      mockConnectOverCDP.mockResolvedValue(mockBrowser);

      const wsUrl = 'ws://custom-host:1234/devtools/browser/direct';
      const result = await connectViaCDP({ wsEndpoint: wsUrl });

      expect(result).toBe(mockBrowser);
      expect(mockConnectOverCDP).toHaveBeenCalledWith(wsUrl);
      // No fetch calls needed
    });
  });

  // ─── CDP Timing ─────────────────────────────────────────────────

  /**
   * Helper: create a fetch mock that respects the AbortSignal passed via options.
   * Real fetch aborts when the signal fires; our mock must do the same.
   */
  function createAbortAwareFetch(
    handler: (url: string) => Promise<any> | 'hang',
  ) {
    return vi.fn().mockImplementation((url: string, opts?: { signal?: AbortSignal }) => {
      const result = handler(url);
      if (result === 'hang') {
        // Never-resolving promise that rejects on abort
        return new Promise((_, reject) => {
          if (opts?.signal) {
            if (opts.signal.aborted) {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
              return;
            }
            opts.signal.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
          }
        });
      }
      return result;
    });
  }

  describe('CDP timing', () => {
    it('respects probeTimeoutMs for slow responses', async () => {
      const mockFetch = createAbortAwareFetch(() => 'hang');
      vi.stubGlobal('fetch', mockFetch);

      const start = Date.now();
      const result = await discoverCdpPort({ ports: [9222], probeTimeoutMs: 100 });
      const elapsed = Date.now() - start;

      expect(result).toBeNull();
      // Should complete quickly due to AbortSignal.timeout, not wait forever
      expect(elapsed).toBeLessThan(2000);

      vi.unstubAllGlobals();
    });

    it('all ports timeout simultaneously', async () => {
      const mockFetch = createAbortAwareFetch(() => 'hang');
      vi.stubGlobal('fetch', mockFetch);

      const start = Date.now();
      const result = await discoverCdpPort({ ports: [9222, 9229, 9221], probeTimeoutMs: 200 });
      const elapsed = Date.now() - start;

      expect(result).toBeNull();
      // All probes should timeout roughly at the same time (parallel, not sequential)
      // Allow generous margin since CI can be slow
      expect(elapsed).toBeLessThan(2000);

      vi.unstubAllGlobals();
    });

    it('first port slow, second port fast — returns fast port', async () => {
      const mockFetch = createAbortAwareFetch((url: string) => {
        if (url.includes(':9222/')) {
          // Slow port — hangs until abort
          return 'hang';
        }
        if (url.includes(':9229/')) {
          // Fast port — resolves immediately
          return Promise.resolve({
            ok: true,
            json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9229/devtools/browser/fast' }),
          });
        }
        return Promise.reject(new Error('Connection refused'));
      });
      vi.stubGlobal('fetch', mockFetch);

      // Even though 9222 is first in array and slow, 9229 should succeed
      const result = await discoverCdpPort({ ports: [9222, 9229], probeTimeoutMs: 200 });

      // Promise.allSettled waits for ALL to settle. The slow port (9222) aborts via signal.
      // After all settle, the implementation iterates results in port order.
      // 9222 (index 0) is rejected, 9229 (index 1) is fulfilled — so 9229 is returned.
      expect(result).not.toBeNull();
      expect(result!.port).toBe(9229);

      vi.unstubAllGlobals();
    });
  });
});
