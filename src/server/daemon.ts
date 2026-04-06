import * as http from 'node:http';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { getLogger } from '../core/logger.js';
import {
  getDaemonSocketPath,
  getDaemonPidPath,
  getDaemonTokenPath,
} from '../core/config.js';
import type { SchruteConfig } from '../skill/types.js';
import type { Engine } from '../core/engine.js';
import type { PidFileContent, TransportConfig } from '../shared/daemon-types.js';
import { verifyBearerToken } from '../shared/auth-utils.js';
import { withTimeout } from '../core/utils.js';
import type { PipelineJobInfo } from '../app/service.js';

function log() { return getLogger(); }

const DAEMON_VERSION = '0.2.0';
const API_VERSION = 1;

interface PipelineJobEngine {
  getPipelineJob(jobId: string): PipelineJobInfo | undefined;
}

function hasPipelineJobEngine(engine: Engine): engine is Engine & PipelineJobEngine {
  return typeof (engine as Partial<PipelineJobEngine>).getPipelineJob === 'function';
}

// ─── Lifecycle Lock (instance-level) ─────────────────────────────

export class LifecycleGuard {
  private lock: Promise<void> = Promise.resolve();
  private shuttingDown = false;

  withLock<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const prev = this.lock;
    this.lock = new Promise(r => { release = r; });
    return prev.then(fn).finally(() => release!());
  }

  async drainLock(): Promise<void> {
    await this.lock;
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  markShuttingDown(): boolean {
    if (this.shuttingDown) return false; // already shutting down
    this.shuttingDown = true;
    return true;
  }
}

// ─── Request Parsing ────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_BODY = 1024 * 1024; // 1MB
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

// ─── Socket Startup Safety ──────────────────────────────────────

async function validateAndCleanSocket(socketPath: string, config: SchruteConfig): Promise<void> {
  // Verify socket path is under dataDir (canonical path containment)
  const realDataDir = fs.realpathSync(config.dataDir);
  const resolvedSocket = fs.existsSync(socketPath) ? fs.realpathSync(socketPath) : path.resolve(socketPath);
  if (path.dirname(resolvedSocket) !== realDataDir) {
    throw new Error(`Socket path ${resolvedSocket} is not under dataDir ${realDataDir}`);
  }

  if (!fs.existsSync(socketPath)) {
    return;
  }

  // Verify it's actually a socket
  const stat = fs.lstatSync(socketPath);
  if (!stat.isSocket()) {
    throw new Error(`${socketPath} exists but is not a socket file`);
  }

  // Verify owned by current user (Unix only)
  if (process.platform !== 'win32') {
    if (stat.uid !== process.getuid!()) {
      throw new Error(`Socket ${socketPath} is owned by uid ${stat.uid}, not current user ${process.getuid!()}`);
    }
  }

  // Probe health of existing daemon
  const alive = await probeExistingDaemon(socketPath);
  if (alive) {
    throw new Error('Another daemon is already running on this socket');
  }

  // All checks passed — remove stale socket
  log().info({ socketPath }, 'Removing stale daemon socket');
  fs.unlinkSync(socketPath);
}

function probeExistingDaemon(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = net.createConnection({ path: socketPath }, () => {
      // Connection succeeded — something is listening
      const req = http.request({
        socketPath,
        path: '/ctl/status',
        method: 'GET',
        timeout: 2000,
      }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
      conn.end();
    });
    conn.on('error', () => resolve(false));
    conn.setTimeout(2000, () => { conn.destroy(); resolve(false); });
  });
}

// ─── TCP Fallback Helpers ───────────────────────────────────────

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function writeTokenFile(tokenPath: string, token: string, config: SchruteConfig): void {
  // Pre-write safety: reject if path exists as symlink or non-regular file
  if (fs.existsSync(tokenPath)) {
    const stat = fs.lstatSync(tokenPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Token path ${tokenPath} is a symlink — refusing to write (possible path abuse)`);
    }
    if (!stat.isFile()) {
      throw new Error(`Token path ${tokenPath} exists but is not a regular file — refusing to write`);
    }
    // Verify under dataDir
    const realDataDir = fs.realpathSync(config.dataDir);
    const realToken = fs.realpathSync(tokenPath);
    if (!realToken.startsWith(realDataDir + path.sep) && realToken !== path.join(realDataDir, path.basename(realToken))) {
      throw new Error(`Token path ${realToken} is not under dataDir ${realDataDir}`);
    }
    // Safe to overwrite — remove first
    fs.unlinkSync(tokenPath);
  }
  fs.writeFileSync(tokenPath, token, { mode: 0o600 });
}

function verifyTokenFilePerms(tokenPath: string): void {
  if (process.platform === 'win32') return;
  const stat = fs.statSync(tokenPath);
  const perms = stat.mode & 0o777;
  if (perms !== 0o600) {
    throw new Error(`Token file ${tokenPath} has insecure permissions ${perms.toString(8)} (expected 600)`);
  }
}

// Bearer auth check uses the shared verifyBearerToken from auth-utils.
export { verifyBearerToken as checkBearerAuth };

// ─── PID File ───────────────────────────────────────────────────

function writePidFile(pidPath: string): void {
  const content: PidFileContent = {
    pid: process.pid,
    version: DAEMON_VERSION,
    apiVersion: API_VERSION,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(pidPath, JSON.stringify(content, null, 2), { mode: 0o600 });
}

function removePidFile(pidPath: string): void {
  try {
    if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
  } catch (err) {
    log().warn({ err, pidPath }, 'Failed to remove PID file during cleanup');
  }
}

// ─── Route Handling ─────────────────────────────────────────────

async function handleRequest(
  engine: Engine,
  config: SchruteConfig,
  transport: TransportConfig,
  lifecycle: LifecycleGuard,
  gracefulShutdownFn: () => Promise<void>,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  // TCP auth check
  if (transport.mode === 'tcp' && transport.token) {
    if (!verifyBearerToken(req, transport.token)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }
  }

  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  try {
    // POST /ctl/explore
    if (method === 'POST' && url === '/ctl/explore') {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON in request body' });
        return;
      }
      if (!body.url || typeof body.url !== 'string') {
        sendJson(res, 400, { error: 'Missing required field: url' });
        return;
      }
      const result = await lifecycle.withLock(() => engine.explore(body.url as string));
      sendJson(res, 200, result);
      return;
    }

    // POST /ctl/record
    if (method === 'POST' && url === '/ctl/record') {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON in request body' });
        return;
      }
      if (!body.name || typeof body.name !== 'string') {
        sendJson(res, 400, { error: 'Missing required field: name' });
        return;
      }
      const result = await lifecycle.withLock(() => engine.startRecording(body.name as string, body.inputs as Record<string, string> | undefined));
      sendJson(res, 200, result);
      return;
    }

    // POST /ctl/stop
    if (method === 'POST' && url === '/ctl/stop') {
      const result = await withTimeout(
        lifecycle.withLock(() => engine.stopRecording()),
        30_000, 'stopRecording',
      );
      sendJson(res, 200, result);
      return;
    }

    const pipelineMatch = method === 'GET' ? url.match(/^\/ctl\/pipeline\/([^/?#]+)$/) : null;
    if (pipelineMatch) {
      if (!hasPipelineJobEngine(engine)) {
        sendJson(res, 501, { error: 'Pipeline status is not supported by this engine build' });
        return;
      }
      const jobId = decodeURIComponent(pipelineMatch[1]);
      const job = engine.getPipelineJob(jobId);
      if (!job) {
        sendJson(res, 404, { error: `Pipeline job '${jobId}' not found` });
        return;
      }
      sendJson(res, 200, job);
      return;
    }

    // GET /ctl/status
    if (method === 'GET' && url === '/ctl/status') {
      const engineStatus = engine.getStatus();
      sendJson(res, 200, {
        ...engineStatus,
        apiVersion: API_VERSION,
        daemonVersion: DAEMON_VERSION,
        pid: process.pid,
        uptime: Math.round(process.uptime() * 1000),
      });
      return;
    }

    // GET /ctl/sessions
    if (method === 'GET' && url === '/ctl/sessions') {
      const msm = engine.getMultiSessionManager();
      const activeName = msm.getActive();
      const sessions = msm.list(undefined, config, { includeInternal: false }).map(s => ({
        name: s.name,
        siteId: s.siteId,
        isCdp: s.isCdp,
        active: s.name === activeName,
      }));
      sendJson(res, 200, sessions);
      return;
    }

    // POST /ctl/skills/search
    if (method === 'POST' && url === '/ctl/skills/search') {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON in request body' });
        return;
      }
      const { getDatabase } = await import('../storage/database.js');
      const { SkillRepository } = await import('../storage/skill-repository.js');
      const { searchAndProjectSkills } = await import('./skill-helpers.js');
      const db = getDatabase(config);
      const skillRepo = new SkillRepository(db);
      const siteId = body.siteId as string | undefined;
      const includeInactive = body.includeInactive as boolean | undefined;
      const browserManager = engine.getSessionManager().getBrowserManager();
      const limit = (body.limit as number) ?? 10;
      const query = body.query as string | undefined;

      const response = searchAndProjectSkills(skillRepo, browserManager, {
        query, siteId, limit, includeInactive: includeInactive ?? false,
      });

      sendJson(res, 200, response);
      return;
    }

    // POST /ctl/execute
    if (method === 'POST' && url === '/ctl/execute') {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON' });
        return;
      }
      const { skillId, params } = body;
      if (!skillId || typeof skillId !== 'string') {
        sendJson(res, 400, { error: 'Missing required field: skillId' });
        return;
      }
      // Use SchruteService for safety gates (active check, confirmation)
      const { getDatabase } = await import('../storage/database.js');
      const { SkillRepository } = await import('../storage/skill-repository.js');
      const { SiteRepository } = await import('../storage/site-repository.js');
      const { ConfirmationManager } = await import('./confirmation.js');
      const { SchruteService } = await import('../app/service.js');
      const db = getDatabase(config);
      const skillRepo = new SkillRepository(db);
      const siteRepo = new SiteRepository(db);
      const confirmation = new ConfirmationManager(db, config);
      const appService = new SchruteService({ engine, skillRepo, siteRepo, confirmation, config });

      try {
        const result = await lifecycle.withLock(() =>
          appService.executeSkill(skillId as string, (params ?? {}) as Record<string, unknown>, 'daemon'),
        );
        sendJson(res, 200, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(res, 400, { error: message });
      }
      return;
    }

    // POST /ctl/confirm
    if (method === 'POST' && url === '/ctl/confirm') {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON' });
        return;
      }
      const { token, approve } = body;
      if (!token || typeof token !== 'string') {
        sendJson(res, 400, { error: 'Missing required field: token' });
        return;
      }
      const { getDatabase } = await import('../storage/database.js');
      const { ConfirmationManager } = await import('./confirmation.js');
      const db = getDatabase(config);
      const confirmation = new ConfirmationManager(db, config);

      try {
        const result = await lifecycle.withLock(async () => {
          const verifyResult = confirmation.verifyAndConsume(token, approve !== false);
          if (!verifyResult.valid || !verifyResult.token) {
            throw new Error(`Confirmation failed: ${verifyResult.error ?? 'invalid token'}`);
          }
          return {
            status: approve !== false ? 'approved' : 'denied',
            skillId: verifyResult.token.skillId,
          };
        });
        sendJson(res, 200, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(res, 400, { error: message });
      }
      return;
    }

    // POST /ctl/revoke
    if (method === 'POST' && url === '/ctl/revoke') {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON' });
        return;
      }
      const { skillId } = body;
      if (!skillId || typeof skillId !== 'string') {
        sendJson(res, 400, { error: 'Missing required field: skillId' });
        return;
      }
      const { getDatabase } = await import('../storage/database.js');
      const { ConfirmationManager } = await import('./confirmation.js');
      const db = getDatabase(config);
      const confirmation = new ConfirmationManager(db, config);
      confirmation.revokeApproval(skillId);
      sendJson(res, 200, { revoked: true, skillId });
      return;
    }

    // GET /ctl/amendments
    if (method === 'GET' && url.startsWith('/ctl/amendments')) {
      const parsedUrl = new URL(url, 'http://localhost');
      const skillId = parsedUrl.searchParams.get('skillId');
      if (!skillId) {
        sendJson(res, 400, { error: 'skillId query parameter required' });
        return;
      }
      const amendmentRepo = engine.getAmendmentRepo();
      if (!amendmentRepo) {
        sendJson(res, 503, { error: 'Amendment tracking not available' });
        return;
      }
      const amendments = amendmentRepo.getBySkillId(skillId);
      sendJson(res, 200, { amendments });
      return;
    }

    // POST /ctl/optimize
    if (method === 'POST' && url === '/ctl/optimize') {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON in request body' });
        return;
      }
      const { skillId } = body;
      if (!skillId || typeof skillId !== 'string') {
        sendJson(res, 400, { error: 'skillId is required' });
        return;
      }
      const { getDatabase } = await import('../storage/database.js');
      const { SkillRepository } = await import('../storage/skill-repository.js');
      const db = getDatabase(config);
      const skillRepo = new SkillRepository(db);
      const skill = skillRepo.getById(skillId);
      if (!skill) {
        sendJson(res, 404, { error: `Skill '${skillId}' not found` });
        return;
      }
      const amendmentRepo = engine.getAmendmentRepo();
      const exemplarRepo = engine.getExemplarRepo();
      if (!amendmentRepo) {
        sendJson(res, 503, { error: 'Amendment or exemplar tracking not available' });
        return;
      }
      const { GepaEngine } = await import('../healing/gepa.js');
      const { AmendmentEngine } = await import('../healing/amendment.js');
      const metricsRepo = engine.getMetricsRepo();
      const amendmentEngine = new AmendmentEngine(amendmentRepo, skillRepo, metricsRepo);
      const gepa = new GepaEngine(skillRepo, amendmentRepo, exemplarRepo, amendmentEngine);
      const result = await gepa.optimize(skillId);
      sendJson(res, 200, result);
      return;
    }

    // GET /ctl/cdp-sessions — list CDP sessions for persistence across restarts
    if (method === 'GET' && url === '/ctl/cdp-sessions') {
      const msm = engine.getMultiSessionManager();
      const cdpSessions = msm.list().filter(s => s.isCdp).map(s => ({
        name: s.name,
        siteId: s.siteId,
        selectedPageUrl: s.selectedPageUrl,
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt,
      }));
      sendJson(res, 200, { cdpSessions });
      return;
    }

    // POST /ctl/shutdown — does NOT use lifecycle lock to avoid deadlock
    if (method === 'POST' && url === '/ctl/shutdown') {
      sendJson(res, 200, { message: 'Shutting down' });
      setImmediate(() => {
        gracefulShutdownFn().catch((err) => {
          log().error({ err }, 'Error during graceful shutdown');
        });
      });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    log().error({ err, url, method }, 'Control server request error');
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: message });
  }
}

// ─── Graceful Shutdown ──────────────────────────────────────────

export interface DaemonCloseHandles {
  mcpCloseHandles?: Array<{ close: () => Promise<void> }>;
}

async function createGracefulShutdown(
  engine: Engine,
  config: SchruteConfig,
  server: http.Server,
  lifecycle: LifecycleGuard,
  closeHandles: DaemonCloseHandles,
): Promise<() => Promise<void>> {
  const socketPath = getDaemonSocketPath(config);
  const pidPath = getDaemonPidPath(config);
  const tokenPath = getDaemonTokenPath(config);

  return async () => {
    if (!lifecycle.markShuttingDown()) return; // already shutting down

    log().info('Daemon graceful shutdown initiated');

    // 1. Stop accepting new connections
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    // 2. Drain lifecycle lock (wait for in-flight ops)
    await lifecycle.drainLock();

    // 3. Close MCP servers
    if (closeHandles.mcpCloseHandles) {
      for (const handle of closeHandles.mcpCloseHandles) {
        try {
          await handle.close();
        } catch (err) {
          log().warn({ err }, 'Error closing MCP handle during shutdown');
        }
      }
    }

    // 4. Transport cleanup
    try {
      const { resolveTransport } = await import('../replay/transport.js');
      const transport = resolveTransport();
      await transport.cleanup?.();
    } catch (err) {
      log().warn({ err }, 'Error cleaning up transport during shutdown');
    }

    // 5. Close Engine
    try {
      await engine.close();
    } catch (err) {
      log().warn({ err }, 'Error closing engine during shutdown');
    }

    // 6. Remove socket + PID + token files
    try { if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath); } catch (err) {
      log().warn({ err, socketPath }, 'Failed to remove daemon socket during shutdown');
    }
    removePidFile(pidPath);
    try { if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath); } catch (err) {
      log().warn({ err, tokenPath }, 'Failed to remove daemon token file during shutdown');
    }

    log().info('Daemon shutdown complete');
  };
}

// ─── Signal Handler Setup ───────────────────────────────────────

function setupSignalHandlers(shutdownFn: () => Promise<void>): void {
  const handler = () => {
    shutdownFn().catch((err) => {
      log().error({ err }, 'Error during signal-triggered shutdown');
      process.exitCode = 1;
    });
  };

  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
}

// ─── Start Daemon Server ────────────────────────────────────────

interface DaemonServerHandle {
  close: () => Promise<void>;
  gracefulShutdown: () => Promise<void>;
  transport: TransportConfig;
}

export async function startDaemonServer(
  engine: Engine,
  config: SchruteConfig,
  closeHandles?: DaemonCloseHandles,
): Promise<DaemonServerHandle> {
  const socketPath = getDaemonSocketPath(config);
  const pidPath = getDaemonPidPath(config);
  const tokenPath = getDaemonTokenPath(config);
  const handles = closeHandles ?? {};

  // Determine transport mode
  let transport: TransportConfig;
  let useUds = true;

  // UDS path length limit: 104 bytes on macOS (sun_path), 108 on Linux
  if (socketPath.length > 104) {
    log().warn({ socketPath, length: socketPath.length }, 'UDS path too long, falling back to TCP');
    useUds = false;
  }

  if (useUds) {
    // UDS mode
    await validateAndCleanSocket(socketPath, config);
    transport = { mode: 'uds', socketPath };
  } else {
    // TCP fallback mode with bearer token auth
    const port = config.daemon?.port ?? 19420;
    const token = generateToken();
    writeTokenFile(tokenPath, token, config);
    verifyTokenFilePerms(tokenPath); // Fail-closed: abort if perms wrong after write
    transport = { mode: 'tcp', port, token };
  }

  const lifecycle = new LifecycleGuard();
  const server = http.createServer();
  const gracefulShutdownFn = await createGracefulShutdown(engine, config, server, lifecycle, handles);

  server.on('request', (req, res) => {
    handleRequest(engine, config, transport, lifecycle, gracefulShutdownFn, req, res).catch((err) => {
      log().error({ err }, 'Unhandled request error');
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Internal server error' });
      }
    });
  });

  // Start listening
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    if (transport.mode === 'uds') {
      const udsTransport = transport;
      server.listen(udsTransport.socketPath, () => {
        // Set socket file permissions (owner-only) — fail-closed
        try {
          fs.chmodSync(udsTransport.socketPath, 0o600);
        } catch (err) {
          log().error({ err, socketPath: udsTransport.socketPath }, 'Failed to set socket permissions — aborting (fail-closed)');
          server.close();
          reject(new Error(`Failed to set socket permissions on ${udsTransport.socketPath}: ${err instanceof Error ? err.message : String(err)}`));
          return;
        }
        resolve();
      });
    } else {
      const tcpTransport = transport;
      server.listen(tcpTransport.port, '127.0.0.1', () => resolve());
    }
  });

  // Write PID file
  writePidFile(pidPath);

  if (transport.mode === 'uds') {
    log().info({ socketPath: transport.socketPath }, 'Daemon control server listening (UDS)');
  } else {
    log().info({ port: transport.port }, 'Daemon control server listening (TCP, bearer auth required)');
  }

  const closeServer = async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  return {
    close: closeServer,
    gracefulShutdown: gracefulShutdownFn,
    transport,
  };
}
