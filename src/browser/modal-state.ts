import { EventEmitter } from 'node:events';
import { getLogger } from '../core/logger.js';

const log = getLogger();

// ─── Modal State Tracking ───────────────────────────────────────
// Tracks native Playwright dialog/filechooser events (NOT HTML/CSS modals).
// Prevents tools from executing in invalid states with TTL-based recovery.

export type ModalType = 'dialog' | 'fileChooser';

export interface ModalState {
  type: ModalType;
  description: string;
  clearedBy: string;
  data: unknown;
  createdAt: number;
  ttlMs: number;
  handled: boolean;
}

/** Maps tool names to the modal type they clear */
export const MODAL_CLEARING_TOOLS: Record<string, ModalType> = {
  'browser_handle_dialog': 'dialog',
  'browser_file_upload': 'fileChooser',
};

export class ModalStateTracker extends EventEmitter {
  private states: ModalState[] = [];

  add(state: ModalState): void {
    this.states.push(state);
    this.emit('modal', state);
  }

  clear(type: ModalType): void {
    this.states = this.states.filter(s => s.type !== type);
  }

  getActive(): ModalState[] {
    return [...this.states];
  }

  hasActive(): boolean {
    return this.states.length > 0;
  }

  /**
   * Get modal states that would block a given tool.
   * A tool is blocked if there are active modals and it doesn't clear any of them.
   */
  getBlockingStates(toolName: string): ModalState[] {
    const clearsModal = MODAL_CLEARING_TOOLS[toolName];
    if (clearsModal) {
      // This tool clears a modal type — not blocked
      return [];
    }
    return [...this.states];
  }

  /**
   * Remove expired modals (TTL exceeded).
   * Called synchronously at the start of every proxyTool() call.
   * For dialogs, attempts to auto-dismiss before clearing.
   */
  pruneExpired(): ModalState[] {
    const now = Date.now();
    const expired: ModalState[] = [];
    const remaining: ModalState[] = [];

    for (const modal of this.states) {
      if (now - modal.createdAt > modal.ttlMs) {
        expired.push(modal);

        // Auto-dismiss unhandled dialogs
        if (modal.type === 'dialog' && !modal.handled && modal.data) {
          try {
            const dialog = modal.data as { dismiss: () => Promise<void> };
            dialog.dismiss().catch((err) => log.debug({ err }, 'Dialog dismiss failed'));
          } catch {
            // Best-effort
          }
        }

        log.warn(
          { type: modal.type, description: modal.description },
          'Auto-cleared stale modal state (TTL expired)',
        );
      } else {
        remaining.push(modal);
      }
    }

    this.states = remaining;
    return expired;
  }

  /**
   * Clear dialog states on navigation events.
   * Native JS dialogs are dismissed by navigation.
   */
  clearOnNavigation(): void {
    const hadDialogs = this.states.some(s => s.type === 'dialog');
    this.states = this.states.filter(s => s.type !== 'dialog');
    if (hadDialogs) {
      log.info('Cleared dialog modal states on navigation');
    }
  }

  /**
   * Mark a dialog as handled (accept/dismiss was called successfully).
   */
  markHandled(type: ModalType): void {
    for (const state of this.states) {
      if (state.type === type) {
        state.handled = true;
      }
    }
  }

  /**
   * Generate a description of active modal states for snapshot content.
   */
  describeActive(): string {
    if (this.states.length === 0) return '';
    return this.states
      .map(s => `[MODAL] "${s.type}": ${s.description} — handle with ${s.clearedBy}`)
      .join('\n');
  }
}

/**
 * Race an action against modal state appearance.
 * If a modal appears mid-action, resolves immediately with the modal states.
 * The underlying Playwright action continues running but its result is discarded.
 */
export async function raceAgainstModals<T>(
  tracker: ModalStateTracker,
  action: () => Promise<T>,
): Promise<T | ModalState[]> {
  if (tracker.hasActive()) return tracker.getActive();

  return new Promise((resolve, reject) => {
    let settled = false;

    const onModal = (modal: ModalState) => {
      if (settled) return;
      settled = true;
      resolve([modal]);
    };

    tracker.once('modal', onModal);

    action()
      .then(result => {
        if (settled) return;
        settled = true;
        tracker.off('modal', onModal);
        resolve(result);
      })
      .catch(err => {
        if (settled) return;
        settled = true;
        tracker.off('modal', onModal);
        reject(err);
      });
  });
}
