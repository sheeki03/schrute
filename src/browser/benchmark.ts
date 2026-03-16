// ─── Browser Benchmark ──────────────────────────────────────────
// Metrics collection for browser automation performance tracking.
// Zero overhead when benchmark instance is null.

interface BrowserMetrics {
  snapshotTokens: number;
  snapshotLatencyMs: number;
  actionLatencyMs: number;
  actionSuccess: boolean;
  staleRefRate: number;
  screenshotBytes: number;
  networkEntriesCount: number;
}

interface BenchmarkSummary {
  totalSnapshots: number;
  avgSnapshotTokens: number;
  avgSnapshotLatencyMs: number;
  totalActions: number;
  avgActionLatencyMs: number;
  actionSuccessRate: number;
  staleRefRate: number;
  avgScreenshotBytes: number;
  totalNetworkEntries: number;
}

export class BrowserBenchmark {
  private snapshotTokensList: number[] = [];
  private snapshotLatencies: number[] = [];
  private actionLatencies: number[] = [];
  private actionSuccesses: number[] = [];
  private staleRefAttempts = 0;
  private staleRefFailures = 0;
  private screenshotSizes: number[] = [];
  private networkCounts: number[] = [];

  recordSnapshot(tokens: number, latencyMs: number): void {
    this.snapshotTokensList.push(tokens);
    this.snapshotLatencies.push(latencyMs);
  }

  recordAction(tool: string, latencyMs: number, success: boolean): void {
    this.actionLatencies.push(latencyMs);
    this.actionSuccesses.push(success ? 1 : 0);
  }

  recordStaleRef(found: boolean): void {
    this.staleRefAttempts++;
    if (!found) this.staleRefFailures++;
  }

  recordScreenshot(bytes: number): void {
    this.screenshotSizes.push(bytes);
  }

  recordNetworkEntries(count: number): void {
    this.networkCounts.push(count);
  }

  /** Estimate token count from content string length */
  static estimateTokens(content: string): number {
    return Math.ceil(content.length / 4);
  }

  getSummary(): BenchmarkSummary {
    const avg = (arr: number[]) => arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;

    return {
      totalSnapshots: this.snapshotTokensList.length,
      avgSnapshotTokens: Math.round(avg(this.snapshotTokensList)),
      avgSnapshotLatencyMs: Math.round(avg(this.snapshotLatencies) * 100) / 100,
      totalActions: this.actionLatencies.length,
      avgActionLatencyMs: Math.round(avg(this.actionLatencies) * 100) / 100,
      actionSuccessRate: this.actionSuccesses.length === 0
        ? 1
        : Math.round((avg(this.actionSuccesses)) * 1000) / 1000,
      staleRefRate: this.staleRefAttempts === 0
        ? 0
        : Math.round((this.staleRefFailures / this.staleRefAttempts) * 1000) / 1000,
      avgScreenshotBytes: Math.round(avg(this.screenshotSizes)),
      totalNetworkEntries: this.networkCounts.reduce((a, b) => a + b, 0),
    };
  }

  reset(): void {
    this.snapshotTokensList = [];
    this.snapshotLatencies = [];
    this.actionLatencies = [];
    this.actionSuccesses = [];
    this.staleRefAttempts = 0;
    this.staleRefFailures = 0;
    this.screenshotSizes = [];
    this.networkCounts = [];
  }
}
