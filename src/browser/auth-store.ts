import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { getLogger } from '../core/logger.js';
import { writeFileAtomically } from '../shared/atomic-write.js';
import type { CookieEntry } from './backend.js';

const log = getLogger();

interface SiteAuthState {
  cookies: CookieEntry[];
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
  version: number;
  lastUpdated: number;
}

/**
 * Canonical browser auth state per site.
 *
 * Scope: cookies + localStorage (covers 95%+ of web auth patterns).
 * Explicitly excludes: sessionStorage, IndexedDB, Cache API, service workers.
 */
export class BrowserAuthStore {
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = path.join(dataDir, 'browser-data');
  }

  /**
   * Load auth state for a site.
   */
  load(siteId: string): SiteAuthState | undefined {
    const filePath = this.getAuthStatePath(siteId);
    try {
      if (!fs.existsSync(filePath)) return undefined;
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as SiteAuthState;
    } catch (err) {
      log.warn({ err, siteId }, 'Failed to load auth state');
      return undefined;
    }
  }

  /**
   * Persist auth state. Diff-aware: only bumps version if the new state
   * differs from the currently stored state. Returns whether state changed.
   */
  save(
    siteId: string,
    state: Omit<SiteAuthState, 'version'>,
  ): { changed: boolean; version: number } {
    const existing = this.load(siteId);
    const newHash = this.contentHash(state);
    const existingHash = existing
      ? this.contentHash({
          cookies: existing.cookies,
          origins: existing.origins,
          lastUpdated: existing.lastUpdated,
        })
      : '';

    if (newHash === existingHash && existing) {
      return { changed: false, version: existing.version };
    }

    const version = (existing?.version ?? 0) + 1;
    const fullState: SiteAuthState = { ...state, version };

    const dir = this.getSiteDir(siteId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileAtomically(
      this.getAuthStatePath(siteId),
      JSON.stringify(fullState, null, 2),
      { mode: 0o600 },
    );

    log.debug({ siteId, version }, 'Auth state saved');
    return { changed: true, version };
  }

  /**
   * Convert to Playwright storage state format.
   */
  toPlaywrightStorageState(state: SiteAuthState): object {
    return {
      cookies: state.cookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires ?? -1,
        httpOnly: c.httpOnly ?? false,
        secure: c.secure ?? false,
        sameSite: c.sameSite ?? 'None',
      })),
      origins: state.origins,
    };
  }

  private getSiteDir(siteId: string): string {
    // Sanitize siteId for filesystem
    const safe = siteId.replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.dataDir, safe);
  }

  private getAuthStatePath(siteId: string): string {
    return path.join(this.getSiteDir(siteId), 'auth-state.json');
  }

  private contentHash(state: Omit<SiteAuthState, 'version'>): string {
    const content = JSON.stringify({
      cookies: state.cookies,
      origins: state.origins,
    });
    return crypto.createHash('sha256').update(content).digest('hex');
  }
}
