import { describe, it, expect, vi, beforeEach } from 'vitest';
import { notify, createEvent, drainMcpNotifications } from '../../src/healing/notification.js';
import type { OneAgentConfig } from '../../src/skill/types.js';

const mockConfig: OneAgentConfig = {
  dataDir: '/tmp/oneagent-test',
  logLevel: 'info',
  features: { webmcp: false, httpTransport: false },
  toolBudget: {
    maxToolCallsPerTask: 50,
    maxConcurrentCalls: 3,
    crossDomainCalls: false,
    secretsToNonAllowlisted: false,
  },
  payloadLimits: {
    maxResponseBodyBytes: 10_000_000,
    maxRequestBodyBytes: 5_000_000,
    replayTimeoutMs: { tier1: 30000, tier3: 60000, tier4: 120000 },
    harCaptureMaxBodyBytes: 50_000_000,
    redactorTimeoutMs: 10000,
  },
  audit: { strictMode: true, rootHashExport: true },
  storage: { maxPerSiteMb: 500, maxGlobalMb: 5000, retentionDays: 90 },
  server: { network: false },
  daemon: { port: 19420, autoStart: false },
  tempTtlMs: 3600000,
  gcIntervalMs: 900000,
  confirmationTimeoutMs: 30000,
  confirmationExpiryMs: 60000,
  promotionConsecutivePasses: 5,
  promotionVolatilityThreshold: 0.2,
  maxToolsPerSite: 20,
  toolShortlistK: 10,
};

describe('notification', () => {
  beforeEach(() => {
    // Drain any pending notifications from prior tests
    drainMcpNotifications();
  });

  describe('createEvent', () => {
    it('creates a skill event with correct structure', () => {
      const event = createEvent('skill_broken', 'test.skill.v1', 'example.com', { reason: 'low success rate' });

      expect(event.type).toBe('skill_broken');
      expect(event.skillId).toBe('test.skill.v1');
      expect(event.siteId).toBe('example.com');
      expect(event.details).toEqual({ reason: 'low success rate' });
      expect(event.timestamp).toBeGreaterThan(0);
    });

    it('defaults details to empty object', () => {
      const event = createEvent('skill_promoted', 'test.skill.v1', 'example.com');
      expect(event.details).toEqual({});
    });
  });

  describe('notify', () => {
    it('sends to log and MCP sinks by default', async () => {
      const event = createEvent('skill_degraded', 'test.skill.v1', 'example.com');

      await notify(event, mockConfig);

      // MCP notification should be queued
      const mcpNotifications = drainMcpNotifications();
      expect(mcpNotifications).toHaveLength(1);
      expect(mcpNotifications[0].method).toBe('notifications/tools/list_changed');
      expect(mcpNotifications[0].params).toMatchObject({
        reason: 'skill_degraded',
        skillId: 'test.skill.v1',
      });
    });

    it('does not send webhooks when server.network is false', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

      const event = createEvent('skill_broken', 'test.skill.v1', 'example.com');
      await notify(event, mockConfig, ['https://hooks.example.com/events']);

      expect(fetchSpy).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });

    it('sends webhooks when server.network is true', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

      const networkConfig = { ...mockConfig, server: { network: true } };
      const event = createEvent('skill_relearned', 'test.skill.v1', 'example.com');

      await notify(event, networkConfig, ['https://hooks.example.com/events']);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://hooks.example.com/events',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('skill_relearned'),
        }),
      );
      vi.restoreAllMocks();
    });

    it('handles webhook failures gracefully', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

      const networkConfig = { ...mockConfig, server: { network: true } };
      const event = createEvent('skill_broken', 'test.skill.v1', 'example.com');

      // Should not throw
      await expect(
        notify(event, networkConfig, ['https://hooks.example.com/events']),
      ).resolves.toBeUndefined();

      vi.restoreAllMocks();
    });

    it('sends to multiple webhook URLs', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

      const networkConfig = { ...mockConfig, server: { network: true } };
      const event = createEvent('skill_promoted', 'test.skill.v1', 'example.com');

      await notify(event, networkConfig, [
        'https://hooks.example.com/a',
        'https://hooks.example.com/b',
      ]);

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      vi.restoreAllMocks();
    });
  });

  describe('drainMcpNotifications', () => {
    it('returns empty array when no notifications pending', () => {
      const notifications = drainMcpNotifications();
      expect(notifications).toEqual([]);
    });

    it('drains all pending notifications', async () => {
      const event1 = createEvent('skill_broken', 'skill1.v1', 'a.com');
      const event2 = createEvent('skill_degraded', 'skill2.v1', 'b.com');

      await notify(event1, mockConfig);
      await notify(event2, mockConfig);

      const notifications = drainMcpNotifications();
      expect(notifications).toHaveLength(2);

      // Second drain should be empty
      const empty = drainMcpNotifications();
      expect(empty).toHaveLength(0);
    });
  });
});
