import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { generateSkillReferences, generateSkillTemplates } from '../../src/skill/generator.js';
import type { SkillSpec } from '../../src/skill/types.js';

function makeSkill(overrides: Partial<SkillSpec> = {}): SkillSpec {
  return {
    id: 'example_com.get_users.v1',
    version: 1,
    name: 'get_users',
    siteId: 'example.com',
    method: 'GET',
    pathTemplate: '/api/users',
    description: 'Fetch user list',
    status: 'active',
    currentTier: 'tier_1',
    tierLock: null,
    sideEffectClass: 'read_only',
    confidence: 0.9,
    successRate: 0.95,
    sampleCount: 10,
    authType: 'bearer',
    requiredHeaders: { 'Accept': 'application/json' },
    dynamicHeaders: {},
    parameters: [
      { name: 'page', type: 'number', source: 'user_input', evidence: ['1', '2'] },
      { name: 'limit', type: 'number', source: 'extracted', evidence: ['10'] },
    ],
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'number' },
        limit: { type: 'number' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        users: { type: 'array' },
      },
    },
    replayStrategy: 'direct_fetch',
    requiredCapabilities: ['net_fetch_direct'],
    allowedDomains: ['example.com'],
    validation: { semanticChecks: [], customInvariants: [] },
    redaction: { piiClassesFound: [], fieldsRedacted: 0 },
    createdAt: Date.now(),
    lastVerified: null,
    lastUsed: null,
    ...overrides,
  } as SkillSpec;
}

describe('Skill Documentation', () => {
  describe('generateSkillReferences', () => {
    it('produces api-reference.md with endpoint details', () => {
      const spec = makeSkill();
      const refs = generateSkillReferences(spec);

      expect(refs.has('api-reference.md')).toBe(true);
      const apiRef = refs.get('api-reference.md')!;
      expect(apiRef).toContain('# API Reference: get_users');
      expect(apiRef).toContain('`GET`');
      expect(apiRef).toContain('`/api/users`');
      expect(apiRef).toContain('`example.com`');
      expect(apiRef).toContain('`bearer`');
    });

    it('includes parameters table', () => {
      const spec = makeSkill();
      const refs = generateSkillReferences(spec);
      const apiRef = refs.get('api-reference.md')!;

      expect(apiRef).toContain('| page | number | user_input |');
      expect(apiRef).toContain('| limit | number | extracted |');
    });

    it('includes input and output schemas', () => {
      const spec = makeSkill();
      const refs = generateSkillReferences(spec);
      const apiRef = refs.get('api-reference.md')!;

      expect(apiRef).toContain('## Input Schema');
      expect(apiRef).toContain('## Output Schema');
      expect(apiRef).toContain('"page"');
    });

    it('produces task-patterns.md', () => {
      const spec = makeSkill();
      const refs = generateSkillReferences(spec);

      expect(refs.has('task-patterns.md')).toBe(true);
      const patterns = refs.get('task-patterns.md')!;
      expect(patterns).toContain('# Task Patterns: get_users');
      expect(patterns).toContain('`read_only`');
      expect(patterns).toContain('`direct_fetch`');
    });

    it('includes response status distribution with sampleRequests', () => {
      const spec = makeSkill();
      const refs = generateSkillReferences(spec, [
        { status: 200, method: 'GET', url: '/api/users' },
        { status: 200, method: 'GET', url: '/api/users?page=2' },
        { status: 404, method: 'GET', url: '/api/users?page=999' },
      ]);

      const patterns = refs.get('task-patterns.md')!;
      expect(patterns).toContain('HTTP 200: 2 request(s)');
      expect(patterns).toContain('HTTP 404: 1 request(s)');
    });

    it('produces error-handling.md with auth guidance', () => {
      const spec = makeSkill();
      const refs = generateSkillReferences(spec);

      expect(refs.has('error-handling.md')).toBe(true);
      const errors = refs.get('error-handling.md')!;
      expect(errors).toContain('# Error Handling: get_users');
      expect(errors).toContain('`bearer`');
      expect(errors).toContain('401');
    });

    it('handles skill without auth', () => {
      const spec = makeSkill({ authType: undefined });
      const refs = generateSkillReferences(spec);
      const errors = refs.get('error-handling.md')!;
      expect(errors).toContain('No authentication configured');
    });

    it('generates all three reference files', () => {
      const spec = makeSkill();
      const refs = generateSkillReferences(spec);
      expect(refs.size).toBe(3);
      expect([...refs.keys()]).toEqual(['api-reference.md', 'task-patterns.md', 'error-handling.md']);
    });
  });

  describe('generateSkillTemplates', () => {
    it('produces request.json with correct parameter defaults', () => {
      const spec = makeSkill();
      const templates = generateSkillTemplates(spec);

      expect(templates.has('request.json')).toBe(true);
      const requestJson = JSON.parse(templates.get('request.json')!);
      expect(requestJson.page).toBe(0);
      expect(requestJson.limit).toBe(0);
    });

    it('produces curl.sh with correct method and path', () => {
      const spec = makeSkill();
      const templates = generateSkillTemplates(spec);

      expect(templates.has('curl.sh')).toBe(true);
      const curl = templates.get('curl.sh')!;
      expect(curl).toContain('curl -X GET');
      expect(curl).toContain("'Accept: application/json'");
      expect(curl).toContain("'Authorization: Bearer YOUR_TOKEN'");
      expect(curl).toContain("'https://example.com/api/users'");
    });

    it('includes Content-Type and body for POST', () => {
      const spec = makeSkill({ method: 'POST' });
      const templates = generateSkillTemplates(spec);
      const curl = templates.get('curl.sh')!;
      expect(curl).toContain('curl -X POST');
      expect(curl).toContain("'Content-Type: application/json'");
      expect(curl).toContain('-d');
    });

    it('handles skill with no input schema', () => {
      const spec = makeSkill({ inputSchema: {} });
      const templates = generateSkillTemplates(spec);
      const requestJson = JSON.parse(templates.get('request.json')!);
      expect(requestJson).toEqual({});
    });

    it('handles different property types', () => {
      const spec = makeSkill({
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            count: { type: 'number' },
            active: { type: 'boolean' },
            tags: { type: 'array' },
            meta: { type: 'object' },
          },
        },
      });
      const templates = generateSkillTemplates(spec);
      const requestJson = JSON.parse(templates.get('request.json')!);
      expect(requestJson.name).toBe('');
      expect(requestJson.count).toBe(0);
      expect(requestJson.active).toBe(false);
      expect(requestJson.tags).toEqual([]);
      expect(requestJson.meta).toEqual({});
    });
  });

  describe('URI resolution', () => {
    it('same skillId on different sites produces different references', () => {
      const specA = makeSkill({ siteId: 'site-a.com' });
      const specB = makeSkill({ siteId: 'site-b.com' });

      const refsA = generateSkillReferences(specA);
      const refsB = generateSkillReferences(specB);

      const apiRefA = refsA.get('api-reference.md')!;
      const apiRefB = refsB.get('api-reference.md')!;

      expect(apiRefA).toContain('`site-a.com`');
      expect(apiRefB).toContain('`site-b.com`');
      expect(apiRefA).not.toBe(apiRefB);
    });
  });
});
