import { getLogger } from '../core/logger.js';
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
  CapabilityName,
  SkillParameter,
  SkillValidation,
  SkillRedactionInfo,
  ReplayStrategy,
} from '../skill/types.js';
import {
  SkillStatus,
  TierState,
  SideEffectClass,
} from '../skill/types.js';

// ─── Validators for union types from DB rows ──────────────────────
const VALID_SKILL_STATUSES: readonly string[] = Object.values(SkillStatus);
function validateSkillStatus(value: string): SkillStatusName {
  if (!VALID_SKILL_STATUSES.includes(value)) {
    throw new Error(`Invalid skill status from database: "${value}". Expected one of: ${VALID_SKILL_STATUSES.join(', ')}`);
  }
  return value as SkillStatusName;
}

const VALID_TIER_STATES: readonly string[] = Object.values(TierState);
function validateTierState(value: string): TierStateName {
  if (!VALID_TIER_STATES.includes(value)) {
    throw new Error(`Invalid tier state from database: "${value}". Expected one of: ${VALID_TIER_STATES.join(', ')}`);
  }
  return value as TierStateName;
}

const VALID_SIDE_EFFECT_CLASSES: readonly string[] = Object.values(SideEffectClass);
function validateSideEffectClass(value: string): SideEffectClassName {
  if (!VALID_SIDE_EFFECT_CLASSES.includes(value)) {
    throw new Error(`Invalid side effect class from database: "${value}". Expected one of: ${VALID_SIDE_EFFECT_CLASSES.join(', ')}`);
  }
  return value as SideEffectClassName;
}

const VALID_AUTH_TYPES = new Set(['bearer', 'cookie', 'api_key', 'oauth2']);
function validateAuthType(value: string): AuthType {
  if (!VALID_AUTH_TYPES.has(value)) {
    throw new Error(`Invalid auth type from database: "${value}". Expected one of: ${[...VALID_AUTH_TYPES].join(', ')}`);
  }
  return value as AuthType;
}

const VALID_REPLAY_STRATEGIES = new Set(['prefer_tier_1', 'prefer_tier_3', 'tier_3_only']);
function validateReplayStrategy(value: string): ReplayStrategy {
  if (!VALID_REPLAY_STRATEGIES.has(value)) {
    throw new Error(`Invalid replay strategy from database: "${value}". Expected one of: ${[...VALID_REPLAY_STRATEGIES].join(', ')}`);
  }
  return value as ReplayStrategy;
}

// ─── Shape assertions for JSON-parsed types ────────────────────────
function assertTierLockShape(value: unknown): TierLock {
  if (value === null) return null;
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Invalid TierLock shape: expected object or null, got ${typeof value}`);
  }
  const obj = value as Record<string, unknown>;
  if (obj.type === 'permanent') {
    if (typeof obj.reason !== 'string' || typeof obj.evidence !== 'string') {
      throw new Error('Invalid PermanentTierLock: missing required fields "reason" and "evidence"');
    }
    return obj as unknown as TierLock;
  }
  if (obj.type === 'temporary_demotion') {
    if (typeof obj.since !== 'string' || typeof obj.demotions !== 'number') {
      throw new Error('Invalid TemporaryDemotion: missing required fields "since" and "demotions"');
    }
    return obj as unknown as TierLock;
  }
  throw new Error(`Invalid TierLock: unknown type "${String(obj.type)}"`);
}

function assertParameterEvidenceArrayShape(value: unknown): ParameterEvidence[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ParameterEvidence[]: expected array, got ${typeof value}`);
  }
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (typeof item !== 'object' || item === null || typeof item.fieldPath !== 'string' || typeof item.classification !== 'string') {
      throw new Error(`Invalid ParameterEvidence at index ${i}: missing required fields "fieldPath" and "classification"`);
    }
  }
  return value as ParameterEvidence[];
}

function assertRequestChainShape(value: unknown): RequestChain {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Invalid RequestChain shape: expected object, got ${typeof value}`);
  }
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.steps) || typeof obj.canReplayWithCookiesOnly !== 'boolean') {
    throw new Error('Invalid RequestChain: missing required fields "steps" (array) and "canReplayWithCookiesOnly" (boolean)');
  }
  return value as RequestChain;
}

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
  allowed_domains: string;
  required_capabilities: string;
  parameters: string;
  validation: string;
  redaction: string;
  replay_strategy: string;
  avg_latency_ms: number | null;
  last_successful_tier: string | null;
  direct_canary_eligible: number;
  direct_canary_attempts: number;
  validations_since_last_canary: number;
  last_canary_error_type: string | null;
  review_required: number;
}

const log = getLogger();

function parseJson<T>(value: string | null, fallback: T, shapeValidator?: (parsed: unknown) => T): T {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    if (shapeValidator) {
      return shapeValidator(parsed);
    }
    return parsed as T;
  } catch (err) {
    log.warn({ value: value.slice(0, 100), err }, 'Failed to parse JSON from database column, using fallback');
    return fallback;
  }
}

function rowToSkill(row: SkillRow): SkillSpec {
  return {
    id: row.id,
    siteId: row.site_id,
    name: row.name,
    version: row.version,
    status: validateSkillStatus(row.status),
    description: row.description ?? undefined,
    method: row.method,
    pathTemplate: row.path_template,
    inputSchema: parseJson<Record<string, unknown>>(row.input_schema, {}),
    outputSchema: row.output_schema ? parseJson<Record<string, unknown>>(row.output_schema, {}) : undefined,
    authType: row.auth_type ? validateAuthType(row.auth_type) : undefined,
    requiredHeaders: row.required_headers ? parseJson<Record<string, string>>(row.required_headers, {}) : undefined,
    dynamicHeaders: row.dynamic_headers ? parseJson<Record<string, string>>(row.dynamic_headers, {}) : undefined,
    sideEffectClass: validateSideEffectClass(row.side_effect_class),
    isComposite: row.is_composite === 1,
    chainSpec: row.chain_spec ? parseJson<RequestChain>(row.chain_spec, undefined as unknown as RequestChain, assertRequestChainShape) : undefined,
    currentTier: validateTierState(row.current_tier),
    tierLock: parseJson<TierLock>(row.tier_lock, null, assertTierLockShape),
    confidence: row.confidence,
    consecutiveValidations: row.consecutive_validations,
    sampleCount: row.sample_count,
    parameterEvidence: row.parameter_evidence ? parseJson<ParameterEvidence[]>(row.parameter_evidence, [], assertParameterEvidenceArrayShape) : undefined,
    lastVerified: row.last_verified ?? undefined,
    lastUsed: row.last_used ?? undefined,
    successRate: row.success_rate,
    skillMd: row.skill_md ?? undefined,
    openApiFragment: row.openapi_fragment ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // NOTE: Fallback values on JSON parse failure have different security properties:
    // - allowedDomains: [] means no domains allowed (restrictive, safe default)
    // - validation: empty checks means no semantic/invariant validation will run (permissive)
    // - redaction: empty PII classes means no redaction applied (permissive, potential data leak)
    // If tightening is needed, consider failing loudly instead of falling back.
    allowedDomains: parseJson<string[]>(row.allowed_domains, []),
    requiredCapabilities: parseJson<CapabilityName[]>(row.required_capabilities, []),
    parameters: parseJson<SkillParameter[]>(row.parameters, []),
    validation: parseJson<SkillValidation>(row.validation, { semanticChecks: [], customInvariants: [] }),
    redaction: parseJson<SkillRedactionInfo>(row.redaction, { piiClassesFound: [], fieldsRedacted: 0 }),
    replayStrategy: validateReplayStrategy(row.replay_strategy ?? 'prefer_tier_3'),
    avgLatencyMs: row.avg_latency_ms ?? undefined,
    lastSuccessfulTier: row.last_successful_tier ?? undefined,
    directCanaryEligible: row.direct_canary_eligible === 1,
    directCanaryAttempts: row.direct_canary_attempts ?? 0,
    validationsSinceLastCanary: row.validations_since_last_canary ?? 0,
    lastCanaryErrorType: row.last_canary_error_type ?? undefined,
    reviewRequired: row.review_required === 1,
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
        created_at, updated_at,
        allowed_domains, required_capabilities, parameters, validation, redaction, replay_strategy,
        avg_latency_ms, last_successful_tier,
        direct_canary_eligible, direct_canary_attempts, validations_since_last_canary, last_canary_error_type,
        review_required
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      JSON.stringify(skill.allowedDomains ?? []),
      JSON.stringify(skill.requiredCapabilities ?? []),
      JSON.stringify(skill.parameters ?? []),
      JSON.stringify(skill.validation ?? { semanticChecks: [], customInvariants: [] }),
      JSON.stringify(skill.redaction ?? { piiClassesFound: [], fieldsRedacted: 0 }),
      skill.replayStrategy ?? 'prefer_tier_3',
      skill.avgLatencyMs ?? null,
      skill.lastSuccessfulTier ?? null,
      skill.directCanaryEligible ? 1 : 0,
      skill.directCanaryAttempts ?? 0,
      skill.validationsSinceLastCanary ?? 0,
      skill.lastCanaryErrorType ?? null,
      skill.reviewRequired ? 1 : 0,
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

  getByStatusAndSiteId(status: string, siteId: string): SkillSpec[] {
    const rows = this.db.all<SkillRow>(
      'SELECT * FROM skills WHERE site_id = ? AND status = ? ORDER BY name, version',
      siteId,
      status,
    );
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

  /** Return all skills across all statuses. */
  getAll(): SkillSpec[] {
    const rows = this.db.all<SkillRow>('SELECT * FROM skills ORDER BY updated_at DESC');
    return rows.map(rowToSkill);
  }

  update(id: string, updates: Partial<Omit<SkillSpec, 'id'>>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    // Direct-value columns: property name -> DB column name
    const directColumns: Array<[keyof typeof updates, string]> = [
      ['name', 'name'], ['version', 'version'], ['status', 'status'],
      ['description', 'description'], ['method', 'method'],
      ['pathTemplate', 'path_template'], ['authType', 'auth_type'],
      ['sideEffectClass', 'side_effect_class'], ['currentTier', 'current_tier'],
      ['confidence', 'confidence'], ['consecutiveValidations', 'consecutive_validations'],
      ['sampleCount', 'sample_count'], ['lastVerified', 'last_verified'],
      ['lastUsed', 'last_used'], ['successRate', 'success_rate'],
      ['skillMd', 'skill_md'], ['openApiFragment', 'openapi_fragment'],
      ['replayStrategy', 'replay_strategy'],
      ['avgLatencyMs', 'avg_latency_ms'],
      ['lastSuccessfulTier', 'last_successful_tier'],
      ['lastCanaryErrorType', 'last_canary_error_type'],
    ];

    // JSON-serialized columns
    const jsonColumns: Array<[keyof typeof updates, string]> = [
      ['inputSchema', 'input_schema'], ['outputSchema', 'output_schema'],
      ['requiredHeaders', 'required_headers'], ['dynamicHeaders', 'dynamic_headers'],
      ['chainSpec', 'chain_spec'], ['parameterEvidence', 'parameter_evidence'],
      ['allowedDomains', 'allowed_domains'], ['requiredCapabilities', 'required_capabilities'],
      ['parameters', 'parameters'], ['validation', 'validation'], ['redaction', 'redaction'],
    ];

    for (const [prop, col] of directColumns) {
      if (updates[prop] !== undefined) {
        fields.push(`${col} = ?`);
        values.push(updates[prop]);
      }
    }

    for (const [prop, col] of jsonColumns) {
      if (updates[prop] !== undefined) {
        fields.push(`${col} = ?`);
        values.push(JSON.stringify(updates[prop]));
      }
    }

    // Special cases with custom serialization
    if (updates.isComposite !== undefined) {
      fields.push('is_composite = ?');
      values.push(updates.isComposite ? 1 : 0);
    }
    if (updates.reviewRequired !== undefined) {
      fields.push('review_required = ?');
      values.push(updates.reviewRequired ? 1 : 0);
    }
    if (updates.tierLock !== undefined) {
      fields.push('tier_lock = ?');
      values.push(updates.tierLock ? JSON.stringify(updates.tierLock) : null);
    }
    if (updates.directCanaryEligible !== undefined) {
      fields.push('direct_canary_eligible = ?');
      values.push(updates.directCanaryEligible ? 1 : 0);
    }
    if (updates.directCanaryAttempts !== undefined) {
      fields.push('direct_canary_attempts = ?');
      values.push(updates.directCanaryAttempts);
    }
    if (updates.validationsSinceLastCanary !== undefined) {
      fields.push('validations_since_last_canary = ?');
      values.push(updates.validationsSinceLastCanary);
    }

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

  incrementValidationsSinceLastCanary(skillId: string): void {
    this.db.run('UPDATE skills SET validations_since_last_canary = validations_since_last_canary + 1 WHERE id = ?', skillId);
  }

  searchFts(query: string, opts?: { siteId?: string; limit?: number }): { skills: SkillSpec[]; matchType: 'fts' | 'like' } {
    try {
      // Try FTS5 first
      let sql = 'SELECT s.* FROM skills s JOIN skills_fts f ON s.id = f.skill_id WHERE skills_fts MATCH ?';
      const params: unknown[] = [query];

      if (opts?.siteId) {
        sql += ' AND s.site_id = ?';
        params.push(opts.siteId);
      }

      sql += ' ORDER BY rank';

      if (opts?.limit) {
        sql += ' LIMIT ?';
        params.push(opts.limit);
      }

      const rows = this.db.all<SkillRow>(sql, ...params);
      return { skills: rows.map(rowToSkill), matchType: 'fts' };
    } catch (err: unknown) {
      // Only fall back to LIKE for expected FTS failures (syntax errors, missing module).
      // Re-throw unexpected database errors (broken connection, schema regression, etc.).
      const msg = err instanceof Error ? err.message : '';
      const isFtsError = /fts5|MATCH|no such table.*skills_fts|syntax error|unterminated string|parse error|unknown special query/i.test(msg);
      if (!isFtsError) {
        log.warn({ err }, 'Unexpected FTS query error (not an FTS syntax/availability issue)');
        throw err;
      }
      // FTS5 not available or query syntax invalid — fall back to LIKE search
      // Strip FTS5 phrase delimiters (not meaningful in LIKE context)
      const cleanQuery = query.replace(/^"+|"+$/g, '');
      const escaped = cleanQuery.replace(/[%_\\]/g, '\\$&');
      const likePattern = `%${escaped}%`;
      let sql = "SELECT * FROM skills WHERE (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR path_template LIKE ? ESCAPE '\\')";
      const params: unknown[] = [likePattern, likePattern, likePattern];

      if (opts?.siteId) {
        sql += ' AND site_id = ?';
        params.push(opts.siteId);
      }

      if (opts?.limit) {
        sql += ' LIMIT ?';
        params.push(opts.limit);
      }

      const rows = this.db.all<SkillRow>(sql, ...params);
      return { skills: rows.map(rowToSkill), matchType: 'like' };
    }
  }

  delete(id: string): void {
    // Delete from dependent tables first (no FK cascade guarantee)
    this.db.run('DELETE FROM skill_amendments WHERE skill_id = ?', id);
    this.db.run('DELETE FROM skill_exemplars WHERE skill_id = ?', id);
    this.db.run('DELETE FROM skills WHERE id = ?', id);
  }
}
