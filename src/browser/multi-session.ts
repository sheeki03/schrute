import { BrowserManager } from './manager.js';
import type { ContextOverrides } from './manager.js';
import type { BrowserPool } from './pool.js';
import type { SchruteConfig } from '../skill/types.js';
import type { BrowserAuthStore } from './auth-store.js';
import type { AuthCoordinator } from './auth-coordinator.js';
import { isAdminCaller } from '../shared/admin-auth.js';
import { getLogger } from '../core/logger.js';
import { removeManagedChromeMetadata, terminateManagedChrome } from './real-browser-handoff.js';

const log = getLogger();

export const DEFAULT_SESSION_NAME = 'default';

export interface NamedSession {
  name: string;
  siteId: string;
  browserManager: BrowserManager;
  isCdp: boolean;
  createdAt: number;
  lastUsedAt: number;
  ownedBy?: string;
  contextOverrides?: ContextOverrides;
  selectedPageUrl?: string;
  cdpPriorPolicyState?: Record<string, unknown>;
  managedProfileDir?: string;
  managedPid?: number;
}

/**
 * Manages multiple named browser sessions, each backed by its own BrowserManager.
 * The 'default' session is always launch-based and HAR-capable.
 */
export class MultiSessionManager {
  private sessions = new Map<string, NamedSession>();
  private active: string = DEFAULT_SESSION_NAME;
  private config?: SchruteConfig;
  private pool?: BrowserPool;
  private onSessionChangedCallback?: (name: string) => void;
  private authStore?: BrowserAuthStore;
  private authCoordinator?: AuthCoordinator;

  constructor(defaultBrowserManager: BrowserManager, config?: SchruteConfig, pool?: BrowserPool) {
    this.config = config;
    this.pool = pool;
    // Create the default session entry
    const now = Date.now();
    this.sessions.set(DEFAULT_SESSION_NAME, {
      name: DEFAULT_SESSION_NAME,
      siteId: '',
      browserManager: defaultBrowserManager,
      isCdp: false,
      createdAt: now,
      lastUsedAt: now,
    });
  }

  /**
   * Register a callback invoked after a session is closed.
   */
  setOnSessionChanged(callback: (name: string) => void): void {
    this.onSessionChangedCallback = callback;
  }

  /**
   * Wire auth store and coordinator into this manager.
   * New sessions created via getOrCreate/connectCDP will receive auth integration.
   */
  setAuthIntegration(authStore: BrowserAuthStore, coordinator: AuthCoordinator): void {
    this.authStore = authStore;
    this.authCoordinator = coordinator;
  }

  /**
   * Get or create a named session (launch-based).
   */
  getOrCreate(name: string = DEFAULT_SESSION_NAME): NamedSession {
    const existing = this.sessions.get(name);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    const now = Date.now();
    const manager = new BrowserManager(this.config, this.pool);
    if (this.authStore && this.authCoordinator) {
      manager.setAuthIntegration(this.authStore, this.authCoordinator, name);
    }
    const session: NamedSession = {
      name,
      siteId: '',
      browserManager: manager,
      isCdp: false,
      createdAt: now,
      lastUsedAt: now,
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
    ownedBy?: string,
  ): Promise<NamedSession> {
    if (name === DEFAULT_SESSION_NAME) {
      throw new Error('Cannot use "default" for CDP sessions. The default session is reserved for launch-based browser automation.');
    }
    if (this.sessions.has(name)) {
      throw new Error(`Session "${name}" already exists. Close it first.`);
    }

    const { connectViaCDP } = await import('./cdp-connector.js');
    const browser = await connectViaCDP(options);
    const manager = new BrowserManager(this.config, this.pool);
    if (this.authStore && this.authCoordinator) {
      manager.setAuthIntegration(this.authStore, this.authCoordinator, name);
    }
    await manager.connectExisting(browser, siteId, options);

    const now = Date.now();
    const session: NamedSession = {
      name,
      siteId,
      browserManager: manager,
      isCdp: true,
      createdAt: now,
      lastUsedAt: now,
      ownedBy,
    };
    this.sessions.set(name, session);
    log.info({ session: name, siteId }, 'Created CDP browser session');
    return session;
  }

  /**
   * Get a named session, or undefined if it doesn't exist.
   */
  get(name: string): NamedSession | undefined {
    const session = this.sessions.get(name);
    if (session) session.lastUsedAt = Date.now();
    return session;
  }

  /**
   * List sessions, optionally filtered by caller ownership.
   * In multi-user mode, non-admin callers see only their own named sessions
   * (default session is hidden as it contains the admin's browsing context).
   */
  list(callerId?: string, config?: SchruteConfig): NamedSession[] {
    const all = [...this.sessions.values()];
    if (!callerId) return all;  // admin/legacy — see everything
    const effectiveConfig = config ?? this.config;
    if (!effectiveConfig || isAdminCaller(callerId, effectiveConfig)) return all;  // admin — see everything
    // Non-admin in multi-user mode: hide default + other callers' sessions
    return all.filter(s =>
      s.name !== DEFAULT_SESSION_NAME && (!s.ownedBy || s.ownedBy === callerId)
    );
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
          throw new Error('Cannot close during recording. Stop recording first with schrute_stop.');
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

    // Restore CDP policy overlay before closing
    if (session.cdpPriorPolicyState && session.siteId) {
      try {
        const { mergeSitePolicy } = await import('../core/policy.js');
        const result = mergeSitePolicy(session.siteId, session.cdpPriorPolicyState as any, this.config);
        if (result.persisted) {
          log.info({ siteId: session.siteId }, 'Restored pre-CDP policy state on session close');
        } else {
          log.warn({ siteId: session.siteId }, 'Pre-CDP policy restored in-memory but failed to persist to database');
        }
      } catch (err) {
        log.warn({ err, siteId: session.siteId }, 'Failed to restore pre-CDP policy state');
      }
    }

    // Non-default: full close and remove
    if (session.browserManager.isCdpConnected()) {
      await session.browserManager.detachCdp();
    } else {
      await session.browserManager.closeAll();
    }
    if (session.managedPid) {
      await terminateManagedChrome(session.managedPid);
    }
    if (session.managedProfileDir) {
      removeManagedChromeMetadata(session.managedProfileDir);
    }
    this.sessions.delete(name);

    // Auto-fallback to default if closing active session
    if (this.active === name) {
      this.active = DEFAULT_SESSION_NAME;
    }

    log.info({ session: name }, 'Closed named browser session');
    this.onSessionChangedCallback?.(name);
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
   * In multi-user mode (server.network=true), only 'default' is allowed
   * as the global active session to prevent cross-caller interference.
   */
  setActive(name: string, config?: SchruteConfig): void {
    const effectiveConfig = config ?? this.config;
    if (effectiveConfig?.server?.network && name !== DEFAULT_SESSION_NAME) {
      throw new Error(
        `Cannot switch global active session in multi-user mode. ` +
        `Use the 'session' parameter on browser tools to target '${name}' explicitly.`
      );
    }
    if (!this.sessions.has(name)) {
      throw new Error(`Session "${name}" does not exist.`);
    }
    this.active = name;
  }

  /**
   * Assert that a caller owns a session (or the session is shared/default).
   * Throws if the caller doesn't own the session.
   */
  assertOwnership(name: string, callerId: string | undefined): void {
    const session = this.sessions.get(name);
    if (!session) return;
    if (name === DEFAULT_SESSION_NAME) return;  // default is shared
    if (!session.ownedBy) return;               // legacy, no owner
    if (!callerId) return;                      // stdio/cli, no restriction
    if (session.ownedBy !== callerId) {
      throw new Error(`Session '${name}' belongs to a different client.`);
    }
  }

  /**
   * Sweep idle sessions that have not been used within maxIdleMs.
   * Uses close() which calls browserManager.closeAll()/detachCdp() to properly
   * clean up browser contexts (not just map entries).
   */
  private cdpIdleTimeoutMs = 20 * 60 * 1000; // 20 minutes

  sweepIdleSessions(maxIdleMs: number = 3600_000): number {
    const now = Date.now();
    // Collect names first to avoid mutating the Map during iteration
    // (close() calls this.sessions.delete())
    const toSweep: string[] = [];
    for (const [name, session] of this.sessions) {
      if (name === DEFAULT_SESSION_NAME) continue;
      const effectiveIdleMs = session.isCdp ? this.cdpIdleTimeoutMs : maxIdleMs;
      if (now - session.lastUsedAt > effectiveIdleMs) {
        toSweep.push(name);
      }
    }
    for (const name of toSweep) {
      // close() calls browserManager.closeAll()/detachCdp() — required for proper cleanup
      this.close(name, { force: true }).catch(err =>
        log.warn({ err, session: name }, 'Session sweep close failed'),
      );
    }
    return toSweep.length;
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
