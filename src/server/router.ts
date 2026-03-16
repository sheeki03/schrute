import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getLogger } from '../core/logger.js';
import { Engine } from '../core/engine.js';
import { SkillRepository } from '../storage/skill-repository.js';
import { SiteRepository } from '../storage/site-repository.js';
import { dryRun } from '../replay/dry-run.js';
import { validateParams } from '../replay/param-validator.js';
import { validateSkill } from '../skill/validator.js';
import { ConfirmationManager } from './confirmation.js';
import type {
  SkillSpec,
  SchruteConfig,
  SkillStatusName,
  AuditEntry,
} from '../skill/types.js';
import { SkillStatus } from '../skill/types.js';
import type { ContextOverrides } from '../browser/manager.js';
import { shouldAutoConfirm } from './skill-helpers.js';
import type { PipelineJobInfo } from '../app/service.js';

const log = getLogger();

// ─── Slug-Tolerant Matching ──────────────────────────────────────

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function findSkillBySlug(skills: SkillSpec[], skillName: string, requireActive: boolean): SkillSpec | undefined {
  return skills.find(s =>
    (s.name === skillName || slugify(s.name) === slugify(skillName)) &&
    (!requireActive || s.status === SkillStatus.ACTIVE),
  );
}

// ─── Router Result Types ─────────────────────────────────────────

export type RouterResult =
  | { success: true; data: unknown }
  | { success: false; error: string; statusCode?: number; data?: unknown };

// ─── Router Dependencies ─────────────────────────────────────────

export interface RouterDeps {
  engine: Engine;
  skillRepo: SkillRepository;
  siteRepo: SiteRepository;
  config: SchruteConfig;
  confirmation: ConfirmationManager;
}

interface PipelineJobEngine {
  getPipelineJob(jobId: string): PipelineJobInfo | undefined;
}

function hasPipelineJobEngine(engine: Engine): engine is Engine & PipelineJobEngine {
  return typeof (engine as Partial<PipelineJobEngine>).getPipelineJob === 'function';
}

// ─── Unified Router ──────────────────────────────────────────────

export function createRouter(deps: RouterDeps) {
  const { engine, skillRepo, siteRepo, config, confirmation } = deps;

  return {
    // ─── Sites ─────────────────────────────────────────────
    listSites(): RouterResult {
      const sites = siteRepo.getAll();
      return { success: true, data: sites };
    },

    getSite(siteId: string): RouterResult {
      const site = siteRepo.getById(siteId);
      if (!site) {
        return { success: false, error: `Site '${siteId}' not found`, statusCode: 404 };
      }
      return { success: true, data: site };
    },

    // ─── Skills ────────────────────────────────────────────
    listSkills(siteId: string, status?: string): RouterResult {
      let skills: SkillSpec[];
      if (status) {
        skills = skillRepo.getByStatus(status as SkillStatusName)
          .filter((s) => s.siteId === siteId);
      } else {
        skills = skillRepo.getBySiteId(siteId);
      }

      const summary = skills.map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        siteId: s.siteId,
        method: s.method,
        pathTemplate: s.pathTemplate,
        successRate: s.successRate,
        currentTier: s.currentTier,
      }));
      return { success: true, data: summary };
    },

    // ─── Skill Execution ───────────────────────────────────
    async executeSkill(
      siteId: string,
      skillName: string,
      params: Record<string, unknown>,
      callerId?: string,
    ): Promise<RouterResult> {
      const skills = skillRepo.getBySiteId(siteId);
      const skill = findSkillBySlug(skills, skillName, true);

      if (!skill) {
        return {
          success: false,
          error: `Skill '${skillName}' not found for site '${siteId}'`,
          statusCode: 404,
        };
      }

      // WS-7: Validate params before confirmation — reject invalid params early
      const validation = validateParams(params, skill, config.paramLimits);
      if (!validation.valid) {
        return { success: false, error: `Invalid params: ${validation.errors.join('; ')}`, statusCode: 400 };
      }

      // P2-8: Auto-confirm read-only GET/HEAD skills
      const autoConfirm = shouldAutoConfirm(skill);

      // Gate ALL unconfirmed skills through confirmation, regardless of side-effect class
      const needsConfirmation = !autoConfirm && !confirmation.isSkillConfirmed(skill.id);

      if (needsConfirmation) {
        const token = await confirmation.generateToken(
          skill.id,
          params,
          skill.currentTier,
        );

        return {
          success: false,
          error: 'Confirmation required',
          statusCode: 202,
          data: {
            status: 'confirmation_required',
            message: 'This skill has not been validated yet. Please confirm execution.',
            skillId: skill.id,
            confirmationToken: token.nonce,
            expiresAt: token.expiresAt,
            sideEffectClass: skill.sideEffectClass,
            method: skill.method,
            pathTemplate: skill.pathTemplate,
          },
        };
      }

      const result = await engine.executeSkill(skill.id, params, callerId);
      if (result.success) {
        return { success: true, data: result };
      }
      return { success: false, error: result.error ?? 'Skill execution failed', data: result };
    },

    // ─── Dry Run ───────────────────────────────────────────
    async dryRunSkill(
      siteId: string,
      skillName: string,
      params: Record<string, unknown>,
      mode?: 'agent-safe' | 'developer-debug',
    ): Promise<RouterResult> {
      const skills = skillRepo.getBySiteId(siteId);
      const skill = findSkillBySlug(skills, skillName, false);

      if (!skill) {
        return {
          success: false,
          error: `Skill '${skillName}' not found for site '${siteId}'`,
          statusCode: 404,
        };
      }

      // WS-8: Validate params before preview
      const validation = validateParams(params, skill, config.paramLimits);

      const preview = await dryRun(skill, params, mode ?? 'agent-safe');
      return {
        success: true,
        data: {
          ...preview,
          ...(validation.valid ? {} : { validationErrors: validation.errors, note: 'Parameters would be rejected at execution time.' }),
          ...(validation.valid ? { note: 'This is a preview only. No request was sent.' } : {}),
        },
      };
    },

    // ─── Validate ──────────────────────────────────────────
    async validateSkillRoute(
      siteId: string,
      skillName: string,
      params: Record<string, unknown>,
    ): Promise<RouterResult> {
      const skills = skillRepo.getBySiteId(siteId);
      const skill = findSkillBySlug(skills, skillName, false);

      if (!skill) {
        return {
          success: false,
          error: `Skill '${skillName}' not found for site '${siteId}'`,
          statusCode: 404,
        };
      }

      const result = await validateSkill(skill, params);
      if (result.success) {
        return { success: true, data: result };
      }
      return { success: false, error: 'Validation failed', data: result };
    },

    // ─── Explore / Record / Stop ───────────────────────────
    async explore(url: string, overrides?: ContextOverrides): Promise<RouterResult> {
      try {
        const result = await engine.explore(url, overrides);
        return { success: true, data: result };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ url, err }, 'Explore failed');
        return { success: false, error: message, statusCode: 400 };
      }
    },

    async startRecording(
      name: string,
      inputs?: Record<string, string>,
    ): Promise<RouterResult> {
      try {
        const result = await engine.startRecording(name, inputs);
        return { success: true, data: result };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ name, err }, 'Start recording failed');
        return { success: false, error: message, statusCode: 400 };
      }
    },

    async stopRecording(): Promise<RouterResult> {
      try {
        const result = await engine.stopRecording();
        return { success: true, data: result };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err }, 'Stop recording failed');
        return { success: false, error: message, statusCode: 400 };
      }
    },

    getPipelineStatus(jobId: string): RouterResult {
      if (!hasPipelineJobEngine(engine)) {
        return {
          success: false,
          error: 'Pipeline status is not supported by this engine build',
          statusCode: 501,
        };
      }

      const job = engine.getPipelineJob(jobId);
      if (!job) {
        return {
          success: false,
          error: `Pipeline job '${jobId}' not found`,
          statusCode: 404,
        };
      }

      return { success: true, data: job };
    },

    async recoverExplore(resumeToken: string, waitMs?: number): Promise<RouterResult> {
      try {
        const result = await engine.recoverExplore(resumeToken, waitMs);
        return { success: true, data: result };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err }, 'Recover explore failed');
        return { success: false, error: message, statusCode: 400 };
      }
    },

    // ─── Status ────────────────────────────────────────────
    getStatus(): RouterResult {
      const status = engine.getStatus();
      return { success: true, data: status };
    },

    // ─── Confirmation ──────────────────────────────────────
    confirm(
      confirmationToken: string,
      approve: boolean,
    ): RouterResult {
      const result = confirmation.verifyAndConsume(confirmationToken, approve);
      if (!result.valid || !result.token) {
        return {
          success: false,
          error: `Confirmation failed: ${result.error ?? 'invalid token'}`,
          statusCode: 400,
        };
      }

      const { skillId, tier } = result.token;

      if (approve) {
        return {
          success: true,
          data: {
            status: 'approved',
            skillId,
            tier,
          },
        };
      } else {
        return {
          success: true,
          data: {
            status: 'denied',
            skillId,
          },
        };
      }
    },

    // ─── Audit ─────────────────────────────────────────────
    getAuditLog(options?: { offset?: number; limit?: number }): RouterResult {
      const limit = options?.limit ?? 100;
      const offset = options?.offset ?? 0;
      const auditFilePath = join(config.dataDir, 'audit', 'audit.jsonl');

      if (!existsSync(auditFilePath)) {
        return { success: true, data: { entries: [], total: 0 } };
      }

      const content = readFileSync(auditFilePath, 'utf-8').trim();
      if (!content) {
        return { success: true, data: { entries: [], total: 0 } };
      }

      const lines = content.split('\n');
      const total = lines.length;

      // Return entries in reverse chronological order (newest first)
      const reversed = lines.slice().reverse();
      const page = reversed.slice(offset, offset + limit);
      const entries: AuditEntry[] = [];
      let skippedCount = 0;
      for (const line of page) {
        try {
          entries.push(JSON.parse(line) as AuditEntry);
        } catch {
          skippedCount++;
          log.warn({ entry: line }, 'Skipping malformed audit log entry');
        }
      }

      return { success: true, data: { entries, total, offset, limit, skippedCount } };
    },

    // ─── Health ────────────────────────────────────────────
    health(): RouterResult {
      const status = engine.getStatus();
      return {
        success: true,
        data: {
          status: 'ok',
          uptime: status.uptime,
          mode: status.mode,
        },
      };
    },
  };
}

export type Router = ReturnType<typeof createRouter>;
