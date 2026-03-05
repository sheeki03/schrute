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
import { detectAndWaitForChallenge } from '../browser/base-browser-adapter.js';
import { getFlags } from '../browser/feature-flags.js';
import { BrowserManager, ContextOverrideMismatchError } from '../browser/manager.js';
import type { ContextOverrides } from '../browser/manager.js';
import { MultiSessionManager } from '../browser/multi-session.js';
import { detectAuth } from '../capture/auth-detector.js';
import { discoverParamsNative as discoverParams } from '../native/param-discoverer.js';
import { detectChains } from '../capture/chain-detector.js';
import { parseHar, extractRequestResponse, type StructuredRecord } from '../capture/har-extractor.js';
import { filterRequestsNative as filterRequests } from '../native/noise-filter.js';
import { clusterEndpoints } from '../capture/api-extractor.js';
import { generateSkill, generateSkillReferences, generateSkillTemplates, generateActionName } from '../skill/generator.js';
import { getSkillsDir } from './config.js';
import { SiteRepository } from '../storage/site-repository.js';
import { MasteryLevel, ExecutionTier } from '../skill/types.js';
import { classifySite } from '../automation/classifier.js';
import { updateStrategy } from '../automation/strategy.js';
import type { NetworkEntry } from '../skill/types.js';
import { canPromote, promoteSkill } from './promotion.js';
import { handleFailure } from './tiering.js';
import { detectDrift } from '../healing/diff-engine.js';
import { monitorSkills } from '../healing/monitor.js';
import { notify, createEvent } from '../healing/notification.js';
import { clusterByOperation, canReplayPersistedQuery, extractGraphQLInfo, isGraphQL } from '../capture/graphql-extractor.js';
import { canonicalizeRequest } from '../capture/canonicalizer.js';
import { recordFilteredEntries } from '../capture/noise-filter.js';
import { inferSchema, mergeSchemas } from '../capture/schema-inferrer.js';
import { loadCachedTools } from '../discovery/webmcp-scanner.js';
import type { SkillStatusName, GeoEmulationConfig } from '../skill/types.js';

// ─── Types ────────────────────────────────────────────────────────

export type EngineMode = 'idle' | 'exploring' | 'recording' | 'replaying';

export interface EngineStatus {
  mode: EngineMode;
  activeSession: SessionInfo | null;
  activeNamedSession?: { name: string; siteId: string; isCdp: boolean; overrides?: ContextOverrides };
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
  skillsGenerated?: number;
  signalRequests?: number;
  noiseRequests?: number;
}

export interface ExploreResult {
  sessionId: string;
  siteId: string;
  url: string;
  reused?: boolean;
  appliedOverrides?: { proxy?: { server: string }; geo?: GeoEmulationConfig };
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

/**
 * Traceability markers used in this file reference the OneAgent implementation plan:
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
  private multiSessionManager: MultiSessionManager;
  private recordingListenerCleanups: Array<() => void> = [];
  private providerCache = new WeakMap<
    BrowserManager,
    Map<string, { adapter: PlaywrightMcpAdapter; page: unknown; domainsKey: string }>
  >();

  constructor(config: OneAgentConfig) {
    this.config = config;
    const browserManager = new BrowserManager(config);
    this.sessionManager = new SessionManager(browserManager);
    this.multiSessionManager = new MultiSessionManager(browserManager, config);
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

  getMultiSessionManager(): MultiSessionManager {
    return this.multiSessionManager;
  }

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  private getProviderCacheForManager(manager: BrowserManager): Map<string, { adapter: PlaywrightMcpAdapter; page: unknown; domainsKey: string }> {
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

  resetExploreState(expectedId: string | null): void {
    if (this.activeSessionId !== expectedId) return;
    if (this.activeSessionId) {
      this.sessionManager.remove(this.activeSessionId);
    }
    this.activeSessionId = null;
    this.mode = 'idle';
    this.multiSessionManager.updateSiteId('default', '');
    this.multiSessionManager.updateContextOverrides('default', undefined);
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
    const manager = options?.browserManager ?? this.sessionManager.getBrowserManager();
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
      const pages = existing.pages();
      const page = pages[0] ?? await existing.newPage();
      const effectiveDomains = domains ?? [siteId];
      const domainsKey = this.domainsKey(effectiveDomains);
      const cached = providerCache.get(siteId);
      const pageIsClosed = cached
        && typeof (cached.page as { isClosed?: () => boolean }).isClosed === 'function'
        && (cached.page as { isClosed: () => boolean }).isClosed();
      if (cached && !pageIsClosed && cached.page === page && cached.domainsKey === domainsKey) {
        return cached.adapter;
      }

      const adapter = new PlaywrightMcpAdapter(page, effectiveDomains, {
        flags: getFlags(this.config),
        capabilities: manager.getCapabilities() ?? undefined,
        handlerTimeoutMs: manager.getHandlerTimeoutMs(),
      });
      providerCache.set(siteId, { adapter, page, domainsKey });
      return adapter;
    }

    const context = await manager.getOrCreateContext(siteId, options?.overrides);
    const pages = context.pages();
    const page = pages[0] ?? await context.newPage();
    const effectiveDomains = domains ?? [siteId];
    const domainsKey = this.domainsKey(effectiveDomains);
    const cached = providerCache.get(siteId);
    const pageIsClosed = cached
      && typeof (cached.page as { isClosed?: () => boolean }).isClosed === 'function'
      && (cached.page as { isClosed: () => boolean }).isClosed();
    if (cached && !pageIsClosed && cached.page === page && cached.domainsKey === domainsKey) {
      return cached.adapter;
    }

    const adapter = new PlaywrightMcpAdapter(page, effectiveDomains, {
      flags: getFlags(this.config),
      capabilities: manager.getCapabilities() ?? undefined,
      handlerTimeoutMs: manager.getHandlerTimeoutMs(),
    });
    providerCache.set(siteId, { adapter, page, domainsKey });
    return adapter;
  }

  private navigateFireAndForget(siteId: string, url: string, overrides?: ContextOverrides, sessionId?: string): void {
    const bm = this.sessionManager.getBrowserManager();
    bm.withLease(async () => {
      const context = await bm.getOrCreateContext(siteId, overrides);
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await detectAndWaitForChallenge(page, 3000);
      if (sessionId) this.sessionManager.updateUrl(sessionId, page.url());
    }).catch(err => {
      this.log.warn({ url, err }, 'Auto-navigation after explore failed (non-blocking)');
    });
  }

  async explore(url: string, overrides?: ContextOverrides): Promise<ExploreResult> {
    const parsedUrl = new URL(url);
    const siteId = parsedUrl.hostname;

    // Re-explore same site: reuse session, navigate to new URL
    if (this.mode === 'exploring' && this.activeSessionId) {
      const currentSession = this.sessionManager.getSession(this.activeSessionId);
      if (currentSession?.siteId === siteId) {
        try {
          await this.sessionManager.getBrowserManager().getOrCreateContext(siteId, overrides);
          this.navigateFireAndForget(siteId, url, overrides, currentSession.id);
          return { sessionId: currentSession.id, siteId, url, reused: true };
        } catch (err) {
          if (err instanceof ContextOverrideMismatchError) {
            throw new Error(
              `Site "${siteId}" already has an active session with different overrides. ` +
              `Use oneagent_close_session(name: "default", force: true) first, then re-explore.`
            );
          }
          throw err;
        }
      }
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
      const session = await this.sessionManager.create(siteId, url, overrides);
      this.activeSessionId = session.id;
      this.mode = 'exploring';

      // Sync default session siteId
      this.multiSessionManager.updateSiteId('default', siteId);
      this.multiSessionManager.updateContextOverrides('default', overrides);

      this.log.info({ sessionId: session.id, url, siteId }, 'Explore session started');

      this.navigateFireAndForget(siteId, url, overrides, session.id);

      // Fire-and-forget cold-start discovery (non-blocking)
      this.runColdStartDiscovery(url, siteId).catch(err => {
        this.log.warn({ siteId, err }, 'Cold-start discovery failed (non-blocking)');
      });

      const appliedOverrides = overrides ? {
        proxy: overrides.proxy ? { server: overrides.proxy.server } : undefined,
        geo: overrides.geo,
      } : undefined;

      return {
        sessionId: session.id,
        siteId,
        url,
        appliedOverrides,
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

    // Verify recording is on the default launch-based session
    if (this.multiSessionManager.getActive() !== 'default') {
      throw new Error(
        'Recording is only supported on the default session. ' +
        'Switch to the default session first with oneagent_switch_session.',
      );
    }
    const defaultSession = this.multiSessionManager.get('default');
    if (!defaultSession) {
      throw new Error('No default session available for recording.');
    }
    const browserManager = defaultSession.browserManager;
    if (!browserManager.supportsHarRecording()) {
      throw new Error('Recording is not supported on CDP sessions. Use a launch-based browser session.');
    }

    const previousMode = this.mode;
    const previousRecording = this.currentRecording;

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
      const context = browserManager.tryGetContext(session.siteId);
      if (context) {
        const responseHandler = () => {
          if (this.currentRecording === recording) {
            recording.requestCount++;
          }
        };
        (context as any).on('response', responseHandler);
        this.recordingListenerCleanups.push(() => (context as any).off('response', responseHandler));
      }

      this.mode = 'recording';
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
      // Clean up any listeners attached before the failure
      for (const cleanup of this.recordingListenerCleanups) {
        try { cleanup(); } catch { /* ignore */ }
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

    // Detach response listeners from the recording cycle
    for (const cleanup of this.recordingListenerCleanups) {
      try { cleanup(); } catch { /* page may already be closed */ }
    }
    this.recordingListenerCleanups = [];

    this.log.info(
      { recordingId: recording.id, name: recording.name, requests: recording.requestCount },
      'Recording stopped',
    );

    const browserManager = this.sessionManager.getBrowserManager();
    const siteId = recording.siteId;

    try {
      // 1. Capture HAR path BEFORE closing context
      const harPath = browserManager.getHarPath(siteId);
      if (!harPath) {
        throw new Error('Missing HAR path during recording — invariant violation');
      }

      // 2. Close context -> flushes HAR to disk (browser-touching, use lease)
      await browserManager.withLease(async () => {
        await browserManager.closeContext(siteId);
      });

      // 3. Run capture pipeline with explicit HAR path (CPU/IO only, no lease)
      let pipelineError: Error | undefined;
      try {
        await this.runCapturePipeline(recording, harPath);
      } catch (err) {
        pipelineError = err instanceof Error ? err : new Error(String(err));
      }

      // 4. Re-open context so explore mode remains usable (browser-touching, use lease)
      if (!this.isClosing) {
        try {
          await browserManager.withLease(async () => {
            await browserManager.getOrCreateContext(siteId);
          });
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
      const allRecords: StructuredRecord[] = harData.log.entries.map(extractRequestResponse);

      // Filter noise (analytics, beacons, polling, static assets)
      const { signal, noise, ambiguous } = filterRequests(harData.log.entries);

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
      const clusters = clusterEndpoints(restRecords);
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

    // Derive effective domain list once — used for budget tracker and browser provider
    const policy = getSitePolicy(skill.siteId, this.config);
    const effectiveDomains = policy.domainAllowlist.length > 0
      ? policy.domainAllowlist
      : [...new Set([...skill.allowedDomains, skill.siteId])];
    this.budgetTracker.setDomainAllowlist(effectiveDomains);

    // Wire live browser context into executor if available
    const browserProvider = await this.createBrowserProvider(skill.siteId, effectiveDomains);

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

      // 8. Update adaptive strategy with observation
      updateStrategy(skill.siteId, {
        skillId: skill.id,
        tier: result.tier,
        success: result.success,
        latencyMs: result.latencyMs,
        failureCause: result.failureCause,
      });

      // A1: Update validation counters
      if (result.success) {
        this.skillRepo.updateConfidence(skill.id, Math.min(skill.confidence + 0.1, 1.0), skill.consecutiveValidations + 1);
      } else {
        this.skillRepo.updateConfidence(skill.id, Math.max(skill.confidence - 0.2, 0), 0);
      }

      // A2: Handle structural failures — tier lock
      const structuralCauses = ['js_computed_field', 'protocol_sensitivity', 'signed_payload'];
      if (result.failureCause && structuralCauses.includes(result.failureCause)) {
        const failResult = handleFailure(skill, result.failureCause);
        this.skillRepo.updateTier(skill.id, failResult.newTier, failResult.tierLock);
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
            this.skillRepo.update(skill.id, { status: 'stale' as SkillStatusName, consecutiveValidations: 0 });
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

      // B2: Health monitoring
      const [healthReport] = monitorSkills([skill], this.metricsRepo);
      if (healthReport?.status === 'broken') {
        this.skillRepo.update(skill.id, { status: 'broken' as SkillStatusName, consecutiveValidations: 0 });
        notify(createEvent('skill_broken', skill.id, skill.siteId,
          { successRate: healthReport.successRate }), this.config).catch(err => this.log.debug({ err }, 'Notification failed'));
      } else if (healthReport?.status === 'degrading') {
        notify(createEvent('skill_degraded', skill.id, skill.siteId,
          { successRate: healthReport.successRate, trend: healthReport.trend }), this.config).catch(err => this.log.debug({ err }, 'Notification failed'));
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

    // Active named session info
    let activeNamedSession: EngineStatus['activeNamedSession'];
    const activeName = this.multiSessionManager.getActive();
    const activeNamed = this.multiSessionManager.get(activeName);
    if (activeNamed && (activeName !== 'default' || activeNamed.contextOverrides)) {
      activeNamedSession = {
        name: activeName,
        siteId: activeNamed.siteId,
        isCdp: activeNamed.isCdp,
        overrides: activeNamed.contextOverrides,
      };
    }

    return {
      mode: this.mode,
      activeSession,
      activeNamedSession,
      currentRecording: this.currentRecording ? { ...this.currentRecording } : null,
      uptime: Date.now() - this.startedAt,
    };
  }

  private async runColdStartDiscovery(url: string, siteId: string): Promise<void> {
    const { discoverSite } = await import('../discovery/cold-start.js');
    const db = getDatabase(this.config);

    // C5: Pass browser + db into discoverSite for WebMCP scanning
    const browserProvider = await this.createBrowserProvider(siteId);

    const result = await discoverSite(url, this.config, browserProvider, db);
    if (result.endpoints.length > 0) {
      this.log.info(
        { siteId, endpointCount: result.endpoints.length, sources: result.sources.filter(s => s.found).map(s => s.type) },
        'Cold-start discovery found endpoints',
      );
    }

    // C5: Load cached WebMCP tools
    const cachedTools = loadCachedTools(siteId, db);
    if (cachedTools.length > 0) {
      this.log.info({ siteId, toolCount: cachedTools.length }, 'Loaded cached WebMCP tools');
    }
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
