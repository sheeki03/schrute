-- Schrute v0.1 initial schema
-- SQLite with WAL mode (set at connection time, not here)

-- ─── Sites ───────────────────────────────────────────────────────────
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

-- ─── Skills ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skills (
  id                TEXT PRIMARY KEY,  -- site.action.vN
  site_id           TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  version           INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'draft',
  description       TEXT,
  method            TEXT NOT NULL,
  path_template     TEXT NOT NULL,
  input_schema      TEXT NOT NULL DEFAULT '{}',       -- JSON
  output_schema     TEXT,       -- JSON
  auth_type         TEXT,
  required_headers  TEXT,       -- JSON
  dynamic_headers   TEXT,       -- JSON
  side_effect_class TEXT NOT NULL DEFAULT 'read-only',
  is_composite      INTEGER NOT NULL DEFAULT 0,
  chain_spec        TEXT,       -- JSON
  current_tier      TEXT NOT NULL DEFAULT 'tier_3',
  tier_lock         TEXT,       -- JSON
  confidence        REAL NOT NULL DEFAULT 0.0,
  consecutive_validations INTEGER NOT NULL DEFAULT 0,
  sample_count      INTEGER NOT NULL DEFAULT 0,
  parameter_evidence TEXT,      -- JSON
  last_verified     INTEGER,
  last_used         INTEGER,
  success_rate      REAL NOT NULL DEFAULT 0.0,
  skill_md          TEXT,
  openapi_fragment  TEXT,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  UNIQUE(site_id, name, version)
);

-- ─── Auth Flows ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auth_flows (
  id                TEXT PRIMARY KEY,
  site_id           TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  type              TEXT NOT NULL,
  recipe            TEXT,       -- JSON, encrypted at rest
  token_keychain_ref TEXT,
  token_expires_at  INTEGER,
  last_refreshed    INTEGER
);

-- ─── Action Frames ───────────────────────────────────────────────────
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

-- ─── Action Frame Entries ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS action_frame_entries (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  frame_id          TEXT NOT NULL REFERENCES action_frames(id) ON DELETE CASCADE,
  request_hash      TEXT NOT NULL,
  classification    TEXT NOT NULL,
  noise_reason      TEXT,
  cluster_id        TEXT,
  redaction_applied INTEGER NOT NULL DEFAULT 0
);

-- ─── Skill Confirmations ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skill_confirmations (
  skill_id            TEXT PRIMARY KEY REFERENCES skills(id) ON DELETE CASCADE,
  confirmation_status TEXT NOT NULL DEFAULT 'pending',
  approved_by         TEXT,
  approved_at         INTEGER,
  denied_at           INTEGER
);

-- ─── Confirmation Nonces ─────────────────────────────────────────────
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

-- ─── Skill Metrics ───────────────────────────────────────────────────
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

-- ─── Policies ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS policies (
  site_id             TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  allowed_methods     TEXT NOT NULL DEFAULT '["GET","HEAD","POST:read-only"]',
  max_qps             REAL NOT NULL DEFAULT 1.0,
  max_concurrent      INTEGER NOT NULL DEFAULT 1,
  min_gap_ms          INTEGER NOT NULL DEFAULT 100,
  read_only_default   INTEGER NOT NULL DEFAULT 1,
  require_confirmation TEXT NOT NULL DEFAULT '[]',
  domain_allowlist    TEXT,       -- JSON
  redaction_rules     TEXT NOT NULL DEFAULT '[]',
  capabilities        TEXT NOT NULL DEFAULT '["net.fetch.direct","net.fetch.browserProxied","browser.automation","storage.write","secrets.use"]'
);

-- ─── Performance Indexes ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_skills_site_status
  ON skills(site_id, status);

CREATE INDEX IF NOT EXISTS idx_skill_metrics_skill_time
  ON skill_metrics(skill_id, executed_at);

CREATE INDEX IF NOT EXISTS idx_action_frames_site_time
  ON action_frames(site_id, started_at);

CREATE INDEX IF NOT EXISTS idx_sites_last_visited
  ON sites(last_visited);
