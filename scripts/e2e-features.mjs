#!/usr/bin/env node
/**
 * End-to-end feature test exercising:
 * 1. Geo emulation (timezone + locale + geolocation)
 * 2. Context override mismatch detection
 * 3. Force-close session during exploring
 * 4. Re-explore with new overrides after force-close
 * 5. CDP auto-discovery (mocked — no real browser needed)
 * 6. Proxy validation (input rejection)
 * 7. SDK library exports
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '..');

// Use a temp data dir
const dataDir = path.join(root, '.e2e-tmp');
fs.mkdirSync(dataDir, { recursive: true });
process.env.SCHRUTE_DATA_DIR = dataDir;
process.env.SCHRUTE_LOG_LEVEL = 'silent';

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.log(`  FAIL: ${name}`);
    failed++;
  }
}

async function cleanup() {
  fs.rmSync(dataDir, { recursive: true, force: true });
}

// ─── Test 1: Geo emulation via explore ──────────────────────────

console.log('\n=== Feature 1: Geo Emulation ===');

const { Engine } = await import(path.join(root, 'dist/core/engine.js'));
const { getConfig, loadConfig, ensureDirectories } = await import(path.join(root, 'dist/core/config.js'));

await loadConfig();
await ensureDirectories();
const config = getConfig();
const engine = new Engine(config);

try {
  const result = await engine.explore('https://httpbin.org/get', {
    geo: {
      timezoneId: 'Europe/Paris',
      locale: 'fr-FR',
      geolocation: { latitude: 48.8566, longitude: 2.3522 },
    },
  });
  assert(result.sessionId, 'Explore with geo overrides returns sessionId');
  assert(result.siteId === 'httpbin.org', 'Correct siteId extracted');
  assert(engine.getStatus().mode === 'exploring', 'Engine mode is exploring');
  console.log(`  Session: ${result.sessionId}`);
} catch (err) {
  console.log(`  FAIL: Explore with geo - ${err.message}`);
  failed++;
}

// ─── Test 2: Context override mismatch ──────────────────────────

console.log('\n=== Feature 2: Context Override Mismatch ===');

try {
  await engine.explore('https://httpbin.org/get', {
    geo: { timezoneId: 'Asia/Tokyo', locale: 'ja-JP' },
  });
  console.log('  FAIL: Should have thrown ContextOverrideMismatchError');
  failed++;
} catch (err) {
  assert(err.name === 'ContextOverrideMismatchError', 'Throws ContextOverrideMismatchError');
  assert(err.message.includes('different proxy/geo settings'), 'Error message is descriptive');
}

// ─── Test 3: Force-close during exploring ───────────────────────

console.log('\n=== Feature 3: Force-Close Session ===');

const expectedId = engine.getActiveSessionId();
assert(expectedId !== null, 'Active session ID exists before force-close');

try {
  await engine.multiSessionManager.close('default', { engineMode: 'exploring', force: true });
  engine.resetExploreState(expectedId);
  assert(engine.getStatus().mode === 'idle', 'Engine mode is idle after force-close');
  assert(engine.getActiveSessionId() === null, 'No active session after force-close');
} catch (err) {
  console.log(`  FAIL: Force-close - ${err.message}`);
  failed++;
}

// ─── Test 4: Re-explore with new overrides ──────────────────────

console.log('\n=== Feature 4: Re-Explore with New Overrides ===');

try {
  const result2 = await engine.explore('https://httpbin.org/get', {
    geo: { timezoneId: 'Asia/Tokyo', locale: 'ja-JP' },
  });
  assert(result2.sessionId, 'Re-explore with Tokyo geo succeeds');
  assert(engine.getStatus().mode === 'exploring', 'Engine mode is exploring again');
  console.log(`  New session: ${result2.sessionId}`);
} catch (err) {
  console.log(`  FAIL: Re-explore - ${err.message}`);
  failed++;
}

// Clean up engine
try { await engine.close(); } catch {}

// ─── Test 5: CDP Auto-Discovery ─────────────────────────────────

console.log('\n=== Feature 5: CDP Auto-Discovery ===');

const { discoverCdpPort } = await import(path.join(root, 'dist/browser/cdp-connector.js'));

// No CDP servers running — should return null
const found = await discoverCdpPort({ probeTimeoutMs: 500 });
assert(found === null, 'discoverCdpPort returns null when no CDP servers running');

// connectViaCDP with autoDiscover should throw descriptive error
const { connectViaCDP } = await import(path.join(root, 'dist/browser/cdp-connector.js'));
try {
  await connectViaCDP({ autoDiscover: true });
  console.log('  FAIL: Should have thrown');
  failed++;
} catch (err) {
  assert(err.message.includes('auto-discovery found no endpoints'), 'Auto-discover throws descriptive error');
}

// ─── Test 6: Proxy Validation ───────────────────────────────────

console.log('\n=== Feature 6: Proxy Validation ===');

const { setConfigValue } = await import(path.join(root, 'dist/core/config.js'));

// Valid proxy
try {
  setConfigValue('browser.proxy.server', 'http://proxy.example.com:8080');
  assert(true, 'Valid HTTP proxy accepted');
} catch { assert(false, 'Valid HTTP proxy accepted'); }

try {
  setConfigValue('browser.proxy.server', 'socks5://proxy.example.com:1080');
  assert(true, 'Valid SOCKS5 proxy accepted');
} catch { assert(false, 'Valid SOCKS5 proxy accepted'); }

// Invalid proxy
try {
  setConfigValue('browser.proxy.server', 'not-a-url');
  assert(false, 'Invalid proxy rejected');
} catch {
  assert(true, 'Invalid proxy rejected');
}

try {
  setConfigValue('browser.proxy.server', 'http://proxy.example.com/path?token=secret');
  assert(false, 'Proxy with path/query rejected');
} catch {
  assert(true, 'Proxy with path/query rejected');
}

// ─── Test 7: Geo Validation ────────────────────────────────────

console.log('\n=== Feature 7: Geo Validation ===');

try {
  setConfigValue('browser.geo.timezoneId', 'Europe/Paris');
  assert(true, 'Valid timezone accepted');
} catch { assert(false, 'Valid timezone accepted'); }

try {
  setConfigValue('browser.geo.timezoneId', 'Mars/Olympus');
  assert(false, 'Invalid timezone rejected');
} catch {
  assert(true, 'Invalid timezone rejected');
}

try {
  setConfigValue('browser.geo.locale', 'fr-FR');
  assert(true, 'Valid locale accepted');
} catch { assert(false, 'Valid locale accepted'); }

try {
  setConfigValue('browser.geo.geolocation.latitude', 91);
  assert(false, 'Latitude > 90 rejected');
} catch {
  assert(true, 'Latitude > 90 rejected');
}

try {
  setConfigValue('browser.geo.geolocation.longitude', -181);
  assert(false, 'Longitude < -180 rejected');
} catch {
  assert(true, 'Longitude < -180 rejected');
}

// ─── Test 8: SDK Library Exports ────────────────────────────────

console.log('\n=== Feature 8: SDK Library Exports ===');

const lib = await import(path.join(root, 'dist/lib.js'));
assert(typeof lib.Engine === 'function', 'Engine exported');
assert(typeof lib.BrowserManager === 'function', 'BrowserManager exported');
assert(typeof lib.MultiSessionManager === 'function', 'MultiSessionManager exported');
assert(typeof lib.SkillRepository === 'function', 'SkillRepository exported');
assert(typeof lib.getConfig === 'function', 'getConfig exported');
assert(typeof lib.loadConfig === 'function', 'loadConfig exported');
assert(typeof lib.startMcpServer === 'function', 'startMcpServer exported');
assert(typeof lib.VERSION === 'string', 'VERSION exported');

// ─── Summary ────────────────────────────────────────────────────

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));

await cleanup();
process.exit(failed > 0 ? 1 : 0);
