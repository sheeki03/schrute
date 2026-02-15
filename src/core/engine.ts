import { randomUUID } from 'node:crypto';
import { getLogger } from './logger.js';
import type { OneAgentConfig, SkillSpec, PolicyDecision } from '../skill/types.js';
import { SessionManager, type SessionInfo } from './session.js';
import {
  checkCapability,
  enforceDomainAllowlist,
  checkMethodAllowed,
  checkPathRisk,
} from './policy.js';
import { Capability } from '../skill/types.js';
import { getDatabase } from '../storage/database.js';
import { SkillRepository } from '../storage/skill-repository.js';
import { MetricsRepository } from '../storage/metrics-repository.js';
import { executeSkill as replayExecuteSkill } from '../replay/executor.js';
import { AuditLog } from '../replay/audit-log.js';
import { ToolBudgetTracker } from '../replay/tool-budget.js';
import { detectAuth } from '../capture/auth-detector.js';
import { discoverParams } from '../capture/param-discoverer.js';
import { detectChains } from '../capture/chain-detector.js';

// ─── Types ────────────────────────────────────────────────────────

export type EngineMode = 'idle' | 'exploring' | 'recording' | 'replaying';

export interface EngineStatus {
  mode: EngineMode;
  activeSession: SessionInfo | null;
  currentRecording: RecordingInfo | null;
  uptime: number;
}

export interface RecordingInfo {
  id: string;
  name: string;
  siteId: string;
  startedAt: number;
  requestCount: number;
  inputs?: Record<string, string>;
}

export interface ExploreResult {
  sessionId: string;
  siteId: string;
  url: string;
}

export interface SkillExecutionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  latencyMs: number;
}

// ─── Engine ───────────────────────────────────────────────────────

export class Engine {
  private config: OneAgentConfig;
  private sessionManager: SessionManager;
  private mode: EngineMode = 'idle';
  private activeSessionId: string | null = null;
  private currentRecording: RecordingInfo | null = null;
  private startedAt: number;
  private log = getLogger();
  private skillRepo: SkillRepository;
  private metricsRepo: MetricsRepository;
  private auditLog: AuditLog;
  private budgetTracker: ToolBudgetTracker;

  constructor(config: OneAgentConfig) {
    this.config = config;
    this.sessionManager = new SessionManager();
    this.startedAt = Date.now();

    const db = getDatabase(config);
    this.skillRepo = new SkillRepository(db);
    this.metricsRepo = new MetricsRepository(db);
    this.auditLog = new AuditLog(config);
    this.budgetTracker = new ToolBudgetTracker(config);
  }

  async explore(url: string): Promise<ExploreResult> {
    // Validate browser automation capability
    const parsedUrl = new URL(url);
    const siteId = parsedUrl.hostname;

    const capCheck = checkCapability(siteId, Capability.BROWSER_AUTOMATION);
    if (!capCheck.allowed) {
      throw new Error(`Policy blocked: ${capCheck.reason}`);
    }

    // Validate domain
    const domainCheck = enforceDomainAllowlist(siteId, parsedUrl.hostname);
    if (!domainCheck.allowed) {
      this.log.debug(
        { siteId, domain: parsedUrl.hostname },
        'Domain not in allowlist, proceeding with exploration (self-domain)',
      );
    }

    // Create browser session
    const session = await this.sessionManager.create(siteId, url);
    this.activeSessionId = session.id;
    this.mode = 'exploring';

    this.log.info({ sessionId: session.id, url, siteId }, 'Explore session started');

    return {
      sessionId: session.id,
      siteId,
      url,
    };
  }

  async startRecording(
    name: string,
    inputs?: Record<string, string>,
  ): Promise<RecordingInfo> {
    if (this.mode !== 'exploring') {
      throw new Error(
        `Cannot start recording in '${this.mode}' mode. Must be exploring first.`,
      );
    }

    if (!this.activeSessionId) {
      throw new Error('No active session to record');
    }

    const session = await this.sessionManager.resume(this.activeSessionId);

    this.currentRecording = {
      id: randomUUID(),
      name,
      siteId: session.siteId,
      startedAt: Date.now(),
      requestCount: 0,
      inputs,
    };

    this.mode = 'recording';
    this.log.info(
      { recordingId: this.currentRecording.id, name, siteId: session.siteId },
      'Recording started',
    );

    return { ...this.currentRecording };
  }

  async stopRecording(): Promise<RecordingInfo> {
    if (this.mode !== 'recording' || !this.currentRecording) {
      throw new Error('No active recording to stop');
    }

    const recording = { ...this.currentRecording };
    this.currentRecording = null;
    this.mode = 'exploring';

    this.log.info(
      { recordingId: recording.id, name: recording.name, requests: recording.requestCount },
      'Recording stopped',
    );

    // Run capture pipeline on the recorded HAR data
    await this.runCapturePipeline(recording);

    return recording;
  }

  private async runCapturePipeline(recording: RecordingInfo): Promise<void> {
    try {
      // The session's HAR data is available via the browser manager.
      // For now, the pipeline works on StructuredRecords built from
      // HAR entries that were captured during the recording window.
      // In a full integration the BrowserManager would provide the HAR path;
      // here we process whatever the session manager collected.

      const session = this.sessionManager.listActive().find(s => s.siteId === recording.siteId);
      if (!session) {
        this.log.warn({ recordingId: recording.id }, 'No active session for capture pipeline');
        return;
      }

      this.log.info({ recordingId: recording.id, siteId: recording.siteId }, 'Running capture pipeline');

      // Detect auth patterns from the session (empty entries for now — populated when HAR is loaded)
      const authRecipe = detectAuth([]);

      // Discover parameters using ground truth inputs
      const paramEvidence = discoverParams([]);

      // Detect request chains
      const chains = detectChains([]);

      this.log.info(
        {
          recordingId: recording.id,
          authDetected: authRecipe != null,
          paramCount: paramEvidence.length,
          chainCount: chains.length,
        },
        'Capture pipeline complete',
      );
    } catch (err) {
      this.log.error({ recordingId: recording.id, err }, 'Capture pipeline failed');
    }
  }

  async executeSkill(
    skillId: string,
    params: Record<string, unknown>,
  ): Promise<SkillExecutionResult> {
    const startTime = Date.now();

    this.log.info({ skillId, params }, 'Executing skill');

    // 1. Look up skill spec from storage
    const skill = this.skillRepo.getById(skillId);
    if (!skill) {
      return {
        success: false,
        error: `Skill '${skillId}' not found`,
        latencyMs: Date.now() - startTime,
      };
    }

    // 2. Apply policy checks
    const methodAllowed = checkMethodAllowed(skill.siteId, skill.method, skill.sideEffectClass);
    if (!methodAllowed) {
      return {
        success: false,
        error: `Policy blocked: method ${skill.method} not allowed for ${skill.siteId}`,
        latencyMs: Date.now() - startTime,
      };
    }

    const pathCheck = checkPathRisk(skill.method, skill.pathTemplate);
    if (pathCheck.blocked) {
      return {
        success: false,
        error: `Policy blocked: ${pathCheck.reason ?? 'destructive path pattern'}`,
        latencyMs: Date.now() - startTime,
      };
    }

    // 3. Build policy decision for audit
    const policyDecision: PolicyDecision = {
      proposed: `${skill.method} ${skill.pathTemplate}`,
      policyResult: 'allowed',
      policyRule: 'engine.executeSkill',
      userConfirmed: null,
      redactionsApplied: [],
    };

    // 4. Execute via replay engine
    try {
      const result = await replayExecuteSkill(skill, params, {
        auditLog: this.auditLog,
        budgetTracker: this.budgetTracker,
        metricsRepo: this.metricsRepo,
        policyDecision,
      });

      // 5. Record metrics
      this.metricsRepo.record({
        skillId: skill.id,
        executedAt: Date.now(),
        success: result.success,
        latencyMs: result.latencyMs,
        executionTier: result.tier,
        errorType: result.failureCause,
        policyRule: policyDecision.policyRule,
      });

      return {
        success: result.success,
        data: result.data,
        error: result.failureCause ? `Failure: ${result.failureCause}` : undefined,
        latencyMs: result.latencyMs,
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      this.log.error({ skillId, err }, 'Skill execution error');
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        latencyMs,
      };
    }
  }

  getStatus(): EngineStatus {
    let activeSession: SessionInfo | null = null;
    if (this.activeSessionId) {
      const sessions = this.sessionManager.listActive();
      activeSession = sessions.find((s) => s.id === this.activeSessionId) ?? null;
    }

    return {
      mode: this.mode,
      activeSession,
      currentRecording: this.currentRecording ? { ...this.currentRecording } : null,
      uptime: Date.now() - this.startedAt,
    };
  }

  async close(): Promise<void> {
    if (this.currentRecording) {
      await this.stopRecording();
    }
    if (this.activeSessionId) {
      await this.sessionManager.close(this.activeSessionId);
      this.activeSessionId = null;
    }
    this.mode = 'idle';
    this.log.info('Engine closed');
  }
}
