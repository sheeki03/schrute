import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getLogger } from '../core/logger.js';
import { Engine } from '../core/engine.js';
import { SkillRepository } from '../storage/skill-repository.js';
import { SiteRepository } from '../storage/site-repository.js';
import { dryRun } from '../replay/dry-run.js';
import { validateSkill } from '../skill/validator.js';
import { ConfirmationManager } from './confirmation.js';
import type {
  SkillSpec,
  OneAgentConfig,
  SkillStatusName,
  AuditEntry,
} from '../skill/types.js';
import { SkillStatus } from '../skill/types.js';

const log = getLogger();

// ─── Router Result Types ─────────────────────────────────────────

export interface RouterResult {
  success: boolean;
  data?: unknown;
  error?: string;
  statusCode?: number;
}

// ─── Router Dependencies ─────────────────────────────────────────

export interface RouterDeps {
  engine: Engine;
  skillRepo: SkillRepository;
  siteRepo: SiteRepository;
  config: OneAgentConfig;
  confirmation: ConfirmationManager;
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
    ): Promise<RouterResult> {
      const skills = skillRepo.getBySiteId(siteId);
      const skill = skills.find(
        (s) => s.name === skillName && s.status === SkillStatus.ACTIVE,
      );

      if (!skill) {
        return {
          success: false,
          error: `Skill '${skillName}' not found for site '${siteId}'`,
          statusCode: 404,
        };
      }

      // First-run confirmation flow — skip if globally confirmed
      if (skill.consecutiveValidations < 1 && !confirmation.isSkillConfirmed(skill.id)) {
        const token = confirmation.generateToken(
          skill.id,
          params,
          skill.currentTier,
        );

        return {
          success: false,
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

      const result = await engine.executeSkill(skill.id, params);
      return {
        success: result.success,
        data: result,
        error: result.error,
      };
    },

    // ─── Dry Run ───────────────────────────────────────────
    async dryRunSkill(
      siteId: string,
      skillName: string,
      params: Record<string, unknown>,
      mode?: 'agent-safe' | 'developer-debug',
    ): Promise<RouterResult> {
      const skills = skillRepo.getBySiteId(siteId);
      const skill = skills.find((s) => s.name === skillName);

      if (!skill) {
        return {
          success: false,
          error: `Skill '${skillName}' not found for site '${siteId}'`,
          statusCode: 404,
        };
      }

      const preview = await dryRun(skill, params, mode ?? 'agent-safe');
      return {
        success: true,
        data: {
          ...preview,
          note: 'This is a preview only. No request was sent.',
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
      const skill = skills.find((s) => s.name === skillName);

      if (!skill) {
        return {
          success: false,
          error: `Skill '${skillName}' not found for site '${siteId}'`,
          statusCode: 404,
        };
      }

      const result = await validateSkill(skill, params);
      return { success: result.success, data: result };
    },

    // ─── Explore / Record / Stop ───────────────────────────
    async explore(url: string): Promise<RouterResult> {
      try {
        const result = await engine.explore(url);
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
      const verification = confirmation.verifyToken(confirmationToken);
      if (!verification.valid) {
        return {
          success: false,
          error: `Confirmation failed: ${verification.error}`,
          statusCode: 400,
        };
      }

      confirmation.consumeToken(confirmationToken, approve);

      if (approve) {
        return {
          success: true,
          data: {
            status: 'approved',
            skillId: verification.token!.skillId,
            tier: verification.token!.tier,
          },
        };
      } else {
        return {
          success: true,
          data: {
            status: 'denied',
            skillId: verification.token!.skillId,
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
      for (const line of page) {
        try {
          entries.push(JSON.parse(line) as AuditEntry);
        } catch {
          // Skip malformed entries
        }
      }

      return { success: true, data: { entries, total, offset, limit } };
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
