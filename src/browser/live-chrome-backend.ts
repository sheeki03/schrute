import { getLogger } from '../core/logger.js';
import type { BrowserProvider } from '../skill/types.js';
import type { MultiSessionManager, NamedSession } from './multi-session.js';
import type { BrowserAuthStore } from './auth-store.js';

const log = getLogger();

export interface BrowserBackend {
  createProvider(siteId: string, domains: string[]): Promise<BrowserProvider | undefined>;
}

export class LiveChromeBackend implements BrowserBackend {
  constructor(
    private multiSession: MultiSessionManager,
    private authStore?: BrowserAuthStore,
  ) {}

  async createProvider(
    siteId: string,
    domains: string[],
    sessionName?: string,
  ): Promise<BrowserProvider | undefined> {
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
    if (!ctx) return undefined;

    // Return the adapter from the existing context
    const pages = ctx.pages();
    if (pages.length === 0) return undefined;

    log.info({ siteId, sessionName: session.name }, 'LiveChromeBackend providing browser context');
    // The caller will use engine.createBrowserProvider() with this manager
    return undefined; // Placeholder -- actual adapter creation requires PlaywrightMcpAdapter wiring via engine
  }
}
