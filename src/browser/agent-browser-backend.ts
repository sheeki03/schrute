import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import { getLogger } from '../core/logger.js';
import type { BrowserBackend, CookieEntry } from './backend.js';
import type { BrowserProvider, SchruteConfig } from '../skill/types.js';
import type { BrowserAuthStore } from './auth-store.js';
import type { AuthCoordinator } from './auth-coordinator.js';
import type { AgentBrowserProvider } from './agent-browser-provider.js';
import { AgentBrowserIpcClient, resolveSocketDir } from './agent-browser-ipc.js';

const log = getLogger();

const PROBE_COOLDOWN_MS = 60_000;

/**
 * AgentBrowserBackend — wraps agent-browser daemon via IPC sockets.
 * Uses once-promise probe to detect availability.
 */
export class AgentBrowserBackend implements BrowserBackend {
  private sessions = new Map<string, { provider: AgentBrowserProvider; ipc: AgentBrowserIpcClient }>();
  private daemonAvailable: boolean | null = null;
  private probePromise: Promise<boolean> | null = null;
  private lastFailTime = 0;
  private authCoordinator?: AuthCoordinator;

  constructor(
    private config: SchruteConfig,
    private authStore?: BrowserAuthStore,
  ) {}

  /**
   * Wire auth coordinator for participant registration.
   */
  setAuthCoordinator(coordinator: AuthCoordinator): void {
    this.authCoordinator = coordinator;
  }

  async createProvider(siteId: string, domains: string[]): Promise<BrowserProvider | undefined> {
    // Check daemon availability via once-promise probe
    const available = await this.ensureProbed();
    if (!available) {
      log.debug('agent-browser daemon not available');
      return undefined;
    }

    // localStorage routing: if site has non-empty localStorage, fall to Playwright
    if (this.authStore) {
      const authState = this.authStore.load(siteId);
      if (authState) {
        const hasLocalStorage = authState.origins.some(o => o.localStorage.length > 0);
        if (hasLocalStorage) {
          log.debug({ siteId }, 'Site has localStorage data — falling back to Playwright');
          return undefined;
        }
      }
    }

    const existingEntry = this.sessions.get(siteId);
    if (existingEntry) {
      // Stale-auth safety net: check if our cached session has outdated auth
      if (this.authCoordinator && this.authStore) {
        const participantId = `exec-ab:${siteId}`;
        const participant = this.authCoordinator.getParticipant(participantId);
        const currentStoreVersion = this.authStore.load(siteId)?.version ?? 0;
        if (participant && participant.lastSeenAuthVersion < currentStoreVersion) {
          // Stale — discard and recreate below with fresh auth
          log.info({ siteId, stale: participant.lastSeenAuthVersion, current: currentStoreVersion },
            'Auth version stale — discarding agent-browser session for fresh hydration');
          await this.discardSession(siteId);
          // Fall through to create a new session below
        } else {
          return existingEntry.provider;
        }
      } else {
        return existingEntry.provider;
      }
    }

    try {
      const { AgentBrowserProvider: ABProvider } = await import('./agent-browser-provider.js');
      const sessionName = `exec-${siteId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

      const ipc = new AgentBrowserIpcClient();
      await ipc.bootstrapDaemon(sessionName);
      await ipc.connect(sessionName);

      const provider = new ABProvider(ipc, domains);

      // Hydrate with auth state if available (cookies only for agent-browser)
      if (this.authStore) {
        const authState = this.authStore.load(siteId);
        if (authState && authState.cookies.length > 0) {
          await provider.hydrateCookies(authState.cookies);
        }
      }

      this.sessions.set(siteId, { provider, ipc });

      // Register as auth coordinator participant
      if (this.authCoordinator) {
        const participantId = `exec-ab:${siteId}`;
        const authVersion = this.authStore?.load(siteId)?.version ?? 0;
        this.authCoordinator.register({
          id: participantId,
          siteId,
          lastSeenAuthVersion: authVersion,
          onAuthChanged: async (_sid: string, _newVersion: number) => {
            // Peer has newer auth — discard session without persisting stale state
            await this.discardSession(siteId);
            log.info({ siteId, participantId }, 'Auth coordinator invalidated agent-browser session');
          },
        });
      }

      return provider;
    } catch (err) {
      log.warn({ err, siteId }, 'AgentBrowserBackend.createProvider failed');
      return undefined;
    }
  }

  async getCookies(siteId: string): Promise<CookieEntry[]> {
    const entry = this.sessions.get(siteId);
    if (!entry) return [];
    return entry.provider.getCookies();
  }

  async setCookies(siteId: string, cookies: CookieEntry[]): Promise<void> {
    const entry = this.sessions.get(siteId);
    if (entry) {
      await entry.provider.hydrateCookies(cookies);
    }
  }

  async importCookies(siteId: string, cookieFile: string): Promise<number> {
    // Parse Netscape cookie file and set cookies
    const content = fs.readFileSync(cookieFile, 'utf-8');
    const cookies: CookieEntry[] = [];
    for (const line of content.split('\n')) {
      if (line.startsWith('#') || !line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length >= 7) {
        cookies.push({
          domain: parts[0],
          path: parts[2],
          secure: parts[3] === 'TRUE',
          expires: parseInt(parts[4]) || undefined,
          name: parts[5],
          value: parts[6],
        });
      }
    }
    await this.setCookies(siteId, cookies);
    return cookies.length;
  }

  async exportCookies(siteId: string): Promise<CookieEntry[]> {
    return this.getCookies(siteId);
  }

  async closeAndPersist(siteId: string): Promise<void> {
    const entry = this.sessions.get(siteId);
    if (!entry) return;

    try {
      // Cookies-only persist with MERGE
      const cookies = await entry.provider.getCookies();
      if (this.authStore) {
        // Always persist — even empty cookies clear stale auth after logout/expiry
        const existing = this.authStore.load(siteId);
        const { changed, version } = this.authStore.save(siteId, {
          cookies,
          origins: existing?.origins ?? [],
          lastUpdated: Date.now(),
        });
        // Publish auth change to peers (not self)
        if (changed && this.authCoordinator) {
          const participantId = `exec-ab:${siteId}`;
          const participant = this.authCoordinator.getParticipant(participantId);
          if (participant) participant.lastSeenAuthVersion = version;
          await this.authCoordinator.publish({
            siteId, version, originId: participantId, reason: 'exec_close',
          });
        }
      }
    } catch (err) {
      log.warn({ err, siteId }, 'Failed to extract auth before closing agent-browser session');
    }

    // Unregister from coordinator before closing
    this.authCoordinator?.unregister(`exec-ab:${siteId}`);
    await entry.provider.close();
    entry.ipc.close();
    this.sessions.delete(siteId);
  }

  async discardSession(siteId: string): Promise<void> {
    const entry = this.sessions.get(siteId);
    if (entry) {
      this.authCoordinator?.unregister(`exec-ab:${siteId}`);
      await entry.provider.close();
      entry.ipc.close();
      this.sessions.delete(siteId);
    }
  }

  isUsable(): boolean {
    return this.daemonAvailable === true;
  }

  async shutdown(): Promise<void> {
    // Unregister all participants
    for (const siteId of this.sessions.keys()) {
      this.authCoordinator?.unregister(`exec-ab:${siteId}`);
    }
    const closePromises = [...this.sessions.values()].map(async (entry) => {
      try {
        await entry.provider.close();
        entry.ipc.close();
      } catch (err) { log.debug({ err }, 'Session close failed during shutdown'); }
    });
    await Promise.allSettled(closePromises);
    this.sessions.clear();
  }

  /**
   * Reset the probe cache for testing.
   */
  resetProbe(): void {
    this.daemonAvailable = null;
    this.probePromise = null;
    this.lastFailTime = 0;
  }

  /**
   * Refresh cookies via an ephemeral IPC session (not cached in shared sessions Map).
   * Creates a short-lived session, hydrates existing cookies, navigates to trigger
   * network activity, reads back fresh cookies, and tears down.
   */
  async refreshCookies(siteId: string, domains: string[]): Promise<CookieEntry[]> {
    const available = await this.ensureProbed();
    if (!available) return [];

    const sessionName = `__prefetch_${siteId.replace(/[^a-zA-Z0-9_-]/g, '_')}_${Date.now()}`;
    const ipc = new AgentBrowserIpcClient();

    try {
      await ipc.bootstrapDaemon(sessionName);
      await ipc.connect(sessionName);

      // Hydrate existing cookies
      if (this.authStore) {
        const authState = this.authStore.load(siteId);
        if (authState && authState.cookies.length > 0) {
          await ipc.send({ action: 'cookies_set', cookies: authState.cookies });
        }
      }

      // Resolve a host to navigate to for triggering network activity
      const refreshHost = this.resolveRefreshHost(siteId, domains);
      if (refreshHost) {
        try {
          await ipc.send({ action: 'navigate', url: `https://${refreshHost}` });
        } catch (err) {
          log.debug({ err, siteId, refreshHost }, 'Refresh navigation failed — reading cookies anyway');
        }
      }

      // Read back cookies
      const result = await ipc.send({ action: 'cookies_get' });
      const cookies: CookieEntry[] = Array.isArray(result) ? result : [];

      // Tear down ephemeral session
      try { await ipc.send({ action: 'close' }); } catch (err) { log.debug({ err }, 'IPC close send failed'); }
      ipc.close();

      return cookies;
    } catch (err) {
      // Clean up IPC client but re-throw — callers (Promise.allSettled in
      // prefetchStaleAuth) must distinguish failure from empty cookie jar
      // to avoid wiping canonical auth state.
      try { ipc.close(); } catch (err2) { log.debug({ err: err2 }, 'IPC cleanup failed'); }
      throw err;
    }
  }

  /**
   * Resolve a host to navigate to for cookie refresh.
   * Priority: domain allowlist > cookie domain > siteId as hostname > skip.
   */
  private resolveRefreshHost(siteId: string, domains: string[]): string | undefined {
    // a) Matching cookie domain from auth store — prefer the host that actually
    //    holds auth cookies over an arbitrary allowlisted domain.
    if (this.authStore) {
      const authState = this.authStore.load(siteId);
      if (authState) {
        for (const cookie of authState.cookies) {
          const domain = (cookie.domain ?? '').replace(/^\./, '');
          if (domain && (siteId === domain || siteId.endsWith('.' + domain))) {
            return domain;
          }
        }
      }
    }

    // b) Domain allowlist (admin-curated)
    if (domains.length > 0) return domains[0];

    // c) siteId as hostname — only if it looks like a real hostname (contains a dot)
    if (siteId.includes('.')) {
      try {
        new URL('https://' + siteId);
        return siteId;
      } catch { /* not a valid hostname */ }
    }

    // d) Skip
    log.debug({ siteId }, 'No valid refresh host found — skipping cookie refresh');
    return undefined;
  }

  // ─── Internal ──────────────────────────────────────────────────────

  /**
   * Once-promise probe: check agent-browser availability.
   * On success: cached permanently.
   * On failure: cached for PROBE_COOLDOWN_MS, then re-probed.
   */
  private async ensureProbed(): Promise<boolean> {
    // If permanently cached as available
    if (this.daemonAvailable === true) return true;

    // If cached as failed and within cooldown
    if (this.daemonAvailable === false) {
      if (Date.now() - this.lastFailTime < PROBE_COOLDOWN_MS) {
        return false;
      }
      // Cooldown expired — re-probe
      this.probePromise = null;
    }

    // Deduplicate concurrent probes
    if (!this.probePromise) {
      this.probePromise = this.runProbe();
    }

    return this.probePromise;
  }

  private async runProbe(): Promise<boolean> {
    try {
      // Step 1: Check `which agent-browser`
      await new Promise<void>((resolve, reject) => {
        execFile('which', ['agent-browser'], { timeout: 5000 }, (err) => {
          if (err) reject(new Error('agent-browser not found'));
          else resolve();
        });
      });

      // Step 2: Bootstrap probe session
      const probeName = `__probe_${process.pid}_${Date.now()}__`;
      const ipc = new AgentBrowserIpcClient();
      try {
        await ipc.bootstrapDaemon(probeName);
        await ipc.connect(probeName);

        // Step 3: Send a verify command
        await ipc.send({ action: 'url' });

        // Step 4: Tear down probe
        await ipc.send({ action: 'close' });
        ipc.close();
      } catch (err) {
        ipc.close();
        throw err;
      }

      this.daemonAvailable = true;
      return true;
    } catch (err) {
      log.debug({ err }, 'agent-browser probe failed');
      this.daemonAvailable = false;
      this.lastFailTime = Date.now();
      return false;
    }
  }
}
