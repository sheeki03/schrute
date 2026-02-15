import { getLogger } from '../core/logger.js';
import type {
  BrowserProvider,
  SealedModelContextRequest,
  SealedModelContextResponse,
} from '../skill/types.js';

const log = getLogger();

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Execute a WebMCP tool via sealed evaluateModelContext().
 *
 * Security constraints:
 * - Only calls navigator.modelContext.callTool() — no arbitrary JS
 * - Validates toolName against discovered allowlist
 * - Feature-flagged off by default (caller checks config.features.webmcp)
 * - Domain-gated: browser must already be on the target site
 */
export async function executeWebMcpTool(
  req: SealedModelContextRequest,
  browser: BrowserProvider,
  allowedTools: string[],
): Promise<SealedModelContextResponse> {
  // Validate browser supports WebMCP
  if (!browser.evaluateModelContext) {
    return {
      result: null,
      error: 'Browser does not support evaluateModelContext',
    };
  }

  // Validate tool name against allowlist
  if (!allowedTools.includes(req.toolName)) {
    log.warn({ toolName: req.toolName }, 'WebMCP tool not in allowlist');
    return {
      result: null,
      error: `Tool "${req.toolName}" is not in the allowed tools list`,
    };
  }

  // Validate tool name format — no injection via special characters
  if (!isValidToolName(req.toolName)) {
    return {
      result: null,
      error: `Invalid tool name: "${req.toolName}"`,
    };
  }

  // Validate args is a plain object
  if (req.args === null || typeof req.args !== 'object' || Array.isArray(req.args)) {
    return {
      result: null,
      error: 'args must be a plain object',
    };
  }

  try {
    log.debug({ toolName: req.toolName }, 'Executing WebMCP tool');

    // Sealed execution: only navigator.modelContext.callTool()
    const response = await browser.evaluateModelContext(req);

    if (response.error) {
      log.warn({ toolName: req.toolName, error: response.error }, 'WebMCP tool returned error');
    }

    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ toolName: req.toolName, error: message }, 'WebMCP tool execution failed');
    return {
      result: null,
      error: `Execution failed: ${message}`,
    };
  }
}

// ─── Validation ──────────────────────────────────────────────────────

const TOOL_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/;

function isValidToolName(name: string): boolean {
  return TOOL_NAME_PATTERN.test(name);
}
