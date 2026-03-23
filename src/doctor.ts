import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { getConfig, getDataDir, getTmpDir, getDbPath } from './core/config.js';
import { getLogger } from './core/logger.js';
import * as secrets from './storage/secrets.js';
import { AuditLog } from './replay/audit-log.js';
import type { SchruteConfig } from './skill/types.js';
import { VERSION } from './version.js';

const log = getLogger();

// ─── Types ────────────────────────────────────────────────────────

type CheckStatus = 'pass' | 'fail' | 'warning';

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

async function checkBrowserEngine(cfg: SchruteConfig): Promise<CheckResult> {
  const engine = cfg.browser?.engine ?? 'patchright';
  const installInstructions: Record<string, string> = {
    playwright: 'npx playwright install chromium',
    patchright: 'npm install patchright && npx patchright install chromium',
    camoufox: 'npm install camoufox-js && npx camoufox-js fetch',
  };

  let browser: import('playwright').Browser | null = null;
  try {
    const { launchBrowserEngine } = await import('./browser/engine.js');
    const result = await launchBrowserEngine(engine, { headless: true });
    browser = result.browser;

    if (result.capabilities.configuredEngine !== result.capabilities.effectiveEngine) {
      return {
        name: 'browser_engine',
        status: 'warning',
        message: `Configured engine "${result.capabilities.configuredEngine}" unavailable — fell back to "${result.capabilities.effectiveEngine}"`,
        details: `Install: ${installInstructions[engine] ?? 'unknown engine'}`,
      };
    }

    return {
      name: 'browser_engine',
      status: 'pass',
      message: `Browser engine "${result.capabilities.effectiveEngine}" available`,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const isNotInstalled = errMsg.includes("Executable doesn't exist") || errMsg.includes('executable doesn\'t exist');
    return {
      name: 'browser_engine',
      status: 'fail',
      message: isNotInstalled
        ? `Browser not installed. Run: ${installInstructions[engine] ?? 'unknown engine'}`
        : `Browser engine "${engine}" not available`,
      details: isNotInstalled ? undefined : `Install with: ${installInstructions[engine] ?? 'unknown engine'}\n${errMsg}`,
    };
  } finally {
    await browser?.close().catch((err) => log.debug({ err }, 'Doctor: browser cleanup failed'));
  }
}

async function checkKeychainAccess(): Promise<CheckResult> {
  const testKey = '__schrute_doctor_test__';
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

function checkDurableStorageClean(config: SchruteConfig): CheckResult {
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
  } catch (err) {
    return {
      name: 'durable_storage_clean',
      status: 'warning' as const,
      message: 'Could not read durable storage directory',
      details: err instanceof Error ? err.message : String(err),
    };
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

function checkTempDirCleanup(config: SchruteConfig): CheckResult {
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
          } catch (err) {
            log.debug({ err }, 'Failed to remove stale entry during cleanup');
            staleCount++;
          }
        }
      } else if (!hasLockfile && stat.isDirectory()) {
        // Young but no lockfile -- warning
        warnings.push(entry);
      }
    }
  } catch (err) {
    return {
      name: 'temp_dir_cleanup',
      status: 'warning' as const,
      message: 'Could not read temp directory',
      details: err instanceof Error ? err.message : String(err),
    };
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

function checkFilePermissions(config: SchruteConfig): CheckResult {
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

async function checkWalCheckpoint(config: SchruteConfig): Promise<CheckResult> {
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

function checkAuditHashChain(config: SchruteConfig): CheckResult {
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
        status: 'warning',
        message: `Audit hash chain broken at entry ${verification.brokenAt} (${verification.totalEntries} entries)`,
        details: `${verification.message ?? ''} (expected when database is shared across dev sessions or keychain key was rotated)`.trim(),
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

async function checkNativeModules(): Promise<CheckResult> {
  try {
    const DatabaseModule = await import('better-sqlite3');
    // If import succeeds, the native module ABI matches the current Node version
    if (typeof DatabaseModule === 'function' || typeof DatabaseModule.default === 'function') {
      return {
        name: 'native_modules',
        status: 'pass',
        message: `better-sqlite3 native module loaded (Node ${process.version})`,
      };
    }
    return {
      name: 'native_modules',
      status: 'warning',
      message: 'better-sqlite3 loaded but export shape unexpected',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isAbiMismatch = msg.includes('NODE_MODULE_VERSION') || msg.includes('was compiled against');
    return {
      name: 'native_modules',
      status: 'fail',
      message: isAbiMismatch
        ? `better-sqlite3 ABI mismatch — rebuild with: npm rebuild better-sqlite3`
        : `better-sqlite3 native module failed to load`,
      details: `Node ${process.version}. ${msg}`,
    };
  }
}

async function checkExecutionBackend(cfg: SchruteConfig): Promise<CheckResult> {
  const backend = cfg.browser?.execution?.backend ?? 'agent-browser';
  if (backend === 'playwright') {
    return {
      name: 'execution_backend',
      status: 'pass',
      message: 'Execution backend set to playwright',
    };
  }

  // Step 1: Check `which agent-browser`
  const binaryFound = await new Promise<boolean>((resolve) => {
    execFile('which', ['agent-browser'], { timeout: 5000 }, (err) => {
      resolve(!err);
    });
  });

  if (!binaryFound) {
    return {
      name: 'execution_backend',
      status: 'warning',
      message: 'agent-browser binary not found — Playwright fallback is active',
      details: 'Install agent-browser for faster Lightpanda-based execution. Skills will execute via Playwright in the meantime.',
    };
  }

  // Step 2: Deep probe — bootstrap a session, connect via IPC, verify, tear down
  try {
    const { AgentBrowserIpcClient } = await import('./browser/agent-browser-ipc.js');
    const probeName = `__doctor_${process.pid}_${Date.now()}__`;
    const ipc = new AgentBrowserIpcClient();
    try {
      await ipc.bootstrapDaemon(probeName);
      await ipc.connect(probeName);
      await ipc.send({ action: 'url' });
      await ipc.send({ action: 'close' });
      ipc.close();
    } catch (err) {
      ipc.close();
      const msg = err instanceof Error ? err.message : String(err);
      return {
        name: 'execution_backend',
        status: 'warning',
        message: 'agent-browser binary found but IPC probe failed',
        details: `Socket communication test failed: ${msg}`,
      };
    }

    return {
      name: 'execution_backend',
      status: 'pass',
      message: 'agent-browser binary found and IPC socket verified',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: 'execution_backend',
      status: 'warning',
      message: 'agent-browser binary found but deep probe failed',
      details: msg,
    };
  }
}

// ─── WS-9 Checks ─────────────────────────────────────────────────

async function checkSkillHealth(config: SchruteConfig): Promise<CheckResult> {
  try {
    const { getDatabase } = await import('./storage/database.js');
    const { SkillRepository } = await import('./storage/skill-repository.js');
    const { SkillStatus } = await import('./skill/types.js');
    const db = getDatabase(config);
    const skillRepo = new SkillRepository(db);
    const broken = skillRepo.getByStatus(SkillStatus.BROKEN);
    const stale = skillRepo.getByStatus(SkillStatus.STALE);

    if (broken.length > 0) {
      return {
        name: 'skill_health',
        status: 'fail',
        message: `${broken.length} broken skill(s)`,
        details: broken.map(s => s.id).slice(0, 5).join(', '),
      };
    }
    if (stale.length > 0) {
      return {
        name: 'skill_health',
        status: 'warning',
        message: `${stale.length} stale skill(s)`,
        details: stale.map(s => s.id).slice(0, 5).join(', '),
      };
    }
    return { name: 'skill_health', status: 'pass', message: 'All skills healthy' };
  } catch (err) {
    return { name: 'skill_health', status: 'warning', message: 'Could not check skill health', details: err instanceof Error ? err.message : String(err) };
  }
}

async function checkDirectTierViability(): Promise<CheckResult> {
  try {
    const https = await import('node:https');
    const tls = await import('node:tls');
    const crypto = await import('node:crypto');
    if (typeof https.request !== 'function') {
      return { name: 'direct_tier_viability', status: 'fail', message: 'node:https.request not available' };
    }

    // Generate an ephemeral self-signed cert via Node's crypto API.
    // Node 20+ has crypto.X509Certificate but not cert generation.
    // Use generateKeyPairSync + execFileSync openssl for the cert, or
    // use tls.createSecureContext with a pre-baked ephemeral cert.
    // Simplest reliable approach: generate key + self-signed cert via child_process.
    const { execFileSync } = await import('node:child_process');

    let certPem: string;
    let keyPem: string;
    try {
      // Generate key + self-signed cert in one openssl call (no temp files)
      const opensslOut = execFileSync('openssl', [
        'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
        '-keyout', '/dev/stdout', '-out', '/dev/stdout',
        '-days', '1', '-nodes', '-batch', '-subj', '/CN=doctor-sni-test.local',
      ], { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });

      // openssl outputs key then cert, both PEM-encoded
      const keyMatch = opensslOut.match(/(-----BEGIN (?:EC )?PRIVATE KEY-----[\s\S]*?-----END (?:EC )?PRIVATE KEY-----)/);
      const certMatch = opensslOut.match(/(-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----)/);
      if (!keyMatch || !certMatch) {
        return { name: 'direct_tier_viability', status: 'warning', message: 'openssl available but output unexpected — SNI check skipped' };
      }
      keyPem = keyMatch[1];
      certPem = certMatch[1];
    } catch {
      // openssl not available — can't generate cert for real TLS test
      return {
        name: 'direct_tier_viability',
        status: 'warning',
        message: `openssl not found — cannot verify TLS SNI behavior (Node ${process.version})`,
        details: 'Install openssl for full direct-tier diagnostics. The direct tier will still work if Node supports servername.',
      };
    }

    // Stand up an ephemeral TLS server with the self-signed cert (CN=doctor-sni-test.local).
    // Connect with hostname=127.0.0.1 + servername=doctor-sni-test.local.
    // If the TLS handshake succeeds AND the server sees the correct SNI, the check passes.
    const result = await new Promise<{ passed: boolean; sni?: string }>((resolve) => {
      const deadline = setTimeout(() => { resolve({ passed: false }); }, 5000);

      let receivedSni: string | undefined;
      const server = tls.createServer({ key: keyPem, cert: certPem }, (socket) => {
        receivedSni = (socket as import('node:tls').TLSSocket).servername || undefined;
        socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK');
      });

      server.on('error', () => {
        clearTimeout(deadline);
        resolve({ passed: false });
      });

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        const req = https.request({
          hostname: '127.0.0.1',       // connect to IP
          port: addr.port,
          servername: 'doctor-sni-test.local', // SNI must be this, not 127.0.0.1
          rejectUnauthorized: false,    // self-signed cert
          timeout: 2000,
        }, (res) => {
          res.resume();
          res.on('end', () => {
            clearTimeout(deadline);
            server.close();
            resolve({ passed: true, sni: receivedSni });
          });
        });
        req.on('error', () => {
          clearTimeout(deadline);
          server.close();
          resolve({ passed: false });
        });
        req.on('timeout', () => {
          req.destroy();
          clearTimeout(deadline);
          server.close();
          resolve({ passed: false });
        });
        req.end();
      });
    });

    if (result.passed && result.sni === 'doctor-sni-test.local') {
      return {
        name: 'direct_tier_viability',
        status: 'pass',
        message: `TLS handshake with SNI override verified (servername=${result.sni}, Node ${process.version})`,
      };
    }
    if (result.passed) {
      return {
        name: 'direct_tier_viability',
        status: 'warning',
        message: `TLS handshake succeeded but SNI was '${result.sni ?? 'empty'}', expected 'doctor-sni-test.local'`,
      };
    }
    return {
      name: 'direct_tier_viability',
      status: 'fail',
      message: 'TLS handshake with SNI override failed',
    };
  } catch (err) {
    return {
      name: 'direct_tier_viability',
      status: 'fail',
      message: 'Could not verify direct tier viability',
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkMetricSync(config: SchruteConfig): Promise<CheckResult> {
  try {
    const { getDatabase } = await import('./storage/database.js');
    const { SkillRepository } = await import('./storage/skill-repository.js');
    const { MetricsRepository } = await import('./storage/metrics-repository.js');
    const { monitorSkills } = await import('./healing/monitor.js');
    const { SkillStatus } = await import('./skill/types.js');
    const db = getDatabase(config);
    const skillRepo = new SkillRepository(db);
    const metricsRepo = new MetricsRepository(db);
    const activeSkills = skillRepo.getByStatus(SkillStatus.ACTIVE);

    const divergent: string[] = [];
    for (const skill of activeSkills) {
      const [report] = monitorSkills([skill], metricsRepo);
      if (report && Math.abs(skill.successRate - report.successRate) > 0.1) {
        divergent.push(`${skill.id}: stored=${skill.successRate.toFixed(2)} computed=${report.successRate.toFixed(2)}`);
      }
    }

    if (divergent.length > 0) {
      return {
        name: 'metric_sync',
        status: 'warning',
        message: `${divergent.length}/${activeSkills.length} skill(s) with divergent success rates`,
        details: divergent.slice(0, 5).join('; '),
      };
    }
    return { name: 'metric_sync', status: 'pass', message: `Stored and computed success rates in sync (${activeSkills.length} checked)` };
  } catch (err) {
    return { name: 'metric_sync', status: 'warning', message: 'Could not check metric sync', details: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Main Doctor ──────────────────────────────────────────────────

export async function runDoctor(
  config?: SchruteConfig,
): Promise<DoctorReport> {
  const cfg = config ?? getConfig();
  const log = getLogger();

  log.info('Running schrute doctor...');

  const checks: CheckResult[] = [];

  // Run async checks
  const [browserEngineResult, keychainResult] = await Promise.all([
    checkBrowserEngine(cfg),
    checkKeychainAccess(),
  ]);

  checks.push(browserEngineResult);
  checks.push(keychainResult);

  // Run async native module check
  checks.push(await checkNativeModules());
  checks.push(checkDurableStorageClean(cfg));
  checks.push(checkTempDirCleanup(cfg));
  checks.push(checkFilePermissions(cfg));
  checks.push(await checkWalCheckpoint(cfg));
  checks.push(checkAuditHashChain(cfg));
  checks.push(await checkExecutionBackend(cfg));

  // WS-9: Additional health checks
  checks.push(await checkSkillHealth(cfg));
  checks.push(await checkDirectTierViability());
  checks.push(await checkMetricSync(cfg));

  const summary = {
    pass: checks.filter((c) => c.status === 'pass').length,
    fail: checks.filter((c) => c.status === 'fail').length,
    warning: checks.filter((c) => c.status === 'warning').length,
  };

  const report: DoctorReport = {
    timestamp: Date.now(),
    version: VERSION,
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
  lines.push(`Schrute Doctor (v${report.version})`);
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
