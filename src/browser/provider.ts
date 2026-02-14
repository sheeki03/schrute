import type { Page } from 'playwright';
import type { BrowserProvider, OneAgentConfig } from '../skill/types.js';
import { PlaywrightMcpAdapter } from './playwright-mcp-adapter.js';
import type { BrowserFeatureFlags } from './feature-flags.js';
import type { EngineCapabilities } from './engine.js';

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
  /** Runtime feature flags for the browser adapter */
  flags?: BrowserFeatureFlags;
  capabilities?: EngineCapabilities;
}

/**
 * Factory that creates the appropriate BrowserProvider adapter.
 * Supports PlaywrightMcpAdapter and AgentBrowserAdapter.
 * Additional adapters (e.g. CDP direct, remote browser) can be registered here.
 *
 * Intentional single-method class — serves as extension point for additional browser adapter types
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
    return new PlaywrightMcpAdapter(
      page,
      providerConfig.domainAllowlist,
      {
        flags: providerConfig.flags,
        capabilities: providerConfig.capabilities,
      },
    );
  }
}
