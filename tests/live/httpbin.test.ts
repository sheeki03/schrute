/**
 * Live integration tests against httpbin.org.
 *
 * These tests hit real HTTP endpoints — do NOT run in CI.
 * Run manually: npx vitest run tests/live/httpbin.test.ts --timeout 30000
 *
 * Tests:
 * 1. Direct HTTP execution of a Tier 1 skill
 * 2. Response transform (jsonpath) on live data
 * 3. Export generates runnable curl command
 * 4. Skill search returns real results
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getConfig, ensureDirectories } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';
import { getDatabase, closeDatabase } from '../../src/storage/database.js';
import { SkillRepository } from '../../src/storage/skill-repository.js';
import { SiteRepository } from '../../src/storage/site-repository.js';
import type { SchruteConfig } from '../../src/skill/types.js';
import type { AgentDatabase } from '../../src/storage/database.js';
import { buildRequest } from '../../src/replay/request-builder.js';
import { applyTransform } from '../../src/replay/transform.js';
import { generateExport } from '../../src/skill/generator.js';

let config: SchruteConfig;
let db: AgentDatabase;
let skillRepo: SkillRepository;
let siteRepo: SiteRepository;

describe('httpbin.org live integration', () => {
  beforeAll(() => {
    config = getConfig();
    createLogger(config.logLevel);
    ensureDirectories(config);
    db = getDatabase(config);
    skillRepo = new SkillRepository(db);
    siteRepo = new SiteRepository(db);
  });

  afterAll(() => {
    closeDatabase();
  });

  it('has learned httpbin skills from previous sessions', () => {
    const skills = skillRepo.getBySiteId('httpbin.org');
    expect(skills.length).toBeGreaterThan(0);

    const ipSkill = skills.find(s => s.id === 'httpbin_org.get_ip.v1');
    expect(ipSkill).toBeDefined();
    expect(ipSkill!.status).toBe('active');
    expect(ipSkill!.method).toBe('GET');
    expect(ipSkill!.pathTemplate).toBe('/ip');
  });

  it('buildRequest resolves a valid HTTP request for get_ip', () => {
    const skill = skillRepo.getById('httpbin_org.get_ip.v1');
    expect(skill).toBeDefined();

    const request = buildRequest(skill!, {}, 'direct');
    expect(request.url).toContain('httpbin.org/ip');
    expect(request.method).toBe('GET');
    expect(request.headers).toBeDefined();
  });

  it('executes direct HTTP fetch against httpbin.org/ip', async () => {
    const skill = skillRepo.getById('httpbin_org.get_ip.v1');
    expect(skill).toBeDefined();

    const request = buildRequest(skill!, {}, 'direct');
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty('origin');
    expect(typeof data.origin).toBe('string');
    expect(data.origin).toMatch(/^\d+\.\d+\.\d+\.\d+/);
  });

  it('applies jsonpath transform to live httpbin response', async () => {
    const response = await fetch('https://httpbin.org/ip', {
      headers: { accept: 'application/json' },
    });
    const data = await response.json();

    const result = await applyTransform(data, {
      type: 'jsonpath',
      expression: '$.origin',
      label: 'ip_address',
    });

    expect(result.transformApplied).toBe(true);
    expect(result.label).toBe('ip_address');
    expect(typeof result.data).toBe('string');
    expect(result.data).toMatch(/^\d+\.\d+\.\d+\.\d+/);
  });

  it('applies regex transform to extract IP octets', async () => {
    const response = await fetch('https://httpbin.org/ip', {
      headers: { accept: 'application/json' },
    });
    const data = await response.json();

    const result = await applyTransform(data.origin, {
      type: 'regex',
      expression: '(?<first>\\d+)\\.(?<second>\\d+)\\.(?<third>\\d+)\\.(?<fourth>\\d+)',
      label: 'ip_octets',
    });

    expect(result.transformApplied).toBe(true);
    const octets = result.data as Record<string, string>;
    expect(octets).toHaveProperty('first');
    expect(octets).toHaveProperty('second');
    expect(octets).toHaveProperty('third');
    expect(octets).toHaveProperty('fourth');
  });

  it('generates working curl export for get_ip skill', () => {
    const skill = skillRepo.getById('httpbin_org.get_ip.v1');
    expect(skill).toBeDefined();

    const curlOutput = generateExport(skill!, 'curl');
    expect(curlOutput).toContain('curl');
    expect(curlOutput).toContain('httpbin.org/ip');
    expect(curlOutput).toContain('-X GET');
  });

  it('generates typescript export for get_ip skill', () => {
    const skill = skillRepo.getById('httpbin_org.get_ip.v1');
    expect(skill).toBeDefined();

    const tsOutput = generateExport(skill!, 'fetch.ts');
    expect(tsOutput).toContain('fetch(');
    expect(tsOutput).toContain('httpbin.org/ip');
    expect(tsOutput).toContain('await');
  });

  it('generates python export for get_ip skill', () => {
    const skill = skillRepo.getById('httpbin_org.get_ip.v1');
    expect(skill).toBeDefined();

    const pyOutput = generateExport(skill!, 'requests.py');
    expect(pyOutput).toContain('import requests');
    expect(pyOutput).toContain('httpbin.org/ip');
  });

  it('fetches httpbin.org/headers and gets structured response', async () => {
    const response = await fetch('https://httpbin.org/headers', {
      headers: { accept: 'application/json', 'x-custom': 'test-value' },
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty('headers');
    expect(data.headers).toHaveProperty('X-Custom');
    expect(data.headers['X-Custom']).toBe('test-value');
  });
});
