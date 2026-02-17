#!/usr/bin/env node
// Syncs version from package.json → src/version.ts + .claude-plugin/plugin.json
import { readFileSync, writeFileSync, existsSync } from 'fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = pkg.version;

// 1. Update src/version.ts (always — this is the critical sync target)
const versionTs = `// Auto-updated by scripts/sync-version.js — do not edit manually\nexport const VERSION = '${version}';\n`;
writeFileSync('src/version.ts', versionTs);

// 2. Update .claude-plugin/plugin.json (guarded — may not exist in CI/subpackages)
const pluginPath = '.claude-plugin/plugin.json';
if (existsSync(pluginPath)) {
  const plugin = JSON.parse(readFileSync(pluginPath, 'utf8'));
  plugin.version = version;
  writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + '\n');
  console.error(`Synced version ${version} to src/version.ts + plugin.json`);
} else {
  console.error(`Synced version ${version} to src/version.ts (plugin.json not found — skipping)`);
}
