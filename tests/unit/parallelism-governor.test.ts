import { describe, it, expect, afterEach } from 'vitest';
import { ParallelismGovernor } from '../../src/browser/parallelism-governor.js';

describe('ParallelismGovernor', () => {
  let governor: ParallelismGovernor;

  afterEach(() => {
    governor?.reset();
  });

  it('allows launches up to max concurrent', async () => {
    governor = new ParallelismGovernor({ maxConcurrent: 2, memoryThresholdPct: 1.0 });
    await governor.acquire();
    await governor.acquire();
    expect(governor.getState().active).toBe(2);
  });

  it('queues when at capacity and releases on release()', async () => {
    governor = new ParallelismGovernor({ maxConcurrent: 1, memoryThresholdPct: 1.0 });
    await governor.acquire();

    let resolved = false;
    const pending = governor.acquire().then(() => { resolved = true; });

    // Should be queued
    expect(governor.getState().queued).toBe(1);
    expect(resolved).toBe(false);

    governor.release();
    await pending;
    expect(resolved).toBe(true);
  });

  it('rejects on queue timeout', async () => {
    governor = new ParallelismGovernor({ maxConcurrent: 1, memoryThresholdPct: 1.0, queueMaxWait: 50 });
    await governor.acquire();

    await expect(governor.acquire()).rejects.toThrow('Governor queue timeout');
  });

  it('reports state correctly', async () => {
    governor = new ParallelismGovernor({ maxConcurrent: 3, memoryThresholdPct: 1.0 });
    const state = governor.getState();
    expect(state.active).toBe(0);
    expect(state.queued).toBe(0);
    expect(state.maxConcurrent).toBe(3);
  });

  it('reset clears all state', async () => {
    governor = new ParallelismGovernor({ maxConcurrent: 1, memoryThresholdPct: 1.0 });
    await governor.acquire();
    governor.reset();
    expect(governor.getState().active).toBe(0);
  });
});
