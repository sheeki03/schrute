#!/usr/bin/env node
import * as fs from 'node:fs';
import * as readline from 'node:readline';
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

function getRemoteClient(cmdOpts?: { url?: string; token?: string }): RemoteClient | null {
  const globalOpts = program.opts<{ url?: string; token?: string; json?: boolean }>();
  const url = cmdOpts?.url ?? globalOpts.url;
  const token = cmdOpts?.token ?? globalOpts.token;
  if (!url) return null;
  return new RemoteClient(url, token);
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

// ─── Helper: progress indicator ─────────────────────────────────

function startProgress(msg: string): () => void {
  if (!process.stderr.isTTY) return () => {};
  process.stderr.write(msg);
  const id = setInterval(() => process.stderr.write('.'), 1000);
  return () => { clearInterval(id); process.stderr.write('\n'); };
}

// ─── Helper: retry on 429 ───────────────────────────────────────

async function executeWithRetry(
  fn: () => Promise<unknown>,
  retries = 2,
  delayMs = 2000,
): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const result = await fn();
    const data = result as Record<string, unknown>;
    // Daemon returns { status: 'executed', result: { failureCause: 'rate_limited', failureDetail: '...NNNms...' } }
    const inner = (data?.result ?? data) as Record<string, unknown> | undefined;
    if (inner?.failureCause === 'rate_limited' && attempt < retries) {
      const detail = typeof inner.failureDetail === 'string' ? inner.failureDetail : '';
      const wait = parseInt(detail.match(/(\d+)ms/)?.[1] ?? String(delayMs));
      console.error(`Rate limited — retrying in ${wait}ms...`);
      await new Promise(r => setTimeout(r, wait + 100));
      continue;
    }
    return result;
  }
}

async function executeWithRetryRemote(
  fn: () => Promise<unknown>,
  retries = 2,
  delayMs = 2000,
): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/429|rate.limit/i.test(msg) && attempt < retries) {
        console.error(`Rate limited — retrying in ${delayMs}ms...`);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
}

// ─── explore ────────────────────────────────────────────────────

program
  .command('explore <url>')
  .description('Open a browser session to explore a website')
  .addHelpText('after', '\n(requires local daemon or --url)')
  .option('--url <url>', 'Remote Schrute server URL')
  .option('--token <token>', 'Auth token for remote server')
  .action(async (url: string, cmdOpts: { url?: string; token?: string }) => {
    const remote = getRemoteClient(cmdOpts);
    if (remote) {
      const stop = startProgress('Exploring');
      try {
        const result = await remote.explore(url);
        outputResult(result);
      } catch (err) {
        console.error('Error:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      } finally {
        stop();
      }
      return;
    }

    const config = getConfig();
    createLogger(config.logLevel);
    ensureDirectories(config);

    const client = createDaemonClient(config);
    const stop = startProgress('Exploring');
    try {
      const result = await client.request('POST', '/ctl/explore', { url });
      console.log('Explore session started:');
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error('Error:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    } finally {
      stop();
    }
  });

// ─── status ─────────────────────────────────────────────────────

program
  .command('status')
  .description('Show server status')
  .addHelpText('after', '\n(requires local daemon or --url)')
  .option('--url <url>', 'Remote Schrute server URL')
  .option('--token <token>', 'Auth token for remote server')
  .action(async (cmdOpts: { url?: string; token?: string }) => {
    const remote = getRemoteClient(cmdOpts);
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
  .option('--url <url>', 'Remote Schrute server URL')
  .option('--token <token>', 'Auth token for remote server')
  .action(async (cmdOpts: { url?: string; token?: string }) => {
    const remote = getRemoteClient(cmdOpts);
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
  .option('--url <url>', 'Remote Schrute server URL')
  .option('--token <token>', 'Auth token for remote server')
  .action(async (options: { name: string; input?: string[]; url?: string; token?: string }) => {
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

    const remote = getRemoteClient(options);
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
  .option('--url <url>', 'Remote Schrute server URL')
  .option('--token <token>', 'Auth token for remote server')
  .action(async (cmdOpts: { url?: string; token?: string }) => {
    const remote = getRemoteClient(cmdOpts);
    if (remote) {
      const stop = startProgress('Stopping');
      try {
        const result = await remote.stopRecording();
        outputResult(result);
      } catch (err) {
        console.error('Error:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      } finally {
        stop();
      }
      return;
    }

    const config = getConfig();
    createLogger(config.logLevel);

    const client = createDaemonClient(config);
    const stop = startProgress('Stopping');
    try {
      const result = await client.request('POST', '/ctl/stop');
      console.log('Recording stopped:');
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error('Error:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    } finally {
      stop();
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
  .option('--status <status>', 'Filter by status (draft, active, stale, broken)')
  .option('--url <url>', 'Remote Schrute server URL')
  .option('--token <token>', 'Auth token for remote server')
  .action(async (site: string | undefined, cmdOpts: { status?: string; url?: string; token?: string }) => {
    const { SkillStatus } = await import('./skill/types.js');
    const validStatuses = Object.values(SkillStatus) as string[];
    if (cmdOpts.status && !validStatuses.includes(cmdOpts.status)) {
      console.error(`Invalid status '${cmdOpts.status}'. Valid: ${validStatuses.join(', ')}`);
      process.exit(1);
    }

    const remote = getRemoteClient(cmdOpts);
    if (remote) {
      try {
        const result = await remote.listSkills(site ?? undefined, cmdOpts.status);
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

    if (cmdOpts.status) {
      skills = skills.filter(s => s.status === cmdOpts.status);
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
  .option('--site <siteId>', 'Filter to a specific site')
  .option('--url <url>', 'Remote Schrute server URL')
  .option('--token <token>', 'Auth token for remote server')
  .action(async (query?: string, options?: { limit?: string; site?: string; url?: string; token?: string }) => {
    const remote = getRemoteClient(options);
    if (remote) {
      try {
        const limit = options?.limit ? parseInt(options.limit, 10) : undefined;
        const result = await remote.searchSkills(query, limit, options?.site);
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
      const { skills: ftsResults } = skillRepo.searchFts(query, { siteId: options?.site, limit });
      results = ftsResults.length > 0
        ? ftsResults.filter(s => s.status === SkillStatus.ACTIVE).slice(0, limit)
        : rankToolsByIntent(
            options?.site
              ? skillRepo.getByStatusAndSiteId(SkillStatus.ACTIVE, options.site)
              : skillRepo.getByStatus(SkillStatus.ACTIVE),
            query, limit);
    } else {
      results = (options?.site
        ? skillRepo.getByStatusAndSiteId(SkillStatus.ACTIVE, options.site)
        : skillRepo.getByStatus(SkillStatus.ACTIVE)
      ).slice(0, limit);
    }

    // P2-3: Surface inactive matches
    const inactiveMatches = findInactiveMatches(skillRepo, query, limit, options?.site);

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
  .option('--yes', 'Skip confirmation')
  .action(async (skillId: string, options: { yes?: boolean }) => {
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

    if (!options.yes) {
      console.log(`About to delete skill '${skillId}':`);
      console.log(`  Name:   ${skill.name}`);
      console.log(`  Method: ${skill.method} ${skill.pathTemplate}`);
      console.log(`  Status: ${skill.status}`);
      if (!process.stdin.isTTY) {
        console.error('Non-interactive terminal: use --yes to confirm deletion.');
        closeDatabase();
        process.exit(1);
      }
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>(resolve => rl.question('Delete this skill? [y/N] ', resolve));
      rl.close();
      if (answer.toLowerCase() !== 'y') {
        console.log('Aborted.');
        closeDatabase();
        return;
      }
    }

    skillRepo.delete(skillId);
    console.log(`Deleted skill '${skillId}' (${skill.name}).`);
    closeDatabase();
  });

skillsCmd
  .command('revoke <skill_id>')
  .description('Revoke permanent approval for a skill')
  .option('--url <url>', 'Remote Schrute server URL')
  .option('--token <token>', 'Auth token for remote server')
  .action(async (skillId: string, cmdOpts: { url?: string; token?: string }) => {
    const remote = getRemoteClient(cmdOpts);
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
  .option('--url <url>', 'Remote Schrute server URL')
  .option('--token <token>', 'Auth token for remote server')
  .action(async (skillId: string, cmdOpts: { url?: string; token?: string }) => {
    const remote = getRemoteClient(cmdOpts);
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
  .option('--url <url>', 'Remote Schrute server URL')
  .option('--token <token>', 'Auth token for remote server')
  .action(async (skillId: string, cmdOpts: { url?: string; token?: string }) => {
    const remote = getRemoteClient(cmdOpts);
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

skillsCmd
  .command('prune-infra')
  .description('Remove captured third-party infrastructure skills (e.g. Cloudflare challenges)')
  .requiredOption('--site <siteId>', 'Site ID to prune infrastructure skills for')
  .option('--dry-run', 'List matches without deleting')
  .option('--yes', 'Skip confirmation and delete immediately')
  .action(async (options: { site: string; dryRun?: boolean; yes?: boolean }) => {
    const { isLearnableHost } = await import('./capture/noise-filter.js');
    const config = getConfig();
    createLogger(config.logLevel);
    ensureDirectories(config);

    const db = getDatabase(config);
    const skillRepo = new SkillRepository(db);
    const siteId = options.site;
    const isJson = program.opts().json;

    const skills = skillRepo.getBySiteId(siteId);
    const schemeRegex = /^[a-z][a-z0-9+.-]*:/i;

    interface MatchedSkill {
      id: string;
      host: string | null;
      pathTemplate: string;
      reason: 'non_learnable_host' | 'malformed_url';
    }

    const matched: MatchedSkill[] = [];
    for (const skill of skills) {
      if (!schemeRegex.test(skill.pathTemplate)) continue;

      let host: string | null = null;
      let reason: MatchedSkill['reason'] = 'malformed_url';
      try {
        host = new URL(skill.pathTemplate).hostname;
        if (isLearnableHost(host, siteId)) continue; // same-root — keep
        reason = 'non_learnable_host';
      } catch {
        reason = 'malformed_url';
      }

      matched.push({ id: skill.id, host, pathTemplate: skill.pathTemplate, reason });
    }

    if (matched.length === 0) {
      if (isJson) {
        console.log(JSON.stringify({ siteId, dryRun: !!options.dryRun, matched: 0, deleted: 0, skipped: 0, errors: [] }));
      } else {
        console.log(`No infrastructure skills found for site "${siteId}".`);
      }
      closeDatabase();
      return;
    }

    if (options.dryRun) {
      if (isJson) {
        console.log(JSON.stringify({ siteId, dryRun: true, matched: matched.length, deleted: 0, skipped: matched.length, errors: [], skills: matched }));
      } else {
        console.log(`Dry run: ${matched.length} infrastructure skill(s) would be deleted:\n`);
        for (const m of matched) {
          console.log(`  ${m.id} — host: ${m.host ?? 'malformed'} — ${m.pathTemplate} (${m.reason})`);
        }
      }
      closeDatabase();
      return;
    }

    // Interactive confirmation unless --yes
    if (!options.yes) {
      if (!process.stdin.isTTY) {
        console.error('Non-interactive terminal: use --yes or --dry-run');
        closeDatabase();
        process.exit(1);
      }
      console.log(`About to delete ${matched.length} infrastructure skill(s):\n`);
      for (const m of matched) {
        console.log(`  ${m.id} — host: ${m.host ?? 'malformed'} — ${m.pathTemplate} (${m.reason})`);
      }
      const readline = await import('node:readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>(resolve => rl.question('\nDelete these skills? [y/N] ', resolve));
      rl.close();
      if (answer.toLowerCase() !== 'y') {
        if (isJson) {
          console.log(JSON.stringify({ siteId, dryRun: false, matched: matched.length, deleted: 0, skipped: matched.length, errors: [] }));
        } else {
          console.log('Aborted.');
        }
        closeDatabase();
        process.exit(1);
      }
    }

    let deleted = 0;
    const errors: Array<{ id: string; error: string }> = [];
    for (const m of matched) {
      try {
        skillRepo.delete(m.id);
        deleted++;
      } catch (err) {
        errors.push({ id: m.id, error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (isJson) {
      console.log(JSON.stringify({ siteId, dryRun: false, matched: matched.length, deleted, skipped: matched.length - deleted, errors }));
    } else {
      console.log(`Deleted ${deleted} of ${matched.length} infrastructure skill(s).`);
      if (errors.length > 0) {
        for (const e of errors) {
          console.error(`  Error deleting ${e.id}: ${e.error}`);
        }
      }
    }

    closeDatabase();
  });

// ─── execute ────────────────────────────────────────────────────

program
  .command('execute <skillId> [params...]')
  .description('Execute a skill by ID')
  .addHelpText('after', '\n(requires local daemon or --url)')
  .option('--yes', 'Auto-confirm and permanently approve the skill')
  .option('--json', 'Output as JSON')
  .option('--url <url>', 'Remote Schrute server URL')
  .option('--token <token>', 'Auth token for remote server')
  .action(async (skillId: string, paramPairs: string[], options: { yes?: boolean; json?: boolean; url?: string; token?: string }) => {
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

    const remote = getRemoteClient(options);
    if (remote) {
      // Remote mode
      const stop = startProgress('Executing');
      try {
        let result = await executeWithRetryRemote(() => remote.executeSkill(skillId, params));
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
          result = await executeWithRetryRemote(() => remote.executeSkill(skillId, params));
        }
        outputResult(result);
      } catch (err) {
        console.error('Error:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      } finally {
        stop();
      }
      return;
    }

    // Local mode — go through daemon
    const stop = startProgress('Executing');
    try {
      const daemonClient = createDaemonClient(getConfig());
      let result = await executeWithRetry(() => daemonClient.request('POST', '/ctl/execute', { skillId, params }));
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
        result = await executeWithRetry(() => daemonClient.request('POST', '/ctl/execute', { skillId, params }));
      }
      outputResult(result);
    } catch (err) {
      console.error('Error:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    } finally {
      stop();
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
  .option('--url <url>', 'Remote Schrute server URL')
  .option('--token <token>', 'Auth token for remote server')
  .action(async (cmdOpts: { url?: string; token?: string }) => {
    const remote = getRemoteClient(cmdOpts);
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
  .option('--reveal', 'Show sensitive values without masking')
  .action((key: string, options: { reveal?: boolean }) => {
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

    // Mask sensitive leaf values unless --reveal
    if (!options.reveal) {
      const lastKey = keys[keys.length - 1];
      current = maskConfigValue(lastKey, current);
    }
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
  .addHelpText('after', '\nTo run multiple instances, set SCHRUTE_DATA_DIR to different directories.')
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
      const masked = config.server.authToken
        ? `${config.server.authToken.slice(0, 4)}***`
        : '(not set)';
      console.log(`  Auth token:   ${masked}  (full value: schrute config get server.authToken --reveal)`);
      if (!config.server.network) {
        console.log(`  REST API:     no auth (local mode)`);
        console.log(`  MCP HTTP:     requires Bearer token`);
      }
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
	        // In stdio mode, stdout is reserved for MCP JSON-RPC frames.
	        (options.http || config.server.network ? console.log : console.error)('\nShutting down...');
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
  .option('--yes', 'Skip confirmation')
  .action(async (file: string, options: { yes?: boolean }) => {
    const config = getConfig();
    createLogger(config.logLevel);
    ensureDirectories(config);

    const db = getDatabase(config);
    const skillRepo = new SkillRepository(db);
    const siteRepo = new SiteRepository(db);

    try {
      const { performImport } = await import('./app/import-service.js');
      const result = await performImport(file, { db, skillRepo, siteRepo, config }, options);

      if (result.cancelled) {
        console.log('Cancelled.');
        return;
      }

      if (result.siteAction) {
        console.log(`${result.siteAction === 'created' ? 'Created' : 'Updated'} site.`);
      }
      if (result.updated > 0) {
        console.log(`Will overwrite ${result.updated} existing skill(s).`);
      }
      console.log(`Imported ${result.created} new skill(s), updated ${result.updated} existing skill(s).`);
      if (result.hasAuthSkills) {
        console.log('NOTE: Re-authentication may be required -- credentials are never exported.');
      }
    } catch (err) {
      console.error('Error:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    } finally {
      closeDatabase();
    }
  });

// ─── discover ───────────────────────────────────────────────────

program
  .command('discover <url>')
  .description('Run cold-start discovery on a URL')
  .action(async (url: string) => {
    const config = getConfig();
    createLogger(config.logLevel);
    ensureDirectories(config);

    const stop = startProgress('Discovering');
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
    } finally {
      stop();
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
