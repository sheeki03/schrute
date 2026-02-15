#!/usr/bin/env npx tsx

/**
 * OneAgent 3-Site Benchmark Script
 *
 * Starts 3 mock Fastify servers (REST, GraphQL, Auth), executes skills
 * against each at different tiers, and reports latency/success metrics.
 *
 * Usage: npx tsx scripts/benchmark-3-sites.ts
 */

import { createRestMockServer } from '../tests/fixtures/mock-sites/rest-mock-server.js';
import { createGraphQLMockServer } from '../tests/fixtures/mock-sites/graphql-mock-server.js';
import { createAuthMockServer } from '../tests/fixtures/mock-sites/auth-mock-server.js';
import { executeSkill } from '../src/replay/executor.js';
import type { SkillSpec, SealedFetchRequest, SealedFetchResponse, BrowserProvider } from '../src/skill/types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Configuration ────────────────────────────────────────────────

const ITERATIONS = 5;

// ─── Helper: load skill fixture ──────────────────────────────────

function loadSkillFixture(name: string): SkillSpec {
  const fixturePath = path.join(__dirname, '..', 'tests', 'fixtures', 'generated-skills', name);
  return JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as SkillSpec;
}

// ─── Helper: create a fetchFn that adds auth ─────────────────────

function createFetchFn(authHeader?: string) {
  return async (req: SealedFetchRequest): Promise<SealedFetchResponse> => {
    const headers: Record<string, string> = { ...req.headers };
    if (authHeader) {
      headers['Authorization'] = authHeader;
    }
    const resp = await fetch(req.url, {
      method: req.method,
      headers,
      body: req.body,
    });
    const body = await resp.text();
    const respHeaders: Record<string, string> = {};
    resp.headers.forEach((value, key) => { respHeaders[key] = value; });
    return { status: resp.status, headers: respHeaders, body };
  };
}

// ─── Helper: create a mock browser provider ──────────────────────

function createMockBrowserProvider(authHeader?: string): BrowserProvider {
  return {
    navigate: async () => {},
    snapshot: async () => ({ url: '', title: '', content: '' }),
    click: async () => {},
    type: async () => {},
    evaluateFetch: async (req: SealedFetchRequest): Promise<SealedFetchResponse> => {
      // Simulate extra latency for browser-proxied tier
      await new Promise(r => setTimeout(r, 10));
      const headers: Record<string, string> = { ...req.headers };
      if (authHeader) {
        headers['Authorization'] = authHeader;
      }
      const resp = await fetch(req.url, {
        method: req.method,
        headers,
        body: req.body,
      });
      const body = await resp.text();
      const respHeaders: Record<string, string> = {};
      resp.headers.forEach((value, key) => { respHeaders[key] = value; });
      return { status: resp.status, headers: respHeaders, body };
    },
    screenshot: async () => Buffer.from(''),
    networkRequests: async () => [],
  };
}

// ─── Benchmark runner ────────────────────────────────────────────

interface BenchmarkResult {
  site: string;
  skill: string;
  tier: string;
  iterations: number;
  successCount: number;
  failureCount: number;
  successRate: string;
  avgLatencyMs: string;
  minLatencyMs: number;
  maxLatencyMs: number;
  p95LatencyMs: number;
}

async function runBenchmark(
  site: string,
  skillName: string,
  skill: SkillSpec,
  params: Record<string, unknown>,
  tier: 'direct' | 'browser_proxied',
  iterations: number,
  fetchFn: (req: SealedFetchRequest) => Promise<SealedFetchResponse>,
  browserProvider: BrowserProvider,
): Promise<BenchmarkResult> {
  const latencies: number[] = [];
  let successCount = 0;

  for (let i = 0; i < iterations; i++) {
    const result = await executeSkill(skill, params, {
      fetchFn,
      browserProvider,
      forceTier: tier,
    });

    latencies.push(result.latencyMs);
    if (result.success || result.status >= 200 && result.status < 300) {
      successCount++;
    }
  }

  latencies.sort((a, b) => a - b);
  const avgLatency = latencies.reduce((s, l) => s + l, 0) / latencies.length;
  const p95Index = Math.min(Math.ceil(latencies.length * 0.95) - 1, latencies.length - 1);

  return {
    site,
    skill: skillName,
    tier: tier === 'direct' ? 'Tier 1' : 'Tier 3',
    iterations,
    successCount,
    failureCount: iterations - successCount,
    successRate: ((successCount / iterations) * 100).toFixed(1) + '%',
    avgLatencyMs: avgLatency.toFixed(2),
    minLatencyMs: latencies[0],
    maxLatencyMs: latencies[latencies.length - 1],
    p95LatencyMs: latencies[p95Index],
  };
}

// ─── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log('=== OneAgent 3-Site Benchmark ===\n');
  console.log(`Iterations per test: ${ITERATIONS}\n`);

  // Start all 3 mock servers
  console.log('Starting mock servers...');
  const restServer = await createRestMockServer();
  const graphqlServer = await createGraphQLMockServer();
  const authServer = await createAuthMockServer();

  console.log(`  REST server:    ${restServer.url}`);
  console.log(`  GraphQL server: ${graphqlServer.url}`);
  console.log(`  Auth server:    ${authServer.url}`);
  console.log('');

  const results: BenchmarkResult[] = [];

  try {
    // ─── REST: Get Users ──────────────────────────────────────
    {
      const skill = loadSkillFixture('get-users-skill.json');
      skill.pathTemplate = `${restServer.url}/api/users`;
      skill.allowedDomains = [new URL(restServer.url).hostname];

      const fetchFn = createFetchFn('Bearer token123');
      const browserProvider = createMockBrowserProvider('Bearer token123');

      console.log('Benchmarking REST: Get Users...');
      results.push(await runBenchmark(
        'REST', 'Get Users', skill, { page: 1, limit: 10 },
        'direct', ITERATIONS, fetchFn, browserProvider,
      ));
      results.push(await runBenchmark(
        'REST', 'Get Users', skill, { page: 1, limit: 10 },
        'browser_proxied', ITERATIONS, fetchFn, browserProvider,
      ));
    }

    // ─── REST: Create User ────────────────────────────────────
    {
      const skill = loadSkillFixture('create-user-skill.json');
      skill.pathTemplate = `${restServer.url}/api/users`;
      skill.allowedDomains = [new URL(restServer.url).hostname];
      skill.status = 'active';
      skill.consecutiveValidations = 1;

      const fetchFn = createFetchFn('Bearer token123');
      const browserProvider = createMockBrowserProvider('Bearer token123');

      console.log('Benchmarking REST: Create User...');
      results.push(await runBenchmark(
        'REST', 'Create User', skill,
        { name: 'Bench User', email: 'bench@example.com', role: 'user' },
        'direct', ITERATIONS, fetchFn, browserProvider,
      ));
      results.push(await runBenchmark(
        'REST', 'Create User', skill,
        { name: 'Bench User', email: 'bench@example.com', role: 'user' },
        'browser_proxied', ITERATIONS, fetchFn, browserProvider,
      ));
    }

    // ─── GraphQL: Get Users ───────────────────────────────────
    {
      const skill = loadSkillFixture('graphql-skill.json');
      skill.pathTemplate = `${graphqlServer.url}/graphql`;
      skill.allowedDomains = [new URL(graphqlServer.url).hostname];

      const fetchFn = createFetchFn();
      const browserProvider = createMockBrowserProvider();

      console.log('Benchmarking GraphQL: Get Users...');
      results.push(await runBenchmark(
        'GraphQL', 'GetUsers', skill,
        {
          query: 'query GetUsers($limit: Int, $offset: Int) { users(limit: $limit, offset: $offset) { id name email role createdAt } }',
          operationName: 'GetUsers',
          variables: { limit: 10, offset: 0 },
        },
        'direct', ITERATIONS, fetchFn, browserProvider,
      ));
      results.push(await runBenchmark(
        'GraphQL', 'GetUsers', skill,
        {
          query: 'query GetUsers($limit: Int, $offset: Int) { users(limit: $limit, offset: $offset) { id name email role createdAt } }',
          operationName: 'GetUsers',
          variables: { limit: 10, offset: 0 },
        },
        'browser_proxied', ITERATIONS, fetchFn, browserProvider,
      ));
    }

    // ─── Auth: Login ──────────────────────────────────────────
    {
      // Build a login skill on the fly
      const loginSkill: SkillSpec = {
        id: 'auth-site.login.v1',
        version: 1,
        status: 'active',
        currentTier: 'tier_1',
        tierLock: null,
        allowedDomains: [new URL(authServer.url).hostname],
        requiredCapabilities: ['net.fetch.direct'],
        parameters: [
          { name: 'username', type: 'string', source: 'user_input', evidence: [] },
          { name: 'password', type: 'string', source: 'user_input', evidence: [] },
        ],
        validation: { semanticChecks: [], customInvariants: [] },
        redaction: { piiClassesFound: ['email'], fieldsRedacted: 1 },
        replayStrategy: 'prefer_tier_1',
        sideEffectClass: 'idempotent',
        sampleCount: 1,
        consecutiveValidations: 1,
        confidence: 0.9,
        method: 'POST',
        pathTemplate: `${authServer.url}/auth/login`,
        inputSchema: {
          type: 'object',
          properties: {
            username: { type: 'string' },
            password: { type: 'string' },
          },
          required: ['username', 'password'],
        },
        outputSchema: {
          type: 'object',
          properties: {
            access_token: { type: 'string' },
            refresh_token: { type: 'string' },
            token_type: { type: 'string' },
            expires_in: { type: 'number' },
          },
          required: ['access_token', 'token_type'],
        },
        requiredHeaders: { 'Content-Type': 'application/json' },
        dynamicHeaders: {},
        isComposite: false,
        siteId: 'auth-site',
        name: 'Login',
        description: 'Authenticate and get access token',
        successRate: 1.0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const fetchFn = createFetchFn();
      const browserProvider = createMockBrowserProvider();

      console.log('Benchmarking Auth: Login...');
      results.push(await runBenchmark(
        'Auth', 'Login', loginSkill,
        { username: 'alice@example.com', password: 'password123' },
        'direct', ITERATIONS, fetchFn, browserProvider,
      ));
      results.push(await runBenchmark(
        'Auth', 'Login', loginSkill,
        { username: 'alice@example.com', password: 'password123' },
        'browser_proxied', ITERATIONS, fetchFn, browserProvider,
      ));
    }

    // ─── Print Results ────────────────────────────────────────

    console.log('\n' + '='.repeat(110));
    console.log('BENCHMARK RESULTS');
    console.log('='.repeat(110));

    // Table header
    const headers = ['Site', 'Skill', 'Tier', 'Iters', 'OK', 'Fail', 'Rate', 'Avg(ms)', 'Min(ms)', 'Max(ms)', 'P95(ms)'];
    const widths = [10, 14, 8, 6, 4, 5, 7, 10, 9, 9, 9];

    const headerLine = headers.map((h, i) => h.padEnd(widths[i])).join(' | ');
    console.log(headerLine);
    console.log(widths.map(w => '-'.repeat(w)).join('-+-'));

    for (const r of results) {
      const row = [
        r.site.padEnd(widths[0]),
        r.skill.padEnd(widths[1]),
        r.tier.padEnd(widths[2]),
        String(r.iterations).padStart(widths[3]),
        String(r.successCount).padStart(widths[4]),
        String(r.failureCount).padStart(widths[5]),
        r.successRate.padStart(widths[6]),
        r.avgLatencyMs.padStart(widths[7]),
        String(r.minLatencyMs).padStart(widths[8]),
        String(r.maxLatencyMs).padStart(widths[9]),
        String(r.p95LatencyMs).padStart(widths[10]),
      ];
      console.log(row.join(' | '));
    }

    console.log('='.repeat(110));

    // Summary
    const totalExecutions = results.reduce((s, r) => s + r.iterations, 0);
    const totalSuccesses = results.reduce((s, r) => s + r.successCount, 0);
    const overallRate = ((totalSuccesses / totalExecutions) * 100).toFixed(1);

    const tier1Results = results.filter(r => r.tier === 'Tier 1');
    const tier3Results = results.filter(r => r.tier === 'Tier 3');

    const avgTier1 = tier1Results.length > 0
      ? (tier1Results.reduce((s, r) => s + parseFloat(r.avgLatencyMs), 0) / tier1Results.length).toFixed(2)
      : 'N/A';
    const avgTier3 = tier3Results.length > 0
      ? (tier3Results.reduce((s, r) => s + parseFloat(r.avgLatencyMs), 0) / tier3Results.length).toFixed(2)
      : 'N/A';

    console.log(`\nSummary:`);
    console.log(`  Total executions:  ${totalExecutions}`);
    console.log(`  Overall success:   ${totalSuccesses}/${totalExecutions} (${overallRate}%)`);
    console.log(`  Avg Tier 1 latency: ${avgTier1}ms`);
    console.log(`  Avg Tier 3 latency: ${avgTier3}ms`);
    console.log('');
  } finally {
    // Cleanup
    console.log('Shutting down mock servers...');
    await restServer.close();
    await graphqlServer.close();
    await authServer.close();
    console.log('Done.');
  }
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
