import type { Page, Request, Response as PwResponse, Dialog, FileChooser, Frame, Locator } from 'playwright';
import type {
  BrowserProvider,
  PageSnapshot,
  NetworkEntry,
  SealedFetchRequest,
  SealedFetchResponse,
  SealedModelContextRequest,
  SealedModelContextResponse,
  SnapshotEvent,
} from '../skill/types.js';
import {
  ALLOWED_BROWSER_TOOLS,
  BLOCKED_BROWSER_TOOLS,
} from '../skill/types.js';
import type { BrowserFeatureFlags } from './feature-flags.js';
import { DEFAULT_FLAGS } from './feature-flags.js';
import type { BrowserBenchmark } from './benchmark.js';
import type { EngineCapabilities } from './engine.js';
import type { AnnotatedSnapshot, SnapshotOptions, RefState, RefEntry, FrameSnapshot, SnapshotNode } from './snapshot-refs.js';
import {
  parseYamlToTree,
  annotateSnapshot,
  createRefState,
  diffTrees,
  renderDiff,
  resolveRef,
  buildCssFallback,
  cssEscapeAttr,
  jaccardSimilarity,
  filterTree,
  StaleRefError,
  STATIC_RESOURCE_TYPES,
} from './snapshot-refs.js';
import {
  ModalStateTracker,
  MODAL_CLEARING_TOOLS,
  raceAgainstModals,
} from './modal-state.js';
import { resizeScreenshotBuffer, estimateScale, DEFAULT_MAX_DIMENSION, DEFAULT_MAX_PIXELS } from './screenshot-resize.js';
import { humanMousePreamble } from './human-input.js';
import { isObviousNoise, shouldCaptureResponseBody } from '../capture/noise-filter.js';
import { getLogger } from '../core/logger.js';

const log = getLogger();

// Cloudflare page title patterns — used for both challenge detection and snapshot warnings
const CF_CHALLENGE_TITLE_RE = /^Just a moment\b|Attention Required!.*Cloudflare|Verify you are human/i;
const CF_PHISHING_TITLE_RE = /Suspected phishing|phishing site.*Cloudflare/i;

// Browser-context globals used in page.evaluate/waitForFunction callbacks.
// These run in the browser, not Node — declared here to satisfy TypeScript.
declare const document: { querySelector(sel: string): unknown; title: string };

/**
 * Detect whether the current page is showing a Cloudflare challenge or interstitial.
 */
export async function isCloudflareChallengePage(page: Page): Promise<boolean> {
  const indicators = [
    '#challenge-running',
    '#challenge-spinner',
    '#cf-please-wait',
    '#turnstile-wrapper',
    '#cf-challenge-running',
  ];

  let challengeElements: boolean;
  let title: string;
  try {
    [challengeElements, title] = await Promise.all([
      page.evaluate((selectors: string[]) => {
        return selectors.some(sel => document.querySelector(sel) !== null);
      }, indicators),
      page.title(),
    ]);
  } catch {
    // Page context destroyed or closed — safe to return false
    return false;
  }

  return challengeElements || CF_CHALLENGE_TITLE_RE.test(title) || CF_PHISHING_TITLE_RE.test(title);
}

/**
 * Detect Cloudflare challenge pages (JS challenges, Turnstile, interstitials)
 * and wait for them to resolve. Returns true if a challenge was detected.
 */
export async function detectAndWaitForChallenge(page: Page, timeoutMs = 15000): Promise<boolean> {
  const indicators = [
    '#challenge-running',
    '#challenge-spinner',
    '#cf-please-wait',
    '#turnstile-wrapper',
    '#cf-challenge-running',
  ];

  let challengeElements: boolean;
  let title: string;
  try {
    [challengeElements, title] = await Promise.all([
      page.evaluate((selectors: string[]) => {
        return selectors.some(sel => document.querySelector(sel) !== null);
      }, indicators),
      page.title(),
    ]);
  } catch {
    // Page context destroyed or closed — safe to return false
    return false;
  }

  // Cloudflare phishing/safety interstitial — auto-dismiss "Ignore & Proceed"
  const isPhishingWarning = CF_PHISHING_TITLE_RE.test(title);
  if (isPhishingWarning) {
    log.info('Cloudflare phishing interstitial detected, attempting auto-dismiss...');
    const dismissed = await dismissCloudflareInterstitial(page, timeoutMs);
    if (dismissed) {
      log.info('Cloudflare phishing interstitial dismissed');
      return true;
    }
    log.warn('Could not auto-dismiss Cloudflare phishing interstitial — Turnstile challenge likely failed. Try importing cf_clearance cookies or switching to camoufox/patchright engine.');
    return false;
  }

  const titleMatch = CF_CHALLENGE_TITLE_RE.test(title);

  if (!challengeElements && !titleMatch) return false;

  log.info('Cloudflare challenge detected, waiting for resolution...');
  const deadline = Date.now() + timeoutMs;
  try {
    await page.waitForFunction(
      (ctx: { selectors: string[]; origTitle: string; hadSelectors: boolean }) => {
        const noSelectors = !ctx.selectors.some(sel => document.querySelector(sel));
        if (ctx.hadSelectors) {
          return noSelectors;
        }
        return document.title !== ctx.origTitle;
      },
      { selectors: indicators, origTitle: title, hadSelectors: challengeElements },
      { timeout: timeoutMs },
    );
    const remaining = deadline - Date.now();
    if (remaining > 500) {
      await page.waitForLoadState('domcontentloaded', { timeout: remaining });
    }
    log.info('Cloudflare challenge resolved');
    return true;
  } catch {
    log.warn('Cloudflare challenge did not resolve within timeout');
    return false;
  }
}

/**
 * Dismiss Cloudflare safety/phishing interstitial pages.
 *
 * These pages have a form posting to `/cdn-cgi/phish-bypass` with a Turnstile
 * challenge. The "Ignore & Proceed" button (`#bypass-button`) starts disabled
 * and becomes enabled once Turnstile solves. We wait for that, then submit.
 * If Turnstile never solves, we attempt a force-bypass as a last resort.
 */
async function dismissCloudflareInterstitial(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  // Strategy 1: Wait for #bypass-button to become enabled (Turnstile solved)
  try {
    const btn = page.locator('#bypass-button');
    if (await btn.count() > 0) {
      // Wait up to 70% of timeout for Turnstile to enable the button
      const waitMs = Math.min(Math.floor(timeoutMs * 0.7), 20_000);
      try {
        await btn.waitFor({ state: 'attached', timeout: 2000 });
        // Poll for enabled state
        // waitMs is always a safe integer derived from Math.min(Math.floor(...), 20_000)
        const enabled = await page.evaluate(`
          new Promise(resolve => {
            var el = document.getElementById('bypass-button');
            if (!el) return resolve(false);
            if (!el.disabled) return resolve(true);
            var obs = new MutationObserver(function() {
              if (!el.disabled) { obs.disconnect(); resolve(true); }
            });
            obs.observe(el, { attributes: true, attributeFilter: ['disabled'] });
            setTimeout(function() { obs.disconnect(); resolve(false); }, ${waitMs});
          })
        `);
        if (enabled) {
          log.info('Turnstile solved — bypass button enabled, clicking');
          await btn.click({ timeout: 5000 });
          await page.waitForLoadState('domcontentloaded', { timeout: deadline - Date.now() });
          return true;
        }
      } catch (err) {
        log.debug({ err }, 'CF bypass: turnstile button wait/click failed');
      }

      // Strategy 2: Force-enable button and submit form (Turnstile may not
      // have solved, but some CF configurations don't validate the token)
      log.info('Turnstile did not solve — attempting force-bypass');
      try {
        const navigated = await page.evaluate(`
          (() => {
            const btn = document.getElementById('bypass-button');
            if (!btn) return false;
            btn.disabled = false;
            btn.removeAttribute('disabled');
            const form = btn.closest('form');
            if (form) { form.submit(); return true; }
            btn.click();
            return true;
          })()
        `);
        if (navigated) {
          try {
            await page.waitForLoadState('domcontentloaded', { timeout: Math.max(deadline - Date.now(), 3000) });
          } catch (err) { log.debug({ err }, 'CF bypass: waitForLoadState after force-bypass failed'); }
          // Verify we reached the target site, not a CF error page
          const newUrl = page.url();
          const newTitle = await page.title().catch((err: unknown) => { log.debug({ err }, 'page.title() failed'); return ''; });
          const isBypassError = /\/cdn-cgi\/phish-bypass/i.test(newUrl);
          if (!isBypassError && !/phishing/i.test(newTitle) && newTitle.length > 0) return true;
          // Go back if we ended up on the bypass error page
          if (isBypassError) {
            try { await page.goBack({ timeout: 5000 }); } catch (err) { log.debug({ err }, 'CF bypass: goBack after phishing page failed'); }
          }
        }
      } catch (err) {
        log.debug({ err }, 'CF bypass: force-enable button strategy failed');
      }
    }
  } catch (err) {
    log.debug({ err }, 'CF bypass: #bypass-button approach failed entirely');
  }

  // Strategy 3: Generic fallback — try clicking any visible proceed-like button
  const fallbackSelectors = [
    'button:has-text("Proceed")',
    'a:has-text("Proceed")',
    'button:has-text("Continue")',
    'a:has-text("Continue")',
  ];
  for (const selector of fallbackSelectors) {
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 1000 })) {
        await el.click({ timeout: 3000 });
        await page.waitForLoadState('domcontentloaded', { timeout: Math.max(deadline - Date.now(), 3000) });
        const newUrl = page.url();
        const newTitle = await page.title().catch((err: unknown) => { log.debug({ err }, 'page.title() failed'); return ''; });
        if (!/cdn-cgi/i.test(newUrl) && !/phishing/i.test(newTitle) && newTitle.length > 0) return true;
      }
    } catch (err) {
      log.debug({ err, selector }, 'CF bypass: fallback selector failed');
    }
  }

  return false;
}

type AllowedTool = (typeof ALLOWED_BROWSER_TOOLS)[number];

const MAX_RECENT_EVENTS = 20;

/**
 * Abstract base class for browser adapters implementing BrowserProvider.
 *
 * Contains all shared logic for the proxyTool dispatch, tool allowlist gate,
 * sealed fetch, network capture, @ref snapshot system, modal tracking,
 * screenshot resize, batch actions, and common tool implementations.
 *
 * SECURITY:
 * - Only tools from ALLOWED_BROWSER_TOOLS are reachable.
 * - browser_evaluate, browser_run_code, browser_install are BLOCKED.
 * - evaluateFetch() is a sealed wrapper: generates a fetch snippet internally,
 *   validates domain against allowlist, and executes via page.evaluate().
 *   Raw evaluate is NEVER exposed to calling agents.
 */
export abstract class BaseBrowserAdapter implements BrowserProvider {
  protected page: Page;
  protected domainAllowlist: string[];
  protected static readonly MAX_NETWORK_ENTRIES = 500;
  protected networkEntries: NetworkEntry[] = [];
  protected flags: BrowserFeatureFlags;
  protected benchmark: BrowserBenchmark | null;
  protected capabilities: EngineCapabilities | null;
  private _consoleUnavailableNotified = false;

  // @ref system state
  private refState: RefState;
  private currentSnapshot: AnnotatedSnapshot | null = null;
  private snapshotStale = false;
  private navEpoch = 0;

  // Modal state tracking
  protected modalTracker: ModalStateTracker;

  // Recent events (console + downloads) since last snapshot
  private recentEvents: SnapshotEvent[] = [];

  // Default timeout tracking (Playwright doesn't expose getDefaultTimeout)
  private _currentDefaultTimeout = 30_000;

  // Frame map for locator resolution (framePath → Frame)
  private frameMap = new Map<string, Frame>();

  // Persistent console log buffer
  private consoleLog: Array<{ level: string; text: string; timestamp: number }> = [];
  private static readonly MAX_CONSOLE_LOG = 100;

  // Configurable handler timeout (applied to individual Playwright actions)
  protected handlerTimeoutMs: number;

  constructor(
    page: Page,
    domainAllowlist: string[],
    options?: {
      flags?: BrowserFeatureFlags;
      benchmark?: BrowserBenchmark;
      capabilities?: EngineCapabilities;
      handlerTimeoutMs?: number;
    },
  ) {
    this.page = page;
    // Reject wildcard .domain entries — require exact domain or explicit subdomain
    for (const domain of domainAllowlist) {
      if (domain.startsWith('.')) {
        throw new Error(
          `Invalid domain allowlist entry "${domain}": wildcard entries starting ` +
          `with "." are not allowed. Use the exact domain (e.g., "${domain.slice(1)}") ` +
          `or list subdomains explicitly.`,
        );
      }
    }
    this.domainAllowlist = domainAllowlist;
    this.flags = options?.flags ?? DEFAULT_FLAGS;
    this.benchmark = options?.benchmark ?? null;
    this.capabilities = options?.capabilities ?? null;
    this.handlerTimeoutMs = options?.handlerTimeoutMs ?? 30_000;
    this.refState = createRefState();
    this.modalTracker = new ModalStateTracker();

    // Network capture is set up in constructor — ensures listener is active before first navigation
    this.setupNetworkCapture();
    this.setupRecentEventListeners();

    if (this.flags.modalTracking) {
      this.setupModalListeners();
    }

    // Reset refs on main-frame navigation (preserve hashToRef for stale ref recovery)
    this.page.on('framenavigated', (frame: Frame) => {
      const isMain = frame === this.page.mainFrame();
      if (isMain) log.debug({ url: frame.url(), navEpoch: this.navEpoch }, 'framenavigated: main frame');
      if (isMain) {
        this.refState = createRefState(this.pruneHashToRef());
        this.snapshotStale = true;
        this.navEpoch++;
      }
      // Clear dialog modals on any navigation
      if (this.flags.modalTracking) {
        this.modalTracker.clearOnNavigation();
      }
    });
  }

  // ─── Timeout Management ─────────────────────────────────────────

  private setPageTimeout(ms: number): void {
    this._currentDefaultTimeout = ms;
    this.page.setDefaultTimeout(ms);
  }

  // ─── Tool Allowlist Gate ───────────────────────────────────────────

  private assertAllowed(toolName: string): asserts toolName is AllowedTool {
    if ((BLOCKED_BROWSER_TOOLS as readonly string[]).includes(toolName)) {
      throw new Error(
        `BLOCKED: Tool "${toolName}" is explicitly blocked for security. ` +
        `Blocked tools: ${BLOCKED_BROWSER_TOOLS.join(', ')}`,
      );
    }
    if (!(ALLOWED_BROWSER_TOOLS as readonly string[]).includes(toolName)) {
      throw new Error(
        `DENIED: Tool "${toolName}" is not on the allowed browser tools list.`,
      );
    }
  }

  // ─── Modal Gate ───────────────────────────────────────────────────

  private assertModalState(toolName: string): void {
    if (!this.flags.modalTracking) return;

    this.modalTracker.pruneExpired();
    const clearsModal = MODAL_CLEARING_TOOLS[toolName];
    const activeModals = this.modalTracker.getActive();

    if (clearsModal && !activeModals.some(m => m.type === clearsModal)) {
      throw new Error(
        `Tool "${toolName}" can only be used when a ${clearsModal} is present`,
      );
    }
    if (!clearsModal && activeModals.length > 0) {
      throw new Error(
        `Tool "${toolName}" cannot run while modal is active. Handle it with: ` +
        activeModals.map(m => m.clearedBy).join(', '),
      );
    }
  }

  // ─── Modal-Racing Wrapper ────────────────────────────────────────

  /**
   * Wrap an action with modal-race logic. If modal tracking is enabled,
   * races the action against modal appearance; otherwise runs directly.
   */
  private async withModalRace(actionFn: () => Promise<void>): Promise<{ success: boolean; modalInterrupt?: boolean; modals?: string[] }> {
    if (this.flags.modalTracking) {
      const result = await raceAgainstModals(this.modalTracker, async () => {
        await this.waitForCompletion(actionFn);
        return { success: true };
      });
      if (Array.isArray(result)) {
        return { success: false, modalInterrupt: true, modals: result.map(m => m.description) };
      }
      return result;
    }
    await this.waitForCompletion(actionFn);
    return { success: true };
  }

  // ─── Post-Action Stabilization ─────────────────────────────────

  private async waitForCompletion(callback: () => Promise<void>): Promise<void> {
    const requests: Request[] = [];
    const listener = (req: Request) => requests.push(req);
    this.page.on('request', listener);

    try {
      await callback();
      await new Promise(f => setTimeout(f, 500));
    } finally {
      this.page.off('request', listener);
    }

    if (requests.some(r => r.isNavigationRequest())) {
      await this.page.mainFrame().waitForLoadState('load', { timeout: 10_000 }).catch((err) => log.debug({ err }, 'waitForLoadState failed'));
      return;
    }

    const promises: Promise<void>[] = [];
    for (const req of requests) {
      const rt = req.resourceType();
      if (['document', 'stylesheet', 'script', 'xhr', 'fetch'].includes(rt)) {
        promises.push(
          req.response().then(r => r?.finished()).catch((err) => log.debug({ err }, 'Response waiting failed')) as Promise<void>,
        );
      } else {
        promises.push(req.response().catch((err) => log.debug({ err }, 'Response waiting failed')) as Promise<void>);
      }
    }
    await Promise.race([Promise.all(promises), new Promise(f => setTimeout(f, 5_000))]);
    if (requests.length) await new Promise(f => setTimeout(f, 500));
  }

  // ─── Per-Frame Snapshot Collection ──────────────────────────────

  /**
   * Build frame path with priority: name > url > sibling index.
   * Used to create stable frame identifiers for multi-frame ref system.
   */
  private buildFramePath(frame: Frame): string {
    const parts: string[] = [];
    let current: Frame | null = frame;
    while (current && current.parentFrame()) {
      const parent: Frame = current.parentFrame()!;
      const siblings = parent.childFrames();
      const idx = siblings.indexOf(current);

      const name = current.name();
      let url: string | undefined;
      try { url = current.url(); } catch (err) { log.debug({ err }, 'Detached frame URL access failed'); }

      let segment: string;
      if (name) {
        segment = `name:${name}`;
      } else if (url && url !== 'about:blank') {
        try {
          const parsed = new URL(url);
          segment = `url:${parsed.hostname}${parsed.pathname}`;
        } catch {
          segment = `iframe[${idx}]`;
        }
      } else {
        segment = `iframe[${idx}]`;
      }

      // Sibling disambiguation — append index if another sibling has the same segment
      const currentRef = current;
      const siblingSegments = siblings
        .filter(s => s !== currentRef)
        .map(s => {
          const sName = s.name();
          if (sName) return `name:${sName}`;
          try {
            const sUrl = s.url();
            if (sUrl && sUrl !== 'about:blank') {
              const p = new URL(sUrl);
              return `url:${p.hostname}${p.pathname}`;
            }
          } catch (err) { log.debug({ err }, 'Detached sibling frame URL access failed'); }
          return `iframe[${siblings.indexOf(s)}]`;
        });
      if (siblingSegments.includes(segment)) {
        segment = `${segment}[${idx}]`;
      }

      parts.unshift(segment);
      current = parent;
    }
    return ['main', ...parts].join('>');
  }

  /**
   * Collect accessibility tree snapshots from all frames (main + iframes).
   * Each iframe gets a 3s timeout; failures produce a placeholder with error metadata.
   */
  private async collectFrameSnapshots(selector?: string): Promise<Array<FrameSnapshot & { frame: Frame }>> {
    const results: Array<FrameSnapshot & { frame: Frame }> = [];

    // Main frame
    let mainYaml = '';
    try {
      const locator = selector ? this.page.locator(selector) : this.page.locator('body');
      mainYaml = await locator.ariaSnapshot({ timeout: this.handlerTimeoutMs });
    } catch (err) {
      log.debug({ err }, 'ariaSnapshot failed, falling back to innerText');
      try {
        mainYaml = await this.page.locator('body').innerText();
      } catch (textErr) {
        log.debug({ textErr }, 'Failed to extract main frame content');
        mainYaml = '';
      }
    }
    results.push({ framePath: 'main', yaml: mainYaml, frame: this.page.mainFrame() });

    // Child frames — 3s timeout each
    for (const frame of this.page.frames()) {
      if (frame === this.page.mainFrame()) continue;
      const framePath = this.buildFramePath(frame);
      try {
        const yaml = await frame.locator('body').ariaSnapshot({ timeout: 3000 });
        results.push({ framePath, yaml, frame });
      } catch (err) {
        log.debug({ err, framePath }, 'Failed to capture iframe snapshot');
        results.push({
          framePath,
          yaml: '',
          frame,
          error: err instanceof Error ? err.message : 'timeout',
          timedOut: true,
        });
      }
    }

    return results;
  }

  // ─── Locator Building ─────────────────────────────────────────────

  private async buildLocator(entry: RefEntry) {
    const frame = this.frameMap.get(entry.framePath);
    if (!frame) {
      throw new StaleRefError(entry.ref, this.currentSnapshot?.version);
    }

    const strategy = entry.locatorStrategy;

    // 1. Try scopedRole
    if (strategy.method === 'scopedRole' && strategy.scopeChain && strategy.scopeChain.length > 0) {
      let loc = frame.getByRole(
        strategy.scopeChain[0].role as any,
        strategy.scopeChain[0].name ? { name: strategy.scopeChain[0].name, exact: false } : undefined,
      );
      for (let i = 1; i < strategy.scopeChain.length; i++) {
        const s = strategy.scopeChain[i];
        loc = loc.getByRole(s.role as any, s.name ? { name: s.name, exact: false } : undefined);
      }
      loc = loc.getByRole(strategy.role as any, { name: strategy.name, exact: false });
      if (strategy.nth !== undefined) loc = loc.nth(strategy.nth);

      const count = await loc.count();
      if (count > 0) return loc;
    }

    // 2. Try globalRole
    if (strategy.role && strategy.name !== undefined) {
      let loc = frame.getByRole(strategy.role as any, { name: strategy.name, exact: false });
      if (strategy.nth !== undefined) loc = loc.nth(strategy.nth);

      const count = await loc.count();
      if (count > 0) return loc;
    }

    // 3. CSS fallback
    const cssLoc = frame.locator(strategy.selector ?? buildCssFallback(entry)).first();
    const count = await cssLoc.count();
    if (count > 0) return cssLoc;

    throw new StaleRefError(entry.ref, this.currentSnapshot?.version);
  }

  /**
   * Prune hashToRef map to prevent unbounded growth.
   * Tier 1: Keep only visible refs if full-page snapshot available.
   * Tier 2: LRU eviction (keep last 5000 by Map insertion order).
   */
  private pruneHashToRef(): Map<string, string> {
    const map = this.refState.hashToRef;
    if (map.size <= 5000) return new Map(map);

    // Tier 1: If full-page snapshot available (not filtered/partial), keep only visible refs
    if (this.currentSnapshot && !this.currentSnapshot.wasFiltered) {
      const visibleRefs = new Set(this.currentSnapshot.refs.keys());
      const pruned = new Map<string, string>();
      for (const [hash, ref] of map) {
        if (visibleRefs.has(ref)) pruned.set(hash, ref);
      }
      if (pruned.size > 5000) {
        const entries = [...pruned.entries()];
        return new Map(entries.slice(entries.length - 5000));
      }
      return pruned;
    }

    // Tier 2: No reliable snapshot — LRU eviction (keep last 5000 by Map insertion order)
    const entries = [...map.entries()];
    return new Map(entries.slice(entries.length - 5000));
  }

  /**
   * Resolve a ref string to a Playwright locator.
   * @ref refs use the ref system; legacy refs fall back to data-ref/aria-label.
   *
   * Always attempts resolution from current snapshot first.
   * When stale, verifies identity via fresh snapshot before returning.
   */
  private async resolveRefToLocator(ref: string) {
    if (ref.startsWith('@e')) {
      // Branch on stale BEFORE buildLocator — stale frame map can throw before recovery
      if (this.snapshotStale) {
        return this.resolveStaleRef(ref);
      }

      // Happy path: not stale, resolve and build directly
      const entry = resolveRef(ref, this.currentSnapshot ?? undefined);
      const locator = await this.buildLocator(entry);
      this.benchmark?.recordStaleRef(true);
      return locator;
    }
    // Legacy fallback
    return this.page.locator(
      `[data-ref="${cssEscapeAttr(ref)}"], [aria-label="${cssEscapeAttr(ref)}"]`,
    ).first();
  }

  /**
   * Resolve a ref when snapshot is stale.
   * Takes a fresh snapshot first, then validates identity from old → new,
   * and builds locator from the NEW snapshot/frame map only.
   */
  private async resolveStaleRef(ref: string) {
    // Grab old entry for identity verification (may be undefined if snapshot was nulled)
    const oldSnapshot = this.currentSnapshot;
    const oldEntry = oldSnapshot?.refs.get(ref);

    // A navigation can occur while snapshot is being collected (common on pages
    // still settling after initial load). Retry a few times before failing closed.
    const MAX_RECOVERY_ATTEMPTS = 3;
    let lastVersion = this.currentSnapshot?.version ?? 0;

    for (let attempt = 1; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
      await this.snapshot();
      const newSnapshot = this.currentSnapshot;

      if (!newSnapshot) {
        throw new StaleRefError(ref, 0);
      }
      lastVersion = newSnapshot.version;

      // Epoch captured AFTER snapshot: allows nav during snapshot collection,
      // but still detects nav races during verification/action handoff.
      const verifyEpoch = this.navEpoch;

      // Filtered snapshots can't be trusted for identity verification
      if (newSnapshot.wasFiltered) {
        throw new StaleRefError(ref, newSnapshot.version);
      }

      const newEntry = newSnapshot.refs.get(ref);
      if (!newEntry) {
        throw new StaleRefError(ref, newSnapshot.version);
      }

      // If old snapshot was filtered, we can't trust old hash counts — fail closed
      if (oldSnapshot?.wasFiltered) {
        throw new StaleRefError(ref, newSnapshot.version);
      }

      // If we had an old entry, verify identity continuity
      if (oldEntry) {
        const oldHash = oldEntry.identityHash;
        const newHash = newEntry.identityHash;

        if (!oldHash || !newHash || oldHash !== newHash) {
          throw new StaleRefError(ref, newSnapshot.version);
        }

        // Check ordinal stability for ambiguous (duplicate) elements
        if (oldSnapshot?.identityHashCounts && newSnapshot.identityHashCounts) {
          const oldCount = oldSnapshot.identityHashCounts.get(oldHash) ?? 0;
          const newCount = newSnapshot.identityHashCounts.get(newHash) ?? 0;

          if (oldCount !== newCount) {
            // Element population changed — ordinals may have shifted
            throw new StaleRefError(ref, newSnapshot.version);
          }

          if (oldCount > 1 && oldEntry.ordinal !== newEntry.ordinal) {
            throw new StaleRefError(ref, newSnapshot.version);
          }
        }
      }
      // If no old entry (snapshot was nulled), we trust the fresh snapshot —
      // the ref exists in the new snapshot with a valid frame map.

      // Build locator from NEW entry + NEW frame map
      const locator = await this.buildLocator(newEntry);
      const count = await locator.count();
      if (count !== 1) {
        throw new StaleRefError(ref, newSnapshot.version);
      }

      // Final nav guard: if nav raced during verification, retry (bounded)
      if (this.navEpoch !== verifyEpoch) {
        if (attempt < MAX_RECOVERY_ATTEMPTS) {
          continue;
        }
        throw new StaleRefError(ref, newSnapshot.version);
      }

      this.benchmark?.recordStaleRef(true);
      return locator;
    }

    throw new StaleRefError(ref, lastVersion);
  }

  /**
   * Resolve a ref and execute an action, guarding against navigation between resolve and action.
   */
  private async withRefLocator<T>(ref: string, action: (locator: Locator) => Promise<T>): Promise<T> {
    const epochBefore = this.navEpoch;
    const locator = await this.resolveRefToLocator(ref);
    if (this.navEpoch !== epochBefore) {
      // Epoch changes are expected during stale-recovery snapshot refresh.
      // Only fail if the page is still marked stale after resolution.
      if (this.snapshotStale) {
        throw new StaleRefError(ref, this.currentSnapshot?.version ?? 0);
      }
    }
    return action(locator);
  }

  /**
   * Proxy a tool call through the allowlist gate with runtime arg validation.
   */
  async proxyTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertAllowed(toolName);

    // Modal gate (skip for batch — batch handles its own gating per-action)
    if (toolName !== 'browser_batch_actions') {
      this.assertModalState(toolName);
    }

    const actionStart = Date.now();
    let success = true;

    try {
      const result = await this.dispatchTool(toolName, args);
      return result;
    } catch (err) {
      success = false;
      if (err instanceof StaleRefError) {
        this.benchmark?.recordStaleRef(false);
      }
      throw err;
    } finally {
      // Benchmark recording for action tools
      if (toolName !== 'browser_snapshot' && toolName !== 'browser_batch_actions') {
        this.benchmark?.recordAction(toolName, Date.now() - actionStart, success);
      }
    }
  }

  private async dispatchTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    switch (toolName) {
      case 'browser_navigate':
        if (typeof args.url !== 'string') throw new Error('Expected url to be a string');
        await this.navigate(args.url, { timeout: this.handlerTimeoutMs });
        return { success: true };
      case 'browser_navigate_back':
        return this.withModalRace(async () => { await this.page.goBack(); });
      case 'browser_snapshot': {
        const options: SnapshotOptions = {};
        if (typeof args.selector === 'string') options.selector = args.selector;
        if (typeof args.interactiveOnly === 'boolean') options.interactiveOnly = args.interactiveOnly;
        if (typeof args.maxDepth === 'number') options.maxDepth = args.maxDepth;
        if (typeof args.compact === 'boolean') options.compact = args.compact;
        if (typeof args.maxChars === 'number') options.maxChars = args.maxChars;
        if (typeof args.offset === 'number') options.offset = args.offset;
        return this.snapshot(Object.keys(options).length > 0 ? options : undefined);
      }
      case 'browser_snapshot_with_screenshot': {
        const options: SnapshotOptions = {};
        if (typeof args.selector === 'string') options.selector = args.selector;
        if (typeof args.interactiveOnly === 'boolean') options.interactiveOnly = args.interactiveOnly;
        return this.snapshotWithScreenshot(options);
      }
      case 'browser_debug_trace':
        return this.debugTrace();
      case 'browser_click': {
        if (typeof args.ref !== 'string') throw new Error('Expected ref to be a string');
        return this.withRefLocator(args.ref, (loc) =>
          this.withModalRace(async () => {
            if (this.flags.humanCursor) {
              const bbox = await loc.boundingBox();
              if (bbox) {
                const cx = bbox.x + bbox.width / 2;
                const cy = bbox.y + bbox.height / 2;
                await humanMousePreamble(this.page, cx, cy);
              }
            }
            await loc.click({ timeout: this.handlerTimeoutMs });
          }));
      }
      case 'browser_type': {
        if (typeof args.ref !== 'string') throw new Error('Expected ref to be a string');
        if (typeof args.text !== 'string') throw new Error('Expected text to be a string');
        return this.withRefLocator(args.ref, (loc) =>
          this.withModalRace(async () => { await loc.fill(args.text as string, { timeout: this.handlerTimeoutMs }); }));
      }
      case 'browser_take_screenshot': {
        const rawFormat = args?.format as string | undefined;
        const format = rawFormat ? (['jpeg', 'png'].includes(rawFormat) ? rawFormat as 'jpeg' | 'png' : undefined) : undefined;
        if (rawFormat && !format) throw new Error(`Invalid format '${rawFormat}'. Must be 'jpeg' or 'png'.`);

        let quality: number | undefined;
        const rawQuality = args?.quality;
        if (rawQuality !== undefined && rawQuality !== null) {
          const parsed = typeof rawQuality === 'number' ? rawQuality : Number(rawQuality);
          if (!Number.isFinite(parsed)) {
            throw new Error(`Invalid quality '${rawQuality}'. Must be a number 1-100.`);
          }
          if ((format ?? this.flags.screenshotFormat) === 'png') {
            quality = undefined;
          } else {
            quality = Math.max(1, Math.min(100, Math.round(parsed)));
          }
        }

        if (args?.ref && typeof args.ref === 'string') {
          const { buffer } = await this.withRefLocator(args.ref, async (locator) => {
            return this.captureScreenshot({ format, quality, locator });
          });
          return buffer;
        }
        const { buffer } = await this.captureScreenshot({ format, quality });
        return buffer;
      }
      case 'browser_network_requests':
        return this.networkRequests(args.includeStatic as boolean | undefined);
      case 'browser_hover': {
        if (typeof args.ref !== 'string') throw new Error('Expected ref to be a string');
        return this.withRefLocator(args.ref, (loc) =>
          this.withModalRace(async () => {
            if (this.flags.humanCursor) {
              const bbox = await loc.boundingBox();
              if (bbox) {
                const cx = bbox.x + bbox.width / 2;
                const cy = bbox.y + bbox.height / 2;
                await humanMousePreamble(this.page, cx, cy);
              }
            }
            await loc.hover({ timeout: this.handlerTimeoutMs });
          }));
      }
      case 'browser_drag': {
        if (typeof args.startRef !== 'string') throw new Error('Expected startRef to be a string');
        if (typeof args.endRef !== 'string') throw new Error('Expected endRef to be a string');
        const dragEpoch = this.navEpoch;
        const startLoc = await this.resolveRefToLocator(args.startRef);
        const endLoc = await this.resolveRefToLocator(args.endRef);
        if (this.navEpoch !== dragEpoch) {
          throw new StaleRefError(args.startRef, this.currentSnapshot?.version ?? 0);
        }
        return this.withModalRace(async () => {
          // Final epoch check right before action — closes the resolve→action gap
          if (this.navEpoch !== dragEpoch) {
            throw new StaleRefError(args.startRef as string, this.currentSnapshot?.version ?? 0);
          }
          await startLoc.dragTo(endLoc, { timeout: this.handlerTimeoutMs });
        });
      }
      case 'browser_press_key':
        if (typeof args.key !== 'string') throw new Error('Expected key to be a string');
        return this.withModalRace(async () => { await this.page.keyboard.press(args.key as string); });
      case 'browser_select_option': {
        if (typeof args.ref !== 'string') throw new Error('Expected ref to be a string');
        if (typeof args.value !== 'string') throw new Error('Expected value to be a string');
        return this.withRefLocator(args.ref, (loc) =>
          this.withModalRace(async () => { await loc.selectOption(args.value as string, { timeout: this.handlerTimeoutMs }); }));
      }
      case 'browser_fill_form': {
        const values = args.values;
        if (typeof values !== 'object' || values === null || Array.isArray(values)) {
          throw new Error(
            'browser_fill_form expects { values: { "<label|name|@ref>": "value", ... } }. ' +
            'Keys can be field labels, input name attributes, or @e refs from browser_snapshot. ' +
            'For single-field input, use browser_type instead.'
          );
        }
        await this.fillForm(values as Record<string, string>);
        return { success: true };
      }
      case 'browser_file_upload': {
        if (typeof args.ref !== 'string') throw new Error('Expected ref to be a string');
        if (!Array.isArray(args.paths)) throw new Error('Expected paths to be an array');
        return this.withRefLocator(args.ref, async (loc) => {
          await loc.setInputFiles(args.paths as string[], { timeout: this.handlerTimeoutMs });
          // Clear fileChooser modal state
          if (this.flags.modalTracking) {
            this.modalTracker.markHandled('fileChooser');
            this.modalTracker.clear('fileChooser');
          }
          return { success: true };
        });
      }
      case 'browser_handle_dialog': {
        if (this.flags.modalTracking) {
          const activeDialogs = this.modalTracker.getActive().filter(m => m.type === 'dialog');
          if (activeDialogs.length === 0) {
            throw new Error('No active dialog to handle');
          }
          const dialog = activeDialogs[0].data as Dialog;
          const accept = args.accept !== false;
          if (accept) {
            await dialog.accept(typeof args.promptText === 'string' ? args.promptText : undefined);
          } else {
            await dialog.dismiss();
          }
          this.modalTracker.markHandled('dialog');
          this.modalTracker.clear('dialog');
          return { success: true };
        }
        return { success: true, note: 'Dialogs are auto-handled (modal tracking disabled)' };
      }
      case 'browser_tabs':
        return this.page.context().pages().map((p, i) => ({
          index: i,
          url: p.url(),
          title: '',
        }));
      case 'browser_wait_for': {
        if (typeof args.selector !== 'string') throw new Error('Expected selector to be a string');
        const timeout = args.timeout;
        if (timeout !== undefined && typeof timeout !== 'number') {
          throw new Error('Expected timeout to be a number');
        }
        await this.page.waitForSelector(
          args.selector,
          { timeout: (timeout as number) ?? 30000 },
        );
        return { success: true };
      }
      case 'browser_close':
        await this.page.close();
        return { success: true };
      case 'browser_resize': {
        if (typeof args.width !== 'number') throw new Error('Expected width to be a number');
        if (typeof args.height !== 'number') throw new Error('Expected height to be a number');
        await this.page.setViewportSize({
          width: args.width,
          height: args.height,
        });
        return { success: true };
      }
      case 'browser_console_messages': {
        let messages = [...this.consoleLog];
        if (args?.pattern) {
          let re: RegExp;
          try { re = new RegExp(args.pattern as string, 'i'); }
          catch { throw new Error(`Invalid regex pattern: ${args.pattern}`); }
          messages = messages.filter(m => re.test(m.text));
        }
        return { messages: messages.map(m => ({ level: m.level, text: m.text })), count: messages.length };
      }
      case 'browser_batch_actions':
        return this.executeBatch(args);
      case 'browser_load_all': {
        const result = await this.loadAll({
          maxScrolls: typeof args.maxScrolls === 'number' ? args.maxScrolls : undefined,
          waitMs: typeof args.waitMs === 'number' ? args.waitMs : undefined,
        });
        return result;
      }
      default:
        throw new Error(`Unhandled allowed tool: ${toolName}`);
    }
  }

  // ─── BrowserProvider Interface ─────────────────────────────────────

  async navigate(url: string, options?: { timeout?: number }): Promise<void> {
    const gotoOpts: Record<string, unknown> = { waitUntil: 'domcontentloaded', timeout: options?.timeout };

    // Referrer spoofing: inject Google referer when navigating cross-origin
    if (this.flags.referrerSpoofing) {
      try {
        const currentHost = new URL(this.page.url()).hostname;
        const targetHost = new URL(url).hostname;
        if (currentHost !== targetHost) {
          gotoOpts.referer = 'https://www.google.com/';
        }
      } catch {
        // Invalid URLs — skip spoofing
      }
    }

    await this.page.goto(url, gotoOpts);
    await detectAndWaitForChallenge(this.page);
  }

  async snapshot(options?: SnapshotOptions): Promise<PageSnapshot> {
    // Note: snapshotStale is reset AFTER currentSnapshot is assigned (line ~935),
    // not here — framenavigated can fire during async collectFrameSnapshots() and
    // re-set the flag. The final snapshot reflects actual page state regardless.

    // Reconcile stale modals before snapshot
    if (this.flags.modalTracking) {
      this.modalTracker.pruneExpired();
    }

    const snapshotStart = Date.now();
    const url = this.page.url();
    const title = await this.page.title();

    // Snapshot mode: none
    if (this.flags.snapshotMode === 'none') {
      return { url, title, content: '', mode: 'none', interactiveCount: 0 };
    }

    // Collect accessibility tree from all frames (main + iframes)
    const frameSnapshots = await this.collectFrameSnapshots(options?.selector);

    // Update frame map for locator resolution
    this.frameMap.clear();
    for (const fs of frameSnapshots) {
      this.frameMap.set(fs.framePath, fs.frame);
    }

    // Snapshot mode: full (legacy)
    if (this.flags.snapshotMode === 'full') {
      const combinedYaml = frameSnapshots
        .filter(fs => fs.yaml)
        .map(fs => fs.framePath === 'main' ? fs.yaml : `[frame: ${fs.framePath}]\n${fs.yaml}`)
        .join('\n\n');
      const tokens = Math.ceil(combinedYaml.length / 4);
      this.benchmark?.recordSnapshot(tokens, Date.now() - snapshotStart);
      return {
        url, title,
        content: combinedYaml,
        mode: 'full',
        recentEvents: this.drainRecentEvents(),
      };
    }

    // Snapshot mode: annotated (@ref system) — per-frame annotation
    const allRefs = new Map<string, RefEntry>();
    const contentParts: string[] = [];
    const allTrees = new Map<string, SnapshotNode[]>();
    const allIdentityHashCounts = new Map<string, number>();

    this.refState.version++;
    for (const fs of frameSnapshots) {
      if (!fs.yaml) {
        if (fs.error) {
          contentParts.push(
            `[frame: ${fs.framePath}] (${fs.timedOut ? 'timeout' : 'error'}: ${fs.error})`,
          );
        }
        continue;
      }

      const trees = parseYamlToTree(fs.yaml, fs.framePath);
      const { refs, annotatedContent, identityHashCounts } = annotateSnapshot(trees, fs.framePath, this.refState);

      for (const [key, value] of refs) {
        allRefs.set(key, value);
      }
      for (const [hash, count] of identityHashCounts) {
        allIdentityHashCounts.set(hash, (allIdentityHashCounts.get(hash) ?? 0) + count);
      }

      if (fs.framePath === 'main') {
        contentParts.push(annotatedContent);
      } else {
        contentParts.push(`[frame: ${fs.framePath}]\n${annotatedContent}`);
      }

      allTrees.set(fs.framePath, trees);
    }

    // SPA divergence detection (across all frames)
    const allCurrentHashes = new Set([...allRefs.values()].map(r => r.identityHash));
    if (this.currentSnapshot) {
      const prevHashes = new Set(this.currentSnapshot.refsByHash.keys());
      if (jaccardSimilarity(prevHashes, allCurrentHashes) < 0.5) {
        this.refState = createRefState(this.pruneHashToRef());
        this.refState.version++;
        allRefs.clear();
        contentParts.length = 0;
        allTrees.clear();
        allIdentityHashCounts.clear();
        for (const fs of frameSnapshots) {
          if (!fs.yaml) {
            if (fs.error) {
              contentParts.push(
                `[frame: ${fs.framePath}] (${fs.timedOut ? 'timeout' : 'error'}: ${fs.error})`,
              );
            }
            continue;
          }
          const trees = parseYamlToTree(fs.yaml, fs.framePath);
          const { refs, annotatedContent, identityHashCounts } = annotateSnapshot(trees, fs.framePath, this.refState);
          for (const [key, value] of refs) {
            allRefs.set(key, value);
          }
          for (const [hash, count] of identityHashCounts) {
            allIdentityHashCounts.set(hash, (allIdentityHashCounts.get(hash) ?? 0) + count);
          }
          if (fs.framePath === 'main') {
            contentParts.push(annotatedContent);
          } else {
            contentParts.push(`[frame: ${fs.framePath}]\n${annotatedContent}`);
          }
          allTrees.set(fs.framePath, trees);
        }
      }
    }

    this.currentSnapshot = {
      version: this.refState.version,
      yamlContent: frameSnapshots.map(fs => fs.yaml).join('\n\n'),
      annotatedContent: contentParts.join('\n\n'),
      refs: allRefs,
      refsByHash: new Map([...allRefs.values()].map(r => [r.identityHash, r.ref])),
      interactiveCount: allRefs.size,
      wasFiltered: !!(options?.selector),
      identityHashCounts: allIdentityHashCounts,
    };

    // Reset stale flag AFTER snapshot is built — any framenavigated that fired
    // during collectFrameSnapshots() is reflected in the snapshot data above.
    this.snapshotStale = false;

    // Incremental diffs — per-frame
    let content = this.currentSnapshot.annotatedContent;
    let incremental = false;

    if (this.flags.incrementalDiffs && !this.modalTracker.hasActive()) {
      const diffParts: string[] = [];
      let anyDiffed = false;
      let anyFallback = false;

      for (const [framePath, trees] of allTrees) {
        const previousTrees = this.refState.previousTrees.get(framePath);
        if (previousTrees) {
          const diff = diffTrees(previousTrees, trees);
          if (diff.fullFallback) {
            anyFallback = true;
            break;
          }
          const rendered = renderDiff(diff, this.currentSnapshot.version);
          if (framePath === 'main') {
            diffParts.push(rendered);
          } else {
            diffParts.push(`[frame: ${framePath}]\n${rendered}`);
          }
          anyDiffed = true;
        }
      }

      if (anyDiffed && !anyFallback) {
        content = diffParts.join('\n\n');
        incremental = true;
      }
    }

    // Store current trees for next diff
    for (const [framePath, trees] of allTrees) {
      this.refState.previousTrees.set(framePath, trees);
    }

    // Apply filtering (main frame only for filtered view)
    if (options && !incremental) {
      const mainTrees = allTrees.get('main');
      if (mainTrees) {
        const filteredTrees = filterTree(mainTrees, options);
        content = filteredTrees.map(t => renderFilteredNode(t)).join('\n');
      }
    }

    // Modal state description in snapshot
    if (this.flags.modalTracking && this.modalTracker.hasActive()) {
      const modalDesc = this.modalTracker.describeActive();
      content = `${modalDesc}\n\n${content}`;
      incremental = false; // Force full on modal
    }

    const tokens = Math.ceil(content.length / 4);
    this.benchmark?.recordSnapshot(tokens, Date.now() - snapshotStart);

    // One-shot console unavailability notice for patchright engine
    if (this.capabilities?.supportsConsoleEvents === false
      && !this._consoleUnavailableNotified
      && !incremental
      && this.flags.snapshotMode === 'annotated') {
      content += `\n[Note: console events unavailable — ${this.capabilities?.effectiveEngine ?? 'current'} engine disables console API]`;
      this._consoleUnavailableNotified = true;
    }

    // Cloudflare challenge / interstitial page detection
    const isChallenged = CF_CHALLENGE_TITLE_RE.test(title);
    const isPhishingPage = CF_PHISHING_TITLE_RE.test(title);
    if (isChallenged || isPhishingPage) {
      const currentEngine = this.capabilities?.effectiveEngine ?? 'unknown';
      const engineHint = currentEngine === 'playwright'
        ? '- Switch engine: try patchright or camoufox for better stealth\n'
        : '';
      const pageType = isPhishingPage ? 'CLOUDFLARE PHISHING INTERSTITIAL' : 'CLOUDFLARE CHALLENGE PAGE';
      const extra = isPhishingPage
        ? '- Auto-dismiss was attempted (Turnstile challenge must solve first to enable bypass). Try navigating again or wait.\n'
        : '- Wait: call browser_snapshot again in 5-10 seconds (challenge may auto-resolve)\n';
      const warning = `${pageType} DETECTED\n` +
        'This page is showing a Cloudflare security interstitial.\n' +
        'Options:\n' +
        extra +
        '- Import cookies: use schrute_import_cookies with a cf_clearance cookie file\n' +
        engineHint +
        '- Current engine: ' + currentEngine + '\n\n';
      content = warning + content;
    }

    // Apply pagination if requested
    const paginatedResult = this.applyPagination(content, options);

    return {
      url,
      title,
      content: paginatedResult.content,
      version: this.currentSnapshot.version,
      interactiveCount: this.currentSnapshot.interactiveCount,
      incremental,
      mode: 'annotated',
      recentEvents: this.drainRecentEvents(),
      pagination: paginatedResult.pagination,
    };
  }

  /**
   * Combined snapshot + screenshot with partial failure handling.
   */
  async snapshotWithScreenshot(options?: SnapshotOptions): Promise<PageSnapshot> {
    const [snapshotResult, screenshotResult] = await Promise.allSettled([
      this.snapshot(options),
      this.captureScreenshot(),
    ]);

    if (snapshotResult.status === 'rejected') {
      throw snapshotResult.reason;
    }

    const result = snapshotResult.value;

    if (screenshotResult.status === 'rejected') {
      result.screenshot = null;
      result.screenshotError = screenshotResult.reason instanceof Error
        ? screenshotResult.reason.message
        : String(screenshotResult.reason);
    } else {
      result.screenshot = screenshotResult.value.buffer.toString('base64');
      result.screenshotMimeType = screenshotResult.value.mimeType;
    }

    return result;
  }

  async click(ref: string): Promise<void> {
    await this.withRefLocator(ref, async (locator) => {
      await this.waitForCompletion(async () => {
        await locator.click({ timeout: this.handlerTimeoutMs });
      });
    });
  }

  async type(ref: string, text: string): Promise<void> {
    await this.withRefLocator(ref, async (locator) => {
      await this.waitForCompletion(async () => {
        await locator.fill(text, { timeout: this.handlerTimeoutMs });
      });
    });
  }

  /**
   * Sealed fetch wrapper. NEVER exposes raw page.evaluate() to agents.
   */
  async evaluateFetch(req: SealedFetchRequest): Promise<SealedFetchResponse> {
    this.assertDomainAllowed(req.url);

    const result = await this.page.evaluate(
      async ({ url, method, headers, body }) => {
        const resp = await fetch(url, {
          method,
          headers,
          body: body ?? undefined,
          redirect: 'manual',   // Surface redirects to executor for per-hop validation
        });

        const responseHeaders: Record<string, string> = {};
        resp.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        const responseBody = await resp.text();

        return {
          status: resp.status,
          headers: responseHeaders,
          body: responseBody,
        };
      },
      {
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: req.body,
      },
    );

    return result;
  }

  async evaluateModelContext(req: SealedModelContextRequest): Promise<SealedModelContextResponse> {
    const { toolName, args } = req;
    const result = await this.page.evaluate(
      async ({ name, arguments: callArgs }: { name: string; arguments: Record<string, unknown> }) => {
        const mc = (navigator as any).modelContext;
        if (!mc || typeof mc.callTool !== 'function') {
          return { result: null, error: 'WebMCP not available on this page' };
        }
        try {
          // Set up cancel detection
          const cancelPromise = new Promise((_, reject) => {
            (globalThis as any).addEventListener('toolcancel', (evt: any) => {
              if (evt.toolName === name) reject(new Error(`Tool '${name}' cancelled by user`));
            }, { once: true });
          });
          const response = await Promise.race([
            mc.callTool(name, callArgs),
            cancelPromise,
          ]);
          return { result: response, error: null, hasStructuredResponse: typeof response === 'object' && response !== null };
        } catch (err: any) {
          return { result: null, error: err?.message ?? String(err) };
        }
      },
      { name: toolName, arguments: args },
    );
    return result as SealedModelContextResponse;
  }

  async listModelContextTools(): Promise<SealedModelContextResponse> {
    const result = await this.page.evaluate(async () => {
      const mc = (navigator as any).modelContext;
      if (!mc) return { result: null, error: 'WebMCP not available' };

      if (typeof mc.listTools === 'function') {
        try {
          const tools = await mc.listTools();
          const testing = (navigator as any).modelContextTesting;
          let testingTools = null;
          if (testing && typeof testing.listTools === 'function') {
            try { testingTools = await testing.listTools(); } catch {}
          }
          return { result: { tools, testingTools }, error: null };
        } catch (e: any) {
          return { result: null, error: e?.message ?? String(e) };
        }
      }

      const testing = (navigator as any).modelContextTesting;
      if (testing && typeof testing.listTools === 'function') {
        try {
          return { result: { tools: await testing.listTools() }, error: null };
        } catch (e: any) {
          return { result: null, error: e?.message ?? String(e) };
        }
      }

      if (typeof mc.callTool === 'function') {
        try {
          const r = await mc.callTool('__webmcp_probe__', { action: 'listTools' });
          return { result: { tools: r }, error: null };
        } catch (e: any) {
          return { result: null, error: e?.message ?? String(e) };
        }
      }

      return { result: null, error: 'No tool enumeration API found' };
    });
    return result as SealedModelContextResponse;
  }

  getCurrentUrl(): string {
    return this.page.url();
  }

  private async captureScreenshot(options?: {
    format?: 'jpeg' | 'png';
    quality?: number;
    locator?: Locator;
  }): Promise<{ buffer: Buffer; mimeType: string }> {
    const format = options?.format ?? this.flags.screenshotFormat ?? 'jpeg';
    const quality = format === 'jpeg' ? (options?.quality ?? this.flags.screenshotQuality ?? 80) : undefined;
    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';

    const target = options?.locator ?? this.page;
    const raw = await target.screenshot({
      fullPage: false, scale: 'css', type: format, quality,
      timeout: this.handlerTimeoutMs,
    });

    if (this.flags.screenshotResize) {
      if (format === 'png') {
        const result = resizeScreenshotBuffer(raw);
        this.benchmark?.recordScreenshot(result.buffer.length);
        return { buffer: result.buffer, mimeType };
      }
      // JPEG: check dimensions and fall back to PNG resize if oversized
      let width: number, height: number;
      if (options?.locator) {
        const box = await options.locator.boundingBox();
        width = box ? Math.ceil(box.width) : 0;
        height = box ? Math.ceil(box.height) : 0;
      } else {
        const viewport = this.page.viewportSize();
        width = viewport?.width ?? 1280;
        height = viewport?.height ?? 720;
      }
      const scale = estimateScale(width, height, DEFAULT_MAX_DIMENSION, DEFAULT_MAX_PIXELS);
      if (scale < 1) {
        const pngRaw = await target.screenshot({
          fullPage: false, scale: 'css', type: 'png', timeout: this.handlerTimeoutMs,
        });
        const result = resizeScreenshotBuffer(pngRaw);
        this.benchmark?.recordScreenshot(result.buffer.length);
        return { buffer: result.buffer, mimeType: 'image/png' };
      }
    }

    this.benchmark?.recordScreenshot(raw.length);
    return { buffer: raw, mimeType };
  }

  async screenshot(): Promise<Buffer> {
    const { buffer } = await this.captureScreenshot();
    return buffer;
  }

  getNetworkEntryCount(): number {
    return this.networkEntries.length;
  }

  consoleMessages(): SnapshotEvent[] {
    return this.consoleLog.map(m => ({
      type: 'console' as const,
      level: (m.level === 'error' || m.level === 'warning' || m.level === 'info' || m.level === 'debug')
        ? m.level
        : 'info' as const,
      text: m.text,
    }));
  }

  async debugTrace(): Promise<{ snapshot: PageSnapshot; console: SnapshotEvent[]; network: NetworkEntry[] }> {
    const [snapshot, consoleEvents, network] = await Promise.all([
      this.snapshot(),
      Promise.resolve(this.consoleMessages()),
      this.networkRequests(),
    ]);
    return { snapshot, console: consoleEvents, network };
  }

  async networkRequests(includeStatic?: boolean): Promise<NetworkEntry[]> {
    if (includeStatic) return [...this.networkEntries];

    return this.networkEntries.filter(entry => {
      const isStatic = entry.resourceType
        ? STATIC_RESOURCE_TYPES.has(entry.resourceType)
        : false;
      const isSuccess = !entry.status || entry.status < 400;
      return !(isStatic && isSuccess);
    });
  }

  // ─── Batch Actions ──────────────────────────────────────────────────

  // Inlined limits — no import coupling with tool-registry
  private static readonly BATCH_MAX_ACTIONS = 20;
  private static readonly BATCH_PER_ACTION_TIMEOUT_MS = 10_000;
  private static readonly BATCH_TOTAL_TIMEOUT_MS = 60_000;
  private static readonly BATCH_UNSAFE_TOOLS = new Set([
    'browser_close',
    'browser_navigate',
    'browser_batch_actions',
  ]);

  private async executeBatch(args: Record<string, unknown>): Promise<unknown> {
    if (!this.flags.batchActions) throw new Error('Batch actions disabled');

    const actions = args.actions as Array<{ tool: string; args: Record<string, unknown> }>;
    if (!Array.isArray(actions)) throw new Error('Expected actions to be an array');

    // Pre-validation
    if (actions.length > BaseBrowserAdapter.BATCH_MAX_ACTIONS) {
      throw new Error(`Batch exceeds max ${BaseBrowserAdapter.BATCH_MAX_ACTIONS} actions`);
    }
    const unsafeFound = actions.filter(a => BaseBrowserAdapter.BATCH_UNSAFE_TOOLS.has(a.tool));
    if (unsafeFound.length > 0) {
      const names = [...new Set(unsafeFound.map(a => a.tool))].join(', ');
      throw new Error(`Batch contains unsafe tool: ${names}`);
    }

    const batchStart = Date.now();
    const results: Array<{ tool: string; success: boolean; error?: string }> = [];

    const originalTimeout = this._currentDefaultTimeout;
    const batchAbort = new AbortController();
    const batchTimer = setTimeout(
      () => batchAbort.abort(),
      BaseBrowserAdapter.BATCH_TOTAL_TIMEOUT_MS,
    );

    try {
      for (const action of actions) {
        if (batchAbort.signal.aborted) {
          results.push({ tool: action.tool, success: false, error: 'Batch total timeout exceeded' });
          continue;
        }

        const elapsed = Date.now() - batchStart;
        const remainingMs = BaseBrowserAdapter.BATCH_TOTAL_TIMEOUT_MS - elapsed;
        if (remainingMs <= 0) {
          results.push({ tool: action.tool, success: false, error: 'Batch total timeout exceeded' });
          continue;
        }

        const actionTimeout = Math.min(
          BaseBrowserAdapter.BATCH_PER_ACTION_TIMEOUT_MS,
          remainingMs,
        );
        this.setPageTimeout(actionTimeout);

        try {
          await this.proxyTool(action.tool, action.args);
          results.push({ tool: action.tool, success: true });
        } catch (err) {
          results.push({
            tool: action.tool,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      clearTimeout(batchTimer);
      this.setPageTimeout(originalTimeout);
    }

    const snapshot = await this.snapshot();
    return { results, snapshot };
  }

  // ─── Internal Helpers ──────────────────────────────────────────────

  private applyPagination(
    content: string,
    options?: SnapshotOptions,
  ): { content: string; pagination?: { totalChars: number; offset: number; hasMore: boolean } } {
    if (!options?.maxChars || options.maxChars <= 0) {
      return { content };
    }

    const maxChars = Math.max(0, Math.floor(options.maxChars));
    const offset = Math.max(0, Math.min(options.offset ?? 0, content.length));

    if (offset >= content.length) {
      return {
        content: '',
        pagination: { totalChars: content.length, offset, hasMore: false },
      };
    }

    const sliced = content.slice(offset, offset + maxChars);
    const hasMore = offset + maxChars < content.length;

    return {
      content: sliced,
      pagination: { totalChars: content.length, offset, hasMore },
    };
  }

  protected assertDomainAllowed(url: string): void {
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }

    if (this.domainAllowlist.length === 0) {
      throw new Error(
        `Domain "${hostname}" is not on the allowlist. ` +
        `Configure domainAllowlist to enable sealed fetch.`,
      );
    }

    const allowed = this.domainAllowlist.some((domain) => {
      return hostname === domain || hostname.endsWith('.' + domain);
    });

    if (!allowed) {
      throw new Error(
        `Domain "${hostname}" is not on the allowlist. ` +
        `Allowed: ${this.domainAllowlist.join(', ')}`,
      );
    }
  }

  protected getCaptureSiteHost(requestUrl: string): string {
    const firstAllowed = this.domainAllowlist[0];
    if (firstAllowed) {
      return firstAllowed;
    }

    try {
      return new URL(this.page.url()).hostname;
    } catch {
      try {
        return new URL(requestUrl).hostname;
      } catch {
        return '';
      }
    }
  }

  protected setupNetworkCapture(): void {
    this.page.on('response', async (response: PwResponse) => {
      try {
        const request = response.request();
        const timing = request.timing();
        const requestUrl = request.url();
        const method = request.method();
        const status = response.status();
        const resourceType = request.resourceType();
        const siteHost = this.getCaptureSiteHost(requestUrl);

        const requestHeaders: Record<string, string> = {};
        const reqHeaders = await request.allHeaders();
        for (const [k, v] of Object.entries(reqHeaders)) {
          requestHeaders[k] = v;
        }

        const responseHeaders: Record<string, string> = {};
        const respHeaders = await response.allHeaders();
        for (const [k, v] of Object.entries(respHeaders)) {
          responseHeaders[k] = v;
        }

        const obviousNoise = isObviousNoise(requestUrl, method, status, siteHost, resourceType);

        let requestBody: string | undefined;
        if (!obviousNoise.obvious) {
          try {
            requestBody = request.postData() ?? undefined;
          } catch (err) {
            log.debug({ err }, 'Failed to read request post data');
          }
        }

        let responseBody: string | undefined;
        if (shouldCaptureResponseBody(
          requestUrl,
          method,
          status,
          responseHeaders['content-type'] ?? responseHeaders['Content-Type'],
          siteHost,
          resourceType,
        )) {
          try {
            responseBody = await response.text();
          } catch (err) {
            log.debug({ err }, 'Failed to read response body');
          }
        }

        const startTime = timing.startTime;
        const endTime = timing.responseEnd > 0
          ? timing.responseEnd
          : startTime + 1;

        this.networkEntries.push({
          url: requestUrl,
          method,
          status,
          requestHeaders,
          responseHeaders,
          requestBody,
          responseBody,
          resourceType,
          timing: {
            startTime,
            endTime,
            duration: endTime - startTime,
          },
        });
        // Evict oldest entries to prevent unbounded memory growth
        if (this.networkEntries.length > BaseBrowserAdapter.MAX_NETWORK_ENTRIES) {
          this.networkEntries.splice(0, this.networkEntries.length - BaseBrowserAdapter.MAX_NETWORK_ENTRIES);
        }
        this.benchmark?.recordNetworkEntries(this.networkEntries.length);
      } catch (err) {
        log.debug({ err }, 'Network capture failed for response event');
      }
    });
  }

  private setupRecentEventListeners(): void {
    if (this.capabilities?.supportsConsoleEvents !== false) {
      this.page.on('console', (msg) => {
        const level = msg.type();
        const mappedLevel = level === 'error' ? 'error'
          : level === 'warning' ? 'warning'
          : level === 'info' ? 'info'
          : 'debug';
        this.addRecentEvent({
          type: 'console',
          level: mappedLevel as SnapshotEvent & { type: 'console' } extends { level: infer L } ? L : never,
          text: msg.text(),
        });
        // Persistent console log buffer
        this.consoleLog.push({ level: mappedLevel, text: msg.text(), timestamp: Date.now() });
        if (this.consoleLog.length > BaseBrowserAdapter.MAX_CONSOLE_LOG) {
          this.consoleLog.shift();
        }
      });
    }

    this.page.on('download', (download) => {
      this.addRecentEvent({
        type: 'download',
        filename: download.suggestedFilename(),
        finished: false,
      });
      download.path().then(() => {
        // Mark finished — update last download event if still in buffer
        let idx = -1;
        for (let i = this.recentEvents.length - 1; i >= 0; i--) {
          const ev = this.recentEvents[i];
          if (ev.type === 'download' && ev.filename === download.suggestedFilename()) {
            idx = i;
            break;
          }
        }
        if (idx >= 0) {
          (this.recentEvents[idx] as { type: 'download'; filename: string; finished: boolean }).finished = true;
        }
      }).catch((err) => log.debug({ err }, 'Download handling failed'));
    });
  }

  private addRecentEvent(event: SnapshotEvent): void {
    this.recentEvents.push(event);
    if (this.recentEvents.length > MAX_RECENT_EVENTS) {
      this.recentEvents.shift();
    }
  }

  private drainRecentEvents(): SnapshotEvent[] {
    const events = [...this.recentEvents];
    this.recentEvents = [];
    return events;
  }

  private setupModalListeners(): void {
    this.page.on('dialog', (dialog: Dialog) => {
      this.modalTracker.add({
        type: 'dialog',
        description: `${dialog.type()}: "${dialog.message()}"`,
        clearedBy: 'browser_handle_dialog',
        data: dialog,
        createdAt: Date.now(),
        ttlMs: 30_000,
        handled: false,
      });
    });

    this.page.on('filechooser', (chooser: FileChooser) => {
      this.modalTracker.add({
        type: 'fileChooser',
        description: 'File chooser dialog',
        clearedBy: 'browser_file_upload',
        data: chooser,
        createdAt: Date.now(),
        ttlMs: 60_000,
        handled: false,
      });
    });
  }

  protected async fillForm(values: Record<string, string>): Promise<void> {
    for (const [key, value] of Object.entries(values)) {
      if (key.startsWith('@e')) {
        // Existing ref path
        await this.type(key, value);
      } else {
        // Label-based lookup with name fallback
        let locator = this.page.getByLabel(key);
        const count = await locator.count();
        if (count > 1) {
          log.warn({ key, count }, 'fillForm: multiple elements match label — using first');
        }
        if (count === 0) {
          locator = this.page.locator(`input[name="${key}"]`);
          const nameCount = await locator.count();
          if (nameCount === 0) {
            throw new Error(`No form field found for label or name: "${key}"`);
          }
        }
        await locator.first().fill(value, { timeout: this.handlerTimeoutMs });
      }
    }
  }

  async loadAll(options?: { maxScrolls?: number; waitMs?: number }): Promise<{ scrollCount: number; finalHeight: number }> {
    const max = options?.maxScrolls ?? 20;
    const wait = options?.waitMs ?? 1000;
    let prev = 0;
    let scrolls = 0;

    while (scrolls < max) {
      const height = await this.page.evaluate(`document.body.scrollHeight`) as number;
      if (height === prev) break;
      prev = height;
      await this.page.evaluate(`window.scrollTo(0, document.body.scrollHeight)`);
      await this.page.waitForTimeout(wait);
      scrolls++;
    }

    return { scrollCount: scrolls, finalHeight: prev };
  }
}

function renderFilteredNode(node: SnapshotNode, indent = 0): string {
  const prefix = '  '.repeat(indent);
  let line = `${prefix}- ${node.role}`;
  if (node.name) line += ` "${node.name}"`;
  if (node.ref) line += ` [${node.ref}]`;

  if (node.children.length > 0) {
    const childLines = node.children.map((c: SnapshotNode) => renderFilteredNode(c, indent + 1));
    return `${line}:\n${childLines.join('\n')}`;
  }
  return line;
}
