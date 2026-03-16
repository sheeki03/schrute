#!/usr/bin/env node
import * as fs from 'node:fs';
import { Command } from 'commander';
import { getConfig, setConfigValue, ensureDirectories } from './core/config.js';
import { createLogger } from './core/logger.js';
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
import { RemoteClient } from './client/remote-client.js';
import { validateSkill } from './skill/validator.js';
import { validateImportableSkill, validateImportableSite } from './storage/import-validator.js';
import type { SkillSpec, SiteManifest, SitePolicy } from './skill/types.js';
import { getSitePolicy } from './core/policy.js';
import { VERSION } from './version.js';
import { ConfigError } from './core/config.js';

const program = new Command();

program
  .name('schrute')
  .description('Universal Self-Learning Browser Agent')
  .version(VERSION)
  .option('--url <url>', 'Remote Schrute server URL (skips local daemon)')
  .option('--token <token>', 'Auth token for remote server')
  .option('--json', 'Output results as JSON');

// ─── Helper: get remote client from global opts ─────────────────

function getRemoteClient(): RemoteClient | null {
  const opts = program.opts<{ url?: string; token?: string; json?: boolean }>();
  if (!opts.url) return null;
  return new RemoteClient(opts.url, opts.token);
}

function outputResult(data: unknown): void {
  const opts = program.opts<{ json?: boolean }>();
  if (opts.json) {
    // Raw JSON for piping/scripting
    console.log(JSON.stringify(data));
  } else {
    // Pretty-printed for human consumption
    console.log(JSON.stringify(data, null, 2));
  }
}

// ─── explore ────────────────────────────────────────────────────

program
  .command('explore <url>')
  .description('Open a browser session to explore a website')
  .addHelpText('after', '\n(requires local daemon or --url)')
  .action(async (url: string) => {
    const remote = getRemoteClient();
    if (remote) {
      try {
        const result = await remote.explore(url);
        outputResult(result);
      } catch (err) {
        console.error('Error:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      return;
    }

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

// ─── status ─────────────────────────────────────────────────────

program
  .command('status')
  .description('Show server status')
  .addHelpText('after', '\n(requires local daemon or --url)')
  .action(async () => {
    const remote = getRemoteClient();
    if (remote) {
      try {
        const result = await remote.getStatus();
        outputResult(result);
      } catch (err) {
        console.error('Error:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      return;
    }

    const config = getConfig();
    createLogger(config.logLevel);

    const client = createDaemonClient(config);
    try {
      const result = await client.request('GET', '/ctl/status');
      outputResult(result);
    } catch (err) {
      console.error('Error:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── sessions ───────────────────────────────────────────────────

program
  .command('sessions')
  .description('List active sessions')
  .addHelpText('after', '\n(requires local daemon or --url)')
  .action(async () => {
    const remote = getRemoteClient();
    if (remote) {
      try {
        const result = await remote.listSessions();
        outputResult(result);
      } catch (err) {
        console.error('Error:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      return;
    }

    const config = getConfig();
    createLogger(config.logLevel);

    const client = createDaemonClient(config);
    try {
      const result = await client.request('GET', '/ctl/sessions');
      outputResult(result);
    } catch (err) {
      console.error('Error:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── record ─────────────────────────────────────────────────────

program
  .command('record')
  .description('Start recording an action frame')
  .addHelpText('after', '\n(requires local daemon or --url)')
  .requiredOption('--name <name>', 'Name for the action frame')
  .option('--input <pairs...>', 'Input key=value pairs')
  .action(async (options: { name: string; input?: string[] }) => {
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

    const remote = getRemoteClient();
    if (remote) {
      try {
        const result = await remote.startRecording(options.name, inputs);
        outputResult(result);
      } catch (err) {
        console.error('Error:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      return;
    }

    const config = getConfig();
    createLogger(config.logLevel);
    ensureDirectories(config);

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
  .addHelpText('after', '\n(requires local daemon or --url)')
  .action(async () => {
    const remote = getRemoteClient();
    if (remote) {
      try {
        const result = await remote.stopRecording();
        outputResult(result);
      } catch (err) {
        console.error('Error:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      return;
    }

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
  .description('Manage skills')
  .action(async () => {
    // Default to 'list' when no subcommand given
    await skillsCmd.commands.find((c: Command) => c.name() === 'list')?.parseAsync([], { from: 'user' });
  });

skillsCmd
  .command('list [site]')
  .description('List skills, optionally filtered by site')
  .action(async (site?: string) => {
    const remote = getRemoteClient();
    if (remote) {
      try {
        const result = await remote.listSkills(site ?? undefined);
        outputResult(result);
      } catch (err) {
        console.error('Error:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      return;
    }

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

    if (program.opts().json) {
      outputResult(skills);
      closeDatabase();
      return;
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
        `  [${status}] ${s.id} — ${s.method} ${s.pathTemplate} (${(s.successRate * 100).toFixed(0)}% success, ${s.currentTier}${s.avgLatencyMs ? `, ${s.avgLatencyMs}ms` : ''})`,
      );
    }

    closeDatabase();
  });

skillsCmd
  .command('search [query]')
  .description('Search skills by query')
  .option('--limit <n>', 'Max results', '20')
  .action(async (query?: string, options?: { limit?: string }) => {
    const remote = getRemoteClient();
    if (remote) {
      try {
        const limit = options?.limit ? parseInt(options.limit, 10) : undefined;
        const result = await remote.searchSkills(query, limit);
        outputResult(result);
      } catch (err) {
        console.error('Error:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      return;
    }

    // Local: read DB directly (no daemon needed — same as skills list)
    const config = getConfig();
    createLogger(config.logLevel);
    ensureDirectories(config);

    const { rankToolsByIntent, skillToToolDefinition } = await import('./server/tool-registry.js');
    const { SkillStatus } = await import('./skill/types.js');
    const { findInactiveMatches } = await import('./server/skill-helpers.js');
    const db = getDatabase(config);
    const skillRepo = new SkillRepository(db);
    const limit = options?.limit ? parseInt(options.limit, 10) : 20;

    // Use FTS when a query is provided for better relevance ranking
    let results: SkillSpec[];
    if (query) {
      const { skills: ftsResults } = skillRepo.searchFts(query, { limit });
      results = ftsResults.length > 0
        ? ftsResults.filter(s => s.status === SkillStatus.ACTIVE).slice(0, limit)
        : rankToolsByIntent(skillRepo.getByStatus(SkillStatus.ACTIVE), query, limit);
    } else {
      results = skillRepo.getByStatus(SkillStatus.ACTIVE).slice(0, limit);
    }

    // P2-3: Surface inactive matches
    const inactiveMatches = findInactiveMatches(skillRepo, query, limit);

    if (program.opts().json) {
      outputResult({ results: results.map(s => ({ id: s.id, name: s.name, method: s.method, pathTemplate: s.pathTemplate, successRate: s.successRate })), inactiveMatches });
      closeDatabase();
      return;
    }

    if (results.length === 0) {
      console.log('No matching skills found.');
    } else {
      console.log(`Found ${results.length} matching skill(s):\n`);
      for (const s of results) {
        const toolDef = skillToToolDefinition(s);
        const desc = toolDef.description ? ` — ${toolDef.description.slice(0, 80)}` : '';
        console.log(`  ${s.id}${desc}`);
      }
    }

    if (inactiveMatches.length > 0) {
      const labels = inactiveMatches.map(s => `${s.id} [${s.status}]`).join(', ');
      console.log(`\n  Also found (inactive): ${labels}`);
    }

    closeDatabase();
  });

skillsCmd
  .command('show <skill_id>')
  .description('Show detailed skill information')
  .option('-v, --verbose', 'Show detailed parameter evidence')
  .action(async (skillId: string, options?: { verbose?: boolean }) => {
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

    // Include recent execution metrics for diagnostic context
    const { MetricsRepository: MetricsRepo } = await import('./storage/metrics-repository.js');
    const metricsRepo = new MetricsRepo(db);
    const recentMetrics = metricsRepo.getRecentBySkillId(skillId, 5);
    const lastFailure = recentMetrics.find((m: { success: boolean; errorType?: string }) => !m.success);

    const output: Record<string, unknown> = { ...skill };
    if (!options?.verbose) {
      delete output.parameterEvidence;
    }
    if (recentMetrics.length > 0) {
      output.recentExecutions = recentMetrics;
    }
    if (lastFailure?.errorType) {
      output.lastFailureReason = lastFailure.errorType;
    }

    // Build whyNotDirect
    let whyNotDirect: string | undefined;
    if (skill.currentTier === 'tier_1') {
      // skip — already direct
    } else if (skill.tierLock?.type === 'permanent') {
      whyNotDirect = `Permanently locked: ${skill.tierLock.reason}`;
    } else if ((skill.directCanaryAttempts ?? 0) > 0 && !skill.directCanaryEligible) {
      whyNotDirect = `Direct canary failed (${skill.lastCanaryErrorType ?? 'unknown'}). ${skill.directCanaryAttempts} attempts.`;
    } else if (skill.directCanaryEligible) {
      whyNotDirect = 'Ready for direct canary on next execution';
    } else {
      whyNotDirect = 'Waiting for browser validations';
    }

    if (whyNotDirect) {
      output.whyNotDirect = whyNotDirect;
    }
    if (skill.avgLatencyMs) {
      output.performance = `avg ${skill.avgLatencyMs}ms (${skill.lastSuccessfulTier ?? 'unknown'})`;
    }

    console.log(JSON.stringify(output, null, 2));
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

skillsCmd
  .command('delete <skill_id>')
  .description('Permanently delete a skill')
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
    skillRepo.delete(skillId);
    console.log(`Deleted skill '${skillId}' (${skill.name}).`);
    closeDatabase();
  });

skillsCmd
  .command('revoke <skill_id>')
  .description('Revoke permanent approval for a skill')
  .action(async (skillId: string) => {
    const remote = getRemoteClient();
    if (remote) {
      try {
        const result = await remote.revokeApproval(skillId);
        outputResult(result);
      } catch (err) {
        console.error('Error:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      return;
    }

    const config = getConfig();
    createLogger(config.logLevel);
    ensureDirectories(config);

    // Try daemon first
    const client = createDaemonClient(config);
    const available = await client.isAvailable();
    if (available) {
      try {
        const result = await client.request('POST', '/ctl/revoke', { skillId });
        outputResult(result);
      } catch (err) {
        console.error('Error:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      return;
    }

    // Direct DB access
    const db = getDatabase(config);
    const skillRepo = new SkillRepository(db);
    const skill = skillRepo.getById(skillId);
    if (!skill) {
      console.error(`Skill '${skillId}' not found.`);
      closeDatabase();
      process.exit(1);
    }

    const confirmation = new ConfirmationManager(db, config);
    confirmation.revokeApproval(skillId);
    console.log(`Approval revoked for '${skillId}'. Next execution will require confirmation.`);
    closeDatabase();
  });

skillsCmd
  .command('amendments <skillId>')
  .description('List amendments for a skill')
  .action(async (skillId: string) => {
    const remote = getRemoteClient();
    if (remote) {
      try {
        const result = await remote.request('GET', `/skills/${encodeURIComponent(skillId)}/amendments`);
        outputResult(result);
      } catch (err) {
        console.error('Error:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      return;
    }
    const config = getConfig();
    createLogger(config.logLevel);
    const client = createDaemonClient(config);
    try {
      const result = await client.request('GET', `/ctl/amendments?skillId=${encodeURIComponent(skillId)}`);
      outputResult(result);
    } catch (err) {
      console.error('Error:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

skillsCmd
  .command('optimize <skillId>')
  .description('Run GEPA offline optimization on a skill')
  .action(async (skillId: string) => {
    const remote = getRemoteClient();
    if (remote) {
      try {
        const result = await remote.request('POST', `/skills/${encodeURIComponent(skillId)}/optimize`);
        outputResult(result);
      } catch (err) {
        console.error('Error:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      return;
    }
    const config = getConfig();
    createLogger(config.logLevel);
    const client = createDaemonClient(config);
    try {
      const result = await client.request('POST', '/ctl/optimize', { skillId });
      outputResult(result);
    } catch (err) {
      console.error('Error:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── execute ────────────────────────────────────────────────────

program
  .command('execute <skillId> [params...]')
  .description('Execute a skill by ID')
  .addHelpText('after', '\n(requires local daemon or --url)')
  .option('--yes', 'Auto-confirm and permanently approve the skill')
  .option('--json', 'Output as JSON')
  .action(async (skillId: string, paramPairs: string[], options: { yes?: boolean; json?: boolean }) => {
    // Parse key=value params
    const params: Record<string, unknown> = {};
    for (const pair of paramPairs) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) {
        console.error(`Invalid param format: '${pair}'. Use key=value.`);
        process.exit(1);
      }
      const key = pair.slice(0, eqIdx);
      let value: unknown = pair.slice(eqIdx + 1);
      // Try to parse as JSON for complex values
      try { value = JSON.parse(value as string); } catch { /* keep as string */ }
      params[key] = value;
    }

    const remote = getRemoteClient();
    if (remote) {
      // Remote mode
      try {
        let result = await remote.executeSkill(skillId, params);
        // Handle confirmation flow
        const data = result as Record<string, unknown>;
        if (data.status === 'confirmation_required') {
          if (!options.yes) {
            console.log(`Skill '${skillId}' requires confirmation.`);
            console.log(`  Side effect: ${data.sideEffectClass}`);
            console.log(`  Method: ${data.method} ${data.pathTemplate}`);
            console.log(`Use --yes to permanently approve and execute, or confirm via MCP/REST.`);
            process.exit(0);
          }
          // Auto-confirm
          await remote.confirm(data.confirmationToken as string, true);
          console.log(`Skill '${skillId}' permanently approved for execution.`);
          result = await remote.executeSkill(skillId, params);
        }
        outputResult(result);
      } catch (err) {
        console.error('Error:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      return;
    }

    // Local mode — go through daemon
    try {
      const daemonClient = createDaemonClient(getConfig());
      let result = await daemonClient.request('POST', '/ctl/execute', { skillId, params });
      const data = result as Record<string, unknown>;
      if (data.status === 'confirmation_required') {
        if (!options.yes) {
          console.log(`Skill '${skillId}' requires confirmation.`);
          console.log(`  Side effect: ${data.sideEffectClass}`);
          console.log(`  Method: ${data.method} ${data.pathTemplate}`);
          console.log(`Use --yes to permanently approve and execute, or confirm via MCP/REST.`);
          process.exit(0);
        }
        await daemonClient.request('POST', '/ctl/confirm', { token: data.confirmationToken, approve: true });
        console.log(`Skill '${skillId}' permanently approved for execution.`);
        result = await daemonClient.request('POST', '/ctl/execute', { skillId, params });
      }
      outputResult(result);
    } catch (err) {
      console.error('Error:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── sites ──────────────────────────────────────────────────────

const sitesCmd = program
  .command('sites')
  .description('Manage sites')
  .action(async () => {
    // Default to 'list' when no subcommand given
    await sitesCmd.commands.find((c: Command) => c.name() === 'list')?.parseAsync([], { from: 'user' });
  });

sitesCmd
  .command('list')
  .description('List all known sites')
  .action(async () => {
    const remote = getRemoteClient();
    if (remote) {
      try {
        const result = await remote.listSites();
        outputResult(result);
      } catch (err) {
        console.error('Error:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      return;
    }

    // Local: read DB directly
    const config = getConfig();
    createLogger(config.logLevel);
    ensureDirectories(config);
    const db = getDatabase(config);
    const siteRepo = new SiteRepository(db);
    const skillRepo = new SkillRepository(db);
    const sites = siteRepo.getAll();

    if (sites.length === 0) {
      console.log('No sites found.');
      closeDatabase();
      return;
    }

    if (program.opts().json) {
      outputResult(sites);
      closeDatabase();
      return;
    }

    console.log(`Found ${sites.length} site(s):\n`);
    for (const site of sites) {
      const skillCount = skillRepo.getBySiteId(site.id).length;
      const lastVisited = new Date(site.lastVisited).toISOString().split('T')[0];
      console.log(`  ${site.id} — ${site.masteryLevel} — ${skillCount} skills — last visited ${lastVisited}`);
    }
    closeDatabase();
  });

sitesCmd
  .command('delete <siteId>')
  .description('Delete a site and all its skills')
  .action((siteId: string) => {
    const config = getConfig();
    createLogger(config.logLevel);
    ensureDirectories(config);
    const db = getDatabase(config);
    const siteRepo = new SiteRepository(db);
    const site = siteRepo.getById(siteId);
    if (!site) {
      console.error(`Site '${siteId}' not found.`);
      closeDatabase();
      process.exit(1);
    }
    // Delete skills first, then site
    const skillRepo = new SkillRepository(db);
    const skills = skillRepo.getBySiteId(siteId);
    for (const skill of skills) {
      skillRepo.delete(skill.id);
    }
    siteRepo.delete(siteId);
    console.log(`Deleted site '${siteId}' and ${skills.length} associated skill(s).`);
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

    if (program.opts().json) {
      outputResult(report);
      if (report.summary.fail > 0) process.exit(1);
      return;
    }

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

    if (program.opts().json) {
      outputResult(posture);
      return;
    }

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

    console.log('Setting up Schrute...\n');

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

    // Mask sensitive leaf values
    const lastKey = keys[keys.length - 1];
    current = maskConfigValue(lastKey, current);
    console.log(JSON.stringify(current, null, 2));
  });

configCmd
  .command('list')
  .description('List all configuration values')
  .action(() => {
    const config = getConfig();
    const masked = maskConfigObject(config as unknown as Record<string, unknown>);
    if (program.opts().json) {
      outputResult(masked);
      return;
    }
    console.log(JSON.stringify(masked, null, 2));
  });

// ─── serve ──────────────────────────────────────────────────────

program
  .command('serve')
  .description('Start the MCP server (stdio by default, or HTTP with --http)')
  .option('--http', 'Enable HTTP transport (REST + MCP HTTP)')
  .option('--port <port>', 'Port number for HTTP server', '3000')
  .option('--no-daemon', 'Skip starting the daemon control socket')
  .action(async (options: { http?: boolean; port?: string; daemon?: boolean }) => {
    const config = getConfig();
    createLogger(config.logLevel);
    ensureDirectories(config);

    // --http flag implies features.httpTransport (in-memory only, not persisted)
    if (options.http) {
      config.features.httpTransport = true;
    }

    // Validate HTTP config BEFORE creating any resources (avoids stale daemon artifacts)
    if (options.http || config.server.network) {
      if (!config.features.httpTransport) {
        console.error(
          'Error: HTTP transport is disabled by default.\n' +
          'Enable it with: schrute config set features.httpTransport true',
        );
        process.exit(1);
      }

      if (!config.server.authToken) {
        console.error(
          'Error: HTTP transport requires an auth token.\n' +
          'Set one with: schrute config set server.authToken <your-secret>',
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

    // Daemon is optional — only needed for CLI control of a running server
    let daemon: Awaited<ReturnType<typeof startDaemonServer>> | null = null;
    const closeHandles: DaemonCloseHandles = { mcpCloseHandles: [] };

    if (options.daemon !== false) {
      daemon = await startDaemonServer(engine, config, closeHandles);
    }

    if (options.http || config.server.network) {
      const port = parseInt(options.port ?? String(config.server.httpPort ?? 3000), 10);
      const host = config.server.network ? '0.0.0.0' : '127.0.0.1';

      console.log(`Starting HTTP server on ${host}:${port}...`);

      // Start REST server — uses shared engine/deps (no second Engine instance)
      const { startRestServer } = await import('./server/rest-server.js');
      const restApp = await startRestServer({ host, port, deps });
      console.log(`  REST API:     http://${host}:${port}/api`);
      console.log(`  API Docs:     http://${host}:${port}/api/docs`);
      console.log(`  OpenAPI Spec: http://${host}:${port}/api/openapi.json`);

      // Start MCP HTTP on port+1
      const { startMcpHttpServer } = await import('./server/mcp-http.js');
      const mcpHttpDeps = { ...deps, config: { ...config, server: { ...config.server, network: true } } };
      const mcpHttp = await startMcpHttpServer(mcpHttpDeps, { host, port: port + 1 });
      console.log(`  MCP HTTP:     http://${host}:${port + 1}/mcp`);
      if (daemon) {
        const transport = daemon.transport;
        if (transport.mode === 'uds') {
          console.log(`  Daemon:       ${transport.socketPath}`);
        } else {
          console.log(`  Daemon:       tcp://127.0.0.1:${transport.port}`);
        }
      }

      // Register close handles so daemon's graceful shutdown closes MCP/REST servers
      closeHandles.mcpCloseHandles!.push(mcpHttp, restApp);
    } else {
      // stdio mode — NO HTTP
      const mcpStdio = await startMcpServer(deps);
      console.error('MCP stdio server: listening on stdin/stdout');
      if (daemon) {
        const transport = daemon.transport;
        if (transport.mode === 'uds') {
          console.error(`Daemon control: ${transport.socketPath}`);
        } else {
          console.error(`Daemon control: tcp://127.0.0.1:${transport.port}`);
        }
      }

      // Register close handle so daemon's graceful shutdown closes MCP stdio server
      closeHandles.mcpCloseHandles!.push(mcpStdio);
    }

    // Shared graceful shutdown for both HTTP and stdio modes
    {
      const shutdown = async () => {
        console.log('\nShutting down...');
        if (daemon) {
          await daemon.gracefulShutdown();
        } else {
          // No daemon — close MCP handles directly
          for (const handle of closeHandles.mcpCloseHandles ?? []) {
            try { await handle.close(); } catch (err) { console.warn('MCP close error:', err); }
          }
          await engine.close();
        }
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
      note: 'Metrics and execution history are not included. Skills will start with fresh stats on import.',
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

    // ── Validate site before touching DB ──────────────────────────
    const siteResult = validateImportableSite(bundle.site);
    if (!siteResult.valid) {
      console.error(`Site validation failed:\n  ${siteResult.errors.join('\n  ')}`);
      process.exit(1);
    }

    // ── Validate each skill; warn + skip invalid ones ─────────────
    const validSkills: typeof bundle.skills = [];
    const expectedSiteId = bundle.site.id;

    for (const skill of bundle.skills) {
      const skillResult = validateImportableSkill(skill);
      if (!skillResult.valid) {
        const label = (skill as unknown as Record<string, unknown>).id ?? '(unknown)';
        console.warn(
          `Warning: skill '${label}' failed validation — skipping.\n  ${skillResult.errors.join('\n  ')}`,
        );
        continue;
      }

      // Preflight: empty allowedDomains
      if (Array.isArray(skill.allowedDomains) && skill.allowedDomains.length === 0) {
        console.warn(
          `Warning: skill '${skill.id}' has no allowedDomains — may not execute without a domain policy.`,
        );
      }

      // Preflight: siteId consistency
      if (skill.siteId !== expectedSiteId) {
        console.warn(
          `Warning: skill '${skill.id}' has siteId '${skill.siteId}', expected '${expectedSiteId}'. Skipping.`,
        );
        continue;
      }

      validSkills.push(skill);
    }

    // ── Open DB ───────────────────────────────────────────────────
    const db = getDatabase(config);
    const skillRepo = new SkillRepository(db);
    const siteRepo = new SiteRepository(db);

    // Import site manifest (wrap getById in try-catch for corrupt rows)
    let existingSite: SiteManifest | undefined;
    try {
      existingSite = siteRepo.getById(bundle.site.id);
    } catch (err) {
      console.warn(
        `Warning: existing site '${bundle.site.id}' has corrupt data — will overwrite.`,
      );
      existingSite = undefined;
    }

    if (existingSite) {
      siteRepo.update(bundle.site.id, bundle.site);
      console.log(`Updated existing site '${bundle.site.id}'.`);
    } else {
      // If the row exists but was corrupt, delete it first to avoid INSERT OR IGNORE keeping the old row
      try { siteRepo.delete(bundle.site.id); } catch (_err) { /* row may not exist */ }
      siteRepo.create(bundle.site);
      console.log(`Created site '${bundle.site.id}'.`);
    }

    // Import valid skills — ensure required NOT NULL DB fields are populated with defaults.
    // SkillRepository.create() passes all fields explicitly (no DB DEFAULT fallback),
    // so every NOT NULL column needs a value.
    const now = Date.now();
    for (const skill of validSkills) {
      // name is NOT NULL — derive from id (format: "site_id.skill_name.vN")
      if (!skill.name) {
        const parts = skill.id.split('.');
        skill.name = parts.length >= 2 ? parts[parts.length - 2] : skill.id;
      }
      if (skill.inputSchema === undefined) skill.inputSchema = {};
      if (skill.sideEffectClass === undefined) skill.sideEffectClass = 'read-only';
      if (skill.currentTier === undefined) skill.currentTier = 'tier_3';
      if (skill.status === undefined) skill.status = 'draft';
      if (skill.confidence === undefined) skill.confidence = 0;
      if (skill.consecutiveValidations === undefined) skill.consecutiveValidations = 0;
      if (skill.sampleCount === undefined) skill.sampleCount = 0;
      if (skill.successRate === undefined) skill.successRate = 0;
      if (skill.version === undefined) skill.version = 1;
      if (skill.allowedDomains === undefined) skill.allowedDomains = [];
      if (skill.isComposite === undefined) skill.isComposite = false;
      if (skill.directCanaryEligible === undefined) skill.directCanaryEligible = false;
      if (skill.directCanaryAttempts === undefined) skill.directCanaryAttempts = 0;
      if (skill.validationsSinceLastCanary === undefined) skill.validationsSinceLastCanary = 0;
      if (skill.createdAt === undefined) skill.createdAt = now;
      if (skill.updatedAt === undefined) skill.updatedAt = now;
    }
    let created = 0;
    let updated = 0;
    for (const skill of validSkills) {
      let existingSkill: SkillSpec | undefined;
      try {
        existingSkill = skillRepo.getById(skill.id);
      } catch (err) {
        console.warn(
          `Warning: existing skill '${skill.id}' has corrupt data — will overwrite.`,
        );
        existingSkill = undefined;
      }

      if (existingSkill) {
        skillRepo.update(skill.id, skill);
        updated++;
      } else {
        // If the row exists but was corrupt, delete it first
        try { skillRepo.delete(skill.id); } catch (_err) { /* row may not exist */ }
        skillRepo.create(skill);
        created++;
      }
    }

    if (updated > 0) {
      console.log(`Will overwrite ${updated} existing skill(s).`);
    }

    console.log(`Imported ${created} new skill(s), updated ${updated} existing skill(s).`);
    const hasAuthSkills = validSkills.some((s: SkillSpec) => s.authType != null);
    if (hasAuthSkills) {
      console.log('NOTE: Re-authentication may be required — credentials are never exported.');
    }

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

const SENSITIVE_CONFIG_KEY = /token|secret|password|key/i;

function maskConfigValue(key: string, value: unknown): unknown {
  if (typeof value === 'string' && SENSITIVE_CONFIG_KEY.test(key) && value.length > 0) {
    return value.slice(0, 4) + '***';
  }
  return value;
}

function maskConfigObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = maskConfigObject(value as Record<string, unknown>);
    } else {
      result[key] = maskConfigValue(key, value);
    }
  }
  return result;
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
