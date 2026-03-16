import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { getLogger } from '../core/logger.js';

const log = getLogger();

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Resolve the socket directory used by agent-browser.
 * Precedence: AGENT_BROWSER_SOCKET_DIR > XDG_RUNTIME_DIR/agent-browser > ~/.agent-browser > tmpdir
 */
export function resolveSocketDir(): string {
  if (process.env.AGENT_BROWSER_SOCKET_DIR) return process.env.AGENT_BROWSER_SOCKET_DIR;
  if (process.env.XDG_RUNTIME_DIR) return path.join(process.env.XDG_RUNTIME_DIR, 'agent-browser');
  const home = os.homedir();
  if (home) return path.join(home, '.agent-browser');
  return path.join(os.tmpdir(), 'agent-browser');
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface IpcResponse {
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Socket IPC client for agent-browser daemon.
 * Protocol: newline-delimited JSON.
 * Send: {id, action, ...params}\n
 * Recv: {id, success, data} or {id, success: false, error}
 */
export class AgentBrowserIpcClient {
  private socket: net.Socket | null = null;
  private pending = new Map<string, PendingRequest>();
  private counter = 0;
  private buffer = '';
  private sessionName = '';

  /**
   * Bootstrap the agent-browser daemon for a session.
   * Spawns `agent-browser --session {name} --json open about:blank` via execFile (not shell).
   */
  bootstrapDaemon(sessionName: string): Promise<void> {
    this.sessionName = sessionName;
    return new Promise<void>((resolve, reject) => {
      const child = execFile(
        'agent-browser',
        ['--session', sessionName, '--json', 'open', 'about:blank'],
        { timeout: DEFAULT_TIMEOUT_MS },
        (err) => {
          if (err) {
            reject(new Error(`Failed to bootstrap agent-browser: ${err.message}`));
          } else {
            resolve();
          }
        },
      );
      child.stdin?.end();
    });
  }

  /**
   * Connect to the Unix socket for a named session.
   */
  connect(sessionName: string): Promise<void> {
    this.sessionName = sessionName;
    const socketPath = path.join(resolveSocketDir(), `${sessionName}.sock`);

    return new Promise<void>((resolve, reject) => {
      const sock = net.createConnection(socketPath, () => {
        this.socket = sock;
        resolve();
      });

      sock.on('error', (err) => {
        this.rejectAllPending(new Error(`Socket error: ${err.message}`));
        this.socket = null;
      });

      sock.on('close', () => {
        this.rejectAllPending(new Error('Socket closed'));
        this.socket = null;
      });

      sock.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString('utf-8');
        this.drainBuffer();
      });

      // If initial connection fails, reject the connect promise
      sock.once('error', (err) => {
        reject(new Error(`Failed to connect to socket ${socketPath}: ${err.message}`));
      });
    });
  }

  /**
   * Send a command and wait for the correlated response.
   */
  send(command: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (!this.socket || this.socket.destroyed) {
      return Promise.reject(new Error('Socket not connected'));
    }

    const id = String(++this.counter);
    const payload = JSON.stringify({ id, ...command }) + '\n';

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Command ${command.action} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      this.socket!.write(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error(`Socket write failed: ${err.message}`));
        }
      });
    });
  }

  /**
   * Close the socket connection.
   */
  close(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.rejectAllPending(new Error('Client closed'));
  }

  /**
   * Whether the socket is currently connected.
   */
  isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  // ─── Internal ──────────────────────────────────────────────────────

  private drainBuffer(): void {
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (!line) continue;

      try {
        const msg = JSON.parse(line) as IpcResponse;
        const entry = this.pending.get(msg.id);
        if (!entry) {
          log.debug({ id: msg.id }, 'Received response for unknown request id');
          continue;
        }

        clearTimeout(entry.timer);
        this.pending.delete(msg.id);

        if (msg.success) {
          entry.resolve(msg.data);
        } else {
          entry.reject(new Error(msg.error ?? 'Unknown IPC error'));
        }
      } catch (err) {
        log.debug({ line, err }, 'Failed to parse IPC response');
      }
    }
  }

  /**
   * Reject and clear ALL pending requests — called on socket close/error
   * so in-flight calls don't sit until the 30s timeout.
   */
  private rejectAllPending(reason: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    this.pending.clear();
  }
}
