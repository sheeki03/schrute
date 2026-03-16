import { getLogger } from '../core/logger.js';
import type { BrowserProvider } from '../skill/types.js';
import type { MultiSessionManager, NamedSession } from './multi-session.js';
import type { BrowserAuthStore } from './auth-store.js';
import type { BrowserManager } from './manager.js';

const log = getLogger();

export interface LiveChromeResult {
  browserManager: BrowserManager;
  siteId: string;
  sessionName: string;
}

export class LiveChromeBackend {
  constructor(
    private multiSession: MultiSessionManager,
    private authStore?: BrowserAuthStore,
  ) {}

  /**
   * Find a CDP session matching the siteId. Returns the BrowserManager
   * so the caller (engine) can create a provider through normal channels.
   */
  findSession(
    siteId: string,
    sessionName?: string,
  ): LiveChromeResult | undefined {
    let session: NamedSession | undefined;

    if (sessionName) {
      session = this.multiSession.get(sessionName);
      if (!session?.isCdp) return undefined;
    } else {
      const all = this.multiSession.list();
      const matches = all.filter(s => s.isCdp && s.siteId === siteId);
      if (matches.length === 0) return undefined;
      session = matches[0];
    }

    const ctx = session.browserManager.tryGetContext(siteId);
    if (!ctx) {
      log.debug({ siteId, sessionName: session.name }, 'LiveChromeBackend: no context for siteId');
      return undefined;
    }

    const pages = ctx.pages();
    if (pages.length === 0) {
      log.debug({ siteId }, 'LiveChromeBackend: context has no pages');
      return undefined;
    }

    log.info({ siteId, sessionName: session.name }, 'LiveChromeBackend matched CDP session');
    return {
      browserManager: session.browserManager,
      siteId: session.siteId,
      sessionName: session.name,
    };
  }
}
