import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getBrowserDataDir } from '../core/config.js';
import type { SchruteConfig } from '../skill/types.js';

const CHROME_PID_FILE = 'chrome.pid';
const CHROME_META_FILE = 'chrome.meta.json';
const OWNED_LAUNCH_DIR = 'owned-launches';

export interface OwnedBrowserLaunchMetadata {
  pid: number;
  createdAt: number;
  engine?: string;
  sessionName?: string;
  commandHint?: string;
}

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

export function getOwnedBrowserLaunchRoot(config: SchruteConfig): string {
  return path.join(getBrowserDataDir(config), OWNED_LAUNCH_DIR);
}

function getOwnedBrowserLaunchPath(config: SchruteConfig, pid: number): string {
  return path.join(getOwnedBrowserLaunchRoot(config), `${pid}.json`);
}

export function writeOwnedBrowserLaunchMetadata(
  config: SchruteConfig,
  metadata: OwnedBrowserLaunchMetadata,
): void {
  const root = getOwnedBrowserLaunchRoot(config);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(getOwnedBrowserLaunchPath(config, metadata.pid), JSON.stringify(metadata), { mode: 0o600 });
}

export function removeOwnedBrowserLaunchMetadata(config: SchruteConfig, pid: number): void {
  try {
    fs.rmSync(getOwnedBrowserLaunchPath(config, pid), { force: true });
  } catch {
    // Best effort.
  }
}

export function listOwnedBrowserLaunchMetadata(config: SchruteConfig): OwnedBrowserLaunchMetadata[] {
  const root = getOwnedBrowserLaunchRoot(config);
  if (!fs.existsSync(root)) return [];

  const entries: OwnedBrowserLaunchMetadata[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(root, entry.name), 'utf-8')) as Partial<OwnedBrowserLaunchMetadata>;
      if (typeof raw.pid !== 'number' || !Number.isInteger(raw.pid)) continue;
      entries.push({
        pid: raw.pid,
        createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
        ...(typeof raw.engine === 'string' ? { engine: raw.engine } : {}),
        ...(typeof raw.sessionName === 'string' ? { sessionName: raw.sessionName } : {}),
        ...(typeof raw.commandHint === 'string' ? { commandHint: raw.commandHint } : {}),
      });
    } catch {
      // Skip malformed metadata.
    }
  }
  return entries;
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

function readProcessStartTimeMs(pid: number): number | null {
  try {
    if (process.platform === 'win32') {
      const isoTimestamp = execFileSync('powershell', [
        '-NoProfile',
        '-Command',
        `$p = Get-Process -Id ${pid} -ErrorAction Stop; $p.StartTime.ToUniversalTime().ToString('o')`,
      ], { encoding: 'utf-8' }).trim();
      const parsed = Date.parse(isoTimestamp);
      return Number.isFinite(parsed) ? parsed : null;
    }

    const raw = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf-8' })
      .trim()
      .replace(/\s+/g, ' ');
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const OWNED_LAUNCH_START_TIME_TOLERANCE_MS = 120_000;

function canRevalidateOwnedBrowserLaunch(metadata: OwnedBrowserLaunchMetadata): boolean {
  const startTimeMs = readProcessStartTimeMs(metadata.pid);
  if (startTimeMs == null) {
    return false;
  }

  if (Math.abs(startTimeMs - metadata.createdAt) > OWNED_LAUNCH_START_TIME_TOLERANCE_MS) {
    return false;
  }

  const commandLine = readProcessCommandLine(metadata.pid);
  if (metadata.commandHint && commandLine && !commandLine.includes(metadata.commandHint)) {
    return false;
  }

  return true;
}

function listUnixDescendantPids(pid: number): number[] {
  try {
    const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf-8' })
      .trim()
      .split(/\r?\n/)
      .map(line => line.trim().split(/\s+/, 2).map(Number))
      .filter(parts => parts.length === 2 && Number.isInteger(parts[0]) && Number.isInteger(parts[1]))
      .map(([childPid, parentPid]) => ({ childPid, parentPid }));

    const byParent = new Map<number, number[]>();
    for (const row of rows) {
      const children = byParent.get(row.parentPid) ?? [];
      children.push(row.childPid);
      byParent.set(row.parentPid, children);
    }

    const descendants: number[] = [];
    const stack = [...(byParent.get(pid) ?? [])];
    while (stack.length > 0) {
      const current = stack.pop()!;
      descendants.push(current);
      const children = byParent.get(current);
      if (children) stack.push(...children);
    }
    return descendants;
  } catch {
    return [];
  }
}

function signalUnixTree(pid: number, signal: NodeJS.Signals, detachedProcessGroup: boolean): void {
  if (detachedProcessGroup) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to explicit child traversal.
    }
  }

  const descendants = listUnixDescendantPids(pid);
  for (const childPid of descendants.reverse()) {
    try { process.kill(childPid, signal); } catch { /* best effort */ }
  }
  try { process.kill(pid, signal); } catch { /* best effort */ }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return !isProcessAlive(pid);
}

export async function terminateProcessTree(
  pid: number,
  options?: { detachedProcessGroup?: boolean },
): Promise<void> {
  if (!isProcessAlive(pid)) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
    } catch {
      // Best effort.
    }
    return;
  }

  signalUnixTree(pid, 'SIGTERM', options?.detachedProcessGroup === true);
  if (await waitForProcessExit(pid, 1000)) return;
  signalUnixTree(pid, 'SIGKILL', options?.detachedProcessGroup === true);
}

export function terminateProcessTreeSync(
  pid: number,
  options?: { detachedProcessGroup?: boolean },
): void {
  if (!isProcessAlive(pid)) return;

  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
    } catch {
      // Best effort.
    }
    return;
  }

  signalUnixTree(pid, 'SIGTERM', options?.detachedProcessGroup === true);
  signalUnixTree(pid, 'SIGKILL', options?.detachedProcessGroup === true);
}

export async function terminateManagedChrome(pid: number): Promise<void> {
  await terminateProcessTree(pid, { detachedProcessGroup: process.platform !== 'win32' });
}

export function terminateManagedChromeSync(pid: number): void {
  terminateProcessTreeSync(pid, { detachedProcessGroup: process.platform !== 'win32' });
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

/**
 * Synchronous best-effort cleanup — sends SIGTERM to all managed Chrome processes.
 * Designed for `process.on('exit')` where only synchronous code can run.
 * Does NOT wait for processes to die (can't await in exit handler).
 */
export function cleanupManagedChromeLaunchesSync(config: SchruteConfig): void {
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
    terminateManagedChromeSync(pid);
    removeManagedChromeMetadata(profileDir);
  }
}

export async function cleanupOwnedBrowserLaunches(config: SchruteConfig): Promise<void> {
  for (const metadata of listOwnedBrowserLaunchMetadata(config)) {
    if (!isProcessAlive(metadata.pid)) {
      removeOwnedBrowserLaunchMetadata(config, metadata.pid);
      continue;
    }

    // Never kill a reused PID unless we can positively re-establish ownership.
    if (!canRevalidateOwnedBrowserLaunch(metadata)) {
      removeOwnedBrowserLaunchMetadata(config, metadata.pid);
      continue;
    }

    await terminateProcessTree(metadata.pid);
    removeOwnedBrowserLaunchMetadata(config, metadata.pid);
  }
}

export function cleanupOwnedBrowserLaunchesSync(config: SchruteConfig): void {
  for (const metadata of listOwnedBrowserLaunchMetadata(config)) {
    if (!isProcessAlive(metadata.pid)) {
      removeOwnedBrowserLaunchMetadata(config, metadata.pid);
      continue;
    }

    // Exit-handler cleanup stays best-effort, but it still must prove ownership.
    if (!canRevalidateOwnedBrowserLaunch(metadata)) {
      removeOwnedBrowserLaunchMetadata(config, metadata.pid);
      continue;
    }

    terminateProcessTreeSync(metadata.pid);
    removeOwnedBrowserLaunchMetadata(config, metadata.pid);
  }
}
