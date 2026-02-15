import * as fs from 'node:fs';
import * as path from 'node:path';
import { getConfig, getDataDir, getDbPath } from './core/config.js';
import { getDatabase } from './storage/database.js';
import { isPublicIp } from './core/policy.js';
import * as secrets from './storage/secrets.js';
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
  let allowedHosts = 0;

  const dbPath = getDbPath(config);
  if (fs.existsSync(dbPath)) {
    try {
      const db = getDatabase(config);
      try {
        const row = db.get<{ cnt: number }>(
          "SELECT COUNT(DISTINCT json_each.value) as cnt FROM policies, json_each(policies.domain_allowlist)",
        );
        allowedHosts = row?.cnt ?? 0;
      } catch {
        // Table may not exist yet
      }
    } catch {
      // DB not available
    }
  }

  // Verify IP enforcement actually blocks private ranges
  const publicIpsEnforced = !isPublicIp('127.0.0.1') && !isPublicIp('10.0.0.1');

  return {
    transport: config.server.network ? 'network (HTTP)' : 'local-only (MCP stdio)',
    allowedHosts,
    publicIpsOnly: publicIpsEnforced,
  };
}

async function getSecretsInfo(config: OneAgentConfig): Promise<TrustPosture['secrets']> {
  let storedSessions = 0;
  let keychainOk = false;

  // Test keychain access
  try {
    const testKey = '__oneagent_trust_probe__';
    const testVal = `probe-${Date.now()}`;
    await secrets.store(testKey, testVal);
    const retrieved = await secrets.retrieve(testKey);
    await secrets.remove(testKey);
    keychainOk = retrieved === testVal;
  } catch {
    keychainOk = false;
  }

  // Count stored sessions from DB if available
  const dbPath = getDbPath(config);
  if (fs.existsSync(dbPath)) {
    try {
      const db = getDatabase(config);
      try {
        const row = db.get<{ cnt: number }>('SELECT COUNT(*) as cnt FROM sites');
        storedSessions = row?.cnt ?? 0;
      } catch {
        // Table may not exist yet
      }
    } catch {
      // DB not available
    }
  }

  return {
    keychainOk,
    storedSessions,
    exportExcludesCreds: true, // always enforced in v0.1
  };
}

function getRedactionInfo(config: OneAgentConfig): TrustPosture['redaction'] {
  let violations = 0;

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
              violations++;
            }
          } catch {
            // skip malformed lines
          }
        }
      }
    } catch {
      // audit file unreadable
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
      const db = getDatabase(config);
      try {
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
            } catch {
              // not valid JSON
            }
          }
        }
      } catch {
        // Table may not exist yet
      }
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
      const db = getDatabase(config);
      try {
        const row = db.get<{ oldest: number | null }>(
          'SELECT MIN(started_at) as oldest FROM action_frames',
        );
        if (row?.oldest) {
          oldestFrameDays = Math.floor(
            (Date.now() - row.oldest) / (1000 * 60 * 60 * 24),
          );
        }
      } catch {
        // Table may not exist yet
      }
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

export async function getTrustPosture(config?: OneAgentConfig): Promise<TrustPosture> {
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
