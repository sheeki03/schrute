import { getLogger } from '../core/logger.js';
import type { BrowserProvider } from '../skill/types.js';
import type { AgentDatabase } from '../storage/database.js';
import type { WebMcpScanResult, WebMcpTool } from './types.js';

const log = getLogger();

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Scan for WebMCP tools available on a site via navigator.modelContext.
 * Feature-flagged: only runs when config.features.webmcp = true.
 * Caller is responsible for checking the feature flag before invoking.
 */
export async function scanWebMcp(
  siteId: string,
  browser: BrowserProvider,
  db: AgentDatabase,
): Promise<WebMcpScanResult> {
  // Check if browser supports evaluateModelContext
  if (!browser.evaluateModelContext) {
    log.debug('Browser does not support evaluateModelContext');
    return { available: false, tools: [] };
  }

  try {
    // Probe for navigator.modelContext availability via a sealed check.
    // We call a sentinel tool name that returns available tools list.
    const probeResult = await browser.evaluateModelContext({
      toolName: '__webmcp_probe__',
      args: { action: 'listTools' },
    });

    if (probeResult.error) {
      log.debug({ error: probeResult.error }, 'WebMCP not available on this site');
      return { available: false, tools: [] };
    }

    const toolsData = probeResult.result as WebMcpToolRaw[] | undefined;
    if (!Array.isArray(toolsData) || toolsData.length === 0) {
      return { available: true, tools: [] };
    }

    const tools: WebMcpTool[] = toolsData.map(t => ({
      name: String(t.name ?? ''),
      description: t.description ? String(t.description) : undefined,
      inputSchema: t.inputSchema as Record<string, unknown> | undefined,
    }));

    // Store in database
    const now = Date.now();
    for (const tool of tools) {
      db.run(
        `INSERT INTO webmcp_tools (site_id, tool_name, description, input_schema, discovered_at, last_verified)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(site_id, tool_name) DO UPDATE SET
           description = excluded.description,
           input_schema = excluded.input_schema,
           last_verified = excluded.last_verified`,
        siteId,
        tool.name,
        tool.description ?? null,
        tool.inputSchema ? JSON.stringify(tool.inputSchema) : null,
        now,
        now,
      );
    }

    log.info({ siteId, toolCount: tools.length }, 'Discovered WebMCP tools');
    return { available: true, tools };
  } catch (err) {
    log.warn({ siteId, err }, 'WebMCP scan failed');
    return { available: false, tools: [] };
  }
}

/**
 * Load cached WebMCP tools from database.
 */
export function loadCachedTools(siteId: string, db: AgentDatabase): WebMcpTool[] {
  const rows = db.all<WebMcpToolRow>(
    'SELECT tool_name, description, input_schema FROM webmcp_tools WHERE site_id = ?',
    siteId,
  );

  return rows.map(row => ({
    name: row.tool_name,
    description: row.description ?? undefined,
    inputSchema: row.input_schema ? JSON.parse(row.input_schema) as Record<string, unknown> : undefined,
  }));
}

// ─── Internal Types ──────────────────────────────────────────────────

interface WebMcpToolRaw {
  name: unknown;
  description?: unknown;
  inputSchema?: unknown;
}

interface WebMcpToolRow {
  tool_name: string;
  description: string | null;
  input_schema: string | null;
}
