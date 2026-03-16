import type { NetworkEntry } from '../skill/types.js';

interface TimestampedNetworkEntry {
  entry: NetworkEntry;
  capturedAt: number;
}

export class NetworkRingBuffer {
  private entries: TimestampedNetworkEntry[] = [];
  private maxEntries: number;
  private maxAgeMs: number;

  constructor(opts?: { maxEntries?: number; maxAgeMs?: number }) {
    this.maxEntries = opts?.maxEntries ?? 500;
    this.maxAgeMs = opts?.maxAgeMs ?? 5 * 60 * 1000;
  }

  push(entry: NetworkEntry): void {
    this.entries.push({ entry, capturedAt: Date.now() });
    this.evict();
  }

  snapshot(sinceMs?: number): NetworkEntry[] {
    this.evict();
    const cutoff = sinceMs ? Date.now() - sinceMs : 0;
    return this.entries
      .filter(e => e.capturedAt >= cutoff)
      .map(e => e.entry);
  }

  get size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
  }

  private evict(): void {
    const cutoff = Date.now() - this.maxAgeMs;
    while (this.entries.length > this.maxEntries ||
           (this.entries.length > 0 && this.entries[0].capturedAt < cutoff)) {
      this.entries.shift();
    }
  }
}
