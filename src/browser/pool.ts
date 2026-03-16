import type { Browser } from 'playwright';
import { connectViaCDP } from './cdp-connector.js';
import { getLogger } from '../core/logger.js';

const log = getLogger();

interface PoolEntry {
  wsEndpoint: string;
  browser: Browser | null;
  activeSessions: number;
  maxSessions: number;
  lastUsed: number;
}

export class BrowserPool {
  private entries: PoolEntry[] = [];

  constructor(endpoints?: { wsEndpoint: string; maxSessions?: number }[]) {
    if (endpoints) {
      for (const ep of endpoints) {
        this.addEndpoint(ep.wsEndpoint, ep.maxSessions);
      }
    }
  }

  addEndpoint(wsEndpoint: string, maxSessions = 5): void {
    if (maxSessions < 1) throw new RangeError('maxSessions must be >= 1');
    if (this.entries.some(e => e.wsEndpoint === wsEndpoint)) return;
    this.entries.push({
      wsEndpoint,
      browser: null,
      activeSessions: 0,
      maxSessions,
      lastUsed: Date.now(),
    });
  }

  removeEndpoint(wsEndpoint: string): void {
    this.entries = this.entries.filter(e => e.wsEndpoint !== wsEndpoint);
  }

  async acquire(): Promise<{ browser: Browser; release: () => void }> {
    if (this.entries.length === 0) throw new Error('BrowserPool: no endpoints configured');

    // Least-loaded selection
    const sorted = [...this.entries]
      .filter(e => e.activeSessions < e.maxSessions)
      .sort((a, b) => (a.activeSessions / a.maxSessions) - (b.activeSessions / b.maxSessions));

    const entry = sorted[0];
    if (!entry) throw new Error('BrowserPool: all endpoints at capacity');

    if (!entry.browser || !entry.browser.isConnected()) {
      await this.reconnect(entry);
    }

    entry.activeSessions++;
    entry.lastUsed = Date.now();

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      entry.activeSessions = Math.max(0, entry.activeSessions - 1);
    };

    return { browser: entry.browser!, release };
  }

  private async reconnect(entry: PoolEntry): Promise<void> {
    try {
      log.info({ wsEndpoint: entry.wsEndpoint }, 'BrowserPool: connecting');
      entry.browser = await connectViaCDP({ wsEndpoint: entry.wsEndpoint });
      entry.browser.on('disconnected', () => {
        log.warn({ wsEndpoint: entry.wsEndpoint }, 'BrowserPool: browser disconnected');
        entry.browser = null;
      });
    } catch (err) {
      log.error({ err, wsEndpoint: entry.wsEndpoint }, 'BrowserPool: connection failed');
      throw err;
    }
  }

  async shutdown(): Promise<void> {
    for (const entry of this.entries) {
      try {
        if (entry.browser?.isConnected()) {
          await entry.browser.close();
        }
      } catch (err) { log.debug({ err }, 'Browser close failed (may already be closed)'); }
      entry.browser = null;
      entry.activeSessions = 0;
    }
    this.entries = [];
  }
}
