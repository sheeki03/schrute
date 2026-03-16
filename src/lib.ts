// Core
export { Engine } from './core/engine.js';
export type { EngineStatus, ExploreResult } from './core/engine.js';

// Browser
export { BrowserManager } from './browser/manager.js';
export { MultiSessionManager } from './browser/multi-session.js';
export type { ContextOverrides } from './browser/manager.js';

// Storage
export { SkillRepository } from './storage/skill-repository.js';
export { SiteRepository } from './storage/site-repository.js';
export { getDatabase, closeDatabase } from './storage/database.js';

// Config
export { getConfig, loadConfig, ensureDirectories } from './core/config.js';

// Types
export type {
  SchruteConfig, SkillSpec, SiteManifest, SitePolicy,
  ProxyConfig, GeoEmulationConfig,
} from './skill/types.js';
export { SkillStatus, ExecutionTier, Capability } from './skill/types.js';

// Server factories (for embedding)
export { startMcpServer } from './server/mcp-stdio.js';

// Version
export { VERSION } from './version.js';
