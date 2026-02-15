import type {
  SkillSpec,
  SkillParameter,
  AuthRecipe,
  ParameterEvidence,
  RequestChain,
  SideEffectClassName,
  SkillStatusName,
  TierStateName,
  CapabilityName,
  EvidenceReport,
} from './types.js';
import {
  SkillStatus,
  TierState,
  Capability,
  SideEffectClass,
} from './types.js';
import { classifySideEffect } from './side-effects.js';

// ─── Types ──────────────────────────────────────────────────────

export interface ClusterInfo {
  method: string;
  pathTemplate: string;
  actionName: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  requiredHeaders?: Record<string, string>;
  dynamicHeaders?: Record<string, string>;
  sampleCount: number;
  isGraphQL?: boolean;
  graphqlOperationName?: string;
  requestBody?: string;
}

// ─── Skill Generation ───────────────────────────────────────────

export function generateSkill(
  siteId: string,
  cluster: ClusterInfo,
  authRecipe?: AuthRecipe,
  paramEvidence?: ParameterEvidence[],
  chain?: RequestChain,
): SkillSpec {
  const actionName = cluster.actionName;
  const version = 1;
  const id = buildSkillId(siteId, actionName, version, cluster.isGraphQL, cluster.graphqlOperationName);

  const sideEffectClass = classifySideEffect(
    cluster.method,
    cluster.pathTemplate,
    undefined,
    cluster.requestBody,
  );

  const parameters = buildParameters(paramEvidence);
  const allowedDomains = [siteId];
  const requiredCapabilities = buildRequiredCapabilities(authRecipe);

  const now = Date.now();

  const spec: SkillSpec = {
    id,
    version,
    status: SkillStatus.DRAFT as SkillStatusName,
    currentTier: TierState.TIER_3_DEFAULT as TierStateName,
    tierLock: null,
    allowedDomains,
    requiredCapabilities,
    parameters,
    validation: {
      semanticChecks: ['schema_match', 'no_error_signatures'],
      customInvariants: [],
    },
    redaction: {
      piiClassesFound: [],
      fieldsRedacted: 0,
    },
    replayStrategy: 'prefer_tier_3',
    sideEffectClass,
    sampleCount: cluster.sampleCount,
    consecutiveValidations: 0,
    confidence: 0,

    method: cluster.method,
    pathTemplate: cluster.pathTemplate,
    inputSchema: cluster.inputSchema,
    outputSchema: cluster.outputSchema,
    authType: authRecipe?.type,
    requiredHeaders: cluster.requiredHeaders,
    dynamicHeaders: cluster.dynamicHeaders,
    isComposite: chain != null && chain.steps.length > 1,
    chainSpec: chain,
    parameterEvidence: paramEvidence,

    siteId,
    name: actionName,
    description: cluster.description,
    successRate: 0,
    createdAt: now,
    updatedAt: now,
  };

  return spec;
}

// ─── SKILL.md Generation ────────────────────────────────────────

export function generateSkillMd(spec: SkillSpec): string {
  const frontmatter = buildFrontmatter(spec);
  const body = buildMarkdownBody(spec);
  return `---\n${frontmatter}---\n\n${body}`;
}

function buildFrontmatter(spec: SkillSpec): string {
  const lines: string[] = [];

  lines.push(`id: ${spec.id}`);
  lines.push(`version: ${spec.version}`);
  lines.push(`status: ${spec.status}`);
  lines.push(`current_tier: ${spec.currentTier}`);
  lines.push(`tier_lock: ${spec.tierLock ? JSON.stringify(spec.tierLock) : 'null'}`);
  lines.push(`allowed_domains:`);
  for (const d of spec.allowedDomains) {
    lines.push(`  - ${d}`);
  }
  lines.push(`required_capabilities:`);
  for (const c of spec.requiredCapabilities) {
    lines.push(`  - ${c}`);
  }

  // Parameters
  lines.push(`parameters:`);
  for (const p of spec.parameters) {
    lines.push(`  - name: ${p.name}`);
    lines.push(`    type: ${p.type}`);
    lines.push(`    source: ${p.source}`);
    lines.push(`    evidence:`);
    for (const e of p.evidence) {
      lines.push(`      - ${JSON.stringify(e)}`);
    }
  }

  // Validation
  lines.push(`validation:`);
  lines.push(`  semantic_checks:`);
  for (const sc of spec.validation.semanticChecks) {
    lines.push(`    - ${sc}`);
  }
  lines.push(`  custom_invariants:`);
  for (const ci of spec.validation.customInvariants) {
    lines.push(`    - ${ci}`);
  }

  // Redaction
  lines.push(`redaction:`);
  lines.push(`  pii_classes_found:`);
  for (const p of spec.redaction.piiClassesFound) {
    lines.push(`    - ${p}`);
  }
  lines.push(`  fields_redacted: ${spec.redaction.fieldsRedacted}`);

  lines.push(`replay_strategy: ${spec.replayStrategy}`);
  lines.push(`side_effect_class: ${spec.sideEffectClass}`);
  lines.push(`sample_count: ${spec.sampleCount}`);
  lines.push(`consecutive_validations: ${spec.consecutiveValidations}`);
  lines.push(`confidence: ${spec.confidence}`);

  return lines.join('\n') + '\n';
}

function buildMarkdownBody(spec: SkillSpec): string {
  const sections: string[] = [];

  sections.push(`# ${spec.name}`);
  if (spec.description) {
    sections.push(`\n${spec.description}`);
  }

  sections.push(`\n## Endpoint\n`);
  sections.push(`- **Method**: \`${spec.method}\``);
  sections.push(`- **Path**: \`${spec.pathTemplate}\``);
  if (spec.authType) {
    sections.push(`- **Auth**: \`${spec.authType}\``);
  }

  if (spec.parameters.length > 0) {
    sections.push(`\n## Parameters\n`);
    sections.push(`| Name | Type | Source |`);
    sections.push(`|------|------|--------|`);
    for (const p of spec.parameters) {
      sections.push(`| ${p.name} | ${p.type} | ${p.source} |`);
    }
  }

  if (spec.inputSchema && Object.keys(spec.inputSchema).length > 0) {
    sections.push(`\n## Input Schema\n`);
    sections.push('```json');
    sections.push(JSON.stringify(spec.inputSchema, null, 2));
    sections.push('```');
  }

  return sections.join('\n');
}

// ─── OpenAPI Fragment ───────────────────────────────────────────

export function generateOpenApiFragment(spec: SkillSpec): Record<string, unknown> {
  const pathKey = spec.pathTemplate;
  const methodKey = spec.method.toLowerCase();

  const operation: Record<string, unknown> = {
    operationId: spec.id,
    summary: spec.description ?? spec.name,
    tags: [spec.siteId],
  };

  // Request body for POST/PUT/PATCH
  if (['post', 'put', 'patch'].includes(methodKey)) {
    operation.requestBody = {
      required: true,
      content: {
        'application/json': {
          schema: spec.inputSchema,
        },
      },
    };
  }

  // Parameters from path template
  const pathParams = extractPathParams(spec.pathTemplate);
  if (pathParams.length > 0 || methodKey === 'get') {
    const params: Record<string, unknown>[] = [];

    for (const pp of pathParams) {
      params.push({
        name: pp,
        in: 'path',
        required: true,
        schema: { type: 'string' },
      });
    }

    // Query params for GET from input schema
    if (methodKey === 'get' && spec.inputSchema) {
      const properties = (spec.inputSchema as Record<string, unknown>).properties as Record<string, unknown> | undefined;
      if (properties) {
        for (const [name, schema] of Object.entries(properties)) {
          params.push({
            name,
            in: 'query',
            schema,
          });
        }
      }
    }

    if (params.length > 0) {
      operation.parameters = params;
    }
  }

  // Response
  operation.responses = {
    '200': {
      description: 'Successful response',
      content: spec.outputSchema
        ? {
            'application/json': {
              schema: spec.outputSchema,
            },
          }
        : undefined,
    },
  };

  // Security
  if (spec.authType) {
    operation.security = [{ [spec.authType]: [] }];
  }

  return {
    openapi: '3.1.0',
    info: {
      title: `${spec.siteId} - ${spec.name}`,
      version: `${spec.version}`,
    },
    paths: {
      [pathKey]: {
        [methodKey]: operation,
      },
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────

function buildSkillId(
  siteId: string,
  actionName: string,
  version: number,
  isGraphQL?: boolean,
  operationName?: string,
): string {
  const safeSiteId = siteId.replace(/\./g, '_');

  if (isGraphQL && operationName) {
    return `${safeSiteId}.gql.${operationName}.v${version}`;
  }

  const safeAction = actionName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
  return `${safeSiteId}.${safeAction}.v${version}`;
}

function buildParameters(paramEvidence?: ParameterEvidence[]): SkillParameter[] {
  if (!paramEvidence) return [];

  return paramEvidence
    .filter((pe) => pe.classification === 'parameter')
    .map((pe) => ({
      name: pe.fieldPath,
      type: inferType(pe.observedValues),
      source: pe.correlatesWithInput ? 'user_input' as const : 'extracted' as const,
      evidence: pe.observedValues.slice(0, 3), // keep first 3 as evidence
    }));
}

function inferType(values: string[]): string {
  if (values.length === 0) return 'string';

  const allNumbers = values.every((v) => !isNaN(Number(v)) && v.trim() !== '');
  if (allNumbers) return 'number';

  const allBooleans = values.every((v) => v === 'true' || v === 'false');
  if (allBooleans) return 'boolean';

  return 'string';
}

function buildRequiredCapabilities(authRecipe?: AuthRecipe): CapabilityName[] {
  const caps: CapabilityName[] = [Capability.NET_FETCH_DIRECT];

  if (authRecipe) {
    caps.push(Capability.SECRETS_USE);
  }

  return caps;
}

function extractPathParams(template: string): string[] {
  const matches = template.match(/\{(\w+)\}/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(1, -1));
}

// ─── Evidence Report Generation ─────────────────────────────────

/**
 * Generate an evidence report for a skill, aggregating PII redaction counts
 * from the skill's redaction metadata and an optional list of all skills
 * on the same site for cross-skill aggregation.
 */
export function generateEvidenceReport(
  skill: SkillSpec,
  validationHistory: EvidenceReport['validationHistory'],
  policyRule: string,
  siteSkills?: SkillSpec[],
): EvidenceReport {
  // Aggregate piiRedactionCounts across supplied skills (or just the single skill)
  const skills = siteSkills ?? [skill];
  const piiRedactionCounts: Record<string, number> = {};

  for (const s of skills) {
    if (s.redaction.piiClassesFound.length > 0) {
      for (const piiClass of s.redaction.piiClassesFound) {
        piiRedactionCounts[piiClass] = (piiRedactionCounts[piiClass] ?? 0) + s.redaction.fieldsRedacted;
      }
    }
  }

  return {
    skillId: skill.id,
    tierEligibility: {
      currentTier: skill.currentTier,
      tierLock: skill.tierLock,
      volatilityScores: [],
    },
    parameterEvidence: skill.parameterEvidence ?? [],
    requestChain: skill.chainSpec,
    policyRule,
    redactionsApplied: {
      piiClassesFound: skill.redaction.piiClassesFound,
      fieldsRedacted: skill.redaction.fieldsRedacted,
    },
    piiRedactionCounts,
    validationHistory,
  };
}
