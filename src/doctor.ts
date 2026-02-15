import * as fs from 'node:fs';
import * as path from 'node:path';
import { getConfig, getDataDir, getTmpDir, getDbPath } from './core/config.js';
import { getLogger } from './core/logger.js';
import * as secrets from './storage/secrets.js';
import { AuditLog } from './replay/audit-log.js';
import type { OneAgentConfig } from './skill/types.js';

// ─── Types ────────────────────────────────────────────────────────

export type CheckStatus = 'pass' | 'fail' | 'warning';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  details?: string;
}

export interface DoctorReport {
  timestamp: number;
  version: string;
  checks: CheckResult[];
  summary: { pass: number; fail: number; warning: number };
}

// ─── Individual Checks ────────────────────────────────────────────

async function checkPlaywrightBrowsers(): Promise<CheckResult> {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return {
      name: 'playwright_browsers',
      status: 'pass',
      message: 'Chromium browser available',
    };
  } catch (err) {
    return {
      name: 'playwright_browsers',
      status: 'fail',
      message: 'Chromium browser not available',
      details: `Install with: npx playwright install chromium\n${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkKeychainAccess(): Promise<CheckResult> {
  const testKey = '__oneagent_doctor_test__';
  const testValue = `doctor-${Date.now()}`;

  try {
    await secrets.store(testKey, testValue);
    const retrieved = await secrets.retrieve(testKey);
    await secrets.remove(testKey);

    if (retrieved === testValue) {
      return {
        name: 'keychain_access',
        status: 'pass',
        message: 'Keychain store/retrieve/delete working',
      };
    }

    return {
      name: 'keychain_access',
      status: 'fail',
      message: 'Keychain retrieval returned unexpected value',
      details: `Expected '${testValue}', got '${retrieved}'`,
    };
  } catch (err) {
    return {
      name: 'keychain_access',
      status: 'fail',
      message: 'Keychain access failed',
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

function checkDurableStorageClean(config: OneAgentConfig): CheckResult {
  const dataDir = path.join(getDataDir(config), 'data');
  if (!fs.existsSync(dataDir)) {
    return {
      name: 'durable_storage_clean',
      status: 'pass',
      message: 'No durable storage directory yet',
    };
  }

  const rawExtensions = ['.har', '.tmp', '.partial', '.raw'];
  const issues: string[] = [];

  try {
    const entries = fs.readdirSync(dataDir, { recursive: true }) as string[];
    for (const entry of entries) {
      const ext = path.extname(String(entry)).toLowerCase();
      if (rawExtensions.includes(ext)) {
        issues.push(String(entry));
      }
    }
  } catch {
    // Directory read error is not a storage cleanliness issue
  }

  if (issues.length > 0) {
    return {
      name: 'durable_storage_clean',
      status: 'fail',
      message: `Found ${issues.length} raw artifact(s) in durable storage`,
      details: issues.slice(0, 10).join(', '),
    };
  }

  return {
    name: 'durable_storage_clean',
    status: 'pass',
    message: 'No raw artifacts in durable storage',
  };
}

function checkTempDirCleanup(config: OneAgentConfig): CheckResult {
  const tmpDir = getTmpDir(config);
  if (!fs.existsSync(tmpDir)) {
    return {
      name: 'temp_dir_cleanup',
      status: 'pass',
      message: 'No temp directory',
    };
  }

  const now = Date.now();
  const ttl = config.tempTtlMs;
  let staleCount = 0;
  let cleanedCount = 0;
  const warnings: string[] = [];

  try {
    const entries = fs.readdirSync(tmpDir);
    for (const entry of entries) {
      const entryPath = path.join(tmpDir, entry);
      const stat = fs.statSync(entryPath);
      const age = now - stat.mtimeMs;
      const lockfilePath = path.join(entryPath, '.lock');
      const hasLockfile = fs.existsSync(lockfilePath);

      if (age > ttl) {
        if (hasLockfile) {
          // Stale with lockfile -- invariant breach
          staleCount++;
        } else {
          // Stale without lockfile -- try to clean
          try {
            fs.rmSync(entryPath, { recursive: true, force: true });
            cleanedCount++;
          } catch {
            staleCount++;
          }
        }
      } else if (!hasLockfile && stat.isDirectory()) {
        // Young but no lockfile -- warning
        warnings.push(entry);
      }
    }
  } catch {
    // temp dir read error
  }

  if (staleCount > 0) {
    return {
      name: 'temp_dir_cleanup',
      status: 'fail',
      message: `${staleCount} stale temp dir(s) beyond TTL (${cleanedCount} cleaned)`,
    };
  }

  if (warnings.length > 0) {
    return {
      name: 'temp_dir_cleanup',
      status: 'warning',
      message: `${warnings.length} temp dir(s) without lockfile (age < TTL, recoverable)`,
      details: warnings.slice(0, 5).join(', '),
    };
  }

  if (cleanedCount > 0) {
    return {
      name: 'temp_dir_cleanup',
      status: 'pass',
      message: `Cleaned ${cleanedCount} stale temp dir(s)`,
    };
  }

  return {
    name: 'temp_dir_cleanup',
    status: 'pass',
    message: 'Temp directory clean',
  };
}

function checkFilePermissions(config: OneAgentConfig): CheckResult {
  const dataDir = getDataDir(config);
  if (!fs.existsSync(dataDir)) {
    return {
      name: 'file_permissions',
      status: 'pass',
      message: 'Data directory does not exist yet',
    };
  }

  try {
    const stat = fs.statSync(dataDir);
    const mode = stat.mode & 0o777;

    // Data dir should be 0o700 (user-only access)
    if (mode === 0o700) {
      return {
        name: 'file_permissions',
        status: 'pass',
        message: 'Data directory permissions correct (700)',
      };
    }

    // Group/other readable is a warning
    if (mode & 0o077) {
      return {
        name: 'file_permissions',
        status: 'warning',
        message: `Data directory permissions too open: ${mode.toString(8)}`,
        details: `Expected 700, got ${mode.toString(8)}. Run: chmod 700 "${dataDir}"`,
      };
    }

    return {
      name: 'file_permissions',
      status: 'pass',
      message: `Data directory permissions: ${mode.toString(8)}`,
    };
  } catch (err) {
    return {
      name: 'file_permissions',
      status: 'fail',
      message: 'Cannot check data directory permissions',
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkWalCheckpoint(config: OneAgentConfig): Promise<CheckResult> {
  const dbPath = getDbPath(config);
  if (!fs.existsSync(dbPath)) {
    return {
      name: 'wal_checkpoint',
      status: 'pass',
      message: 'Database does not exist yet',
    };
  }

  try {
    const DatabaseModule = await import('better-sqlite3');
    const Database = DatabaseModule.default;
    const db = new Database(dbPath, { readonly: false });
    const result = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{
      busy: number;
      log: number;
      checkpointed: number;
    }>;
    db.close();

    const entry = result[0];
    if (entry && entry.busy === 0) {
      return {
        name: 'wal_checkpoint',
        status: 'pass',
        message: `WAL checkpoint complete (${entry.checkpointed} pages)`,
      };
    }

    return {
      name: 'wal_checkpoint',
      status: 'warning',
      message: 'WAL checkpoint could not complete (database busy)',
    };
  } catch (err) {
    return {
      name: 'wal_checkpoint',
      status: 'fail',
      message: 'WAL checkpoint failed',
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

function checkBuildProfile(): CheckResult {
  // v0.1: only stdio transport, no HTTP
  return {
    name: 'build_profile',
    status: 'pass',
    message: 'v0.1 — stdio MCP transport, local-only, no HTTP',
  };
}

function checkAuditHashChain(config: OneAgentConfig): CheckResult {
  // Audit is JSONL file-based, not a DB table. Use AuditLog.verifyChain().
  try {
    const auditLog = new AuditLog(config);
    const verification = auditLog.verifyChain();

    if (verification.totalEntries === 0) {
      return {
        name: 'audit_hash_chain',
        status: 'pass',
        message: verification.message ?? 'No audit entries to verify',
      };
    }

    if (!verification.valid) {
      return {
        name: 'audit_hash_chain',
        status: 'fail',
        message: `Audit hash chain broken at entry ${verification.brokenAt} (${verification.totalEntries} entries)`,
        details: verification.message,
      };
    }

    return {
      name: 'audit_hash_chain',
      status: 'pass',
      message: `Audit hash chain intact (${verification.totalEntries} entries)`,
    };
  } catch (err) {
    return {
      name: 'audit_hash_chain',
      status: 'fail',
      message: 'Audit hash chain verification failed',
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Main Doctor ──────────────────────────────────────────────────

export async function runDoctor(
  config?: OneAgentConfig,
): Promise<DoctorReport> {
  const cfg = config ?? getConfig();
  const log = getLogger();

  log.info('Running oneagent doctor...');

  const checks: CheckResult[] = [];

  // Run async checks
  const [playwrightResult, keychainResult] = await Promise.all([
    checkPlaywrightBrowsers(),
    checkKeychainAccess(),
  ]);

  checks.push(playwrightResult);
  checks.push(keychainResult);

  // Run sync checks
  checks.push(checkDurableStorageClean(cfg));
  checks.push(checkTempDirCleanup(cfg));
  checks.push(checkFilePermissions(cfg));
  checks.push(await checkWalCheckpoint(cfg));
  checks.push(checkBuildProfile());
  checks.push(checkAuditHashChain(cfg));

  const summary = {
    pass: checks.filter((c) => c.status === 'pass').length,
    fail: checks.filter((c) => c.status === 'fail').length,
    warning: checks.filter((c) => c.status === 'warning').length,
  };

  const report: DoctorReport = {
    timestamp: Date.now(),
    version: '0.1.0',
    checks,
    summary,
  };

  log.info(
    { pass: summary.pass, fail: summary.fail, warning: summary.warning },
    'Doctor complete',
  );

  return report;
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`OneAgent Doctor (v${report.version})`);
  lines.push('='.repeat(40));
  lines.push('');

  for (const check of report.checks) {
    const icon =
      check.status === 'pass' ? 'PASS' : check.status === 'fail' ? 'FAIL' : 'WARN';
    lines.push(`[${icon}] ${check.name}: ${check.message}`);
    if (check.details) {
      lines.push(`       ${check.details}`);
    }
  }

  lines.push('');
  lines.push(
    `Summary: ${report.summary.pass} passed, ${report.summary.fail} failed, ${report.summary.warning} warnings`,
  );

  return lines.join('\n');
}
