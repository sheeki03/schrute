import type { Engine, EngineStatus } from '../core/engine.js';
import type { SchruteConfig } from '../skill/types.js';
import { getDatabase } from '../storage/database.js';
import { loadCachedTools } from '../discovery/webmcp-scanner.js';
import { isAdminCaller } from '../shared/admin-auth.js';

export async function getShapedStatus(
  engine: Engine,
  config: SchruteConfig,
  callerId?: string,
): Promise<EngineStatus & { webmcp?: Record<string, unknown> }> {
  const statusIsAdmin = isAdminCaller(callerId, config);
  const statusData = engine.getStatus({ drainWarnings: statusIsAdmin }) as EngineStatus & { webmcp?: Record<string, unknown> };
  const statusRecord = statusData as unknown as Record<string, unknown>;

  if (!statusIsAdmin) {
    if (statusRecord.currentRecording && typeof statusRecord.currentRecording === 'object') {
      const rec = statusRecord.currentRecording as Record<string, unknown>;
      statusRecord.currentRecording = {
        id: rec.id,
        name: rec.name,
        siteId: rec.siteId,
        startedAt: rec.startedAt,
        requestCount: rec.requestCount,
      };
    }

    statusRecord.activeSession = null;
    statusRecord.activeNamedSession = undefined;
    statusRecord.warnings = undefined;
    if (statusRecord.pendingRecovery && typeof statusRecord.pendingRecovery === 'object') {
      const recovery = { ...(statusRecord.pendingRecovery as Record<string, unknown>) };
      delete recovery.resumeToken;
      statusRecord.pendingRecovery = recovery;
    }
  }

  if (config.features.webmcp && statusIsAdmin) {
    const multiSession = engine.getMultiSessionManager();
    const activeName = multiSession.getActive();
    const activeNamed = multiSession.get(activeName);
    const activeSiteId = activeNamed?.siteId;

    if (activeSiteId) {
      try {
        const db = getDatabase(config);
        let origin: string | undefined;
        if (activeNamed) {
          const existingCtx = activeNamed.browserManager.tryGetContext(activeSiteId);
          if (existingCtx) {
            const page = existingCtx.pages().find(p => !p.isClosed());
            if (page?.url()) {
              try {
                origin = new URL(page.url()).origin;
              } catch {
                // Ignore invalid URLs.
              }
            }
          }
        }
        const cachedTools = loadCachedTools(activeSiteId, db, origin);
        statusRecord.webmcp = {
          enabled: true,
          toolCount: cachedTools.length,
          tools: cachedTools.map(t => t.name),
          note: cachedTools.length > 0 ? 'Tools cached by origin. Only tools on current page will execute.' : undefined,
        };
      } catch {
        statusRecord.webmcp = {
          enabled: true,
          toolCount: 0,
          tools: [],
          error: 'Failed to load WebMCP tools',
        };
      }
    } else {
      statusRecord.webmcp = { enabled: true, toolCount: 0, tools: [] };
    }
  } else if (config.features.webmcp) {
    statusRecord.webmcp = { enabled: true };
  }

  return statusData;
}
