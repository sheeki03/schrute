import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { getLogger } from '../core/logger.js';
import type { Browser } from 'playwright';

const log = getLogger();

export interface CdpConnectionOptions {
  wsEndpoint?: string;
  port?: number;
  host?: string;
  autoDiscover?: boolean;
}

const COMMON_CDP_PORTS = [9222, 9229, 9221, 9223, 9224, 9225, 9226, 9230];

const DISCOVERY_TIMEOUT_MS = 5000;
const MAX_DISCOVERY_RETRIES = 2;
const DISCOVERY_BACKOFF_MS = 1000;

/**
 * Connect to an existing browser (Electron, Chrome, etc.) via Chrome DevTools Protocol.
 *
 * Discovers the WebSocket endpoint via /json/version if not provided directly.
 */
export async function connectViaCDP(options: CdpConnectionOptions): Promise<Browser> {
  const host = options.host ?? '127.0.0.1';

  if (options.port !== undefined) {
    if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) {
      throw new Error(`Invalid CDP port: ${options.port}. Must be an integer between 1024 and 65535.`);
    }
  }

  let wsEndpoint = options.wsEndpoint;

  // Discover wsEndpoint via /json/version if not provided
  if (!wsEndpoint) {
    if (options.port) {
      wsEndpoint = await discoverWsEndpoint(host, options.port);
    } else if (options.autoDiscover) {
      const found = await discoverCdpPort({ host });
      if (!found) {
        throw new Error(
          `No Chrome debugging endpoint found. Scanned ports: ${COMMON_CDP_PORTS.join(', ')}. ` +
          'Enable remote debugging at chrome://inspect/#remote-debugging, or provide an explicit port/wsEndpoint.'
        );
      }
      wsEndpoint = found.wsEndpoint;
      log.info({ port: found.port }, 'Auto-discovered CDP endpoint');
    } else {
      throw new Error('Either wsEndpoint, port, or autoDiscover must be provided.');
    }
  }

  const { chromium } = await import('playwright');
  log.info({ wsEndpoint }, 'Connecting to browser via CDP');
  const browser = await chromium.connectOverCDP(wsEndpoint);
  log.info('CDP connection established');
  return browser;
}

function readDevToolsActivePort(host: string): { wsEndpoint: string; port: number } | null {
  const CHROME_DATA_DIRS: Record<string, string[]> = {
    darwin: [
      '~/Library/Application Support/Google/Chrome',
      '~/Library/Application Support/Chromium',
      '~/Library/Application Support/BraveSoftware/Brave-Browser',
    ],
    linux: [
      '~/.config/google-chrome',
      '~/.config/chromium',
      '~/.config/BraveSoftware/Brave-Browser',
    ],
  };
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  for (const dir of CHROME_DATA_DIRS[platform] ?? []) {
    const portFile = path.join(dir.replace('~', os.homedir()), 'DevToolsActivePort');
    try {
      const lines = fs.readFileSync(portFile, 'utf-8').trim().split('\n');
      if (lines.length >= 2) {
        const port = parseInt(lines[0], 10);
        const wsPath = lines[1];
        if (port > 0 && wsPath) return { wsEndpoint: `ws://${host}:${port}${wsPath}`, port };
      }
    } catch { /* file doesn't exist or unreadable */ }
  }
  return null;
}

export async function discoverCdpPort(
  options?: { host?: string; ports?: number[]; probeTimeoutMs?: number },
): Promise<{ wsEndpoint: string; port: number } | null> {
  const host = options?.host ?? '127.0.0.1';
  const ports = options?.ports ?? COMMON_CDP_PORTS;
  const timeout = options?.probeTimeoutMs ?? 1000;

  const results = await Promise.allSettled(
    ports.map(async (port) => {
      const url = `http://${host}:${port}/json/version`;
      const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { webSocketDebuggerUrl?: string };
      if (!data.webSocketDebuggerUrl) throw new Error('No webSocketDebuggerUrl');
      return { wsEndpoint: data.webSocketDebuggerUrl, port };
    }),
  );

  for (const result of results) {
    if (result.status === 'fulfilled') return result.value;
  }

  // 2. Fallback: DevToolsActivePort file (works for custom --user-data-dir launches only)
  const portFileResult = readDevToolsActivePort(host);
  if (portFileResult) return portFileResult;

  return null;
}

async function discoverWsEndpoint(host: string, port: number): Promise<string> {
  const url = `http://${host}:${port}/json/version`;

  for (let attempt = 0; attempt <= MAX_DISCOVERY_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, DISCOVERY_BACKOFF_MS));
    }

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`Discovery endpoint returned HTTP ${response.status}`);
      }

      const data = await response.json() as { webSocketDebuggerUrl?: string };
      if (!data.webSocketDebuggerUrl) {
        throw new Error('Discovery response missing webSocketDebuggerUrl');
      }

      return data.webSocketDebuggerUrl;
    } catch (err) {
      log.warn({ attempt, url, err }, 'CDP discovery attempt failed');
      if (attempt === MAX_DISCOVERY_RETRIES) {
        throw new Error(
          `Failed to discover CDP endpoint at ${url} after ${MAX_DISCOVERY_RETRIES + 1} attempts: ` +
          `${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  // Unreachable, but TypeScript needs it
  throw new Error('CDP discovery failed');
}
