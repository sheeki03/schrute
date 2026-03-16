import * as fs from 'node:fs';
import * as path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Browser, BrowserContext } from 'playwright';
import { getConfig, getBrowserDataDir, getTmpDir } from '../core/config.js';
import type { SchruteConfig, ProxyConfig, GeoEmulationConfig } from '../skill/types.js';
import { ANALYTICS_DOMAINS, FEATURE_FLAG_DOMAINS } from '../skill/types.js';
import { launchBrowserEngine, type EngineCapabilities } from './engine.js';
import { getFlags } from './feature-flags.js';
import type { BrowserEngine } from '../skill/types.js';
import { getLogger } from '../core/logger.js';
import type { CdpConnectionOptions } from './cdp-connector.js';
import type { BrowserPool } from './pool.js';
import { BoundedMap } from '../shared/bounded-map.js';
import type { BrowserAuthStore } from './auth-store.js';
import type { AuthCoordinator } from './auth-coordinator.js';
import { ParallelismGovernor } from './parallelism-governor.js';

const log = getLogger();

/** Proxy configs with placeholder/example servers that would always fail */
const PLACEHOLDER_PROXY_RE = /example\.com|localhost:0\b|placeholder/i;

function resolveProxy(overrides: ContextOverrides | undefined, config: ReturnType<BrowserManager['getResolvedConfig']>): ProxyConfig | undefined {
  const raw = overrides?.proxy ?? config.browser?.proxy;
  if (raw?.server && PLACEHOLDER_PROXY_RE.test(raw.server)) return undefined;
  return raw;
}

// ─── Context Overrides ─────────────────────────────────────────────

export interface ContextOverrides {
  proxy?: ProxyConfig;
  geo?: GeoEmulationConfig;
}

export class ContextOverrideMismatchError extends Error {
  constructor(siteId: string) {
    super(
      `Context for '${siteId}' already exists with different proxy/geo settings. ` +
      'Close the session first, then re-explore with new settings.',
    );
    this.name = 'ContextOverrideMismatchError';
  }
}

export function stableStringify(obj: unknown): string {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const record = obj as Record<string, unknown>;
  const sorted = Object.keys(record).filter(k => record[k] !== undefined).sort();
  return '{' + sorted.map(k => JSON.stringify(k) + ':' + stableStringify(record[k])).join(',') + '}';
}

function overridesEqual(a: ContextOverrides | undefined, b: ContextOverrides | undefined): boolean {
  if (a === b) return true;
  if (!a && !b) return true;
  return stableStringify(a) === stableStringify(b);
}

export function safeProxyUrl(server: string): string {
  try {
    const u = new URL(server);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return '[invalid-url]';
  }
}

function simpleHash(s: string): number {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) >>> 0;
  }
  return hash;
}

const DEFAULT_IDLE_TIMEOUT_MS = 300_000; // 5 minutes
const DEFAULT_HANDLER_TIMEOUT_MS = 30_000; // 30 seconds

interface ManagedContext {
  context: BrowserContext;
  siteId: string;
  harPath: string | undefined; // undefined for CDP sessions (no HAR recording)
  createdAt: number;
  overrides?: ContextOverrides;
  selectedPageUrl?: string;
}

/**
 * Manages Playwright browser lifecycle and per-site persistent contexts.
 *
 * Each site gets its own BrowserContext with:
 * - Persistent storage at ~/.schrute/browser-data/{siteId}/
 * - Full HAR recording (headers, cookies, response metadata)
 * - Isolated cookie/storage state
 * - Idle timeout with lazy relaunch
 * - Per-operation lease tracking
 */
export class BrowserManager {
  private browser: Browser | null = null;
  private contexts = new Map<string, ManagedContext>();
  private lastHarPaths = new BoundedMap<string, string>({ maxSize: 500, ttlMs: 1800_000 });
  private config?: SchruteConfig;
  private capabilities: EngineCapabilities | null = null;
  private engine: BrowserEngine;

  // Pool state
  private pool: BrowserPool | null = null;
  private releaseToPool: (() => void) | null = null;
  private disconnectHandler: (() => void) | null = null;

  // Idle timeout state
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimeoutMs: number;
  private lastActivityAt: number = Date.now();
  private inFlightOps: number = 0;
  private suppressIdleTimeout: boolean = false;

  // Lifecycle lock — serializes lifecycle transitions (idleShutdown, closeAll, detachCdp)
  private lifecyclePromise: Promise<void> | null = null;
  // AsyncLocalStorage tracks the current async context to detect true reentrancy
  // (same async call chain) vs legitimate concurrent calls (different async chains).
  private static lifecycleALS = new AsyncLocalStorage<string>();

  // Auth integration (set via setter to avoid constructor changes)
  private authStore?: BrowserAuthStore;
  private authCoordinator?: AuthCoordinator;
  private sessionName?: string;

  // Parallelism governor — gates local browser launches
  private governor = new ParallelismGovernor();

  // CDP state
  private cdpConnected: boolean = false;
  private cdpOptions: CdpConnectionOptions | null = null;
  private cdpFailed: boolean = false;
  private reconnecting: boolean = false;
  private reconnectPromise: Promise<void> | null = null;
  private reconnectAborted: boolean = false;
  private lastCdpSiteId: string | null = null; // preserved across disconnect for reconnect

  constructor(config?: SchruteConfig, pool?: BrowserPool) {
    this.config = config;
    this.pool = pool ?? null;
    this.engine = config?.browser?.engine ?? 'patchright';
    this.idleTimeoutMs = config?.browser?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  setAuthIntegration(authStore: BrowserAuthStore, coordinator: AuthCoordinator, sessionName: string): void {
    this.authStore = authStore;
    this.authCoordinator = coordinator;
    this.sessionName = sessionName;
  }

  /**
   * Unregister all auth coordinator participants for tracked contexts.
   * Must be called before contexts.clear() to avoid orphaned registrations.
   */
  private unregisterAllAuthParticipants(): void {
    if (!this.authCoordinator) return;
    for (const siteId of this.contexts.keys()) {
      this.authCoordinator.unregister(`explore:${this.sessionName ?? 'default'}:${siteId}`);
    }
  }

  /**
   * Snapshot auth state from a live browser context into the auth store.
   * Non-blocking — failures are logged but do not throw.
   */
  async snapshotAuth(siteId: string): Promise<void> {
    if (!this.authStore || !this.authCoordinator) return;

    const ctx = this.tryGetContext(siteId);
    if (!ctx) return;

    try {
      // Extract storage state from the live context
      const storageState = await ctx.storageState();
      const cookies = (storageState.cookies || []).map((c: any) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
      }));
      const origins = storageState.origins || [];

      const { changed, version } = this.authStore.save(siteId, {
        cookies,
        origins,
        lastUpdated: Date.now(),
      });

      if (changed) {
        const originId = `explore:${this.sessionName ?? 'default'}:${siteId}`;
        // Advance our own lastSeenAuthVersion so we don't self-invalidate
        const participant = this.authCoordinator.getParticipant(originId);
        if (participant) participant.lastSeenAuthVersion = version;
        await this.authCoordinator.publish({
          siteId,
          version,
          originId,
          reason: 'auth_snapshot',
        });
      }
    } catch (err) {
      log.debug({ err, siteId }, 'Auth snapshot failed (non-blocking)');
    }
  }

  private getResolvedConfig(): SchruteConfig {
    return this.config ?? getConfig();
  }

  /**
   * Get the configured handler timeout in ms.
   */
  getHandlerTimeoutMs(): number {
    const config = this.getResolvedConfig();
    return config.browser?.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
  }

  // ─── Lifecycle Lock ─────────────────────────────────────────────

  /**
   * Serialize lifecycle transitions to prevent overlapping operations.
   * Non-reentrant: fails fast if called within the same async context (catches bugs).
   * Concurrent same-name calls from different async contexts queue correctly.
   *
   * Uses AsyncLocalStorage for accurate reentrancy detection — a name-based check
   * would false-positive on legitimate concurrent calls with the same operation name.
   *
   * Uses a promise-chain queue: each caller appends to the chain, so even if
   * multiple callers await the same predecessor, they execute sequentially
   * (each sees the NEXT link, not the same one).
   */
  private async withLifecycleLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    // True reentrancy guard — only fires if this is the SAME async context
    // (i.e., fn() called withLifecycleLock again). Different concurrent callers
    // get different ALS stores and correctly queue instead of erroring.
    const currentHolder = BrowserManager.lifecycleALS.getStore();
    if (currentHolder !== undefined) {
      throw new Error(`BrowserManager lifecycle lock re-entry detected: '${name}' called while already held by '${currentHolder}'`);
    }

    // Chain onto the existing promise (or start fresh).
    // Each caller gets its own link in the chain — no two can run concurrently.
    const predecessor = this.lifecyclePromise ?? Promise.resolve();

    let resolve!: () => void;
    // The next link: won't resolve until THIS operation finishes
    this.lifecyclePromise = new Promise<void>(r => { resolve = r; });

    // Wait for all prior operations to complete
    await predecessor;

    try {
      // Run fn() inside ALS context so nested withLifecycleLock calls are detected
      return await BrowserManager.lifecycleALS.run(name, fn);
    } finally {
      resolve();
    }
  }

  // ─── Operation Lease System ─────────────────────────────────────

  /**
   * Record the start of a browser operation. Clears idle timer.
   */
  touchActivity(): void {
    this.inFlightOps++;
    this.lastActivityAt = Date.now();
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /**
   * Record the end of a browser operation. Starts idle timer when no ops remain.
   */
  releaseActivity(): void {
    this.inFlightOps = Math.max(0, this.inFlightOps - 1);
    if (this.inFlightOps === 0) {
      this.resetIdleTimer();
    }
  }

  /**
   * Whether no operations are in flight.
   */
  isIdle(): boolean {
    return this.inFlightOps === 0;
  }

  /**
   * Centralized lease scope — the ONLY way callers should bracket browser operations.
   * Prevents imbalanced lease from missed finally blocks.
   */
  async withLease<T>(fn: () => Promise<T>): Promise<T> {
    this.touchActivity();
    try {
      return await fn();
    } finally {
      this.releaseActivity();
    }
  }

  // ─── Idle Timeout ───────────────────────────────────────────────

  /**
   * Set or clear idle timeout suppression (used during recording).
   */
  setSuppressIdleTimeout(suppress: boolean): void {
    this.suppressIdleTimeout = suppress;
    if (suppress) {
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }
    } else {
      this.resetIdleTimer();
    }
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    // Don't set timer if: disabled, ops in flight, no browser, CDP session, or suppressed
    if (
      this.idleTimeoutMs <= 0 ||
      this.inFlightOps > 0 ||
      !this.browser?.isConnected() ||
      this.cdpConnected ||
      this.suppressIdleTimeout
    ) {
      return;
    }

    this.idleTimer = setTimeout(() => {
      this.idleShutdown().catch(err => {
        log.warn({ err }, 'Idle shutdown failed');
      });
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  /**
   * Shut down browser after idle timeout. Uses lifecycle lock.
   */
  async idleShutdown(): Promise<void> {
    return this.withLifecycleLock('idleShutdown', async () => {
      if (this.inFlightOps > 0 || this.suppressIdleTimeout) return;

      log.info('Idle timeout reached — shutting down browser');

      // Close each context with persistence
      for (const siteId of [...this.contexts.keys()]) {
        if (this.inFlightOps > 0) return; // bail if new work arrived
        await this.closeContext(siteId);
      }

      if (this.inFlightOps > 0) return;

      // Null browser reference synchronously, then close/release detached ref
      const browser = this.browser;
      this.browser = null;
      if (this.releaseToPool) {
        if (this.disconnectHandler && browser) {
          browser.off('disconnected', this.disconnectHandler);
        }
        this.releaseToPool();
        this.releaseToPool = null;
        this.disconnectHandler = null;
      } else {
        try { await browser?.close(); } catch { /* already closed */ }
      }
    });
  }

  // ─── Browser Launch ─────────────────────────────────────────────

  /**
   * Launch the shared browser instance.
   * Idempotent — returns immediately if already launched.
   */
  async launchBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) {
      return this.browser;
    }

    // Pool acquisition — borrow a browser from the pool instead of launching locally
    if (this.pool) {
      const { browser, release } = await this.pool.acquire();
      this.browser = browser;
      this.releaseToPool = release;
      // Store disconnect handler ref for cleanup
      this.disconnectHandler = () => {
        log.warn('Pool browser disconnected');
        this.browser = null;
        this.unregisterAllAuthParticipants();
        this.contexts.clear();
        if (this.idleTimer) {
          clearTimeout(this.idleTimer);
          this.idleTimer = null;
        }
      };
      browser.on('disconnected', this.disconnectHandler);
      this.resetIdleTimer();
      return browser;
    }

    log.info({ engine: this.engine }, 'Launching browser');
    await this.governor.acquire();
    let result: Awaited<ReturnType<typeof launchBrowserEngine>>;
    try {
      result = await launchBrowserEngine(this.engine, { headless: true });
    } catch (err) {
      this.governor.release(); // Prevent slot leak on launch failure
      throw err;
    }
    this.browser = result.browser;
    this.capabilities = result.capabilities;
    if (result.capabilities.configuredEngine !== result.capabilities.effectiveEngine) {
      log.warn(
        { configured: result.capabilities.configuredEngine, effective: result.capabilities.effectiveEngine },
        'Browser engine fallback active — running without stealth',
      );
    }

    this.browser.on('disconnected', () => {
      log.warn('Browser disconnected');
      this.browser = null;
      this.governor.release();
      this.unregisterAllAuthParticipants();
      this.contexts.clear();
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }

      // CDP auto-reconnect
      if (this.cdpConnected && this.cdpOptions && !this.reconnectAborted) {
        this.attemptReconnect();
      }
    });

    this.resetIdleTimer();
    return this.browser;
  }

  // ─── Fingerprint Coherence ─────────────────────────────────────

  private validateGeoCoherence(overrides?: ContextOverrides): void {
    if (!overrides?.geo) return;
    const { locale, timezoneId } = overrides.geo;
    if (!locale || !timezoneId) return;

    // Basic coherence: US locales should have US timezones, etc.
    const localeCountry = locale.split('-')[1]?.toUpperCase();
    const tzContinent = timezoneId.split('/')[0];

    const TIMEZONE_COUNTRY_MAP: Record<string, string[]> = {
      'America': ['US', 'CA', 'MX', 'BR', 'AR', 'CO', 'CL'],
      'Europe': ['GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'PL', 'SE', 'NO', 'DK', 'FI', 'PT', 'AT', 'CH', 'BE', 'IE'],
      'Asia': ['JP', 'CN', 'KR', 'IN', 'SG', 'HK', 'TW', 'TH', 'VN', 'PH', 'MY', 'ID'],
      'Australia': ['AU', 'NZ'],
      'Africa': ['ZA', 'NG', 'KE', 'EG', 'MA'],
    };

    if (localeCountry && tzContinent) {
      const expectedCountries = TIMEZONE_COUNTRY_MAP[tzContinent];
      if (expectedCountries && !expectedCountries.includes(localeCountry)) {
        log.warn(
          { locale, timezoneId, localeCountry, tzContinent },
          'Geo fingerprint incoherence: locale country does not match timezone continent'
        );
      }
    }
  }

  // ─── Context Management ─────────────────────────────────────────

  /**
   * Get an existing context for a site, or create one with HAR recording.
   */
  async getOrCreateContext(siteId: string, overrides?: ContextOverrides): Promise<BrowserContext> {
    // Guard: reconnecting or failed CDP
    if (this.reconnecting) {
      throw new Error('Browser disconnected and reconnecting. Please retry shortly.');
    }
    if (this.cdpFailed) {
      throw new Error('CDP connection lost and reconnect failed. Use schrute_connect_cdp to reconnect.');
    }

    const existing = this.contexts.get(siteId);
    if (existing) {
      // Safety net: check if our auth version is stale (missed coordinator event)
      if (this.authCoordinator && this.authStore) {
        const participantId = `explore:${this.sessionName ?? 'default'}:${siteId}`;
        const participant = this.authCoordinator.getParticipant(participantId);
        const currentStoreVersion = this.authStore.load(siteId)?.version ?? 0;
        if (participant && participant.lastSeenAuthVersion < currentStoreVersion) {
          // Stale — discard and recreate below
          log.info({ siteId, stale: participant.lastSeenAuthVersion, current: currentStoreVersion },
            'Auth version stale — discarding context for fresh hydration');
          this.authCoordinator.unregister(participantId);
          this.contexts.delete(siteId);
          try { await existing.context.close(); } catch { /* best effort */ }
          // Fall through to create a new context below
        } else {
          // CDP: skip mismatch check — overrides not applicable
          if (this.cdpConnected) return existing.context;
          // Launch-based: compare effective overrides
          const config = this.getResolvedConfig();
          const effectiveProxy = resolveProxy(overrides, config);
          const effectiveGeo = overrides?.geo ?? config.browser?.geo;
          const effectiveOverrides: ContextOverrides | undefined =
            effectiveProxy || effectiveGeo ? { proxy: effectiveProxy, geo: effectiveGeo } : undefined;
          if (!overridesEqual(existing.overrides, effectiveOverrides)) {
            throw new ContextOverrideMismatchError(siteId);
          }
          return existing.context;
        }
      } else {
        // No auth integration — original behavior
        if (this.cdpConnected) return existing.context;
        const config = this.getResolvedConfig();
        const effectiveProxy = resolveProxy(overrides, config);
        const effectiveGeo = overrides?.geo ?? config.browser?.geo;
        const effectiveOverrides: ContextOverrides | undefined =
          effectiveProxy || effectiveGeo ? { proxy: effectiveProxy, geo: effectiveGeo } : undefined;
        if (!overridesEqual(existing.overrides, effectiveOverrides)) {
          throw new ContextOverrideMismatchError(siteId);
        }
        return existing.context;
      }
    }

    // CDP mode: reuse existing context or create minimal one
    if (this.cdpConnected && this.browser) {
      if (overrides?.proxy || overrides?.geo) {
        log.warn({ siteId }, 'Proxy/geo overrides ignored for CDP connection');
      }
      const existingContexts = this.browser.contexts();
      const context = existingContexts[0] ?? await this.browser.newContext();
      this.contexts.set(siteId, {
        context,
        siteId,
        harPath: undefined, // CDP: no HAR
        createdAt: Date.now(),
      });
      log.info({ siteId }, 'Reusing CDP browser context (no HAR)');
      return context;
    }

    this.validateGeoCoherence(overrides);

    const browser = await this.launchBrowser();
    const config = this.getResolvedConfig();
    const effectiveProxy = resolveProxy(overrides, config);
    const effectiveGeo = overrides?.geo ?? config.browser?.geo;

    // Persistent storage directory for this site
    const storageDir = path.join(getBrowserDataDir(config), siteId);
    fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });

    // HAR output path in tmp directory
    const tmpDir = getTmpDir(config);
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const harPath = path.join(tmpDir, `${siteId}-${Date.now()}.har`);

    // Load existing storage state: prefer auth-store (canonical), fall back to legacy storage-state.json
    const storageStatePath = path.join(storageDir, 'storage-state.json');
    let storageState: string | undefined;
    if (this.authStore) {
      const authState = this.authStore.load(siteId);
      if (authState) {
        // Convert canonical auth state to Playwright storage state format and write to temp file
        const pwState = this.authStore.toPlaywrightStorageState(authState);
        const tmpStatePath = path.join(storageDir, 'auth-state-pw.json');
        fs.writeFileSync(tmpStatePath, JSON.stringify(pwState), { mode: 0o600 });
        storageState = tmpStatePath;
      } else if (fs.existsSync(storageStatePath)) {
        storageState = storageStatePath;
      }
    } else if (fs.existsSync(storageStatePath)) {
      storageState = storageStatePath;
    }

    const ctxOpts: Record<string, unknown> = {
      recordHar: { path: harPath, mode: 'full' },
      storageState,
    };

    if (effectiveProxy) {
      ctxOpts.proxy = {
        server: effectiveProxy.server,
        ...(effectiveProxy.bypass && { bypass: effectiveProxy.bypass }),
        ...(effectiveProxy.username && { username: effectiveProxy.username }),
        ...(effectiveProxy.password && { password: effectiveProxy.password }),
      };
    }
    if (effectiveGeo?.geolocation) {
      ctxOpts.geolocation = effectiveGeo.geolocation;
      ctxOpts.permissions = ['geolocation'];
    }
    if (effectiveGeo?.timezoneId) ctxOpts.timezoneId = effectiveGeo.timezoneId;
    if (effectiveGeo?.locale) ctxOpts.locale = effectiveGeo.locale;

    // Stable per-site fingerprint (Botasaurus-style)
    const flags = getFlags(this.getResolvedConfig());
    if (flags.fingerprintProfile && !effectiveGeo?.userAgent && !effectiveGeo?.viewport) {
      const hash = simpleHash(siteId);
      const viewports: [number, number][] = [[1366,768],[1440,900],[1536,864],[1920,1080],[1280,800]];
      const uas = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
      ];
      ctxOpts.viewport = { width: viewports[hash % viewports.length][0], height: viewports[hash % viewports.length][1] };
      ctxOpts.userAgent = uas[hash % uas.length];
    }

    // Explicit UA/viewport overrides from geo config
    if (effectiveGeo?.viewport) ctxOpts.viewport = effectiveGeo.viewport;
    if (effectiveGeo?.userAgent) ctxOpts.userAgent = effectiveGeo.userAgent;

    const context = await browser.newContext(ctxOpts);

    if (effectiveGeo?.timezoneId) {
      try {
        const testPage = await context.newPage();
        const actual = await testPage.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
        await testPage.close();
        if (actual !== effectiveGeo.timezoneId) {
          log.warn({ expected: effectiveGeo.timezoneId, actual }, 'Timezone emulation may not have taken effect');
        }
      } catch (err) {
        log.debug({ err }, 'Timezone verification failed (non-blocking)');
      }
    }

    const storedOverrides: ContextOverrides | undefined =
      effectiveProxy || effectiveGeo ? { proxy: effectiveProxy, geo: effectiveGeo } : undefined;

    this.contexts.set(siteId, {
      context,
      siteId,
      harPath,
      createdAt: Date.now(),
      overrides: storedOverrides,
    });

    // cf_clearance cookie warning when proxy changes
    if (storageState && (effectiveProxy)) {
      try {
        const raw = fs.readFileSync(storageStatePath, 'utf-8');
        const parsed = JSON.parse(raw);
        const cookies = parsed.cookies ?? [];
        const hasCfClearance = cookies.some((c: any) => c.name === 'cf_clearance');
        if (hasCfClearance) {
          log.info({ siteId }, 'cf_clearance cookie found — will be valid only if proxy IP matches previous session');
        }
      } catch (err) {
        log.debug({ err, siteId }, 'Could not parse storage state for cf_clearance check');
      }
    }

    const logMeta: Record<string, unknown> = { siteId, harPath };
    if (effectiveProxy) logMeta.proxy = safeProxyUrl(effectiveProxy.server);
    if (effectiveGeo?.timezoneId) logMeta.timezoneId = effectiveGeo.timezoneId;
    if (effectiveGeo?.locale) logMeta.locale = effectiveGeo.locale;
    log.info(logMeta, 'Created browser context with HAR recording');

    // Register as auth coordinator participant for this site context
    if (this.authCoordinator && this.authStore) {
      const participantId = `explore:${this.sessionName ?? 'default'}:${siteId}`;
      const authVersion = this.authStore.load(siteId)?.version ?? 0;
      this.authCoordinator.register({
        id: participantId,
        siteId,
        lastSeenAuthVersion: authVersion,
        onAuthChanged: async (_sid: string, _newVersion: number) => {
          // Peer has newer auth — discard this context without persisting stale state
          const ctx = this.contexts.get(siteId);
          if (ctx) {
            this.contexts.delete(siteId);
            try { await ctx.context.close(); } catch { /* best effort */ }
            log.info({ siteId, participantId }, 'Auth coordinator invalidated context');
          }
        },
      });
    }

    return context;
  }

  /**
   * Create a separate BrowserContext for scraping (not stored in this.contexts).
   * When assetBlocking is enabled, blocks images, media, fonts, stylesheets,
   * analytics, and feature-flag domains for faster page loads.
   */
  async createScrapeContext(siteId: string): Promise<{ context: BrowserContext; close: () => Promise<void> }> {
    const browser = this.browser ?? await this.launchBrowser();
    const context = await browser.newContext({ javaScriptEnabled: true });
    const flags = getFlags(this.getResolvedConfig());
    if (flags.assetBlocking) {
      await context.route('**/*', (route) => {
        const url = route.request().url();
        const resourceType = route.request().resourceType();
        if (['image', 'media', 'font', 'stylesheet'].includes(resourceType)) {
          return route.abort();
        }
        try {
          const hostname = new URL(url).hostname;
          if (ANALYTICS_DOMAINS.some(d => hostname.includes(d)) ||
              FEATURE_FLAG_DOMAINS.some(d => hostname.includes(d))) {
            return route.abort();
          }
        } catch { /* invalid URL — let it continue */ }
        return route.continue();
      });
    }
    return { context, close: () => context.close() };
  }

  /**
   * Export cookies from a site's browser context.
   */
  async exportCookies(siteId: string): Promise<Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: string;
  }>> {
    const managed = this.contexts.get(siteId);
    if (!managed) {
      throw new Error(`No browser context for site '${siteId}'. Explore the site first.`);
    }

    const cookies = await managed.context.cookies();
    return cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    }));
  }

  /**
   * Close the context for a specific site.
   * Uses persist-first, then remove+close pattern.
   */
  async closeContext(siteId: string): Promise<void> {
    const managed = this.contexts.get(siteId);
    if (!managed) {
      return;
    }

    // 1. Save harPath to lastHarPaths (if defined)
    if (managed.harPath) {
      this.lastHarPaths.set(siteId, managed.harPath);
    }

    // 2. Persist storage state (if not CDP)
    if (managed.harPath !== undefined) {
      const config = this.getResolvedConfig();
      const storageDir = path.join(getBrowserDataDir(config), siteId);
      const storageStatePath = path.join(storageDir, 'storage-state.json');

      try {
        const state = await managed.context.storageState();
        fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });
        // Write legacy storage-state.json for backward compatibility
        fs.writeFileSync(storageStatePath, JSON.stringify(state), {
          mode: 0o600,
        });

        // Also persist to canonical auth store if available
        if (this.authStore) {
          const cookies = (state.cookies || []).map((c: any) => ({
            name: c.name, value: c.value, domain: c.domain, path: c.path,
            expires: c.expires, httpOnly: c.httpOnly, secure: c.secure,
            sameSite: c.sameSite,
          }));
          const origins = state.origins || [];
          const { changed, version } = this.authStore.save(siteId, {
            cookies, origins, lastUpdated: Date.now(),
          });
          if (changed && this.authCoordinator) {
            const originId = `explore:${this.sessionName ?? 'default'}:${siteId}`;
            // Advance version before publishing so we don't self-invalidate
            const participant = this.authCoordinator.getParticipant(originId);
            if (participant) participant.lastSeenAuthVersion = version;
            this.authCoordinator.publish({ siteId, version, originId, reason: 'context_close' })
              .catch(err => log.debug({ err, siteId }, 'Auth publish on close failed'));
          }
        }

        log.info({ siteId }, 'Saved storage state');
      } catch (err) {
        log.warn({ siteId, err }, 'Failed to save storage state');
      }
    }

    // 3. Unregister from auth coordinator
    if (this.authCoordinator) {
      this.authCoordinator.unregister(`explore:${this.sessionName ?? 'default'}:${siteId}`);
    }

    // 4. Remove from map (synchronous — atomic)
    this.contexts.delete(siteId);

    // 5. Close context (if not CDP — CDP contexts are managed externally)
    if (managed.harPath !== undefined) {
      try {
        await managed.context.close();
      } catch (err) {
        log.warn({ err, siteId }, 'Error closing browser context');
      }
    }

    log.info({ siteId }, 'Closed browser context');
  }

  /** Remove context without persisting storage state or publishing auth changes. */
  discardContext(siteId: string): void {
    if (this.authCoordinator) {
      this.authCoordinator.unregister(`explore:${this.sessionName ?? 'default'}:${siteId}`);
    }
    const managed = this.contexts.get(siteId);
    this.contexts.delete(siteId);
    if (managed) {
      managed.context.close().catch(() => {});
    }
  }

  /**
   * Close all contexts and the browser. Uses lifecycle lock.
   */
  async closeAll(): Promise<void> {
    return this.withLifecycleLock('closeAll', async () => {
      // Prevent reconnect from starting/continuing
      this.reconnectAborted = true;
      if (this.reconnectPromise) {
        await this.reconnectPromise;
      }

      // Clear idle timer and reset ops
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }
      this.inFlightOps = 0;
      this.suppressIdleTimeout = false;

      // Close each context with persistence
      const siteIds = [...this.contexts.keys()];
      for (const siteId of siteIds) {
        await this.closeContext(siteId);
      }

      // Null browser reference synchronously, then close/release detached ref
      const browser = this.browser;
      this.browser = null;
      if (this.releaseToPool) {
        if (this.disconnectHandler && browser) {
          browser.off('disconnected', this.disconnectHandler);
        }
        this.releaseToPool();
        this.releaseToPool = null;
        this.disconnectHandler = null;
      } else if (browser) {
        try {
          await browser.close();
        } catch (err) {
          log.warn({ err }, 'Error closing browser instance');
        }
      }

      // Reset CDP state
      this.cdpConnected = false;
      this.cdpOptions = null;
      this.cdpFailed = false;
      this.reconnecting = false;
      this.reconnectPromise = null;
      this.lastCdpSiteId = null;

      log.info('Closed all browser contexts and browser');
    });
  }

  // ─── CDP Connection ─────────────────────────────────────────────

  /**
   * Connect to an existing browser via CDP (e.g., Electron app).
   */
  async connectExisting(browser: Browser, siteId: string, cdpOptions: CdpConnectionOptions): Promise<void> {
    this.browser = browser;
    this.cdpConnected = true;
    this.cdpOptions = cdpOptions;
    this.cdpFailed = false;
    this.reconnectAborted = false;
    this.lastCdpSiteId = siteId;

    // Get existing context or create minimal one
    const existingContexts = browser.contexts();
    const context = existingContexts[0] ?? await browser.newContext();

    this.contexts.set(siteId, {
      context,
      siteId,
      harPath: undefined, // CDP: no HAR
      createdAt: Date.now(),
    });

    // Register disconnect handler for auto-reconnect
    browser.on('disconnected', () => {
      log.warn('CDP browser disconnected');
      this.browser = null;
      this.unregisterAllAuthParticipants();
      this.contexts.clear();
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }

      if (this.cdpOptions && !this.reconnectAborted) {
        this.attemptReconnect();
      }
    });

    log.info({ siteId, cdpConnected: true }, 'Connected to existing browser via CDP');
  }

  /**
   * Detach CDP session. For intentional disconnect (not crash recovery).
   */
  async detachCdp(): Promise<void> {
    return this.withLifecycleLock('detachCdp', async () => {
      this.reconnectAborted = true;
      if (this.reconnectPromise) {
        await this.reconnectPromise;
      }

      // Unregister auth participants before clearing context mappings
      this.unregisterAllAuthParticipants();
      // Clear local context mappings synchronously (no context.close for CDP)
      this.contexts.clear();
      const browser = this.browser;
      this.browser = null;

      // Disconnect CDP
      if (browser) {
        try {
          await browser.close();
        } catch { /* already disconnected */ }
      }

      // Reset CDP state
      this.cdpConnected = false;
      this.cdpOptions = null;
      this.cdpFailed = false;
      this.reconnecting = false;
      this.reconnectPromise = null;
      this.lastCdpSiteId = null;

      log.info('Detached CDP session');
    });
  }

  /**
   * Attempt auto-reconnect after CDP disconnect. Single-flight.
   */
  private attemptReconnect(): void {
    if (this.reconnectPromise) return; // already reconnecting

    this.reconnecting = true;
    const opts = this.cdpOptions!;

    this.reconnectPromise = (async () => {
      const MAX_RETRIES = 2;
      const BACKOFF_MS = 2000;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (this.reconnectAborted) {
          this.reconnecting = false;
          return;
        }

        if (attempt > 0) {
          await new Promise(r => setTimeout(r, BACKOFF_MS));
        }

        if (this.reconnectAborted) {
          this.reconnecting = false;
          return;
        }

        try {
          const { connectViaCDP } = await import('./cdp-connector.js');
          const newBrowser = await connectViaCDP(opts);

          if (this.reconnectAborted) {
            // Close the newly connected browser and bail
            try { await newBrowser.close(); } catch { /* */ }
            this.reconnecting = false;
            return;
          }

          // Restore the siteId from before disconnect
          const siteId = this.lastCdpSiteId ?? 'cdp-reconnected';
          await this.connectExisting(newBrowser, siteId, opts);
          this.reconnecting = false;
          log.info('CDP auto-reconnect succeeded');
          return;
        } catch (err) {
          log.warn({ attempt, err }, 'CDP reconnect attempt failed');
        }
      }

      // All retries exhausted
      this.reconnecting = false;
      this.cdpFailed = true;
      log.warn('CDP reconnect failed after all retries. Use schrute_connect_cdp to reconnect.');
    })();

    this.reconnectPromise.finally(() => {
      this.reconnectPromise = null;
    });
  }

  // ─── Accessors ──────────────────────────────────────────────────

  /**
   * Get the HAR path for a site's context.
   */
  getHarPath(siteId: string): string | undefined {
    return this.contexts.get(siteId)?.harPath ?? this.lastHarPaths.get(siteId);
  }

  /**
   * Check if a context exists for a site.
   */
  hasContext(siteId: string): boolean {
    return this.contexts.has(siteId);
  }

  /**
   * Return existing context for a site, or undefined if none exists.
   * Unlike getOrCreateContext(), this never launches a browser or creates a context.
   * Eliminates TOCTOU race between hasContext() + getOrCreateContext().
   */
  tryGetContext(siteId: string): BrowserContext | undefined {
    return this.contexts.get(siteId)?.context;
  }

  /**
   * Get the underlying browser instance (if launched).
   */
  getBrowser(): Browser | null {
    return this.browser;
  }

  /**
   * Get the engine capabilities (available after launch).
   */
  getCapabilities(): EngineCapabilities | null {
    return this.capabilities;
  }

  /**
   * Whether this browser supports HAR recording (launch-based, not CDP).
   */
  supportsHarRecording(): boolean {
    return !this.cdpConnected;
  }

  /**
   * Whether this manager is connected via CDP.
   */
  isCdpConnected(): boolean {
    return this.cdpConnected;
  }

  selectPage(siteId: string, pageUrl: string): void {
    const ctx = this.contexts.get(siteId);
    if (ctx) {
      ctx.selectedPageUrl = pageUrl;
      log.info({ siteId, pageUrl }, 'Selected page for site');
    }
  }

  rebindSiteId(oldId: string, newId: string): void {
    const ctx = this.contexts.get(oldId);
    if (ctx) {
      ctx.siteId = newId;
      this.contexts.set(newId, ctx);
      this.contexts.delete(oldId);
    }
    log.info({ oldId, newId }, 'Rebound CDP site ID');
  }

  /**
   * Import cookies from a Netscape cookie file into a browser context.
   */
  async importCookies(siteId: string, cookieFilePath: string): Promise<number> {
    const resolved = path.resolve(cookieFilePath);

    // Validate file exists and is a regular file
    let realPath: string;
    try {
      realPath = fs.realpathSync(resolved);
    } catch {
      throw new Error(`Cookie file not found: ${resolved}`);
    }

    const stat = fs.statSync(realPath);
    if (!stat.isFile()) {
      throw new Error(`Cookie path is not a file: ${realPath}`);
    }

    const { parseNetscapeCookieFile } = await import('./netscape-cookie-parser.js');
    const cookies = parseNetscapeCookieFile(realPath);

    if (cookies.length === 0) {
      return 0;
    }

    const context = await this.getOrCreateContext(siteId);

    // Convert Netscape format to Playwright cookie format
    const playwrightCookies = cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires === 0 ? -1 : c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: 'Lax' as const,
    }));

    await context.addCookies(playwrightCookies);

    // Snapshot imported cookies into auth store and publish change
    if (this.authStore) {
      const allCookies = await context.cookies();
      const { changed, version } = this.authStore.save(siteId, {
        cookies: allCookies.map(c => ({
          name: c.name, value: c.value, domain: c.domain, path: c.path,
          expires: c.expires, httpOnly: c.httpOnly, secure: c.secure,
          sameSite: c.sameSite,
        })),
        origins: [],
        lastUpdated: Date.now(),
      });
      if (changed && this.authCoordinator) {
        const originId = `explore:${this.sessionName ?? 'default'}:${siteId}`;
        const participant = this.authCoordinator.getParticipant(originId);
        if (participant) participant.lastSeenAuthVersion = version;
        this.authCoordinator.publish({ siteId, version, originId, reason: 'cookie_import' })
          .catch(err => log.debug({ err, siteId }, 'Auth publish on cookie import failed'));
      }
    }

    log.info({ siteId, count: playwrightCookies.length }, 'Imported cookies');
    return playwrightCookies.length;
  }
}
