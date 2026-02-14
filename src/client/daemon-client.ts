import * as http from 'node:http';
import * as fs from 'node:fs';
import * as net from 'node:net';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import {
  getDaemonSocketPath,
  getDaemonPidPath,
  getDaemonTokenPath,
} from '../core/config.js';
import { getLogger } from '../core/logger.js';
import type { OneAgentConfig } from '../skill/types.js';
import type { PidFileContent, TransportConfig } from '../shared/daemon-types.js';

const log = getLogger();

const CLIENT_API_VERSION = 1;
const AUTO_START_POLL_INTERVAL_MS = 500;
const AUTO_START_TIMEOUT_MS = 10000;

// ─── Types ──────────────────────────────────────────────────────

export interface DaemonClient {
  request(method: string, path: string, body?: unknown): Promise<unknown>;
  isAvailable(): Promise<boolean>;
}

// ─── Helpers ────────────────────────────────────────────────────

function readPidFile(pidPath: string): PidFileContent | null {
  try {
    if (!fs.existsSync(pidPath)) return null;
    const raw = fs.readFileSync(pidPath, 'utf-8');
    return JSON.parse(raw) as PidFileContent;
  } catch (err) {
    log.warn({ err, pidPath }, 'Failed to parse daemon PID file — treating as missing');
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanupStaleFiles(config: OneAgentConfig): void {
  const paths = [
    getDaemonPidPath(config),
    getDaemonSocketPath(config),
    getDaemonTokenPath(config),
  ];
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (err) {
      log.warn({ err, path: p }, 'Failed to clean up stale daemon file');
    }
  }
}

function readTokenFile(tokenPath: string): string | null {
  try {
    if (!fs.existsSync(tokenPath)) return null;
    // Verify permissions on Unix
    if (process.platform !== 'win32') {
      const stat = fs.statSync(tokenPath);
      const perms = stat.mode & 0o777;
      if (perms !== 0o600) {
        log.warn({ tokenPath, perms: `0${perms.toString(8)}` }, 'Daemon token file has insecure permissions (expected 0600) — refusing to use');
        return null;
      }
    }
    return fs.readFileSync(tokenPath, 'utf-8').trim();
  } catch (err) {
    log.warn({ err, tokenPath }, 'Failed to read daemon token file');
    return null;
  }
}

function resolveTransport(config: OneAgentConfig): TransportConfig | null {
  const socketPath = getDaemonSocketPath(config);
  const tokenPath = getDaemonTokenPath(config);

  // Prefer UDS if socket file exists
  if (fs.existsSync(socketPath)) {
    return { mode: 'uds', socketPath };
  }

  // Fall back to TCP if token file exists
  const token = readTokenFile(tokenPath);
  if (token) {
    const port = config.daemon?.port ?? 19420;
    return { mode: 'tcp', port, token };
  }

  return null;
}

function httpRequest(
  transport: TransportConfig,
  method: string,
  reqPath: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body != null ? JSON.stringify(body) : undefined;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (transport.mode === 'tcp' && transport.token) {
      headers['Authorization'] = `Bearer ${transport.token}`;
    }

    if (bodyStr) {
      headers['Content-Length'] = Buffer.byteLength(bodyStr).toString();
    }

    const options: http.RequestOptions = {
      method,
      path: reqPath,
      headers,
      timeout: 30000,
    };

    if (transport.mode === 'uds') {
      options.socketPath = transport.socketPath;
    } else {
      options.hostname = '127.0.0.1';
      options.port = transport.port;
    }

    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        try {
          const data = JSON.parse(raw);
          resolve({ status: res.statusCode ?? 0, data });
        } catch {
          resolve({ status: res.statusCode ?? 0, data: raw });
        }
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });

    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });
}

// ─── Auto-Start Helper ──────────────────────────────────────────

function resolveOneagentBin(): string {
  // 1. Prefer the package.json "bin" entry resolved via require
  try {
    const req = createRequire(import.meta.url);
    return req.resolve('oneagent/dist/index.js');
  } catch { /* not resolvable — try next */ }

  // 2. Check if argv[1] looks like the oneagent CLI (not a random host app)
  const arg1 = process.argv[1] ?? '';
  if (arg1.includes('oneagent') && !arg1.includes('node_modules/.bin/vitest')) {
    return arg1;
  }

  // 3. Fall back to npx which will find the installed bin
  return 'oneagent';
}

function spawnDaemon(): void {
  const bin = resolveOneagentBin();

  // If we resolved to the bare name 'oneagent', spawn it as an executable
  if (bin === 'oneagent') {
    const child = spawn('npx', ['oneagent', 'serve'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return;
  }

  const child = spawn(
    process.execPath,
    [bin, 'serve'],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
}

function waitForDaemon(config: OneAgentConfig): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + AUTO_START_TIMEOUT_MS;

    const poll = async () => {
      if (Date.now() > deadline) {
        resolve(false);
        return;
      }

      const pidFile = readPidFile(getDaemonPidPath(config));
      if (pidFile && isPidAlive(pidFile.pid)) {
        const transport = resolveTransport(config);
        if (transport) {
          try {
            const { status, data } = await httpRequest(transport, 'GET', '/ctl/status');
            if (status === 200) {
              // Verify apiVersion from live response
              const statusData = data as Record<string, unknown>;
              if (statusData.apiVersion !== undefined && statusData.apiVersion !== CLIENT_API_VERSION) {
                resolve(false); // Version mismatch
                return;
              }
              resolve(true);
              return;
            }
          } catch {
            // Not ready yet
          }
        }
      }

      setTimeout(poll, AUTO_START_POLL_INTERVAL_MS);
    };

    poll();
  });
}

// ─── Client Factory ─────────────────────────────────────────────

export function createDaemonClient(config: OneAgentConfig): DaemonClient {
  return {
    async isAvailable(): Promise<boolean> {
      const pidPath = getDaemonPidPath(config);
      const pidFile = readPidFile(pidPath);

      if (!pidFile) {
        return false;
      }

      // Check PID is alive — only cleanup when process is confirmed dead
      if (!isPidAlive(pidFile.pid)) {
        cleanupStaleFiles(config);
        return false;
      }

      // Check API version compatibility
      if (pidFile.apiVersion !== CLIENT_API_VERSION) {
        return false;
      }

      // Resolve transport
      const transport = resolveTransport(config);
      if (!transport) {
        // PID is alive but transport unavailable — don't cleanup, may be starting up
        return false;
      }

      // Health probe — transient failure should NOT delete live daemon files
      try {
        const { status, data } = await httpRequest(transport, 'GET', '/ctl/status');
        if (status !== 200) return false;
        // Second-stage API version check from live response
        const statusData = data as Record<string, unknown>;
        if (statusData.apiVersion !== undefined && statusData.apiVersion !== CLIENT_API_VERSION) {
          return false;
        }
        return true;
      } catch (err) {
        // Connection errors are expected when the daemon is down — treat as unavailable.
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE') {
          return false;
        }
        // For other errors, log at warn level (could be code bugs) but still return false.
        log.warn({ err }, 'Unexpected error during daemon health probe');
        return false;
      }
    },

    async request(method: string, reqPath: string, body?: unknown): Promise<unknown> {
      const pidPath = getDaemonPidPath(config);
      let pidFile = readPidFile(pidPath);

      if (!pidFile) {
        // Auto-start daemon if configured
        const daemonConfig = config.daemon;
        if (daemonConfig?.autoStart) {
          spawnDaemon();
          const started = await waitForDaemon(config);
          if (!started) {
            throw new Error('Failed to auto-start daemon (timed out). Start manually with: oneagent serve');
          }
          pidFile = readPidFile(pidPath);
          if (!pidFile) {
            throw new Error('Daemon started but PID file not found. Start manually with: oneagent serve');
          }
        } else {
          throw new Error('No daemon running. Start one with: oneagent serve');
        }
      }

      if (!isPidAlive(pidFile.pid)) {
        cleanupStaleFiles(config);
        throw new Error('Daemon process is dead (stale PID file cleaned). Start one with: oneagent serve');
      }

      if (pidFile.apiVersion !== CLIENT_API_VERSION) {
        throw new Error(
          `Daemon API version mismatch: daemon=${pidFile.apiVersion}, client=${CLIENT_API_VERSION}. ` +
          'Please restart the daemon with: oneagent serve',
        );
      }

      const transport = resolveTransport(config);
      if (!transport) {
        throw new Error('Cannot determine daemon transport. Start a daemon with: oneagent serve');
      }

      const { status, data } = await httpRequest(transport, method, reqPath, body);

      if (status === 401) {
        throw new Error('Daemon authentication failed. Token may have been rotated — restart client.');
      }

      if (status >= 400) {
        const errMsg = (data as Record<string, unknown>)?.error ?? `HTTP ${status}`;
        throw new Error(`Daemon request failed: ${errMsg}`);
      }

      return data;
    },
  };
}
