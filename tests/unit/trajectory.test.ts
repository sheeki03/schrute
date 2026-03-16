import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TrajectoryRecorder, type Trajectory } from '../../src/replay/trajectory.js';
import { ExecutionTier, FailureCause } from '../../src/skill/types.js';

describe('TrajectoryRecorder', () => {
  let dataDir: string;
  let recorder: TrajectoryRecorder;

  beforeEach(() => {
    dataDir = '/tmp/schrute-traj-test-' + Math.random().toString(36).slice(2);
    recorder = new TrajectoryRecorder(dataDir);
  });

  afterEach(() => {
    try { fs.rmSync(dataDir, { recursive: true }); } catch {}
  });

  function makeTrajectory(overrides?: Partial<Trajectory>): Trajectory {
    return {
      skillId: 'example.com.get_users.v1',
      siteId: 'example.com',
      tiersAttempted: [ExecutionTier.DIRECT],
      steps: [{
        tier: ExecutionTier.DIRECT,
        status: 200,
        latencyMs: 42,
        success: true,
      }],
      finalSuccess: true,
      totalLatencyMs: 42,
      timestamp: Date.now(),
      ...overrides,
    };
  }

  it('records and reads trajectories', () => {
    recorder.record(makeTrajectory());
    recorder.record(makeTrajectory({ skillId: 'other.v1' }));
    const recent = recorder.getRecent(10);
    expect(recent).toHaveLength(2);
    expect(recent[0].skillId).toBe('example.com.get_users.v1');
  });

  it('filters by skillId', () => {
    recorder.record(makeTrajectory());
    recorder.record(makeTrajectory({ skillId: 'other.v1' }));
    const filtered = recorder.getBySkillId('example.com.get_users.v1');
    expect(filtered).toHaveLength(1);
  });

  it('returns empty array when no file exists', () => {
    expect(recorder.getRecent()).toEqual([]);
  });

  it('limits results', () => {
    for (let i = 0; i < 10; i++) {
      recorder.record(makeTrajectory({ timestamp: i }));
    }
    expect(recorder.getRecent(3)).toHaveLength(3);
  });

  it('sets file permissions to 0o600', () => {
    recorder.record(makeTrajectory());
    const filePath = path.join(dataDir, 'trajectories', 'executions.jsonl');
    const stats = fs.statSync(filePath);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('records failure trajectories', () => {
    recorder.record(makeTrajectory({
      finalSuccess: false,
      steps: [{
        tier: ExecutionTier.DIRECT,
        status: 500,
        latencyMs: 100,
        failureCause: FailureCause.UNKNOWN,
        success: false,
      }],
    }));
    const recent = recorder.getRecent();
    expect(recent[0].finalSuccess).toBe(false);
    expect(recent[0].steps[0].failureCause).toBe('unknown');
  });
});
