import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthCoordinator } from '../../src/browser/auth-coordinator.js';
import type { AuthParticipant } from '../../src/browser/auth-coordinator.js';

vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('AuthCoordinator', () => {
  let coordinator: AuthCoordinator;

  beforeEach(() => {
    coordinator = new AuthCoordinator();
  });

  function makeParticipant(id: string, siteId: string): AuthParticipant {
    return {
      id,
      siteId,
      lastSeenAuthVersion: 0,
      onAuthChanged: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('registers and unregisters participants', () => {
    coordinator.register(makeParticipant('a', 'site1'));
    expect(coordinator.size).toBe(1);
    coordinator.unregister('a');
    expect(coordinator.size).toBe(0);
  });

  it('notifies peers but not the origin', async () => {
    const p1 = makeParticipant('explore:default:site1', 'site1');
    const p2 = makeParticipant('exec-ab:site1', 'site1');
    coordinator.register(p1);
    coordinator.register(p2);

    await coordinator.publish({
      siteId: 'site1',
      version: 2,
      originId: 'explore:default:site1',
    });

    expect(p1.onAuthChanged).not.toHaveBeenCalled();
    expect(p2.onAuthChanged).toHaveBeenCalledWith('site1', 2);
  });

  it('does not notify participants for different sites', async () => {
    const p1 = makeParticipant('explore:default:site1', 'site1');
    const p2 = makeParticipant('explore:default:site2', 'site2');
    coordinator.register(p1);
    coordinator.register(p2);

    await coordinator.publish({ siteId: 'site1', version: 1, originId: 'system:import' });

    expect(p1.onAuthChanged).toHaveBeenCalled();
    expect(p2.onAuthChanged).not.toHaveBeenCalled();
  });

  it('system origin notifies ALL participants for the site', async () => {
    const p1 = makeParticipant('explore:default:site1', 'site1');
    const p2 = makeParticipant('exec-ab:site1', 'site1');
    coordinator.register(p1);
    coordinator.register(p2);

    await coordinator.publish({
      siteId: 'site1',
      version: 3,
      originId: 'system:import',
    });

    expect(p1.onAuthChanged).toHaveBeenCalled();
    expect(p2.onAuthChanged).toHaveBeenCalled();
  });

  it('rebindParticipant resets version to 0', () => {
    const p = makeParticipant('explore:default:site1', 'site1');
    p.lastSeenAuthVersion = 5;
    coordinator.register(p);

    coordinator.rebindParticipant('explore:default:site1', 'site2');

    const updated = coordinator.getParticipant('explore:default:site1');
    expect(updated?.siteId).toBe('site2');
    expect(updated?.lastSeenAuthVersion).toBe(0);
  });

  it('handles notification errors gracefully', async () => {
    const p1 = makeParticipant('p1', 'site1');
    (p1.onAuthChanged as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    const p2 = makeParticipant('p2', 'site1');
    coordinator.register(p1);
    coordinator.register(p2);

    // Should not throw even if p1 fails
    await coordinator.publish({ siteId: 'site1', version: 1, originId: 'system:import' });
    expect(p2.onAuthChanged).toHaveBeenCalled();
  });

  it('getParticipantsForSite returns only matching participants', () => {
    coordinator.register(makeParticipant('a', 'site1'));
    coordinator.register(makeParticipant('b', 'site1'));
    coordinator.register(makeParticipant('c', 'site2'));

    const site1Participants = coordinator.getParticipantsForSite('site1');
    expect(site1Participants).toHaveLength(2);
    expect(site1Participants.map(p => p.id).sort()).toEqual(['a', 'b']);
  });

  it('rebindParticipant is no-op for unknown id', () => {
    coordinator.rebindParticipant('unknown-id', 'site2');
    expect(coordinator.size).toBe(0);
  });

  it('publish is no-op when no peers exist', async () => {
    // Should not throw
    await coordinator.publish({ siteId: 'site1', version: 1, originId: 'system:import' });
  });
});
