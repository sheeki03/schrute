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
  origin?: string,
): Promise<WebMcpScanResult> {
  // If no explicit origin, derive from browser's current URL (post-navigation)
  let cacheKey = origin ?? siteId;
  if (!origin) {
    try {
      const derived = new URL(browser.getCurrentUrl()).origin;
      // 'null' is returned for about:blank, data:, and other non-HTTP URLs
      if (derived && derived !== 'null') {
        cacheKey = derived;
      }
    } catch { /* fall back to siteId */ }
  }

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
      // Authoritative scan returned 0 tools — site no longer has WebMCP tools
      db.run('DELETE FROM webmcp_tools WHERE site_id = ?', cacheKey);
      return { available: true, tools: [] };
    }

    const rawTools: WebMcpTool[] = toolsData.map(t => ({
      name: String(t.name ?? ''),
      description: t.description ? String(t.description) : undefined,
      inputSchema: t.inputSchema as Record<string, unknown> | undefined,
    }));

    // Sort and cap at 20
    const sorted = [...rawTools].sort((a, b) => a.name.localeCompare(b.name));
    const tools = sorted.slice(0, 20);

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
        cacheKey,
        tool.name,
        tool.description ?? null,
        tool.inputSchema ? JSON.stringify(tool.inputSchema) : null,
        now,
        now,
      );
    }

    // Prune tools no longer present in authoritative scan
    if (tools.length > 0) {
      const discoveredNames = tools.map(t => t.name);
      const placeholders = discoveredNames.map(() => '?').join(',');
      db.run(
        `DELETE FROM webmcp_tools WHERE site_id = ? AND tool_name NOT IN (${placeholders})`,
        cacheKey,
        ...discoveredNames,
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
 * Load cached WebMCP tools from database, ordered and capped at 20.
 */
export function loadCachedTools(siteId: string, db: AgentDatabase, origin?: string): WebMcpTool[] {
  const cacheKey = origin ?? siteId;
  const rows = db.all<WebMcpToolRow>(
    'SELECT tool_name, description, input_schema FROM webmcp_tools WHERE site_id = ? ORDER BY last_verified DESC, tool_name ASC LIMIT 20',
    cacheKey,
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
  last_verified?: number;
}
