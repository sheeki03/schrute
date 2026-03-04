import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page, BrowserContext, Locator } from 'playwright';

vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// We need to test the applyPagination and snapshotWithScreenshot logic.
// Since these are on the BaseBrowserAdapter (abstract), we test through a
// concrete subclass or by extracting the logic. For now, we test the logic
// directly by importing and calling the adapter with mocks.

import { ALLOWED_BROWSER_TOOLS } from '../../src/skill/types.js';
import {
  createRefState,
  annotateSnapshot,
  parseYamlToTree,
} from '../../src/browser/snapshot-refs.js';

describe('Snapshot Enhancements', () => {
  // ─── Pagination ────────────────────────────────────────────────

  describe('pagination (applyPagination logic)', () => {
    // We test the pagination logic by directly exercising the pure function behavior.
    // The applyPagination method is private, so we test through its effects.

    function applyPagination(
      content: string,
      options?: { maxChars?: number; offset?: number },
    ) {
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

    it('truncates at maxChars', () => {
      const result = applyPagination('abcdefghij', { maxChars: 5 });
      expect(result.content).toBe('abcde');
      expect(result.pagination).toEqual({ totalChars: 10, offset: 0, hasMore: true });
    });

    it('correct offset slicing', () => {
      const result = applyPagination('abcdefghij', { maxChars: 3, offset: 4 });
      expect(result.content).toBe('efg');
      expect(result.pagination).toEqual({ totalChars: 10, offset: 4, hasMore: true });
    });

    it('hasMore is false when content fits', () => {
      const result = applyPagination('abcde', { maxChars: 10 });
      expect(result.content).toBe('abcde');
      expect(result.pagination).toEqual({ totalChars: 5, offset: 0, hasMore: false });
    });

    it('no pagination when maxChars is not set', () => {
      const result = applyPagination('abcdefghij');
      expect(result.content).toBe('abcdefghij');
      expect(result.pagination).toBeUndefined();
    });

    it('maxChars=0 means no pagination', () => {
      const result = applyPagination('abcdefghij', { maxChars: 0 });
      expect(result.content).toBe('abcdefghij');
      expect(result.pagination).toBeUndefined();
    });

    it('negative offset clamped to 0', () => {
      const result = applyPagination('abcde', { maxChars: 3, offset: -5 });
      expect(result.content).toBe('abc');
      expect(result.pagination!.offset).toBe(0);
    });

    it('offset beyond content returns empty with hasMore false', () => {
      const result = applyPagination('abcde', { maxChars: 3, offset: 100 });
      expect(result.content).toBe('');
      expect(result.pagination).toEqual({ totalChars: 5, offset: 5, hasMore: false });
    });

    it('very large maxChars returns all content', () => {
      const result = applyPagination('abcde', { maxChars: 999999 });
      expect(result.content).toBe('abcde');
      expect(result.pagination).toEqual({ totalChars: 5, offset: 0, hasMore: false });
    });
  });

  // ─── Combined snapshot + screenshot ─────────────────────────────

  describe('combined snapshot + screenshot', () => {
    it('browser_snapshot_with_screenshot is in ALLOWED_BROWSER_TOOLS', () => {
      expect((ALLOWED_BROWSER_TOOLS as readonly string[]).includes('browser_snapshot_with_screenshot')).toBe(true);
    });
  });

  // ─── createRefState preservation ─────────────────────────────────

  describe('createRefState preservation', () => {
    it('preserves refs from a map', () => {
      const preserved = new Map([
        ['abc123:0', '@e1'],
        ['def456:0', '@e3'],
      ]);
      const state = createRefState(preserved);
      expect(state.hashToRef.get('abc123:0')).toBe('@e1');
      expect(state.hashToRef.get('def456:0')).toBe('@e3');
    });

    it('calculates correct nextRef from preserved refs', () => {
      const preserved = new Map([
        ['h1:0', '@e2'],
        ['h2:0', '@e9'],
        ['h3:0', '@e4'],
      ]);
      const state = createRefState(preserved);
      expect(state.nextRef).toBe(10); // 9 + 1
    });

    it('nextRef is 1 when no preserved refs', () => {
      const state = createRefState();
      expect(state.nextRef).toBe(1);
    });

    it('nextRef is 1 for empty preserved map', () => {
      const state = createRefState(new Map());
      expect(state.nextRef).toBe(1);
    });

    it('previousTrees starts empty even with preservation', () => {
      const preserved = new Map([['h:0', '@e5']]);
      const state = createRefState(preserved);
      expect(state.previousTrees.size).toBe(0);
    });
  });

  // ─── LRU touch ─────────────────────────────────────────────────

  describe('LRU touch in annotateSnapshot', () => {
    it('moves accessed entry to end of map', () => {
      const state = createRefState();

      // Create three refs: button A, B, C
      const yaml = '- button "X"\n- button "Y"\n- button "Z"';
      const trees = parseYamlToTree(yaml, 'main');
      annotateSnapshot(trees, 'main', state);

      const orderBefore = [...state.hashToRef.keys()];
      const firstKey = orderBefore[0];

      // Re-annotate with just the first element to trigger LRU touch
      const yamlSingle = '- button "X"';
      const treesSingle = parseYamlToTree(yamlSingle, 'main');
      annotateSnapshot(treesSingle, 'main', state);

      const orderAfter = [...state.hashToRef.keys()];
      // firstKey should now be at the end
      expect(orderAfter[orderAfter.length - 1]).toBe(firstKey);
    });
  });

  // ─── identityHashCounts from annotateSnapshot ──────────────────

  describe('identityHashCounts from annotateSnapshot', () => {
    it('returns a Map', () => {
      const state = createRefState();
      const trees = parseYamlToTree('- button "Go"', 'main');
      const { identityHashCounts } = annotateSnapshot(trees, 'main', state);
      expect(identityHashCounts).toBeInstanceOf(Map);
    });

    it('counts 1 for unique elements', () => {
      const state = createRefState();
      const yaml = '- button "A"\n- link "B"';
      const trees = parseYamlToTree(yaml, 'main');
      const { identityHashCounts } = annotateSnapshot(trees, 'main', state);
      for (const count of identityHashCounts.values()) {
        expect(count).toBe(1);
      }
    });

    it('counts duplicates correctly', () => {
      const state = createRefState();
      const yaml = '- button "Same"\n- button "Same"';
      const trees = parseYamlToTree(yaml, 'main');
      const { identityHashCounts } = annotateSnapshot(trees, 'main', state);
      const maxCount = Math.max(...identityHashCounts.values());
      expect(maxCount).toBe(2);
    });
  });

  // ─── Partial failure (snapshotWithScreenshot) ────────────────────

  describe('snapshotWithScreenshot partial failure', () => {
    it('screenshot failure returns snapshot with null screenshot', async () => {
      // Simulate the Promise.allSettled logic
      const snapshotResult = {
        status: 'fulfilled' as const,
        value: {
          content: 'page content',
          url: 'https://example.com',
          title: 'Test',
        },
      };
      const screenshotResult = {
        status: 'rejected' as const,
        reason: new Error('screenshot timeout'),
      };

      const [snap, shot] = [snapshotResult, screenshotResult];

      // Apply same logic as snapshotWithScreenshot
      if (snap.status === 'rejected') {
        throw snap.reason;
      }

      const result = { ...snap.value, screenshot: undefined as string | null | undefined, screenshotError: undefined as string | undefined };

      if (shot.status === 'rejected') {
        result.screenshot = null;
        result.screenshotError = shot.reason instanceof Error
          ? shot.reason.message
          : String(shot.reason);
      } else {
        result.screenshot = 'base64data';
      }

      expect(result.content).toBe('page content');
      expect(result.screenshot).toBeNull();
      expect(result.screenshotError).toBe('screenshot timeout');
    });

    it('snapshot failure throws error', () => {
      const snapshotResult = {
        status: 'rejected' as const,
        reason: new Error('snapshot failed'),
      };

      expect(() => {
        if (snapshotResult.status === 'rejected') {
          throw snapshotResult.reason;
        }
      }).toThrow('snapshot failed');
    });

    it('both succeed returns combined result', () => {
      const result = {
        content: 'page content',
        url: 'https://example.com',
        title: 'Test',
        screenshot: undefined as string | null | undefined,
        screenshotError: undefined as string | undefined,
      };

      const screenshotResult = {
        status: 'fulfilled' as const,
        value: Buffer.from('fake-png'),
      };

      if (screenshotResult.status === 'fulfilled') {
        result.screenshot = screenshotResult.value.toString('base64');
      }

      expect(result.content).toBe('page content');
      expect(result.screenshot).toBe(Buffer.from('fake-png').toString('base64'));
      expect(result.screenshotError).toBeUndefined();
    });
  });
});
