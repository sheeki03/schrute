import * as fs from 'node:fs';
import * as path from 'node:path';
import { getLogger } from './logger.js';
import { writeFileAtomically } from '../shared/atomic-write.js';
import type { SchruteConfig } from '../skill/types.js';
import { Capability } from '../skill/types.js';
import { VALID_SNAPSHOT_MODES } from '../browser/feature-flags.js';

// Re-export for convenience
export type { SchruteConfig } from '../skill/types.js';

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
  '.schrute',
);

const DEFAULT_CONFIG: SchruteConfig = {
  dataDir: DEFAULT_DATA_DIR,
  logLevel: 'info',
  features: {
    webmcp: true,
    httpTransport: false,
    discoveryImport: false,
    respectRobotsTxt: true,
    sitemapDiscovery: true,
    adaptivePathTrie: true,
  },
  capabilities: { enabled: [] },
  toolBudget: {
    maxToolCallsPerTask: 50,
    maxConcurrentCalls: 3,
    crossDomainCalls: false,
    secretsToNonAllowlisted: false,
  },
  paramLimits: {
    maxStringLength: 10_000,
    maxDepth: 5,
    maxProperties: 50,
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
  slimMode: false,
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
  'browser.idleTimeoutMs',
  'browser.handlerTimeoutMs',
  'browser.geo.geolocation.latitude',
  'browser.geo.geolocation.longitude',
  'browser.geo.geolocation.accuracy',
  'browser.features.screenshotQuality',
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

function parseNonNegativeMs(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Invalid value: '${v}'. Must be a non-negative integer (milliseconds).`);
  }
  return n;
}

function parseScreenshotFormat(v: string): string {
  if (v !== 'jpeg' && v !== 'png') {
    throw new Error(`Invalid value: "${v}". Must be 'jpeg' or 'png'.`);
  }
  return v;
}

function parseScreenshotQuality(v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1 || n > 100) {
    throw new Error(`Invalid value: "${v}". Must be a number between 1 and 100.`);
  }
  return n;
}

function makeFloatParser(label: string, min?: number, max?: number): (v: string) => number {
  return (v: string): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) {
      throw new Error(`Invalid config: ${label} must be a finite number. Got: '${v}'.`);
    }
    if (min !== undefined && n < min) {
      throw new Error(`Invalid config: ${label} must be >= ${min}. Got: ${n}.`);
    }
    if (max !== undefined && n > max) {
      throw new Error(`Invalid config: ${label} must be <= ${max}. Got: ${n}.`);
    }
    return n;
  };
}

function makeProxyServerParser(): (v: string) => string {
  return (v: string): string => {
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      throw new Error(`Invalid config: proxy server must be a valid URL. Got: '${v}'.`);
    }
    const allowed = new Set(['http:', 'https:', 'socks4:', 'socks5:']);
    if (!allowed.has(u.protocol)) {
      throw new Error(
        `Invalid config: proxy server protocol must be one of http, https, socks4, socks5. Got: '${u.protocol.replace(':', '')}'.`,
      );
    }
    if (u.pathname !== '/' && u.pathname !== '') {
      throw new Error(`Invalid config: proxy server must not contain a path. Got: '${u.pathname}'.`);
    }
    if (u.search) {
      throw new Error(`Invalid config: proxy server must not contain a query string.`);
    }
    if (u.hash) {
      throw new Error(`Invalid config: proxy server must not contain a hash.`);
    }
    if (u.username || u.password) {
      throw new Error(`Invalid config: proxy server URL must not contain credentials. Use separate username/password fields.`);
    }
    return v;
  };
}

function makeTimezoneParser(): (v: string) => string {
  return (v: string): string => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: v });
    } catch {
      throw new Error(`Invalid config: '${v}' is not a valid IANA timezone.`);
    }
    return v;
  };
}

function makeLocaleParser(): (v: string) => string {
  return (v: string): string => {
    try {
      Intl.getCanonicalLocales(v);
    } catch {
      throw new Error(`Invalid config: '${v}' is not a valid locale.`);
    }
    return v;
  };
}

const ENV_OVERRIDES: Array<{
  env: string;
  key: string;
  parse: (v: string) => unknown;
}> = [
  { env: 'SCHRUTE_DATA_DIR',       key: 'dataDir',                parse: String },
  { env: 'SCHRUTE_LOG_LEVEL',      key: 'logLevel',               parse: String },
  { env: 'SCHRUTE_AUTH_TOKEN',     key: 'server.authToken',       parse: String },
  { env: 'SCHRUTE_NETWORK',        key: 'server.network',         parse: parseStrictBool },
  { env: 'SCHRUTE_HTTP_TRANSPORT', key: 'features.httpTransport', parse: parseStrictBool },
  { env: 'SCHRUTE_SITEMAP_DISCOVERY', key: 'features.sitemapDiscovery', parse: parseStrictBool },
  { env: 'SCHRUTE_ADAPTIVE_PATH_TRIE', key: 'features.adaptivePathTrie', parse: parseStrictBool },
  { env: 'SCHRUTE_HTTP_PORT',      key: 'server.httpPort',        parse: parseStrictInt },
  { env: 'SCHRUTE_BROWSER_ENGINE', key: 'browser.engine',                parse: parseBrowserEngine },
  { env: 'SCHRUTE_SNAPSHOT_MODE',  key: 'browser.features.snapshotMode', parse: parseSnapshotMode },
  { env: 'SCHRUTE_INCREMENTAL_DIFFS', key: 'browser.features.incrementalDiffs', parse: parseStrictBool },
  { env: 'SCHRUTE_MODAL_TRACKING', key: 'browser.features.modalTracking', parse: parseStrictBool },
  { env: 'SCHRUTE_SCREENSHOT_RESIZE', key: 'browser.features.screenshotResize', parse: parseStrictBool },
  { env: 'SCHRUTE_SCREENSHOT_FORMAT', key: 'browser.features.screenshotFormat', parse: parseScreenshotFormat },
  { env: 'SCHRUTE_SCREENSHOT_QUALITY', key: 'browser.features.screenshotQuality', parse: parseScreenshotQuality },
  { env: 'SCHRUTE_BATCH_ACTIONS',  key: 'browser.features.batchActions', parse: parseStrictBool },
  { env: 'SCHRUTE_IDLE_TIMEOUT_MS', key: 'browser.idleTimeoutMs', parse: parseNonNegativeMs },
  { env: 'SCHRUTE_HANDLER_TIMEOUT_MS', key: 'browser.handlerTimeoutMs', parse: parseNonNegativeMs },
  { env: 'SCHRUTE_PROXY_SERVER',   key: 'browser.proxy.server',    parse: makeProxyServerParser() },
  { env: 'SCHRUTE_PROXY_BYPASS',   key: 'browser.proxy.bypass',    parse: String },
  { env: 'SCHRUTE_PROXY_USERNAME', key: 'browser.proxy.username',  parse: String },
  { env: 'SCHRUTE_PROXY_PASSWORD', key: 'browser.proxy.password',  parse: String },
  { env: 'SCHRUTE_GEO_LATITUDE',  key: 'browser.geo.geolocation.latitude',  parse: makeFloatParser('latitude', -90, 90) },
  { env: 'SCHRUTE_GEO_LONGITUDE', key: 'browser.geo.geolocation.longitude', parse: makeFloatParser('longitude', -180, 180) },
  { env: 'SCHRUTE_TIMEZONE',      key: 'browser.geo.timezoneId',   parse: makeTimezoneParser() },
  { env: 'SCHRUTE_LOCALE',        key: 'browser.geo.locale',       parse: makeLocaleParser() },
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
function applyEnvOverrides(config: SchruteConfig): SchruteConfig {
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
let cachedConfig: SchruteConfig | null = null;

export function getDataDir(config?: SchruteConfig): string {
  return (config ?? getConfig()).dataDir;
}

export function getTmpDir(config?: SchruteConfig): string {
  return path.join(getDataDir(config), 'tmp');
}

export function getSkillsDir(config?: SchruteConfig): string {
  return path.join(getDataDir(config), 'skills');
}

export function getAuditDir(config?: SchruteConfig): string {
  return path.join(getDataDir(config), 'audit');
}

export function getBrowserDataDir(config?: SchruteConfig): string {
  return path.join(getDataDir(config), 'browser-data');
}

export function getDbPath(config?: SchruteConfig): string {
  return path.join(getDataDir(config), 'data', 'agent.db');
}

export function getConfigPath(config?: SchruteConfig): string {
  return path.join(getDataDir(config), 'config.json');
}

export function ensureDirectories(config?: SchruteConfig): void {
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
export function loadConfig(configPath?: string): SchruteConfig {
  const cfgPath = configPath ?? path.join(DEFAULT_DATA_DIR, 'config.json');

  if (!fs.existsSync(cfgPath)) {
    return structuredClone(DEFAULT_CONFIG);
  }

  try {
    const raw = fs.readFileSync(cfgPath, 'utf-8');
    const parsed = JSON.parse(raw);

    // WARNING: Config loaded from file is not validated against SchruteConfig schema.
    // The double-cast (as unknown as SchruteConfig) means any JSON structure is accepted.
    // Critical sections are validated below (server, daemon, payloadLimits, logLevel, server.network,
    // server.httpPort) but non-critical fields may silently have wrong types.
    const loaded = deepMerge(
      DEFAULT_CONFIG as unknown as Record<string, unknown>,
      parsed as Record<string, unknown>,
    ) as unknown as SchruteConfig;

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
        `Config logLevel "${loaded.logLevel}" is not a recognized level. Falling back to "info".`,
      );
      loaded.logLevel = 'info';
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

    // Validate browser timing config from file
    const browserIdleMs = loaded.browser?.idleTimeoutMs;
    if (browserIdleMs !== undefined && (typeof browserIdleMs !== 'number' || !Number.isInteger(browserIdleMs) || browserIdleMs < 0)) {
      throw new Error('Invalid config: browser.idleTimeoutMs must be a non-negative integer');
    }
    const browserHandlerMs = loaded.browser?.handlerTimeoutMs;
    if (browserHandlerMs !== undefined && (typeof browserHandlerMs !== 'number' || !Number.isInteger(browserHandlerMs) || browserHandlerMs < 0)) {
      throw new Error('Invalid config: browser.handlerTimeoutMs must be a non-negative integer');
    }

    // Validate browser.proxy.server format if present
    const proxyServer = loaded.browser?.proxy?.server;
    if (proxyServer !== undefined) {
      try {
        makeProxyServerParser()(proxyServer);
      } catch {
        throw new Error(`Invalid config: browser.proxy.server is not a valid proxy URL: '${proxyServer}'`);
      }
    }

    // Validate geolocation ranges if present
    const geo = loaded.browser?.geo;
    if (geo?.geolocation) {
      const { latitude, longitude } = geo.geolocation;
      if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
        throw new Error(`Invalid config: browser.geo.geolocation.latitude must be between -90 and 90. Got: ${latitude}`);
      }
      if (typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        throw new Error(`Invalid config: browser.geo.geolocation.longitude must be between -180 and 180. Got: ${longitude}`);
      }
    }

    // Validate timezone if present
    if (geo?.timezoneId !== undefined) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: geo.timezoneId });
      } catch {
        throw new Error(`Invalid config: browser.geo.timezoneId '${geo.timezoneId}' is not a valid IANA timezone`);
      }
    }

    // Validate locale if present
    if (geo?.locale !== undefined) {
      try {
        Intl.getCanonicalLocales(geo.locale);
      } catch {
        throw new Error(`Invalid config: browser.geo.locale '${geo.locale}' is not a valid locale`);
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
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveConfig(config: SchruteConfig): void {
  const cfgPath = getConfigPath(config);
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  writeFileAtomically(cfgPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}

// getConfig = applyEnvOverrides(loadConfig()) — runtime only
export function getConfig(): SchruteConfig {
  if (!cachedConfig) {
    cachedConfig = applyEnvOverrides(loadConfig());
  }
  return structuredClone(cachedConfig);
}

export function resetConfigCache(): void {
  cachedConfig = null;
}

const VALID_TOP_LEVEL_KEYS = new Set([
  'dataDir', 'logLevel', 'features', 'capabilities', 'toolBudget', 'payloadLimits',
  'audit', 'storage', 'server', 'daemon', 'browser', 'tempTtlMs', 'gcIntervalMs',
  'confirmationTimeoutMs', 'confirmationExpiryMs', 'promotionConsecutivePasses',
  'promotionVolatilityThreshold', 'maxToolsPerSite', 'toolShortlistK',
  'browserPool', 'managedCrawl', 'slimMode',
]);

/**
 * Validate a config value for a given keyPath.
 * Throws on invalid values. Coercion (string→boolean/number) stays inline in callers.
 */
function validateConfigValue(keyPath: string, value: unknown): void {
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

  // Validate browser.features.screenshotFormat
  if (keyPath === 'browser.features.screenshotFormat') {
    if (value !== 'jpeg' && value !== 'png') {
      throw new Error(
        `Invalid value for browser.features.screenshotFormat: "${value}". Must be 'jpeg' or 'png'.`,
      );
    }
  }

  // Validate browser.features.screenshotQuality
  if (keyPath === 'browser.features.screenshotQuality') {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num) || num < 1 || num > 100) {
      throw new Error(
        `Invalid value for browser.features.screenshotQuality: must be a number between 1 and 100. Got: ${value}.`,
      );
    }
  }

  // Validate browser timing config
  if (keyPath === 'browser.idleTimeoutMs' || keyPath === 'browser.handlerTimeoutMs') {
    if (typeof value === 'number' && (value < 0 || !Number.isInteger(value))) {
      throw new Error(`Invalid value for ${keyPath}: must be a non-negative integer (milliseconds).`);
    }
  }

  // Validate proxy server URL
  if (keyPath === 'browser.proxy.server' && typeof value === 'string') {
    try {
      makeProxyServerParser()(value);
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  }

  // Validate geolocation latitude
  if (keyPath === 'browser.geo.geolocation.latitude' && typeof value === 'number') {
    if (!Number.isFinite(value) || value < -90 || value > 90) {
      throw new Error(`Invalid config: latitude must be between -90 and 90. Got: ${value}.`);
    }
  }

  // Validate geolocation longitude
  if (keyPath === 'browser.geo.geolocation.longitude' && typeof value === 'number') {
    if (!Number.isFinite(value) || value < -180 || value > 180) {
      throw new Error(`Invalid config: longitude must be between -180 and 180. Got: ${value}.`);
    }
  }

  // Validate timezone
  if (keyPath === 'browser.geo.timezoneId' && typeof value === 'string') {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
    } catch {
      throw new Error(`Invalid config: '${value}' is not a valid IANA timezone.`);
    }
  }

  // Validate locale
  if (keyPath === 'browser.geo.locale' && typeof value === 'string') {
    try {
      Intl.getCanonicalLocales(value);
    } catch {
      throw new Error(`Invalid config: '${value}' is not a valid locale.`);
    }
  }

  // Validate capabilities.enabled
  if (keyPath === 'capabilities.enabled') {
    if (!Array.isArray(value)) throw new Error('capabilities.enabled must be an array');
    const validCapabilities = Object.values(Capability);
    for (const cap of value as string[]) {
      if (!(validCapabilities as string[]).includes(cap)) {
        throw new Error(`Invalid capability '${cap}'. Valid: ${validCapabilities.join(', ')}`);
      }
    }
  }
}

/**
 * Shared mutation logic: validate top-level key, traverse key path, coerce value,
 * validate, and assign. Returns the coerced value for callers that need it.
 */
function applyConfigMutation(
  target: Record<string, unknown>,
  keyPath: string,
  value: unknown,
): void {
  const topKey = keyPath.split('.')[0];
  if (!VALID_TOP_LEVEL_KEYS.has(topKey)) {
    throw new Error(`Unknown config key: ${topKey}. Valid keys: ${[...VALID_TOP_LEVEL_KEYS].join(', ')}`);
  }

  const keys = keyPath.split('.');
  let current = target;

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

  validateConfigValue(keyPath, value);

  current[lastKey] = value;
}

// setConfigValue loads from file (no env), mutates, saves — env values never leak to disk
export function setConfigValue(keyPath: string, value: unknown): SchruteConfig {
  const fileConfig = loadConfig(); // raw persisted config — no env overlay
  applyConfigMutation(fileConfig as unknown as Record<string, unknown>, keyPath, value);
  saveConfig(fileConfig);
  cachedConfig = applyEnvOverrides(fileConfig); // re-cache with env overlay
  return cachedConfig;
}

export function setConfigValueInMemory(keyPath: string, value: unknown): SchruteConfig {
  const currentConfig = getConfig();
  const modified = structuredClone(currentConfig);
  applyConfigMutation(modified as unknown as Record<string, unknown>, keyPath, value);
  cachedConfig = applyEnvOverrides(modified);
  return cachedConfig;
}

function normalizeDataDir(dataDir: string): string {
  try {
    return fs.realpathSync(dataDir);
  } catch {
    return path.resolve(dataDir);
  }
}

export function getDaemonSocketPath(config: SchruteConfig): string {
  return path.join(normalizeDataDir(config.dataDir), 'daemon.sock');
}

export function getDaemonPidPath(config: SchruteConfig): string {
  return path.join(normalizeDataDir(config.dataDir), 'daemon.pid');
}

export function getDaemonTokenPath(config: SchruteConfig): string {
  return path.join(normalizeDataDir(config.dataDir), 'daemon.token');
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
