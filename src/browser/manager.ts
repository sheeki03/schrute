import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Browser, BrowserContext } from 'playwright';
import { getConfig, getBrowserDataDir, getTmpDir } from '../core/config.js';
import type { OneAgentConfig } from '../skill/types.js';
import { launchBrowserEngine, type EngineCapabilities } from './engine.js';
import type { BrowserEngine } from '../skill/types.js';
import { getLogger } from '../core/logger.js';

const log = getLogger();

interface ManagedContext {
  context: BrowserContext;
  siteId: string;
  harPath: string;
  createdAt: number;
}

/**
 * Manages Playwright browser lifecycle and per-site persistent contexts.
 *
 * Each site gets its own BrowserContext with:
 * - Persistent storage at ~/.oneagent/browser-data/{siteId}/
 * - Full HAR recording (headers, cookies, response metadata)
 * - Isolated cookie/storage state
 */
export class BrowserManager {
  private browser: Browser | null = null;
  private contexts = new Map<string, ManagedContext>();
  private lastHarPaths = new Map<string, string>();
  private config?: OneAgentConfig;
  private capabilities: EngineCapabilities | null = null;
  private engine: BrowserEngine;

  constructor(config?: OneAgentConfig) {
    this.config = config;
    this.engine = config?.browser?.engine ?? 'patchright';
  }

  private getResolvedConfig(): OneAgentConfig {
    return this.config ?? getConfig();
  }

  /**
   * Launch the shared browser instance.
   * Idempotent — returns immediately if already launched.
   */
  async launchBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) {
      return this.browser;
    }

    log.info({ engine: this.engine }, 'Launching browser');
    const result = await launchBrowserEngine(this.engine, { headless: true });
    this.browser = result.browser;
    this.capabilities = result.capabilities;
    if (result.capabilities.configuredEngine !== result.capabilities.effectiveEngine) {
      log.warn(
        { configured: result.capabilities.configuredEngine, effective: result.capabilities.effectiveEngine },
        'Browser engine fallback active — running without stealth',
      );
    }

    this.browser.on('disconnected', () => {
      log.warn('Browser disconnected');
      this.browser = null;
      this.contexts.clear();
    });

    return this.browser;
  }

  /**
   * Get an existing context for a site, or create one with HAR recording.
   *
   * @param siteId - Unique site identifier (e.g. "github.com")
   * @returns The BrowserContext for this site
   */
  async getOrCreateContext(siteId: string): Promise<BrowserContext> {
    const existing = this.contexts.get(siteId);
    if (existing) {
      return existing.context;
    }

    const browser = await this.launchBrowser();
    const config = this.getResolvedConfig();

    // Persistent storage directory for this site
    const storageDir = path.join(getBrowserDataDir(config), siteId);
    fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });

    // HAR output path in tmp directory
    const tmpDir = getTmpDir(config);
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const harPath = path.join(tmpDir, `${siteId}-${Date.now()}.har`);

    // Load existing storage state if available
    const storageStatePath = path.join(storageDir, 'storage-state.json');
    let storageState: string | undefined;
    if (fs.existsSync(storageStatePath)) {
      storageState = storageStatePath;
    }

    const context = await browser.newContext({
      recordHar: {
        path: harPath,
        mode: 'full',
      },
      storageState,
    });

    this.contexts.set(siteId, {
      context,
      siteId,
      harPath,
      createdAt: Date.now(),
    });

    log.info({ siteId, harPath }, 'Created browser context with HAR recording');
    return context;
  }

  /**
   * Close the context for a specific site.
   * Saves storage state before closing so cookies/localStorage persist.
   *
   * @param siteId - Site whose context to close
   */
  async closeContext(siteId: string): Promise<void> {
    const managed = this.contexts.get(siteId);
    if (!managed) {
      return;
    }

    const config = this.getResolvedConfig();
    const storageDir = path.join(getBrowserDataDir(config), siteId);
    const storageStatePath = path.join(storageDir, 'storage-state.json');

    try {
      // Persist storage state before closing
      const state = await managed.context.storageState();
      fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(storageStatePath, JSON.stringify(state), {
        mode: 0o600,
      });
      log.info({ siteId }, 'Saved storage state');
    } catch (err) {
      log.warn({ siteId, err }, 'Failed to save storage state');
    }

    try {
      await managed.context.close();
    } catch (err) {
      log.warn({ err, siteId }, 'Error closing browser context');
    }

    // Preserve HAR path so it survives context close (needed by capture pipeline)
    this.lastHarPaths.set(siteId, managed.harPath);
    this.contexts.delete(siteId);
    log.info({ siteId }, 'Closed browser context');
  }

  /**
   * Close all contexts and the browser.
   */
  async closeAll(): Promise<void> {
    const siteIds = [...this.contexts.keys()];
    for (const siteId of siteIds) {
      await this.closeContext(siteId);
    }

    if (this.browser) {
      try {
        await this.browser.close();
      } catch (err) {
        log.warn({ err }, 'Error closing browser instance');
      }
      this.browser = null;
    }

    log.info('Closed all browser contexts and browser');
  }

  /**
   * Get the HAR path for a site's context.
   */
  getHarPath(siteId: string): string | undefined {
    return this.contexts.get(siteId)?.harPath ?? this.lastHarPaths.get(siteId);
  }

  /**
   * Check if a context exists for a site.
   */
  hasContext(siteId: string): boolean {
    return this.contexts.has(siteId);
  }

  /**
   * Get the underlying browser instance (if launched).
   */
  getBrowser(): Browser | null {
    return this.browser;
  }

  /**
   * Get the engine capabilities (available after launch).
   */
  getCapabilities(): EngineCapabilities | null {
    return this.capabilities;
  }
}
