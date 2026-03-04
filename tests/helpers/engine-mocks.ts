/**
 * Shared mock setup for engine.test.ts and engine-capture.test.ts.
 *
 * Both test files require an identical set of vi.mock() calls and mock objects
 * to construct an Engine instance. This module exports the shared mock
 * references so both files can import them instead of duplicating ~80 lines
 * of mock declarations.
 *
 * IMPORTANT: vi.mock() calls MUST still appear at the top level of each test
 * file because vitest hoists them. This helper provides:
 *   1. Shared mock object references (mockDb, mockBrowserManager, etc.)
 *   2. A makeConfig() helper
 *   3. The mock factory functions used inside vi.mock() calls
 *
 * Each test file should:
 *   - Import these shared references
 *   - Copy the vi.mock() blocks from the template (vitest requires static
 *     top-level vi.mock calls; they cannot be abstracted into a function)
 */

import { vi } from 'vitest';
import type { OneAgentConfig } from '../../src/skill/types.js';

// ─── Mock Database ──────────────────────────────────────────────

export function createMockDb() {
  return {
    run: vi.fn().mockReturnValue({ changes: 0 }),
    get: vi.fn().mockReturnValue(undefined),
    all: vi.fn().mockReturnValue([]),
    exec: vi.fn(),
    open: vi.fn(),
    close: vi.fn(),
    transaction: vi.fn((fn: () => unknown) => fn()),
  };
}

// ─── Mock SiteRepository Instance ───────────────────────────────

export function createMockSiteRepoInstance() {
  return {
    getById: vi.fn().mockReturnValue(undefined),
    create: vi.fn(),
    update: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
    delete: vi.fn(),
    updateMetrics: vi.fn(),
  };
}

// ─── Mock BrowserManager ────────────────────────────────────────

export function createMockBrowserManager() {
  return {
    launchBrowser: vi.fn().mockResolvedValue({}),
    getOrCreateContext: vi.fn().mockResolvedValue({
      pages: () => [],
      newPage: vi.fn().mockResolvedValue({}),
    }),
    hasContext: vi.fn().mockReturnValue(false),
    tryGetContext: vi.fn().mockReturnValue(undefined),
    closeContext: vi.fn().mockResolvedValue(undefined),
    closeBrowser: vi.fn().mockResolvedValue(undefined),
    closeAll: vi.fn().mockResolvedValue(undefined),
    getHarPath: vi.fn().mockReturnValue(null),
    getCapabilities: vi.fn().mockReturnValue(null),
    getHandlerTimeoutMs: vi.fn().mockReturnValue(30000),
    supportsHarRecording: vi.fn().mockReturnValue(true),
    isCdpConnected: vi.fn().mockReturnValue(false),
    setSuppressIdleTimeout: vi.fn(),
    withLease: vi.fn().mockImplementation(async (fn: () => Promise<unknown>) => fn()),
    touchActivity: vi.fn(),
    releaseActivity: vi.fn(),
    isIdle: vi.fn().mockReturnValue(true),
  };
}

// ─── Mock Session Manager fns ───────────────────────────────────

export function createMockSessionFns() {
  return {
    mockSessionCreate: vi.fn().mockResolvedValue({
      id: 'sess-1',
      siteId: 'example.com',
      url: 'https://example.com',
      createdAt: Date.now(),
    }),
    mockSessionResume: vi.fn().mockResolvedValue({
      id: 'sess-1',
      siteId: 'example.com',
      url: 'https://example.com',
      createdAt: Date.now(),
    }),
    mockSessionClose: vi.fn().mockResolvedValue(undefined),
    mockSessionListActive: vi.fn().mockReturnValue([]),
  };
}

// ─── Config Factory ─────────────────────────────────────────────

export function makeConfig(): OneAgentConfig {
  return {
    dataDir: '/tmp/oneagent-engine-test',
    logLevel: 'silent',
    features: { webmcp: false, httpTransport: false },
    toolBudget: {
      maxToolCallsPerTask: 50,
      maxConcurrentCalls: 3,
      crossDomainCalls: false,
      secretsToNonAllowlisted: false,
    },
    payloadLimits: {
      maxResponseBodyBytes: 10 * 1024 * 1024,
      maxRequestBodyBytes: 5 * 1024 * 1024,
      replayTimeoutMs: { tier1: 30000, tier3: 60000, tier4: 120000 },
      harCaptureMaxBodyBytes: 50 * 1024 * 1024,
      redactorTimeoutMs: 10000,
    },
    audit: { strictMode: true, rootHashExport: true },
    storage: { maxPerSiteMb: 500, maxGlobalMb: 5000, retentionDays: 90 },
    server: { network: false },
    daemon: { port: 19420, autoStart: false },
    tempTtlMs: 3600000,
    gcIntervalMs: 900000,
    confirmationTimeoutMs: 30000,
    confirmationExpiryMs: 60000,
    promotionConsecutivePasses: 5,
    promotionVolatilityThreshold: 0.2,
    maxToolsPerSite: 20,
    toolShortlistK: 10,
  } as OneAgentConfig;
}

// ─── Config Mock Factory (for vi.mock callback) ─────────────────

export function getConfigMockValue() {
  return {
    dataDir: '/tmp/oneagent-engine-test',
    logLevel: 'silent',
    features: { webmcp: false, httpTransport: false },
    toolBudget: {
      maxToolCallsPerTask: 50,
      maxConcurrentCalls: 3,
      crossDomainCalls: false,
      secretsToNonAllowlisted: false,
    },
    payloadLimits: {
      maxResponseBodyBytes: 10 * 1024 * 1024,
      maxRequestBodyBytes: 5 * 1024 * 1024,
      replayTimeoutMs: { tier1: 30000, tier3: 60000, tier4: 120000 },
      harCaptureMaxBodyBytes: 50 * 1024 * 1024,
      redactorTimeoutMs: 10000,
    },
    audit: { strictMode: true, rootHashExport: true },
    storage: { maxPerSiteMb: 500, maxGlobalMb: 5000, retentionDays: 90 },
    server: { network: false },
    daemon: { port: 19420, autoStart: false },
    tempTtlMs: 3600000,
    gcIntervalMs: 900000,
    confirmationTimeoutMs: 30000,
    confirmationExpiryMs: 60000,
    promotionConsecutivePasses: 5,
    promotionVolatilityThreshold: 0.2,
    maxToolsPerSite: 20,
    toolShortlistK: 10,
  };
}
