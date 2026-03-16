import type { AgentDatabase } from './database.js';

interface SkillAmendment {
  id: string;
  skillId: string;
  failureCause: string;
  strategy: string;
  snapshotFields: string;
  successRateBefore: number;
  successRateAfter?: number;
  executionsSince: number;
  evaluationWindow: number;
  status: 'active' | 'kept' | 'reverted' | 'expired';
  createdAt: number;
  resolvedAt?: number;
}

interface AmendmentRow {
  id: string;
  skill_id: string;
  failure_cause: string;
  strategy: string;
  snapshot_fields: string;
  success_rate_before: number;
  success_rate_after: number | null;
  executions_since: number;
  evaluation_window: number;
  status: string;
  created_at: number;
  resolved_at: number | null;
}

function rowToAmendment(row: AmendmentRow): SkillAmendment {
  return {
    id: row.id,
    skillId: row.skill_id,
    failureCause: row.failure_cause,
    strategy: row.strategy,
    snapshotFields: row.snapshot_fields,
    successRateBefore: row.success_rate_before,
    successRateAfter: row.success_rate_after ?? undefined,
    executionsSince: row.executions_since,
    evaluationWindow: row.evaluation_window,
    status: row.status as SkillAmendment['status'],
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined,
  };
}

export class AmendmentRepository {
  constructor(private db: AgentDatabase) {}

  create(amendment: Omit<SkillAmendment, 'executionsSince' | 'resolvedAt' | 'successRateAfter'>): void {
    this.db.run(
      `INSERT INTO skill_amendments (id, skill_id, failure_cause, strategy, snapshot_fields, success_rate_before, evaluation_window, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      amendment.id,
      amendment.skillId,
      amendment.failureCause,
      amendment.strategy,
      amendment.snapshotFields,
      amendment.successRateBefore,
      amendment.evaluationWindow,
      amendment.status,
      amendment.createdAt,
    );
  }

  getActiveAmendment(skillId: string): SkillAmendment | undefined {
    const row = this.db.get<AmendmentRow>(
      `SELECT * FROM skill_amendments WHERE skill_id = ? AND status = 'active'`,
      skillId,
    );
    return row ? rowToAmendment(row) : undefined;
  }

  hasActiveAmendment(skillId: string): boolean {
    return this.getActiveAmendment(skillId) !== undefined;
  }

  isInCooldown(skillId: string, cooldownExecutions: number): boolean {
    const lastReverted = this.db.get<{ resolved_at: number }>(
      `SELECT resolved_at FROM skill_amendments WHERE skill_id = ? AND status = 'reverted' ORDER BY resolved_at DESC LIMIT 1`,
      skillId,
    );
    if (!lastReverted) return false;

    // Count executions since last revert
    const execsSince = this.db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM skill_metrics WHERE skill_id = ? AND executed_at > ?`,
      skillId,
      lastReverted.resolved_at,
    );

    return (execsSince?.count ?? 0) < cooldownExecutions;
  }

  incrementExecutionCount(skillId: string): void {
    this.db.run(
      `UPDATE skill_amendments SET executions_since = executions_since + 1 WHERE skill_id = ? AND status = 'active'`,
      skillId,
    );
  }

  resolve(amendmentId: string, status: 'kept' | 'reverted', successRateAfter: number): void {
    this.db.run(
      `UPDATE skill_amendments SET status = ?, success_rate_after = ?, resolved_at = ? WHERE id = ?`,
      status,
      successRateAfter,
      Date.now(),
      amendmentId,
    );
  }

  rankStrategies(
    failureCause: string,
    candidates: readonly string[],
  ): Array<{ strategy: string; winRate: number }> {
    if (candidates.length === 0) return [];

    const placeholders = candidates.map(() => '?').join(',');
    const rows = this.db.all<{ strategy: string; win_rate: number }>(
      `SELECT strategy, AVG(CASE WHEN status='kept' THEN 1.0 ELSE 0.0 END) as win_rate
       FROM skill_amendments
       WHERE failure_cause = ? AND strategy IN (${placeholders}) AND status IN ('kept', 'reverted')
       GROUP BY strategy
       ORDER BY win_rate DESC`,
      failureCause,
      ...candidates,
    );

    return rows.map(r => ({ strategy: r.strategy, winRate: r.win_rate }));
  }

  getBySkillId(skillId: string): SkillAmendment[] {
    const rows = this.db.all<AmendmentRow>(
      `SELECT * FROM skill_amendments WHERE skill_id = ? ORDER BY created_at DESC`,
      skillId,
    );
    return rows.map(rowToAmendment);
  }

  getAll(): SkillAmendment[] {
    const rows = this.db.all<AmendmentRow>(
      `SELECT * FROM skill_amendments ORDER BY created_at DESC`,
    );
    return rows.map(rowToAmendment);
  }
}
