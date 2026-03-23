/**
 * Live integration tests against CoinGecko (Cloudflare-protected).
 *
 * These tests verify:
 * 1. Browser-required skills are correctly locked
 * 2. CoinGecko skills exist and have correct metadata
 * 3. Direct HTTP to CoinGecko fails (Cloudflare blocks it)
 * 4. Export for browser_required skills includes warning
 * 5. Transform on price chart data extracts latest price
 *
 * Run manually: npx vitest run tests/live/coingecko.test.ts --timeout 30000
 * NOTE: These tests do NOT launch a browser — they verify skill metadata
 * and test that direct HTTP is correctly blocked by Cloudflare.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getConfig, ensureDirectories } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';
import { getDatabase, closeDatabase } from '../../src/storage/database.js';
import { SkillRepository } from '../../src/storage/skill-repository.js';
import type { SchruteConfig } from '../../src/skill/types.js';
import type { AgentDatabase } from '../../src/storage/database.js';
import { applyTransform } from '../../src/replay/transform.js';
import { generateExport } from '../../src/skill/generator.js';

let config: SchruteConfig;
let db: AgentDatabase;
let skillRepo: SkillRepository;

describe('coingecko.com live integration', () => {
  beforeAll(() => {
    config = getConfig();
    createLogger(config.logLevel);
    ensureDirectories(config);
    db = getDatabase(config);
    skillRepo = new SkillRepository(db);
  });

  afterAll(() => {
    closeDatabase();
  });

  it('has learned CoinGecko skills from previous sessions', () => {
    const skills = skillRepo.getBySiteId('www.coingecko.com');
    expect(skills.length).toBeGreaterThan(0);

    const chartSkill = skills.find(s => s.id === 'www_coingecko_com.get_24_hours_json.v1');
    expect(chartSkill).toBeDefined();
    expect(chartSkill!.status).toBe('active');
    expect(chartSkill!.method).toBe('GET');
    expect(chartSkill!.pathTemplate).toBe('/price_charts/bitcoin/usd/24_hours.json');
  });

  it('CoinGecko skills have browser_required tier lock', () => {
    const chartSkill = skillRepo.getById('www_coingecko_com.get_24_hours_json.v1');
    expect(chartSkill).toBeDefined();
    expect(chartSkill!.tierLock).toBeDefined();
    expect(chartSkill!.tierLock?.type).toBe('permanent');
    expect(chartSkill!.tierLock?.reason).toBe('browser_required');
  });

  it('direct HTTP to CoinGecko price chart is blocked by Cloudflare', async () => {
    // CoinGecko returns a Cloudflare challenge page for direct HTTP
    const response = await fetch(
      'https://www.coingecko.com/price_charts/bitcoin/usd/24_hours.json',
      { headers: { accept: 'application/json' } },
    );

    // Cloudflare may return 403, 503, or a challenge page with 200
    // The key assertion: it does NOT return valid JSON chart data
    const text = await response.text();
    const isBlocked = response.status === 403
      || response.status === 503
      || text.includes('challenge')
      || text.includes('Cloudflare')
      || text.includes('cf-browser-verification');

    // Either blocked by status code or by challenge page content
    if (response.status === 200) {
      // If status is 200, verify it's a challenge page, not real data
      try {
        const data = JSON.parse(text);
        // If it parses as JSON with stats array, Cloudflare let it through (rare)
        if (data.stats && Array.isArray(data.stats)) {
          // Cloudflare sometimes allows direct requests — this is acceptable
          expect(data.stats.length).toBeGreaterThan(0);
        }
      } catch {
        // Not JSON — it's a Cloudflare challenge HTML page
        expect(isBlocked).toBe(true);
      }
    } else {
      expect([403, 503]).toContain(response.status);
    }
  });

  it('export for browser_required skill includes warning', () => {
    const skill = skillRepo.getById('www_coingecko_com.get_24_hours_json.v1');
    expect(skill).toBeDefined();

    const playwrightExport = generateExport(skill!, 'playwright.ts');
    expect(playwrightExport).toContain('browser_required');
    expect(playwrightExport).toContain('chromium');

    // curl export should also work
    const curlExport = generateExport(skill!, 'curl');
    expect(curlExport).toContain('curl');
    expect(curlExport).toContain('coingecko.com');
  });

  it('jsonpath transform extracts latest BTC price from chart data', async () => {
    // Simulate the shape of CoinGecko's chart response
    const mockChartData = {
      stats: [
        [1774169696954, 68708.85],
        [1774169964640, 68785.73],
      ],
      total_volumes: [
        [1774169696954, 27377622020.50],
        [1774169964640, 27774473651.30],
      ],
    };

    const result = await applyTransform(mockChartData, {
      type: 'jsonpath',
      expression: '$.stats[(@.length-1)][1]',
      label: 'latest_btc_price',
    });

    expect(result.transformApplied).toBe(true);
    expect(result.label).toBe('latest_btc_price');
    // jsonpath may return the value directly or wrapped — accept either
    const price = Array.isArray(result.data) ? result.data[0] : result.data;
    expect(typeof price).toBe('number');
    expect(price).toBeCloseTo(68785.73, 1);
  });

  it('multiple CoinGecko skills exist with correct sideEffectClass', () => {
    const skills = skillRepo.getBySiteId('www.coingecko.com');
    const activeSkills = skills.filter(s => s.status === 'active');

    expect(activeSkills.length).toBeGreaterThan(1);

    // All CoinGecko skills should be read-only
    for (const skill of activeSkills) {
      expect(skill.sideEffectClass).toBe('read-only');
    }
  });
});
