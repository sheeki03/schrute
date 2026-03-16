import * as fs from 'node:fs';
import * as path from 'node:path';
import { getConfig, getDataDir, getDbPath } from './core/config.js';
import { getLogger } from './core/logger.js';
import { getDatabase } from './storage/database.js';
import { isPublicIp } from './core/policy.js';
import * as secrets from './storage/secrets.js';
import type { SchruteConfig, SkillStatusName } from './skill/types.js';

const log = getLogger();

// ─── Database Helper ──────────────────────────────────────────────

/**
 * Open the database (if it exists) and run `fn` against it.
 * Returns `fallback` if the DB file is missing or any error occurs.
 */
function withDatabase<T>(
  config: SchruteConfig,
  fn: (db: ReturnType<typeof getDatabase>) => T,
  label: string,
  fallback: T,
): T {
  const dbPath = getDbPath(config);
  if (!fs.existsSync(dbPath)) {
    return fallback;
  }
  try {
    const db = getDatabase(config);
    try {
      return fn(db);
    } catch (err) {
      log.warn({ err }, `Trust computation: ${label} query failed`);
      return fallback;
    }
  } catch (err) {
    log.warn({ err }, `Trust computation: failed to open database for ${label}`);
    return fallback;
  }
}

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
    piiDetected: boolean;
    redactionsApplied: number;
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

function getNetworkInfo(config: SchruteConfig): TrustPosture['network'] {
  const allowedHosts = withDatabase(
    config,
    (db) => {
      const row = db.get<{ cnt: number }>(
        "SELECT COUNT(DISTINCT json_each.value) as cnt FROM policies, json_each(policies.domain_allowlist)",
      );
      return row?.cnt ?? 0;
    },
    'allowed hosts',
    0,
  );

  // Verify IP enforcement actually blocks private ranges
  const publicIpsEnforced = !isPublicIp('127.0.0.1') && !isPublicIp('10.0.0.1');

  return {
    transport: config.server.network ? 'network (HTTP)' : 'local-only (MCP stdio)',
    allowedHosts,
    publicIpsOnly: publicIpsEnforced,
  };
}

async function getSecretsInfo(config: SchruteConfig): Promise<TrustPosture['secrets']> {
  let storedSessions = 0;
  let keychainOk = false;

  // Test keychain access
  try {
    const testKey = '__schrute_trust_probe__';
    const testVal = `probe-${Date.now()}`;
    await secrets.store(testKey, testVal);
    const retrieved = await secrets.retrieve(testKey);
    await secrets.remove(testKey);
    keychainOk = retrieved === testVal;
  } catch (err) {
    log.warn({ err }, 'Trust computation: keychain access test failed');
    keychainOk = false;
  }

  // Count stored sessions from DB if available
  storedSessions = withDatabase(
    config,
    (db) => {
      const row = db.get<{ cnt: number }>('SELECT COUNT(*) as cnt FROM sites');
      return row?.cnt ?? 0;
    },
    'stored sessions',
    0,
  );

  return {
    keychainOk,
    storedSessions,
    exportExcludesCreds: true, // always enforced
  };
}

function getRedactionInfo(config: SchruteConfig): TrustPosture['redaction'] {
  let redactionsApplied = 0;

  // Audit is JSONL file-based, not a DB table. Read the audit file and count redaction violations.
  const auditFilePath = path.join(config.dataDir, 'audit', 'audit.jsonl');
  if (fs.existsSync(auditFilePath)) {
    try {
      const content = fs.readFileSync(auditFilePath, 'utf-8').trim();
      if (content) {
        for (const line of content.split('\n')) {
          try {
            const entry = JSON.parse(line);
            const redactions = entry.policyDecision?.redactionsApplied;
            if (Array.isArray(redactions) && redactions.length > 0) {
              redactionsApplied++;
            }
          } catch (err) {
            log.warn({ err }, 'Trust computation: failed to parse audit log line');
          }
        }
      }
    } catch (err) {
      log.warn({ err }, 'Trust computation: failed to read audit file');
    }
  }

  return {
    piiDetected: redactionsApplied > 0,
    redactionsApplied,
  };
}

function getSkillsInfo(config: SchruteConfig): TrustPosture['skills'] {
  return withDatabase(
    config,
    (db) => {
      const result = { active: 0, stale: 0, locked: 0, broken: 0 };
      const rows = db.all<{ status: string; tier_lock: string | null }>(
        'SELECT status, tier_lock FROM skills',
      );

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
          } catch (err) {
            log.warn({ err }, 'Trust computation: failed to parse tier_lock JSON');
          }
        }
      }

      return result;
    },
    'skills info',
    { active: 0, stale: 0, locked: 0, broken: 0 },
  );
}

function getRetentionInfo(config: SchruteConfig): TrustPosture['retention'] {
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
        } catch (err) {
          log.warn({ err, entryPath }, 'Trust computation: failed to stat file for retention calculation');
        }
      }
    } catch (err) {
      log.warn({ err }, 'Trust computation: failed to read data directory');
    }
  }

  // Get oldest frame
  oldestFrameDays = withDatabase(
    config,
    (db) => {
      const row = db.get<{ oldest: number | null }>(
        'SELECT MIN(started_at) as oldest FROM action_frames',
      );
      if (row?.oldest) {
        return Math.floor((Date.now() - row.oldest) / (1000 * 60 * 60 * 24));
      }
      return null;
    },
    'oldest action frame',
    null,
  );

  return {
    usedMb: Math.round(usedMb * 10) / 10,
    globalCapMb: config.storage.maxGlobalMb,
    oldestFrameDays,
  };
}

// ─── Main Trust Report ────────────────────────────────────────────

export async function getTrustPosture(config?: SchruteConfig): Promise<TrustPosture> {
  const cfg = config ?? getConfig();

  return {
    network: getNetworkInfo(cfg),
    secrets: await getSecretsInfo(cfg),
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
    `Redaction:  ${posture.redaction.redactionsApplied} redactions applied, PII detected: ${posture.redaction.piiDetected ? 'yes' : 'no'}`,
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
