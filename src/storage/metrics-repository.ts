import type { AgentDatabase } from './database.js';
import type { ExecutionTierName, FailureCauseName, CapabilityName } from '../skill/types.js';

export interface SkillMetric {
  id?: number;
  skillId: string;
  executionTier: ExecutionTierName;
  success: boolean;
  latencyMs: number;
  errorType?: FailureCauseName;
  capabilityUsed?: CapabilityName;
  policyRule?: string;
  executedAt: number;
}

interface MetricRow {
  id: number;
  skill_id: string;
  execution_tier: string;
  success: number;
  latency_ms: number;
  error_type: string | null;
  capability_used: string | null;
  policy_rule: string | null;
  executed_at: number;
}

function rowToMetric(row: MetricRow): SkillMetric {
  return {
    id: row.id,
    skillId: row.skill_id,
    executionTier: row.execution_tier as ExecutionTierName,
    success: row.success === 1,
    latencyMs: row.latency_ms,
    errorType: (row.error_type as FailureCauseName) ?? undefined,
    capabilityUsed: (row.capability_used as CapabilityName) ?? undefined,
    policyRule: row.policy_rule ?? undefined,
    executedAt: row.executed_at,
  };
}

export class MetricsRepository {
  constructor(private db: AgentDatabase) {}

  record(metric: Omit<SkillMetric, 'id'>): void {
    this.db.run(
      `INSERT INTO skill_metrics (skill_id, execution_tier, success, latency_ms, error_type, capability_used, policy_rule, executed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      metric.skillId,
      metric.executionTier,
      metric.success ? 1 : 0,
      metric.latencyMs,
      metric.errorType ?? null,
      metric.capabilityUsed ?? null,
      metric.policyRule ?? null,
      metric.executedAt,
    );
  }

  getBySkillId(skillId: string): SkillMetric[] {
    const rows = this.db.all<MetricRow>(
      'SELECT * FROM skill_metrics WHERE skill_id = ? ORDER BY executed_at DESC',
      skillId,
    );
    return rows.map(rowToMetric);
  }

  getRecentBySkillId(skillId: string, limit = 100): SkillMetric[] {
    const rows = this.db.all<MetricRow>(
      'SELECT * FROM skill_metrics WHERE skill_id = ? ORDER BY executed_at DESC LIMIT ?',
      skillId,
      limit,
    );
    return rows.map(rowToMetric);
  }

  getSuccessRate(skillId: string): number {
    const row = this.db.get<{ total: number; successes: number }>(
      'SELECT COUNT(*) as total, SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes FROM skill_metrics WHERE skill_id = ?',
      skillId,
    );
    if (!row || row.total === 0) return 0;
    return row.successes / row.total;
  }

  getAverageLatency(skillId: string): number {
    const row = this.db.get<{ avg_latency: number | null }>(
      'SELECT AVG(latency_ms) as avg_latency FROM skill_metrics WHERE skill_id = ?',
      skillId,
    );
    return row?.avg_latency ?? 0;
  }
}
