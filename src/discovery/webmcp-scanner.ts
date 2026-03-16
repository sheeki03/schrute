import { getLogger } from '../core/logger.js';
import type { BrowserProvider } from '../skill/types.js';
import type { AgentDatabase } from '../storage/database.js';
import type { WebMcpScanResult, WebMcpTool } from './types.js';
import { validateWebMcpTool } from './webmcp-validator.js';

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

  // Check if browser supports listModelContextTools
  if (!browser.listModelContextTools) {
    log.debug('Browser does not support listModelContextTools');
    return { available: false, tools: [] };
  }

  try {
    // Use the declarative listModelContextTools() API (Chrome 146+)
    const probeResult = await browser.listModelContextTools();

    if (probeResult.error) {
      log.debug({ error: probeResult.error }, 'WebMCP not available on this site');
      return { available: false, tools: [] };
    }

    const resultObj = probeResult.result as { tools?: WebMcpToolRaw[]; testingTools?: WebMcpToolRaw[] } | null;
    const toolsData = resultObj?.tools;
    const testingToolsData = resultObj?.testingTools;

    if (!Array.isArray(toolsData) || toolsData.length === 0) {
      // Authoritative scan returned 0 tools — site no longer has WebMCP tools
      db.run('DELETE FROM webmcp_tools WHERE site_id = ?', cacheKey);
      return { available: true, tools: [] };
    }

    // Build a lookup from testingTools for metadata enrichment
    const testingLookup = new Map<string, WebMcpToolRaw>();
    if (Array.isArray(testingToolsData)) {
      for (const t of testingToolsData) {
        if (t.name) testingLookup.set(String(t.name), t);
      }
    }

    const rawTools: WebMcpTool[] = toolsData.map(t => {
      const name = String(t.name ?? '');
      const testing = testingLookup.get(name);
      return {
        name,
        description: t.description ? String(t.description) : undefined,
        inputSchema: t.inputSchema as Record<string, unknown> | undefined,
        outputSchema: t.outputSchema as Record<string, unknown> | undefined,
        declarative: Boolean(testing?.declarative ?? t.declarative),
        autoSubmit: Boolean(testing?.autoSubmit ?? t.autoSubmit),
      };
    });

    // Sort and cap at 20
    const sorted = [...rawTools].sort((a, b) => a.name.localeCompare(b.name));
    const tools = sorted.slice(0, 20);

    // Validate discovered tools
    for (const tool of tools) {
      const warnings = validateWebMcpTool(tool);
      if (warnings.length > 0) {
        log.warn({ toolName: tool.name, warnings }, 'WebMCP tool validation warnings');
      }
    }

    // Store in database
    const now = Date.now();
    for (const tool of tools) {
      db.run(
        `INSERT INTO webmcp_tools (site_id, tool_name, description, input_schema, discovered_at, last_verified, declarative, auto_submit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(site_id, tool_name) DO UPDATE SET
           description = excluded.description,
           input_schema = excluded.input_schema,
           last_verified = excluded.last_verified,
           declarative = excluded.declarative,
           auto_submit = excluded.auto_submit`,
        cacheKey,
        tool.name,
        tool.description ?? null,
        tool.inputSchema ? JSON.stringify(tool.inputSchema) : null,
        now,
        now,
        tool.declarative ? 1 : 0,
        tool.autoSubmit ? 1 : 0,
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
 * Refresh WebMCP tools for a site, returning added and removed tool names.
 */
export async function refreshWebMcpTools(
  siteId: string,
  browser: BrowserProvider,
  db: AgentDatabase,
  origin?: string,
): Promise<{ added: WebMcpTool[]; removed: string[] }> {
  const before = loadCachedTools(siteId, db, origin);
  const scan = await scanWebMcp(siteId, browser, db, origin);
  const after = scan.tools;
  const beforeNames = new Set(before.map(t => t.name));
  const afterNames = new Set(after.map(t => t.name));
  const added = after.filter(t => !beforeNames.has(t.name));
  const removed = [...beforeNames].filter(n => !afterNames.has(n));
  return { added, removed };
}

/**
 * Load cached WebMCP tools from database, ordered and capped at 20.
 */
export function loadCachedTools(siteId: string, db: AgentDatabase, origin?: string): WebMcpTool[] {
  const cacheKey = origin ?? siteId;
  const rows = db.all<WebMcpToolRow>(
    'SELECT tool_name, description, input_schema, declarative, auto_submit FROM webmcp_tools WHERE site_id = ? ORDER BY last_verified DESC, tool_name ASC LIMIT 20',
    cacheKey,
  );

  return rows.map(row => ({
    name: row.tool_name,
    description: row.description ?? undefined,
    inputSchema: row.input_schema ? JSON.parse(row.input_schema) as Record<string, unknown> : undefined,
    declarative: row.declarative === 1,
    autoSubmit: row.auto_submit === 1,
  }));
}

// ─── Internal Types ──────────────────────────────────────────────────

interface WebMcpToolRaw {
  name: unknown;
  description?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
  declarative?: unknown;
  autoSubmit?: unknown;
}

interface WebMcpToolRow {
  tool_name: string;
  description: string | null;
  input_schema: string | null;
  declarative: number;
  auto_submit: number;
  last_verified?: number;
}
