import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ─── Mock logger ─────────────────────────────────────────────────
vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Create real temp dir for test isolation
let testTmpDir: string;

beforeEach(() => {
  testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schrute-har-test-'));
});

afterEach(() => {
  try {
    fs.rmSync(testTmpDir, { recursive: true, force: true });
  } catch {
    // cleanup best effort
  }
});

vi.mock('../../src/core/config.js', () => ({
  getConfig: () => ({
    dataDir: testTmpDir,
    logLevel: 'silent',
    tempTtlMs: 3600000,
    payloadLimits: {
      redactorTimeoutMs: 10000,
    },
  }),
  getTmpDir: () => path.join(testTmpDir, 'tmp'),
}));

import { HarRecorder } from '../../src/browser/har-recorder.js';

describe('HarRecorder', () => {
  let recorder: HarRecorder;

  beforeEach(() => {
    // Ensure tmp dir exists for the recorder
    const tmpDir = path.join(testTmpDir, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    recorder = new HarRecorder();
  });

  describe('start/stop lifecycle', () => {
    it('starts a recording session', () => {
      const runDir = recorder.startRecording('example.com', 'frame-1');
      expect(runDir).toBeDefined();
      expect(typeof runDir).toBe('string');
      expect(fs.existsSync(runDir)).toBe(true);
    });

    it('creates run directory with lock file', () => {
      const runDir = recorder.startRecording('example.com', 'frame-1');
      const lockPath = path.join(runDir, '.lock');
      expect(fs.existsSync(lockPath)).toBe(true);

      const lockContent = fs.readFileSync(lockPath, 'utf-8');
      expect(parseInt(lockContent, 10)).toBe(process.pid);
    });

    it('reports active session info', () => {
      recorder.startRecording('example.com', 'frame-1');
      const session = recorder.getActiveSession();
      expect(session).not.toBeNull();
      expect(session!.siteId).toBe('example.com');
      expect(session!.frameId).toBe('frame-1');
    });

    it('reports active HAR path', () => {
      recorder.startRecording('example.com', 'frame-1');
      const harPath = recorder.getActiveHarPath();
      expect(harPath).not.toBeNull();
      expect(harPath!.endsWith('recording.har')).toBe(true);
    });

    it('returns null when no active session', () => {
      expect(recorder.getActiveSession()).toBeNull();
      expect(recorder.getActiveHarPath()).toBeNull();
    });

    it('stops and cleans up when no HAR file exists', async () => {
      const runDir = recorder.startRecording('example.com', 'frame-1');
      // Don't create HAR file — simulate no network activity
      const result = await recorder.stopRecording();
      expect(result).toBeNull();
      // Run dir should be cleaned up
      expect(fs.existsSync(runDir)).toBe(false);
    });

    it('returns null when stopping without active session', async () => {
      const result = await recorder.stopRecording();
      expect(result).toBeNull();
    });

    it('handles starting new session while one is active', () => {
      recorder.startRecording('site-a.com', 'frame-a');
      const runDir2 = recorder.startRecording('site-b.com', 'frame-b');
      expect(runDir2).toBeDefined();

      // Active session should now be site-b
      const session = recorder.getActiveSession();
      expect(session!.siteId).toBe('site-b.com');
    });
  });

  describe('redaction timeout (fail-closed)', () => {
    it('preserves raw HAR with TTL on redaction failure', async () => {
      const runDir = recorder.startRecording('example.com', 'frame-1');
      // Create a HAR file to simulate network activity
      const harPath = path.join(runDir, 'recording.har');
      fs.writeFileSync(harPath, '{"log": {"entries": []}}');

      // Register a failing redactor
      recorder.setRedactor(async () => {
        throw new Error('Redaction failed');
      });

      const result = await recorder.stopRecording();
      expect(result).toBeNull();
      // Run dir should still exist (preserved with TTL)
      expect(fs.existsSync(runDir)).toBe(true);
      // Lock file should be removed (so GC can clean it up)
      expect(fs.existsSync(path.join(runDir, '.lock'))).toBe(false);
    });

    it('preserves raw HAR when no redactor registered', async () => {
      const runDir = recorder.startRecording('example.com', 'frame-1');
      const harPath = path.join(runDir, 'recording.har');
      fs.writeFileSync(harPath, '{"log": {"entries": []}}');

      const result = await recorder.stopRecording();
      expect(result).toBeNull();
      // Run dir should still exist (preserved with TTL)
      expect(fs.existsSync(runDir)).toBe(true);
    });

    it('deletes raw HAR on successful redaction', async () => {
      const runDir = recorder.startRecording('example.com', 'frame-1');
      const harPath = path.join(runDir, 'recording.har');
      fs.writeFileSync(harPath, '{"log": {"entries": []}}');

      const redactedPath = path.join(testTmpDir, 'redacted.har');
      recorder.setRedactor(async () => {
        fs.writeFileSync(redactedPath, '{"redacted": true}');
        return redactedPath;
      });

      const result = await recorder.stopRecording();
      expect(result).toBe(redactedPath);
      // Run dir should be cleaned up (raw deleted)
      expect(fs.existsSync(runDir)).toBe(false);
    });
  });

  describe('startup GC', () => {
    it('cleans stale directories on instantiation', () => {
      const tmpDir = path.join(testTmpDir, 'tmp');
      // Create a stale directory (old mtime)
      const staleDir = path.join(tmpDir, 'stale-run');
      fs.mkdirSync(staleDir, { recursive: true });
      // Set old mtime (older than TTL)
      const oldTime = new Date(Date.now() - 7200000); // 2 hours ago
      fs.utimesSync(staleDir, oldTime, oldTime);

      // Instantiation should trigger GC — stale dirs older than tempTtlMs (1 hour) are cleaned
      const freshRecorder = new HarRecorder();
      expect(fs.existsSync(staleDir)).toBe(false);
    });

    it('does not clean directories locked by running process', () => {
      const tmpDir = path.join(testTmpDir, 'tmp');
      const lockedDir = path.join(tmpDir, 'locked-run');
      fs.mkdirSync(lockedDir, { recursive: true });

      // Write lock file with current PID
      fs.writeFileSync(path.join(lockedDir, '.lock'), String(process.pid), { mode: 0o600 });
      const oldTime = new Date(Date.now() - 7200000);
      fs.utimesSync(lockedDir, oldTime, oldTime);

      const freshRecorder = new HarRecorder();
      // Should NOT be cleaned because current process holds the lock
      expect(fs.existsSync(lockedDir)).toBe(true);
    });

    it('does not clean recent directories', () => {
      const tmpDir = path.join(testTmpDir, 'tmp');
      const recentDir = path.join(tmpDir, 'recent-run');
      fs.mkdirSync(recentDir, { recursive: true });
      // mtime is now (recent), should not be cleaned

      const freshRecorder = new HarRecorder();
      expect(fs.existsSync(recentDir)).toBe(true);
    });
  });
});
