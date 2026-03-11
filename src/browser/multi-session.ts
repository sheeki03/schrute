import { BrowserManager } from './manager.js';
import type { ContextOverrides } from './manager.js';
import type { OneAgentConfig } from '../skill/types.js';
import { getLogger } from '../core/logger.js';

const log = getLogger();

export const DEFAULT_SESSION_NAME = 'default';

export interface NamedSession {
  name: string;
  siteId: string;
  browserManager: BrowserManager;
  isCdp: boolean;
  createdAt: number;
  contextOverrides?: ContextOverrides;
}

/**
 * Manages multiple named browser sessions, each backed by its own BrowserManager.
 * The 'default' session is always launch-based and HAR-capable.
 */
export class MultiSessionManager {
  private sessions = new Map<string, NamedSession>();
  private active: string = DEFAULT_SESSION_NAME;
  private config?: OneAgentConfig;

  constructor(defaultBrowserManager: BrowserManager, config?: OneAgentConfig) {
    this.config = config;
    // Create the default session entry
    this.sessions.set(DEFAULT_SESSION_NAME, {
      name: DEFAULT_SESSION_NAME,
      siteId: '',
      browserManager: defaultBrowserManager,
      isCdp: false,
      createdAt: Date.now(),
    });
  }

  /**
   * Get or create a named session (launch-based).
   */
  getOrCreate(name: string = DEFAULT_SESSION_NAME): NamedSession {
    const existing = this.sessions.get(name);
    if (existing) return existing;

    const session: NamedSession = {
      name,
      siteId: '',
      browserManager: new BrowserManager(this.config),
      isCdp: false,
      createdAt: Date.now(),
    };
    this.sessions.set(name, session);
    log.info({ session: name }, 'Created named browser session');
    return session;
  }

  /**
   * Create a CDP-connected session.
   */
  async connectCDP(
    name: string,
    options: import('./cdp-connector.js').CdpConnectionOptions,
    siteId: string,
  ): Promise<NamedSession> {
    if (name === DEFAULT_SESSION_NAME) {
      throw new Error('Cannot use "default" for CDP sessions. The default session is reserved for launch-based browser automation.');
    }
    if (this.sessions.has(name)) {
      throw new Error(`Session "${name}" already exists. Close it first.`);
    }

    const { connectViaCDP } = await import('./cdp-connector.js');
    const browser = await connectViaCDP(options);
    const manager = new BrowserManager(this.config);
    await manager.connectExisting(browser, siteId, options);

    const session: NamedSession = {
      name,
      siteId,
      browserManager: manager,
      isCdp: true,
      createdAt: Date.now(),
    };
    this.sessions.set(name, session);
    log.info({ session: name, siteId }, 'Created CDP browser session');
    return session;
  }

  /**
   * Get a named session, or undefined if it doesn't exist.
   */
  get(name: string): NamedSession | undefined {
    return this.sessions.get(name);
  }

  /**
   * List all sessions.
   */
  list(): NamedSession[] {
    return [...this.sessions.values()];
  }

  /**
   * Close a named session.
   */
  async close(
    name: string,
    options?: { engineMode?: string; force?: boolean },
  ): Promise<void> {
    const session = this.sessions.get(name);
    if (!session) return;

    if (name === DEFAULT_SESSION_NAME) {
      // Guard: block close during exploring/recording unless forced
      if (!options?.force) {
        const mode = options?.engineMode;
        if (mode === 'exploring' || mode === 'recording') {
          throw new Error('Cannot close default session while exploring/recording. Stop recording first.');
        }
      } else {
        // Force mode: allow during exploring, but block during recording (HAR invariant protection)
        const mode = options?.engineMode;
        if (mode === 'recording') {
          throw new Error('Cannot close during recording. Stop recording first with oneagent_stop.');
        }
      }

      // Soft-close: shut down browser but keep session entry
      if (session.browserManager.isCdpConnected()) {
        await session.browserManager.detachCdp();
      } else {
        await session.browserManager.closeAll();
      }
      return;
    }

    // Non-default: full close and remove
    if (session.browserManager.isCdpConnected()) {
      await session.browserManager.detachCdp();
    } else {
      await session.browserManager.closeAll();
    }
    this.sessions.delete(name);

    // Auto-fallback to default if closing active session
    if (this.active === name) {
      this.active = DEFAULT_SESSION_NAME;
    }

    log.info({ session: name }, 'Closed named browser session');
  }

  /**
   * Close all sessions.
   */
  async closeAll(): Promise<void> {
    for (const [name] of this.sessions) {
      if (name === DEFAULT_SESSION_NAME) {
        await this.sessions.get(name)!.browserManager.closeAll();
      } else {
        await this.close(name, { force: true });
      }
    }
  }

  /**
   * Get the active session name.
   */
  getActive(): string {
    return this.active;
  }

  /**
   * Set the active session.
   */
  setActive(name: string): void {
    if (!this.sessions.has(name)) {
      throw new Error(`Session "${name}" does not exist.`);
    }
    this.active = name;
  }

  /**
   * Update the siteId for a named session.
   */
  updateSiteId(name: string, siteId: string): void {
    const session = this.sessions.get(name);
    if (session) {
      session.siteId = siteId;
    }
  }

  /**
   * Update context overrides for a named session.
   */
  updateContextOverrides(name: string, overrides?: ContextOverrides): void {
    const session = this.sessions.get(name);
    if (session) {
      session.contextOverrides = overrides;
    }
  }
}
