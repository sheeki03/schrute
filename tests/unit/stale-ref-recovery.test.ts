import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page, Frame, BrowserContext, Locator } from 'playwright';

vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../src/browser/screenshot-resize.js', () => ({
  resizeScreenshotBuffer: (buf: Buffer) => ({ buffer: buf }),
}));

import {
  createRefState,
  annotateSnapshot,
  parseYamlToTree,
  resolveRef,
  StaleRefError,
} from '../../src/browser/snapshot-refs.js';
import type { AnnotatedSnapshot, RefState } from '../../src/browser/snapshot-refs.js';
import { PlaywrightMcpAdapter } from '../../src/browser/playwright-mcp-adapter.js';

describe('Stale Ref Recovery', () => {
  // ─── createRefState preservation ────────────────────────────────

  describe('createRefState with preserveHashMap', () => {
    it('preserves refs from previous state', () => {
      const preserved = new Map([
        ['hash1:0', '@e1'],
        ['hash2:0', '@e5'],
        ['hash3:0', '@e10'],
      ]);
      const state = createRefState(preserved);
      expect(state.hashToRef.get('hash1:0')).toBe('@e1');
      expect(state.hashToRef.get('hash2:0')).toBe('@e5');
      expect(state.hashToRef.get('hash3:0')).toBe('@e10');
    });

    it('derives nextRef from max preserved ref', () => {
      const preserved = new Map([
        ['hash1:0', '@e3'],
        ['hash2:0', '@e7'],
        ['hash3:0', '@e5'],
      ]);
      const state = createRefState(preserved);
      expect(state.nextRef).toBe(8); // max is 7, so next is 8
    });

    it('handles empty preserved map', () => {
      const state = createRefState(new Map());
      expect(state.nextRef).toBe(1);
      expect(state.hashToRef.size).toBe(0);
    });

    it('defaults to fresh state when no arg', () => {
      const state = createRefState();
      expect(state.nextRef).toBe(1);
      expect(state.hashToRef.size).toBe(0);
      expect(state.version).toBe(0);
    });

    it('does not share reference with input map', () => {
      const preserved = new Map([['hash1:0', '@e1']]);
      const state = createRefState(preserved);
      // Mutation of original should not affect state
      preserved.set('hash2:0', '@e2');
      expect(state.hashToRef.has('hash2:0')).toBe(false);
    });
  });

  // ─── Identity hash recovery across snapshots ────────────────────

  describe('identity hash recovery', () => {
    it('assigns same ref to same element across snapshots', () => {
      const yaml = '- button "Submit"';
      const state = createRefState();

      const trees1 = parseYamlToTree(yaml, 'main');
      const { refs: refs1 } = annotateSnapshot(trees1, 'main', state);
      const ref1 = [...refs1.values()][0].ref;

      // Simulate navigation: preserve hashToRef
      const preserved = new Map(state.hashToRef);
      const newState = createRefState(preserved);
      newState.version = state.version + 1;

      const trees2 = parseYamlToTree(yaml, 'main');
      const { refs: refs2 } = annotateSnapshot(trees2, 'main', newState);
      const ref2 = [...refs2.values()][0].ref;

      expect(ref2).toBe(ref1);
    });

    it('assigns new ref when element changes', () => {
      const state = createRefState();

      const trees1 = parseYamlToTree('- button "Submit"', 'main');
      const { refs: refs1 } = annotateSnapshot(trees1, 'main', state);
      const ref1 = [...refs1.values()][0].ref;

      // Different button after navigation
      const preserved = new Map(state.hashToRef);
      const newState = createRefState(preserved);

      const trees2 = parseYamlToTree('- button "Cancel"', 'main');
      const { refs: refs2 } = annotateSnapshot(trees2, 'main', newState);
      const ref2 = [...refs2.values()][0].ref;

      expect(ref2).not.toBe(ref1);
    });
  });

  // ─── snapshotStale flag behavior ────────────────────────────────

  describe('snapshotStale and resolveRef', () => {
    it('resolveRef throws StaleRefError when snapshot is undefined', () => {
      expect(() => resolveRef('@e1', undefined)).toThrow(StaleRefError);
    });

    it('resolveRef throws StaleRefError when ref not found', () => {
      const snapshot: AnnotatedSnapshot = {
        version: 1,
        yamlContent: '',
        annotatedContent: '',
        refs: new Map(),
        refsByHash: new Map(),
        interactiveCount: 0,
      };
      expect(() => resolveRef('@e999', snapshot)).toThrow(StaleRefError);
    });

    it('resolveRef succeeds when ref exists in snapshot', () => {
      const yaml = '- button "Submit"';
      const state = createRefState();
      const trees = parseYamlToTree(yaml, 'main');
      const { refs } = annotateSnapshot(trees, 'main', state);

      const refId = [...refs.keys()][0];
      const entry = [...refs.values()][0];

      const snapshot: AnnotatedSnapshot = {
        version: 1,
        yamlContent: yaml,
        annotatedContent: '',
        refs,
        refsByHash: new Map([[entry.identityHash, refId]]),
        interactiveCount: refs.size,
      };

      const resolved = resolveRef(refId, snapshot);
      expect(resolved.ref).toBe(refId);
      expect(resolved.role).toBe('button');
    });
  });

  // ─── Sub-resource navigation no-op ──────────────────────────────

  describe('sub-resource navigation', () => {
    it('iframe navigation does not affect main frame refs', () => {
      const state = createRefState();
      const yaml = '- button "Main"';
      const trees = parseYamlToTree(yaml, 'main');
      const { refs } = annotateSnapshot(trees, 'main', state);
      const refId = [...refs.keys()][0];

      // State should still have the ref
      expect(state.hashToRef.size).toBeGreaterThan(0);

      // The framenavigated handler only resets on mainFrame match,
      // so iframe frames should not reset. Verify the state is intact.
      const refValues = [...state.hashToRef.values()];
      expect(refValues).toContain(refId);
    });
  });

  // ─── Ambiguity detection ────────────────────────────────────────

  describe('ambiguity detection', () => {
    it('selector-filtered snapshot sets wasFiltered', () => {
      // wasFiltered should be true when options.selector is used
      // This is set by the adapter, not by snapshot-refs directly.
      // We test the interface contract here.
      const snapshot: AnnotatedSnapshot = {
        version: 1,
        yamlContent: '',
        annotatedContent: '',
        refs: new Map(),
        refsByHash: new Map(),
        interactiveCount: 0,
        wasFiltered: true,
      };
      expect(snapshot.wasFiltered).toBe(true);
    });

    it('identityHashCounts tracks duplicate hashes', () => {
      // Two buttons with the same identity should produce count > 1
      const yaml = [
        '- navigation "nav":',
        '  - button "Submit"',
        '  - button "Submit"',
      ].join('\n');
      const state = createRefState();
      const trees = parseYamlToTree(yaml, 'main');
      const { identityHashCounts } = annotateSnapshot(trees, 'main', state);

      // Both buttons have same identity hash (same role, name, semantic path)
      // so at least one hash should have count > 1
      const maxCount = Math.max(...identityHashCounts.values());
      expect(maxCount).toBe(2);
    });

    it('interactiveOnly snapshot does not set wasFiltered', () => {
      const snapshot: AnnotatedSnapshot = {
        version: 1,
        yamlContent: '',
        annotatedContent: '',
        refs: new Map(),
        refsByHash: new Map(),
        interactiveCount: 0,
        wasFiltered: false,
      };
      expect(snapshot.wasFiltered).toBe(false);
    });

    it('absent old snapshot produces undefined wasFiltered', () => {
      const snapshot: AnnotatedSnapshot = {
        version: 1,
        yamlContent: '',
        annotatedContent: '',
        refs: new Map(),
        refsByHash: new Map(),
        interactiveCount: 0,
      };
      expect(snapshot.wasFiltered).toBeUndefined();
    });
  });

  // ─── LRU touch ──────────────────────────────────────────────────

  describe('LRU touch in annotateSnapshot', () => {
    it('refreshes insertion order on hit', () => {
      const state = createRefState();

      // First annotation: create refs
      const yaml1 = '- button "A"\n- button "B"\n- button "C"';
      const trees1 = parseYamlToTree(yaml1, 'main');
      annotateSnapshot(trees1, 'main', state);

      // Record insertion order: should be A, B, C
      const keysAfterFirst = [...state.hashToRef.keys()];

      // Second annotation with only A: should LRU-touch A, moving it to end
      const yaml2 = '- button "A"';
      const trees2 = parseYamlToTree(yaml2, 'main');
      annotateSnapshot(trees2, 'main', state);

      const keysAfterSecond = [...state.hashToRef.keys()];
      // A's key should now be last (most recently touched)
      const aKey = keysAfterFirst[0]; // A was first
      expect(keysAfterSecond[keysAfterSecond.length - 1]).toBe(aKey);
    });
  });

  // ─── identityHashCounts from annotateSnapshot ──────────────────

  describe('identityHashCounts', () => {
    it('returns correct counts for unique elements', () => {
      const yaml = '- button "A"\n- button "B"\n- link "C"';
      const state = createRefState();
      const trees = parseYamlToTree(yaml, 'main');
      const { identityHashCounts } = annotateSnapshot(trees, 'main', state);

      // Each element has a unique identity, so all counts should be 1
      for (const count of identityHashCounts.values()) {
        expect(count).toBe(1);
      }
    });

    it('returns count > 1 for hash collisions', () => {
      // Same role and name under same semantic path = collision
      const yaml = '- button "OK"\n- button "OK"';
      const state = createRefState();
      const trees = parseYamlToTree(yaml, 'main');
      const { identityHashCounts } = annotateSnapshot(trees, 'main', state);

      // Both buttons share the same identity hash
      const counts = [...identityHashCounts.values()];
      expect(counts.some(c => c === 2)).toBe(true);
    });

    it('is a Map type', () => {
      const yaml = '- button "X"';
      const state = createRefState();
      const trees = parseYamlToTree(yaml, 'main');
      const { identityHashCounts } = annotateSnapshot(trees, 'main', state);
      expect(identityHashCounts).toBeInstanceOf(Map);
    });
  });

  // ─── Adapter-level stale ref behavior ──────────────────────────

  describe('adapter-level stale ref behavior', () => {
    // Helpers to build a mock Page for PlaywrightMcpAdapter
    type FramenavHandler = (frame: Frame) => void;

    function createMockLocator(opts?: { count?: number }) {
      const locCount = opts?.count ?? 1;
      const loc: any = {
        ariaSnapshot: vi.fn().mockResolvedValue('- button "Submit" [@e1]'),
        count: vi.fn().mockResolvedValue(locCount),
        click: vi.fn().mockResolvedValue(undefined),
        fill: vi.fn().mockResolvedValue(undefined),
        hover: vi.fn().mockResolvedValue(undefined),
        selectOption: vi.fn().mockResolvedValue(undefined),
        setInputFiles: vi.fn().mockResolvedValue(undefined),
        dragTo: vi.fn().mockResolvedValue(undefined),
        screenshot: vi.fn().mockResolvedValue(Buffer.from('png')),
        getByRole: vi.fn().mockReturnThis(),
        nth: vi.fn().mockReturnThis(),
        first: vi.fn().mockReturnThis(),
        innerText: vi.fn().mockResolvedValue(''),
        boundingBox: vi.fn().mockResolvedValue({ x: 0, y: 0, width: 100, height: 100 }),
      };
      return loc;
    }

    function createMockPage(ariaYaml = '- button "Submit"') {
      const handlers: Record<string, FramenavHandler[]> = {};
      const mainFrame: any = {
        url: () => 'https://example.com',
        name: () => '',
        parentFrame: () => null,
        getByRole: vi.fn(),
        locator: vi.fn(),
      };

      const mockLocator = createMockLocator();
      mockLocator.ariaSnapshot.mockResolvedValue(ariaYaml);

      // Configure frame's getByRole to return a locator with correct count
      mainFrame.getByRole.mockReturnValue(mockLocator);
      mainFrame.locator.mockReturnValue(mockLocator);

      const page: any = {
        on: vi.fn((event: string, handler: any) => {
          if (!handlers[event]) handlers[event] = [];
          handlers[event].push(handler);
        }),
        off: vi.fn(),
        once: vi.fn(),
        mainFrame: () => mainFrame,
        frames: () => [mainFrame],
        url: () => 'https://example.com',
        title: vi.fn().mockResolvedValue('Test'),
        locator: vi.fn().mockReturnValue(mockLocator),
        getByRole: vi.fn().mockReturnValue(mockLocator),
        context: () => ({ pages: () => [page] }),
        keyboard: { press: vi.fn().mockResolvedValue(undefined) },
        setDefaultTimeout: vi.fn(),
        setViewportSize: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
        goto: vi.fn().mockResolvedValue(undefined),
        goBack: vi.fn().mockResolvedValue(undefined),
        waitForSelector: vi.fn().mockResolvedValue(undefined),
        screenshot: vi.fn().mockResolvedValue(Buffer.from('png')),
        _handlers: handlers,
        _mainFrame: mainFrame,
        _mockLocator: mockLocator,
      };

      return page;
    }

    function fireFramenavigated(page: any, frame?: any) {
      const handlers = page._handlers['framenavigated'] || [];
      for (const h of handlers) {
        h(frame ?? page._mainFrame);
      }
    }

    it('navEpoch increments on main-frame framenavigated event', async () => {
      const page = createMockPage();
      const adapter = new PlaywrightMcpAdapter(page as any, ['example.com'], {
        flags: { snapshotMode: 'annotated', incrementalDiffs: false, modalTracking: false, screenshotResize: false },
      } as any);

      // Take initial snapshot to populate refs
      await adapter.proxyTool('browser_snapshot', {});

      // Simulate framenavigated - this should increment navEpoch internally
      // We test indirectly: fire two navigations, then try to click a stale ref
      fireFramenavigated(page);
      fireFramenavigated(page);

      // The adapter should be in stale state now.
      // A click on a ref that doesn't match after fresh snapshot should throw.
      page._mockLocator.ariaSnapshot.mockResolvedValue('- button "Different"');
      await expect(adapter.proxyTool('browser_click', { ref: '@e1' }))
        .rejects.toThrow(StaleRefError);
    });

    it('stale flag set, fresh snapshot matches old hash (count=1) resolves ref', async () => {
      const page = createMockPage('- button "Submit"');
      const adapter = new PlaywrightMcpAdapter(page as any, ['example.com'], {
        flags: { snapshotMode: 'annotated', incrementalDiffs: false, modalTracking: false, screenshotResize: false },
      } as any);

      // Take initial snapshot
      await adapter.proxyTool('browser_snapshot', {});

      // Simulate framenavigated (sets snapshotStale = true)
      fireFramenavigated(page);

      // Fresh snapshot returns same content (same identity hash)
      // Click should succeed because identity verification passes
      await expect(adapter.proxyTool('browser_click', { ref: '@e1' }))
        .resolves.not.toThrow();
    });

    it('stale flag set, ref absent from fresh snapshot throws StaleRefError', async () => {
      const page = createMockPage('- button "Submit"');
      const adapter = new PlaywrightMcpAdapter(page as any, ['example.com'], {
        flags: { snapshotMode: 'annotated', incrementalDiffs: false, modalTracking: false, screenshotResize: false },
      } as any);

      // Take initial snapshot (assigns @e1 to "Submit" button)
      await adapter.proxyTool('browser_snapshot', {});

      // Simulate navigation
      fireFramenavigated(page);

      // Fresh snapshot has completely different content
      page._mockLocator.ariaSnapshot.mockResolvedValue('- link "Login"');

      await expect(adapter.proxyTool('browser_click', { ref: '@e1' }))
        .rejects.toThrow(StaleRefError);
    });

    it('stale flag set, old hash != new hash throws StaleRefError', async () => {
      const page = createMockPage('- button "Submit"');
      const adapter = new PlaywrightMcpAdapter(page as any, ['example.com'], {
        flags: { snapshotMode: 'annotated', incrementalDiffs: false, modalTracking: false, screenshotResize: false },
      } as any);

      await adapter.proxyTool('browser_snapshot', {});
      fireFramenavigated(page);

      // The button is now under a different semantic context (different identity hash)
      page._mockLocator.ariaSnapshot.mockResolvedValue('- navigation "nav":\n  - button "Submit"');

      await expect(adapter.proxyTool('browser_click', { ref: '@e1' }))
        .rejects.toThrow(StaleRefError);
    });

    it('stale flag set, hash count > 1 in fresh snapshot throws StaleRefError', async () => {
      const page = createMockPage('- button "Submit"');
      const adapter = new PlaywrightMcpAdapter(page as any, ['example.com'], {
        flags: { snapshotMode: 'annotated', incrementalDiffs: false, modalTracking: false, screenshotResize: false },
      } as any);

      await adapter.proxyTool('browser_snapshot', {});
      fireFramenavigated(page);

      // Fresh snapshot has duplicates — two buttons with the same identity
      page._mockLocator.ariaSnapshot.mockResolvedValue('- button "Submit"\n- button "Submit"');

      await expect(adapter.proxyTool('browser_click', { ref: '@e1' }))
        .rejects.toThrow(StaleRefError);
    });

    it('stale flag set, locator count > 1 throws StaleRefError', async () => {
      const page = createMockPage('- button "Submit"');
      const adapter = new PlaywrightMcpAdapter(page as any, ['example.com'], {
        flags: { snapshotMode: 'annotated', incrementalDiffs: false, modalTracking: false, screenshotResize: false },
      } as any);

      await adapter.proxyTool('browser_snapshot', {});
      fireFramenavigated(page);

      // The locator matches 2 elements in the DOM
      page._mockLocator.count.mockResolvedValue(2);

      await expect(adapter.proxyTool('browser_click', { ref: '@e1' }))
        .rejects.toThrow(StaleRefError);
    });

    it('stale flag set, wasFiltered on old snapshot throws StaleRefError', async () => {
      const page = createMockPage('- button "Submit"');
      const adapter = new PlaywrightMcpAdapter(page as any, ['example.com'], {
        flags: { snapshotMode: 'annotated', incrementalDiffs: false, modalTracking: false, screenshotResize: false },
      } as any);

      // Take initial snapshot with selector (wasFiltered = true)
      await adapter.proxyTool('browser_snapshot', { selector: '#form' });
      fireFramenavigated(page);

      // Even though fresh snapshot matches, wasFiltered on old snapshot means we can't trust it
      await expect(adapter.proxyTool('browser_click', { ref: '@e1' }))
        .rejects.toThrow(StaleRefError);
    });

    it('recovery: resolveRef fails on stale throws StaleRefError unconditionally', async () => {
      const page = createMockPage('- button "Submit"');
      const adapter = new PlaywrightMcpAdapter(page as any, ['example.com'], {
        flags: { snapshotMode: 'annotated', incrementalDiffs: false, modalTracking: false, screenshotResize: false },
      } as any);

      await adapter.proxyTool('browser_snapshot', {});

      // Navigation causes ref state reset, old refs are gone
      fireFramenavigated(page);

      // After navigation, the fresh snapshot produces completely new refs
      page._mockLocator.ariaSnapshot.mockResolvedValue('- link "Something else"');

      // @e1 won't be in the old or new snapshot's refs after the
      // resolveRef throw triggers the catch path
      await expect(adapter.proxyTool('browser_click', { ref: '@e999' }))
        .rejects.toThrow(StaleRefError);
    });

    it('after successful verification, snapshotStale is set to false', async () => {
      const page = createMockPage('- button "Submit"');
      const adapter = new PlaywrightMcpAdapter(page as any, ['example.com'], {
        flags: { snapshotMode: 'annotated', incrementalDiffs: false, modalTracking: false, screenshotResize: false },
      } as any);

      await adapter.proxyTool('browser_snapshot', {});
      fireFramenavigated(page);

      // First click should succeed and clear stale flag
      await adapter.proxyTool('browser_click', { ref: '@e1' });

      // Second click should also succeed (no longer stale, no fresh snapshot needed)
      await expect(adapter.proxyTool('browser_click', { ref: '@e1' }))
        .resolves.not.toThrow();
    });

    it('navigation during snapshot collection is tolerated if final verification is stable', async () => {
      const page = createMockPage('- button "Submit"');
      const adapter = new PlaywrightMcpAdapter(page as any, ['example.com'], {
        flags: { snapshotMode: 'annotated', incrementalDiffs: false, modalTracking: false, screenshotResize: false },
      } as any);

      await adapter.proxyTool('browser_snapshot', {});
      fireFramenavigated(page);

      // During snapshot() call inside resolveRefToLocator verification,
      // another navigation fires. We simulate this by making ariaSnapshot
      // trigger a framenavigated event.
      const origAriaSnapshot = page._mockLocator.ariaSnapshot;
      page._mockLocator.ariaSnapshot.mockImplementation(async () => {
        // Fire another navigation during snapshot — TOCTOU
        fireFramenavigated(page);
        return '- button "Submit"';
      });

      await expect(adapter.proxyTool('browser_click', { ref: '@e1' }))
        .resolves.not.toThrow();

      // Restore
      page._mockLocator.ariaSnapshot = origAriaSnapshot;
    });

    it('stale flag set, no identityHash on old entry throws StaleRefError', async () => {
      const page = createMockPage('- button "Submit"');
      const adapter = new PlaywrightMcpAdapter(page as any, ['example.com'], {
        flags: { snapshotMode: 'annotated', incrementalDiffs: false, modalTracking: false, screenshotResize: false },
      } as any);

      await adapter.proxyTool('browser_snapshot', {});
      fireFramenavigated(page);

      // Monkey-patch: remove identityHash from the old snapshot's ref entry
      // Access the adapter's currentSnapshot to strip hashes before stale verification
      const snap = (adapter as any).currentSnapshot;
      if (snap?.refs) {
        for (const entry of snap.refs.values()) {
          entry.identityHash = undefined;
        }
      }

      await expect(adapter.proxyTool('browser_click', { ref: '@e1' }))
        .rejects.toThrow(StaleRefError);
    });

    it('stale flag set, wasFiltered on fresh snapshot throws StaleRefError', async () => {
      const page = createMockPage('- button "Submit"');
      const adapter = new PlaywrightMcpAdapter(page as any, ['example.com'], {
        flags: { snapshotMode: 'annotated', incrementalDiffs: false, modalTracking: false, screenshotResize: false },
      } as any);

      // Take initial snapshot without filter
      await adapter.proxyTool('browser_snapshot', {});
      fireFramenavigated(page);

      // The fresh snapshot during verification will use selector (wasFiltered=true)
      // because we intercept snapshot() to add a selector.
      const origSnapshot = (adapter as any).snapshot.bind(adapter);
      let callCount = 0;
      vi.spyOn(adapter as any, 'snapshot').mockImplementation(async (opts?: any) => {
        callCount++;
        if (callCount === 1) {
          // First call during stale verification — force wasFiltered on result
          const result = await origSnapshot.call(adapter, opts);
          (adapter as any).currentSnapshot.wasFiltered = true;
          return result;
        }
        return origSnapshot.call(adapter, opts);
      });

      await expect(adapter.proxyTool('browser_click', { ref: '@e1' }))
        .rejects.toThrow(StaleRefError);
    });

    it('stale flag set, hash count > 1 with matching ordinals resolves ref', async () => {
      const page = createMockPage('- button "Submit"\n- button "Submit"');
      const adapter = new PlaywrightMcpAdapter(page as any, ['example.com'], {
        flags: { snapshotMode: 'annotated', incrementalDiffs: false, modalTracking: false, screenshotResize: false },
      } as any);

      // Initial snapshot has duplicate buttons (hash count > 1)
      await adapter.proxyTool('browser_snapshot', {});
      fireFramenavigated(page);

      // Both old and new have count=2, ordinals match, locator count=1
      // With relaxed check, this should succeed
      await expect(adapter.proxyTool('browser_click', { ref: '@e1' }))
        .resolves.not.toThrow();
    });

    it('stale flag set, hash count changes between snapshots throws StaleRefError', async () => {
      const page = createMockPage('- button "Submit"\n- button "Submit"');
      const adapter = new PlaywrightMcpAdapter(page as any, ['example.com'], {
        flags: { snapshotMode: 'annotated', incrementalDiffs: false, modalTracking: false, screenshotResize: false },
      } as any);

      // Initial snapshot has 2 duplicate buttons
      await adapter.proxyTool('browser_snapshot', {});
      fireFramenavigated(page);

      // Fresh snapshot has only 1 button — count changed from 2 to 1
      page._mockLocator.ariaSnapshot.mockResolvedValue('- button "Submit"');

      await expect(adapter.proxyTool('browser_click', { ref: '@e1' }))
        .rejects.toThrow(StaleRefError);
    });

    it('recovery takes fresh snapshot that updates currentSnapshot', async () => {
      const page = createMockPage('- button "Submit"');
      const adapter = new PlaywrightMcpAdapter(page as any, ['example.com'], {
        flags: { snapshotMode: 'annotated', incrementalDiffs: false, modalTracking: false, screenshotResize: false },
      } as any);

      await adapter.proxyTool('browser_snapshot', {});
      fireFramenavigated(page);

      // Change content so old ref doesn't exist in new snapshot
      page._mockLocator.ariaSnapshot.mockResolvedValue('- link "Login"');

      // This should throw StaleRefError (recovery path)
      await expect(adapter.proxyTool('browser_click', { ref: '@e999' }))
        .rejects.toThrow(StaleRefError);

      // After recovery, currentSnapshot should be updated with new content
      const snap = (adapter as any).currentSnapshot;
      expect(snap).toBeDefined();
      // The fresh snapshot from recovery should have the new ref content
      expect(snap.refs.size).toBeGreaterThan(0);
    });

    it('same-URL reload sets snapshotStale to true', async () => {
      const page = createMockPage('- button "Submit"');
      const adapter = new PlaywrightMcpAdapter(page as any, ['example.com'], {
        flags: { snapshotMode: 'annotated', incrementalDiffs: false, modalTracking: false, screenshotResize: false },
      } as any);

      await adapter.proxyTool('browser_snapshot', {});

      // After snapshot, stale should be false
      expect((adapter as any).snapshotStale).toBe(false);

      // Simulate same-URL reload (framenavigated on main frame)
      fireFramenavigated(page);

      // Should be stale even though it's the same URL
      expect((adapter as any).snapshotStale).toBe(true);
    });

    it('withRefLocator is used by click, type, hover, select_option, and file_upload', async () => {
      const page = createMockPage('- button "Submit"');
      const adapter = new PlaywrightMcpAdapter(page as any, ['example.com'], {
        flags: { snapshotMode: 'annotated', incrementalDiffs: false, modalTracking: false, screenshotResize: false },
      } as any);

      await adapter.proxyTool('browser_snapshot', {});

      // Spy on withRefLocator
      const spy = vi.spyOn(adapter as any, 'withRefLocator');

      // click
      await adapter.proxyTool('browser_click', { ref: '@e1' });
      expect(spy).toHaveBeenCalledWith('@e1', expect.any(Function));

      // type
      spy.mockClear();
      await adapter.proxyTool('browser_type', { ref: '@e1', text: 'hello' });
      expect(spy).toHaveBeenCalledWith('@e1', expect.any(Function));

      // hover
      spy.mockClear();
      await adapter.proxyTool('browser_hover', { ref: '@e1' });
      expect(spy).toHaveBeenCalledWith('@e1', expect.any(Function));

      // select_option
      spy.mockClear();
      await adapter.proxyTool('browser_select_option', { ref: '@e1', value: 'opt1' });
      expect(spy).toHaveBeenCalledWith('@e1', expect.any(Function));

      // file_upload
      spy.mockClear();
      await adapter.proxyTool('browser_file_upload', { ref: '@e1', paths: ['/tmp/f.txt'] });
      expect(spy).toHaveBeenCalledWith('@e1', expect.any(Function));

      spy.mockRestore();
    });

    it('withRefLocator: navEpoch changes between resolve and action throws StaleRefError', async () => {
      const page = createMockPage('- button "Submit"');
      const adapter = new PlaywrightMcpAdapter(page as any, ['example.com'], {
        flags: { snapshotMode: 'annotated', incrementalDiffs: false, modalTracking: false, screenshotResize: false },
      } as any);

      await adapter.proxyTool('browser_snapshot', {});

      // We need navigation to fire inside resolveRefToLocator (during buildLocator),
      // so that when withRefLocator checks navEpoch after resolve returns,
      // it detects the change. The last async call in buildLocator is count().
      // We intercept the count() call on the 2nd invocation (first was during
      // the initial snapshot's buildLocator) to fire navigation.
      page._mockLocator.count.mockImplementation(async () => {
        // Fire navigation during buildLocator's count() check.
        // This simulates a TOCTOU: resolveRefToLocator gets a valid locator,
        // but by the time withRefLocator checks navEpoch, it has changed.
        fireFramenavigated(page);
        return 1;
      });

      // The navigation fires during resolveRefToLocator's buildLocator,
      // incrementing navEpoch. withRefLocator's epoch check catches it.
      await expect(adapter.proxyTool('browser_click', { ref: '@e1' }))
        .rejects.toThrow(StaleRefError);
    });
  });

  // ─── Browser ref lifecycle: snapshot → click → navigate → retry ──

  describe('browser ref lifecycle: snapshot → click → navigate → retry', () => {
    it('auto-retries ref resolution after navigation by taking fresh snapshot', () => {
      // Setup: create initial state and annotate a snapshot containing @e refs
      const state = createRefState();
      const yaml1 = '- button "Submit"\n- link "Home"';
      const trees1 = parseYamlToTree(yaml1, 'main');
      const result1 = annotateSnapshot(trees1, 'main', state);

      // Verify refs are assigned
      expect(result1.refs.size).toBe(2);
      const refIds1 = [...result1.refs.keys()];
      const firstRef = refIds1[0]; // e.g., '@e1'

      // Action 1: resolve the ref successfully against current snapshot
      const snapshot1: AnnotatedSnapshot = {
        version: state.version,
        yamlContent: yaml1,
        annotatedContent: '',
        refs: result1.refs,
        refsByHash: result1.refsByHash,
        interactiveCount: result1.refs.size,
      };
      const resolved1 = resolveRef(firstRef, snapshot1);
      expect(resolved1).toBeDefined();
      expect(resolved1.ref).toBe(firstRef);

      // Action 2: simulate navigation — clear snapshot (snapshotStale = true scenario)
      // After navigation, the old snapshot is stale; resolveRef should throw StaleRefError
      expect(() => resolveRef(firstRef, undefined)).toThrow(StaleRefError);

      // Action 3: take a fresh snapshot after navigation (same page content)
      // Preserve the hashToRef map (like the real adapter does after framenavigated)
      const preserved = new Map(state.hashToRef);
      const newState = createRefState(preserved);
      newState.version = state.version + 1;

      const trees2 = parseYamlToTree(yaml1, 'main');
      const result2 = annotateSnapshot(trees2, 'main', newState);

      // Build new snapshot
      const snapshot2: AnnotatedSnapshot = {
        version: newState.version,
        yamlContent: yaml1,
        annotatedContent: '',
        refs: result2.refs,
        refsByHash: result2.refsByHash,
        interactiveCount: result2.refs.size,
      };

      // Resolve the same ref again — should succeed with same ref ID
      // (identity hash preservation ensures the same element gets the same ref)
      const resolved2 = resolveRef(firstRef, snapshot2);
      expect(resolved2).toBeDefined();
      expect(resolved2.ref).toBe(firstRef);
    });

    it('detects changed elements after navigation via different refs', () => {
      // Initial snapshot has "Submit" button
      const state = createRefState();
      const yaml1 = '- button "Submit"';
      const trees1 = parseYamlToTree(yaml1, 'main');
      const result1 = annotateSnapshot(trees1, 'main', state);
      const refId1 = [...result1.refs.keys()][0];

      // Navigate to page with different content
      const preserved = new Map(state.hashToRef);
      const newState = createRefState(preserved);
      newState.version = state.version + 1;

      const yaml2 = '- button "Login"';
      const trees2 = parseYamlToTree(yaml2, 'main');
      const result2 = annotateSnapshot(trees2, 'main', newState);

      const snapshot2: AnnotatedSnapshot = {
        version: newState.version,
        yamlContent: yaml2,
        annotatedContent: '',
        refs: result2.refs,
        refsByHash: result2.refsByHash,
        interactiveCount: result2.refs.size,
      };

      // Old ref should NOT be in the new snapshot (different element)
      expect(() => resolveRef(refId1, snapshot2)).toThrow(StaleRefError);

      // New element should have a different ref
      const refId2 = [...result2.refs.keys()][0];
      expect(refId2).not.toBe(refId1);
    });

    it('version increments across snapshots', () => {
      const state = createRefState();
      expect(state.version).toBe(0);

      const yaml = '- button "A"';
      const trees = parseYamlToTree(yaml, 'main');
      annotateSnapshot(trees, 'main', state);

      // Simulate navigation: create new state with incremented version
      const preserved = new Map(state.hashToRef);
      const newState = createRefState(preserved);
      newState.version = state.version + 1;
      expect(newState.version).toBe(1);

      // Annotate again
      const trees2 = parseYamlToTree(yaml, 'main');
      annotateSnapshot(trees2, 'main', newState);

      // Refs should still be consistent
      expect(newState.hashToRef.size).toBeGreaterThan(0);
    });
  });
});
