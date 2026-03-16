import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { getConfig, getTmpDir } from '../core/config.js';
import { getLogger } from '../core/logger.js';
import { withTimeout } from '../core/utils.js';

const log = getLogger();

interface RecordingSession {
  siteId: string;
  frameId: string;
  runId: string;
  runDir: string;
  harPath: string;
  startedAt: number;
}

/**
 * Wraps Playwright's HAR recording with action-frame boundaries.
 *
 * Pipeline: raw HAR -> redactFn() -> durable store commit -> raw HAR deleted
 *
 * FAIL-CLOSED: if redaction times out, no durable write occurs, no terminal/agent output.
 * Raw HAR is preserved in temp with TTL for background retry.
 */
export class HarRecorder {
  private activeSession: RecordingSession | null = null;
  private redactFn: ((harPath: string) => Promise<string>) | null = null;

  constructor() {
    // Run startup GC on instantiation
    this.startupGc();
  }

  /**
   * Register a redaction function to process raw HARs.
   * The function receives a raw HAR path and returns the redacted artifact path.
   */
  setRedactor(fn: (harPath: string) => Promise<string>): void {
    this.redactFn = fn;
  }

  /**
   * Start a new HAR recording session.
   *
   * @param siteId - The site being recorded
   * @param frameId - The action frame ID for boundary tracking
   * @returns The run directory path
   */
  startRecording(siteId: string, frameId: string): string {
    if (this.activeSession) {
      log.warn(
        { existingSiteId: this.activeSession.siteId },
        'Recording already active, stopping previous session',
      );
      // Design choice: fire-and-forget cleanup on browser disconnect. Awaiting would block
      // the disconnect handler, and the recording data is best-effort at this point.
      void this.stopRecording().catch((err) => {
        log.warn({ err }, 'Failed to stop HAR recording on disconnect');
      });
    }

    const config = getConfig();
    const tmpDir = getTmpDir(config);
    const runId = crypto.randomUUID();
    const runDir = path.join(tmpDir, runId);

    // Create run directory with restricted permissions
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });

    // Write lockfile to prevent multi-process cleanup race
    const lockPath = path.join(runDir, '.lock');
    fs.writeFileSync(lockPath, String(process.pid), { mode: 0o600 });

    const harPath = path.join(runDir, 'recording.har');

    this.activeSession = {
      siteId,
      frameId,
      runId,
      runDir,
      harPath,
      startedAt: Date.now(),
    };

    log.info({ siteId, frameId, runId }, 'Started HAR recording session');
    return runDir;
  }

  /**
   * Stop the current recording session and process the HAR through redaction.
   *
   * @returns Path to the redacted artifact, or null if redaction failed (fail-closed)
   */
  async stopRecording(): Promise<string | null> {
    const session = this.activeSession;
    if (!session) {
      log.warn('No active recording session to stop');
      return null;
    }

    this.activeSession = null;
    log.info(
      { siteId: session.siteId, runId: session.runId },
      'Stopping HAR recording session',
    );

    // If no HAR file was written (e.g. no network activity), clean up
    if (!fs.existsSync(session.harPath)) {
      this.cleanRunDir(session.runDir);
      return null;
    }

    // If no redactor is registered, preserve raw HAR with TTL
    if (!this.redactFn) {
      log.warn({ runId: session.runId }, 'No redactor registered, preserving raw HAR with TTL');
      this.markForTtl(session.runDir);
      return null;
    }

    // Run redaction with timeout (fail-closed)
    const config = getConfig();
    const timeoutMs = config.payloadLimits.redactorTimeoutMs;

    try {
      const redactedPath = await withTimeout(
        this.redactFn(session.harPath),
        timeoutMs,
        'HAR redaction',
      );

      // Redaction succeeded — delete raw HAR
      this.cleanRunDir(session.runDir);
      log.info(
        { runId: session.runId, redactedPath },
        'HAR redaction complete, raw deleted',
      );
      return redactedPath;
    } catch (err) {
      // FAIL-CLOSED: no durable write, no terminal/agent output
      log.error(
        { runId: session.runId, err },
        'HAR redaction failed — fail-closed, preserving raw with TTL',
      );
      this.markForTtl(session.runDir);
      return null;
    }
  }

  /**
   * Get the current active session's HAR path (for Playwright's recordHar).
   */
  getActiveHarPath(): string | null {
    return this.activeSession?.harPath ?? null;
  }

  /**
   * Get the current active session info.
   */
  getActiveSession(): RecordingSession | null {
    return this.activeSession ? { ...this.activeSession } : null;
  }

  // ─── Startup GC ───────────────────────────────────────────────────

  /**
   * On instantiation, scan tmp/ for stale run dirs older than TTL.
   * Delete any that are not locked by a running process.
   */
  private startupGc(): void {
    const config = getConfig();
    const tmpDir = getTmpDir(config);
    const ttlMs = config.tempTtlMs;

    if (!fs.existsSync(tmpDir)) {
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(tmpDir, { withFileTypes: true });
    } catch (err) {
      log.warn({ err, tmpDir }, 'HAR recorder GC: failed to read tmp directory');
      return;
    }

    const now = Date.now();
    let cleaned = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const dirPath = path.join(tmpDir, entry.name);
      const lockPath = path.join(dirPath, '.lock');

      // Check if locked by a running process
      if (fs.existsSync(lockPath)) {
        try {
          const pid = parseInt(fs.readFileSync(lockPath, 'utf-8').trim(), 10);
          if (this.isProcessRunning(pid)) {
            continue; // Skip — active process owns this dir
          }
        } catch (err) {
          log.warn({ err, lockPath }, 'HAR recorder GC: failed to read lock file');
        }
      }

      // Check age by directory mtime
      try {
        const stat = fs.statSync(dirPath);
        const age = now - stat.mtimeMs;
        if (age > ttlMs) {
          fs.rmSync(dirPath, { recursive: true, force: true });
          cleaned++;
        }
      } catch (err) {
        log.warn({ err, dirPath }, 'HAR recorder GC: failed to stat or remove stale directory');
      }
    }

    if (cleaned > 0) {
      log.info({ cleaned }, 'Startup GC cleaned stale run directories');
    }
  }

  // ─── Internal Helpers ──────────────────────────────────────────────

  /**
   * Mark a run directory for TTL-based cleanup (don't delete now,
   * let GC handle it later).
   */
  private markForTtl(runDir: string): void {
    try {
      // Remove lockfile so GC can clean it up after TTL
      const lockPath = path.join(runDir, '.lock');
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
      }
      // Touch the directory to reset mtime for TTL calculation
      const now = new Date();
      fs.utimesSync(runDir, now, now);
    } catch (err) {
      log.warn({ runDir, err }, 'Failed to mark run dir for TTL');
    }
  }

  /**
   * Remove a run directory and all its contents.
   */
  private cleanRunDir(runDir: string): void {
    try {
      fs.rmSync(runDir, { recursive: true, force: true });
    } catch (err) {
      log.warn({ runDir, err }, 'Failed to clean run directory');
    }
  }

  /**
   * Check if a process with the given PID is still running.
   */
  private isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

}
