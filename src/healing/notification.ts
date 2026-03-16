import { getLogger } from '../core/logger.js';
import type { SchruteConfig } from '../skill/types.js';

const log = getLogger();

// ─── Types ──────────────────────────────────────────────────────

type SkillEventType =
  | 'skill_degraded'
  | 'skill_broken'
  | 'skill_relearned'
  | 'skill_promoted'
  | 'skill_demoted'
  | 'skill_nudge'
  | 'webmcp_tool_added'
  | 'webmcp_tool_removed';

interface SkillEvent {
  type: SkillEventType;
  skillId: string;
  siteId: string;
  details: Record<string, unknown>;
  timestamp: number;
}

interface NotificationSink {
  name: string;
  send(event: SkillEvent): Promise<void>;
}

// ─── Built-in Sinks ──────────────────────────────────────────────

/**
 * Log sink — always active. Writes events to the structured logger.
 */
class LogSink implements NotificationSink {
  name = 'log';

  async send(event: SkillEvent): Promise<void> {
    log.info(
      { eventType: event.type, skillId: event.skillId, siteId: event.siteId, details: event.details },
      `Skill event: ${event.type}`,
    );
  }
}

/**
 * MCP notification sink. Sends `notifications/tools/list_changed` when
 * skill state changes affect the available tool surface.
 */
class McpSink implements NotificationSink {
  name = 'mcp';

  async send(event: SkillEvent): Promise<void> {
    // MCP notifications are emitted via the server's notification mechanism.
    // This sink records the intent; the actual MCP server picks it up from
    // the pending notifications queue.
    pendingMcpNotifications.push({
      method: 'notifications/tools/list_changed',
      params: {
        reason: event.type,
        skillId: event.skillId,
        siteId: event.siteId,
        timestamp: event.timestamp,
      },
    });

    log.debug(
      { eventType: event.type, skillId: event.skillId },
      'Queued MCP tool list changed notification',
    );
  }
}

/**
 * REST webhook sink. POSTs events to configured URLs when the REST server
 * is enabled.
 */
// Note: Webhook delivery is fire-and-forget with no retry or backoff.
// Failed deliveries are logged but not retried. Consider adding retry
// logic if webhook reliability becomes important.
class WebhookSink implements NotificationSink {
  name = 'webhook';

  constructor(private urls: string[]) {}

  async send(event: SkillEvent): Promise<void> {
    const body = JSON.stringify(event);

    const results = await Promise.allSettled(
      this.urls.map((url) =>
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(10000),
        }),
      ),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        log.warn(
          { url: this.urls[i], err: result.reason },
          'Webhook notification failed',
        );
      }
    }
  }
}

// ─── Pending MCP Notifications Queue ────────────────────────────

interface McpNotification {
  method: string;
  params: Record<string, unknown>;
}

const pendingMcpNotifications: McpNotification[] = [];

/**
 * Drain pending MCP notifications. Called by the MCP server transport.
 */
export function drainMcpNotifications(): McpNotification[] {
  return pendingMcpNotifications.splice(0);
}

// ─── Notify ─────────────────────────────────────────────────────

/**
 * Send a skill lifecycle event to all configured notification sinks.
 *
 * Sinks:
 * - **Log**: Always active (structured log output)
 * - **MCP**: Always active (queues `notifications/tools/list_changed`)
 * - **Webhook**: Active when REST server is enabled and webhook URLs configured
 *
 * @param event - The lifecycle event to broadcast
 * @param config - Agent configuration (determines which sinks are active)
 * @param webhookUrls - Optional webhook URLs (from site/global config)
 */
export async function notify(
  event: SkillEvent,
  config: SchruteConfig,
  webhookUrls?: string[],
): Promise<void> {
  const sinks: NotificationSink[] = [new LogSink(), new McpSink()];

  // Add webhook sink if REST server is enabled and URLs are provided
  if (config.server.network && webhookUrls && webhookUrls.length > 0) {
    sinks.push(new WebhookSink(webhookUrls));
  }

  const results = await Promise.allSettled(
    sinks.map((sink) => sink.send(event)),
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'rejected') {
      log.warn(
        { sink: sinks[i].name, err: result.reason },
        'Notification sink failed',
      );
    }
  }
}

/**
 * Create a SkillEvent helper.
 */
export function createEvent(
  type: SkillEventType,
  skillId: string,
  siteId: string,
  details: Record<string, unknown> = {},
): SkillEvent {
  return { type, skillId, siteId, details, timestamp: Date.now() };
}
