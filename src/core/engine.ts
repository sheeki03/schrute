import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
import { retryWithEscalation } from '../replay/retry.js';
import { AuditLog } from '../replay/audit-log.js';
import { ToolBudgetTracker } from '../replay/tool-budget.js';
import { RateLimiter } from '../automation/rate-limiter.js';
import { refreshCookies } from '../automation/cookie-refresh.js';
import { SideEffectClass, FailureCause } from '../skill/types.js';
import { detectAuth } from '../capture/auth-detector.js';
import { discoverParamsNative as discoverParams } from '../native/param-discoverer.js';
import { detectChains } from '../capture/chain-detector.js';
import { parseHar, extractRequestResponse, type StructuredRecord } from '../capture/har-extractor.js';
import { filterRequestsNative as filterRequests } from '../native/noise-filter.js';
import { clusterEndpoints } from '../capture/api-extractor.js';
import { generateSkill } from '../skill/generator.js';

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

// ─── Persisted Session State ──────────────────────────────────────

interface PersistedSessionState {
  sessionId: string;
  siteId: string;
  url: string;
  mode: EngineMode;
  currentRecording: RecordingInfo | null;
}

function getSessionStatePath(config: OneAgentConfig): string {
  return path.join(config.dataDir, 'session.json');
}

function loadSessionState(config: OneAgentConfig): PersistedSessionState | null {
  const statePath = getSessionStatePath(config);
  try {
    if (fs.existsSync(statePath)) {
      const raw = fs.readFileSync(statePath, 'utf-8');
      return JSON.parse(raw) as PersistedSessionState;
    }
  } catch {
    // Corrupted or unreadable state file
  }
  return null;
}

function saveSessionState(config: OneAgentConfig, state: PersistedSessionState | null): void {
  const statePath = getSessionStatePath(config);
  try {
    if (state === null) {
      if (fs.existsSync(statePath)) {
        fs.unlinkSync(statePath);
      }
    } else {
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
    }
  } catch {
    // Best effort
  }
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
  private rateLimiter: RateLimiter;

  constructor(config: OneAgentConfig) {
    this.config = config;
    this.sessionManager = new SessionManager();
    this.startedAt = Date.now();

    // Restore persisted session state for cross-process CLI continuity
    const persisted = loadSessionState(config);
    if (persisted) {
      this.activeSessionId = persisted.sessionId;
      this.mode = persisted.mode;
      this.currentRecording = persisted.currentRecording;
    }

    const db = getDatabase(config);
    this.skillRepo = new SkillRepository(db);
    this.metricsRepo = new MetricsRepository(db);
    this.auditLog = new AuditLog(config);
    this.budgetTracker = new ToolBudgetTracker(config);
    this.rateLimiter = new RateLimiter();

    // Initialize audit HMAC key from keychain
    this.auditLog.initHmacKey().catch((err) => {
      this.log.warn({ err }, 'Failed to initialize audit HMAC key');
    });
  }

  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  private persistState(): void {
    if (this.mode === 'idle') {
      saveSessionState(this.config, null);
      return;
    }

    const sessions = this.sessionManager.listActive();
    const session = sessions.find(s => s.id === this.activeSessionId);

    saveSessionState(this.config, {
      sessionId: this.activeSessionId ?? '',
      siteId: session?.siteId ?? '',
      url: session?.url ?? '',
      mode: this.mode,
      currentRecording: this.currentRecording,
    });
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

    this.persistState();
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
    this.persistState();
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
    this.persistState();

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
      this.log.info({ recordingId: recording.id, siteId: recording.siteId }, 'Running capture pipeline');

      // Load HAR file from the browser manager via session manager
      const harPath = this.sessionManager.getHarPath(recording.siteId);
      if (!harPath || !fs.existsSync(harPath)) {
        this.log.warn({ recordingId: recording.id }, 'No HAR file available for capture pipeline');
        return;
      }

      // Parse HAR and convert to structured records
      const harData = parseHar(harPath);
      const allRecords: StructuredRecord[] = harData.log.entries.map(extractRequestResponse);

      // Filter noise (analytics, beacons, polling, static assets)
      const { signal } = filterRequests(harData.log.entries);
      const signalRecords: StructuredRecord[] = signal.map(extractRequestResponse);

      if (signalRecords.length === 0) {
        this.log.warn({ recordingId: recording.id }, 'No signal requests after filtering');
        return;
      }

      // Detect auth patterns
      const authRecipe = detectAuth(signalRecords);

      // Discover parameters (needs RequestSample[] with declaredInputs)
      const paramSamples = signalRecords.map(record => ({
        record,
        declaredInputs: recording.inputs,
      }));
      const paramEvidence = discoverParams(paramSamples);

      // Detect request chains
      const chains = detectChains(signalRecords);

      // Cluster endpoints and generate draft skills
      const clusters = clusterEndpoints(signalRecords);
      let generatedCount = 0;
      for (const cluster of clusters) {
        const chainForCluster = chains.find(c =>
          c.steps.some(s => s.skillRef.includes(cluster.pathTemplate)),
        );

        const skill = generateSkill(
          recording.siteId,
          {
            method: cluster.method,
            pathTemplate: cluster.pathTemplate,
            actionName: cluster.pathTemplate.replace(/[^a-zA-Z0-9]/g, '_'),
            inputSchema: cluster.bodyShape ? { type: 'object', properties: cluster.bodyShape } : {},
            requiredHeaders: cluster.commonHeaders,
            sampleCount: cluster.requests.length,
          },
          authRecipe ?? undefined,
          paramEvidence.length > 0 ? paramEvidence : undefined,
          chainForCluster,
        );

        // Persist draft skill if it doesn't already exist
        if (!this.skillRepo.getById(skill.id)) {
          this.skillRepo.create(skill);
          generatedCount++;
        }
      }

      this.log.info(
        {
          recordingId: recording.id,
          authDetected: authRecipe != null,
          paramCount: paramEvidence.length,
          chainCount: chains.length,
          signalRequests: signalRecords.length,
          clusters: clusters.length,
          generatedSkills: generatedCount,
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

    // 3. Rate limit check
    const rateCheck = this.rateLimiter.checkRate(skill.siteId);
    if (!rateCheck.allowed) {
      this.log.warn(
        { skillId, siteId: skill.siteId, retryAfterMs: rateCheck.retryAfterMs },
        'Rate limited — skipping execution',
      );
      return {
        success: false,
        error: `Rate limited for site ${skill.siteId}. Retry after ${rateCheck.retryAfterMs}ms`,
        latencyMs: Date.now() - startTime,
      };
    }

    // 4. Build policy decision for audit
    const policyDecision: PolicyDecision = {
      proposed: `${skill.method} ${skill.pathTemplate}`,
      policyResult: 'allowed',
      policyRule: 'engine.executeSkill',
      userConfirmed: null,
      redactionsApplied: [],
    };

    const executorOptions = {
      auditLog: this.auditLog,
      budgetTracker: this.budgetTracker,
      metricsRepo: this.metricsRepo,
      policyDecision,
    };

    // 5. Execute — use retryWithEscalation for read-only skills
    try {
      const result = skill.sideEffectClass === SideEffectClass.READ_ONLY
        ? await retryWithEscalation(skill, params, executorOptions)
        : await replayExecuteSkill(skill, params, executorOptions);

      // 6. Update rate limiter with response info
      this.rateLimiter.recordResponse(skill.siteId, result.status, result.headers);

      // 7. Record metrics
      this.metricsRepo.record({
        skillId: skill.id,
        executedAt: Date.now(),
        success: result.success,
        latencyMs: result.latencyMs,
        executionTier: result.tier,
        errorType: result.failureCause,
        policyRule: policyDecision.policyRule,
      });

      // 8. On cookie_refresh failure, trigger browser cookie refresh
      if (!result.success && result.failureCause === FailureCause.COOKIE_REFRESH) {
        this.log.info({ skillId, siteId: skill.siteId }, 'Triggering cookie refresh');
        refreshCookies(skill.siteId).catch((err) => {
          this.log.warn({ skillId, err }, 'Cookie refresh failed');
        });
      }

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
    this.persistState();
    this.log.info('Engine closed');
  }
}
