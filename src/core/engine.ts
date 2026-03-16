import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getLogger } from './logger.js';
import type { SchruteConfig, SkillSpec, PolicyDecision } from '../skill/types.js';
import { SessionManager, type SessionInfo } from './session.js';
import {
  checkCapability,
  enforceDomainAllowlist,
  checkMethodAllowed,
  checkPathRisk,
  getSitePolicy,
  mergeSitePolicy,
} from './policy.js';
import { Capability } from '../skill/types.js';
import { getDatabase } from '../storage/database.js';
import { SkillRepository } from '../storage/skill-repository.js';
import { MetricsRepository } from '../storage/metrics-repository.js';
import { executeSkill as replayExecuteSkill } from '../replay/executor.js';
import { retryWithEscalation, type RetryOptions } from '../replay/retry.js';
import { TrajectoryRecorder, type Trajectory } from '../replay/trajectory.js';
import { AuditLog } from '../replay/audit-log.js';
import { ToolBudgetTracker } from '../replay/tool-budget.js';
import { ExemplarRepository } from '../storage/exemplar-repository.js';
import { RateLimiter } from '../automation/rate-limiter.js';
import { validateParams } from '../replay/param-validator.js';
import { refreshCookies } from '../automation/cookie-refresh.js';
import { SideEffectClass, FailureCause, INFRA_FAILURE_CAUSES, TierState } from '../skill/types.js';
import type { BrowserProvider } from '../skill/types.js';
import { PlaywrightMcpAdapter } from '../browser/playwright-mcp-adapter.js';
import { detectAndWaitForChallenge, isCloudflareChallengePage } from '../browser/base-browser-adapter.js';
import { getFlags } from '../browser/feature-flags.js';
import { BrowserManager, ContextOverrideMismatchError, stableStringify } from '../browser/manager.js';
import type { ContextOverrides } from '../browser/manager.js';
import { BrowserPool } from '../browser/pool.js';
import { MultiSessionManager, DEFAULT_SESSION_NAME } from '../browser/multi-session.js';
import type { BrowserBackend } from '../browser/backend.js';
import { BrowserAuthStore } from '../browser/auth-store.js';
import { AuthCoordinator } from '../browser/auth-coordinator.js';
import { AgentBrowserBackend } from '../browser/agent-browser-backend.js';
import { PlaywrightBackend } from '../browser/playwright-backend.js';
import { LiveChromeBackend } from '../browser/live-chrome-backend.js';
import { BoundedMap } from '../shared/bounded-map.js';
import {
  cleanupManagedChromeLaunches,
  listManagedChromeMetadata,
  launchManagedChrome,
  removeManagedChromeMetadata,
  terminateManagedChrome,
  waitForDevToolsActivePort,
  writeManagedChromeMetadata,
} from '../browser/real-browser-handoff.js';
import { detectAuth } from '../capture/auth-detector.js';
import { discoverParamsNative as discoverParams } from '../native/param-discoverer.js';
import { detectChains } from '../capture/chain-detector.js';
import { parseHar, extractRequestResponse, type StructuredRecord } from '../capture/har-extractor.js';
import { filterRequestsNative as filterRequests } from '../native/noise-filter.js';
import { clusterEndpoints } from '../capture/api-extractor.js';
import { PathTrie } from '../capture/path-trie.js';
import { generateSkill, generateSkillReferences, generateSkillTemplates, generateActionName } from '../skill/generator.js';
import { getSkillsDir } from './config.js';
import { SiteRepository } from '../storage/site-repository.js';
import { MasteryLevel, ExecutionTier } from '../skill/types.js';
import { classifySite } from '../automation/classifier.js';
import { updateStrategy } from '../automation/strategy.js';
import type { NetworkEntry } from '../skill/types.js';
import { canPromote, promoteSkill } from './promotion.js';
import { handleFailure, getEffectiveTier, checkPromotion } from './tiering.js';
import { detectDrift } from '../healing/diff-engine.js';
import { monitorSkills, shouldNudge } from '../healing/monitor.js';
import { AmendmentEngine } from '../healing/amendment.js';
import { AmendmentRepository } from '../storage/amendment-repository.js';
import { scanSkill } from '../skill/security-scanner.js';
import { buildDependencyGraph, getCascadeAffected } from '../skill/dependency-graph.js';
import { notify, createEvent } from '../healing/notification.js';
import { clusterByOperation, canReplayPersistedQuery, extractGraphQLInfo, isGraphQL } from '../capture/graphql-extractor.js';
import { canonicalizeRequest } from '../capture/canonicalizer.js';
import { recordFilteredEntries } from '../capture/noise-filter.js';
import { inferSchema, mergeSchemas } from '../capture/schema-inferrer.js';
import { loadCachedTools } from '../discovery/webmcp-scanner.js';
import { SkillStatus } from '../skill/types.js';
import type { GeoEmulationConfig, PermanentTierLock, ExecutionTierName } from '../skill/types.js';

// ─── Types ────────────────────────────────────────────────────────

export type EngineMode = 'idle' | 'exploring' | 'recording' | 'replaying';

export interface EngineStatus {
  mode: EngineMode;
  activeSession: SessionInfo | null;
  activeNamedSession?: { name: string; siteId: string; isCdp: boolean; overrides?: ContextOverrides };
  pendingRecovery?: PendingRecoveryStatus;
  currentRecording: RecordingInfo | null;
  uptime: number;
  warnings?: string[];
  skillSummary?: { total: number; executable: number; blocked: number };
}

interface RecordingInfo {
  id: string;
  name: string;
  siteId: string;
  startedAt: number;
  requestCount: number;
  inputs?: Record<string, string>;
  skillsGenerated?: number;
  signalRequests?: number;
  noiseRequests?: number;
  generatedSkills?: Array<{ id: string; method: string; pathTemplate: string; status: string }>;
  dedupedRequests?: number;
}

export interface ExploreReadyResult {
  status: 'ready';
  sessionId: string;
  siteId: string;
  url: string;
  reused?: boolean;
  appliedOverrides?: { proxy?: { server: string }; geo?: GeoEmulationConfig };
  hint: string;
}

export interface ExploreHandoffRequiredResult {
  status: 'browser_handoff_required';
  reason: 'cloudflare_challenge';
  recoveryMode: 'real_browser_cdp';
  siteId: string;
  url: string;
  hint: string;
  resumeToken?: string;
  advisoryHint?: string;
}

export type ExploreResult = ExploreReadyResult | ExploreHandoffRequiredResult;

export interface PendingRecoveryStatus {
  reason: 'cloudflare_challenge';
  recoveryMode: 'real_browser_cdp';
  siteId: string;
  url: string;
  hint: string;
  resumeToken?: string;
  advisoryHint?: string;
}

export interface RecoverExploreResult {
  status: 'ready' | 'awaiting_user' | 'expired' | 'failed';
  siteId: string;
  url: string;
  session?: string;
  managedBrowser?: boolean;
  hint: string;
}

interface RecoveryState {
  resumeToken: string;
  recoveryId: string;
  siteId: string;
  url: string;
  hint: string;
  createdAt: number;
  cdpSessionName: string;
  managedProfileDir: string;
  managedPid?: number;
  managedBrowser: boolean;
  priorPolicySnapshot?: Record<string, unknown>;
  exploreSessionNameBeforeRecovery: string;
  currentState: 'pending' | 'awaiting_user' | 'ready' | 'failed';
  failureReason?: string;
  advisoryHint?: string;
  overrides?: ContextOverrides;
  autoRecoverSupported: boolean;
}

export interface SkillExecutionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  failureCause?: string;
  failureDetail?: string;
  latencyMs: number;
}

function formatExecutionError(cause: string, detail: string): string {
  return `Failure: ${cause} — ${detail.replace(/\.+$/, '')}. Use schrute_dry_run to preview.`;
}

/**
 * Remove stale session.json left over from pre-daemon versions.
 * Logs a warning if one is found.
 */
export function removeStaleSessionJson(config: SchruteConfig): void {
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

/**
 * Traceability markers used in this file reference the Schrute implementation plan:
 *   C = Capture pipeline steps
 *       C1: GraphQL clustering (operation-level grouping of GraphQL requests)
 *       C2: Canonicalization (request deduplication via canonical URL/body)
 *       C3: Noise filter persistence (audit trail for filtered entries and action frames)
 *       C5: Cold-start discovery (WebMCP scanning and endpoint seeding on first visit)
 *   A = Analysis / promotion steps
 *       A1: Skill tracking (sample counting, confidence updates, promotion checks)
 *       A2: Structural failure handling (tier lock on non-recoverable causes)
 *   B = Health / healing steps
 *       B1: Drift detection (schema inference and breaking-change enforcement)
 *       B2: Health monitoring (success-rate tracking and degradation alerts)
 */

/** Minimal page interface for provider cache — avoids importing full Playwright types */
interface CachedPage { isClosed?: () => boolean }

// ─── Engine ───────────────────────────────────────────────────────

export class Engine {
  private config: SchruteConfig;
  private sessionManager: SessionManager;
  private mode: EngineMode = 'idle';
  private activeSessionId: string | null = null;
  private exploreSessionName = DEFAULT_SESSION_NAME;
  private recordingSessionName: string | null = null;
  private currentRecording: RecordingInfo | null = null;
  private recordingBrowserManager: BrowserManager | null = null;
  private startedAt: number;
  private log = getLogger();
  private skillRepo: SkillRepository;
  private siteRepo: SiteRepository;
  private metricsRepo: MetricsRepository;
  private trajectoryRecorder: TrajectoryRecorder;
  private exemplarRepo: ExemplarRepository;
  private auditLog: AuditLog;
  private hmacKeyReady: Promise<void> | null = null;
  private budgetTracker: ToolBudgetTracker;
  private rateLimiter: RateLimiter;
  private isClosing = false;
  private pool: BrowserPool | null = null;
  private multiSessionManager: MultiSessionManager;
  private recordingListenerCleanups: Array<() => void> = [];
  private cdpHarRecorder: import('../capture/cdp-har-recorder.js').CdpHarRecorder | null = null;
  private providerCache = new WeakMap<
    BrowserManager,
    Map<string, { adapter: PlaywrightMcpAdapter; page: CachedPage; domainsKey: string }>
  >();
  private inflightDedup = new Map<string, Promise<SkillExecutionResult>>();
  private exploreAbortController: AbortController | null = null;
  private pendingBackgroundOps = new Set<Promise<void>>();
  private warnings: string[] = [];
  private static readonly MAX_WARNINGS = 100;
  private static readonly RECOVERY_TTL_MS = 15 * 60 * 1000;
  private readonly recoveries = new BoundedMap<string, RecoveryState>({
    maxSize: 100,
    ttlMs: Engine.RECOVERY_TTL_MS,
  });
  private sessionSweepInterval: ReturnType<typeof setInterval> | null = null;
  private backoffPersistInterval: ReturnType<typeof setInterval> | null = null;
  private sweepInterval: ReturnType<typeof setInterval> | null = null;
  private amendmentEngine: AmendmentEngine | null = null;
  private amendmentRepo: AmendmentRepository | null = null;
  private authStore: BrowserAuthStore;
  private authCoordinator: AuthCoordinator;
  private agentBrowserBackend: AgentBrowserBackend;
  private fallbackExecutionBackend: PlaywrightBackend | null = null;
  private sharedPlaywrightBackends = new Map<string, PlaywrightBackend>();
  private liveChromeBackend?: LiveChromeBackend;
  private pathTrie?: PathTrie;

  constructor(config: SchruteConfig) {
    this.config = config;

    // Adaptive path trie for clustering deduplication (default: enabled)
    if (config.features?.adaptivePathTrie !== false) {
      this.pathTrie = new PathTrie();
    }

    // Construct BrowserPool when remote endpoints are configured
    if (config.browserPool?.endpoints?.length) {
      this.pool = new BrowserPool(config.browserPool.endpoints);
    }

    const browserManager = new BrowserManager(config, this.pool ?? undefined);
    this.sessionManager = new SessionManager(browserManager);
    this.multiSessionManager = new MultiSessionManager(browserManager, config, this.pool ?? undefined);
    this.multiSessionManager.setOnSessionChanged((name) => {
      this.sharedPlaywrightBackends.delete(name);
      if (this.exploreSessionName === name) {
        this.exploreSessionName = DEFAULT_SESSION_NAME;
      }
      if (this.recordingSessionName === name) {
        this.recordingSessionName = null;
      }
    });
    this.startedAt = Date.now();

    const db = getDatabase(config);
    this.skillRepo = new SkillRepository(db);
    this.siteRepo = new SiteRepository(db);
    this.metricsRepo = new MetricsRepository(db);
    this.trajectoryRecorder = new TrajectoryRecorder(config.dataDir);
    this.exemplarRepo = new ExemplarRepository(db);
    this.auditLog = new AuditLog(config);
    this.budgetTracker = new ToolBudgetTracker(config);
    this.rateLimiter = new RateLimiter();
    this.rateLimiter.attachDatabase(db);

    // Persist rate limiter backoffs every 60 seconds
    this.backoffPersistInterval = setInterval(() => {
      this.rateLimiter.persistBackoffs();
    }, 60_000);
    this.backoffPersistInterval.unref();

    // Amendment engine for self-healing skills
    this.amendmentRepo = new AmendmentRepository(db);
    this.amendmentEngine = new AmendmentEngine(this.amendmentRepo, this.skillRepo, this.metricsRepo);

    // Phase 5: Auth store, coordinator, and agent-browser backend
    this.authStore = new BrowserAuthStore(config.dataDir);
    this.authCoordinator = new AuthCoordinator();
    this.agentBrowserBackend = new AgentBrowserBackend(config, this.authStore);
    this.agentBrowserBackend.setAuthCoordinator(this.authCoordinator);

    // Wire auth integration into the default BrowserManager and MultiSessionManager
    browserManager.setAuthIntegration(this.authStore, this.authCoordinator, DEFAULT_SESSION_NAME);
    this.multiSessionManager.setAuthIntegration(this.authStore, this.authCoordinator);

    // LiveChromeBackend: fallback to CDP sessions for WebMCP skills
    this.liveChromeBackend = new LiveChromeBackend(this.multiSessionManager, this.authStore);

    this.cleanupStaleRecoveryPolicies();
    cleanupManagedChromeLaunches(config).catch(err => {
      this.log.debug({ err }, 'Managed Chrome cleanup failed during startup');
    });

    // HMAC key init is deferred to first skill execution (lazy) to avoid
    // blocking constructor and leaking promises when no skills are executed.

    // Session sweep: clean up idle named sessions every 15 minutes
    this.sessionSweepInterval = setInterval(() => {
      this.multiSessionManager.sweepIdleSessions(3600_000);
    }, 900_000);
    this.sessionSweepInterval.unref();

    // WS-10: Background sweep for stale/broken skills (every 6 hours)
    this.sweepInterval = setInterval(() => {
      if (this.getStatus().mode !== 'idle') return; // Only sweep when idle
      try {
        const allSkills = this.skillRepo.getByStatus(SkillStatus.ACTIVE);

        // Build dependency graph for cascade marking
        const depGraph = buildDependencyGraph(allSkills);

        // Process in batches of 50
        const brokenIds: string[] = [];
        for (let i = 0; i < allSkills.length; i += 50) {
          const batch = allSkills.slice(i, i + 50);
          const reports = monitorSkills(batch, this.metricsRepo);
          for (let j = 0; j < batch.length; j++) {
            const report = reports[j];
            if (report?.status === 'broken') {
              this.skillRepo.update(batch[j].id, { status: SkillStatus.BROKEN, consecutiveValidations: 0 });
              this.log.info({ skillId: batch[j].id }, 'Background sweep: marked skill as broken');
              brokenIds.push(batch[j].id);
            } else if (report && shouldNudge(report)) {
              // Nudge: skill is healthy but trending down — emit notification
              notify(
                createEvent('skill_nudge', batch[j].id, batch[j].siteId, {
                  successRate: report.successRate,
                  trend: report.trend,
                }),
                this.config,
              ).catch(err => this.log.debug({ err }, 'Nudge notification failed'));
            }
          }
        }

        // Cascade: mark dependents of broken skills as stale
        for (const brokenId of brokenIds) {
          const affected = getCascadeAffected(depGraph, brokenId);
          for (const depId of affected) {
            const dep = this.skillRepo.getById(depId);
            if (dep && dep.status === 'active') {
              this.skillRepo.update(depId, { status: SkillStatus.STALE });
              this.log.info({ skillId: depId, brokenBy: brokenId }, 'Background sweep: cascade-marked dependent as stale');
            }
          }
        }

        // Auth prefetch: refresh stale cookies for recently-used sites (fire-and-forget)
        this.prefetchStaleAuth(allSkills).catch(err =>
          this.log.debug({ err }, 'Auth prefetch sweep failed (non-blocking)'),
        );
      } catch (err) {
        this.log.debug({ err }, 'Background sweep failed (non-blocking)');
      }
    }, 6 * 60 * 60 * 1000);
    this.sweepInterval.unref();
  }

  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  getMultiSessionManager(): MultiSessionManager {
    return this.multiSessionManager;
  }

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  getMode(): EngineMode {
    return this.mode;
  }

  getExploreSessionName(): string {
    return this.exploreSessionName;
  }

  getRecordingSessionName(): string | null {
    return this.recordingSessionName;
  }

  private getExploreBrowserManager(): BrowserManager {
    const session = this.multiSessionManager.get(this.exploreSessionName);
    return session?.browserManager ?? this.sessionManager.getBrowserManager();
  }

  getMetricsRepo(): MetricsRepository {
    return this.metricsRepo;
  }

  getAmendmentRepo(): AmendmentRepository | null {
    return this.amendmentRepo;
  }

  getTrajectoryRecorder(): TrajectoryRecorder {
    return this.trajectoryRecorder;
  }

  getExemplarRepo(): ExemplarRepository {
    return this.exemplarRepo;
  }

  getAuthStore(): BrowserAuthStore { return this.authStore; }
  getAuthCoordinator(): AuthCoordinator { return this.authCoordinator; }

  private cleanupStaleRecoveryPolicies(): void {
    try {
      const db = getDatabase(this.config);
      const metadataBySession = new Map(
        listManagedChromeMetadata(this.config)
          .filter(meta => meta.sessionName)
          .map(meta => [meta.sessionName as string, meta]),
      );
      const staleRecoveryPolicies = db.all<{ site_id: string; execution_session_name: string }>(
        `SELECT site_id, execution_session_name
           FROM policies
          WHERE execution_backend = 'live-chrome'
            AND execution_session_name GLOB '__recovery_*'`,
      );

      for (const row of staleRecoveryPolicies) {
        if (this.multiSessionManager.get(row.execution_session_name)) {
          continue;
        }
        const recoveryMetadata = metadataBySession.get(row.execution_session_name);
        const overlay = recoveryMetadata?.priorPolicySnapshot
          ? recoveryMetadata.priorPolicySnapshot
          : {
              executionBackend: undefined,
              executionSessionName: undefined,
            };
        const result = mergeSitePolicy(row.site_id, overlay as any, this.config);
        if (result.persisted) {
          this.log.warn(
            { siteId: row.site_id, sessionName: row.execution_session_name },
            recoveryMetadata?.priorPolicySnapshot
              ? 'Restored stale recovery-owned policy overlay during startup'
              : 'Cleared stale recovery-owned live-chrome policy overlay during startup',
          );
        } else {
          this.log.warn(
            { siteId: row.site_id, sessionName: row.execution_session_name },
            recoveryMetadata?.priorPolicySnapshot
              ? 'Restored stale recovery-owned policy overlay in-memory but failed to persist during startup'
              : 'Cleared stale recovery-owned live-chrome policy overlay in-memory but failed to persist during startup',
          );
        }
        if (recoveryMetadata?.profileDir && !recoveryMetadata.pid) {
          removeManagedChromeMetadata(recoveryMetadata.profileDir);
        }
      }
    } catch (err) {
      this.log.debug({ err }, 'Stale recovery policy cleanup failed during startup');
    }
  }

  /**
   * Per-site execution backend router.
   * Returns the appropriate BrowserBackend based on site policy and config.
   */
  getExecutionBackend(siteId: string): BrowserBackend {
    const policy = getSitePolicy(siteId, this.config);
    const backendType = policy.executionBackend ?? this.config.browser?.execution?.backend ?? 'agent-browser';

    if (backendType === 'agent-browser') {
      return this.agentBrowserBackend;
    }

    if (backendType === 'live-chrome') {
      // Live Chrome: find a CDP session for this site
      if (this.liveChromeBackend) {
        const liveResult = this.liveChromeBackend.findSession(siteId, policy.executionSessionName);
        if (liveResult) {
          return this.getOrCreateSharedPlaywrightBackend(liveResult.sessionName, liveResult.browserManager);
        }
      }
      // No matching CDP session — fall through to Playwright
      this.log.debug({ siteId }, 'live-chrome backend: no CDP session found, falling through');
    }

    // Playwright execution — two modes:
    if (policy.executionSessionName) {
      // HARD-SITE: shared explore context required
      const multiSession = this.getMultiSessionManager();
      const session = multiSession.get(policy.executionSessionName);
      if (session?.browserManager.tryGetContext(siteId)) {
        return this.getOrCreateSharedPlaywrightBackend(policy.executionSessionName, session.browserManager);
      }
      throw new Error(
        `Hard-site execution requires live explore context for '${siteId}' in session '${policy.executionSessionName}'. Explore first.`
      );
    }

    // GENERAL: dedicated execution PlaywrightBackend (separate from explore)
    if (!this.fallbackExecutionBackend) {
      const dedicatedManager = new BrowserManager(this.config, this.pool ?? undefined);
      dedicatedManager.setAuthIntegration(this.authStore, this.authCoordinator, '__exec_fallback__');
      this.fallbackExecutionBackend = new PlaywrightBackend(
        dedicatedManager,
        this.config,
      );
      this.fallbackExecutionBackend.setAuthCoordinator(this.authCoordinator, this.authStore);
    }
    return this.fallbackExecutionBackend;
  }

  private getOrCreateSharedPlaywrightBackend(sessionName: string, manager: BrowserManager): PlaywrightBackend {
    let backend = this.sharedPlaywrightBackends.get(sessionName);
    if (!backend) {
      backend = new PlaywrightBackend(manager, this.config, { existingOnly: true });
      this.sharedPlaywrightBackends.set(sessionName, backend);
    }
    return backend;
  }

  drainWarnings(): string[] {
    const w = [...this.warnings];
    this.warnings = [];
    return w;
  }

  /**
   * Read warnings without draining. Used for non-admin status calls
   * so that admin callers don't lose visibility into warnings.
   */
  peekWarnings(): string[] {
    return [...this.warnings];
  }

  private addWarning(msg: string): void {
    if (this.warnings.length >= Engine.MAX_WARNINGS) {
      this.warnings.shift();
    }
    this.warnings.push(msg);
  }

  private isAutomaticRecoverySupported(overrides?: ContextOverrides): boolean {
    return !this.config.server.network && !overrides?.proxy && !overrides?.geo;
  }

  private getCloudflareAdvisoryHint(browserManager?: BrowserManager): string | undefined {
    const effectiveEngine =
      browserManager?.getCapabilities()?.effectiveEngine
      ?? this.getExploreBrowserManager().getCapabilities()?.effectiveEngine
      ?? this.config.browser?.engine
      ?? 'patchright';
    if (effectiveEngine === 'playwright') {
      return 'Retrying with patchright may avoid the Cloudflare challenge on some sites.';
    }
    return undefined;
  }

  private buildRecoveryHint(overrides?: ContextOverrides): string {
    if (this.config.server.network) {
      return 'Cloudflare challenge detected. Automatic Chrome handoff is only supported in local desktop mode. Use schrute_connect_cdp manually on the local machine.';
    }
    if (overrides?.proxy || overrides?.geo) {
      return 'Cloudflare challenge detected. Automatic recovery is unavailable for proxy/geo explore sessions. Retry without overrides or use schrute_connect_cdp manually.';
    }
    return 'Cloudflare challenge detected. Call schrute_recover_explore to continue in real Chrome.';
  }

  private getRecoveryBySiteId(siteId: string): RecoveryState | undefined {
    let match: RecoveryState | undefined;
    for (const entry of this.recoveries.values()) {
      if (entry.siteId === siteId && entry.currentState !== 'ready') {
        if (!match || entry.createdAt > match.createdAt) {
          match = entry;
        }
      }
    }
    return match;
  }

  private getPendingRecoveryStatus(): PendingRecoveryStatus | undefined {
    let newest: RecoveryState | undefined;
    for (const entry of this.recoveries.values()) {
      if (entry.currentState === 'ready') continue;
      if (!newest || entry.createdAt > newest.createdAt) {
        newest = entry;
      }
    }
    if (!newest) return undefined;
    return {
      reason: 'cloudflare_challenge',
      recoveryMode: 'real_browser_cdp',
      siteId: newest.siteId,
      url: newest.url,
      hint: newest.hint,
      ...(newest.autoRecoverSupported ? { resumeToken: newest.resumeToken } : {}),
      ...(newest.advisoryHint ? { advisoryHint: newest.advisoryHint } : {}),
    };
  }

  private upsertPendingRecovery(siteId: string, url: string, overrides?: ContextOverrides): RecoveryState {
    const existing = this.getRecoveryBySiteId(siteId);
    const autoRecoverSupported = this.isAutomaticRecoverySupported(overrides);
    const advisoryHint = this.getCloudflareAdvisoryHint();
    const hint = this.buildRecoveryHint(overrides);
    if (existing) {
      existing.url = url;
      existing.hint = hint;
      existing.overrides = overrides;
      existing.currentState = 'pending';
      existing.failureReason = undefined;
      existing.autoRecoverSupported = autoRecoverSupported;
      existing.advisoryHint = advisoryHint;
      this.recoveries.set(existing.resumeToken, existing);
      return existing;
    }

    const recoveryId = randomUUID();
    const resumeToken = randomUUID();
    const cdpSessionName = `__recovery_${createHash('sha256').update(recoveryId).digest('hex').slice(0, 16)}`;
    const managedProfileDir = path.join(this.config.dataDir, 'browser-data', 'live-chrome', recoveryId);
    const createdAt = Date.now();
    const entry: RecoveryState = {
      resumeToken,
      recoveryId,
      siteId,
      url,
      hint,
      createdAt,
      cdpSessionName,
      managedProfileDir,
      managedBrowser: false,
      exploreSessionNameBeforeRecovery: this.exploreSessionName,
      currentState: 'pending',
      advisoryHint,
      overrides,
      autoRecoverSupported,
    };
    this.recoveries.set(resumeToken, entry);
    return entry;
  }

  private toHandoffResult(entry: RecoveryState): ExploreHandoffRequiredResult {
    return {
      status: 'browser_handoff_required',
      reason: 'cloudflare_challenge',
      recoveryMode: 'real_browser_cdp',
      siteId: entry.siteId,
      url: entry.url,
      hint: entry.hint,
      ...(entry.autoRecoverSupported ? { resumeToken: entry.resumeToken } : {}),
      ...(entry.advisoryHint ? { advisoryHint: entry.advisoryHint } : {}),
    };
  }

  private startCloudflareHeaderProbe(
    page: { on(event: 'response', listener: (response: any) => void): void; off(event: 'response', listener: (response: any) => void): void; mainFrame(): unknown },
    siteId: string,
    url: string,
    overrides?: ContextOverrides,
    signal?: AbortSignal,
  ): Promise<ExploreHandoffRequiredResult | undefined> {
    if (typeof page.on !== 'function' || typeof page.off !== 'function' || typeof page.mainFrame !== 'function') {
      return Promise.resolve(undefined);
    }
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    return new Promise((resolve) => {
      const finish = (value: ExploreHandoffRequiredResult | undefined) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        page.off('response', onResponse);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };

      const onAbort = () => finish(undefined);
      const onResponse = (response: any) => {
        try {
          const request = response.request?.();
          if (!request?.isNavigationRequest?.()) return;
          if (request.frame?.() !== page.mainFrame()) return;
          const responseUrl = response.url?.() ?? '';
          const headers = response.headers?.() ?? {};
          const cfMitigated = String(headers['cf-mitigated'] ?? headers['CF-Mitigated'] ?? '').toLowerCase();
          if (cfMitigated === 'challenge' || responseUrl.includes('/cdn-cgi/')) {
            const recovery = this.upsertPendingRecovery(siteId, responseUrl || url, overrides);
            finish(this.toHandoffResult(recovery));
          }
        } catch (err) {
          this.log.debug({ err, siteId }, 'Cloudflare header probe failed (non-blocking)');
        }
      };

      page.on('response', onResponse);
      signal?.addEventListener('abort', onAbort, { once: true });
      timeout = setTimeout(() => finish(undefined), 1500);
      timeout.unref?.();
    });
  }

  private getProviderCacheForManager(manager: BrowserManager): Map<string, { adapter: PlaywrightMcpAdapter; page: CachedPage; domainsKey: string }> {
    let cache = this.providerCache.get(manager);
    if (!cache) {
      cache = new Map();
      this.providerCache.set(manager, cache);
    }
    return cache;
  }

  private domainsKey(domains: string[]): string {
    return [...domains].sort().join('\u0000');
  }

  /** Resolve adapter from cache or create a new one for the given page/domains */
  private resolveAdapter(
    providerCache: Map<string, { adapter: PlaywrightMcpAdapter; page: CachedPage; domainsKey: string }>,
    siteId: string,
    page: CachedPage,
    domains: string[],
    manager: BrowserManager,
  ): PlaywrightMcpAdapter {
    const domainsKey = this.domainsKey(domains);
    const cached = providerCache.get(siteId);
    const pageIsClosed = cached
      && typeof cached.page.isClosed === 'function'
      && cached.page.isClosed();
    if (cached && !pageIsClosed && cached.page === page && cached.domainsKey === domainsKey) {
      return cached.adapter;
    }
    const adapter = new PlaywrightMcpAdapter(page as any, domains, {
      flags: getFlags(this.config),
      capabilities: manager.getCapabilities() ?? undefined,
      handlerTimeoutMs: manager.getHandlerTimeoutMs(),
    });
    providerCache.set(siteId, { adapter, page, domainsKey });
    return adapter;
  }

  resetExploreState(expectedId: string | null): void {
    if (this.activeSessionId !== expectedId) return;
    if (this.activeSessionId) {
      this.sessionManager.remove(this.activeSessionId);
    }
    this.activeSessionId = null;
    this.exploreSessionName = DEFAULT_SESSION_NAME;
    this.recordingSessionName = null;
    this.mode = 'idle';
    this.multiSessionManager.updateSiteId(DEFAULT_SESSION_NAME, '');
    this.multiSessionManager.updateContextOverrides(DEFAULT_SESSION_NAME, undefined);
  }

  /**
   * Create a BrowserProvider for the given site.
   *
   * Without lazy: returns undefined when no context exists (skill execution, discovery).
   * With lazy: calls getOrCreateContext which triggers launchBrowser (tool dispatch).
   */
  async createBrowserProvider(
    siteId: string,
    domains?: string[],
    options?: { browserManager?: BrowserManager; lazy?: boolean; overrides?: ContextOverrides },
  ): Promise<PlaywrightMcpAdapter | undefined> {
    const manager = options?.browserManager ?? this.getExploreBrowserManager();
    const providerCache = this.getProviderCacheForManager(manager);

    // Non-lazy path: return existing context atomically (no TOCTOU race).
    // tryGetContext() returns undefined if no context exists, avoiding
    // an unwanted browser launch between hasContext() and getOrCreateContext().
    if (!options?.lazy) {
      const existing = manager.tryGetContext(siteId);
      if (!existing) {
        providerCache.delete(siteId);
        return undefined;
      }
      const page = await manager.getSelectedOrFirstPage(siteId, existing);
      return this.resolveAdapter(providerCache, siteId, page, domains ?? [siteId], manager);
    }

    const context = await manager.getOrCreateContext(siteId, options?.overrides);
    const page = await manager.getSelectedOrFirstPage(siteId, context);
    return this.resolveAdapter(providerCache, siteId, page, domains ?? [siteId], manager);
  }

  private navigateFireAndForget(
    siteId: string,
    url: string,
    overrides?: ContextOverrides,
    sessionId?: string,
    signal?: AbortSignal,
    browserManager?: BrowserManager,
  ): Promise<void> {
    const bm = browserManager ?? this.getExploreBrowserManager();
    return bm.withLease(async () => {
      if (signal?.aborted) return;
      const context = await bm.getOrCreateContext(siteId, overrides);
      if (signal?.aborted) return;
      const page = await bm.getSelectedOrFirstPage(siteId, context);

      const gotoOpts: Record<string, unknown> = { waitUntil: 'domcontentloaded', timeout: 30000 };
      // Referrer spoofing for explore navigation
      if (this.config.browser?.features?.referrerSpoofing) {
        try {
          const currentHost = new URL(page.url()).hostname;
          const targetHost = new URL(url).hostname;
          if (currentHost !== targetHost) {
            gotoOpts.referer = 'https://www.google.com/';
          }
        } catch {
          // Invalid URLs — skip spoofing
        }
      }

      if (signal?.aborted) return;
      await page.goto(url, gotoOpts);
      if (signal?.aborted) return;
      const challengePresent = await isCloudflareChallengePage(page);
      if (challengePresent) {
        const resolved = await detectAndWaitForChallenge(page, 3000);
        if (!resolved) {
          const recovery = this.upsertPendingRecovery(siteId, page.url() || url, overrides);
          this.addWarning(`Cloudflare challenge is blocking ${siteId}. ${recovery.hint}`);
        }
      } else {
        await detectAndWaitForChallenge(page, 3000);
      }
      if (sessionId) this.sessionManager.updateUrl(sessionId, page.url());
    }).catch(err => {
      if (signal?.aborted && String(err).includes('TargetClosedError')) return;
      this.log.warn({ url, err }, 'Auto-navigation after explore failed (non-blocking)');
      if (!signal?.aborted) {
        this.addWarning(`Auto-navigation failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  async explore(url: string, overrides?: ContextOverrides): Promise<ExploreResult> {
    // Abort any previous explore background ops before starting new ones
    this.exploreAbortController?.abort();
    this.exploreAbortController = new AbortController();
    const signal = this.exploreAbortController.signal;

    const parsedUrl = new URL(url);
    const siteId = parsedUrl.hostname;

    // Re-explore same site: reuse session, navigate to new URL
    if (this.mode === 'exploring' && this.activeSessionId) {
      const currentSession = this.sessionManager.getSession(this.activeSessionId);
      if (currentSession?.siteId === siteId) {
        try {
          const browserManager = this.getExploreBrowserManager();
          const context = await browserManager.getOrCreateContext(siteId, overrides);
          const page = await browserManager.getSelectedOrFirstPage(siteId, context);
          const probe = this.startCloudflareHeaderProbe(page as any, siteId, url, overrides, signal);
          const navOp = this.navigateFireAndForget(siteId, url, overrides, currentSession.id, signal, browserManager)
            .finally(() => this.pendingBackgroundOps.delete(navOp));
          this.pendingBackgroundOps.add(navOp);
          const handoffResult = await probe;
          if (handoffResult) {
            return handoffResult;
          }
          return {
            status: 'ready',
            sessionId: currentSession.id,
            siteId,
            url,
            reused: true,
            hint: 'Session reused. Navigate or call schrute_record to capture.',
          };
        } catch (err) {
          if (err instanceof ContextOverrideMismatchError) {
            throw new Error(
              `Site "${siteId}" already has an active session with different overrides. ` +
              `Use schrute_close_session(name: "default", force: true) first, then re-explore.`
            );
          }
          throw err;
        }
      }
    }

    // Different site while exploring/recording: explicit rejection
    if (this.mode !== 'idle') {
      throw new Error(
        `Engine is currently '${this.mode}'${this.mode === 'exploring' ? ' on a different site' : ''}. ` +
        `Only one explore/record session is supported at a time. ` +
        `Stop the current session first with schrute_stop.`
      );
    }

    // Validate browser automation capability

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

    // Ensure site exists in DB (upsert: create if missing, update last_visited if exists)
    const db = getDatabase(this.config);
    const siteRepo = new SiteRepository(db);
    const existingSite = siteRepo.getById(siteId);
    if (!existingSite) {
      siteRepo.create({
        id: siteId,
        displayName: siteId,
        firstSeen: Date.now(),
        lastVisited: Date.now(),
        masteryLevel: MasteryLevel.EXPLORE,
        recommendedTier: ExecutionTier.BROWSER_PROXIED,
        totalRequests: 0,
        successfulRequests: 0,
      });
    } else {
      siteRepo.update(siteId, { lastVisited: Date.now() });
    }

    // Create browser session with rollback on failure
    const previousMode = this.mode;
    const previousSessionId = this.activeSessionId;
    try {
      const { session, browserError } = await this.sessionManager.create(siteId, url, overrides);
      if (browserError) {
        // explore() requires a browser — fail loudly with the actual error
        this.sessionManager.remove(session.id);
        const browserEngine = this.config.browser?.engine ?? 'patchright';
        const installHints: Record<string, string> = {
          playwright: 'npx playwright install chromium',
          patchright: 'npm install patchright && npx patchright install chromium',
          camoufox: 'npm install camoufox-js && npx camoufox-js fetch',
        };
        throw new Error(
          `Browser context could not be created for '${siteId}': ${browserError.message}. ` +
          `If this is an install issue, try: ${installHints[browserEngine] ?? `npx ${browserEngine} install chromium`}`,
        );
      }
      this.activeSessionId = session.id;
      this.exploreSessionName = DEFAULT_SESSION_NAME;
      this.recordingSessionName = null;
      this.mode = 'exploring';

      // Sync default session siteId
      this.multiSessionManager.updateSiteId(DEFAULT_SESSION_NAME, siteId);
      this.multiSessionManager.updateContextOverrides(DEFAULT_SESSION_NAME, overrides);

      this.log.info({ sessionId: session.id, url, siteId }, 'Explore session started');

      // Track background ops so startRecording/close can await them
      const exploreManager = this.getExploreBrowserManager();
      const context = await exploreManager.getOrCreateContext(siteId, overrides);
      const page = await exploreManager.getSelectedOrFirstPage(siteId, context);
      const probe = this.startCloudflareHeaderProbe(page as any, siteId, url, overrides, signal);
      const navOp = this.navigateFireAndForget(siteId, url, overrides, session.id, signal, exploreManager)
        .finally(() => this.pendingBackgroundOps.delete(navOp));
      this.pendingBackgroundOps.add(navOp);

      const handoffResult = await probe;
      if (handoffResult) {
        return handoffResult;
      }

      // Fire-and-forget cold-start discovery (non-blocking)
      const discoveryOp = this.runColdStartDiscovery(url, siteId, signal)
        .catch(err => {
          if (!signal.aborted) {
            this.log.warn({ siteId, err }, 'Cold-start discovery failed (non-blocking)');
            this.addWarning(`Cold-start discovery failed for ${siteId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        })
        .finally(() => this.pendingBackgroundOps.delete(discoveryOp));
      this.pendingBackgroundOps.add(discoveryOp);

      const appliedOverrides = overrides ? {
        proxy: overrides.proxy ? { server: overrides.proxy.server } : undefined,
        geo: overrides.geo,
      } : undefined;

      return {
        status: 'ready',
        sessionId: session.id,
        siteId,
        url,
        appliedOverrides,
        hint: 'Browser session started. Navigate with browser tools, then call schrute_record to capture API patterns.',
      };
    } catch (err) {
      this.mode = previousMode;
      this.activeSessionId = previousSessionId;
      throw err;
    }
  }

  private async cancelBackgroundExploreOps(): Promise<void> {
    if (this.exploreAbortController) {
      this.exploreAbortController.abort();
      this.exploreAbortController = null;
    }
    if (this.pendingBackgroundOps.size > 0) {
      await Promise.race([
        Promise.allSettled([...this.pendingBackgroundOps]),
        new Promise(resolve => setTimeout(resolve, 500)),
      ]);
      this.pendingBackgroundOps.clear();
    }
  }

  private async connectRecoverySession(entry: RecoveryState): Promise<{ sessionName: string; managedBrowser: boolean }> {
    const multiSession = this.multiSessionManager;
    const existing = multiSession.get(entry.cdpSessionName);
    if (existing) {
      const browser = existing.browserManager.getBrowser();
      if (browser?.isConnected()) {
        return { sessionName: entry.cdpSessionName, managedBrowser: !!existing.managedPid };
      }
      await multiSession.close(entry.cdpSessionName, { force: true });
    }

    if (entry.managedPid && fs.existsSync(entry.managedProfileDir)) {
      try {
        const { wsEndpoint } = await waitForDevToolsActivePort(entry.managedProfileDir);
        const session = await multiSession.connectCDP(entry.cdpSessionName, { wsEndpoint }, entry.siteId);
        session.managedPid = entry.managedPid;
        session.managedProfileDir = entry.managedProfileDir;
        session.cdpPriorPolicyState = entry.priorPolicySnapshot;
        return { sessionName: session.name, managedBrowser: true };
      } catch (err) {
        this.log.debug({ err, siteId: entry.siteId }, 'Managed recovery reconnect failed, will launch a new Chrome session');
      }
    }

    try {
      const attached = await multiSession.connectCDP(entry.cdpSessionName, { autoDiscover: true }, entry.siteId);
      attached.managedProfileDir = entry.managedProfileDir;
      return { sessionName: attached.name, managedBrowser: false };
    } catch (attachErr) {
      const launch = await launchManagedChrome({
        config: this.config,
        siteId: entry.siteId,
        url: entry.url,
        profileDir: entry.managedProfileDir,
      });
      entry.managedPid = launch.pid;
      entry.managedBrowser = true;
      const session = await multiSession.connectCDP(entry.cdpSessionName, { wsEndpoint: launch.wsEndpoint }, entry.siteId);
      session.managedPid = launch.pid;
      session.managedProfileDir = entry.managedProfileDir;
      session.cdpPriorPolicyState = entry.priorPolicySnapshot;
      return { sessionName: session.name, managedBrowser: true };
    }
  }

  private async bindRecoveryPolicy(entry: RecoveryState): Promise<void> {
    const currentPolicy = getSitePolicy(entry.siteId, this.config);
    if (!entry.priorPolicySnapshot) {
      entry.priorPolicySnapshot = {
        domainAllowlist: currentPolicy.domainAllowlist,
        executionBackend: currentPolicy.executionBackend,
        executionSessionName: currentPolicy.executionSessionName,
      };
    }

    const mergeResult = mergeSitePolicy(entry.siteId, {
      domainAllowlist: [...new Set([
        ...currentPolicy.domainAllowlist,
        '127.0.0.1',
        'localhost',
        '[::1]',
      ])],
      executionBackend: 'live-chrome',
      executionSessionName: entry.cdpSessionName,
    }, this.config);
    if (!mergeResult.persisted) {
      this.log.warn({ siteId: entry.siteId }, 'Recovery policy applied in-memory but failed to persist');
    }
    try {
      writeManagedChromeMetadata(entry.managedProfileDir, entry.managedPid, entry.siteId, {
        sessionName: entry.cdpSessionName,
        priorPolicySnapshot: entry.priorPolicySnapshot,
      });
    } catch (err) {
      this.log.warn({ err, siteId: entry.siteId }, 'Failed to persist recovery cleanup metadata');
    }

    const session = this.multiSessionManager.get(entry.cdpSessionName);
    if (session) {
      session.cdpPriorPolicyState = entry.priorPolicySnapshot;
    }
  }

  private async alignRecoveryPage(entry: RecoveryState): Promise<void> {
    const session = this.multiSessionManager.get(entry.cdpSessionName);
    if (!session) {
      throw new Error(`Recovery session '${entry.cdpSessionName}' is not available`);
    }

    const browser = session.browserManager.getBrowser();
    if (!browser) {
      throw new Error('Recovery browser is not connected');
    }

    let selectedPage: Awaited<ReturnType<BrowserManager['getSelectedOrFirstPage']>> | undefined;
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        try {
          const pageUrl = page.url();
          if (!pageUrl || pageUrl === 'about:blank') continue;
          const hostname = new URL(pageUrl).hostname;
          if (pageUrl.startsWith(entry.url) || hostname === entry.siteId || hostname.endsWith(`.${entry.siteId}`)) {
            session.browserManager.selectPage(entry.siteId, pageUrl);
            selectedPage = page;
            break;
          }
        } catch {
          // Ignore invalid URLs.
        }
      }
      if (selectedPage) break;
    }

    const page = selectedPage ?? await session.browserManager.getSelectedOrFirstPage(entry.siteId);
    if (!page.url() || page.url() === 'about:blank') {
      await page.goto(entry.url, { waitUntil: 'commit', timeout: 30000 });
    } else {
      try {
        const currentHost = new URL(page.url()).hostname;
        if (currentHost !== entry.siteId && !currentHost.endsWith(`.${entry.siteId}`)) {
          await page.goto(entry.url, { waitUntil: 'commit', timeout: 30000 });
        }
      } catch {
        await page.goto(entry.url, { waitUntil: 'commit', timeout: 30000 });
      }
    }
    session.browserManager.selectPage(entry.siteId, page.url());
  }

  private async finalizeRecovery(entry: RecoveryState): Promise<void> {
    await this.cancelBackgroundExploreOps();

    this.exploreSessionName = entry.cdpSessionName;
    this.mode = 'exploring';
    if (!this.config.server.network) {
      try {
        this.multiSessionManager.setActive(entry.cdpSessionName, this.config);
      } catch (err) {
        this.log.debug({ err, siteId: entry.siteId }, 'Setting recovery session active failed');
      }
    }

    const defaultSession = this.multiSessionManager.get(DEFAULT_SESSION_NAME);
    defaultSession?.browserManager.discardContext(entry.siteId);

    const discoveryOp = this.runColdStartDiscovery(entry.url, entry.siteId)
      .catch(err => this.log.debug({ err, siteId: entry.siteId }, 'Post-recovery discovery failed'))
      .finally(() => this.pendingBackgroundOps.delete(discoveryOp));
    this.pendingBackgroundOps.add(discoveryOp);
  }

  async recoverExplore(resumeToken: string, waitMs = 90_000): Promise<RecoverExploreResult> {
    const entry = this.recoveries.get(resumeToken);
    if (!entry) {
      return {
        status: 'expired',
        siteId: '',
        url: '',
        hint: 'Recovery token is missing or expired. Start explore again.',
      };
    }

    if (this.config.server.network) {
      return {
        status: 'failed',
        siteId: entry.siteId,
        url: entry.url,
        hint: 'Automatic Chrome handoff is only supported in local desktop mode. Use schrute_connect_cdp manually on the local machine.',
      };
    }

    if (!entry.autoRecoverSupported) {
      return {
        status: 'failed',
        siteId: entry.siteId,
        url: entry.url,
        hint: entry.hint,
      };
    }

    if (this.mode === 'recording' || this.currentRecording) {
      return {
        status: 'failed',
        siteId: entry.siteId,
        url: entry.url,
        hint: 'Automatic recovery is unavailable while recording. Call schrute_stop first, then retry schrute_recover_explore.',
      };
    }

    const boundedWaitMs = Math.max(1_000, Math.min(waitMs, 300_000));

    if (entry.currentState === 'ready') {
      return {
        status: 'ready',
        siteId: entry.siteId,
        url: entry.url,
        session: entry.cdpSessionName,
        managedBrowser: entry.managedBrowser,
        hint: 'Recovery is already complete. Continue using browser tools or call schrute_record.',
      };
    }

    try {
      const { sessionName, managedBrowser } = await this.connectRecoverySession(entry);
      await this.bindRecoveryPolicy(entry);
      await this.alignRecoveryPage(entry);

      const deadline = Date.now() + boundedWaitMs;
      const session = this.multiSessionManager.get(sessionName);
      if (!session) {
        throw new Error(`Recovery session '${sessionName}' was not found after connect`);
      }

      entry.currentState = 'awaiting_user';
      entry.managedBrowser = managedBrowser;

      while (Date.now() < deadline) {
        const page = await session.browserManager.getSelectedOrFirstPage(entry.siteId);
        const challengePresent = await isCloudflareChallengePage(page as any);
        const currentUrl = page.url() || entry.url;
        if (!challengePresent) {
          entry.currentState = 'ready';
          entry.url = currentUrl;
          await session.browserManager.snapshotAuth(entry.siteId);
          await this.finalizeRecovery(entry);
          this.recoveries.set(entry.resumeToken, entry);
          return {
            status: 'ready',
            siteId: entry.siteId,
            url: currentUrl,
            session: sessionName,
            managedBrowser,
            hint: 'Recovery complete. Continue using browser tools or call schrute_record.',
          };
        }
        entry.url = currentUrl;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      entry.currentState = 'awaiting_user';
      this.recoveries.set(entry.resumeToken, entry);
      return {
        status: 'awaiting_user',
        siteId: entry.siteId,
        url: entry.url,
        session: sessionName,
        managedBrowser,
        hint: 'Chrome is open and waiting for you to clear the Cloudflare challenge. Run schrute_recover_explore again after you finish.',
      };
    } catch (err) {
      entry.currentState = 'failed';
      entry.failureReason = err instanceof Error ? err.message : String(err);
      this.recoveries.set(entry.resumeToken, entry);
      return {
        status: 'failed',
        siteId: entry.siteId,
        url: entry.url,
        hint: entry.failureReason,
      };
    }
  }

  async startRecording(
    name: string,
    inputs?: Record<string, string>,
  ): Promise<RecordingInfo> {
    // Abort background explore ops to prevent races with recording
    if (this.exploreAbortController) {
      this.exploreAbortController.abort();
      this.exploreAbortController = null;
    }
    if (this.pendingBackgroundOps.size > 0) {
      await Promise.race([
        Promise.allSettled([...this.pendingBackgroundOps]),
        new Promise(resolve => setTimeout(resolve, 500)),
      ]);
      this.pendingBackgroundOps.clear();
    }

    if (this.mode !== 'exploring') {
      throw new Error(
        `Cannot start recording in '${this.mode}' mode. Must be exploring first.`,
      );
    }

    if (!this.activeSessionId) {
      throw new Error('No active session to record');
    }

    // Recording can use the default session (launch-based, Playwright HAR)
    // or the active named session if it's CDP (uses CDP HAR recorder)
    const activeName = this.exploreSessionName;
    const activeSession = this.multiSessionManager.get(activeName);
    if (!activeSession) {
      throw new Error('No active session available for recording.');
    }
    const browserManager = activeSession.browserManager;

    // CDP sessions don't support Playwright HAR — use CDP HAR recorder instead
    if (!browserManager.supportsHarRecording()) {
      const { CdpHarRecorder } = await import('../capture/cdp-har-recorder.js');
      this.cdpHarRecorder = new CdpHarRecorder();
      this.cdpHarRecorder.start();
      this.log.info({ session: activeName }, 'Using CDP HAR recorder for non-launch-based session');
    } else if (activeName !== DEFAULT_SESSION_NAME) {
      throw new Error(
        'Recording with Playwright HAR is only supported on the default session. ' +
        'Switch to the default session first with schrute_switch_session.',
      );
    }

    const previousMode = this.mode;
    const previousRecording = this.currentRecording;

    // Capture the recording session's manager so stopRecording() uses the
    // exact same manager even if the active session changes mid-recording.
    this.recordingBrowserManager = browserManager;

    // Suppress idle timeout during recording (exception-safe)
    browserManager.setSuppressIdleTimeout(true);
    try {
      const session = await this.sessionManager.resume(this.activeSessionId);

      // Ensure HAR-capable context exists (handles post-idle-timeout case)
      if (!browserManager.hasContext(session.siteId)) {
        await browserManager.getOrCreateContext(session.siteId);
      }

      this.currentRecording = {
        id: randomUUID(),
        name,
        siteId: session.siteId,
        startedAt: Date.now(),
        requestCount: 0,
        inputs,
      };

      // Attach live request counter to page responses
      this.recordingListenerCleanups = [];
      const recording = this.currentRecording;
      const cdpRecorder = this.cdpHarRecorder; // capture for closure
      const context = browserManager.tryGetContext(session.siteId);
      if (context) {
        const responseHandler = (response: any) => {
          if (this.currentRecording === recording) {
            recording.requestCount++;

            // CDP HAR: ingest entry immediately, patch body asynchronously
            if (cdpRecorder) {
              try {
                const req = response.request();
                const timing = response.timing?.();
                const now = Date.now();
                const entry: NetworkEntry = {
                  url: req?.url?.() ?? response.url(),
                  method: req?.method?.() ?? 'GET',
                  status: response.status(),
                  requestHeaders: req?.headers?.() ?? {},
                  responseHeaders: response.headers(),
                  requestBody: req?.postData?.() ?? undefined,
                  responseBody: undefined,
                  timing: {
                    startTime: timing?.startTime ?? now,
                    endTime: now,
                    duration: timing?.responseEnd ?? 0,
                  },
                };
                // Two-phase ingest: record entry now, patch body when promise resolves.
                // stop() flushes pending bodies before returning the HAR.
                const bodyPromise = response.body()
                  .then((buf: Buffer) => buf.toString('utf-8'))
                  .catch(() => undefined as string | undefined);
                cdpRecorder.ingestWithPendingBody(entry, bodyPromise);
              } catch (err) { this.log.debug({ err, url: response.url() }, 'Response capture failed during recording'); }
            }
          }
        };
        (context as any).on('response', responseHandler);
        this.recordingListenerCleanups.push(() => (context as any).off('response', responseHandler));
      }

      this.mode = 'recording';
      this.recordingSessionName = activeName;
      this.log.info(
        { recordingId: this.currentRecording.id, name, siteId: session.siteId },
        'Recording started',
      );

      return { ...this.currentRecording };
    } catch (err) {
      // Clear suppression on failure to prevent stuck state
      browserManager.setSuppressIdleTimeout(false);
      this.mode = previousMode;
      this.currentRecording = previousRecording;
      this.recordingBrowserManager = null;
      // Clean up any listeners attached before the failure
      for (const cleanup of this.recordingListenerCleanups) {
        try { cleanup(); } catch (err2) { this.log.debug({ err: err2 }, 'Recording cleanup failed'); }
      }
      this.recordingListenerCleanups = [];
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
    this.recordingSessionName = null;

    // Detach response listeners from the recording cycle
    for (const cleanup of this.recordingListenerCleanups) {
      try { cleanup(); } catch (err) { this.log.debug({ err }, 'Recording stop cleanup failed'); }
    }
    this.recordingListenerCleanups = [];

    this.log.info(
      { recordingId: recording.id, name: recording.name, requests: recording.requestCount },
      'Recording stopped',
    );

    // Use the exact manager captured when recording started, not the current active session.
    // The active session can change mid-recording (session switch, session close fallback).
    const browserManager = this.recordingBrowserManager ?? this.sessionManager.getBrowserManager();
    this.recordingBrowserManager = null;
    const siteId = recording.siteId;

    try {
      let harPath: string | undefined;

      if (this.cdpHarRecorder) {
        // CDP recording path: flush pending body reads, then stop and write to temp file
        const harLog = await this.cdpHarRecorder.stop();
        this.cdpHarRecorder = null;

        const tmpDir = path.join(this.config.dataDir, 'tmp');
        fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
        harPath = path.join(tmpDir, `${siteId}-cdp-${Date.now()}.har`);
        fs.writeFileSync(harPath, JSON.stringify({ log: harLog }), { mode: 0o600 });
        this.log.info({ harPath, entries: harLog.entries.length }, 'CDP HAR written to disk');
      } else {
        // Playwright recording path: capture HAR path before closing context
        harPath = browserManager.getHarPath(siteId);
        if (!harPath) {
          throw new Error('Missing HAR path during recording — invariant violation');
        }

        // Close context -> flushes HAR to disk (browser-touching, use lease).
        // Timeout prevents indefinite hang when the browser is stuck (e.g. Cloudflare challenge).
        const STOP_LEASE_TIMEOUT_MS = 10_000;
        try {
          await browserManager.withLease(async () => {
            await browserManager.closeContext(siteId);
          }, STOP_LEASE_TIMEOUT_MS);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log.warn({ siteId, err }, 'closeContext timed out during stopRecording — proceeding with HAR on disk');
          // Force-discard the stuck context so it doesn't block future operations
          try { browserManager.discardContext(siteId); } catch { /* best-effort */ }
          // If the HAR file was already partially flushed we can still try the pipeline
          if (!fs.existsSync(harPath)) {
            throw new Error(`stopRecording aborted: context close timed out (${msg}) and no HAR file found`);
          }
        }
      }

      // 3. Run capture pipeline with explicit HAR path (CPU/IO only, no lease)
      let pipelineError: Error | undefined;
      try {
        await this.runCapturePipeline(recording, harPath);
      } catch (err) {
        pipelineError = err instanceof Error ? err : new Error(String(err));
      }

      // 4. Re-open context so explore mode remains usable (browser-touching, use lease)
      const REOPEN_LEASE_TIMEOUT_MS = 10_000;
      if (!this.isClosing) {
        try {
          await browserManager.withLease(async () => {
            await browserManager.getOrCreateContext(siteId);
          }, REOPEN_LEASE_TIMEOUT_MS);
          this.log.info({ siteId }, 'Browser context re-opened after recording stop');
        } catch (err) {
          this.log.warn({ siteId, err }, 'Failed to re-open browser context after recording');
        }
      }

      if (pipelineError) {
        throw new Error(`Recording stopped but capture pipeline failed: ${pipelineError.message}`);
      }

      return recording;
    } finally {
      this.cdpHarRecorder = null;  // always clear, even on error
      // Always clear idle suppression, even if capture pipeline or re-open throws
      browserManager.setSuppressIdleTimeout(false);
    }
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

      // Filter noise (analytics, beacons, polling, static assets)
      const { signal, noise } = filterRequests(harData.log.entries);

      // C3: Persist noise filter audit trail
      const db = getDatabase(this.config);
      db.run(
        `INSERT INTO action_frames (id, site_id, name, started_at, ended_at, request_count, signal_count, skill_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        recording.id, recording.siteId, recording.name, recording.startedAt, Date.now(),
        harData.log.entries.length, signal.length, 0,
      );
      recordFilteredEntries(db, recording.id, harData.log.entries);

      const signalRecords: StructuredRecord[] = signal.map(extractRequestResponse);

      if (signalRecords.length === 0) {
        this.log.warn({ recordingId: recording.id }, 'No signal requests after filtering');
        return;
      }

      // C2: Canonicalize and deduplicate requests
      const seen = new Set<string>();
      const dedupedRecords = signalRecords.filter(r => {
        const canonical = canonicalizeRequest(r.request);
        const key = `${canonical.method}|${canonical.canonicalUrl}|${canonical.canonicalBody ?? ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // Split: REST vs GraphQL (prevents generic /graphql REST skill)
      const restRecords = dedupedRecords.filter(r => !isGraphQL(r.request));
      const gqlRecords = dedupedRecords.filter(r => isGraphQL(r.request));

      // Detect auth patterns
      const authRecipe = detectAuth(restRecords);

      // Discover parameters (needs RequestSample[] with declaredInputs)
      const paramSamples = restRecords.map(record => ({
        record,
        declaredInputs: recording.inputs,
      }));
      const paramEvidence = discoverParams(paramSamples);

      // Detect request chains
      const chains = detectChains(restRecords);

      // Cluster endpoints and generate draft skills
      const clusters = clusterEndpoints(restRecords, this.pathTrie);
      // A1: Track pre-existing skill IDs for this site BEFORE generating new ones
      const preExistingSkillIds = new Set(
        this.skillRepo.getBySiteId(recording.siteId).map(s => s.id)
      );

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
            actionName: generateActionName(cluster.method, cluster.pathTemplate),
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

      // A1: Increment sampleCount for pre-existing skills that matched clusters
      for (const cluster of clusters) {
        const expectedName = generateActionName(cluster.method, cluster.pathTemplate);
        const siteSkills = this.skillRepo.getBySiteId(recording.siteId);
        const candidates = siteSkills.filter(s =>
          s.name === expectedName &&
          s.method === cluster.method &&
          preExistingSkillIds.has(s.id)
        );
        if (candidates.length > 0) {
          const matched = candidates.reduce((best, s) => s.version > best.version ? s : best);
          this.skillRepo.update(matched.id, { sampleCount: matched.sampleCount + cluster.requests.length });
        }
      }

      // A1: Check promotion for all site skills
      const allSiteSkills = this.skillRepo.getBySiteId(recording.siteId);
      for (const existing of allSiteSkills) {
        const check = canPromote(existing, this.config);
        if (check.eligible) {
          const result = promoteSkill(existing, this.config);
          this.skillRepo.update(result.skill.id, {
            status: result.skill.status,
            confidence: result.skill.confidence,
            lastVerified: result.skill.lastVerified,
          });
          notify(createEvent('skill_promoted', existing.id, existing.siteId,
            { previousStatus: existing.status }), this.config).catch(err => this.log.debug({ err }, 'Notification failed'));
        }
      }

      // C1: GraphQL clustering — catalog entries (non-executable drafts)
      for (const gqlCluster of clusterByOperation(gqlRecords, recording.siteId)) {
        // Gate: skip cluster if ALL requests are unreplayable persisted queries
        if (gqlCluster.hasPersistedQueries) {
          const hasReplayable = gqlCluster.requests.some(r => {
            const info = extractGraphQLInfo(r.request);
            return canReplayPersistedQuery(info);
          });
          if (!hasReplayable) continue;
        }

        // Derive method/path from replayable requests only
        const replayableRequests = gqlCluster.requests.filter(r => {
          const info = extractGraphQLInfo(r.request);
          return !info.isPersistedQuery || canReplayPersistedQuery(info);
        });
        const methodPathCounts = new Map<string, number>();
        for (const r of replayableRequests) {
          const key = `${r.request.method}|${new URL(r.request.url).pathname}`;
          methodPathCounts.set(key, (methodPathCounts.get(key) ?? 0) + 1);
        }
        const [bestMethodPath] = [...methodPathCounts.entries()].sort((a, b) => b[1] - a[1])[0];
        const [gqlMethod, gqlPath] = bestMethodPath.split('|');

        const gqlSkill = generateSkill(recording.siteId, {
          method: gqlMethod,
          pathTemplate: gqlPath,
          actionName: gqlCluster.operationName,
          inputSchema: { type: 'object', properties: Object.fromEntries(
            Object.entries(gqlCluster.variableShape).map(([k, v]) => [k, { type: v === 'mixed' ? 'string' : v }])
          )},
          requiredHeaders: {},
          sampleCount: gqlCluster.requests.length,
          isGraphQL: true,
          graphqlOperationName: gqlCluster.operationName,
        }, authRecipe ?? undefined);

        if (!this.skillRepo.getById(gqlSkill.id)) {
          this.skillRepo.create(gqlSkill);
          generatedCount++;
        }
      }

      // P2-6: Auto-activate read-only GET/HEAD skills from this recording session
      // Gate: skip activation if security scanner flags the skill as unsafe
      const newSiteSkills = this.skillRepo.getBySiteId(recording.siteId);
      for (const s of newSiteSkills) {
        if (!preExistingSkillIds.has(s.id) && s.sideEffectClass === SideEffectClass.READ_ONLY && (s.method === 'GET' || s.method === 'HEAD')) {
          const scanResult = scanSkill(s);
          if (!scanResult.safe) {
            this.skillRepo.update(s.id, { reviewRequired: true });
            this.log.warn({ skillId: s.id, findings: scanResult.findings.length }, 'Security scanner blocked auto-activation');
            continue;
          }
          this.skillRepo.update(s.id, { status: SkillStatus.ACTIVE, confidence: 0.5, lastVerified: Date.now() });
          this.log.info({ skillId: s.id }, 'Auto-activated read-only skill from recording session');
        }
      }

      // P2-7: Populate generated skills for richer stop response
      if (this.currentRecording) {
        const newSkills = this.skillRepo.getBySiteId(recording.siteId)
          .filter(s => !preExistingSkillIds.has(s.id));
        this.currentRecording.generatedSkills = newSkills.map(s => ({
          id: s.id, method: s.method, pathTemplate: s.pathTemplate, status: s.status,
        }));
        this.currentRecording.dedupedRequests = signalRecords.length - dedupedRecords.length;
      }

      // C3: Update action_frame with final skill count
      db.run('UPDATE action_frames SET skill_count = ? WHERE id = ?', generatedCount, recording.id);

      // P1-3: Update recording with pipeline counts
      recording.signalRequests = signalRecords.length;
      recording.noiseRequests = noise.length;
      recording.skillsGenerated = generatedCount;
      recording.requestCount = harData.log.entries.length;

      // Classify site traffic to set recommendedTier
      const traffic: NetworkEntry[] = dedupedRecords.map(r => ({
        url: r.request.url,
        method: r.request.method,
        status: r.response.status,
        requestHeaders: r.request.headers ?? {},
        responseHeaders: r.response.headers ?? {},
        requestBody: r.request.body,
        timing: { startTime: r.startedAt, endTime: r.startedAt + r.duration, duration: r.duration },
      }));

      if (traffic.length > 0) {
        const classification = classifySite(recording.siteId, traffic);
        const siteRepo = new SiteRepository(db);
        siteRepo.update(recording.siteId, {
          recommendedTier: classification.recommendedTier,
        });
        this.log.info(
          { siteId: recording.siteId, recommendedTier: classification.recommendedTier, authRequired: classification.authRequired },
          'Site classified after recording',
        );
      }

      this.log.info(
        {
          recordingId: recording.id,
          authDetected: authRecipe != null,
          paramCount: paramEvidence.length,
          chainCount: chains.length,
          signalRequests: dedupedRecords.length,
          clusters: clusters.length,
          generatedSkills: generatedCount,
        },
        'Capture pipeline complete',
      );

      // Persist skill references and templates to disk (non-blocking)
      try {
        const allSiteSkillsForDocs = this.skillRepo.getBySiteId(recording.siteId);
        for (const skill of allSiteSkillsForDocs) {
          const skillDir = path.join(getSkillsDir(this.config), recording.siteId, skill.id);

          const refs = generateSkillReferences(skill);
          const refsDir = path.join(skillDir, 'references');
          fs.mkdirSync(refsDir, { recursive: true });
          for (const [filename, content] of refs) {
            fs.writeFileSync(path.join(refsDir, filename), content, 'utf-8');
          }

          const tmpls = generateSkillTemplates(skill);
          const tmplsDir = path.join(skillDir, 'templates');
          fs.mkdirSync(tmplsDir, { recursive: true });
          for (const [filename, content] of tmpls) {
            fs.writeFileSync(path.join(tmplsDir, filename), content, 'utf-8');
          }
        }
        this.log.debug({ siteId: recording.siteId, count: allSiteSkillsForDocs.length }, 'Skill docs persisted');
      } catch (docsErr) {
        this.log.warn({ err: docsErr }, 'Failed to persist skill docs (non-blocking)');
      }
    } catch (err) {
      this.log.error({ recordingId: recording.id, err }, 'Capture pipeline failed');
      throw err;
    }
  }

  async executeSkill(
    skillId: string,
    params: Record<string, unknown>,
    callerId?: string,
    options?: { skipMetrics?: boolean },
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

    // 1.5. Validate params against synthesized execution schema
    const validation = validateParams(params, skill, this.config.paramLimits);
    if (!validation.valid) {
      return {
        success: false,
        error: formatExecutionError('validation_failed', validation.errors.join('; ')),
        failureCause: 'validation_failed',
        failureDetail: validation.errors.join('; '),
        latencyMs: Date.now() - startTime,
      };
    }

    // Dedup for read-only skills: collapse identical in-flight requests
    if (skill.sideEffectClass === SideEffectClass.READ_ONLY) {
      const dedupKey = `${skillId}|${stableStringify(params)}`;
      const existing = this.inflightDedup.get(dedupKey);
      if (existing) {
        this.log.debug({ skillId }, 'Dedup hit — returning in-flight result');
        return existing;
      }
      const promise = this.executeSkillInner(skill, params, startTime, callerId, options);
      this.inflightDedup.set(dedupKey, promise);
      try {
        return await promise;
      } finally {
        this.inflightDedup.delete(dedupKey);
      }
    }

    return this.executeSkillInner(skill, params, startTime, callerId, options);
  }

  private async executeSkillInner(
    skill: SkillSpec,
    params: Record<string, unknown>,
    startTime: number,
    callerId?: string,
    options?: { skipMetrics?: boolean },
  ): Promise<SkillExecutionResult> {
    const skillId = skill.id;

    // Both WebMCP and HTTP paths produce an ExecutionResult for the shared post-execution block
    const policy = getSitePolicy(skill.siteId, this.config);
    const effectiveDomains = policy.domainAllowlist.length > 0
      ? policy.domainAllowlist
      : [...new Set([...skill.allowedDomains, skill.siteId])];
    const policyDecision: PolicyDecision = {
      proposed: `${skill.method} ${skill.pathTemplate}`,
      policyResult: 'allowed',
      policyRule: 'engine.executeSkill',
      userConfirmed: null,
      redactionsApplied: [],
    };
    const site = this.siteRepo.getById(skill.siteId);
    const MAX_CANARY_ATTEMPTS = 5;
    let isCanaryProbe = false;
    const isDirectRecommended = site?.recommendedTier === ExecutionTier.DIRECT;

    let result: Awaited<ReturnType<typeof replayExecuteSkill>>;

    if (skill.method === 'WEBMCP') {
      // ── WebMCP execution path ────────────────────────────
      // Bypasses HTTP method/path checks and the replay pipeline,
      // but enforces rate limiting and flows through the shared post-execution path.
      const rateCheck = this.rateLimiter.checkRate(skill.siteId, callerId);
      if (!rateCheck.allowed) {
        const detail = `Site '${skill.siteId}' rate limited, retry after ${rateCheck.retryAfterMs}ms`;
        return {
          success: false,
          error: formatExecutionError('rate_limited', detail),
          failureCause: 'rate_limited',
          failureDetail: detail,
          latencyMs: Date.now() - startTime,
        };
      }

      const webmcpRaw = await this.executeWebMcpSkill(skill, params, startTime);
      result = {
        success: webmcpRaw.success,
        tier: ExecutionTier.FULL_BROWSER as ExecutionTierName,
        status: webmcpRaw.success ? 200 : 0,
        data: webmcpRaw.data,
        rawBody: typeof webmcpRaw.data === 'string' ? webmcpRaw.data : JSON.stringify(webmcpRaw.data ?? null),
        headers: {},
        latencyMs: webmcpRaw.latencyMs,
        schemaMatch: true,
        semanticPass: true,
        failureCause: webmcpRaw.failureCause ?? (webmcpRaw.failureDetail ? FailureCause.UNKNOWN : undefined),
        failureDetail: webmcpRaw.failureDetail,
      };
    } else {
      // ── HTTP execution path ──────────────────────────────
      // 2. Apply policy checks
      const methodAllowed = checkMethodAllowed(skill.siteId, skill.method, skill.sideEffectClass, this.config);
      if (!methodAllowed) {
        const detail = `Method ${skill.method} not allowed for '${skill.siteId}'`;
        return {
          success: false,
          error: formatExecutionError('policy_denied', detail),
          failureCause: 'policy_denied',
          failureDetail: detail,
          latencyMs: Date.now() - startTime,
        };
      }

      const pathCheck = checkPathRisk(skill.method, skill.pathTemplate);
      if (pathCheck.blocked) {
        const detail = pathCheck.reason ?? 'destructive path pattern';
        return {
          success: false,
          error: formatExecutionError('policy_denied', detail),
          failureCause: 'policy_denied',
          failureDetail: detail,
          latencyMs: Date.now() - startTime,
        };
      }

      // 3. Rate limit check (with per-caller fairness)
      const rateCheck = this.rateLimiter.checkRate(skill.siteId, callerId);
      if (!rateCheck.allowed) {
        this.log.warn(
          { skillId, siteId: skill.siteId, retryAfterMs: rateCheck.retryAfterMs },
          'Rate limited — skipping execution',
        );
        const detail = `Site '${skill.siteId}' rate limited, retry after ${rateCheck.retryAfterMs}ms`;
        return {
          success: false,
          error: formatExecutionError('rate_limited', detail),
          failureCause: 'rate_limited',
          failureDetail: detail,
          latencyMs: Date.now() - startTime,
        };
      }

      this.budgetTracker.setDomainAllowlist(effectiveDomains);

      // Wire browser provider: try execution backend first, fall back to explore Playwright
      let browserProvider: BrowserProvider | undefined;
      const isHardSite = !!(
        (policy.executionBackend === 'playwright' || policy.executionBackend === 'live-chrome')
        && policy.executionSessionName
      );
      try {
        const backend = this.getExecutionBackend(skill.siteId);
        browserProvider = await backend.createProvider(skill.siteId, effectiveDomains);
        if (!browserProvider) {
          if (isHardSite) {
            throw new Error(`Hard-site '${skill.siteId}' failed to create provider — bound explore session may be closed`);
          }
          // Non-hard-site: fall back to explore Playwright context
          browserProvider = await this.createBrowserProvider(skill.siteId, effectiveDomains);
        }
      } catch (err) {
        if (isHardSite) throw err; // fail closed for hard sites
        this.log.warn({ err, siteId: skill.siteId }, 'Execution backend failed — falling back to explore Playwright');
        browserProvider = await this.createBrowserProvider(skill.siteId, effectiveDomains);
      }

      // Lazy browser provider factory for executor — hard sites NEVER fall back
      const browserProviderFactory = browserProvider ? undefined : (isHardSite ? undefined : async () => {
        try {
          const backend = this.getExecutionBackend(skill.siteId);
          const provider = await backend.createProvider(skill.siteId, effectiveDomains);
          if (provider) return provider;
        } catch { /* fall through */ }
        return this.createBrowserProvider(skill.siteId, effectiveDomains);
      });

      const executorOptions = {
        auditLog: this.auditLog,
        budgetTracker: this.budgetTracker,
        metricsRepo: this.metricsRepo,
        policyDecision,
        browserProvider,
        browserProviderFactory,
        config: this.config,
        siteRecommendedTier: site?.recommendedTier,
      };

      // 5. Execute — canary probe + tier escalation
      const retryOpts: RetryOptions = { ...executorOptions, siteRecommendedTier: site?.recommendedTier };

      if (skill.directCanaryEligible && !skill.tierLock
          && (skill.directCanaryAttempts ?? 0) < MAX_CANARY_ATTEMPTS
          && !isDirectRecommended) {
        retryOpts.forceStartTier = ExecutionTier.DIRECT;
        retryOpts.isCanaryProbe = true;
        isCanaryProbe = true;
        this.skillRepo.update(skill.id, {
          directCanaryAttempts: (skill.directCanaryAttempts ?? 0) + 1,
          directCanaryEligible: false,
          validationsSinceLastCanary: 0,
        });
      }

      result = skill.sideEffectClass === SideEffectClass.READ_ONLY
        ? await retryWithEscalation(skill, params, retryOpts)
        : await replayExecuteSkill(skill, params, retryOpts);
    }

    try {

      // 6. Update rate limiter with response info (pass latency for adaptive throttling on non-browser tiers)
      const adaptiveLatency = result.tier !== ExecutionTier.FULL_BROWSER ? result.latencyMs : undefined;
      this.rateLimiter.recordResponse(skill.siteId, result.status, result.headers, adaptiveLatency, callerId);

      // WS-4: Persist canary failure cause
      if (isCanaryProbe && 'stepResults' in result && (result as any).stepResults[0] && !(result as any).stepResults[0].success) {
        this.skillRepo.update(skill.id, { lastCanaryErrorType: (result as any).stepResults[0].failureCause ?? 'unknown' });
      }

      // 7. Record metrics (skip for infra failures — they don't reflect skill health)
      const isInfra = result.failureCause && INFRA_FAILURE_CAUSES.has(result.failureCause);
      if (!isInfra && !options?.skipMetrics) {
        this.metricsRepo.record({
          skillId: skill.id,
          executedAt: Date.now(),
          success: result.success,
          latencyMs: result.latencyMs,
          executionTier: result.tier,
          errorType: result.failureCause,
          policyRule: policyDecision.policyRule,
        });
      }

      // 7b. Amendment tracking: increment execution count and evaluate
      if (this.amendmentEngine) {
        this.amendmentEngine.incrementExecutionCount(skill.id);
        this.amendmentEngine.evaluate(skill.id);
      }

      // 8. Update adaptive strategy with observation
      updateStrategy(skill.siteId, {
        skillId: skill.id,
        tier: result.tier,
        success: result.success,
        latencyMs: result.latencyMs,
        failureCause: result.failureCause,
      });

      // A1: Update validation counters (skip decay for infra failures)
      if (result.success) {
        this.skillRepo.updateConfidence(skill.id, Math.min(skill.confidence + 0.1, 1.0), skill.consecutiveValidations + 1);
      } else if (!isInfra) {
        this.skillRepo.updateConfidence(skill.id, Math.max(skill.confidence - 0.2, 0), 0);
      }

      // WS-4: Canary re-arm — only for non-direct-recommended tier_3 skills on non-direct success
      if (result.success && result.tier !== ExecutionTier.DIRECT
          && skill.currentTier === TierState.TIER_3_DEFAULT
          && !isDirectRecommended) {
        this.skillRepo.incrementValidationsSinceLastCanary(skill.id);

        const fresh = this.skillRepo.getById(skill.id);
        if (fresh && !fresh.directCanaryEligible && (fresh.directCanaryAttempts ?? 0) < MAX_CANARY_ATTEMPTS) {
          const requiredPasses = Math.min(
            this.config.promotionConsecutivePasses * Math.pow(2, (fresh.directCanaryAttempts ?? 1) - 1),
            50,
          );
          if ((fresh.validationsSinceLastCanary ?? 0) >= requiredPasses) {
            this.skillRepo.update(skill.id, { directCanaryEligible: true });
          }
        }
      }

      // A2: Handle structural failures — tier lock
      const structuralCauses: ReadonlySet<PermanentTierLock['reason']> = new Set(['js_computed_field', 'protocol_sensitivity', 'signed_payload']);
      if (result.failureCause && structuralCauses.has(result.failureCause as PermanentTierLock['reason'])) {
        const failResult = handleFailure(skill, result.failureCause);
        this.skillRepo.updateTier(skill.id, failResult.newTier, failResult.tierLock);
      }

      // A3: Tier promotion check — only when direct execution succeeded on a tier_3 skill
      if (result.success && result.tier === ExecutionTier.DIRECT && skill.currentTier === TierState.TIER_3_DEFAULT) {
        const updatedSkill = this.skillRepo.getById(skill.id);
        if (updatedSkill) {
          const promoCheck = checkPromotion(updatedSkill, [], { match: true, hasDynamicRequiredFields: false }, this.config, site?.recommendedTier);
          if (promoCheck.promote) {
            this.skillRepo.updateTier(updatedSkill.id, TierState.TIER_1_PROMOTED, null);
            this.skillRepo.update(updatedSkill.id, { directCanaryEligible: false, directCanaryAttempts: 0, validationsSinceLastCanary: 0 });
            this.log.info({ skillId: updatedSkill.id }, 'Promoted to tier_1 after direct execution success');
          }
        }
      }

      // B1: Drift detection with schema inference
      const effectiveValidations = result.success ? skill.consecutiveValidations + 1 : 0;

      if (result.success && result.data) {
        if (!skill.outputSchema || Object.keys(skill.outputSchema).length === 0) {
          // Phase 1: First success — infer full schema
          const inferred = inferSchema([result.data]);
          if (inferred && Object.keys(inferred).length > 0) {
            this.skillRepo.update(skill.id, { outputSchema: inferred as Record<string, unknown> });
          }
        } else if (effectiveValidations < 3) {
          // Phase 2: Accumulate via mergeSchemas
          const newInferred = inferSchema([result.data]);
          const merged = mergeSchemas(skill.outputSchema as any, newInferred);
          this.skillRepo.update(skill.id, { outputSchema: merged as Record<string, unknown> });
        } else {
          // Phase 3: Enforce — build enforcement schema from required properties only
          const enforcementSchema = buildEnforcementSchema(skill.outputSchema as Record<string, unknown>);
          const drift = detectDrift(enforcementSchema, result.data);
          if (drift.breaking) {
            this.skillRepo.update(skill.id, { status: SkillStatus.STALE, consecutiveValidations: 0 });
            notify(createEvent('skill_demoted', skill.id, skill.siteId,
              { reason: 'schema_drift', changes: drift.changes.length }), this.config).catch(err => this.log.debug({ err }, 'Notification failed'));
            this.log.warn({ skillId: skill.id, changes: drift.changes.length }, 'Breaking schema drift — skill demoted');
          } else if (drift.drifted) {
            this.log.info({ skillId: skill.id, changes: drift.changes.length }, 'Non-breaking schema drift detected');
            const newInferred = inferSchema([result.data]);
            const merged = mergeSchemas(skill.outputSchema as any, newInferred);
            this.skillRepo.update(skill.id, { outputSchema: merged as Record<string, unknown> });
          }
        }
      }

      // B2: Health monitoring + amendment triggering
      const [healthReport] = monitorSkills([skill], this.metricsRepo);
      if (healthReport?.status === 'broken') {
        this.skillRepo.update(skill.id, { status: SkillStatus.BROKEN, consecutiveValidations: 0 });
        notify(createEvent('skill_broken', skill.id, skill.siteId,
          { successRate: healthReport.successRate }), this.config).catch(err => this.log.debug({ err }, 'Notification failed'));
      } else if (healthReport?.status === 'degrading') {
        notify(createEvent('skill_degraded', skill.id, skill.siteId,
          { successRate: healthReport.successRate, trend: healthReport.trend }), this.config).catch(err => this.log.debug({ err }, 'Notification failed'));
      }

      // B3: Amendment proposal on degrading/broken skills
      if (healthReport && this.amendmentEngine && this.amendmentRepo &&
          (healthReport.status === 'degrading' || healthReport.status === 'broken')) {
        const { shouldAmend } = await import('../healing/monitor.js');
        const amendAction = shouldAmend(healthReport, this.amendmentRepo);
        if (amendAction === 'amend') {
          const freshSkill = this.skillRepo.getById(skill.id);
          if (freshSkill) {
            try {
              this.amendmentEngine.proposeAmendment(freshSkill);
            } catch (amendErr) {
              this.log.debug({ err: amendErr, skillId: skill.id }, 'Amendment proposal failed (non-blocking)');
            }
          }
        }
      }

      // WS-3: Persist all derived stats in one write
      {
        const updatedStats: Partial<SkillSpec> = {
          lastUsed: Date.now(),
        };
        if (healthReport) {
          updatedStats.successRate = healthReport.successRate;
        }
        if (result.success) {
          updatedStats.lastSuccessfulTier = result.tier;
        }
        // Compute avg latency from recent successful metrics
        const recentMetrics = this.metricsRepo.getRecentBySkillId(skill.id, 20);
        const successMetrics = recentMetrics.filter((m: { success: boolean }) => m.success);
        if (successMetrics.length > 0) {
          updatedStats.avgLatencyMs = Math.round(successMetrics.reduce((sum: number, m: { latencyMs: number }) => sum + m.latencyMs, 0) / successMetrics.length);
        }
        this.skillRepo.update(skill.id, updatedStats);
      }

      // Phase 3: Trajectory capture — use authoritative per-attempt results from retryWithEscalation
      {
        const stepResults = 'stepResults' in result ? (result as any).stepResults as Array<{ tier: ExecutionTierName; status: number; latencyMs: number; failureCause?: string; success: boolean }> : undefined;

        const steps: import('../replay/trajectory.js').TrajectoryStep[] = [];
        const tiersAttempted: ExecutionTierName[] = [];

        if (stepResults && stepResults.length > 0) {
          // Use authoritative per-attempt results (real status, latency, failureCause per step)
          for (const step of stepResults) {
            if (!tiersAttempted.includes(step.tier)) tiersAttempted.push(step.tier);
            steps.push({
              tier: step.tier,
              status: step.status,
              latencyMs: step.latencyMs,
              failureCause: step.failureCause as import('../skill/types.js').FailureCauseName | undefined,
              success: step.success,
            });
          }
        } else {
          // Single attempt (non-retry path) — no stepResults available
          tiersAttempted.push(result.tier);
          steps.push({
            tier: result.tier,
            status: result.status,
            latencyMs: result.latencyMs,
            failureCause: result.failureCause,
            success: result.success,
          });
        }

        const totalLatencyMs = steps.reduce((sum, s) => sum + s.latencyMs, 0) || result.latencyMs;
        const trajectory: Trajectory = {
          skillId: skill.id,
          siteId: skill.siteId,
          tiersAttempted,
          steps,
          finalSuccess: result.success,
          totalLatencyMs,
          timestamp: Date.now(),
        };
        this.trajectoryRecorder.record(trajectory);
      }

      // Phase 3: Exemplar capture on success
      if (result.success && result.rawBody) {
        try {
          const crypto = await import('node:crypto');
          const schemaHash = crypto.createHash('sha256')
            .update(result.rawBody.slice(0, 1000))
            .digest('hex')
            .slice(0, 16);

          const { redactBody } = await import('../storage/redactor.js');
          const redactedBody = await redactBody(result.rawBody) ?? '';

          this.exemplarRepo.save({
            skillId: skill.id,
            responseStatus: result.status,
            responseSchemaHash: schemaHash,
            redactedResponseBody: redactedBody,
            capturedAt: Date.now(),
          });
        } catch (exemplarErr) {
          this.log.debug({ err: exemplarErr, skillId: skill.id }, 'Exemplar capture failed (non-blocking)');
        }
      }

      // 9. On cookie_refresh failure, trigger browser cookie refresh
      if (!result.success && result.failureCause === FailureCause.COOKIE_REFRESH) {
        this.log.info({ skillId, siteId: skill.siteId }, 'Triggering cookie refresh');
        // Intentionally fire-and-forget: cookie refresh is a background recovery action
        // that should not block the current response. Failures are logged.
        refreshCookies(skill.siteId, undefined, this.sessionManager.getBrowserManager()).catch((err) => {
          this.log.warn({ skillId, err }, 'Cookie refresh failed');
        });
      }

      return {
        success: result.success,
        data: result.data,
        error: result.failureCause
          ? formatExecutionError(result.failureCause, result.failureDetail ?? 'unknown')
          : undefined,
        failureCause: result.failureCause,
        failureDetail: result.failureDetail,
        latencyMs: result.latencyMs,
      };
    } catch (err) {
      if (this.amendmentEngine) {
        this.amendmentEngine.incrementExecutionCount(skill.id);
      }
      const latencyMs = Date.now() - startTime;
      this.log.error({ skillId, err }, 'Skill execution error');
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        latencyMs,
      };
    }
  }

  private async executeWebMcpSkill(
    skill: SkillSpec,
    params: Record<string, unknown>,
    startTime: number,
  ): Promise<{ success: boolean; data: unknown; failureDetail?: string; failureCause?: import('../skill/types.js').FailureCauseName; latencyMs: number }> {
    const policy = getSitePolicy(skill.siteId, this.config);
    const effectiveDomains = policy.domainAllowlist.length > 0
      ? policy.domainAllowlist
      : [...new Set([...skill.allowedDomains, skill.siteId])];

    // Use the same backend routing chain as normal execution
    let browserProvider: BrowserProvider | undefined;
    const isHardSite = !!(
      (policy.executionBackend === 'playwright' || policy.executionBackend === 'live-chrome')
      && policy.executionSessionName
    );
    try {
      const backend = this.getExecutionBackend(skill.siteId);
      browserProvider = await backend.createProvider(skill.siteId, effectiveDomains);
      if (!browserProvider && !isHardSite) {
        browserProvider = await this.createBrowserProvider(skill.siteId, effectiveDomains);
      }
    } catch (err) {
      if (isHardSite) throw err;
      this.log.warn({ err, siteId: skill.siteId }, 'Execution backend failed for WebMCP skill — falling back');
      try {
        browserProvider = await this.createBrowserProvider(skill.siteId, effectiveDomains);
      } catch (err2) { this.log.warn({ err: err2, siteId: skill.siteId }, 'Fallback browser creation failed'); }
    }

    if (!browserProvider) {
      return {
        success: false,
        data: null,
        failureCause: FailureCause.FETCH_ERROR,
        failureDetail: 'No browser context available for WebMCP skill. Use schrute_explore first.',
        latencyMs: Date.now() - startTime,
      };
    }

    if (!browserProvider.evaluateModelContext) {
      return {
        success: false,
        data: null,
        failureCause: FailureCause.POLICY_DENIED,
        failureDetail: 'WebMCP requires a Chromium-based engine. Current engine does not support navigator.modelContext.',
        latencyMs: Date.now() - startTime,
      };
    }

    const { executeWebMcpTool } = await import('../browser/webmcp-bridge.js');
    const { loadCachedTools } = await import('../discovery/webmcp-scanner.js');
    const db = getDatabase(this.config);
    const allowedTools = loadCachedTools(skill.siteId, db);
    const toolName = skill.pathTemplate;

    const result = await executeWebMcpTool(
      { toolName, args: params },
      browserProvider,
      allowedTools.map(t => t.name),
    );

    // Metrics are now recorded by the shared post-execution path in executeSkillInner()
    return {
      success: !result.error,
      data: result.result,
      failureDetail: result.error ?? undefined,
      latencyMs: Date.now() - startTime,
    };
  }

  getStatus(options?: { drainWarnings?: boolean }): EngineStatus {
    let activeSession: SessionInfo | null = null;
    if (this.activeSessionId) {
      const sessions = this.sessionManager.listActive();
      activeSession = sessions.find((s) => s.id === this.activeSessionId) ?? null;
    }

    // Active named session info
    let activeNamedSession: EngineStatus['activeNamedSession'];
    const activeName = this.mode === 'recording'
      ? (this.recordingSessionName ?? this.exploreSessionName)
      : this.mode === 'exploring'
        ? this.exploreSessionName
        : this.multiSessionManager.getActive();
    const activeNamed = this.multiSessionManager.get(activeName);
    if (activeNamed && (activeName !== DEFAULT_SESSION_NAME || activeNamed.contextOverrides)) {
      activeNamedSession = {
        name: activeName,
        siteId: activeNamed.siteId,
        isCdp: activeNamed.isCdp,
        overrides: activeNamed.contextOverrides,
      };
    }

    // P3-7: Drain or peek warnings depending on caller.
    // Non-admin callers peek (non-destructive) so admin callers
    // don't lose visibility into explore/discovery failures.
    const drain = options?.drainWarnings ?? true;
    const warnings = drain ? this.drainWarnings() : this.peekWarnings();

    // P2-10: Compute skill summary
    const allSkills = this.skillRepo.getAll();
    const browserManager = this.getExploreBrowserManager();
    let executable = 0;
    let blocked = 0;
    for (const s of allSkills) {
      if (s.status !== SkillStatus.ACTIVE) {
        blocked++;
        continue;
      }
      const effectiveTier = getEffectiveTier(s);
      if (effectiveTier === TierState.TIER_3_DEFAULT && !browserManager.hasContext(s.siteId)) {
        blocked++;
      } else {
        executable++;
      }
    }

    return {
      mode: this.mode,
      activeSession,
      activeNamedSession,
      ...(this.getPendingRecoveryStatus() ? { pendingRecovery: this.getPendingRecoveryStatus() } : {}),
      currentRecording: this.currentRecording ? { ...this.currentRecording } : null,
      uptime: Date.now() - this.startedAt,
      ...(warnings.length > 0 ? { warnings } : {}),
      skillSummary: { total: allSkills.length, executable, blocked },
    };
  }

  private async runColdStartDiscovery(url: string, siteId: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    const { discoverSite } = await import('../discovery/cold-start.js');
    const db = getDatabase(this.config);

    if (signal?.aborted) return;
    // C5: Pass browser + db into discoverSite for WebMCP scanning
    const browserProvider = await this.createBrowserProvider(siteId);

    // Provide scrape context factory so discovery can render JS-heavy pages
    const browserManager = this.getExploreBrowserManager();
    const scrapeFactory = (id: string) => browserManager.createScrapeContext(id);

    if (signal?.aborted) return;
    const result = await discoverSite(url, this.config, browserProvider, db, undefined, scrapeFactory);
    if (signal?.aborted) return;
    if (result.endpoints.length > 0) {
      this.log.info(
        { siteId, endpointCount: result.endpoints.length, sources: result.sources.filter(s => s.found).map(s => s.type) },
        'Cold-start discovery found endpoints',
      );
    }

    // P1b: Import discovered endpoints as DRAFT skills (feature-flagged)
    if (this.config.features.discoveryImport && result.endpoints.length > 0) {
      if (signal?.aborted) return;
      try {
        const { discoveredEndpointsToSkills } = await import('../discovery/cold-start.js');
        const importResult = discoveredEndpointsToSkills(siteId, result.endpoints, this.skillRepo);
        this.log.info({ siteId, ...importResult }, 'Imported discovered endpoints as DRAFT skills');
      } catch (err) {
        this.log.warn({ err }, 'Discovery import failed');
      }
    }

    if (signal?.aborted) return;
    // C5: Load cached WebMCP tools
    const cachedTools = loadCachedTools(siteId, db);
    if (cachedTools.length > 0) {
      this.log.info({ siteId, toolCount: cachedTools.length }, 'Loaded cached WebMCP tools');
    }
  }

  /**
   * Background auth prefetch: refresh stale cookies for recently-used sites.
   * Skips sites with localStorage auth (same routing rule as agent-browser backend).
   * Merges cookies only — preserves existing origins array.
   */
  private async prefetchStaleAuth(activeSkills: SkillSpec[]): Promise<void> {
    const AUTH_STALE_MS = 5 * 60 * 1000;
    const RECENT_USE_MS = 30 * 60 * 1000;
    const CONCURRENCY = 3;
    const now = Date.now();
    const seenSites = new Set<string>();

    // Collect eligible sites
    const eligible: Array<{ siteId: string; domains: string[] }> = [];
    for (const skill of activeSkills) {
      if (seenSites.has(skill.siteId)) continue;
      seenSites.add(skill.siteId);
      if (!skill.lastUsed || now - skill.lastUsed > RECENT_USE_MS) continue;

      const authState = this.authStore?.load(skill.siteId);
      if (!authState) continue;
      if (authState.origins.some(o => o.localStorage.length > 0)) continue;
      if (now - authState.lastUpdated < AUTH_STALE_MS) continue;

      const policy = getSitePolicy(skill.siteId, this.config);
      const domains = policy.domainAllowlist.length > 0
        ? policy.domainAllowlist
        : [...new Set([...skill.allowedDomains, skill.siteId])];
      eligible.push({ siteId: skill.siteId, domains });
    }

    if (eligible.length === 0) return;

    // Process in chunks of CONCURRENCY
    for (let i = 0; i < eligible.length; i += CONCURRENCY) {
      const chunk = eligible.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        chunk.map(async ({ siteId, domains }) => {
          // refreshCookies throws on IPC/session failure — Promise.allSettled
          // catches rejected promises, so persist only runs on confirmed reads.
          // Empty cookies (successful read) clear stale auth after logout/expiry.
          const freshCookies = await this.agentBrowserBackend.refreshCookies(siteId, domains);
          const existing = this.authStore!.load(siteId);
          this.authStore!.save(siteId, {
            cookies: freshCookies,
            origins: existing?.origins ?? [],
            lastUpdated: now,
          });
        }),
      );
      for (const result of results) {
        if (result.status === 'rejected') {
          this.log.debug({ err: result.reason }, 'Auth prefetch chunk item failed');
        }
      }
    }
  }

  async close(): Promise<void> {
    // Clear session sweep interval
    if (this.sessionSweepInterval) {
      clearInterval(this.sessionSweepInterval);
      this.sessionSweepInterval = null;
    }

    // Clear backoff persist interval and do a final persist
    if (this.backoffPersistInterval) {
      clearInterval(this.backoffPersistInterval);
      this.backoffPersistInterval = null;
    }
    this.rateLimiter.persistBackoffs();

    // Clear background sweep interval
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = null;
    }

    // Abort background explore ops before closing
    if (this.exploreAbortController) {
      this.exploreAbortController.abort();
      this.exploreAbortController = null;
    }
    if (this.pendingBackgroundOps.size > 0) {
      await Promise.race([
        Promise.allSettled([...this.pendingBackgroundOps]),
        new Promise(resolve => setTimeout(resolve, 500)),
      ]);
      this.pendingBackgroundOps.clear();
    }

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
      await this.multiSessionManager.closeAll();
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

    if (this.pool) {
      try {
        await this.pool.shutdown();
      } catch (err) {
        this.log.warn({ err }, 'BrowserPool shutdown failed during engine close');
      }
    }

    // Shut down execution backends
    try { await this.agentBrowserBackend.shutdown(); }
    catch (err) { this.log.warn({ err }, 'AgentBrowserBackend shutdown failed'); }

    if (this.fallbackExecutionBackend) {
      try { await this.fallbackExecutionBackend.shutdown(); }
      catch (err) { this.log.warn({ err }, 'PlaywrightBackend shutdown failed'); }
      this.fallbackExecutionBackend = null;
    }

    for (const [name, backend] of this.sharedPlaywrightBackends) {
      try { await backend.shutdown(); }
      catch (err) { this.log.warn({ err, name }, 'Shared backend shutdown failed'); }
    }
    this.sharedPlaywrightBackends.clear();

    this.mode = 'idle';
    this.providerCache = new WeakMap();
    this.log.info('Engine closed');
  }
}

// Helper: strip schema to only required properties for drift enforcement
export function buildEnforcementSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema.type === 'array' && schema.items) {
    return { type: 'array', items: buildEnforcementSchema(schema.items as Record<string, unknown>) };
  }
  if (schema.type !== 'object' || !schema.properties) {
    return schema;
  }
  const required = new Set((schema.required ?? []) as string[]);
  const props = schema.properties as Record<string, Record<string, unknown>>;
  const enforcedProps: Record<string, Record<string, unknown>> = {};
  for (const key of Object.keys(props)) {
    if (required.has(key)) {
      enforcedProps[key] = props[key];
    }
  }
  return { type: 'object', properties: enforcedProps, required: [...required] };
}
