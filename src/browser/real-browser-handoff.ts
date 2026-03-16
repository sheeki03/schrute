import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getBrowserDataDir } from '../core/config.js';
import type { SchruteConfig } from '../skill/types.js';

const CHROME_PID_FILE = 'chrome.pid';
const CHROME_META_FILE = 'chrome.meta.json';

export interface ManagedChromeMetadata {
  pid?: number;
  profileDir: string;
  siteId: string;
  createdAt: number;
  sessionName?: string;
  priorPolicySnapshot?: Record<string, unknown>;
}

export interface ManagedChromeLaunch {
  pid: number;
  profileDir: string;
  wsEndpoint: string;
  browserBinary: string;
}

export function getManagedChromeRoot(config: SchruteConfig): string {
  return path.join(getBrowserDataDir(config), 'live-chrome');
}

function getChromeBinaryCandidates(): string[] {
  switch (process.platform) {
    case 'darwin':
      return [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        path.join(process.env.HOME ?? '', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      ];
    case 'win32':
      return [
        path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ];
    default:
      return ['google-chrome-stable', 'google-chrome', 'chromium-browser', 'chromium'];
  }
}

export function findChromeBinary(): string | undefined {
  for (const candidate of getChromeBinaryCandidates()) {
    if (!candidate) continue;
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) {
      return candidate;
    }
    try {
      const command = process.platform === 'win32' ? 'where' : 'which';
      const resolved = execFileSync(command, [candidate], { encoding: 'utf-8' }).trim().split(/\r?\n/)[0];
      if (resolved) return resolved;
    } catch {
      // Best effort.
    }
  }
  return undefined;
}

export function readManagedChromeMetadata(profileDir: string): ManagedChromeMetadata | null {
  const metaPath = path.join(profileDir, CHROME_META_FILE);
  if (fs.existsSync(metaPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Partial<ManagedChromeMetadata>;
      if (typeof raw !== 'object' || raw === null) return null;
      return {
        profileDir,
        siteId: typeof raw.siteId === 'string' ? raw.siteId : '',
        createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
        ...(typeof raw.pid === 'number' ? { pid: raw.pid } : {}),
        ...(typeof raw.sessionName === 'string' ? { sessionName: raw.sessionName } : {}),
        ...(raw.priorPolicySnapshot && typeof raw.priorPolicySnapshot === 'object'
          ? { priorPolicySnapshot: raw.priorPolicySnapshot as Record<string, unknown> }
          : {}),
      };
    } catch {
      return null;
    }
  }

  const pidPath = path.join(profileDir, CHROME_PID_FILE);
  if (!fs.existsSync(pidPath)) {
    return null;
  }
  try {
    const pid = Number.parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    if (!Number.isInteger(pid)) return null;
    return {
      pid,
      profileDir,
      siteId: '',
      createdAt: Date.now(),
    };
  } catch {
    return null;
  }
}

export function writeManagedChromeMetadata(
  profileDir: string,
  pid: number | undefined,
  siteId: string,
  extra: Partial<Omit<ManagedChromeMetadata, 'profileDir' | 'siteId'>> = {},
): void {
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const existing = readManagedChromeMetadata(profileDir);
  const metadata: ManagedChromeMetadata = {
    ...(existing ?? {}),
    profileDir,
    siteId,
    createdAt: existing?.createdAt ?? Date.now(),
    ...extra,
    ...(typeof pid === 'number' && Number.isInteger(pid) ? { pid } : {}),
  };

  if (typeof metadata.pid === 'number' && Number.isInteger(metadata.pid)) {
    fs.writeFileSync(path.join(profileDir, CHROME_PID_FILE), String(metadata.pid), { mode: 0o600 });
  } else {
    try {
      fs.rmSync(path.join(profileDir, CHROME_PID_FILE), { force: true });
    } catch {
      // Best effort.
    }
  }

  fs.writeFileSync(path.join(profileDir, CHROME_META_FILE), JSON.stringify(metadata), { mode: 0o600 });
}

export function removeManagedChromeMetadata(profileDir: string): void {
  for (const filename of [CHROME_PID_FILE, CHROME_META_FILE]) {
    try {
      fs.rmSync(path.join(profileDir, filename), { force: true });
    } catch {
      // Best effort.
    }
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readProcessCommandLine(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      return execFileSync('powershell', [
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      ], { encoding: 'utf-8' }).trim() || null;
    }
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8' }).trim() || null;
  } catch {
    return null;
  }
}

export async function terminateManagedChrome(pid: number): Promise<void> {
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }

  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Best effort.
  }
}

export async function waitForDevToolsActivePort(
  profileDir: string,
  host = '127.0.0.1',
  timeoutMs = 5000,
  intervalMs = 100,
): Promise<{ port: number; wsEndpoint: string }> {
  const deadline = Date.now() + timeoutMs;
  const portFile = path.join(profileDir, 'DevToolsActivePort');

  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(portFile)) {
        const lines = fs.readFileSync(portFile, 'utf-8').trim().split('\n');
        if (lines.length >= 2) {
          const port = Number.parseInt(lines[0], 10);
          const wsPath = lines[1];
          if (Number.isInteger(port) && port > 0 && wsPath) {
            return { port, wsEndpoint: `ws://${host}:${port}${wsPath}` };
          }
        }
      }
    } catch {
      // Retry until timeout.
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for DevToolsActivePort in ${profileDir}`);
}

export async function launchManagedChrome(options: {
  config: SchruteConfig;
  siteId: string;
  url: string;
  profileDir: string;
  host?: string;
}): Promise<ManagedChromeLaunch> {
  const browserBinary = findChromeBinary();
  if (!browserBinary) {
    throw new Error('Chrome binary not found. Use schrute_connect_cdp manually to attach your existing Chrome session.');
  }

  fs.mkdirSync(options.profileDir, { recursive: true, mode: 0o700 });
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${options.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    options.url,
  ];
  const child = spawn(browserBinary, args, {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
  child.unref();

  if (!child.pid) {
    throw new Error('Chrome launch failed: missing child pid');
  }

  writeManagedChromeMetadata(options.profileDir, child.pid, options.siteId);
  let wsEndpoint: string;
  try {
    ({ wsEndpoint } = await waitForDevToolsActivePort(options.profileDir, options.host));
  } catch (err) {
    await terminateManagedChrome(child.pid);
    removeManagedChromeMetadata(options.profileDir);
    throw err;
  }
  return {
    pid: child.pid,
    profileDir: options.profileDir,
    wsEndpoint,
    browserBinary,
  };
}

export function listManagedChromeMetadata(config: SchruteConfig): ManagedChromeMetadata[] {
  const root = getManagedChromeRoot(config);
  if (!fs.existsSync(root)) return [];

  const entries: ManagedChromeMetadata[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const profileDir = path.join(root, entry.name);
    const metadata = readManagedChromeMetadata(profileDir);
    if (metadata) {
      entries.push(metadata);
    }
  }
  return entries;
}

export async function cleanupManagedChromeLaunches(config: SchruteConfig): Promise<void> {
  for (const metadata of listManagedChromeMetadata(config)) {
    const { profileDir, pid } = metadata;
    if (!pid || !Number.isInteger(pid)) {
      removeManagedChromeMetadata(profileDir);
      continue;
    }

    if (!isProcessAlive(pid)) {
      removeManagedChromeMetadata(profileDir);
      continue;
    }

    const commandLine = readProcessCommandLine(pid);
    if (commandLine && commandLine.includes(profileDir)) {
      await terminateManagedChrome(pid);
    }
    removeManagedChromeMetadata(profileDir);
  }
}
