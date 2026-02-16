import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModalStateTracker, raceAgainstModals, MODAL_CLEARING_TOOLS } from '../../src/browser/modal-state.js';
import type { ModalState } from '../../src/browser/modal-state.js';

vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function createModal(overrides: Partial<ModalState> = {}): ModalState {
  return {
    type: 'dialog',
    description: 'test dialog',
    clearedBy: 'browser_handle_dialog',
    data: { dismiss: vi.fn().mockResolvedValue(undefined) },
    createdAt: Date.now(),
    ttlMs: 30_000,
    handled: false,
    ...overrides,
  };
}

describe('ModalStateTracker', () => {
  let tracker: ModalStateTracker;

  beforeEach(() => {
    tracker = new ModalStateTracker();
  });

  describe('add/clear lifecycle', () => {
    it('adds and retrieves active modals', () => {
      const modal = createModal();
      tracker.add(modal);

      expect(tracker.hasActive()).toBe(true);
      expect(tracker.getActive()).toHaveLength(1);
      expect(tracker.getActive()[0].type).toBe('dialog');
    });

    it('clears modals by type', () => {
      tracker.add(createModal({ type: 'dialog' }));
      tracker.add(createModal({ type: 'fileChooser', clearedBy: 'browser_file_upload' }));

      tracker.clear('dialog');
      expect(tracker.getActive()).toHaveLength(1);
      expect(tracker.getActive()[0].type).toBe('fileChooser');
    });

    it('emits modal event on add', () => {
      const listener = vi.fn();
      tracker.on('modal', listener);

      const modal = createModal();
      tracker.add(modal);

      expect(listener).toHaveBeenCalledWith(modal);
    });
  });

  describe('blocking', () => {
    it('regular tool is blocked by active modal', () => {
      tracker.add(createModal());
      expect(tracker.getBlockingStates('browser_click')).toHaveLength(1);
    });

    it('clearing tool is not blocked', () => {
      tracker.add(createModal());
      expect(tracker.getBlockingStates('browser_handle_dialog')).toHaveLength(0);
    });

    it('non-clearing tool blocked when fileChooser active', () => {
      tracker.add(createModal({ type: 'fileChooser', clearedBy: 'browser_file_upload' }));
      expect(tracker.getBlockingStates('browser_click')).toHaveLength(1);
    });
  });

  describe('TTL expiry', () => {
    it('prunes expired modals', () => {
      const modal = createModal({
        createdAt: Date.now() - 60_000,
        ttlMs: 30_000,
      });
      tracker.add(modal);

      const expired = tracker.pruneExpired();
      expect(expired).toHaveLength(1);
      expect(tracker.hasActive()).toBe(false);
    });

    it('does not prune non-expired modals', () => {
      tracker.add(createModal({ createdAt: Date.now(), ttlMs: 30_000 }));

      const expired = tracker.pruneExpired();
      expect(expired).toHaveLength(0);
      expect(tracker.hasActive()).toBe(true);
    });

    it('auto-dismisses unhandled dialogs on expiry', () => {
      const dismiss = vi.fn().mockResolvedValue(undefined);
      const modal = createModal({
        createdAt: Date.now() - 60_000,
        ttlMs: 30_000,
        data: { dismiss },
      });
      tracker.add(modal);

      tracker.pruneExpired();
      expect(dismiss).toHaveBeenCalled();
    });
  });

  describe('navigation clearing', () => {
    it('clears dialog states on navigation', () => {
      tracker.add(createModal({ type: 'dialog' }));
      tracker.add(createModal({ type: 'fileChooser', clearedBy: 'browser_file_upload' }));

      tracker.clearOnNavigation();

      expect(tracker.getActive()).toHaveLength(1);
      expect(tracker.getActive()[0].type).toBe('fileChooser');
    });
  });

  describe('markHandled', () => {
    it('marks dialog as handled', () => {
      const modal = createModal();
      tracker.add(modal);

      tracker.markHandled('dialog');
      expect(tracker.getActive()[0].handled).toBe(true);
    });
  });

  describe('describeActive', () => {
    it('returns empty string when no modals', () => {
      expect(tracker.describeActive()).toBe('');
    });

    it('describes active modals', () => {
      tracker.add(createModal({ description: 'Are you sure?' }));
      const desc = tracker.describeActive();
      expect(desc).toContain('[MODAL]');
      expect(desc).toContain('Are you sure?');
      expect(desc).toContain('browser_handle_dialog');
    });
  });

  describe('multiple simultaneous modals', () => {
    it('tracks multiple modals', () => {
      tracker.add(createModal({ type: 'dialog' }));
      tracker.add(createModal({ type: 'fileChooser', clearedBy: 'browser_file_upload' }));

      expect(tracker.getActive()).toHaveLength(2);
    });
  });
});

describe('raceAgainstModals', () => {
  it('returns action result when no modal appears', async () => {
    const tracker = new ModalStateTracker();
    const result = await raceAgainstModals(tracker, async () => 'done');
    expect(result).toBe('done');
  });

  it('returns modal state when modal appears during action', async () => {
    const tracker = new ModalStateTracker();

    const result = await raceAgainstModals(tracker, () => {
      return new Promise<string>((resolve) => {
        // Simulate modal appearing before action completes
        setTimeout(() => {
          tracker.add(createModal());
        }, 10);
        setTimeout(() => resolve('done'), 100);
      });
    });

    expect(Array.isArray(result)).toBe(true);
    expect((result as any[])[0].type).toBe('dialog');
  });

  it('returns existing modals immediately', async () => {
    const tracker = new ModalStateTracker();
    tracker.add(createModal());

    const result = await raceAgainstModals(tracker, async () => 'done');
    expect(Array.isArray(result)).toBe(true);
  });

  it('cleans up listener on action rejection', async () => {
    const tracker = new ModalStateTracker();

    await expect(
      raceAgainstModals(tracker, async () => {
        throw new Error('action failed');
      }),
    ).rejects.toThrow('action failed');
  });
});
