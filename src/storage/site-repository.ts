import type { AgentDatabase } from './database.js';
import type { SiteManifest, MasteryLevelName, ExecutionTierName } from '../skill/types.js';
import { MasteryLevel, ExecutionTier } from '../skill/types.js';

const VALID_MASTERY_LEVELS: readonly string[] = Object.values(MasteryLevel);
function validateMasteryLevel(value: string): MasteryLevelName {
  if (!VALID_MASTERY_LEVELS.includes(value)) {
    throw new Error(`Invalid mastery level from database: "${value}". Expected one of: ${VALID_MASTERY_LEVELS.join(', ')}`);
  }
  return value as MasteryLevelName;
}

const VALID_EXECUTION_TIERS: readonly string[] = Object.values(ExecutionTier);
function validateExecutionTier(value: string): ExecutionTierName {
  if (!VALID_EXECUTION_TIERS.includes(value)) {
    throw new Error(`Invalid execution tier from database: "${value}". Expected one of: ${VALID_EXECUTION_TIERS.join(', ')}`);
  }
  return value as ExecutionTierName;
}

interface SiteRow {
  id: string;
  display_name: string | null;
  first_seen: number;
  last_visited: number;
  mastery_level: string;
  recommended_tier: string;
  total_requests: number;
  successful_requests: number;
}

function rowToSite(row: SiteRow): SiteManifest {
  return {
    id: row.id,
    displayName: row.display_name ?? undefined,
    firstSeen: row.first_seen,
    lastVisited: row.last_visited,
    masteryLevel: validateMasteryLevel(row.mastery_level),
    recommendedTier: validateExecutionTier(row.recommended_tier),
    totalRequests: row.total_requests,
    successfulRequests: row.successful_requests,
  };
}

export class SiteRepository {
  constructor(private db: AgentDatabase) {}

  create(site: SiteManifest): void {
    this.db.run(
      `INSERT OR IGNORE INTO sites (id, display_name, first_seen, last_visited, mastery_level, recommended_tier, total_requests, successful_requests)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      site.id,
      site.displayName ?? null,
      site.firstSeen,
      site.lastVisited,
      site.masteryLevel,
      site.recommendedTier,
      site.totalRequests,
      site.successfulRequests,
    );
  }

  getById(id: string): SiteManifest | undefined {
    const row = this.db.get<SiteRow>('SELECT * FROM sites WHERE id = ?', id);
    return row ? rowToSite(row) : undefined;
  }

  getAll(): SiteManifest[] {
    const rows = this.db.all<SiteRow>('SELECT * FROM sites ORDER BY last_visited DESC');
    return rows.map(rowToSite);
  }

  update(id: string, updates: Partial<Omit<SiteManifest, 'id'>>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.displayName !== undefined) {
      fields.push('display_name = ?');
      values.push(updates.displayName);
    }
    if (updates.firstSeen !== undefined) {
      fields.push('first_seen = ?');
      values.push(updates.firstSeen);
    }
    if (updates.lastVisited !== undefined) {
      fields.push('last_visited = ?');
      values.push(updates.lastVisited);
    }
    if (updates.masteryLevel !== undefined) {
      fields.push('mastery_level = ?');
      values.push(updates.masteryLevel);
    }
    if (updates.recommendedTier !== undefined) {
      fields.push('recommended_tier = ?');
      values.push(updates.recommendedTier);
    }
    if (updates.totalRequests !== undefined) {
      fields.push('total_requests = ?');
      values.push(updates.totalRequests);
    }
    if (updates.successfulRequests !== undefined) {
      fields.push('successful_requests = ?');
      values.push(updates.successfulRequests);
    }

    if (fields.length === 0) return;

    values.push(id);
    this.db.run(`UPDATE sites SET ${fields.join(', ')} WHERE id = ?`, ...values);
  }

  delete(id: string): void {
    this.db.run('DELETE FROM sites WHERE id = ?', id);
  }

  updateMetrics(id: string, success: boolean): void {
    if (success) {
      this.db.run(
        'UPDATE sites SET total_requests = total_requests + 1, successful_requests = successful_requests + 1, last_visited = ? WHERE id = ?',
        Date.now(),
        id,
      );
    } else {
      this.db.run(
        'UPDATE sites SET total_requests = total_requests + 1, last_visited = ? WHERE id = ?',
        Date.now(),
        id,
      );
    }
  }
}
