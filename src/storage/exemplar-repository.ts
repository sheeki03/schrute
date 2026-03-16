import type { AgentDatabase } from './database.js';

export interface SkillExemplar {
  skillId: string;
  responseStatus: number;
  responseSchemaHash: string;
  redactedResponseBody: string;
  capturedAt: number;
}

interface ExemplarRow {
  skill_id: string;
  response_status: number;
  response_schema_hash: string;
  redacted_response_body: string;
  captured_at: number;
}

function rowToExemplar(row: ExemplarRow): SkillExemplar {
  return {
    skillId: row.skill_id,
    responseStatus: row.response_status,
    responseSchemaHash: row.response_schema_hash,
    redactedResponseBody: row.redacted_response_body,
    capturedAt: row.captured_at,
  };
}

export class ExemplarRepository {
  constructor(private db: AgentDatabase) {}

  /**
   * Upsert an exemplar — overwrites the previous exemplar for this skill.
   */
  save(exemplar: SkillExemplar): void {
    this.db.run(
      `INSERT OR REPLACE INTO skill_exemplars (skill_id, response_status, response_schema_hash, redacted_response_body, captured_at)
       VALUES (?, ?, ?, ?, ?)`,
      exemplar.skillId,
      exemplar.responseStatus,
      exemplar.responseSchemaHash,
      exemplar.redactedResponseBody,
      exemplar.capturedAt,
    );
  }

  /**
   * Get the exemplar for a skill, if one exists.
   */
  get(skillId: string): SkillExemplar | undefined {
    const row = this.db.get<ExemplarRow>(
      `SELECT * FROM skill_exemplars WHERE skill_id = ?`,
      skillId,
    );
    return row ? rowToExemplar(row) : undefined;
  }

  /**
   * Delete the exemplar for a skill.
   */
  delete(skillId: string): void {
    this.db.run(`DELETE FROM skill_exemplars WHERE skill_id = ?`, skillId);
  }

  /**
   * Delete exemplars older than the retention period.
   */
  pruneOlderThan(cutoffMs: number): number {
    const result = this.db.run(
      `DELETE FROM skill_exemplars WHERE captured_at < ?`,
      cutoffMs,
    );
    return result.changes;
  }
}
