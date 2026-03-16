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

import { launchManagedChrome } from '../../src/browser/real-browser-handoff.js';

describe('real-browser-handoff', () => {
  let profileDir: string;
  let processAlive: boolean;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schrute-handoff-'));
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
    expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM');
    expect(fs.existsSync(path.join(profileDir, 'chrome.pid'))).toBe(false);
    expect(fs.existsSync(path.join(profileDir, 'chrome.meta.json'))).toBe(false);
  });
});
