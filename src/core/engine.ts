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
  getSitePolicy,
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
import type { BrowserProvider } from '../skill/types.js';
import { PlaywrightMcpAdapter } from '../browser/playwright-mcp-adapter.js';
import { getFlags } from '../browser/feature-flags.js';
import { BrowserManager } from '../browser/manager.js';
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

/**
 * Remove stale session.json left over from pre-daemon versions.
 * Logs a warning if one is found.
 */
export function removeStaleSessionJson(config: OneAgentConfig): void {
  const statePath = path.join(config.dataDir, 'session.json');
  try {
    if (fs.existsSync(statePath)) {
      const log = getLogger();
      log.warn({ path: statePath }, 'Found stale session.json from pre-daemon version — removing');
      fs.unlinkSync(statePath);
    }
  } catch (err) {
    const rmLog = getLogger();
    rmLog.debug({ err }, 'Failed to remove stale session.json — best effort');
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
  private hmacKeyReady: Promise<void> | null = null;
  private budgetTracker: ToolBudgetTracker;
  private rateLimiter: RateLimiter;
  private isClosing = false;

  constructor(config: OneAgentConfig) {
    this.config = config;
    this.sessionManager = new SessionManager(new BrowserManager(config));
    this.startedAt = Date.now();

    const db = getDatabase(config);
    this.skillRepo = new SkillRepository(db);
    this.metricsRepo = new MetricsRepository(db);
    this.auditLog = new AuditLog(config);
    this.budgetTracker = new ToolBudgetTracker(config);
    this.rateLimiter = new RateLimiter();

    // HMAC key init is deferred to first skill execution (lazy) to avoid
    // blocking constructor and leaking promises when no skills are executed.
  }

  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  async explore(url: string): Promise<ExploreResult> {
    // Validate browser automation capability
    const parsedUrl = new URL(url);
    const siteId = parsedUrl.hostname;

    const capCheck = checkCapability(siteId, Capability.BROWSER_AUTOMATION, this.config);
    if (!capCheck.allowed) {
      throw new Error(`Policy blocked: ${capCheck.reason}`);
    }

    // Validate domain
    const domainCheck = enforceDomainAllowlist(siteId, parsedUrl.hostname, this.config);
    if (!domainCheck.allowed) {
      this.log.debug(
        { siteId, domain: parsedUrl.hostname },
        'Domain not in allowlist, proceeding with exploration (self-domain)',
      );
    }

    // Create browser session with rollback on failure
    const previousMode = this.mode;
    const previousSessionId = this.activeSessionId;
    try {
      const session = await this.sessionManager.create(siteId, url);
      this.activeSessionId = session.id;
      this.mode = 'exploring';

      this.log.info({ sessionId: session.id, url, siteId }, 'Explore session started');

      return {
        sessionId: session.id,
        siteId,
        url,
      };
    } catch (err) {
      this.mode = previousMode;
      this.activeSessionId = previousSessionId;
      throw err;
    }
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

    const previousMode = this.mode;
    const previousRecording = this.currentRecording;
    try {
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
    } catch (err) {
      this.mode = previousMode;
      this.currentRecording = previousRecording;
      throw err;
    }
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

    const browserManager = this.sessionManager.getBrowserManager();
    const siteId = recording.siteId;

    // 1. Capture HAR path BEFORE closing context
    const harPath = browserManager.getHarPath(siteId);

    // 2. Close context -> flushes HAR to disk
    await browserManager.closeContext(siteId);

    // 3. Run capture pipeline with explicit HAR path
    let pipelineError: Error | undefined;
    try {
      await this.runCapturePipeline(recording, harPath);
    } catch (err) {
      pipelineError = err instanceof Error ? err : new Error(String(err));
    }

    // 4. Re-open context so explore mode remains usable (skip during shutdown)
    if (!this.isClosing) {
      try {
        await browserManager.getOrCreateContext(siteId);
        this.log.info({ siteId }, 'Browser context re-opened after recording stop');
      } catch (err) {
        this.log.warn({ siteId, err }, 'Failed to re-open browser context after recording');
      }
    }

    if (pipelineError) {
      throw new Error(`Recording stopped but capture pipeline failed: ${pipelineError.message}`);
    }

    return recording;
  }

  private async runCapturePipeline(recording: RecordingInfo, explicitHarPath?: string): Promise<void> {
    try {
      this.log.info({ recordingId: recording.id, siteId: recording.siteId }, 'Running capture pipeline');

      // Use explicit harPath if provided, otherwise look up from session manager
      const harPath = explicitHarPath ?? this.sessionManager.getHarPath(recording.siteId);
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
      throw err;
    }
  }

  async executeSkill(
    skillId: string,
    params: Record<string, unknown>,
  ): Promise<SkillExecutionResult> {
    const startTime = Date.now();

    // Lazily initialize audit HMAC key on first skill execution
    if (!this.hmacKeyReady) {
      this.hmacKeyReady = this.auditLog.initHmacKey().catch((err) => {
        this.log.warn({ err }, 'Failed to initialize audit HMAC key');
        if (this.config.audit?.strictMode) {
          throw new Error(`Audit HMAC key initialization failed in strict mode: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    }
    await this.hmacKeyReady;

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
    const methodAllowed = checkMethodAllowed(skill.siteId, skill.method, skill.sideEffectClass, this.config);
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

    // Load domain allowlist into budget tracker (reset every execution to avoid cross-site leaks)
    const policy = getSitePolicy(skill.siteId, this.config);
    if (policy.domainAllowlist.length > 0) {
      this.budgetTracker.setDomainAllowlist(policy.domainAllowlist);
    } else {
      // Use implicit allowlist from skill's declared domains + site host
      const implicitDomains = [...new Set([...skill.allowedDomains, skill.siteId])];
      this.budgetTracker.setDomainAllowlist(implicitDomains);
    }

    // Wire live browser context into executor if available
    let browserProvider: BrowserProvider | undefined;
    const browserManager = this.sessionManager.getBrowserManager();
    if (browserManager.hasContext(skill.siteId)) {
      const context = await browserManager.getOrCreateContext(skill.siteId);
      const pages = context.pages();
      const page = pages[0] ?? await context.newPage();
      const sitePolicy = getSitePolicy(skill.siteId, this.config);
      const domains = sitePolicy.domainAllowlist.length > 0
        ? sitePolicy.domainAllowlist
        : [...new Set([...skill.allowedDomains, skill.siteId])];
      browserProvider = new PlaywrightMcpAdapter(page, domains, { flags: getFlags(this.config), capabilities: browserManager.getCapabilities() ?? undefined });
    }

    const executorOptions = {
      auditLog: this.auditLog,
      budgetTracker: this.budgetTracker,
      metricsRepo: this.metricsRepo,
      policyDecision,
      browserProvider,
      config: this.config,
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
        // Intentionally fire-and-forget: cookie refresh is a background recovery action
        // that should not block the current response. Failures are logged.
        refreshCookies(skill.siteId, undefined, browserManager).catch((err) => {
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
    this.isClosing = true;
    const CLOSE_TIMEOUT_MS = 8000;

    // Wrap close operations with a timeout to prevent hangs from unresponsive browser.
    // Each step is wrapped individually so a failing stopRecording() doesn't skip sessionManager.close().
    const closeOps = async () => {
      if (this.currentRecording) {
        try {
          await this.stopRecording();
        } catch (err) {
          this.log.warn({ err }, 'stopRecording() failed during close — continuing cleanup');
          this.currentRecording = null;
        }
      }
      if (this.activeSessionId) {
        await this.sessionManager.close(this.activeSessionId);
        this.activeSessionId = null;
      }
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closeOps(),
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Engine close timed out')), CLOSE_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      this.log.warn({ err }, 'Engine close timed out or failed — forcing cleanup');
      this.activeSessionId = null;
      this.currentRecording = null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    this.mode = 'idle';
    this.log.info('Engine closed');
  }
}
