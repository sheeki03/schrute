import { getLogger } from '../core/logger.js';
import type { BrowserBackend, CookieEntry } from './backend.js';
import type { BrowserProvider, SchruteConfig } from '../skill/types.js';
import type { BrowserManager } from './manager.js';
import type { AuthCoordinator } from './auth-coordinator.js';
import type { BrowserAuthStore } from './auth-store.js';

const log = getLogger();

interface PlaywrightBackendOptions {
  /** If true, createProvider uses tryGetContext() only (never creates new context).
   *  Used for shared Playwright execution to fail closed if explore context is gone. */
  existingOnly?: boolean;
}

/**
 * PlaywrightBackend — thin wrapper around BrowserManager.
 * Used as dedicated execution backend (separate from explore) or
 * shared with explore for hard-site sessionStorage-dependent auth.
 */
export class PlaywrightBackend implements BrowserBackend {
  private authCoordinator?: AuthCoordinator;
  private authStore?: BrowserAuthStore;
  private registeredSites = new Set<string>();
  private onChallengeResolved?: (siteId: string) => Promise<void> | void;

  setOnChallengeResolved(cb: (siteId: string) => Promise<void> | void): void {
    this.onChallengeResolved = cb;
  }

  constructor(
    private manager: BrowserManager,
    private config: SchruteConfig,
    private options: PlaywrightBackendOptions = {},
  ) {}

  /**
   * Wire auth coordinator for participant registration.
   */
  setAuthCoordinator(coordinator: AuthCoordinator, authStore: BrowserAuthStore): void {
    this.authCoordinator = coordinator;
    this.authStore = authStore;
  }

  async createProvider(siteId: string, domains: string[]): Promise<BrowserProvider | undefined> {
    try {
      if (this.options.existingOnly) {
        // Only use existing context — don't create new ones
        const existingCtx = this.manager.tryGetContext(siteId);
        if (!existingCtx) {
          log.debug({ siteId }, 'PlaywrightBackend (existingOnly): no existing context');
          return undefined;
        }
      }

      // Import PlaywrightMcpAdapter lazily to avoid circular dependency
      const { PlaywrightMcpAdapter } = await import('./playwright-mcp-adapter.js');
      const context = await this.manager.getOrCreateContext(siteId);
      const pages = context.pages();
      const page = pages.length > 0 ? pages[0] : await context.newPage();

      // Register as auth coordinator participant (skip for shared/existingOnly — explore owns that identity)
      if (this.authCoordinator && !this.options.existingOnly && !this.registeredSites.has(siteId)) {
        const participantId = `exec-pw:${siteId}`;
        const authVersion = this.authStore?.load(siteId)?.version ?? 0;
        this.authCoordinator.register({
          id: participantId,
          siteId,
          lastSeenAuthVersion: authVersion,
          onAuthChanged: async (_sid: string, _newVersion: number) => {
            await this.discardSession(siteId);
            log.info({ siteId, participantId }, 'Auth coordinator invalidated Playwright execution context');
          },
        });
        this.registeredSites.add(siteId);
      }

      return new PlaywrightMcpAdapter(page, domains, {
        siteId,
        onChallengeResolved: this.onChallengeResolved,
      });
    } catch (err) {
      if (err instanceof TypeError || err instanceof ReferenceError) throw err;
      log.warn({ err, siteId }, 'PlaywrightBackend.createProvider failed');
      return undefined;
    }
  }

  async getCookies(siteId: string): Promise<CookieEntry[]> {
    const raw = await this.manager.exportCookies(siteId);
    return raw.map(c => ({
      ...c,
      sameSite: c.sameSite as CookieEntry['sameSite'],
    }));
  }

  async setCookies(siteId: string, cookies: CookieEntry[]): Promise<void> {
    const ctx = this.manager.tryGetContext(siteId);
    if (ctx) {
      await ctx.addCookies(cookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
      })));
    }
  }

  async importCookies(siteId: string, cookieFile: string): Promise<number> {
    return this.manager.importCookies(siteId, cookieFile);
  }

  async exportCookies(siteId: string): Promise<CookieEntry[]> {
    const raw = await this.manager.exportCookies(siteId);
    return raw.map(c => ({
      ...c,
      sameSite: c.sameSite as CookieEntry['sameSite'],
    }));
  }

  async closeAndPersist(siteId: string): Promise<void> {
    this.authCoordinator?.unregister(`exec-pw:${siteId}`);
    this.registeredSites.delete(siteId);
    await this.manager.closeContext(siteId);
  }

  async discardSession(siteId: string): Promise<void> {
    this.authCoordinator?.unregister(`exec-pw:${siteId}`);
    this.registeredSites.delete(siteId);
    this.manager.discardContext(siteId);
  }

  isUsable(): boolean {
    return true; // Playwright is always available (it's our base dependency)
  }

  async shutdown(): Promise<void> {
    for (const siteId of this.registeredSites) {
      this.authCoordinator?.unregister(`exec-pw:${siteId}`);
    }
    this.registeredSites.clear();
    await this.manager.closeAll();
  }
}
