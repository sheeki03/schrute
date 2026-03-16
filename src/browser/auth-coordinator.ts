import { getLogger } from '../core/logger.js';

const log = getLogger();

export interface AuthParticipant {
  id: string;
  siteId: string;
  lastSeenAuthVersion: number;
  onAuthChanged(siteId: string, newVersion: number): Promise<void>;
}

interface AuthPublishEvent {
  siteId: string;
  version: number;
  originId: string;
  reason?: string;
}

/**
 * Identity-based pub/sub for auth state changes.
 * Each live browser participant registers with a unique identity.
 * On auth update, the publisher broadcasts to all peers EXCEPT itself.
 */
export class AuthCoordinator {
  private participants = new Map<string, AuthParticipant>();

  register(participant: AuthParticipant): void {
    this.participants.set(participant.id, participant);
    log.debug({ participantId: participant.id, siteId: participant.siteId }, 'Auth participant registered');
  }

  /**
   * Rebind a participant to a new siteId. Resets lastSeenAuthVersion to 0
   * so the safety-net version check forces a reload from the new site's store.
   */
  rebindParticipant(id: string, newSiteId: string): void {
    const p = this.participants.get(id);
    if (p) {
      p.siteId = newSiteId;
      p.lastSeenAuthVersion = 0;
      log.debug({ participantId: id, newSiteId }, 'Auth participant rebound');
    }
  }

  unregister(id: string): void {
    this.participants.delete(id);
    log.debug({ participantId: id }, 'Auth participant unregistered');
  }

  /**
   * Publish an auth update. Notifies all peers for the same siteId EXCEPT the origin.
   */
  async publish(event: AuthPublishEvent): Promise<void> {
    const peers = [...this.participants.values()].filter(
      p => p.siteId === event.siteId && p.id !== event.originId,
    );

    if (peers.length === 0) return;

    log.debug(
      { siteId: event.siteId, originId: event.originId, peerCount: peers.length, reason: event.reason },
      'Publishing auth change',
    );

    await Promise.allSettled(
      peers.map(p =>
        p.onAuthChanged(event.siteId, event.version).catch(err =>
          log.debug({ err, participant: p.id, siteId: event.siteId }, 'Auth change notification failed'),
        ),
      ),
    );
  }

  /**
   * Get a participant by ID.
   */
  getParticipant(id: string): AuthParticipant | undefined {
    return this.participants.get(id);
  }

  /**
   * Get all participants for a site.
   */
  getParticipantsForSite(siteId: string): AuthParticipant[] {
    return [...this.participants.values()].filter(p => p.siteId === siteId);
  }

  /**
   * Get count of registered participants.
   */
  get size(): number {
    return this.participants.size;
  }
}
