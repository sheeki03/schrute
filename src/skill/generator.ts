import { extractPathParams } from '../core/utils.js';
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

// ─── Action Name Generation ─────────────────────────────────────

export function generateActionName(method: string, pathTemplate: string): string {
  // Strip /api/ and /v{N}/ prefixes
  let path = pathTemplate.replace(/^\/api\//, '/').replace(/^\/v\d+\//, '/');

  // Remove path params like {id}
  path = path.replace(/\{[^}]+\}/g, '');

  // Get last meaningful segment
  const segments = path.split('/').filter(Boolean);
  const lastSegment = segments[segments.length - 1] || segments[segments.length - 2] || 'action';

  // Clean up
  const cleanName = lastSegment.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').toLowerCase();

  // Map HTTP methods to verb prefixes
  const verbMap: Record<string, string> = {
    'GET': 'get',
    'POST': 'create',
    'PUT': 'update',
    'PATCH': 'update',
    'DELETE': 'delete',
    'HEAD': 'get',
    'OPTIONS': 'get',
  };

  const prefix = verbMap[method.toUpperCase()] || method.toLowerCase();
  return `${prefix}_${cleanName}`;
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

// ─── Evidence Report Generation ─────────────────────────────────

/**
 * Generate an evidence report for a skill, aggregating PII redaction counts
 * from the skill's redaction metadata and an optional list of all skills
 * on the same site for cross-skill aggregation.
 */
// ─── Skill References & Templates ───────────────────────────────

export function generateSkillReferences(
  spec: SkillSpec,
  sampleRequests?: Array<{ status: number; method: string; url: string }>,
): Map<string, string> {
  const refs = new Map<string, string>();

  // api-reference.md
  const apiRef: string[] = [];
  apiRef.push(`# API Reference: ${spec.name}\n`);
  apiRef.push(`## Endpoint\n`);
  apiRef.push(`- **Method**: \`${spec.method}\``);
  apiRef.push(`- **Path**: \`${spec.pathTemplate}\``);
  apiRef.push(`- **Site**: \`${spec.siteId}\``);
  if (spec.authType) apiRef.push(`- **Auth**: \`${spec.authType}\``);
  apiRef.push('');

  if (spec.parameters.length > 0) {
    apiRef.push('## Parameters\n');
    apiRef.push('| Name | Type | Source |');
    apiRef.push('|------|------|--------|');
    for (const p of spec.parameters) {
      apiRef.push(`| ${p.name} | ${p.type} | ${p.source} |`);
    }
    apiRef.push('');
  }

  if (spec.inputSchema && Object.keys(spec.inputSchema).length > 0) {
    apiRef.push('## Input Schema\n');
    apiRef.push('```json');
    apiRef.push(JSON.stringify(spec.inputSchema, null, 2));
    apiRef.push('```\n');
  }

  if (spec.outputSchema && Object.keys(spec.outputSchema).length > 0) {
    apiRef.push('## Output Schema\n');
    apiRef.push('```json');
    apiRef.push(JSON.stringify(spec.outputSchema, null, 2));
    apiRef.push('```\n');
  }
  refs.set('api-reference.md', apiRef.join('\n'));

  // task-patterns.md
  const patterns: string[] = [];
  patterns.push(`# Task Patterns: ${spec.name}\n`);
  if (sampleRequests && sampleRequests.length > 0) {
    patterns.push('## Response Status Distribution\n');
    const statusCounts = new Map<number, number>();
    for (const r of sampleRequests) {
      statusCounts.set(r.status, (statusCounts.get(r.status) ?? 0) + 1);
    }
    for (const [status, count] of statusCounts) {
      patterns.push(`- HTTP ${status}: ${count} request(s)`);
    }
    patterns.push('');
  }
  patterns.push('## Usage Patterns\n');
  patterns.push(`- Side Effect: \`${spec.sideEffectClass}\``);
  patterns.push(`- Replay Strategy: \`${spec.replayStrategy}\``);
  patterns.push(`- Confidence: ${spec.confidence}`);
  refs.set('task-patterns.md', patterns.join('\n'));

  // error-handling.md
  const errors: string[] = [];
  errors.push(`# Error Handling: ${spec.name}\n`);
  if (spec.authType) {
    errors.push(`## Auth Type: \`${spec.authType}\`\n`);
    switch (spec.authType) {
      case 'bearer':
        errors.push('- On 401: Token may be expired. Check for token refresh flow.');
        errors.push('- On 403: Insufficient permissions for this endpoint.');
        break;
      case 'cookie':
        errors.push('- On 401/403: Session cookie may be expired. Re-login via browser.');
        break;
      case 'api_key':
        errors.push('- On 401: API key may be invalid or revoked.');
        break;
      case 'oauth2':
        errors.push('- On 401: Access token expired. Use refresh token flow.');
        break;
    }
  } else {
    errors.push('No authentication configured for this skill.');
  }
  refs.set('error-handling.md', errors.join('\n'));

  return refs;
}

export function generateSkillTemplates(spec: SkillSpec): Map<string, string> {
  const templates = new Map<string, string>();

  // request.json
  const requestTemplate: Record<string, unknown> = {};
  if (spec.inputSchema) {
    const props = (spec.inputSchema as Record<string, unknown>).properties as Record<string, Record<string, unknown>> | undefined;
    if (props) {
      for (const [name, schema] of Object.entries(props)) {
        const type = schema.type as string;
        switch (type) {
          case 'string': requestTemplate[name] = ''; break;
          case 'number': requestTemplate[name] = 0; break;
          case 'boolean': requestTemplate[name] = false; break;
          case 'array': requestTemplate[name] = []; break;
          case 'object': requestTemplate[name] = {}; break;
          default: requestTemplate[name] = null;
        }
      }
    }
  }
  templates.set('request.json', JSON.stringify(requestTemplate, null, 2));

  // curl.sh
  const curlLines: string[] = ['#!/bin/bash'];
  const method = spec.method.toUpperCase();
  curlLines.push(`curl -X ${method} \\`);

  if (spec.requiredHeaders) {
    for (const [key, value] of Object.entries(spec.requiredHeaders)) {
      curlLines.push(`  -H '${key}: ${value}' \\`);
    }
  }
  if (spec.authType === 'bearer') {
    curlLines.push(`  -H 'Authorization: Bearer YOUR_TOKEN' \\`);
  }

  if (['POST', 'PUT', 'PATCH'].includes(method)) {
    curlLines.push(`  -H 'Content-Type: application/json' \\`);
    curlLines.push(`  -d '${JSON.stringify(requestTemplate)}' \\`);
  }

  curlLines.push(`  'https://${spec.siteId}${spec.pathTemplate}'`);
  templates.set('curl.sh', curlLines.join('\n'));

  return templates;
}

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
