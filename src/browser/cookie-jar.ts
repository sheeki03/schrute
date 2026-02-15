import { getLogger } from '../core/logger.js';

const log = getLogger();

const SERVICE_NAME = 'oneagent';

interface CookieEntry {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

interface SiteState {
  cookies: CookieEntry[];
  lastRefresh: number;
}

/**
 * Cookie persistence with encrypted keychain storage.
 *
 * In normal mode: cookies are stored per-site via the OS keychain (keytar).
 * In locked mode: cookies are only in-memory for the current session — not persisted.
 */
export class CookieJar {
  private inMemoryStore = new Map<string, SiteState>();
  private locked: boolean;
  private refreshIntervalMs: number;
  private keytar: typeof import('keytar') | null = null;
  private keytarLoadAttempted = false;

  /**
   * @param locked - If true, cookies are never persisted to keychain (in-memory only).
   * @param refreshIntervalMs - How often cookies should be refreshed (default: 30 minutes).
   */
  constructor(locked = false, refreshIntervalMs = 30 * 60 * 1000) {
    this.locked = locked;
    this.refreshIntervalMs = refreshIntervalMs;
  }

  /**
   * Lazily load keytar. It's a native module and may not be available
   * in all environments.
   */
  private async loadKeytar(): Promise<typeof import('keytar') | null> {
    if (this.keytarLoadAttempted) {
      return this.keytar;
    }
    this.keytarLoadAttempted = true;
    try {
      this.keytar = await import('keytar');
      return this.keytar;
    } catch (err) {
      log.warn({ err }, 'keytar not available — falling back to in-memory cookie storage');
      return null;
    }
  }

  /**
   * Build the keychain key for a site's cookies.
   */
  private keychainKey(siteId: string): string {
    return `site:${siteId}:cookies`;
  }

  /**
   * Save cookies for a site.
   *
   * In locked mode: stored in memory only.
   * In normal mode: persisted to OS keychain via keytar.
   */
  async saveCookies(siteId: string, cookies: CookieEntry[]): Promise<void> {
    const state: SiteState = {
      cookies,
      lastRefresh: Date.now(),
    };

    // Always update in-memory store
    this.inMemoryStore.set(siteId, state);

    if (this.locked) {
      log.debug({ siteId }, 'Locked mode — cookies stored in memory only');
      return;
    }

    // Persist to keychain
    const kt = await this.loadKeytar();
    if (!kt) {
      return; // Fall back to in-memory
    }

    try {
      const serialized = JSON.stringify(state);
      await kt.setPassword(SERVICE_NAME, this.keychainKey(siteId), serialized);
      log.debug({ siteId, count: cookies.length }, 'Saved cookies to keychain');
    } catch (err) {
      log.warn({ siteId, err }, 'Failed to save cookies to keychain');
    }
  }

  /**
   * Load cookies for a site.
   *
   * Checks in-memory cache first, then keychain (if not locked).
   */
  async loadCookies(siteId: string): Promise<CookieEntry[]> {
    // Check in-memory first
    const cached = this.inMemoryStore.get(siteId);
    if (cached) {
      return cached.cookies;
    }

    if (this.locked) {
      return []; // Locked mode — no persistence
    }

    // Try keychain
    const kt = await this.loadKeytar();
    if (!kt) {
      return [];
    }

    try {
      const serialized = await kt.getPassword(
        SERVICE_NAME,
        this.keychainKey(siteId),
      );
      if (!serialized) {
        return [];
      }

      const state: SiteState = JSON.parse(serialized);
      this.inMemoryStore.set(siteId, state);
      log.debug({ siteId, count: state.cookies.length }, 'Loaded cookies from keychain');
      return state.cookies;
    } catch (err) {
      log.warn({ siteId, err }, 'Failed to load cookies from keychain');
      return [];
    }
  }

  /**
   * Clear all cookies for a site (both in-memory and keychain).
   */
  async clearCookies(siteId: string): Promise<void> {
    this.inMemoryStore.delete(siteId);

    if (this.locked) {
      return;
    }

    const kt = await this.loadKeytar();
    if (!kt) {
      return;
    }

    try {
      await kt.deletePassword(SERVICE_NAME, this.keychainKey(siteId));
      log.debug({ siteId }, 'Cleared cookies from keychain');
    } catch (err) {
      log.warn({ siteId, err }, 'Failed to clear cookies from keychain');
    }
  }

  /**
   * Check if cookies for a site need refreshing.
   *
   * Returns true if:
   * - No cookies are stored for this site
   * - The last refresh was longer ago than refreshIntervalMs
   */
  async refreshNeeded(siteId: string): Promise<boolean> {
    // Check in-memory first
    const cached = this.inMemoryStore.get(siteId);
    if (cached) {
      return Date.now() - cached.lastRefresh > this.refreshIntervalMs;
    }

    if (this.locked) {
      return true; // No cookies in locked mode without in-memory state
    }

    // Check keychain
    const kt = await this.loadKeytar();
    if (!kt) {
      return true;
    }

    try {
      const serialized = await kt.getPassword(
        SERVICE_NAME,
        this.keychainKey(siteId),
      );
      if (!serialized) {
        return true;
      }

      const state: SiteState = JSON.parse(serialized);
      this.inMemoryStore.set(siteId, state); // Cache it
      return Date.now() - state.lastRefresh > this.refreshIntervalMs;
    } catch {
      return true;
    }
  }
}
