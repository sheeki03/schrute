import type { Page, Response as PwResponse } from 'playwright';
import type { NetworkEntry } from '../skill/types.js';
import type { BrowserFeatureFlags } from './feature-flags.js';
import type { BrowserBenchmark } from './benchmark.js';
import { BaseBrowserAdapter } from './base-browser-adapter.js';
import type { EngineCapabilities } from './engine.js';
import { getLogger } from '../core/logger.js';

const log = getLogger();

/**
 * Agent-optimized browser adapter implementing BrowserProvider.
 *
 * Purpose-built for agent interaction loops: snapshot -> act -> verify.
 * Provides better context efficiency (approximate ~4x reduction) by returning
 * compact accessibility tree snapshots instead of full DOM.
 *
 * Extends BaseBrowserAdapter with:
 * - Capped network entry buffer (default 500) to bound memory usage
 * - Resilient header capture (catch per-header errors individually)
 *
 * SECURITY:
 * - Only tools from ALLOWED_BROWSER_TOOLS are reachable
 * - browser_evaluate, browser_run_code, browser_install are BLOCKED
 * - evaluateFetch uses sealed template, not raw JS
 */
export class AgentBrowserAdapter extends BaseBrowserAdapter {
  private maxNetworkEntries: number;

  constructor(
    page: Page,
    domainAllowlist: string[],
    options?: {
      maxNetworkEntries?: number;
      flags?: BrowserFeatureFlags;
      benchmark?: BrowserBenchmark;
      capabilities?: EngineCapabilities;
    },
  ) {
    super(page, domainAllowlist, {
      flags: options?.flags,
      benchmark: options?.benchmark,
      capabilities: options?.capabilities,
    });
    this.maxNetworkEntries = options?.maxNetworkEntries ?? 500;
  }

  /**
   * Override network capture to cap the entry buffer and add resilient
   * header capture (individual try/catch around header reads).
   */
  protected override setupNetworkCapture(): void {
    this.page.on('response', async (response: PwResponse) => {
      try {
        if (this.networkEntries.length >= this.maxNetworkEntries) {
          // Drop oldest entries
          this.networkEntries.shift();
        }

        const request = response.request();
        const timing = request.timing();

        let requestBody: string | undefined;
        try {
          requestBody = request.postData() ?? undefined;
        } catch (err) {
          log.debug({ err }, 'Failed to read request post data');
        }

        let responseBody: string | undefined;
        try {
          responseBody = await response.text();
        } catch (err) {
          log.debug({ err }, 'Failed to read response body');
        }

        const requestHeaders: Record<string, string> = {};
        try {
          const reqHeaders = await request.allHeaders();
          for (const [k, v] of Object.entries(reqHeaders)) {
            requestHeaders[k] = v;
          }
        } catch (err) {
          log.debug({ err }, 'Failed to read request headers');
        }

        const responseHeaders: Record<string, string> = {};
        try {
          const respHeaders = await response.allHeaders();
          for (const [k, v] of Object.entries(respHeaders)) {
            responseHeaders[k] = v;
          }
        } catch (err) {
          log.debug({ err }, 'Failed to read response headers');
        }

        const startTime = timing.startTime;
        const endTime = timing.responseEnd > 0 ? timing.responseEnd : startTime + 1;

        this.networkEntries.push({
          url: request.url(),
          method: request.method(),
          status: response.status(),
          requestHeaders,
          responseHeaders,
          requestBody,
          responseBody,
          resourceType: request.resourceType(),
          timing: { startTime, endTime, duration: endTime - startTime },
        });
      } catch (err) {
        // Network capture is best-effort — must never crash the process
        log.debug({ err }, 'Network capture failed for response event');
      }
    });
  }
}
