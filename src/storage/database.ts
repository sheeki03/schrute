import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDbPath, ensureDirectories } from '../core/config.js';
import type { OneAgentConfig } from '../skill/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class AgentDatabase {
  private db: Database.Database | null = null;
  private dbPath: string;

  constructor(config?: OneAgentConfig) {
    this.dbPath = getDbPath(config);
    ensureDirectories(config);
  }

  open(): void {
    if (this.db) return;

    const dir = path.dirname(this.dbPath);
    fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');

    this.runMigrations();
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private ensureOpen(): Database.Database {
    if (!this.db) {
      throw new Error('Database is not open. Call open() first.');
    }
    return this.db;
  }

  run(sql: string, ...params: unknown[]): Database.RunResult {
    const db = this.ensureOpen();
    return db.prepare(sql).run(...params);
  }

  get<T = unknown>(sql: string, ...params: unknown[]): T | undefined {
    const db = this.ensureOpen();
    return db.prepare(sql).get(...params) as T | undefined;
  }

  all<T = unknown>(sql: string, ...params: unknown[]): T[] {
    const db = this.ensureOpen();
    return db.prepare(sql).all(...params) as T[];
  }

  exec(sql: string): void {
    const db = this.ensureOpen();
    db.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    const db = this.ensureOpen();
    return db.transaction(fn)();
  }

  private runMigrations(): void {
    const db = this.ensureOpen();

    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        filename TEXT NOT NULL,
        applied_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      );
    `);

    const migrationsDir = path.join(__dirname, 'migrations');

    if (!fs.existsSync(migrationsDir)) {
      return;
    }

    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    const applied = new Set(
      (db.prepare('SELECT filename FROM schema_migrations').all() as { filename: string }[])
        .map(r => r.filename),
    );

    for (const file of files) {
      if (applied.has(file)) continue;

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations (filename) VALUES (?)').run(file);
      })();
    }
  }

  get raw(): Database.Database {
    return this.ensureOpen();
  }
}

let defaultDb: AgentDatabase | null = null;

export function getDatabase(config?: OneAgentConfig): AgentDatabase {
  if (!defaultDb) {
    defaultDb = new AgentDatabase(config);
    defaultDb.open();
  }
  return defaultDb;
}

export function closeDatabase(): void {
  if (defaultDb) {
    defaultDb.close();
    defaultDb = null;
  }
}
