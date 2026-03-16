import type { Engine, ExploreResult, SkillExecutionResult, EngineStatus } from '../core/engine.js';
import type { SkillRepository } from '../storage/skill-repository.js';
import type { SiteRepository } from '../storage/site-repository.js';
import type { ConfirmationManager } from '../server/confirmation.js';
import type { SchruteConfig, SkillSpec, SkillStatusName, SiteManifest } from '../skill/types.js';
import type { ContextOverrides } from '../browser/manager.js';
import type { CdpConnectionOptions } from '../browser/cdp-connector.js';
import type { DiscoveryResult } from '../discovery/types.js';
import { dryRun } from '../replay/dry-run.js';
import { forcePromote } from '../core/promotion.js';
import { shouldAutoConfirm } from '../server/skill-helpers.js';

// ─── Execute Result (includes confirmation gate) ─────────────────

type ExecuteSkillResult =
  | { status: 'executed'; result: SkillExecutionResult }
  | {
      status: 'confirmation_required';
      skillId: string;
      confirmationToken: string;
      expiresAt: number;
      sideEffectClass: string;
      method: string;
      pathTemplate: string;
    };

// ─── Dependency Container ────────────────────────────────────────────

export interface AppDeps {
  engine: Engine;
  skillRepo: SkillRepository;
  siteRepo: SiteRepository;
  config: SchruteConfig;
  confirmation: ConfirmationManager;
}

// ─── Result Types ────────────────────────────────────────────────────

interface StatusInfo {
  mode: string;
  uptime: number;
  activeSession: unknown;
  currentRecording: unknown;
}

export interface SessionInfo {
  name: string;
  siteId: string;
  isCdp: boolean;
  active: boolean;
}

interface ConfirmResult {
  status: string;
  skillId: string;
  tier?: string;
}

interface ExportedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
}

// ─── Application Service ─────────────────────────────────────────────

export class SchruteService {
  private deps: AppDeps;

  constructor(deps: AppDeps) {
    this.deps = deps;
  }

  // ─── Exploration & Discovery ────────────────────────────────

  async explore(url: string, overrides?: ContextOverrides): Promise<ExploreResult> {
    return this.deps.engine.explore(url, overrides);
  }

  async recoverExplore(resumeToken: string, waitMs?: number): Promise<import('../core/engine.js').RecoverExploreResult> {
    return this.deps.engine.recoverExplore(resumeToken, waitMs);
  }

  async discover(url: string): Promise<DiscoveryResult> {
    const { discoverSite } = await import('../discovery/cold-start.js');
    return discoverSite(url, this.deps.config);
  }

  // ─── Recording ─────────────────────────────────────────────

  async startRecording(name: string, inputs?: Record<string, string>): Promise<void> {
    await this.deps.engine.startRecording(name, inputs);
  }

  async stopRecording(): Promise<unknown> {
    return this.deps.engine.stopRecording();
  }

  // ─── Skill Operations ────────────────────────────────────────

  listSkills(siteId?: string, status?: SkillStatusName): Promise<SkillSpec[]> {
    if (siteId && status) {
      return Promise.resolve(
        this.deps.skillRepo.getByStatusAndSiteId(status, siteId),
      );
    }
    if (siteId) {
      return Promise.resolve(this.deps.skillRepo.getBySiteId(siteId));
    }
    if (status) {
      return Promise.resolve(this.deps.skillRepo.getByStatus(status));
    }
    return Promise.resolve(this.deps.skillRepo.getAll());
  }

  getSkill(skillId: string): SkillSpec | null {
    return this.deps.skillRepo.getById(skillId) ?? null;
  }

  async executeSkill(skillId: string, params: Record<string, unknown>, callerId?: string): Promise<ExecuteSkillResult> {
    const skill = this.deps.skillRepo.getById(skillId);
    if (!skill) throw new Error(`Skill '${skillId}' not found`);

    // ACTIVE-only gate — consistent with MCP/router enforcement
    if (skill.status !== 'active') {
      throw new Error(`Skill '${skillId}' is not active (status: ${skill.status})`);
    }

    // P2-8: Auto-confirm read-only GET/HEAD skills
    const autoConfirm = shouldAutoConfirm(skill);

    // Confirmation gate — all unconfirmed skills require approval before execution
    if (!autoConfirm && !this.deps.confirmation.isSkillConfirmed(skillId)) {
      const token = await this.deps.confirmation.generateToken(
        skillId,
        params,
        skill.currentTier,
      );
      return {
        status: 'confirmation_required',
        skillId: skill.id,
        confirmationToken: token.nonce,
        expiresAt: token.expiresAt,
        sideEffectClass: skill.sideEffectClass,
        method: skill.method,
        pathTemplate: skill.pathTemplate,
      };
    }

    const result = await this.deps.engine.executeSkill(skillId, params, callerId);
    return { status: 'executed', result };
  }

  async dryRun(skillId: string, params: Record<string, unknown>): Promise<unknown> {
    const skill = this.deps.skillRepo.getById(skillId);
    if (!skill) throw new Error(`Skill '${skillId}' not found`);
    return dryRun(skill, params, 'agent-safe');
  }

  activateSkill(skillId: string): SkillSpec {
    const skill = this.deps.skillRepo.getById(skillId);
    if (!skill) throw new Error(`Skill '${skillId}' not found`);
    const result = forcePromote(skill);
    this.deps.skillRepo.update(skill.id, {
      status: result.newStatus,
      updatedAt: result.timestamp,
      lastVerified: result.timestamp,
      confidence: 0.5,
    });
    return this.deps.skillRepo.getById(skillId)!;
  }

  // ─── Confirmation ────────────────────────────────────────────

  confirm(token: string, approve: boolean): ConfirmResult {
    const result = this.deps.confirmation.verifyAndConsume(token, approve);
    if (!result.valid || !result.token) {
      throw new Error(`Confirmation failed: ${result.error ?? 'invalid token'}`);
    }
    return {
      status: approve ? 'approved' : 'denied',
      skillId: result.token.skillId,
      ...(approve ? { tier: result.token.tier } : {}),
    };
  }

  isSkillConfirmed(skillId: string): boolean {
    return this.deps.confirmation.isSkillConfirmed(skillId);
  }

  revokeApproval(skillId: string): void {
    this.deps.confirmation.revokeApproval(skillId);
  }

  async generateConfirmationToken(
    skillId: string,
    params: Record<string, unknown>,
    tier: string,
  ): Promise<unknown> {
    return this.deps.confirmation.generateToken(skillId, params, tier);
  }

  // ─── Site Operations ─────────────────────────────────────────

  listSites(): SiteManifest[] {
    return this.deps.siteRepo.getAll();
  }

  getSite(siteId: string): SiteManifest | null {
    return this.deps.siteRepo.getById(siteId) ?? null;
  }

  // ─── Session Management ──────────────────────────────────────

  async connectCDP(name: string, options: CdpConnectionOptions, siteId: string): Promise<SessionInfo> {
    const msm = this.deps.engine.getMultiSessionManager();
    const session = await msm.connectCDP(name, options, siteId);
    return {
      name: session.name,
      siteId: session.siteId,
      isCdp: session.isCdp,
      active: msm.getActive() === session.name,
    };
  }

  listSessions(): SessionInfo[] {
    const msm = this.deps.engine.getMultiSessionManager();
    const activeName = msm.getActive();
    return msm.list().map(s => ({
      name: s.name,
      siteId: s.siteId,
      isCdp: s.isCdp,
      active: s.name === activeName,
    }));
  }

  switchSession(name: string): void {
    this.deps.engine.getMultiSessionManager().setActive(name, this.deps.config);
  }

  async closeSession(name: string, force = false): Promise<void> {
    const msm = this.deps.engine.getMultiSessionManager();
    await msm.close(name, { engineMode: this.deps.engine.getMode(), force });
  }

  // ─── Cookie Management ─────────────────────────────────────

  async exportCookies(siteId: string): Promise<ExportedCookie[]> {
    const session = this.deps.engine.getMultiSessionManager().getOrCreate();
    return session.browserManager.exportCookies(siteId);
  }

  async importCookies(siteId: string, cookieFilePath: string): Promise<number> {
    const session = this.deps.engine.getMultiSessionManager().getOrCreate();
    return session.browserManager.importCookies(siteId, cookieFilePath);
  }

  // ─── Admin ───────────────────────────────────────────────────

  getStatus(options?: { drainWarnings?: boolean }): EngineStatus {
    return this.deps.engine.getStatus(options);
  }

  getConfig(): SchruteConfig {
    return this.deps.config;
  }
}
