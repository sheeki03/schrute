import type { AgentDatabase } from './database.js';
import type { AuthType, AuthRecipe } from '../skill/types.js';

const VALID_AUTH_TYPES = new Set(['bearer', 'cookie', 'api_key', 'oauth2']);
function validateAuthType(value: string): AuthType {
  if (!VALID_AUTH_TYPES.has(value)) {
    throw new Error(`Invalid auth type from database: "${value}". Expected one of: ${[...VALID_AUTH_TYPES].join(', ')}`);
  }
  return value as AuthType;
}

export interface AuthFlow {
  id: string;
  siteId: string;
  type: AuthType;
  recipe: AuthRecipe | null;
  tokenKeychainRef: string | null;
  tokenExpiresAt: number | null;
  lastRefreshed: number | null;
}

interface AuthFlowRow {
  id: string;
  site_id: string;
  type: string;
  recipe: string | null;
  token_keychain_ref: string | null;
  token_expires_at: number | null;
  last_refreshed: number | null;
}

function rowToAuthFlow(row: AuthFlowRow): AuthFlow {
  return {
    id: row.id,
    siteId: row.site_id,
    type: validateAuthType(row.type),
    recipe: row.recipe ? JSON.parse(row.recipe) as AuthRecipe : null,
    tokenKeychainRef: row.token_keychain_ref,
    tokenExpiresAt: row.token_expires_at,
    lastRefreshed: row.last_refreshed,
  };
}

export class AuthRepository {
  constructor(private db: AgentDatabase) {}

  create(flow: AuthFlow): void {
    this.db.run(
      `INSERT INTO auth_flows (id, site_id, type, recipe, token_keychain_ref, token_expires_at, last_refreshed)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      flow.id,
      flow.siteId,
      flow.type,
      flow.recipe ? JSON.stringify(flow.recipe) : null,
      flow.tokenKeychainRef ?? null,
      flow.tokenExpiresAt ?? null,
      flow.lastRefreshed ?? null,
    );
  }

  getById(id: string): AuthFlow | undefined {
    const row = this.db.get<AuthFlowRow>('SELECT * FROM auth_flows WHERE id = ?', id);
    return row ? rowToAuthFlow(row) : undefined;
  }

  getBySiteId(siteId: string): AuthFlow[] {
    const rows = this.db.all<AuthFlowRow>('SELECT * FROM auth_flows WHERE site_id = ?', siteId);
    return rows.map(rowToAuthFlow);
  }

  update(id: string, updates: Partial<Omit<AuthFlow, 'id'>>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.siteId !== undefined) { fields.push('site_id = ?'); values.push(updates.siteId); }
    if (updates.type !== undefined) { fields.push('type = ?'); values.push(updates.type); }
    if (updates.recipe !== undefined) { fields.push('recipe = ?'); values.push(updates.recipe ? JSON.stringify(updates.recipe) : null); }
    if (updates.tokenKeychainRef !== undefined) { fields.push('token_keychain_ref = ?'); values.push(updates.tokenKeychainRef); }
    if (updates.tokenExpiresAt !== undefined) { fields.push('token_expires_at = ?'); values.push(updates.tokenExpiresAt); }
    if (updates.lastRefreshed !== undefined) { fields.push('last_refreshed = ?'); values.push(updates.lastRefreshed); }

    if (fields.length === 0) return;

    values.push(id);
    this.db.run(`UPDATE auth_flows SET ${fields.join(', ')} WHERE id = ?`, ...values);
  }

  delete(id: string): void {
    this.db.run('DELETE FROM auth_flows WHERE id = ?', id);
  }
}
