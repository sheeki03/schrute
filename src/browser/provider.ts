import type { Page } from 'playwright';
import type { BrowserProvider, OneAgentConfig } from '../skill/types.js';
import { PlaywrightMcpAdapter } from './playwright-mcp-adapter.js';

// Re-export BrowserProvider and related types for consumers
export type {
  BrowserProvider,
  PageSnapshot,
  NetworkEntry,
  SealedFetchRequest,
  SealedFetchResponse,
  SealedModelContextRequest,
  SealedModelContextResponse,
} from '../skill/types.js';

export interface BrowserProviderConfig {
  /** Domains the sealed fetch is allowed to reach */
  domainAllowlist: string[];
  /** Whether WebMCP (model context) is enabled */
  webmcpEnabled?: boolean;
}

/**
 * Factory that creates the appropriate BrowserProvider adapter.
 * Currently only Playwright is supported; future adapters (e.g. CDP direct,
 * remote browser) can be registered here.
 */
export class BrowserProviderFactory {
  /**
   * Create a BrowserProvider backed by Playwright.
   *
   * @param page - A Playwright Page instance (already navigated or fresh).
   * @param providerConfig - Domain allowlist and feature flags.
   */
  static fromPlaywrightPage(
    page: Page,
    providerConfig: BrowserProviderConfig,
  ): BrowserProvider {
    return new PlaywrightMcpAdapter(page, providerConfig.domainAllowlist);
  }
}
