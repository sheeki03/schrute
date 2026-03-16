import * as fs from 'node:fs';
import * as path from 'node:path';
import { getLogger } from '../core/logger.js';
import type { ExecutionTierName, FailureCauseName } from '../skill/types.js';

const log = getLogger();

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50MB rotation

export interface TrajectoryStep {
  tier: ExecutionTierName;
  status: number;
  latencyMs: number;
  failureCause?: FailureCauseName;
  success: boolean;
}

export interface Trajectory {
  skillId: string;
  siteId: string;
  tiersAttempted: ExecutionTierName[];
  steps: TrajectoryStep[];
  finalSuccess: boolean;
  totalLatencyMs: number;
  timestamp: number;
}

export class TrajectoryRecorder {
  private filePath: string;

  constructor(dataDir: string) {
    const trajDir = path.join(dataDir, 'trajectories');
    fs.mkdirSync(trajDir, { recursive: true, mode: 0o700 });
    this.filePath = path.join(trajDir, 'executions.jsonl');
  }

  /**
   * Record a trajectory. Rotates the file when it exceeds 50MB.
   */
  record(trajectory: Trajectory): void {
    try {
      this.rotateIfNeeded();
      const line = JSON.stringify(trajectory) + '\n';
      fs.appendFileSync(this.filePath, line, { mode: 0o600 });
    } catch (err) {
      log.warn({ err, skillId: trajectory.skillId }, 'Failed to record trajectory (non-blocking)');
    }
  }

  /**
   * Read recent trajectories (last N lines from the file).
   */
  getRecent(limit: number = 100): Trajectory[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const content = fs.readFileSync(this.filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      const recent = lines.slice(-limit);
      return recent.map(line => JSON.parse(line) as Trajectory);
    } catch (err) {
      log.warn({ err }, 'Failed to read trajectories');
      return [];
    }
  }

  /**
   * Get trajectories for a specific skill.
   */
  getBySkillId(skillId: string, limit: number = 50): Trajectory[] {
    return this.getRecent(1000).filter(t => t.skillId === skillId).slice(-limit);
  }

  private rotateIfNeeded(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const stats = fs.statSync(this.filePath);
      if (stats.size > MAX_FILE_BYTES) {
        // Read the file and keep only the last half
        const content = fs.readFileSync(this.filePath, 'utf-8');
        const lines = content.trim().split('\n');
        const keepFrom = Math.floor(lines.length / 2);
        const kept = lines.slice(keepFrom).join('\n') + '\n';
        fs.writeFileSync(this.filePath, kept, { mode: 0o600 });
        log.info({ rotatedLines: keepFrom }, 'Trajectory file rotated');
      }
    } catch (err) {
      log.warn({ err }, 'Trajectory rotation failed (non-blocking)');
    }
  }
}
