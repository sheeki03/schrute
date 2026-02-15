import { randomUUID } from 'node:crypto';
import { getLogger } from './logger.js';
import { BrowserManager } from '../browser/manager.js';

// ─── Types ────────────────────────────────────────────────────────

export interface SessionInfo {
  id: string;
  siteId: string;
  url: string;
  startedAt: number;
  browserContextId: string;
}

// ─── Session Manager ──────────────────────────────────────────────

export class SessionManager {
  private sessions = new Map<string, SessionInfo>();
  private browserManager: BrowserManager;
  private log = getLogger();

  constructor(browserManager?: BrowserManager) {
    this.browserManager = browserManager ?? new BrowserManager();
  }

  async create(siteId: string, url: string): Promise<SessionInfo> {
    const contextId = randomUUID();

    // Create a browser context for this site via BrowserManager.
    // In headless environments (CI, tests) this may fail gracefully —
    // the session is still created and usable for non-browser tiers.
    try {
      await this.browserManager.getOrCreateContext(siteId);
      this.log.info({ siteId }, 'Browser context created');
    } catch (err) {
      this.log.warn(
        { siteId, err },
        'Could not create browser context — session created without browser',
      );
    }

    const session: SessionInfo = {
      id: randomUUID(),
      siteId,
      url,
      startedAt: Date.now(),
      browserContextId: contextId,
    };

    this.sessions.set(session.id, session);
    this.log.info(
      { sessionId: session.id, siteId, url },
      'Session created',
    );

    return session;
  }

  async resume(sessionId: string): Promise<SessionInfo> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }

    this.log.debug({ sessionId }, 'Session resumed');

    // Verify browser context is alive
    if (!this.browserManager.hasContext(session.siteId)) {
      this.log.warn({ sessionId, siteId: session.siteId }, 'Browser context no longer exists');
    }

    return session;
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.log.warn({ sessionId }, 'Attempted to close non-existent session');
      return;
    }

    // Close browser context (saves storage state)
    try {
      await this.browserManager.closeContext(session.siteId);
    } catch (err) {
      this.log.warn({ sessionId, siteId: session.siteId, err }, 'Error closing browser context');
    }

    this.sessions.delete(sessionId);
    this.log.info(
      { sessionId, siteId: session.siteId, durationMs: Date.now() - session.startedAt },
      'Session closed',
    );
  }

  listActive(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  getBrowserManager(): BrowserManager {
    return this.browserManager;
  }

  getHarPath(siteId: string): string | undefined {
    return this.browserManager.getHarPath(siteId);
  }
}
