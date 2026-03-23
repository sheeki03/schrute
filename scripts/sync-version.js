#!/usr/bin/env node
// Syncs version from package.json → src/version.ts + release-adjacent metadata
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
}

// 3. Update the local devcontainer feature metadata when present.
const devcontainerFeaturePath = '.devcontainer/features/cli/devcontainer-feature.json';
if (existsSync(devcontainerFeaturePath)) {
  const feature = JSON.parse(readFileSync(devcontainerFeaturePath, 'utf8'));
  feature.version = version;
  writeFileSync(devcontainerFeaturePath, JSON.stringify(feature, null, 2) + '\n');
}

console.error(`Synced version ${version} to src/version.ts and optional release metadata`);
