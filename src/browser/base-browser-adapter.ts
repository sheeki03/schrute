import type { Page, Request, Response as PwResponse, Dialog, FileChooser, Frame } from 'playwright';
import type {
  BrowserProvider,
  PageSnapshot,
  NetworkEntry,
  SealedFetchRequest,
  SealedFetchResponse,
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
import { resizeScreenshotBuffer } from './screenshot-resize.js';
import { getLogger } from '../core/logger.js';

const log = getLogger();

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
  protected networkEntries: NetworkEntry[] = [];
  protected flags: BrowserFeatureFlags;
  protected benchmark: BrowserBenchmark | null;
  protected capabilities: EngineCapabilities | null;
  private _consoleUnavailableNotified = false;

  // @ref system state
  private refState: RefState;
  private currentSnapshot: AnnotatedSnapshot | null = null;

  // Modal state tracking
  protected modalTracker: ModalStateTracker;

  // Recent events (console + downloads) since last snapshot
  private recentEvents: SnapshotEvent[] = [];

  // Default timeout tracking (Playwright doesn't expose getDefaultTimeout)
  private _currentDefaultTimeout = 30_000;

  // Frame map for locator resolution (framePath → Frame)
  private frameMap = new Map<string, Frame>();

  constructor(
    page: Page,
    domainAllowlist: string[],
    options?: {
      flags?: BrowserFeatureFlags;
      benchmark?: BrowserBenchmark;
      capabilities?: EngineCapabilities;
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
    this.refState = createRefState();
    this.modalTracker = new ModalStateTracker();

    this.setupNetworkCapture();
    this.setupRecentEventListeners();

    if (this.flags.modalTracking) {
      this.setupModalListeners();
    }

    // Reset refs on main-frame navigation
    this.page.on('framenavigated', (frame: Frame) => {
      if (frame === this.page.mainFrame()) {
        this.refState = createRefState();
        this.currentSnapshot = null;
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
      mainYaml = await locator.ariaSnapshot();
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
   * Resolve a ref string to a Playwright locator.
   * @ref refs use the ref system; legacy refs fall back to data-ref/aria-label.
   */
  private async resolveRefToLocator(ref: string) {
    if (ref.startsWith('@e')) {
      const entry = resolveRef(ref, this.currentSnapshot ?? undefined);
      const locator = this.buildLocator(entry);
      this.benchmark?.recordStaleRef(true);
      return locator;
    }
    // Legacy fallback
    return this.page.locator(
      `[data-ref="${ref}"], [aria-label="${ref}"]`,
    ).first();
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
        await this.navigate(args.url);
        return { success: true };
      case 'browser_navigate_back':
        return this.withModalRace(async () => { await this.page.goBack(); });
      case 'browser_snapshot': {
        const options: SnapshotOptions = {};
        if (typeof args.selector === 'string') options.selector = args.selector;
        if (typeof args.interactiveOnly === 'boolean') options.interactiveOnly = args.interactiveOnly;
        if (typeof args.maxDepth === 'number') options.maxDepth = args.maxDepth;
        if (typeof args.compact === 'boolean') options.compact = args.compact;
        return this.snapshot(Object.keys(options).length > 0 ? options : undefined);
      }
      case 'browser_click': {
        if (typeof args.ref !== 'string') throw new Error('Expected ref to be a string');
        const loc = await this.resolveRefToLocator(args.ref);
        return this.withModalRace(async () => { await loc.click({ timeout: 10000 }); });
      }
      case 'browser_type': {
        if (typeof args.ref !== 'string') throw new Error('Expected ref to be a string');
        if (typeof args.text !== 'string') throw new Error('Expected text to be a string');
        const loc = await this.resolveRefToLocator(args.ref);
        return this.withModalRace(async () => { await loc.fill(args.text as string); });
      }
      case 'browser_take_screenshot': {
        if (args.ref && typeof args.ref === 'string') {
          const locator = await this.resolveRefToLocator(args.ref);
          const buf = await locator.screenshot();
          if (this.flags.screenshotResize) {
            return resizeScreenshotBuffer(buf).buffer;
          }
          return buf;
        }
        return this.screenshot();
      }
      case 'browser_network_requests':
        return this.networkRequests(args.includeStatic as boolean | undefined);
      case 'browser_hover': {
        if (typeof args.ref !== 'string') throw new Error('Expected ref to be a string');
        const loc = await this.resolveRefToLocator(args.ref);
        return this.withModalRace(async () => { await loc.hover(); });
      }
      case 'browser_drag': {
        if (typeof args.startRef !== 'string') throw new Error('Expected startRef to be a string');
        if (typeof args.endRef !== 'string') throw new Error('Expected endRef to be a string');
        const startLoc = await this.resolveRefToLocator(args.startRef);
        const endLoc = await this.resolveRefToLocator(args.endRef);
        return this.withModalRace(async () => { await startLoc.dragTo(endLoc); });
      }
      case 'browser_press_key':
        if (typeof args.key !== 'string') throw new Error('Expected key to be a string');
        return this.withModalRace(async () => { await this.page.keyboard.press(args.key as string); });
      case 'browser_select_option': {
        if (typeof args.ref !== 'string') throw new Error('Expected ref to be a string');
        if (typeof args.value !== 'string') throw new Error('Expected value to be a string');
        const loc = await this.resolveRefToLocator(args.ref);
        return this.withModalRace(async () => { await loc.selectOption(args.value as string); });
      }
      case 'browser_fill_form': {
        const values = args.values;
        if (typeof values !== 'object' || values === null || Array.isArray(values)) {
          throw new Error('Expected values to be a Record<string, string>');
        }
        await this.fillForm(values as Record<string, string>);
        return { success: true };
      }
      case 'browser_file_upload': {
        if (typeof args.ref !== 'string') throw new Error('Expected ref to be a string');
        if (!Array.isArray(args.paths)) throw new Error('Expected paths to be an array');
        const loc = await this.resolveRefToLocator(args.ref);
        await loc.setInputFiles(args.paths as string[]);
        // Clear fileChooser modal state
        if (this.flags.modalTracking) {
          this.modalTracker.markHandled('fileChooser');
          this.modalTracker.clear('fileChooser');
        }
        return { success: true };
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
      case 'browser_console_messages':
        return { note: 'Console messages require prior listener setup' };
      case 'browser_batch_actions':
        return this.executeBatch(args);
      default:
        throw new Error(`Unhandled allowed tool: ${toolName}`);
    }
  }

  // ─── BrowserProvider Interface ─────────────────────────────────────

  async navigate(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  async snapshot(options?: SnapshotOptions): Promise<PageSnapshot> {
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
      const { refs, annotatedContent } = annotateSnapshot(trees, fs.framePath, this.refState);

      for (const [key, value] of refs) {
        allRefs.set(key, value);
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
        this.refState = createRefState();
        this.refState.version++;
        allRefs.clear();
        contentParts.length = 0;
        allTrees.clear();
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
          const { refs, annotatedContent } = annotateSnapshot(trees, fs.framePath, this.refState);
          for (const [key, value] of refs) {
            allRefs.set(key, value);
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
    };

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

    return {
      url,
      title,
      content,
      version: this.currentSnapshot.version,
      interactiveCount: this.currentSnapshot.interactiveCount,
      incremental,
      mode: 'annotated',
      recentEvents: this.drainRecentEvents(),
    };
  }

  async click(ref: string): Promise<void> {
    const locator = await this.resolveRefToLocator(ref);
    await this.waitForCompletion(async () => {
      await locator.click({ timeout: 10000 });
    });
  }

  async type(ref: string, text: string): Promise<void> {
    const locator = await this.resolveRefToLocator(ref);
    await this.waitForCompletion(async () => {
      await locator.fill(text);
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

  async screenshot(): Promise<Buffer> {
    const raw = await this.page.screenshot({ fullPage: false, scale: 'css' });
    if (!this.flags.screenshotResize) {
      this.benchmark?.recordScreenshot(raw.length);
      return raw;
    }
    const result = resizeScreenshotBuffer(raw);
    this.benchmark?.recordScreenshot(result.buffer.length);
    return result.buffer;
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

  protected setupNetworkCapture(): void {
    this.page.on('response', async (response: PwResponse) => {
      try {
        const request = response.request();
        const timing = request.timing();

        let requestBody: string | undefined;
        try {
          requestBody = request.postData() ?? undefined;
        } catch (err) {
          log.debug({ err }, 'Failed to read request post data');
        }

        let responseBody: string | undefined;
        try {
          responseBody = await response.text();
        } catch (err) {
          log.debug({ err }, 'Failed to read response body');
        }

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

        const startTime = timing.startTime;
        const endTime = timing.responseEnd > 0
          ? timing.responseEnd
          : startTime + 1;

        this.networkEntries.push({
          url: request.url(),
          method: request.method(),
          status: response.status(),
          requestHeaders,
          responseHeaders,
          requestBody,
          responseBody,
          resourceType: request.resourceType(),
          timing: {
            startTime,
            endTime,
            duration: endTime - startTime,
          },
        });
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
    for (const [ref, value] of Object.entries(values)) {
      await this.type(ref, value);
    }
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
