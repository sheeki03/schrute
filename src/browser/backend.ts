import type { BrowserProvider } from '../skill/types.js';

/**
 * Cookie entry for cross-backend cookie exchange.
 */
export interface CookieEntry {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/**
 * Abstract interface for browser execution backends.
 * Implemented by PlaywrightBackend and AgentBrowserBackend.
 */
export interface BrowserBackend {
  /** Create a browser provider for skill execution on a specific site. */
  createProvider(siteId: string, domains: string[]): Promise<BrowserProvider | undefined>;

  /** Get cookies for a site. */
  getCookies(siteId: string): Promise<CookieEntry[]>;

  /** Set cookies for a site. */
  setCookies(siteId: string, cookies: CookieEntry[]): Promise<void>;

  /** Import cookies from a Netscape cookie file. Returns count imported. */
  importCookies(siteId: string, cookieFile: string): Promise<number>;

  /** Export cookies for a site. */
  exportCookies(siteId: string): Promise<CookieEntry[]>;

  /** Graceful close: persist auth then close. */
  closeAndPersist(siteId: string): Promise<void>;

  /** Invalidation close: close WITHOUT persisting stale state. */
  discardSession(siteId: string): Promise<void>;

  /** Whether this backend is currently usable. */
  isUsable(): boolean;

  /** Shut down the backend. */
  shutdown(): Promise<void>;
}
