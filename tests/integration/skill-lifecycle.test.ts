import { describe, it, expect } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHar, extractRequestResponse } from '../../src/capture/har-extractor.js';
import { filterRequests } from '../../src/capture/noise-filter.js';
import { clusterEndpoints } from '../../src/capture/api-extractor.js';
import { generateSkill, generateSkillMd } from '../../src/skill/generator.js';
import { validateSkill } from '../../src/skill/validator.js';
import { canPromote, promoteSkill, demoteSkill } from '../../src/core/promotion.js';
import type { SkillSpec, SchruteConfig, SealedFetchRequest, SealedFetchResponse } from '../../src/skill/types.js';
import { SkillStatus, SideEffectClass } from '../../src/skill/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const harDir = join(__dirname, '..', 'fixtures', 'har-files');

function makeConfig(overrides?: Partial<SchruteConfig>): SchruteConfig {
  return {
    dataDir: '/tmp/test-schrute-integration',
    logLevel: 'silent',
    features: { webmcp: false, httpTransport: false },
    toolBudget: {
      maxToolCallsPerTask: 50,
      maxConcurrentCalls: 3,
      crossDomainCalls: false,
      secretsToNonAllowlisted: false,
    },
    payloadLimits: {
      maxResponseBodyBytes: 10 * 1024 * 1024,
      maxRequestBodyBytes: 5 * 1024 * 1024,
      replayTimeoutMs: { tier1: 30000, tier3: 60000, tier4: 120000 },
      harCaptureMaxBodyBytes: 50 * 1024 * 1024,
      redactorTimeoutMs: 10000,
    },
    audit: { strictMode: true, rootHashExport: true },
    storage: { maxPerSiteMb: 500, maxGlobalMb: 5000, retentionDays: 90 },
    server: { network: false },
    tempTtlMs: 3600000,
    gcIntervalMs: 900000,
    confirmationTimeoutMs: 30000,
    confirmationExpiryMs: 60000,
    promotionConsecutivePasses: 2,
    promotionVolatilityThreshold: 0.2,
    maxToolsPerSite: 20,
    toolShortlistK: 10,
    ...overrides,
  } as SchruteConfig;
}

function mockFetch(responseBody: unknown, status = 200): (req: SealedFetchRequest) => Promise<SealedFetchResponse> {
  return async () => ({
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(responseBody),
  });
}

describe('skill lifecycle integration', () => {
  it('generates skills from extracted API patterns', () => {
    const har = parseHar(join(harDir, 'simple-rest-api.har'));
    const { signal } = filterRequests(har.log.entries);
    const records = signal.map(extractRequestResponse);
    const clusters = clusterEndpoints(records);

    expect(clusters.length).toBeGreaterThan(0);

    const getCluster = clusters.find(c => c.method === 'GET' && !c.pathTemplate.includes('{'));
    expect(getCluster).toBeDefined();

    const skill = generateSkill('api.example.com', {
      method: getCluster!.method,
      pathTemplate: getCluster!.pathTemplate,
      actionName: 'get_users',
      inputSchema: {},
      sampleCount: getCluster!.requests.length,
    });

    expect(skill.id).toContain('api_example_com');
    expect(skill.status).toBe(SkillStatus.DRAFT);
    expect(skill.siteId).toBe('api.example.com');
    expect(skill.method).toBe('GET');
  });

  it('generated skills start as draft', () => {
    const skill = generateSkill('test.com', {
      method: 'GET',
      pathTemplate: '/api/items',
      actionName: 'list_items',
      inputSchema: {},
      sampleCount: 3,
    });

    expect(skill.status).toBe('draft');
    expect(skill.consecutiveValidations).toBe(0);
    expect(skill.confidence).toBe(0);
    expect(skill.currentTier).toBe('tier_3');
  });

  it('validates a skill against a mock endpoint successfully', async () => {
    const skill = generateSkill('example.com', {
      method: 'GET',
      pathTemplate: '/api/items',
      actionName: 'list_items',
      inputSchema: {},
      sampleCount: 3,
    });

    const result = await validateSkill(skill, {}, {
      fetchFn: mockFetch([{ id: 1, name: 'item1' }]),
    });

    expect(result.success).toBe(true);
    expect(result.schemaMatch).toBe(true);
    expect(result.errorSignatures).toHaveLength(0);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('validation detects error signatures in response', async () => {
    const skill = generateSkill('example.com', {
      method: 'GET',
      pathTemplate: '/api/items',
      actionName: 'list_items',
      inputSchema: {},
      sampleCount: 3,
    });

    const result = await validateSkill(skill, {}, {
      fetchFn: mockFetch({ error: 'something went wrong' }),
    });

    expect(result.success).toBe(false);
    expect(result.errorSignatures).toContain('json_error_field');
  });

  it('rejects promotion for skill with insufficient recordings', () => {
    const config = makeConfig();
    const skill = generateSkill('example.com', {
      method: 'GET',
      pathTemplate: '/api/items',
      actionName: 'list_items',
      inputSchema: {},
      sampleCount: 1, // only 1 recording
    });

    const check = canPromote(skill, config);
    expect(check.eligible).toBe(false);
    expect(check.reason).toContain('minimum 2');
  });

  it('promotion gate: minimum 2 recordings and consecutive passes required', () => {
    const config = makeConfig({ promotionConsecutivePasses: 2 });

    // Skill with 2 recordings but 0 validations
    const skill = generateSkill('example.com', {
      method: 'GET',
      pathTemplate: '/api/items',
      actionName: 'list_items',
      inputSchema: {},
      sampleCount: 2,
    });

    // Initially not eligible (no consecutive validations)
    let check = canPromote(skill, config);
    expect(check.eligible).toBe(false);

    // Simulate passing validations
    skill.consecutiveValidations = 1;
    check = canPromote(skill, config);
    expect(check.eligible).toBe(false);

    skill.consecutiveValidations = 2;
    check = canPromote(skill, config);
    expect(check.eligible).toBe(true);
  });

  it('promotes draft skill to active after meeting criteria', () => {
    const config = makeConfig({ promotionConsecutivePasses: 2 });

    const skill = generateSkill('example.com', {
      method: 'GET',
      pathTemplate: '/api/items',
      actionName: 'list_items',
      inputSchema: {},
      sampleCount: 3,
    });

    // Meet all criteria
    skill.consecutiveValidations = 2;
    skill.sideEffectClass = 'read-only';

    const result = promoteSkill(skill, config);
    expect(result.previousStatus).toBe('draft');
    expect(result.newStatus).toBe('active');
    expect(result.skill.status).toBe('active');
    expect(result.skill.confidence).toBe(1.0);
  });

  it('full lifecycle: generate -> validate -> promote -> demote', async () => {
    const config = makeConfig({ promotionConsecutivePasses: 2 });

    // Step 1: Generate skill from HAR
    const har = parseHar(join(harDir, 'simple-rest-api.har'));
    const { signal } = filterRequests(har.log.entries);
    const records = signal.map(extractRequestResponse);
    const clusters = clusterEndpoints(records);

    const cluster = clusters[0];
    const skill = generateSkill('api.example.com', {
      method: cluster.method,
      pathTemplate: cluster.pathTemplate,
      actionName: 'get_users',
      inputSchema: {},
      sampleCount: cluster.requests.length,
    });
    expect(skill.status).toBe('draft');

    // Step 2: Validate twice
    for (let i = 0; i < 2; i++) {
      const result = await validateSkill(skill, {}, {
        fetchFn: mockFetch([{ id: 1, name: 'test' }]),
      });
      expect(result.success).toBe(true);
      skill.consecutiveValidations++;
    }

    // Step 3: Promote
    const promoted = promoteSkill(skill, config);
    expect(promoted.skill.status).toBe('active');

    // Step 4: Demote
    const demoted = demoteSkill(promoted.skill, 'schema drift detected');
    expect(demoted.skill.status).toBe('stale');
    expect(demoted.skill.consecutiveValidations).toBe(0);
  });

  it('generates SKILL.md from skill spec', () => {
    const skill = generateSkill('api.example.com', {
      method: 'GET',
      pathTemplate: '/api/users',
      actionName: 'get_users',
      description: 'Fetch all users',
      inputSchema: {},
      sampleCount: 3,
    });

    const md = generateSkillMd(skill);
    expect(md).toContain('---');
    expect(md).toContain('id:');
    expect(md).toContain('status: draft');
    expect(md).toContain('# get_users');
    expect(md).toContain('GET');
    expect(md).toContain('/api/users');
  });
});
