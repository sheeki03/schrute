import type Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDbPath, ensureDirectories } from '../core/config.js';
import type { SchruteConfig } from '../skill/types.js';

// Lazy-loaded constructor. require() is synchronous — no async propagation.
const esmRequire = createRequire(import.meta.url);
let _Ctor: typeof Database | null = null;

function loadSqlite(): typeof Database {
  if (!_Ctor) {
    _Ctor = esmRequire('better-sqlite3');
  }
  return _Ctor!;
}

// ─── Embedded Migrations ──────────────────────────────────────────────
// SQL files are not emitted by tsc, so we embed them as string constants.
// The original .sql files are kept in src/storage/migrations/ for reference.

export const MIGRATIONS: Array<{ filename: string; sql: string }> = [
  {
    filename: '001_initial.sql',
    sql: `
-- Schrute initial schema

CREATE TABLE IF NOT EXISTS sites (
  id              TEXT PRIMARY KEY,
  display_name    TEXT,
  first_seen      INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  last_visited    INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  mastery_level   TEXT NOT NULL DEFAULT 'explore',
  recommended_tier TEXT NOT NULL DEFAULT 'browser_proxied',
  total_requests  INTEGER NOT NULL DEFAULT 0,
  successful_requests INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS skills (
  id                TEXT PRIMARY KEY,
  site_id           TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  version           INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'draft',
  description       TEXT,
  method            TEXT NOT NULL,
  path_template     TEXT NOT NULL,
  input_schema      TEXT NOT NULL DEFAULT '{}',
  output_schema     TEXT,
  auth_type         TEXT,
  required_headers  TEXT,
  dynamic_headers   TEXT,
  side_effect_class TEXT NOT NULL DEFAULT 'read-only',
  is_composite      INTEGER NOT NULL DEFAULT 0,
  chain_spec        TEXT,
  current_tier      TEXT NOT NULL DEFAULT 'tier_3',
  tier_lock         TEXT,
  confidence        REAL NOT NULL DEFAULT 0.0,
  consecutive_validations INTEGER NOT NULL DEFAULT 0,
  sample_count      INTEGER NOT NULL DEFAULT 0,
  parameter_evidence TEXT,
  last_verified     INTEGER,
  last_used         INTEGER,
  success_rate      REAL NOT NULL DEFAULT 0.0,
  skill_md          TEXT,
  openapi_fragment  TEXT,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  UNIQUE(site_id, name, version)
);

CREATE TABLE IF NOT EXISTS auth_flows (
  id                TEXT PRIMARY KEY,
  site_id           TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  type              TEXT NOT NULL,
  recipe            TEXT,
  token_keychain_ref TEXT,
  token_expires_at  INTEGER,
  last_refreshed    INTEGER
);

CREATE TABLE IF NOT EXISTS action_frames (
  id                    TEXT PRIMARY KEY,
  site_id               TEXT NOT NULL,
  name                  TEXT NOT NULL,
  redacted_artifact_id  TEXT,
  quality_score         REAL,
  started_at            INTEGER NOT NULL,
  ended_at              INTEGER,
  request_count         INTEGER NOT NULL DEFAULT 0,
  signal_count          INTEGER NOT NULL DEFAULT 0,
  skill_count           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS action_frame_entries (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  frame_id          TEXT NOT NULL REFERENCES action_frames(id) ON DELETE CASCADE,
  request_hash      TEXT NOT NULL,
  classification    TEXT NOT NULL,
  noise_reason      TEXT,
  cluster_id        TEXT,
  redaction_applied INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS skill_confirmations (
  skill_id            TEXT PRIMARY KEY REFERENCES skills(id) ON DELETE CASCADE,
  confirmation_status TEXT NOT NULL DEFAULT 'pending',
  approved_by         TEXT,
  approved_at         INTEGER,
  denied_at           INTEGER
);

CREATE TABLE IF NOT EXISTS confirmation_nonces (
  nonce         TEXT PRIMARY KEY,
  skill_id      TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  params_hash   TEXT NOT NULL,
  tier          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  consumed      INTEGER NOT NULL DEFAULT 0,
  consumed_at   INTEGER
);

CREATE TABLE IF NOT EXISTS skill_metrics (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id        TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  execution_tier  TEXT NOT NULL,
  success         INTEGER NOT NULL,
  latency_ms      REAL NOT NULL,
  error_type      TEXT,
  capability_used TEXT,
  policy_rule     TEXT,
  executed_at     INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
);

CREATE TABLE IF NOT EXISTS policies (
  site_id             TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  allowed_methods     TEXT NOT NULL DEFAULT '["GET","HEAD","POST:read-only"]',
  max_qps             REAL NOT NULL DEFAULT 1.0,
  max_concurrent      INTEGER NOT NULL DEFAULT 1,
  read_only_default   INTEGER NOT NULL DEFAULT 1,
  require_confirmation TEXT NOT NULL DEFAULT '[]',
  domain_allowlist    TEXT,
  redaction_rules     TEXT NOT NULL DEFAULT '[]',
  capabilities        TEXT NOT NULL DEFAULT '["net.fetch.direct","net.fetch.browserProxied","browser.automation","storage.write","secrets.use"]'
);

CREATE INDEX IF NOT EXISTS idx_skills_site_status
  ON skills(site_id, status);

CREATE INDEX IF NOT EXISTS idx_skill_metrics_skill_time
  ON skill_metrics(skill_id, executed_at);

CREATE INDEX IF NOT EXISTS idx_action_frames_site_time
  ON action_frames(site_id, started_at);

CREATE INDEX IF NOT EXISTS idx_sites_last_visited
  ON sites(last_visited);
`,
  },
  {
    filename: '002_webmcp.sql',
    sql: `
CREATE TABLE IF NOT EXISTS webmcp_tools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  description TEXT,
  input_schema TEXT,
  discovered_at INTEGER NOT NULL,
  last_verified INTEGER,
  UNIQUE(site_id, tool_name)
);

CREATE INDEX IF NOT EXISTS idx_webmcp_tools_site ON webmcp_tools(site_id);
`,
  },
  {
    filename: '003_skill_extra_fields.sql',
    sql: `
ALTER TABLE skills ADD COLUMN allowed_domains TEXT NOT NULL DEFAULT '[]';
ALTER TABLE skills ADD COLUMN required_capabilities TEXT NOT NULL DEFAULT '[]';
ALTER TABLE skills ADD COLUMN parameters TEXT NOT NULL DEFAULT '[]';
ALTER TABLE skills ADD COLUMN validation TEXT NOT NULL DEFAULT '{"semanticChecks":[],"customInvariants":[]}';
ALTER TABLE skills ADD COLUMN redaction TEXT NOT NULL DEFAULT '{"piiClassesFound":[],"fieldsRedacted":0}';
ALTER TABLE skills ADD COLUMN replay_strategy TEXT NOT NULL DEFAULT 'prefer_tier_3';
`,
  },
  {
    filename: '004_skill_exemplars.sql',
    sql: `
CREATE TABLE IF NOT EXISTS skill_exemplars (
  skill_id TEXT PRIMARY KEY,
  response_status INTEGER NOT NULL,
  response_schema_hash TEXT NOT NULL,
  redacted_response_body TEXT NOT NULL,
  captured_at INTEGER NOT NULL
);
`,
  },
  {
    filename: '005_skill_amendments.sql',
    sql: `
CREATE TABLE IF NOT EXISTS skill_amendments (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  failure_cause TEXT NOT NULL,
  strategy TEXT NOT NULL,
  snapshot_fields TEXT NOT NULL,
  success_rate_before REAL NOT NULL,
  success_rate_after REAL,
  executions_since INTEGER DEFAULT 0,
  evaluation_window INTEGER NOT NULL DEFAULT 10,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_amendment
  ON skill_amendments(skill_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_amendments_cause_strategy
  ON skill_amendments(failure_cause, strategy, status);
`,
  },
  {
    filename: '006_execution_policy.sql',
    sql: `
ALTER TABLE policies ADD COLUMN execution_backend TEXT;
ALTER TABLE policies ADD COLUMN execution_session_name TEXT;
`,
  },
  {
    filename: '007_canary_and_stats.sql',
    sql: `
ALTER TABLE skills ADD COLUMN avg_latency_ms REAL;
ALTER TABLE skills ADD COLUMN last_successful_tier TEXT;
ALTER TABLE skills ADD COLUMN direct_canary_eligible INTEGER DEFAULT 0;
ALTER TABLE skills ADD COLUMN direct_canary_attempts INTEGER DEFAULT 0;
ALTER TABLE skills ADD COLUMN validations_since_last_canary INTEGER DEFAULT 0;
ALTER TABLE skills ADD COLUMN last_canary_error_type TEXT;
`,
  },
  {
    filename: '008_rate_limit_backoffs.sql',
    sql: `
CREATE TABLE IF NOT EXISTS rate_limit_backoffs (
  site_id TEXT PRIMARY KEY,
  backoff_until INTEGER NOT NULL,
  multiplier REAL NOT NULL DEFAULT 1
);
`,
  },
  {
    filename: '009_fts_and_review.sql',
    sql: `
ALTER TABLE skills ADD COLUMN review_required INTEGER DEFAULT 0;

-- Requires daemon restart. searchFts() falls back to LIKE when unavailable.
CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
  skill_id UNINDEXED, name, description, path_template, site_id UNINDEXED,
  tokenize='porter unicode61'
);
INSERT INTO skills_fts(skill_id, name, description, path_template, site_id)
  SELECT id, name, COALESCE(description, ''), path_template, site_id FROM skills;

CREATE TRIGGER IF NOT EXISTS skills_fts_insert AFTER INSERT ON skills BEGIN
  INSERT INTO skills_fts(skill_id, name, description, path_template, site_id)
    VALUES (new.id, new.name, COALESCE(new.description, ''), new.path_template, new.site_id);
END;

CREATE TRIGGER IF NOT EXISTS skills_fts_update AFTER UPDATE ON skills BEGIN
  DELETE FROM skills_fts WHERE skill_id = old.id;
  INSERT INTO skills_fts(skill_id, name, description, path_template, site_id)
    VALUES (new.id, new.name, COALESCE(new.description, ''), new.path_template, new.site_id);
END;

CREATE TRIGGER IF NOT EXISTS skills_fts_delete AFTER DELETE ON skills BEGIN
  DELETE FROM skills_fts WHERE skill_id = old.id;
END;
`,
  },
  {
    filename: '010_webmcp_declarative.sql',
    sql: `
-- WebMCP declarative tool metadata (Chrome 146)
ALTER TABLE webmcp_tools ADD COLUMN declarative INTEGER NOT NULL DEFAULT 0;
ALTER TABLE webmcp_tools ADD COLUMN auto_submit INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    filename: '011_lighthouse.sql',
    sql: `
-- Lighthouse audit scores per site
ALTER TABLE sites ADD COLUMN lighthouse_score REAL;
ALTER TABLE sites ADD COLUMN lighthouse_accessibility REAL;
`,
  },
  {
    filename: '012_sample_params.sql',
    sql: `
ALTER TABLE skills ADD COLUMN sample_params TEXT;
`,
  },
  {
    filename: '013_browser_required_policy.sql',
    sql: `
ALTER TABLE policies ADD COLUMN browser_required INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    filename: '014_output_transforms.sql',
    sql: `
ALTER TABLE skills ADD COLUMN output_transform TEXT;
ALTER TABLE skills ADD COLUMN response_content_type TEXT;
`,
  },
  {
    filename: '015_workflow_spec.sql',
    sql: `
ALTER TABLE skills ADD COLUMN workflow_spec TEXT;
`,
  },
  {
    filename: '016_site_policy_min_gap.sql',
    sql: `
ALTER TABLE policies ADD COLUMN min_gap_ms INTEGER NOT NULL DEFAULT 100;
`,
  },
  {
    filename: '017_skill_ranking_relearn.sql',
    sql: `
ALTER TABLE skills ADD COLUMN suppression_reason TEXT;
ALTER TABLE skills ADD COLUMN relearn_requested INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    filename: '018_workflow_suggestions.sql',
    sql: `
CREATE TABLE IF NOT EXISTS workflow_suggestions (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  workflow_spec TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  source_chain_skill_id TEXT,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_suggestions_dedup
  ON workflow_suggestions(site_id, dedup_key);
`,
  },
];

export class AgentDatabase {
  private db: Database.Database | null = null;
  private dbPath: string;

  constructor(config?: SchruteConfig) {
    this.dbPath = getDbPath(config);
    ensureDirectories(config);
  }

  open(): void {
    if (this.db) return;

    const dir = path.dirname(this.dbPath);
    fs.mkdirSync(dir, { recursive: true });

    const dbOptions: Record<string, unknown> = {};
    if ((process as any).pkg) {
      const addonPath = path.join(path.dirname(process.execPath), 'addons', 'better_sqlite3.node');
      if (!fs.existsSync(addonPath)) {
        throw new Error(
          `Native addon not found at ${addonPath}. ` +
          'Ensure the addons/ directory is shipped alongside the binary.',
        );
      }
      dbOptions.nativeBinding = addonPath;
    }

    try {
      this.db = new (loadSqlite())(this.dbPath, dbOptions);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('NODE_MODULE_VERSION') || msg.includes('was compiled against') || msg.includes('ERR_DLOPEN_FAILED')) {
        throw new Error(
          `${msg}\n\nNative module ABI mismatch.\nFix with: npm rebuild better-sqlite3\nOr run: schrute doctor`,
        );
      }
      throw err;
    }
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

    const applied = new Set(
      (db.prepare('SELECT filename FROM schema_migrations').all() as { filename: string }[])
        .map(r => r.filename),
    );

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.filename)) continue;

      db.transaction(() => {
        db.exec(migration.sql);
        db.prepare('INSERT INTO schema_migrations (filename) VALUES (?)').run(migration.filename);
      })();
    }
  }

  get raw(): Database.Database {
    return this.ensureOpen();
  }
}

let defaultDb: AgentDatabase | null = null;
let defaultDbPath: string | null = null;
let exitHandler: (() => void) | null = null;

export function getDatabase(config?: SchruteConfig): AgentDatabase {
  const requestedPath = getDbPath(config);

  if (defaultDb) {
    // Guard: reject if a different config/dataDir tries to reuse the singleton
    if (defaultDbPath && requestedPath !== defaultDbPath) {
      throw new Error(
        `Database singleton already initialized for "${defaultDbPath}". ` +
        `Cannot reinitialize for "${requestedPath}". ` +
        `Close the existing database first with closeDatabase().`,
      );
    }
    return defaultDb;
  }

  defaultDb = new AgentDatabase(config);
  defaultDbPath = requestedPath;
  defaultDb.open();

  // Register atexit handler for WAL checkpoint — once only, removable on close
  if (!exitHandler) {
    exitHandler = () => {
      if (defaultDb) {
        try { defaultDb.close(); } catch (err) {
          try { console.error('[schrute] Failed to close database on exit:', err); } catch { /* truly best effort */ }
        }
        defaultDb = null;
        defaultDbPath = null;
      }
    };
    process.on('exit', exitHandler);
  }

  return defaultDb;
}

export function closeDatabase(): void {
  if (defaultDb) {
    defaultDb.close();
    defaultDb = null;
    defaultDbPath = null;
  }
  // Remove the exit listener to prevent accumulation across open/close cycles
  if (exitHandler) {
    process.removeListener('exit', exitHandler);
    exitHandler = null;
  }
}
