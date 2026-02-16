import { describe, it, expect } from 'vitest';
import { BrowserBenchmark } from '../../src/browser/benchmark.js';

describe('BrowserBenchmark', () => {
  it('records and summarizes snapshot metrics', () => {
    const bench = new BrowserBenchmark();
    bench.recordSnapshot(100, 50);
    bench.recordSnapshot(200, 30);

    const summary = bench.getSummary();
    expect(summary.totalSnapshots).toBe(2);
    expect(summary.avgSnapshotTokens).toBe(150);
    expect(summary.avgSnapshotLatencyMs).toBe(40);
  });

  it('records and summarizes action metrics', () => {
    const bench = new BrowserBenchmark();
    bench.recordAction('browser_click', 100, true);
    bench.recordAction('browser_type', 200, true);
    bench.recordAction('browser_click', 150, false);

    const summary = bench.getSummary();
    expect(summary.totalActions).toBe(3);
    expect(summary.avgActionLatencyMs).toBe(150);
    expect(summary.actionSuccessRate).toBeCloseTo(0.667, 2);
  });

  it('tracks stale ref rate', () => {
    const bench = new BrowserBenchmark();
    bench.recordStaleRef(true);
    bench.recordStaleRef(true);
    bench.recordStaleRef(false);

    const summary = bench.getSummary();
    expect(summary.staleRefRate).toBeCloseTo(0.333, 2);
  });

  it('returns zero stale ref rate when no attempts', () => {
    const bench = new BrowserBenchmark();
    expect(bench.getSummary().staleRefRate).toBe(0);
  });

  it('tracks screenshot sizes', () => {
    const bench = new BrowserBenchmark();
    bench.recordScreenshot(1000);
    bench.recordScreenshot(2000);

    expect(bench.getSummary().avgScreenshotBytes).toBe(1500);
  });

  it('tracks network entry counts', () => {
    const bench = new BrowserBenchmark();
    bench.recordNetworkEntries(10);
    bench.recordNetworkEntries(20);

    expect(bench.getSummary().totalNetworkEntries).toBe(30);
  });

  it('resets all metrics', () => {
    const bench = new BrowserBenchmark();
    bench.recordSnapshot(100, 50);
    bench.recordAction('click', 100, true);
    bench.recordStaleRef(false);
    bench.recordScreenshot(1000);
    bench.recordNetworkEntries(5);

    bench.reset();

    const summary = bench.getSummary();
    expect(summary.totalSnapshots).toBe(0);
    expect(summary.totalActions).toBe(0);
    expect(summary.staleRefRate).toBe(0);
    expect(summary.avgScreenshotBytes).toBe(0);
    expect(summary.totalNetworkEntries).toBe(0);
  });

  it('returns defaults for empty summary', () => {
    const bench = new BrowserBenchmark();
    const summary = bench.getSummary();

    expect(summary.totalSnapshots).toBe(0);
    expect(summary.avgSnapshotTokens).toBe(0);
    expect(summary.avgSnapshotLatencyMs).toBe(0);
    expect(summary.totalActions).toBe(0);
    expect(summary.avgActionLatencyMs).toBe(0);
    expect(summary.actionSuccessRate).toBe(1); // no failures = 100%
    expect(summary.staleRefRate).toBe(0);
    expect(summary.avgScreenshotBytes).toBe(0);
    expect(summary.totalNetworkEntries).toBe(0);
  });

  it('estimates tokens from content', () => {
    expect(BrowserBenchmark.estimateTokens('')).toBe(0);
    expect(BrowserBenchmark.estimateTokens('abcd')).toBe(1);
    expect(BrowserBenchmark.estimateTokens('abcde')).toBe(2);
    expect(BrowserBenchmark.estimateTokens('a'.repeat(100))).toBe(25);
  });
});
