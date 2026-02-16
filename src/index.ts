#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { getConfig, loadConfig, setConfigValue, ensureDirectories } from './core/config.js';
import { createLogger, getLogger } from './core/logger.js';
import { Engine, removeStaleSessionJson } from './core/engine.js';
import { getDatabase, closeDatabase } from './storage/database.js';
import { SkillRepository } from './storage/skill-repository.js';
import { SiteRepository } from './storage/site-repository.js';
import { ConfirmationManager } from './server/confirmation.js';
import { runDoctor, formatDoctorReport } from './doctor.js';
import { getTrustPosture, formatTrustReport } from './trust.js';
import { startMcpServer } from './server/mcp-stdio.js';
import { startDaemonServer, type DaemonCloseHandles } from './server/daemon.js';
import { createDaemonClient } from './client/daemon-client.js';
import { validateSkill } from './skill/validator.js';
import type { SkillSpec, SiteManifest, SitePolicy } from './skill/types.js';
import { getSitePolicy } from './core/policy.js';
import { VERSION } from './version.js';
import { ConfigError } from './core/config.js';

const program = new Command();

program
  .name('oneagent')
  .description('Universal Self-Learning Browser Agent')
  .version(VERSION);

// ─── explore ────────────────────────────────────────────────────

program
  .command('explore <url>')
  .description('Open a browser session to explore a website')
  .action(async (url: string) => {
    const config = getConfig();
    createLogger(config.logLevel);
    ensureDirectories(config);

    const client = createDaemonClient(config);
    try {
      const result = await client.request('POST', '/ctl/explore', { url });
      console.log('Explore session started:');
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error('Error:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── record ─────────────────────────────────────────────────────

program
  .command('record')
  .description('Start recording an action frame')
  .requiredOption('--name <name>', 'Name for the action frame')
  .option('--input <pairs...>', 'Input key=value pairs')
  .action(async (options: { name: string; input?: string[] }) => {
    const config = getConfig();
    createLogger(config.logLevel);
    ensureDirectories(config);

    // Parse input pairs
    let inputs: Record<string, string> | undefined;
    if (options.input) {
      inputs = {};
      for (const pair of options.input) {
        const idx = pair.indexOf('=');
        if (idx > 0) {
          inputs[pair.slice(0, idx)] = pair.slice(idx + 1);
        }
      }
    }

    const client = createDaemonClient(config);
    try {
      const result = await client.request('POST', '/ctl/record', { name: options.name, inputs });
      console.log('Recording started:');
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error('Error:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── stop ───────────────────────────────────────────────────────

program
  .command('stop')
  .description('Stop recording and process the action frame')
  .action(async () => {
    const config = getConfig();
    createLogger(config.logLevel);

    const client = createDaemonClient(config);
    try {
      const result = await client.request('POST', '/ctl/stop');
      console.log('Recording stopped:');
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error('Error:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── skills ─────────────────────────────────────────────────────

const skillsCmd = program
  .command('skills')
  .description('Manage skills');

skillsCmd
  .command('list [site]')
  .description('List skills, optionally filtered by site')
  .action((site?: string) => {
    const config = getConfig();
    createLogger(config.logLevel);
    ensureDirectories(config);

    const db = getDatabase(config);
    const skillRepo = new SkillRepository(db);

    let skills;
    if (site) {
      skills = skillRepo.getBySiteId(site);
    } else {
      skills = skillRepo.getAll();
    }

    if (skills.length === 0) {
      console.log('No skills found.');
      closeDatabase();
      return;
    }

    console.log(`Found ${skills.length} skill(s):\n`);
    for (const s of skills) {
      const status = s.status.toUpperCase().padEnd(8);
      console.log(
        `  [${status}] ${s.id} — ${s.method} ${s.pathTemplate} (${(s.successRate * 100).toFixed(0)}% success)`,
      );
    }

    closeDatabase();
  });

skillsCmd
  .command('show <skill_id>')
  .description('Show detailed skill information')
  .action((skillId: string) => {
    const config = getConfig();
    createLogger(config.logLevel);
    ensureDirectories(config);

    const db = getDatabase(config);
    const skillRepo = new SkillRepository(db);
    const skill = skillRepo.getById(skillId);

    if (!skill) {
      console.error(`Skill '${skillId}' not found.`);
      closeDatabase();
      process.exit(1);
    }

    console.log(JSON.stringify(skill, null, 2));
    closeDatabase();
  });

skillsCmd
  .command('validate <skill_id>')
  .description('Trigger validation for a skill')
  .action(async (skillId: string) => {
    const config = getConfig();
    createLogger(config.logLevel);
    ensureDirectories(config);

    const db = getDatabase(config);
    const skillRepo = new SkillRepository(db);
    const skill = skillRepo.getById(skillId);

    if (!skill) {
      console.error(`Skill '${skillId}' not found.`);
      closeDatabase();
      process.exit(1);
    }

    console.log(`Validating skill '${skillId}'...`);
    try {
      const result = await validateSkill(skill, {});
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error('Validation error:', err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }

    closeDatabase();
  });

skillsCmd
  .command('report <skill_id>')
  .description('Generate a full evidence report for a skill')
  .action((skillId: string) => {
    const config = getConfig();
    createLogger(config.logLevel);
    ensureDirectories(config);

    const db = getDatabase(config);
    const skillRepo = new SkillRepository(db);
    const skill = skillRepo.getById(skillId);

    if (!skill) {
      console.error(`Skill '${skillId}' not found.`);
      closeDatabase();
      process.exit(1);
    }

    // Build evidence report from skill data
    const report = {
      skillId: skill.id,
      tierEligibility: {
        currentTier: skill.currentTier,
        tierLock: skill.tierLock,
      },
      parameterEvidence: skill.parameterEvidence ?? [],
      chainSpec: skill.chainSpec,
      sideEffectClass: skill.sideEffectClass,
      validation: skill.validation,
      redaction: skill.redaction,
      confidence: skill.confidence,
      consecutiveValidations: skill.consecutiveValidations,
      successRate: skill.successRate,
      sampleCount: skill.sampleCount,
      lastVerified: skill.lastVerified,
      lastUsed: skill.lastUsed,
    };

    console.log(JSON.stringify(report, null, 2));
    closeDatabase();
  });

// ─── dry-run ────────────────────────────────────────────────────

program
  .command('dry-run <skill_id> [params...]')
  .description('Preview a request for a skill without executing it')
  .action((skillId: string, params: string[]) => {
    const config = getConfig();
    createLogger(config.logLevel);
    ensureDirectories(config);

    const db = getDatabase(config);
    const skillRepo = new SkillRepository(db);
    const skill = skillRepo.getById(skillId);

    if (!skill) {
      console.error(`Skill '${skillId}' not found.`);
      closeDatabase();
      process.exit(1);
    }

    // Parse params as key=value
    const parsedParams: Record<string, string> = {};
    for (const p of params) {
      const idx = p.indexOf('=');
      if (idx > 0) {
        parsedParams[p.slice(0, idx)] = p.slice(idx + 1);
      }
    }

    let url = skill.pathTemplate;
    for (const [key, value] of Object.entries(parsedParams)) {
      url = url.replace(`{${key}}`, encodeURIComponent(value));
    }
    if (!url.startsWith('http')) {
      const domain = skill.allowedDomains[0] ?? skill.siteId;
      url = `https://${domain}${url}`;
    }

    console.log('Dry Run Preview:');
    console.log(JSON.stringify({
      method: skill.method,
      url,
      headers: skill.requiredHeaders ?? {},
      sideEffectClass: skill.sideEffectClass,
      currentTier: skill.currentTier,
      note: 'No request was sent.',
    }, null, 2));

    closeDatabase();
  });

// ─── doctor ─────────────────────────────────────────────────────

program
  .command('doctor')
  .description('Run health checks')
  .action(async () => {
    const config = getConfig();
    createLogger(config.logLevel);
    ensureDirectories(config);

    const report = await runDoctor(config);
    console.log(formatDoctorReport(report));

    if (report.summary.fail > 0) {
      process.exit(1);
    }
  });

// ─── trust ──────────────────────────────────────────────────────

program
  .command('trust')
  .description('Show trust posture report')
  .action(async () => {
    const config = getConfig();
    createLogger(config.logLevel);
    ensureDirectories(config);

    const posture = await getTrustPosture(config);
    console.log('Trust Posture Report');
    console.log('='.repeat(40));
    console.log(formatTrustReport(posture));
  });

// ─── setup ──────────────────────────────────────────────────────

program
  .command('setup')
  .description('Install browser engine and verify keychain')
  .action(async () => {
    const config = getConfig();
    createLogger(config.logLevel);
    ensureDirectories(config);

    console.log('Setting up OneAgent...\n');

    // 1. Ensure directories
    console.log('[1/3] Creating data directories...');
    ensureDirectories(config);
    console.log('  Done.\n');

    // 2. Install browser (engine-aware)
    const engine = config.browser?.engine ?? 'patchright';
    let browserInstallOk = true;
    console.log(`[2/3] Installing browser (engine: ${engine})...`);
    try {
      const { execSync } = await import('node:child_process');
      switch (engine) {
        case 'playwright':
          execSync('npx playwright install chromium', { stdio: 'inherit' });
          break;
        case 'patchright':
          execSync('npx patchright install chromium', { stdio: 'inherit' });
          break;
        case 'camoufox': {
          let camoufoxFound = false;
          try {
            const { createRequire } = await import('node:module');
            const req = createRequire(import.meta.url);
            req.resolve('camoufox-js');
            camoufoxFound = true;
          } catch { /* not installed */ }
          if (!camoufoxFound) {
            console.error('  camoufox-js is not installed.');
            console.error('  Install with: npm install camoufox-js && npx camoufox-js fetch');
            process.exit(1);
          }
          execSync('npx camoufox-js fetch', { stdio: 'inherit' });
          break;
        }
        default:
          console.error(`  Unknown engine: ${engine}`);
          process.exit(1);
      }
      console.log('  Done.\n');
    } catch (err) {
      browserInstallOk = false;
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`  Failed to install browser: ${detail}`);
      console.error(`  Run manually for engine "${engine}"\n`);
    }

    // 3. Verify keychain
    console.log('[3/3] Verifying keychain access...');
    const doctorReport = await runDoctor(config);
    const keychainCheck = doctorReport.checks.find((c) => c.name === 'keychain_access');
    if (keychainCheck?.status === 'pass') {
      console.log('  Keychain OK.\n');
    } else {
      console.error(`  Keychain: ${keychainCheck?.message ?? 'unknown status'}\n`);
    }

    if (!browserInstallOk) {
      console.error('Setup completed with errors — browser install failed.');
      process.exit(1);
    }
    console.log('Setup complete.');
  });

// ─── config ─────────────────────────────────────────────────────

const configCmd = program
  .command('config')
  .description('Manage configuration');

configCmd
  .command('set <key> <value>')
  .description('Set a configuration value')
  .action((key: string, value: string) => {
    try {
      const updated = setConfigValue(key, value);
      console.log(`Set ${key} = ${JSON.stringify((updated as unknown as Record<string, unknown>)[key] ?? value)}`);
    } catch (err) {
      console.error('Error:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

configCmd
  .command('get <key>')
  .description('Get a configuration value')
  .action((key: string) => {
    const config = getConfig();
    const keys = key.split('.');
    let current: unknown = config;

    for (const k of keys) {
      if (current && typeof current === 'object' && k in current) {
        current = (current as Record<string, unknown>)[k];
      } else {
        console.error(`Key '${key}' not found.`);
        process.exit(1);
      }
    }

    console.log(JSON.stringify(current, null, 2));
  });

// ─── serve ──────────────────────────────────────────────────────

program
  .command('serve')
  .description('Start the MCP server (stdio by default, or HTTP with --http)')
  .option('--http', 'Enable HTTP transport (REST + MCP HTTP)')
  .option('--port <port>', 'Port number for HTTP server', '3000')
  .action(async (options: { http?: boolean; port?: string }) => {
    const config = getConfig();
    createLogger(config.logLevel);
    const log = getLogger();
    ensureDirectories(config);

    // Validate HTTP config BEFORE creating any resources (avoids stale daemon artifacts)
    if (options.http || config.server.network) {
      if (!config.features.httpTransport) {
        console.error(
          'Error: HTTP transport is disabled by default.\n' +
          'Enable it with: oneagent config set features.httpTransport true',
        );
        process.exit(1);
      }

      if (!config.server.authToken) {
        console.error(
          'Error: HTTP transport requires an auth token.\n' +
          'Set one with: oneagent config set server.authToken <your-secret>',
        );
        process.exit(1);
      }
    }

    // Create shared deps once
    const engine = new Engine(config);
    const db = getDatabase(config);
    const skillRepo = new SkillRepository(db);
    const siteRepo = new SiteRepository(db);
    const confirmation = new ConfirmationManager(db, config);
    const deps = { engine, skillRepo, siteRepo, confirmation, config };

    // Clean up stale session.json from pre-daemon versions
    removeStaleSessionJson(config);

    // Start daemon control socket (always) — handles populated below
    const closeHandles: DaemonCloseHandles = { mcpCloseHandles: [] };
    const daemon = await startDaemonServer(engine, config, closeHandles);

    if (options.http || config.server.network) {
      const port = parseInt(options.port ?? String(config.server.httpPort ?? 3000), 10);
      const host = '127.0.0.1';

      console.log(`Starting HTTP server on ${host}:${port}...`);

      // Start REST server — uses shared engine/deps (no second Engine instance)
      const { startRestServer } = await import('./server/rest-server.js');
      const restApp = await startRestServer({ host, port, deps });
      console.log(`  REST API:     http://${host}:${port}/api`);
      console.log(`  API Docs:     http://${host}:${port}/api/docs`);
      console.log(`  OpenAPI Spec: http://${host}:${port}/api/openapi.json`);

      // Start MCP HTTP on port+1
      const { startMcpHttpServer } = await import('./server/mcp-http.js');
      config.server.network = true;
      const mcpHttp = await startMcpHttpServer(deps, { host, port: port + 1 });
      console.log(`  MCP HTTP:     http://${host}:${port + 1}/mcp`);

      // Register close handles so daemon's graceful shutdown closes MCP/REST servers
      closeHandles.mcpCloseHandles!.push(mcpHttp, restApp);
    } else {
      // stdio mode — NO HTTP
      const mcpStdio = await startMcpServer(deps);

      // Register close handle so daemon's graceful shutdown closes MCP stdio server
      closeHandles.mcpCloseHandles!.push(mcpStdio);
    }

    // Shared graceful shutdown for both HTTP and stdio modes
    {
      const shutdown = async () => {
        console.log('\nShutting down...');
        await daemon.gracefulShutdown();
        closeDatabase();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    }
  });

// ─── export ─────────────────────────────────────────────────────

program
  .command('export <site>')
  .description('Export skills + manifest + policy as JSON bundle (NO credentials)')
  .option('-o, --output <file>', 'Output file path')
  .action((siteId: string, options: { output?: string }) => {
    const config = getConfig();
    createLogger(config.logLevel);
    ensureDirectories(config);

    const db = getDatabase(config);
    const skillRepo = new SkillRepository(db);
    const siteRepo = new SiteRepository(db);

    // Get site manifest
    const site = siteRepo.getById(siteId);
    if (!site) {
      console.error(`Site '${siteId}' not found.`);
      closeDatabase();
      process.exit(1);
    }

    // Get skills for site
    const skills = skillRepo.getBySiteId(siteId);

    // Strip credential-related fields from skills
    const sanitizedSkills = skills.map((s) => {
      const { requiredHeaders, dynamicHeaders, ...rest } = s;
      return {
        ...rest,
        // Remove auth tokens, cookies, and other credential data
        requiredHeaders: sanitizeHeaders(requiredHeaders),
        dynamicHeaders: sanitizeHeaders(dynamicHeaders),
      };
    });

    // Use shared policy loader (reads from DB with caching, falls back to defaults)
    const policy: SitePolicy = getSitePolicy(siteId, config);

    const bundle = {
      version: '0.2.0',
      exportedAt: new Date().toISOString(),
      site,
      skills: sanitizedSkills,
      policy,
    };

    const json = JSON.stringify(bundle, null, 2);
    const outputPath = options.output ?? `${siteId.replace(/[^a-zA-Z0-9.-]/g, '_')}-export.json`;

    fs.writeFileSync(outputPath, json, 'utf-8');
    console.log(`Exported ${skills.length} skill(s) for site '${siteId}' to ${outputPath}`);
    console.warn(
      'WARNING: Credentials (auth tokens, cookies, keychain data) are NOT included. Re-authentication will be required on import.',
    );

    closeDatabase();
  });

// ─── import ─────────────────────────────────────────────────────

program
  .command('import <file>')
  .description('Import skills + manifest + policy from JSON bundle')
  .action((file: string) => {
    const config = getConfig();
    createLogger(config.logLevel);
    ensureDirectories(config);

    if (!fs.existsSync(file)) {
      console.error(`File '${file}' not found.`);
      process.exit(1);
    }

    let bundle: {
      version: string;
      site: SiteManifest;
      skills: SkillSpec[];
      policy?: SitePolicy;
    };

    try {
      const raw = fs.readFileSync(file, 'utf-8');
      bundle = JSON.parse(raw);
    } catch (err) {
      console.error('Failed to parse bundle:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    // Validate basic structure
    if (!bundle.site || !bundle.skills || !Array.isArray(bundle.skills)) {
      console.error('Invalid bundle format: missing site or skills.');
      process.exit(1);
    }

    const db = getDatabase(config);
    const skillRepo = new SkillRepository(db);
    const siteRepo = new SiteRepository(db);

    // Import site manifest
    const existingSite = siteRepo.getById(bundle.site.id);
    if (existingSite) {
      siteRepo.update(bundle.site.id, bundle.site);
      console.log(`Updated existing site '${bundle.site.id}'.`);
    } else {
      siteRepo.create(bundle.site);
      console.log(`Created site '${bundle.site.id}'.`);
    }

    // Import skills
    let created = 0;
    let updated = 0;
    for (const skill of bundle.skills) {
      const existing = skillRepo.getById(skill.id);
      if (existing) {
        skillRepo.update(skill.id, skill);
        updated++;
      } else {
        skillRepo.create(skill);
        created++;
      }
    }

    console.log(`Imported ${created} new skill(s), updated ${updated} existing skill(s).`);
    console.log('NOTE: Re-authentication may be required — credentials are never exported.');

    closeDatabase();
  });

// ─── discover ───────────────────────────────────────────────────

program
  .command('discover <url>')
  .description('Run cold-start discovery on a URL')
  .action(async (url: string) => {
    const config = getConfig();
    createLogger(config.logLevel);
    ensureDirectories(config);

    console.log(`Discovering APIs at ${url}...`);

    try {
      const { discoverSite } = await import('./discovery/cold-start.js');
      const result = await discoverSite(url, config);

      console.log(`\nSite: ${result.siteId}`);
      console.log(`Sources found: ${result.sources.filter((s) => s.found).length}/${result.sources.length}`);

      for (const source of result.sources) {
        const status = source.found ? 'FOUND' : 'NOT FOUND';
        console.log(`  [${status.padEnd(9)}] ${source.type} (${source.endpointCount} endpoints)`);
      }

      if (result.endpoints.length > 0) {
        console.log(`\nDiscovered ${result.endpoints.length} endpoint(s):\n`);
        for (const ep of result.endpoints) {
          const trust = `trust:${ep.trustLevel}`;
          console.log(`  ${ep.method.padEnd(7)} ${ep.path} [${ep.source}] (${trust})`);
          if (ep.description) {
            console.log(`          ${ep.description}`);
          }
        }
      } else {
        console.log('\nNo endpoints discovered.');
      }
    } catch (err) {
      console.error('Discovery failed:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── Helpers ────────────────────────────────────────────────────

function sanitizeHeaders(
  headers?: Record<string, string>,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const sanitized: Record<string, string> = {};
  const sensitivePatterns = [
    /^authorization$/i,
    /^cookie$/i,
    /^set-cookie$/i,
    /^x-api-key$/i,
    /^x-auth/i,
    /^x-csrf/i,
    /^x-session/i,
    /token/i,
    /secret/i,
    /credential/i,
  ];

  for (const [key, value] of Object.entries(headers)) {
    const isSensitive = sensitivePatterns.some((p) => p.test(key));
    if (isSensitive) {
      sanitized[key] = '<REDACTED>';
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

// ─── Parse ──────────────────────────────────────────────────────

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
