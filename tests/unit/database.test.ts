import { describe, it, expect, vi, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

// ─── Mock logger ─────────────────────────────────────────────────
vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// We need to dynamically set the dataDir for each test, so we use a mutable reference
let testDataDir = '/tmp/schrute-db-test-default';

vi.mock('../../src/core/config.js', () => ({
  getConfig: () => ({
    dataDir: testDataDir,
    logLevel: 'silent',
  }),
  getDbPath: (config?: any) => {
    const dir = config?.dataDir ?? testDataDir;
    return path.join(dir, 'schrute.db');
  },
  ensureDirectories: vi.fn(),
}));

import { AgentDatabase, getDatabase, closeDatabase, MIGRATIONS } from '../../src/storage/database.js';

// ─── Helpers ─────────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = path.join(os.tmpdir(), `schrute-db-test-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* best effort */ }
}

// ─── Tests ───────────────────────────────────────────────────────

describe('AgentDatabase', () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    // Always close the singleton to reset state between tests
    closeDatabase();
    for (const dir of tempDirs) {
      cleanupDir(dir);
    }
    tempDirs = [];
  });

  describe('singleton guard', () => {
    it('rejects opening with a different dataDir', () => {
      const dir1 = makeTempDir();
      const dir2 = makeTempDir();
      tempDirs.push(dir1, dir2);

      testDataDir = dir1;
      const db1 = getDatabase({ dataDir: dir1 } as any);
      expect(db1).toBeDefined();

      // Attempting to get a database for a different path should throw
      expect(() => getDatabase({ dataDir: dir2 } as any)).toThrow(
        /singleton already initialized/i,
      );
    });

    it('returns same instance when called with same dataDir', () => {
      const dir = makeTempDir();
      tempDirs.push(dir);

      testDataDir = dir;
      const db1 = getDatabase({ dataDir: dir } as any);
      const db2 = getDatabase({ dataDir: dir } as any);
      expect(db1).toBe(db2);
    });

    it('allows reopening after closeDatabase()', () => {
      const dir1 = makeTempDir();
      const dir2 = makeTempDir();
      tempDirs.push(dir1, dir2);

      testDataDir = dir1;
      getDatabase({ dataDir: dir1 } as any);
      closeDatabase();

      // Should now accept a different path
      testDataDir = dir2;
      const db2 = getDatabase({ dataDir: dir2 } as any);
      expect(db2).toBeDefined();
    });
  });

  describe('migrations', () => {
    it('runs all migrations exactly once', () => {
      const dir = makeTempDir();
      tempDirs.push(dir);

      testDataDir = dir;
      const db = getDatabase({ dataDir: dir } as any);

      // Check schema_migrations table for all applied migrations
      const applied = db.all<{ filename: string }>(
        'SELECT filename FROM schema_migrations ORDER BY id',
      ).map(r => r.filename);

      // Every migration should be applied
      for (const migration of MIGRATIONS) {
        expect(applied).toContain(migration.filename);
      }

      // Count should match exactly
      expect(applied).toHaveLength(MIGRATIONS.length);
    });

    it('does not re-run migrations on second open', () => {
      const dir = makeTempDir();
      tempDirs.push(dir);

      testDataDir = dir;

      // First open — runs migrations
      const db1 = new AgentDatabase({ dataDir: dir } as any);
      db1.open();

      const countAfterFirst = db1.all<{ cnt: number }>(
        'SELECT COUNT(*) as cnt FROM schema_migrations',
      )[0].cnt;

      db1.close();

      // Second open — should not re-run
      const db2 = new AgentDatabase({ dataDir: dir } as any);
      db2.open();

      const countAfterSecond = db2.all<{ cnt: number }>(
        'SELECT COUNT(*) as cnt FROM schema_migrations',
      )[0].cnt;

      expect(countAfterSecond).toBe(countAfterFirst);
      db2.close();
    });
  });

  describe('pragmas', () => {
    it('sets WAL journal mode', () => {
      const dir = makeTempDir();
      tempDirs.push(dir);

      const db = new AgentDatabase({ dataDir: dir } as any);
      db.open();

      const result = db.get<{ journal_mode: string }>('PRAGMA journal_mode');
      expect(result!.journal_mode).toBe('wal');

      db.close();
    });

    it('enables foreign keys', () => {
      const dir = makeTempDir();
      tempDirs.push(dir);

      const db = new AgentDatabase({ dataDir: dir } as any);
      db.open();

      const result = db.get<{ foreign_keys: number }>('PRAGMA foreign_keys');
      expect(result!.foreign_keys).toBe(1);

      db.close();
    });
  });

  describe('ensureOpen guard', () => {
    it('throws when accessing database before open()', () => {
      const dir = makeTempDir();
      tempDirs.push(dir);

      const db = new AgentDatabase({ dataDir: dir } as any);
      // Don't call open()

      expect(() => db.run('SELECT 1')).toThrow(/not open/i);
    });

    it('throws after close()', () => {
      const dir = makeTempDir();
      tempDirs.push(dir);

      const db = new AgentDatabase({ dataDir: dir } as any);
      db.open();
      db.close();

      expect(() => db.run('SELECT 1')).toThrow(/not open/i);
    });
  });

  describe('open() is idempotent', () => {
    it('calling open() twice does not throw', () => {
      const dir = makeTempDir();
      tempDirs.push(dir);

      const db = new AgentDatabase({ dataDir: dir } as any);
      db.open();
      // Second open should be a no-op
      expect(() => db.open()).not.toThrow();

      db.close();
    });
  });
});
