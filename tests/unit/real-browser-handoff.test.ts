import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSpawn = vi.fn();
const mockExecFileSync = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

import {
  cleanupOwnedBrowserLaunches,
  cleanupOwnedBrowserLaunchesSync,
  launchManagedChrome,
  listOwnedBrowserLaunchMetadata,
  writeOwnedBrowserLaunchMetadata,
} from '../../src/browser/real-browser-handoff.js';

describe('real-browser-handoff', () => {
  let profileDir: string;
  let dataDir: string;
  let processAlive: boolean;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schrute-handoff-'));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schrute-owned-launches-'));
    processAlive = true;
    mockExecFileSync.mockImplementation((command: string) => {
      if (command === 'which') {
        return '/usr/bin/google-chrome\n';
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    mockSpawn.mockReturnValue({
      pid: 12345,
      unref: vi.fn(),
    });
    killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0 || signal === undefined) {
        if (!processAlive) {
          const err = Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
          throw err;
        }
        return true;
      }
      if (pid === 12345 && (signal === 'SIGTERM' || signal === 'SIGKILL')) {
        processAlive = false;
      }
      return true;
    }) as typeof process.kill);
  });

  afterEach(() => {
    killSpy.mockRestore();
    vi.useRealTimers();
    vi.clearAllMocks();
    fs.rmSync(profileDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('kills Chrome and removes metadata when DevToolsActivePort never appears', async () => {
    const launchPromise = launchManagedChrome({
      config: {} as any,
      siteId: 'example.com',
      url: 'https://example.com',
      profileDir,
    });
    const launchExpectation = expect(launchPromise).rejects.toThrow(
      `Timed out waiting for DevToolsActivePort in ${profileDir}`,
    );

    await vi.advanceTimersByTimeAsync(6000);

    await launchExpectation;
    expect(
      killSpy.mock.calls.some(([pid, signal]) => Math.abs(Number(pid)) === 12345 && signal === 'SIGTERM'),
    ).toBe(true);
    expect(fs.existsSync(path.join(profileDir, 'chrome.pid'))).toBe(false);
    expect(fs.existsSync(path.join(profileDir, 'chrome.meta.json'))).toBe(false);
  });

  it('does not kill owned launches when process start time cannot be revalidated', async () => {
    writeOwnedBrowserLaunchMetadata({ dataDir } as any, {
      pid: 12345,
      createdAt: Date.now() - 5000,
    });

    mockExecFileSync.mockImplementation((command: string, args?: string[]) => {
      if (command === 'ps' && args?.includes('lstart=')) {
        throw new Error('process start time unavailable');
      }
      if (command === 'ps' && args?.includes('command=')) {
        return '/usr/bin/chrome-headless-shell\n';
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    await cleanupOwnedBrowserLaunches({ dataDir } as any);

    expect(
      killSpy.mock.calls.some(([pid, signal]) => pid === 12345 && (signal === 'SIGTERM' || signal === 'SIGKILL')),
    ).toBe(false);
    expect(listOwnedBrowserLaunchMetadata({ dataDir } as any)).toEqual([]);
  });

  it('sync cleanup removes stale metadata without killing a reused pid', () => {
    writeOwnedBrowserLaunchMetadata({ dataDir } as any, {
      pid: 12345,
      createdAt: Date.parse('2026-03-20T10:00:00.000Z'),
      commandHint: 'chrome-headless-shell',
    });

    mockExecFileSync.mockImplementation((command: string, args?: string[]) => {
      if (command === 'ps' && args?.includes('lstart=')) {
        return 'Sat Mar 22 10:00:00 2026\n';
      }
      if (command === 'ps' && args?.includes('command=')) {
        return '/usr/bin/chrome-headless-shell --type=renderer\n';
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    cleanupOwnedBrowserLaunchesSync({ dataDir } as any);

    expect(
      killSpy.mock.calls.some(([pid, signal]) => pid === 12345 && (signal === 'SIGTERM' || signal === 'SIGKILL')),
    ).toBe(false);
    expect(listOwnedBrowserLaunchMetadata({ dataDir } as any)).toEqual([]);
  });
});
