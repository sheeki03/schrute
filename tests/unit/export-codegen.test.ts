import { describe, expect, it } from 'vitest';
import { generateExport, generateSkillTemplates } from '../../src/skill/generator.js';
import type { SkillSpec } from '../../src/skill/types.js';

function makeSkill(overrides: Partial<SkillSpec> = {}): SkillSpec {
  return {
    id: 'example.com.get_user.v1',
    version: 1,
    status: 'active',
    currentTier: 'tier_1',
    tierLock: null,
    allowedDomains: ['example.com'],
    requiredCapabilities: [],
    parameters: [],
    validation: { semanticChecks: [], customInvariants: [] },
    redaction: { piiClassesFound: [], fieldsRedacted: 0 },
    replayStrategy: 'prefer_tier_1',
    sideEffectClass: 'read-only',
    sampleCount: 1,
    consecutiveValidations: 1,
    confidence: 1,
    method: 'GET',
    pathTemplate: '/users/{id}',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        q: { type: 'string' },
      },
    },
    isComposite: false,
    siteId: 'example.com',
    name: 'get_user',
    description: 'Fetch a user',
    successRate: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as SkillSpec;
}

describe('export codegen', () => {
  it('generates curl exports with resolved params and transform comments', () => {
    const code = generateExport(makeSkill({
      outputTransform: { type: 'jsonpath', expression: '$.user.id', label: 'user_id' },
    }), 'curl', { id: '123', q: 'neo' });

    expect(code).toContain('# Transform: jsonpath $.user.id -> user_id');
    expect(code).toContain("curl -X GET");
    expect(code).toContain("https://example.com/users/123?q=neo");
  });

  it('generates fetch.ts exports', () => {
    const code = generateExport(makeSkill(), 'fetch.ts', { id: '123' });
    expect(code).toContain("const response = await fetch(");
    expect(code).toContain('"https://example.com/users/123"');
    expect(code).toContain('method: "GET"');
  });

  it('generates requests.py exports', () => {
    const code = generateExport(makeSkill({ method: 'POST' }), 'requests.py', { id: '123', q: 'neo' });
    expect(code).toContain('import requests');
    expect(code).toContain('requests.request("POST"');
    expect(code).toContain('data = "{\\"q\\":\\"neo\\"}"');
  });

  it('always replaces captured auth headers with placeholders in exports', () => {
    const code = generateExport(makeSkill({
      authType: 'bearer',
      requiredHeaders: {
        authorization: 'Bearer real-secret-token',
        cookie: 'session=real-cookie',
      },
    }), 'curl', { id: '123' });

    expect(code).toContain("'Authorization: Bearer YOUR_TOKEN'");
    expect(code).toContain("'Cookie: SESSION=YOUR_COOKIE'");
    expect(code).not.toContain('real-secret-token');
    expect(code).not.toContain('real-cookie');
  });

  it('preserves string literals when generating python exports', () => {
    const code = generateExport(makeSkill({
      method: 'POST',
      requiredHeaders: {
        accept: 'true',
      },
    }), 'requests.py', { id: '123', q: 'neo' });

    expect(code).toContain('"Accept": "true"');
    expect(code).not.toContain('"Accept": True');
  });

  it('generates playwright exports with browser_required warning', () => {
    const code = generateExport(makeSkill({
      tierLock: {
        type: 'permanent',
        reason: 'browser_required',
        evidence: 'challenge',
      },
    }), 'playwright.ts', { id: '123' });

    expect(code).toContain('Warning: this skill is marked browser_required');
    expect(code).toContain("import { chromium } from 'playwright';");
    expect(code).toContain('page.request.fetch');
  });

  it('extends generated templates with standalone export files', () => {
    const templates = generateSkillTemplates(makeSkill());
    expect(templates.has('request.json')).toBe(true);
    expect(templates.has('curl.sh')).toBe(true);
    expect(templates.has('fetch.ts')).toBe(true);
    expect(templates.has('requests.py')).toBe(true);
    expect(templates.has('playwright.ts')).toBe(true);
  });
});
