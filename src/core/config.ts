import * as fs from 'node:fs';
import * as path from 'node:path';
import type { OneAgentConfig } from '../skill/types.js';

const DEFAULT_DATA_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '~',
  '.oneagent',
);

const DEFAULT_CONFIG: OneAgentConfig = {
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

export function loadConfig(configPath?: string): OneAgentConfig {
  const cfgPath = configPath ?? path.join(DEFAULT_DATA_DIR, 'config.json');

  if (!fs.existsSync(cfgPath)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = fs.readFileSync(cfgPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return deepMerge(
      DEFAULT_CONFIG as unknown as Record<string, unknown>,
      parsed as Record<string, unknown>,
    ) as unknown as OneAgentConfig;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: OneAgentConfig): void {
  const cfgPath = getConfigPath(config);
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2), 'utf-8');
}

export function getConfig(): OneAgentConfig {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}

export function resetConfigCache(): void {
  cachedConfig = null;
}

export function setConfigValue(keyPath: string, value: unknown): OneAgentConfig {
  const config = getConfig();
  const keys = keyPath.split('.');
  let current: Record<string, unknown> = config as unknown as Record<string, unknown>;

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
  else if (typeof value === 'string' && !isNaN(Number(value))) value = Number(value);

  current[lastKey] = value;
  saveConfig(config);
  cachedConfig = config;
  return config;
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
