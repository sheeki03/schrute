import * as fs from 'node:fs';
import * as path from 'node:path';
import { getLogger } from './logger.js';
import type { OneAgentConfig } from '../skill/types.js';
import { VALID_SNAPSHOT_MODES } from '../browser/feature-flags.js';

// Re-export for convenience
export type { OneAgentConfig } from '../skill/types.js';

// ─── ConfigError ────────────────────────────────────────────────────

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// ─── Defaults ───────────────────────────────────────────────────────

const DEFAULT_DATA_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '~',
  '.oneagent',
);

// Daemon config merged into default config alongside all other settings.
const DEFAULT_CONFIG: OneAgentConfig & { daemon: { port: number; autoStart: boolean } } = {
  dataDir: DEFAULT_DATA_DIR,
  logLevel: 'info',
  features: {
    webmcp: false,
    httpTransport: false,
  },
  toolBudget: {
    maxToolCallsPerTask: 50,
    maxConcurrentCalls: 3,
    crossDomainCalls: false,
    secretsToNonAllowlisted: false,
  },
  payloadLimits: {
    maxResponseBodyBytes: 10 * 1024 * 1024,  // 10MB
    maxRequestBodyBytes: 5 * 1024 * 1024,     // 5MB
    replayTimeoutMs: {
      tier1: 30000,
      tier3: 60000,
      tier4: 120000,
    },
    harCaptureMaxBodyBytes: 50 * 1024 * 1024, // 50MB
    redactorTimeoutMs: 10000,
  },
  audit: {
    strictMode: true,
    rootHashExport: true,
  },
  storage: {
    maxPerSiteMb: 500,
    maxGlobalMb: 5000,
    retentionDays: 90,
  },
  server: {
    network: false,
    httpPort: 3000,
  },
  daemon: {
    port: 19420,
    autoStart: false,
  },
  tempTtlMs: 3600000,            // 1 hour
  gcIntervalMs: 900000,          // 15 minutes
  confirmationTimeoutMs: 30000,
  confirmationExpiryMs: 60000,
  promotionConsecutivePasses: 5,
  promotionVolatilityThreshold: 0.2,
  maxToolsPerSite: 20,
  toolShortlistK: 10,
};

const NUMERIC_CONFIG_KEYS = new Set([
  'toolBudget.maxToolCallsPerTask',
  'toolBudget.maxConcurrentCalls',
  'payloadLimits.maxResponseBodyBytes',
  'payloadLimits.maxRequestBodyBytes',
  'payloadLimits.replayTimeoutMs.tier1',
  'payloadLimits.replayTimeoutMs.tier3',
  'payloadLimits.replayTimeoutMs.tier4',
  'payloadLimits.harCaptureMaxBodyBytes',
  'payloadLimits.redactorTimeoutMs',
  'storage.maxPerSiteMb',
  'storage.maxGlobalMb',
  'storage.retentionDays',
  'daemon.port',
  'server.httpPort',
  'tempTtlMs',
  'gcIntervalMs',
  'confirmationTimeoutMs',
  'confirmationExpiryMs',
  'promotionConsecutivePasses',
  'promotionVolatilityThreshold',
  'maxToolsPerSite',
  'toolShortlistK',
]);

// ─── Environment Variable Overrides ─────────────────────────────────

function parseStrictBool(v: string): boolean {
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(`Invalid boolean value: '${v}'. Must be 'true' or 'false'.`);
}

const VALID_BROWSER_ENGINES = new Set(['playwright', 'patchright', 'camoufox']);

function parseBrowserEngine(v: string): string {
  if (!VALID_BROWSER_ENGINES.has(v)) {
    throw new Error(
      `Invalid value: "${v}". Must be one of: ${[...VALID_BROWSER_ENGINES].join(', ')}.`,
    );
  }
  return v;
}

function parseSnapshotMode(v: string): string {
  if (!VALID_SNAPSHOT_MODES.has(v)) {
    throw new Error(
      `Invalid value: "${v}". Must be one of: ${[...VALID_SNAPSHOT_MODES].join(', ')}.`,
    );
  }
  return v;
}

function parseStrictInt(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid port value: '${v}'. Must be integer 1-65535.`);
  }
  return n;
}

const ENV_OVERRIDES: Array<{
  env: string;
  key: string;
  parse: (v: string) => unknown;
}> = [
  { env: 'ONEAGENT_DATA_DIR',       key: 'dataDir',                parse: String },
  { env: 'ONEAGENT_LOG_LEVEL',      key: 'logLevel',               parse: String },
  { env: 'ONEAGENT_AUTH_TOKEN',     key: 'server.authToken',       parse: String },
  { env: 'ONEAGENT_NETWORK',        key: 'server.network',         parse: parseStrictBool },
  { env: 'ONEAGENT_HTTP_TRANSPORT', key: 'features.httpTransport', parse: parseStrictBool },
  { env: 'ONEAGENT_HTTP_PORT',      key: 'server.httpPort',        parse: parseStrictInt },
  { env: 'ONEAGENT_BROWSER_ENGINE', key: 'browser.engine',                parse: parseBrowserEngine },
  { env: 'ONEAGENT_SNAPSHOT_MODE',  key: 'browser.features.snapshotMode', parse: parseSnapshotMode },
  { env: 'ONEAGENT_INCREMENTAL_DIFFS', key: 'browser.features.incrementalDiffs', parse: parseStrictBool },
  { env: 'ONEAGENT_MODAL_TRACKING', key: 'browser.features.modalTracking', parse: parseStrictBool },
  { env: 'ONEAGENT_SCREENSHOT_RESIZE', key: 'browser.features.screenshotResize', parse: parseStrictBool },
  { env: 'ONEAGENT_BATCH_ACTIONS',  key: 'browser.features.batchActions', parse: parseStrictBool },
];

function setNestedValue(obj: Record<string, unknown>, keyPath: string, value: unknown): void {
  const keys = keyPath.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (typeof current[key] !== 'object' || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

// Env overrides never persist to disk — returns a NEW object with env layered on top
function applyEnvOverrides(config: OneAgentConfig): OneAgentConfig {
  const runtime = structuredClone(config);
  for (const { env, key, parse } of ENV_OVERRIDES) {
    const val = process.env[env];
    if (val !== undefined) {
      try {
        setNestedValue(runtime as unknown as Record<string, unknown>, key, parse(val));
      } catch (err) {
        throw new ConfigError(
          `Environment variable ${env}=${val}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  return runtime;
}

// ─── Module-level singleton ─────────────────────────────────────────
// Intentional for process-scoped daemon state
let cachedConfig: OneAgentConfig | null = null;

export function getDataDir(config?: OneAgentConfig): string {
  return (config ?? getConfig()).dataDir;
}

export function getTmpDir(config?: OneAgentConfig): string {
  return path.join(getDataDir(config), 'tmp');
}

export function getSkillsDir(config?: OneAgentConfig): string {
  return path.join(getDataDir(config), 'skills');
}

export function getAuditDir(config?: OneAgentConfig): string {
  return path.join(getDataDir(config), 'audit');
}

export function getBrowserDataDir(config?: OneAgentConfig): string {
  return path.join(getDataDir(config), 'browser-data');
}

export function getDbPath(config?: OneAgentConfig): string {
  return path.join(getDataDir(config), 'data', 'agent.db');
}

export function getConfigPath(config?: OneAgentConfig): string {
  return path.join(getDataDir(config), 'config.json');
}

export function ensureDirectories(config?: OneAgentConfig): void {
  const cfg = config ?? getConfig();
  const dirs = [
    cfg.dataDir,
    path.join(cfg.dataDir, 'data'),
    path.join(cfg.dataDir, 'skills'),
    path.join(cfg.dataDir, 'browser-data'),
    path.join(cfg.dataDir, 'audit'),
    path.join(cfg.dataDir, 'audit', 'roots'),
    path.join(cfg.dataDir, 'tmp'),
    path.join(cfg.dataDir, 'secrets'),
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

// loadConfig returns persisted config only (file + defaults) — no env overlay
export function loadConfig(configPath?: string): OneAgentConfig {
  const cfgPath = configPath ?? path.join(DEFAULT_DATA_DIR, 'config.json');

  if (!fs.existsSync(cfgPath)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = fs.readFileSync(cfgPath, 'utf-8');
    const parsed = JSON.parse(raw);

    // WARNING: Config loaded from file is not validated against OneAgentConfig schema.
    // The double-cast (as unknown as OneAgentConfig) means any JSON structure is accepted.
    // Critical sections are validated below (server, daemon, payloadLimits, logLevel, server.network,
    // server.httpPort) but non-critical fields may silently have wrong types.
    const loaded = deepMerge(
      DEFAULT_CONFIG as unknown as Record<string, unknown>,
      parsed as Record<string, unknown>,
    ) as unknown as OneAgentConfig;

    // Runtime validation for critical config sections
    if (typeof loaded.server !== 'object' || loaded.server === null) {
      throw new Error('Invalid config: server section must be an object');
    }
    if (typeof loaded.daemon !== 'object' || loaded.daemon === null) {
      throw new Error('Invalid config: daemon section must be an object');
    }
    if (typeof loaded.payloadLimits !== 'object' || loaded.payloadLimits === null) {
      throw new Error('Invalid config: payloadLimits section must be an object');
    }
    const pl = loaded.payloadLimits;
    if (typeof pl.maxResponseBodyBytes !== 'number' || typeof pl.maxRequestBodyBytes !== 'number') {
      throw new Error('Invalid config: payloadLimits must have numeric maxResponseBodyBytes and maxRequestBodyBytes');
    }

    // Validate logLevel is a known value — warn but don't reject to preserve forward-compatibility
    const VALID_LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);
    if (typeof loaded.logLevel !== 'string') {
      throw new Error(
        `Invalid config: logLevel must be a string. Got: ${typeof loaded.logLevel}`,
      );
    }
    if (!VALID_LOG_LEVELS.has(loaded.logLevel)) {
      const cfgLog = getLogger();
      cfgLog.warn(
        { logLevel: loaded.logLevel },
        `Config logLevel "${loaded.logLevel}" is not a recognized level (${[...VALID_LOG_LEVELS].join(', ')}). Behavior may be unexpected.`,
      );
    }

    // Validate server.network is boolean
    if (typeof loaded.server.network !== 'boolean') {
      throw new Error(
        `Invalid config: server.network must be a boolean. Got: ${typeof loaded.server.network}`,
      );
    }

    // Validate server.httpPort is a valid port number if present
    if (loaded.server.httpPort !== undefined) {
      if (typeof loaded.server.httpPort !== 'number' || !Number.isInteger(loaded.server.httpPort) || loaded.server.httpPort < 1 || loaded.server.httpPort > 65535) {
        throw new Error(
          `Invalid config: server.httpPort must be an integer between 1 and 65535. Got: ${JSON.stringify(loaded.server.httpPort)}`,
        );
      }
    }

    return loaded;
  } catch (err) {
    // Re-throw validation errors (our own checks) but swallow file read/parse errors
    if (err instanceof Error && err.message.startsWith('Invalid config:')) {
      throw err;
    }
    const cfgLog = getLogger();
    cfgLog.error(
      { err },
      'Failed to read/parse config file — using defaults. Fix your config.json or delete it to silence this warning.',
    );
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: OneAgentConfig): void {
  const cfgPath = getConfigPath(config);
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2), 'utf-8');
}

// getConfig = applyEnvOverrides(loadConfig()) — runtime only
export function getConfig(): OneAgentConfig {
  if (!cachedConfig) {
    cachedConfig = applyEnvOverrides(loadConfig());
  }
  return cachedConfig;
}

export function resetConfigCache(): void {
  cachedConfig = null;
}

const VALID_TOP_LEVEL_KEYS = new Set([
  'dataDir', 'logLevel', 'features', 'toolBudget', 'payloadLimits',
  'audit', 'storage', 'server', 'daemon', 'browser', 'tempTtlMs', 'gcIntervalMs',
  'confirmationTimeoutMs', 'confirmationExpiryMs', 'promotionConsecutivePasses',
  'promotionVolatilityThreshold', 'maxToolsPerSite', 'toolShortlistK',
]);

// setConfigValue loads from file (no env), mutates, saves — env values never leak to disk
export function setConfigValue(keyPath: string, value: unknown): OneAgentConfig {
  const topKey = keyPath.split('.')[0];
  if (!VALID_TOP_LEVEL_KEYS.has(topKey)) {
    throw new Error(`Unknown config key: ${topKey}. Valid keys: ${[...VALID_TOP_LEVEL_KEYS].join(', ')}`);
  }

  const fileConfig = loadConfig(); // raw persisted config — no env overlay
  const keys = keyPath.split('.');
  let current: Record<string, unknown> = fileConfig as unknown as Record<string, unknown>;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (typeof current[key] !== 'object' || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }

  const lastKey = keys[keys.length - 1];
  if (value === 'true') value = true;
  else if (value === 'false') value = false;
  else if (typeof value === 'string' && !isNaN(Number(value)) && NUMERIC_CONFIG_KEYS.has(keyPath)) {
    value = Number(value);
  }

  // Validate browser.engine
  if (keyPath === 'browser.engine' && typeof value === 'string') {
    if (!VALID_BROWSER_ENGINES.has(value)) {
      throw new Error(
        `Invalid value for browser.engine: "${value}". ` +
        `Must be one of: ${[...VALID_BROWSER_ENGINES].join(', ')}.`,
      );
    }
  }

  // Validate browser.features.snapshotMode
  if (keyPath === 'browser.features.snapshotMode' && typeof value === 'string') {
    if (!VALID_SNAPSHOT_MODES.has(value)) {
      throw new Error(
        `Invalid value for browser.features.snapshotMode: "${value}". ` +
        `Must be one of: ${[...VALID_SNAPSHOT_MODES].join(', ')}.`,
      );
    }
  }

  current[lastKey] = value;
  saveConfig(fileConfig);
  cachedConfig = applyEnvOverrides(fileConfig); // re-cache with env overlay
  return cachedConfig;
}

export function getDaemonSocketPath(config: OneAgentConfig): string {
  return path.join(config.dataDir, 'daemon.sock');
}

export function getDaemonPidPath(config: OneAgentConfig): string {
  return path.join(config.dataDir, 'daemon.pid');
}

export function getDaemonTokenPath(config: OneAgentConfig): string {
  return path.join(config.dataDir, 'daemon.token');
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(
        target[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>,
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
