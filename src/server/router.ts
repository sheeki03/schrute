import { createHash, randomBytes, createHmac } from 'node:crypto';
import { getLogger } from '../core/logger.js';
import { Engine } from '../core/engine.js';
import { SkillRepository } from '../storage/skill-repository.js';
import { SiteRepository } from '../storage/site-repository.js';
import { dryRun } from '../replay/dry-run.js';
import { validateSkill } from '../skill/validator.js';
import type {
  SkillSpec,
  ConfirmationToken,
  OneAgentConfig,
  SkillStatusName,
} from '../skill/types.js';
import { SkillStatus } from '../skill/types.js';

const log = getLogger();

// ─── Confirmation Token Store ────────────────────────────────────

const HMAC_SECRET = randomBytes(32);
const pendingConfirmations = new Map<string, ConfirmationToken>();

function generateConfirmationToken(
  skillId: string,
  params: Record<string, unknown>,
  tier: string,
  config: OneAgentConfig,
): ConfirmationToken {
  const nonce = randomBytes(16).toString('hex');
  const paramsHash = createHash('sha256')
    .update(JSON.stringify(params))
    .digest('hex');
  const now = Date.now();

  const token: ConfirmationToken = {
    nonce,
    skillId,
    paramsHash,
    tier,
    createdAt: now,
    expiresAt: now + config.confirmationExpiryMs,
    consumed: false,
  };

  const hmacPayload = `${skillId}|${paramsHash}|${tier}|${token.expiresAt}|${nonce}`;
  const hmac = createHmac('sha256', HMAC_SECRET).update(hmacPayload).digest('hex');
  const tokenId = hmac;

  pendingConfirmations.set(tokenId, token);
  return { ...token, nonce: tokenId };
}

function verifyConfirmationToken(
  tokenId: string,
  _config: OneAgentConfig,
): { valid: boolean; token?: ConfirmationToken; error?: string } {
  const token = pendingConfirmations.get(tokenId);
  if (!token) {
    return { valid: false, error: 'Token not found' };
  }

  if (token.consumed) {
    return { valid: false, error: 'Token already consumed' };
  }

  if (Date.now() > token.expiresAt) {
    pendingConfirmations.delete(tokenId);
    return { valid: false, error: 'Token expired' };
  }

  return { valid: true, token };
}

function consumeToken(tokenId: string): void {
  const token = pendingConfirmations.get(tokenId);
  if (token) {
    token.consumed = true;
    token.consumedAt = Date.now();
  }
}

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
}

// ─── Unified Router ──────────────────────────────────────────────

export function createRouter(deps: RouterDeps) {
  const { engine, skillRepo, siteRepo, config } = deps;

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

      // First-run confirmation flow
      if (skill.consecutiveValidations < 1) {
        const token = generateConfirmationToken(
          skill.id,
          params,
          skill.currentTier,
          config,
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
    dryRunSkill(
      siteId: string,
      skillName: string,
      params: Record<string, unknown>,
      mode?: 'agent-safe' | 'developer-debug',
    ): RouterResult {
      const skills = skillRepo.getBySiteId(siteId);
      const skill = skills.find((s) => s.name === skillName);

      if (!skill) {
        return {
          success: false,
          error: `Skill '${skillName}' not found for site '${siteId}'`,
          statusCode: 404,
        };
      }

      const preview = dryRun(skill, params, mode ?? 'agent-safe');
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
      const verification = verifyConfirmationToken(confirmationToken, config);
      if (!verification.valid) {
        return {
          success: false,
          error: `Confirmation failed: ${verification.error}`,
          statusCode: 400,
        };
      }

      consumeToken(confirmationToken);

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
    getAuditLog(): RouterResult {
      return { success: true, data: { entries: [], message: 'Audit log viewer' } };
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
