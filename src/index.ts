#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { getConfig, loadConfig, setConfigValue, ensureDirectories } from './core/config.js';
import { createLogger, getLogger } from './core/logger.js';
import { Engine } from './core/engine.js';
import { getDatabase, closeDatabase } from './storage/database.js';
import { SkillRepository } from './storage/skill-repository.js';
import { SiteRepository } from './storage/site-repository.js';
import { runDoctor, formatDoctorReport } from './doctor.js';
import { getTrustPosture, formatTrustReport } from './trust.js';
import { startMcpServer } from './server/mcp-stdio.js';
import { validateSkill } from './skill/validator.js';
import { SkillStatus } from './skill/types.js';
import type { SkillSpec, SiteManifest, SitePolicy, CapabilityName } from './skill/types.js';

const program = new Command();

program
  .name('oneagent')
  .description('Universal Self-Learning Browser Agent')
  .version('0.1.0');

// ─── explore ────────────────────────────────────────────────────

program
  .command('explore <url>')
  .description('Open a browser session to explore a website')
  .action(async (url: string) => {
    const config = getConfig();
    createLogger(config.logLevel);
    ensureDirectories(config);

    const engine = new Engine(config);
    try {
      const result = await engine.explore(url);
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

    const engine = new Engine(config);

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

    try {
      const result = await engine.startRecording(options.name, inputs);
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

    const engine = new Engine(config);
    try {
      const result = await engine.stopRecording();
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
      skills = [
        ...skillRepo.getByStatus(SkillStatus.ACTIVE),
        ...skillRepo.getByStatus(SkillStatus.DRAFT),
        ...skillRepo.getByStatus(SkillStatus.STALE),
        ...skillRepo.getByStatus(SkillStatus.BROKEN),
      ];
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
  .description('Download Playwright chromium and verify keychain')
  .action(async () => {
    const config = getConfig();
    createLogger(config.logLevel);
    ensureDirectories(config);

    console.log('Setting up OneAgent...\n');

    // 1. Ensure directories
    console.log('[1/3] Creating data directories...');
    ensureDirectories(config);
    console.log('  Done.\n');

    // 2. Install Playwright Chromium
    console.log('[2/3] Installing Playwright Chromium...');
    try {
      const { execSync } = await import('node:child_process');
      execSync('npx playwright install chromium', { stdio: 'inherit' });
      console.log('  Done.\n');
    } catch {
      console.error('  Failed to install Chromium. Run manually: npx playwright install chromium\n');
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

    if (options.http || config.server.network) {
      // Hard v0.1 gate — HTTP transport is physically excluded from v0.1 builds
      const BUILD_PROFILE = process.env.ONEAGENT_BUILD_PROFILE ?? 'v01';
      if (BUILD_PROFILE === 'v01') {
        console.error(
          'Error: HTTP transport is not available in v0.1 builds.\n' +
          'HTTP/REST/OpenAPI transport requires v0.2.',
        );
        process.exit(1);
      }

      // v0.2 HTTP transport requires the feature flag
      if (!config.features.httpTransport) {
        console.error(
          'Error: HTTP transport is a v0.2 feature and is disabled by default.\n' +
          'Enable it with: oneagent config set features.httpTransport true',
        );
        process.exit(1);
      }

      // HTTP transport requires an auth token
      if (!config.server.authToken) {
        console.error(
          'Error: HTTP transport requires an auth token.\n' +
          'Set one with: oneagent config set server.authToken <your-secret>',
        );
        process.exit(1);
      }

      const port = parseInt(options.port ?? '3000', 10);
      const host = '127.0.0.1';

      console.log(`Starting HTTP server on ${host}:${port}...`);

      // Start REST server
      const { startRestServer } = await import('./server/rest-server.js');
      const restApp = await startRestServer({ host, port });
      console.log(`  REST API:     http://${host}:${port}/api`);
      console.log(`  API Docs:     http://${host}:${port}/api/docs`);
      console.log(`  OpenAPI Spec: http://${host}:${port}/api/openapi.json`);

      // Start MCP HTTP on port+1
      try {
        const { startMcpHttpServer } = await import('./server/mcp-http.js');
        // Temporarily enable network for MCP HTTP
        config.server.network = true;
        const mcpHttp = await startMcpHttpServer({ host, port: port + 1 });
        console.log(`  MCP HTTP:     http://${host}:${port + 1}/mcp`);

        // Graceful shutdown
        const shutdown = async () => {
          console.log('\nShutting down...');
          await mcpHttp.close();
          await restApp.close();
          process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      } catch (err) {
        log.warn({ err }, 'MCP HTTP transport not started');
        // REST still running, set up shutdown for REST only
        const shutdown = async () => {
          console.log('\nShutting down...');
          await restApp.close();
          process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      }
    } else {
      // Default: stdio only
      await startMcpServer();
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

    // Read the actual policy from the policies table
    const policyRow = db.get<{
      site_id: string;
      allowed_methods: string;
      max_qps: number;
      max_concurrent: number;
      read_only_default: number;
      require_confirmation: string;
      domain_allowlist: string | null;
      redaction_rules: string;
      capabilities: string;
    }>('SELECT * FROM policies WHERE site_id = ?', siteId);

    const policy: SitePolicy = policyRow
      ? {
          siteId: policyRow.site_id,
          allowedMethods: JSON.parse(policyRow.allowed_methods) as string[],
          maxQps: policyRow.max_qps,
          maxConcurrent: policyRow.max_concurrent,
          readOnlyDefault: policyRow.read_only_default === 1,
          requireConfirmation: JSON.parse(policyRow.require_confirmation) as string[],
          domainAllowlist: policyRow.domain_allowlist ? JSON.parse(policyRow.domain_allowlist) as string[] : [],
          redactionRules: JSON.parse(policyRow.redaction_rules) as string[],
          capabilities: JSON.parse(policyRow.capabilities) as CapabilityName[],
        }
      : {
          siteId,
          allowedMethods: ['GET', 'HEAD', 'POST:read-only'],
          maxQps: 1,
          maxConcurrent: 1,
          readOnlyDefault: true,
          requireConfirmation: [],
          domainAllowlist: [],
          redactionRules: [],
          capabilities: [] as CapabilityName[],
        };

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

program.parse(process.argv);
