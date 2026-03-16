import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { AgentBrowserProvider } from '../../src/browser/agent-browser-provider.js';
import type { AgentBrowserIpcClient } from '../../src/browser/agent-browser-ipc.js';
import type { SealedFetchRequest } from '../../src/skill/types.js';

function makeIpc(overrides: Partial<AgentBrowserIpcClient> = {}): AgentBrowserIpcClient {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    bootstrapDaemon: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as AgentBrowserIpcClient;
}

function makeReq(overrides: Partial<SealedFetchRequest> = {}): SealedFetchRequest {
  return {
    url: 'https://example.com/api/users',
    method: 'GET',
    headers: {},
    ...overrides,
  } as SealedFetchRequest;
}

describe('AgentBrowserProvider.evaluateFetch', () => {
  describe('domain rejection includes allowlist', () => {
    it('includes allowed domains in rejection message', async () => {
      const ipc = makeIpc();
      const provider = new AgentBrowserProvider(ipc, ['allowed.com', 'other.com']);

      const result = await provider.evaluateFetch(makeReq({ url: 'https://evil.com/steal' }));

      expect(result.status).toBe(0);
      expect(result.body).toContain('evil.com');
      expect(result.body).toContain('not in allowed list');
      expect(result.body).toContain('[allowed.com, other.com]');
    });
  });

  describe('IPC send failure', () => {
    it('returns agent-browser IPC failed with error message', async () => {
      const ipc = makeIpc({
        send: vi.fn().mockRejectedValue(new Error('Socket not connected')),
      });
      const provider = new AgentBrowserProvider(ipc, ['example.com']);

      const result = await provider.evaluateFetch(makeReq());

      expect(result.status).toBe(0);
      expect(result.body).toContain('agent-browser IPC failed');
      expect(result.body).toContain('Socket not connected');
    });

    it('handles non-Error IPC rejection', async () => {
      const ipc = makeIpc({
        send: vi.fn().mockRejectedValue('raw string error'),
      });
      const provider = new AgentBrowserProvider(ipc, ['example.com']);

      const result = await provider.evaluateFetch(makeReq());

      expect(result.status).toBe(0);
      expect(result.body).toContain('agent-browser IPC failed');
      expect(result.body).toContain('raw string error');
    });
  });

  describe('JSON parse failure', () => {
    it('returns truncated raw response on parse failure', async () => {
      const ipc = makeIpc({
        send: vi.fn().mockResolvedValue('not-valid-json{{{'),
      });
      const provider = new AgentBrowserProvider(ipc, ['example.com']);

      const result = await provider.evaluateFetch(makeReq());

      expect(result.status).toBe(0);
      expect(result.body).toContain('Failed to parse IPC response');
      expect(result.body).toContain('not-valid-json{{{');
    });

    it('truncates long raw response to 500 chars', async () => {
      const longResponse = 'x'.repeat(1000);
      const ipc = makeIpc({
        send: vi.fn().mockResolvedValue(longResponse),
      });
      const provider = new AgentBrowserProvider(ipc, ['example.com']);

      const result = await provider.evaluateFetch(makeReq());

      expect(result.status).toBe(0);
      expect(result.body).toContain('Failed to parse IPC response');
      // The raw value portion should be truncated to 500 chars
      const rawPart = result.body!.replace('Failed to parse IPC response: ', '');
      expect(rawPart.length).toBe(500);
    });
  });

  describe('successful fetch', () => {
    it('parses valid JSON response from IPC', async () => {
      const fetchResponse = JSON.stringify({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' });
      const ipc = makeIpc({
        send: vi.fn().mockResolvedValue(fetchResponse),
      });
      const provider = new AgentBrowserProvider(ipc, ['example.com']);

      const result = await provider.evaluateFetch(makeReq());

      expect(result.status).toBe(200);
      expect(result.headers).toEqual({ 'content-type': 'application/json' });
      expect(result.body).toBe('{"ok":true}');
    });
  });
});
