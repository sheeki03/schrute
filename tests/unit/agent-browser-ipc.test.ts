import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock logger
vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock child_process
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

// Track created sockets for assertions
let lastMockSocket: MockSocket;

class MockSocket extends EventEmitter {
  destroyed = false;
  write = vi.fn((_data: string, cb?: (err?: Error) => void) => {
    if (cb) cb();
    return true;
  });
  destroy = vi.fn(() => {
    this.destroyed = true;
  });
}

// Mock net.createConnection
vi.mock('node:net', () => ({
  createConnection: vi.fn((_path: string, connectCb: () => void) => {
    const sock = new MockSocket();
    lastMockSocket = sock;
    // Simulate async connection
    process.nextTick(() => connectCb());
    return sock;
  }),
}));

import { AgentBrowserIpcClient, resolveSocketDir } from '../../src/browser/agent-browser-ipc.js';
import { execFile } from 'node:child_process';

describe('resolveSocketDir', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('prefers AGENT_BROWSER_SOCKET_DIR', () => {
    process.env.AGENT_BROWSER_SOCKET_DIR = '/custom/sock';
    expect(resolveSocketDir()).toBe('/custom/sock');
  });

  it('falls back to XDG_RUNTIME_DIR/agent-browser', () => {
    delete process.env.AGENT_BROWSER_SOCKET_DIR;
    process.env.XDG_RUNTIME_DIR = '/run/user/1000';
    expect(resolveSocketDir()).toBe('/run/user/1000/agent-browser');
  });

  it('falls back to ~/.agent-browser', () => {
    delete process.env.AGENT_BROWSER_SOCKET_DIR;
    delete process.env.XDG_RUNTIME_DIR;
    const expected = path.join(os.homedir(), '.agent-browser');
    expect(resolveSocketDir()).toBe(expected);
  });
});

describe('AgentBrowserIpcClient', () => {
  let client: AgentBrowserIpcClient;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new AgentBrowserIpcClient();
  });

  afterEach(() => {
    vi.useRealTimers();
    try { client.close(); } catch { /* expected */ }
  });

  it('isConnected returns false before connect', () => {
    expect(client.isConnected()).toBe(false);
  });

  it('connects to socket and reports connected', async () => {
    await client.connect('test-session');
    expect(client.isConnected()).toBe(true);
  });

  it('send rejects when not connected', async () => {
    await expect(client.send({ action: 'url' }))
      .rejects.toThrow('Socket not connected');
  });

  it('sends JSON command and resolves on success response', async () => {
    await client.connect('test-session');

    const sendPromise = client.send({ action: 'url' });

    // Simulate response from socket
    const response = JSON.stringify({ id: '1', success: true, data: { url: 'https://example.com' } }) + '\n';
    lastMockSocket.emit('data', Buffer.from(response));

    const result = await sendPromise;
    expect(result).toEqual({ url: 'https://example.com' });

    // Verify the write call
    expect(lastMockSocket.write).toHaveBeenCalledWith(
      expect.stringContaining('"action":"url"'),
      expect.any(Function),
    );
  });

  it('rejects on error response', async () => {
    await client.connect('test-session');

    const sendPromise = client.send({ action: 'bad' });

    const response = JSON.stringify({ id: '1', success: false, error: 'Unknown action' }) + '\n';
    lastMockSocket.emit('data', Buffer.from(response));

    await expect(sendPromise).rejects.toThrow('Unknown action');
  });

  it('times out after specified duration', async () => {
    await client.connect('test-session');

    const sendPromise = client.send({ action: 'slow' }, 5000);

    // Advance past timeout
    vi.advanceTimersByTime(5001);

    await expect(sendPromise).rejects.toThrow('timed out');
  });

  it('rejects ALL pending requests on socket close', async () => {
    await client.connect('test-session');

    const p1 = client.send({ action: 'first' });
    const p2 = client.send({ action: 'second' });

    // Socket closes unexpectedly
    lastMockSocket.emit('close');

    await expect(p1).rejects.toThrow('Socket closed');
    await expect(p2).rejects.toThrow('Socket closed');
  });

  it('rejects ALL pending requests on socket error', async () => {
    await client.connect('test-session');

    const p1 = client.send({ action: 'first' });
    const p2 = client.send({ action: 'second' });

    // Socket error
    lastMockSocket.emit('error', new Error('Connection reset'));

    await expect(p1).rejects.toThrow('Socket error');
    await expect(p2).rejects.toThrow('Socket error');
  });

  it('handles multiple responses in a single chunk', async () => {
    await client.connect('test-session');

    const p1 = client.send({ action: 'a' });
    const p2 = client.send({ action: 'b' });

    const combined =
      JSON.stringify({ id: '1', success: true, data: 'first' }) + '\n' +
      JSON.stringify({ id: '2', success: true, data: 'second' }) + '\n';
    lastMockSocket.emit('data', Buffer.from(combined));

    expect(await p1).toBe('first');
    expect(await p2).toBe('second');
  });

  it('handles partial responses across chunks', async () => {
    await client.connect('test-session');

    const p1 = client.send({ action: 'a' });

    const full = JSON.stringify({ id: '1', success: true, data: 'done' }) + '\n';
    const half1 = full.slice(0, 10);
    const half2 = full.slice(10);

    lastMockSocket.emit('data', Buffer.from(half1));
    lastMockSocket.emit('data', Buffer.from(half2));

    expect(await p1).toBe('done');
  });

  it('bootstrapDaemon calls execFile with correct args', async () => {
    const mockExecFile = vi.mocked(execFile);
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      if (cb) cb(null, '', '');
      return {} as any;
    });

    await client.bootstrapDaemon('my-session');

    expect(mockExecFile).toHaveBeenCalledWith(
      'agent-browser',
      ['--session', 'my-session', '--json', 'open', 'about:blank'],
      expect.objectContaining({ timeout: 30000 }),
      expect.any(Function),
    );
  });

  it('bootstrapDaemon rejects on execFile error', async () => {
    const mockExecFile = vi.mocked(execFile);
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      if (cb) cb(new Error('not found'));
      return {} as any;
    });

    await expect(client.bootstrapDaemon('bad'))
      .rejects.toThrow('Failed to bootstrap agent-browser');
  });

  it('close sets isConnected to false', async () => {
    await client.connect('test-session');
    expect(client.isConnected()).toBe(true);
    client.close();
    expect(client.isConnected()).toBe(false);
  });

  it('uses incrementing IDs for commands', async () => {
    await client.connect('test-session');

    const p1 = client.send({ action: 'a' }).catch(() => {});
    const p2 = client.send({ action: 'b' }).catch(() => {});

    const calls = lastMockSocket.write.mock.calls;
    const parsed1 = JSON.parse(calls[0][0]);
    const parsed2 = JSON.parse(calls[1][0].replace('\n', ''));
    expect(parseInt(parsed1.id)).toBeLessThan(parseInt(parsed2.id));

    // Resolve pending
    lastMockSocket.emit('close');
    await Promise.all([p1, p2]);
  });
});
