import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock playwright.chromium.connectOverCDP
const mockConnectOverCDP = vi.fn();
vi.mock('playwright', () => ({
  chromium: {
    connectOverCDP: (...args: any[]) => mockConnectOverCDP(...args),
  },
}));

import { connectViaCDP } from '../../src/browser/cdp-connector.js';

describe('CDP Connector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('connects with explicit wsEndpoint', async () => {
    const mockBrowser = { isConnected: () => true };
    mockConnectOverCDP.mockResolvedValue(mockBrowser);

    const result = await connectViaCDP({ wsEndpoint: 'ws://127.0.0.1:9222/devtools/browser/abc' });

    expect(result).toBe(mockBrowser);
    expect(mockConnectOverCDP).toHaveBeenCalledWith('ws://127.0.0.1:9222/devtools/browser/abc');
  });

  it('rejects port below 1024', async () => {
    await expect(connectViaCDP({ port: 80 })).rejects.toThrow(/Invalid CDP port.*1024/);
  });

  it('rejects port above 65535', async () => {
    await expect(connectViaCDP({ port: 70000 })).rejects.toThrow(/Invalid CDP port.*1024/);
  });

  it('rejects non-integer port', async () => {
    await expect(connectViaCDP({ port: 1234.5 })).rejects.toThrow(/Invalid CDP port/);
  });

  it('requires either wsEndpoint or port', async () => {
    await expect(connectViaCDP({})).rejects.toThrow(/Either wsEndpoint, port, or autoDiscover/);
  });

  it('host defaults to 127.0.0.1', async () => {
    // Mock fetch for discovery
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    mockConnectOverCDP.mockResolvedValue({ isConnected: () => true });

    await connectViaCDP({ port: 9222 });

    // Verify discovery used 127.0.0.1
    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9222/json/version',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    vi.unstubAllGlobals();
  });

  it('discovers wsEndpoint via /json/version with retries', async () => {
    // First attempt fails, second succeeds
    const mockFetch = vi.fn()
      .mockRejectedValueOnce(new Error('Connection refused'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/found' }),
      });
    vi.stubGlobal('fetch', mockFetch);

    mockConnectOverCDP.mockResolvedValue({ isConnected: () => true });

    const result = await connectViaCDP({ port: 9222 });

    expect(result).toBeDefined();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockConnectOverCDP).toHaveBeenCalledWith('ws://127.0.0.1:9222/devtools/browser/found');

    vi.unstubAllGlobals();
  });

  it('fails after exhausting all retries', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Connection refused'));
    vi.stubGlobal('fetch', mockFetch);

    await expect(connectViaCDP({ port: 9222 })).rejects.toThrow(/Failed to discover CDP endpoint/);

    // 3 attempts total (0, 1, 2)
    expect(mockFetch).toHaveBeenCalledTimes(3);

    vi.unstubAllGlobals();
  });

  it('handles missing webSocketDebuggerUrl in discovery response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}), // no webSocketDebuggerUrl
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(connectViaCDP({ port: 9222 })).rejects.toThrow(/Failed to discover CDP endpoint/);

    vi.unstubAllGlobals();
  });
});
