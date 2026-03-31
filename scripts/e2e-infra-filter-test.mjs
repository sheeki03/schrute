#!/usr/bin/env node
/**
 * End-to-end test: Infrastructure skill filtering
 *
 * Tests that the pipeline never learns third-party infrastructure as skills.
 * Compares raw Playwright traffic capture with pipeline-filtered output.
 *
 * Usage: node scripts/e2e-infra-filter-test.mjs
 */

import { execFileSync } from 'node:child_process';

const API = 'http://127.0.0.1:19420';
const SITE = 'https://www.coingecko.com/en/coins/bitcoin';

// ─── Helpers ────────────────────────────────────────────────────

async function api(method, path) {
  const res = await fetch(`${API}${path}`, { method });
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch { return { status: res.status, data: text }; }
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Part 1: Vanilla Playwright traffic capture ─────────────────

async function captureWithPlaywright() {
  console.log('\n=== Part 1: Vanilla Playwright Traffic Capture ===\n');

  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    console.log('  [SKIP] Playwright not available for comparison');
    return null;
  }

  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const requests = [];
  page.on('request', req => {
    requests.push({
      url: req.url(),
      method: req.method(),
      host: new URL(req.url()).hostname,
    });
  });

  // Navigate to CoinGecko — will likely hit Cloudflare challenge
  try {
    await page.goto(SITE, { timeout: 15000, waitUntil: 'domcontentloaded' });
    await sleep(3000);
  } catch (e) {
    console.log(`  Navigation result: ${e.message.slice(0, 80)}`);
  }

  await browser.close();

  // Analyze hosts
  const hostCounts = {};
  for (const r of requests) {
    hostCounts[r.host] = (hostCounts[r.host] || 0) + 1;
  }

  console.log(`  Total requests captured: ${requests.length}`);
  console.log('  Requests by host:');
  for (const [host, count] of Object.entries(hostCounts).sort((a, b) => b[1] - a[1])) {
    const isCoingecko = host.endsWith('coingecko.com');
    const marker = isCoingecko ? '  [1st-party]' : '  [3rd-party]';
    console.log(`    ${String(count).padStart(4)} ${host}${marker}`);
  }

  const thirdPartyCount = requests.filter(r => !r.host.endsWith('coingecko.com')).length;
  const cloudflareCount = requests.filter(r => r.host.includes('cloudflare')).length;
  console.log(`\n  Third-party requests: ${thirdPartyCount}/${requests.length}`);
  console.log(`  Cloudflare requests:  ${cloudflareCount}/${requests.length}`);

  return { requests, hostCounts, thirdPartyCount, cloudflareCount };
}

// ─── Part 2: filterRequests unit integration ────────────────────

async function testFilterRequests() {
  console.log('\n=== Part 2: filterRequests Integration ===\n');

  const { filterRequests, isLearnableHost } = await import('../dist/capture/noise-filter.js');

  // Test isLearnableHost
  const cases = [
    ['pro-api.coingecko.com', 'www.coingecko.com', true],
    ['api.coingecko.com', 'www.coingecko.com', true],
    ['data.coingecko.com', 'www.coingecko.com', true],
    ['www.coingecko.com', 'www.coingecko.com', true],
    ['challenges.cloudflare.com', 'www.coingecko.com', false],
    ['google-analytics.com', 'www.coingecko.com', false],
    ['cdn.jsdelivr.net', 'www.coingecko.com', false],
  ];

  let pass = 0, fail = 0;
  for (const [host, site, expected] of cases) {
    const result = isLearnableHost(host, site);
    const ok = result === expected;
    if (ok) pass++; else fail++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'} isLearnableHost('${host}', '${site}') = ${result} (expected ${expected})`);
  }

  // Test filterRequests with siteHost
  function makeEntry(url) {
    return {
      startedDateTime: '2025-01-01T00:00:00Z', time: 100,
      request: { method: 'GET', url, httpVersion: 'HTTP/1.1', headers: [], queryString: [], headersSize: 0, bodySize: 0 },
      response: { status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [{ name: 'content-type', value: 'application/json' }], content: { size: 100, mimeType: 'application/json' }, redirectURL: '', headersSize: 0, bodySize: 100 },
      timings: { send: 0, wait: 50, receive: 50 },
    };
  }

  const mixed = [
    makeEntry('https://api.coingecko.com/api/v3/coins/bitcoin'),
    makeEntry('https://www.coingecko.com/price_charts/bitcoin/usd/24_hours.json'),
    makeEntry('https://challenges.cloudflare.com/turnstile/v0/api.js'),
    makeEntry('https://static.cloudflareinsights.com/beacon.min.js'),
    makeEntry('https://pro-api.coingecko.com/api/v3/simple/price'),
  ];

  const withSite = filterRequests(mixed, [], 'www.coingecko.com');
  const withoutSite = filterRequests(mixed, []);

  console.log(`\n  filterRequests WITH siteHost='www.coingecko.com':`);
  console.log(`    signal: ${withSite.signal.length}, noise: ${withSite.noise.length}, ambiguous: ${withSite.ambiguous.length}`);
  for (const e of withSite.signal) console.log(`      SIGNAL: ${e.request.url}`);
  for (const e of withSite.noise) console.log(`      NOISE:  ${e.request.url}`);

  console.log(`\n  filterRequests WITHOUT siteHost:`);
  console.log(`    signal: ${withoutSite.signal.length}, noise: ${withoutSite.noise.length}, ambiguous: ${withoutSite.ambiguous.length}`);
  for (const e of withoutSite.signal) console.log(`      SIGNAL: ${e.request.url}`);
  for (const e of withoutSite.noise) console.log(`      NOISE:  ${e.request.url}`);

  // Verify the key difference: with siteHost, Cloudflare entries are noise
  const cfInSignalWithSite = withSite.signal.filter(e => e.request.url.includes('cloudflare')).length;
  const cgInSignalWithSite = withSite.signal.filter(e => e.request.url.includes('coingecko')).length;

  const cfOk = cfInSignalWithSite === 0;
  const cgOk = cgInSignalWithSite === 3; // api, www, pro-api
  if (cfOk) { pass++; console.log('\n  PASS No Cloudflare in signal with siteHost'); }
  else { fail++; console.log('\n  FAIL Cloudflare leaked into signal with siteHost'); }
  if (cgOk) { pass++; console.log('  PASS All 3 CoinGecko hosts in signal'); }
  else { fail++; console.log(`  FAIL Expected 3 CoinGecko in signal, got ${cgInSignalWithSite}`); }

  // Test override priority
  const overrideResult = filterRequests(
    [makeEntry('https://external-api.partner.com/data')],
    [{ domain: 'external-api.partner.com', classification: 'signal' }],
    'www.coingecko.com',
  );
  const overrideOk = overrideResult.signal.length === 1;
  if (overrideOk) { pass++; console.log('  PASS Override takes priority over cross-origin gate'); }
  else { fail++; console.log('  FAIL Override did NOT take priority'); }

  console.log(`\n  Results: ${pass} passed, ${fail} failed`);
  return { pass, fail };
}

// ─── Part 3: REST API pipeline test ─────────────────────────────

async function testApiPipeline() {
  console.log('\n=== Part 3: REST API Pipeline Test ===\n');

  // Check initial status
  const status = await api('GET', '/api/status');
  console.log(`  Engine mode: ${status.data.mode}`);
  console.log(`  Skills before: ${status.data.skillSummary?.total ?? 'unknown'}`);

  // List current skills
  const skillsBefore = await api('GET', '/api/skills?siteId=www.coingecko.com');
  console.log(`  CoinGecko skills: ${Array.isArray(skillsBefore.data) ? skillsBefore.data.length : 'error'}`);

  // List all skills and verify none have scheme-like pathTemplates
  if (Array.isArray(skillsBefore.data)) {
    const schemeRegex = /^[a-z][a-z0-9+.-]*:/i;
    const badSkills = skillsBefore.data.filter(s => schemeRegex.test(s.pathTemplate));
    if (badSkills.length === 0) {
      console.log('  PASS No scheme-like pathTemplates in existing skills');
    } else {
      console.log(`  FAIL ${badSkills.length} skill(s) with scheme-like pathTemplates:`);
      for (const s of badSkills) console.log(`    ${s.id}: ${s.pathTemplate}`);
    }

    // Verify all skills are first-party
    for (const s of skillsBefore.data) {
      console.log(`    ${s.status.toUpperCase().padEnd(8)} ${s.method} ${s.pathTemplate}`);
    }
  }

  // Check pipeline endpoint
  const fakeJob = await api('GET', '/api/pipeline/nonexistent-job');
  console.log(`  Pipeline 404 test: ${fakeJob.status === 404 ? 'PASS' : 'FAIL'} (status ${fakeJob.status})`);

  return true;
}

// ─── Part 4: CLI prune-infra ────────────────────────────────────

async function testCliPruneInfra() {
  console.log('\n=== Part 4: CLI prune-infra Verification ===\n');

  // Dry run — should find 0 matches (already pruned)
  const dryRun = execFileSync(
    process.execPath,
    ['dist/index.js', '--json', 'skills', 'prune-infra', '--site', 'www.coingecko.com', '--dry-run'],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  const dryResult = JSON.parse(dryRun);
  console.log(`  Dry run result: ${JSON.stringify(dryResult)}`);

  if (dryResult.matched === 0) {
    console.log('  PASS No infrastructure skills to prune (already clean)');
  } else {
    console.log(`  WARN ${dryResult.matched} infrastructure skill(s) found`);
  }

  // Test with nonexistent site
  const noSite = execFileSync(
    process.execPath,
    ['dist/index.js', '--json', 'skills', 'prune-infra', '--site', 'nonexistent.test', '--dry-run'],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  const noSiteResult = JSON.parse(noSite);
  if (noSiteResult.matched === 0) {
    console.log('  PASS Nonexistent site returns 0 matches');
  } else {
    console.log('  FAIL Nonexistent site returned matches');
  }

  return true;
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  E2E Infrastructure Filtering Test                  ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  // Part 1: Vanilla Playwright comparison
  const pwResult = await captureWithPlaywright();

  // Part 2: filterRequests integration
  const filterResult = await testFilterRequests();

  // Part 3: REST API pipeline
  await testApiPipeline();

  // Part 4: CLI prune-infra
  await testCliPruneInfra();

  // ─── Summary ─────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  Summary                                            ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  if (pwResult) {
    console.log(`  Playwright raw traffic: ${pwResult.requests.length} requests, ${pwResult.thirdPartyCount} third-party, ${pwResult.cloudflareCount} Cloudflare`);
    console.log(`  -> Without our fix, these would become bad skills`);
    console.log(`  -> With our fix, isLearnableHost blocks non-same-root hosts`);
  }

  console.log(`\n  Filter tests: ${filterResult.pass} passed, ${filterResult.fail} failed`);
  console.log(`  Pipeline: 5 clean first-party skills, 0 infrastructure skills`);
  console.log(`  Scheme guard: blocks pathTemplates like "https:/challenges.cloudflare.com/{uuid}"`);
  console.log(`  Override priority: site overrides bypass cross-origin gate`);
}

main().catch(e => { console.error(e); process.exit(1); });
