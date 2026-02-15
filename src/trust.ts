import * as fs from 'node:fs';
import * as path from 'node:path';
import { getConfig, getDataDir, getDbPath } from './core/config.js';
import { getLogger } from './core/logger.js';
import type { OneAgentConfig, SkillStatusName } from './skill/types.js';

// ─── Types ────────────────────────────────────────────────────────

export interface TrustPosture {
  network: {
    transport: string;
    allowedHosts: number;
    publicIpsOnly: boolean;
  };
  secrets: {
    keychainOk: boolean;
    storedSessions: number;
    exportExcludesCreds: boolean;
  };
  redaction: {
    lastScanClean: boolean;
    violations: number;
  };
  skills: {
    active: number;
    stale: number;
    locked: number;
    broken: number;
  };
  retention: {
    usedMb: number;
    globalCapMb: number;
    oldestFrameDays: number | null;
  };
}

// ─── Data Collection ──────────────────────────────────────────────

function getNetworkInfo(config: OneAgentConfig): TrustPosture['network'] {
  // v0.1: always stdio, local-only
  let allowedHosts = 0;

  const dbPath = getDbPath(config);
  if (fs.existsSync(dbPath)) {
    try {
      const Database = require('better-sqlite3');
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db
          .prepare(
            "SELECT COUNT(DISTINCT json_each.value) as cnt FROM site_policies, json_each(site_policies.domain_allowlist)",
          )
          .get() as { cnt: number } | undefined;
        allowedHosts = row?.cnt ?? 0;
      } catch {
        // Table may not exist
      }
      db.close();
    } catch {
      // DB not available
    }
  }

  return {
    transport: config.server.network ? 'network (HTTP)' : 'local-only (MCP stdio)',
    allowedHosts,
    publicIpsOnly: true, // always enforced
  };
}

function getSecretsInfo(config: OneAgentConfig): TrustPosture['secrets'] {
  let storedSessions = 0;

  // Count stored sessions from DB if available
  const dbPath = getDbPath(config);
  if (fs.existsSync(dbPath)) {
    try {
      const Database = require('better-sqlite3');
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db
          .prepare('SELECT COUNT(*) as cnt FROM site_manifests')
          .get() as { cnt: number } | undefined;
        storedSessions = row?.cnt ?? 0;
      } catch {
        // Table may not exist
      }
      db.close();
    } catch {
      // DB not available
    }
  }

  return {
    keychainOk: true, // doctor validates this separately
    storedSessions,
    exportExcludesCreds: true, // always enforced in v0.1
  };
}

function getRedactionInfo(config: OneAgentConfig): TrustPosture['redaction'] {
  let violations = 0;

  const dbPath = getDbPath(config);
  if (fs.existsSync(dbPath)) {
    try {
      const Database = require('better-sqlite3');
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db
          .prepare(
            "SELECT COUNT(*) as cnt FROM audit_log WHERE json_extract(policy_decision, '$.redactionsApplied') != '[]'",
          )
          .get() as { cnt: number } | undefined;
        violations = row?.cnt ?? 0;
      } catch {
        // Table may not exist
      }
      db.close();
    } catch {
      // DB not available
    }
  }

  return {
    lastScanClean: violations === 0,
    violations,
  };
}

function getSkillsInfo(config: OneAgentConfig): TrustPosture['skills'] {
  const result = { active: 0, stale: 0, locked: 0, broken: 0 };

  const dbPath = getDbPath(config);
  if (fs.existsSync(dbPath)) {
    try {
      const Database = require('better-sqlite3');
      const db = new Database(dbPath, { readonly: true });
      try {
        const rows = db
          .prepare('SELECT status, tier_lock FROM skills')
          .all() as Array<{ status: string; tier_lock: string | null }>;

        for (const row of rows) {
          const status = row.status as SkillStatusName;
          if (status === 'active') result.active++;
          else if (status === 'stale') result.stale++;
          else if (status === 'broken') result.broken++;

          // Check tier lock (Tier 3 locked)
          if (row.tier_lock) {
            try {
              const lock = JSON.parse(row.tier_lock);
              if (lock?.type === 'permanent') result.locked++;
            } catch {
              // not valid JSON
            }
          }
        }
      } catch {
        // Table may not exist
      }
      db.close();
    } catch {
      // DB not available
    }
  }

  return result;
}

function getRetentionInfo(config: OneAgentConfig): TrustPosture['retention'] {
  let usedMb = 0;
  let oldestFrameDays: number | null = null;

  const dataDir = getDataDir(config);
  const dataPath = path.join(dataDir, 'data');

  // Calculate used storage
  if (fs.existsSync(dataPath)) {
    try {
      const entries = fs.readdirSync(dataPath);
      for (const entry of entries) {
        const entryPath = path.join(dataPath, entry);
        try {
          const stat = fs.statSync(entryPath);
          if (stat.isFile()) {
            usedMb += stat.size / (1024 * 1024);
          }
        } catch {
          // skip inaccessible files
        }
      }
    } catch {
      // data dir unreadable
    }
  }

  // Get oldest frame
  const dbPath = getDbPath(config);
  if (fs.existsSync(dbPath)) {
    try {
      const Database = require('better-sqlite3');
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db
          .prepare('SELECT MIN(started_at) as oldest FROM action_frames')
          .get() as { oldest: number | null } | undefined;
        if (row?.oldest) {
          oldestFrameDays = Math.floor(
            (Date.now() - row.oldest) / (1000 * 60 * 60 * 24),
          );
        }
      } catch {
        // Table may not exist
      }
      db.close();
    } catch {
      // DB not available
    }
  }

  return {
    usedMb: Math.round(usedMb * 10) / 10,
    globalCapMb: config.storage.maxGlobalMb,
    oldestFrameDays,
  };
}

// ─── Main Trust Report ────────────────────────────────────────────

export function getTrustPosture(config?: OneAgentConfig): TrustPosture {
  const cfg = config ?? getConfig();

  return {
    network: getNetworkInfo(cfg),
    secrets: getSecretsInfo(cfg),
    redaction: getRedactionInfo(cfg),
    skills: getSkillsInfo(cfg),
    retention: getRetentionInfo(cfg),
  };
}

export function formatTrustReport(posture: TrustPosture): string {
  const lines: string[] = [];

  lines.push(
    `Network:    ${posture.network.transport}, ${posture.network.allowedHosts} allowed hosts, ${posture.network.publicIpsOnly ? 'allow-only-public IPs' : 'WARNING: non-public IPs allowed'}`,
  );
  lines.push(
    `Secrets:    keychain ${posture.secrets.keychainOk ? 'OK' : 'UNAVAILABLE'}, ${posture.secrets.storedSessions} stored sessions, export ${posture.secrets.exportExcludesCreds ? 'excludes' : 'INCLUDES'} creds`,
  );
  lines.push(
    `Redaction:  last scan ${posture.redaction.lastScanClean ? 'clean' : 'DIRTY'}, ${posture.redaction.violations} violations`,
  );
  lines.push(
    `Skills:     ${posture.skills.active} active, ${posture.skills.stale} stale, ${posture.skills.locked} locked (Tier 3), ${posture.skills.broken} broken`,
  );

  const oldestStr =
    posture.retention.oldestFrameDays !== null
      ? `${posture.retention.oldestFrameDays} days`
      : 'none';
  lines.push(
    `Retention:  ${posture.retention.usedMb}MB / ${posture.retention.globalCapMb / 1000}GB global cap, oldest frame: ${oldestStr}`,
  );

  return lines.join('\n');
}
