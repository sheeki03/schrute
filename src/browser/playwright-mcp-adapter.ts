import type { Page } from 'playwright';
import { BaseBrowserAdapter } from './base-browser-adapter.js';
import type { BrowserFeatureFlags } from './feature-flags.js';
import type { BrowserBenchmark } from './benchmark.js';
import type { EngineCapabilities } from './engine.js';

/**
 * Implements BrowserProvider using Playwright Page directly, with a strict
 * allowlist proxy that mirrors the MCP tool surface.
 *
 * Extends BaseBrowserAdapter with the default (full) snapshot and network
 * capture behavior. This is the standard adapter for MCP server use.
 *
 * SECURITY:
 * - Only tools from ALLOWED_BROWSER_TOOLS are reachable.
 * - browser_evaluate, browser_run_code, browser_install are BLOCKED.
 * - evaluateFetch() is a sealed wrapper: generates a fetch snippet internally,
 *   validates domain against allowlist, and executes via page.evaluate().
 *   Raw evaluate is NEVER exposed to calling agents.
 */
export class PlaywrightMcpAdapter extends BaseBrowserAdapter {
  constructor(
    page: Page,
    domainAllowlist: string[],
    options?: { flags?: BrowserFeatureFlags; benchmark?: BrowserBenchmark; capabilities?: EngineCapabilities; handlerTimeoutMs?: number },
  ) {
    super(page, domainAllowlist, options);
  }
}
