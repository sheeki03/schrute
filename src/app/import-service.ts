import * as fs from 'node:fs';
import * as readline from 'node:readline';
import type { SkillSpec, SiteManifest, SitePolicy } from '../skill/types.js';
import { validateImportableSkill, validateImportableSite } from '../storage/import-validator.js';
import { getSitePolicy, setSitePolicy } from '../core/policy.js';
import type { SkillRepository } from '../storage/skill-repository.js';
import type { SiteRepository } from '../storage/site-repository.js';
import type { AgentDatabase } from '../storage/database.js';
import type { SchruteConfig } from '../core/config.js';

export interface ImportDeps {
  db: AgentDatabase;
  skillRepo: SkillRepository;
  siteRepo: SiteRepository;
  config: SchruteConfig;
}

export interface ImportOptions {
  yes?: boolean;
}

export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  siteAction?: 'created' | 'updated';
  hasAuthSkills: boolean;
  policyWarnings: string[];
  cancelled?: boolean;
}

export async function performImport(
  file: string,
  deps: ImportDeps,
  options: ImportOptions = {},
): Promise<ImportResult> {
  if (!fs.existsSync(file)) {
    throw new Error(`File '${file}' not found.`);
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
    throw new Error(`Failed to parse bundle: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!bundle.site || !bundle.skills || !Array.isArray(bundle.skills)) {
    throw new Error('Invalid bundle format: missing site or skills.');
  }

  // Validate site
  const siteResult = validateImportableSite(bundle.site);
  if (!siteResult.valid) {
    throw new Error(`Site validation failed:\n  ${siteResult.errors.join('\n  ')}`);
  }

  // Validate each skill; warn + skip invalid ones
  const validSkills: SkillSpec[] = [];
  const skipped: string[] = [];
  const expectedSiteId = bundle.site.id;

  for (const skill of bundle.skills) {
    const skillResult = validateImportableSkill(skill);
    if (!skillResult.valid) {
      const label = (skill as unknown as Record<string, unknown>).id ?? '(unknown)';
      console.warn(
        `Warning: skill '${label}' failed validation -- skipping.\n  ${skillResult.errors.join('\n  ')}`,
      );
      skipped.push(String(label));
      continue;
    }

    if (Array.isArray(skill.allowedDomains) && skill.allowedDomains.length === 0) {
      console.warn(
        `Warning: skill '${skill.id}' has no allowedDomains -- may not execute without a domain policy.`,
      );
    }

    if (skill.siteId !== expectedSiteId) {
      console.warn(
        `Warning: skill '${skill.id}' has siteId '${skill.siteId}', expected '${expectedSiteId}'. Skipping.`,
      );
      skipped.push(skill.id);
      continue;
    }

    validSkills.push(skill);
  }

  // Check for overwrites — track corrupt rows separately
  const { db, skillRepo, siteRepo } = deps;
  let existingSite: SiteManifest | undefined;
  let siteCorrupt = false;
  try {
    existingSite = siteRepo.getById(bundle.site.id);
  } catch {
    siteCorrupt = true;
    console.warn(`Warning: existing site '${bundle.site.id}' has corrupt data — will overwrite.`);
  }

  const overwriteIds: string[] = [];
  const corruptIds: string[] = [];
  const existingCreatedAt = new Map<string, number>();
  let newCount = 0;
  for (const skill of validSkills) {
    try {
      const existing = skillRepo.getById(skill.id);
      if (existing) {
        overwriteIds.push(skill.id);
        if (existing.createdAt) existingCreatedAt.set(skill.id, existing.createdAt);
      } else {
        newCount++;
      }
    } catch {
      corruptIds.push(skill.id);
      console.warn(`Warning: existing skill '${skill.id}' has corrupt data — will overwrite.`);
    }
  }
  const existingCount = overwriteIds.length + corruptIds.length;

  // Preview
  console.log(`Import preview for '${file}':`);
  console.log(`  Site:             ${bundle.site.id} (${existingSite ? 'will update' : 'will create'})`);
  console.log(`  Valid skills:     ${validSkills.length}`);
  if (skipped.length > 0) {
    console.log(`  Skipped (invalid): ${skipped.length}`);
  }
  if (existingCount > 0) {
    console.log(`  Will overwrite:   ${existingCount} existing skill(s)`);
    for (const id of overwriteIds) console.log(`    overwrite: ${id}`);
    for (const id of corruptIds) console.log(`    overwrite (corrupt): ${id}`);
  }

  // Policy preview
  const policyWarnings: string[] = [];
  if (bundle.policy) {
    console.log(`  Policy:           will ${existingSite ? 'replace' : 'set'}`);
    const currentPolicy = getSitePolicy(bundle.site.id, deps.config);
    if (bundle.policy.maxConcurrent !== currentPolicy.maxConcurrent) {
      policyWarnings.push(`maxConcurrent: current=${currentPolicy.maxConcurrent}, import=${bundle.policy.maxConcurrent}`);
    }
  }
  if (policyWarnings.length > 0) {
    console.log(`  Policy changes:   ${policyWarnings.join('; ')}`);
  }

  // Confirmation — require when anything will be overwritten
  if ((existingCount > 0 || existingSite || siteCorrupt) && !options.yes) {
    if (!process.stdin.isTTY) {
      throw new Error('Non-interactive terminal: use --yes to confirm import.');
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>(resolve => rl.question('Proceed with import? [y/N] ', resolve));
    rl.close();
    if (answer.toLowerCase() !== 'y') {
      return { created: 0, updated: 0, skipped: skipped.length, hasAuthSkills: false, policyWarnings, cancelled: true };
    }
  }

  // Fill defaults for NOT NULL DB fields
  const now = Date.now();
  for (const skill of validSkills) {
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
    if (skill.createdAt === undefined) {
      skill.createdAt = existingCreatedAt.get(skill.id) ?? now;
    }
    if (skill.updatedAt === undefined) skill.updatedAt = now;
  }

  // Phase 1: Site + skills in a single synchronous transaction
  const corruptSet = new Set(corruptIds);
  const overwriteSet = new Set(overwriteIds);
  let created = 0;
  let updated = 0;
  let siteAction: 'created' | 'updated';

  db.transaction(() => {
    if (existingSite && !siteCorrupt) {
      siteRepo.update(bundle.site.id, bundle.site);
      siteAction = 'updated';
    } else {
      // Delete corrupt/stale row (cascade may delete skills too)
      try { siteRepo.delete(bundle.site.id); } catch { /* row may not exist */ }
      siteRepo.create(bundle.site);
      siteAction = 'created';
    }

    if (siteCorrupt) {
      // Site was deleted+recreated → cascade killed all skills → all are creates
      for (const skill of validSkills) {
        skillRepo.create(skill);
        created++;
      }
    } else {
      for (const skill of validSkills) {
        if (corruptSet.has(skill.id)) {
          try { skillRepo.delete(skill.id); } catch { /* may already be gone */ }
          skillRepo.create(skill);
          updated++;
        } else if (overwriteSet.has(skill.id)) {
          skillRepo.update(skill.id, skill);
          updated++;
        } else {
          skillRepo.create(skill);
          created++;
        }
      }
    }
  });

  // Phase 2: Policy (separate write — setSitePolicy does its own DB call)
  if (bundle.policy) {
    const p = bundle.policy;
    if (p.siteId && p.siteId !== bundle.site.id) {
      console.error(`Warning: policy siteId '${p.siteId}' does not match site '${bundle.site.id}'. Skipping policy.`);
    } else {
      p.siteId = bundle.site.id;
      try {
        const result = setSitePolicy(p, deps.config);
        if (!result.persisted) {
          console.error('Warning: policy imported to cache but failed to persist to DB.');
        }
      } catch (err) {
        console.error(`Warning: policy import failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const hasAuthSkills = validSkills.some((s: SkillSpec) => s.authType != null);

  return { created, updated, skipped: skipped.length, siteAction: siteAction!, hasAuthSkills, policyWarnings };
}
