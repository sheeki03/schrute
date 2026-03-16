import * as os from 'node:os';
import { getLogger } from '../core/logger.js';

const log = getLogger();

// ─── Types ──────────────────────────────────────────────────────

interface GovernorConfig {
  maxConcurrent: number;      // hard limit on concurrent local browsers
  memoryThresholdPct: number; // 0-1, refuse if RSS/total exceeds this
  queueMaxWait: number;       // max ms to wait in queue before rejecting
}

const DEFAULT_GOVERNOR_CONFIG: GovernorConfig = {
  maxConcurrent: 4,
  memoryThresholdPct: 0.8,
  queueMaxWait: 30000,
};

interface QueueEntry {
  resolve: (value: void) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  enqueuedAt: number;
}

// ─── Governor ───────────────────────────────────────────────────

/**
 * ParallelismGovernor gates local browser launches to prevent OOM.
 *
 * Only gates local `launchBrowserEngine()` calls, NOT pool borrows.
 * Local launch consumes local memory; pool borrow is remote.
 */
export class ParallelismGovernor {
  private config: GovernorConfig;
  private activeLaunches = 0;
  private queue: QueueEntry[] = [];

  constructor(config?: Partial<GovernorConfig>) {
    this.config = { ...DEFAULT_GOVERNOR_CONFIG, ...config };
  }

  /**
   * Request permission to launch a local browser.
   * Resolves when a slot is available, rejects if queue timeout expires.
   */
  async acquire(): Promise<void> {
    if (this.canLaunch()) {
      this.activeLaunches++;
      return;
    }

    // Queue the request
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex(e => e.resolve === resolve);
        if (idx >= 0) this.queue.splice(idx, 1);
        reject(new Error(`Governor queue timeout after ${this.config.queueMaxWait}ms`));
      }, this.config.queueMaxWait);

      this.queue.push({ resolve, reject, timer, enqueuedAt: Date.now() });
    });
  }

  /**
   * Release a browser slot after browser close.
   */
  release(): void {
    this.activeLaunches = Math.max(0, this.activeLaunches - 1);
    this.drainQueue();
  }

  /**
   * Get current governor state for diagnostics.
   */
  getState(): { active: number; queued: number; maxConcurrent: number; memoryPressure: boolean } {
    return {
      active: this.activeLaunches,
      queued: this.queue.length,
      maxConcurrent: this.config.maxConcurrent,
      memoryPressure: this.isMemoryPressured(),
    };
  }

  /**
   * Reset governor state (for testing).
   */
  reset(): void {
    this.activeLaunches = 0;
    for (const entry of this.queue) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Governor reset'));
    }
    this.queue = [];
  }

  // ─── Private ────────────────────────────────────────────────

  private canLaunch(): boolean {
    if (this.activeLaunches >= this.config.maxConcurrent) return false;
    if (this.isMemoryPressured()) {
      log.warn(
        { rssBytes: process.memoryUsage.rss(), totalBytes: os.totalmem(), threshold: this.config.memoryThresholdPct },
        'Governor: memory pressure — deferring browser launch',
      );
      return false;
    }
    return true;
  }

  private isMemoryPressured(): boolean {
    const rss = process.memoryUsage.rss();
    const total = os.totalmem();
    return rss / total > this.config.memoryThresholdPct;
  }

  private drainQueue(): void {
    while (this.queue.length > 0 && this.canLaunch()) {
      const entry = this.queue.shift()!;
      clearTimeout(entry.timer);
      this.activeLaunches++;
      entry.resolve();
    }
  }
}
