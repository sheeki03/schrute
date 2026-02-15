import type { AgentDatabase } from './database.js';
import type {
  SkillSpec,
  SkillStatusName,
  TierStateName,
  TierLock,
  SideEffectClassName,
  AuthType,
  RequestChain,
  ParameterEvidence,
} from '../skill/types.js';

interface SkillRow {
  id: string;
  site_id: string;
  name: string;
  version: number;
  status: string;
  description: string | null;
  method: string;
  path_template: string;
  input_schema: string | null;
  output_schema: string | null;
  auth_type: string | null;
  required_headers: string | null;
  dynamic_headers: string | null;
  side_effect_class: string;
  is_composite: number;
  chain_spec: string | null;
  current_tier: string;
  tier_lock: string | null;
  confidence: number;
  consecutive_validations: number;
  sample_count: number;
  parameter_evidence: string | null;
  last_verified: number | null;
  last_used: number | null;
  success_rate: number;
  skill_md: string | null;
  openapi_fragment: string | null;
  created_at: number;
  updated_at: number;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToSkill(row: SkillRow): SkillSpec {
  return {
    id: row.id,
    siteId: row.site_id,
    name: row.name,
    version: row.version,
    status: row.status as SkillStatusName,
    description: row.description ?? undefined,
    method: row.method,
    pathTemplate: row.path_template,
    inputSchema: parseJson<Record<string, unknown>>(row.input_schema, {}),
    outputSchema: row.output_schema ? parseJson<Record<string, unknown>>(row.output_schema, {}) : undefined,
    authType: (row.auth_type as AuthType) ?? undefined,
    requiredHeaders: row.required_headers ? parseJson<Record<string, string>>(row.required_headers, {}) : undefined,
    dynamicHeaders: row.dynamic_headers ? parseJson<Record<string, string>>(row.dynamic_headers, {}) : undefined,
    sideEffectClass: row.side_effect_class as SideEffectClassName,
    isComposite: row.is_composite === 1,
    chainSpec: row.chain_spec ? parseJson<RequestChain>(row.chain_spec, undefined as unknown as RequestChain) : undefined,
    currentTier: row.current_tier as TierStateName,
    tierLock: parseJson<TierLock>(row.tier_lock, null),
    confidence: row.confidence,
    consecutiveValidations: row.consecutive_validations,
    sampleCount: row.sample_count,
    parameterEvidence: row.parameter_evidence ? parseJson<ParameterEvidence[]>(row.parameter_evidence, []) : undefined,
    lastVerified: row.last_verified ?? undefined,
    lastUsed: row.last_used ?? undefined,
    successRate: row.success_rate,
    skillMd: row.skill_md ?? undefined,
    openApiFragment: row.openapi_fragment ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Defaults for fields not stored in DB
    allowedDomains: [],
    requiredCapabilities: [],
    parameters: [],
    validation: { semanticChecks: [], customInvariants: [] },
    redaction: { piiClassesFound: [], fieldsRedacted: 0 },
    replayStrategy: 'prefer_tier_3',
  };
}

export class SkillRepository {
  constructor(private db: AgentDatabase) {}

  create(skill: SkillSpec): void {
    this.db.run(
      `INSERT INTO skills (
        id, site_id, name, version, status, description, method, path_template,
        input_schema, output_schema, auth_type, required_headers, dynamic_headers,
        side_effect_class, is_composite, chain_spec, current_tier, tier_lock,
        confidence, consecutive_validations, sample_count, parameter_evidence,
        last_verified, last_used, success_rate, skill_md, openapi_fragment,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      skill.id,
      skill.siteId,
      skill.name,
      skill.version,
      skill.status,
      skill.description ?? null,
      skill.method,
      skill.pathTemplate,
      JSON.stringify(skill.inputSchema),
      skill.outputSchema ? JSON.stringify(skill.outputSchema) : null,
      skill.authType ?? null,
      skill.requiredHeaders ? JSON.stringify(skill.requiredHeaders) : null,
      skill.dynamicHeaders ? JSON.stringify(skill.dynamicHeaders) : null,
      skill.sideEffectClass,
      skill.isComposite ? 1 : 0,
      skill.chainSpec ? JSON.stringify(skill.chainSpec) : null,
      skill.currentTier,
      skill.tierLock ? JSON.stringify(skill.tierLock) : null,
      skill.confidence,
      skill.consecutiveValidations,
      skill.sampleCount,
      skill.parameterEvidence ? JSON.stringify(skill.parameterEvidence) : null,
      skill.lastVerified ?? null,
      skill.lastUsed ?? null,
      skill.successRate,
      skill.skillMd ?? null,
      skill.openApiFragment ?? null,
      skill.createdAt,
      skill.updatedAt,
    );
  }

  getById(id: string): SkillSpec | undefined {
    const row = this.db.get<SkillRow>('SELECT * FROM skills WHERE id = ?', id);
    return row ? rowToSkill(row) : undefined;
  }

  getBySiteId(siteId: string): SkillSpec[] {
    const rows = this.db.all<SkillRow>('SELECT * FROM skills WHERE site_id = ? ORDER BY name, version', siteId);
    return rows.map(rowToSkill);
  }

  getActive(siteId: string): SkillSpec[] {
    const rows = this.db.all<SkillRow>(
      "SELECT * FROM skills WHERE site_id = ? AND status = 'active' ORDER BY name",
      siteId,
    );
    return rows.map(rowToSkill);
  }

  getByStatus(status: SkillStatusName): SkillSpec[] {
    const rows = this.db.all<SkillRow>('SELECT * FROM skills WHERE status = ? ORDER BY updated_at DESC', status);
    return rows.map(rowToSkill);
  }

  update(id: string, updates: Partial<Omit<SkillSpec, 'id'>>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
    if (updates.version !== undefined) { fields.push('version = ?'); values.push(updates.version); }
    if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
    if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
    if (updates.method !== undefined) { fields.push('method = ?'); values.push(updates.method); }
    if (updates.pathTemplate !== undefined) { fields.push('path_template = ?'); values.push(updates.pathTemplate); }
    if (updates.inputSchema !== undefined) { fields.push('input_schema = ?'); values.push(JSON.stringify(updates.inputSchema)); }
    if (updates.outputSchema !== undefined) { fields.push('output_schema = ?'); values.push(JSON.stringify(updates.outputSchema)); }
    if (updates.authType !== undefined) { fields.push('auth_type = ?'); values.push(updates.authType); }
    if (updates.requiredHeaders !== undefined) { fields.push('required_headers = ?'); values.push(JSON.stringify(updates.requiredHeaders)); }
    if (updates.dynamicHeaders !== undefined) { fields.push('dynamic_headers = ?'); values.push(JSON.stringify(updates.dynamicHeaders)); }
    if (updates.sideEffectClass !== undefined) { fields.push('side_effect_class = ?'); values.push(updates.sideEffectClass); }
    if (updates.isComposite !== undefined) { fields.push('is_composite = ?'); values.push(updates.isComposite ? 1 : 0); }
    if (updates.chainSpec !== undefined) { fields.push('chain_spec = ?'); values.push(JSON.stringify(updates.chainSpec)); }
    if (updates.currentTier !== undefined) { fields.push('current_tier = ?'); values.push(updates.currentTier); }
    if (updates.tierLock !== undefined) { fields.push('tier_lock = ?'); values.push(updates.tierLock ? JSON.stringify(updates.tierLock) : null); }
    if (updates.confidence !== undefined) { fields.push('confidence = ?'); values.push(updates.confidence); }
    if (updates.consecutiveValidations !== undefined) { fields.push('consecutive_validations = ?'); values.push(updates.consecutiveValidations); }
    if (updates.sampleCount !== undefined) { fields.push('sample_count = ?'); values.push(updates.sampleCount); }
    if (updates.parameterEvidence !== undefined) { fields.push('parameter_evidence = ?'); values.push(JSON.stringify(updates.parameterEvidence)); }
    if (updates.lastVerified !== undefined) { fields.push('last_verified = ?'); values.push(updates.lastVerified); }
    if (updates.lastUsed !== undefined) { fields.push('last_used = ?'); values.push(updates.lastUsed); }
    if (updates.successRate !== undefined) { fields.push('success_rate = ?'); values.push(updates.successRate); }
    if (updates.skillMd !== undefined) { fields.push('skill_md = ?'); values.push(updates.skillMd); }
    if (updates.openApiFragment !== undefined) { fields.push('openapi_fragment = ?'); values.push(updates.openApiFragment); }

    if (fields.length === 0) return;

    fields.push('updated_at = ?');
    values.push(Date.now());
    values.push(id);

    this.db.run(`UPDATE skills SET ${fields.join(', ')} WHERE id = ?`, ...values);
  }

  updateTier(id: string, tier: TierStateName, tierLock?: TierLock): void {
    this.db.run(
      'UPDATE skills SET current_tier = ?, tier_lock = ?, updated_at = ? WHERE id = ?',
      tier,
      tierLock ? JSON.stringify(tierLock) : null,
      Date.now(),
      id,
    );
  }

  updateConfidence(id: string, confidence: number, consecutiveValidations: number): void {
    this.db.run(
      'UPDATE skills SET confidence = ?, consecutive_validations = ?, updated_at = ? WHERE id = ?',
      confidence,
      consecutiveValidations,
      Date.now(),
      id,
    );
  }

  delete(id: string): void {
    this.db.run('DELETE FROM skills WHERE id = ?', id);
  }
}
