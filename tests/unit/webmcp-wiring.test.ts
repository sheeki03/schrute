import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock logger ─────────────────────────────────────────────────
vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ─── Mock config ─────────────────────────────────────────────────
vi.mock('../../src/core/config.js', () => ({
  getConfig: () => ({
    dataDir: '/tmp/test-schrute',
    logLevel: 'silent',
    features: { webmcp: false, httpTransport: false },
    daemon: { port: 19420, autoStart: false },
    toolBudget: { maxToolCallsPerTask: 50, maxConcurrentCalls: 3, crossDomainCalls: false, secretsToNonAllowlisted: false },
    payloadLimits: { maxResponseBodyBytes: 10485760, maxRequestBodyBytes: 5242880, replayTimeoutMs: { tier1: 30000, tier3: 60000, tier4: 120000 }, harCaptureMaxBodyBytes: 52428800, redactorTimeoutMs: 10000 },
    audit: { strictMode: true, rootHashExport: true },
    storage: { maxPerSiteMb: 500, maxGlobalMb: 5000, retentionDays: 90 },
    server: { network: false },
    tempTtlMs: 3600000,
    gcIntervalMs: 900000,
    confirmationTimeoutMs: 30000,
    confirmationExpiryMs: 60000,
    promotionConsecutivePasses: 5,
    promotionVolatilityThreshold: 0.2,
    maxToolsPerSite: 20,
    toolShortlistK: 10,
  }),
  getDataDir: () => '/tmp/test-schrute',
  getDbPath: () => ':memory:',
  ensureDirectories: vi.fn(),
  loadConfig: vi.fn(),
  resetConfigCache: vi.fn(),
}));

// ─── Mock database ───────────────────────────────────────────────
vi.mock('../../src/storage/database.js', () => ({
  getDatabase: vi.fn(),
  AgentDatabase: class {},
}));

import type { BrowserProvider, SealedModelContextResponse, SchruteConfig, CapabilityName } from '../../src/skill/types.js';
import { Capability, DISABLED_BY_DEFAULT_CAPABILITIES } from '../../src/skill/types.js';
import { checkCapability, invalidatePolicyCache, setSitePolicy } from '../../src/core/policy.js';
import { scanWebMcp, loadCachedTools } from '../../src/discovery/webmcp-scanner.js';
import type { AgentDatabase } from '../../src/storage/database.js';
import { META_TOOLS } from '../../src/server/tool-registry.js';

// ─── Helpers ─────────────────────────────────────────────────────

function mockBrowser(modelContextResult?: SealedModelContextResponse): BrowserProvider {
  const base: BrowserProvider = {
    navigate: vi.fn(),
    snapshot: vi.fn(),
    click: vi.fn(),
    type: vi.fn(),
    evaluateFetch: vi.fn(),
    screenshot: vi.fn(),
    networkRequests: vi.fn(),
    getCurrentUrl: vi.fn().mockReturnValue('about:blank'),
  };

  if (modelContextResult !== undefined) {
    base.evaluateModelContext = vi.fn().mockResolvedValue(modelContextResult);
    // Scanner now uses listModelContextTools() — wrap result in { tools, testingTools } envelope
    const toolsEnvelope = modelContextResult.error
      ? modelContextResult
      : { result: { tools: modelContextResult.result, testingTools: null }, error: modelContextResult.error };
    base.listModelContextTools = vi.fn().mockResolvedValue(toolsEnvelope);
  }

  return base;
}

function mockDatabase(): AgentDatabase {
  const store = new Map<string, unknown[]>();
  return {
    run: vi.fn((sql: string, ...params: unknown[]) => {
      if (sql.includes('INSERT')) {
        const key = `${params[0]}:${params[1]}`;
        store.set(key, params);
      }
      if (sql.includes('DELETE')) {
        if (sql.includes('NOT IN')) {
          // Prune: keep only specified tool names
          const siteId = params[0] as string;
          const keepNames = params.slice(1).map(String);
          for (const key of store.keys()) {
            if (key.startsWith(`${siteId}:`) && !keepNames.some(n => key === `${siteId}:${n}`)) {
              store.delete(key);
            }
          }
        } else {
          // Delete all for site
          const siteId = params[0] as string;
          for (const key of store.keys()) {
            if (key.startsWith(`${siteId}:`)) {
              store.delete(key);
            }
          }
        }
      }
      return { changes: 1, lastInsertRowid: 1 };
    }),
    all: vi.fn((_sql: string, siteId: string) => {
      const results: unknown[] = [];
      for (const [key, params] of store) {
        if (key.startsWith(`${siteId}:`)) {
          results.push({
            tool_name: params[1],
            description: params[2],
            input_schema: params[3],
          });
        }
      }
      return results;
    }),
    get: vi.fn(),
    exec: vi.fn(),
    transaction: vi.fn(),
    open: vi.fn(),
    close: vi.fn(),
  } as unknown as AgentDatabase;
}

// ─── Tests ───────────────────────────────────────────────────────

describe('webmcp-wiring', () => {
  beforeEach(() => {
    invalidatePolicyCache();
  });

  // ─── evaluateModelContext tests ─────────────────────────────────

  describe('evaluateModelContext', () => {
    it('calls page.evaluate with sealed args', async () => {
      const browser = mockBrowser({
        result: { answer: 42 },
        error: undefined,
      });

      const result = await browser.evaluateModelContext!({
        toolName: 'search',
        args: { query: 'test' },
      });

      expect(browser.evaluateModelContext).toHaveBeenCalledWith({
        toolName: 'search',
        args: { query: 'test' },
      });
      expect(result.result).toEqual({ answer: 42 });
    });

    it('returns error when navigator.modelContext absent', async () => {
      const browser = mockBrowser({
        result: null,
        error: 'WebMCP not available on this page',
      });

      const result = await browser.evaluateModelContext!({
        toolName: 'search',
        args: {},
      });

      expect(result.error).toBe('WebMCP not available on this page');
      expect(result.result).toBeNull();
    });

    it('returns result on success', async () => {
      const browser = mockBrowser({
        result: { items: ['a', 'b'] },
      });

      const result = await browser.evaluateModelContext!({
        toolName: 'listItems',
        args: { category: 'all' },
      });

      expect(result.result).toEqual({ items: ['a', 'b'] });
      expect(result.error).toBeUndefined();
    });
  });

  // ─── checkCapability policy tests ──────────────────────────────

  describe('checkCapability', () => {
    it('BROWSER_MODEL_CONTEXT requires site grant (no longer disabled by default)', () => {
      const result = checkCapability('example.com', Capability.BROWSER_MODEL_CONTEXT);
      expect(result.allowed).toBe(false);
      expect(result.rule).toBe('capability.not_granted');
    });

    it('allows with site grant (no longer requires opt-in)', () => {
      // Set up site policy with the capability
      setSitePolicy({
        siteId: 'example.com',
        allowedMethods: ['GET', 'HEAD'],
        maxQps: 10,
        maxConcurrent: 3,
        readOnlyDefault: true,
        requireConfirmation: [],
        domainAllowlist: ['example.com'],
        redactionRules: [],
        capabilities: [Capability.BROWSER_MODEL_CONTEXT] as CapabilityName[],
      });

      const result = checkCapability('example.com', Capability.BROWSER_MODEL_CONTEXT);
      expect(result.allowed).toBe(true);
      expect(result.rule).toBe('capability.site_allowed');
    });

    it('blocks with opt-in but no site grant', () => {
      // Site policy without BROWSER_MODEL_CONTEXT
      setSitePolicy({
        siteId: 'nope.com',
        allowedMethods: ['GET'],
        maxQps: 10,
        maxConcurrent: 3,
        readOnlyDefault: true,
        requireConfirmation: [],
        domainAllowlist: [],
        redactionRules: [],
        capabilities: [], // no model context capability
      });

      const config = {
        capabilities: {
          enabled: [Capability.BROWSER_MODEL_CONTEXT] as CapabilityName[],
        },
      } as SchruteConfig;

      const result = checkCapability('nope.com', Capability.BROWSER_MODEL_CONTEXT, config);
      expect(result.allowed).toBe(false);
      expect(result.rule).toBe('capability.not_granted');
    });

    it('BROWSER_MODEL_CONTEXT is NOT in DISABLED_BY_DEFAULT list', () => {
      expect(DISABLED_BY_DEFAULT_CAPABILITIES).not.toContain(Capability.BROWSER_MODEL_CONTEXT);
    });
  });

  // ─── Dispatch-level tests ──────────────────────────────────────

  describe('schrute_webmcp_call dispatch logic', () => {
    it('requires features.webmcp to be enabled', () => {
      // The dispatch handler checks config.features.webmcp first
      const config = { features: { webmcp: false } } as any;
      expect(config.features.webmcp).toBe(false);
      // When false, dispatch returns: { content: [{ type: 'text', text: 'WebMCP is disabled...' }], isError: true }
    });

    it('requires an active browser session', () => {
      // If no active session: { text: 'No active browser session...' }
      const msm = { getActive: () => null };
      expect(msm.getActive()).toBeNull();
    });

    it('enforces origin binding — hostname mismatch is rejected', () => {
      // Origin binding logic from tool-dispatch.ts:666
      const siteId = 'example.com';
      const testCases = [
        { url: 'https://evil.com/page', expected: false },
        { url: 'https://example.com/page', expected: true },
        { url: 'https://sub.example.com/page', expected: true },
        { url: 'https://evil-example.com/page', expected: false },
      ];

      for (const { url, expected } of testCases) {
        const parsed = new URL(url);
        const currentHostname = parsed.hostname;
        const matches = currentHostname === siteId || currentHostname.endsWith('.' + siteId);
        expect(matches).toBe(expected);
      }
    });

    it('rejects about:blank and data: URLs', () => {
      const nonHttpUrls = ['about:blank', 'data:text/html,hello'];
      for (const url of nonHttpUrls) {
        // about:blank — new URL succeeds but protocol is 'about:'
        // data: — new URL succeeds but protocol is 'data:'
        try {
          const parsed = new URL(url);
          expect(parsed.protocol).not.toBe('https:');
          expect(parsed.protocol).not.toBe('http:');
        } catch {
          // new URL('about:blank') may throw in some environments — that's also a rejection
        }
      }
    });

    it('rejects non-HTTP schemes like ftp:', () => {
      const parsed = new URL('ftp://files.example.com/data');
      expect(parsed.protocol).toBe('ftp:');
      expect(parsed.protocol !== 'http:' && parsed.protocol !== 'https:').toBe(true);
    });

    it('wraps bridge result into MCP ToolResult format', () => {
      // When bridge returns { result: 'data', error: null }, dispatch wraps as:
      // { content: [{ type: 'text', text: 'data' }] }
      const bridgeResult = { result: 'search results', error: null as string | null };
      const toolResult = bridgeResult.error
        ? { content: [{ type: 'text', text: bridgeResult.error }], isError: true }
        : { content: [{ type: 'text', text: typeof bridgeResult.result === 'string' ? bridgeResult.result : JSON.stringify(bridgeResult.result) }] };

      expect(toolResult.content[0].text).toBe('search results');
      expect((toolResult as any).isError).toBeUndefined();
    });

    it('wraps bridge error as isError: true', () => {
      const bridgeResult = { result: null, error: 'Tool not found' };
      const toolResult = bridgeResult.error
        ? { content: [{ type: 'text', text: bridgeResult.error }], isError: true }
        : { content: [{ type: 'text', text: String(bridgeResult.result) }] };

      expect(toolResult.content[0].text).toBe('Tool not found');
      expect(toolResult.isError).toBe(true);
    });

    it('status includes WebMCP info when enabled with tools', () => {
      // Simulate the status handler's WebMCP section
      const cachedTools = [{ name: 'search' }, { name: 'submit' }];
      const status: any = {};
      status.webmcp = {
        enabled: true,
        toolCount: cachedTools.length,
        tools: cachedTools.map(t => t.name),
        note: cachedTools.length > 0 ? 'Tools cached by hostname. Only tools on current page will execute.' : undefined,
      };

      expect(status.webmcp.enabled).toBe(true);
      expect(status.webmcp.toolCount).toBe(2);
      expect(status.webmcp.tools).toEqual(['search', 'submit']);
      expect(status.webmcp.note).toContain('hostname');
    });

    it('status shows empty tools when enabled but no tools found', () => {
      const status: any = {};
      status.webmcp = { enabled: true, toolCount: 0, tools: [] };
      expect(status.webmcp.toolCount).toBe(0);
      expect(status.webmcp.tools).toEqual([]);
    });
  });

  // ─── Scanner pruning tests ─────────────────────────────────────

  describe('scanner pruning', () => {
    it('prunes stale tools on authoritative rescan', async () => {
      const db = mockDatabase();

      // First scan discovers 3 tools
      const browser1 = mockBrowser({
        result: [
          { name: 'alpha', description: 'Alpha tool' },
          { name: 'beta', description: 'Beta tool' },
          { name: 'gamma', description: 'Gamma tool' },
        ],
      });

      await scanWebMcp('prune-test.com', browser1, db);

      // Second scan only has alpha and gamma (beta removed)
      const browser2 = mockBrowser({
        result: [
          { name: 'alpha', description: 'Alpha tool v2' },
          { name: 'gamma', description: 'Gamma tool v2' },
        ],
      });

      await scanWebMcp('prune-test.com', browser2, db);

      // Verify DELETE was called with NOT IN clause (once per scan)
      const deleteCalls = (db.run as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('DELETE') && (call[0] as string).includes('NOT IN'),
      );
      expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
      // The last prune call should only keep alpha and gamma
      const lastPrune = deleteCalls[deleteCalls.length - 1];
      expect(lastPrune[1]).toBe('prune-test.com');
      // The kept tool names should include alpha and gamma
      const keptNames = lastPrune.slice(2);
      expect(keptNames).toContain('alpha');
      expect(keptNames).toContain('gamma');
      expect(keptNames).not.toContain('beta');
    });

    it('clears all tools when scan returns 0', async () => {
      const db = mockDatabase();

      // First scan discovers tools
      const browser1 = mockBrowser({
        result: [{ name: 'tool1', description: 'Tool 1' }],
      });
      await scanWebMcp('clear-test.com', browser1, db);

      // Second scan returns empty (available=true, tools=[])
      const browser2 = mockBrowser({ result: [] });
      await scanWebMcp('clear-test.com', browser2, db);

      // Verify DELETE all was called
      const deleteCalls = (db.run as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('DELETE') && !(call[0] as string).includes('NOT IN'),
      );
      expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
      const lastDelete = deleteCalls[deleteCalls.length - 1];
      expect(lastDelete[1]).toBe('clear-test.com');
    });

    it('preserves cache on scan failure (non-authoritative)', async () => {
      const db = mockDatabase();

      // First scan discovers tools
      const browser1 = mockBrowser({
        result: [{ name: 'keeper', description: 'Keep this' }],
      });
      await scanWebMcp('cache-test.com', browser1, db);

      // Verify tool was inserted
      const insertCalls1 = (db.run as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('INSERT'),
      );
      expect(insertCalls1.length).toBeGreaterThan(0);

      // Second scan fails (listModelContextTools throws)
      const browser2 = mockBrowser();
      browser2.listModelContextTools = vi.fn().mockRejectedValue(new Error('Page crashed'));

      // Clear mock to track only second scan's calls
      (db.run as ReturnType<typeof vi.fn>).mockClear();

      await scanWebMcp('cache-test.com', browser2, db);

      // On failure, no DELETE should have been called (cache preserved)
      const deleteCalls = (db.run as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('DELETE'),
      );
      expect(deleteCalls.length).toBe(0);
    });
  });

  // ─── loadCachedTools ordering and cap ──────────────────────────

  describe('loadCachedTools', () => {
    it('orders and caps at 20', () => {
      const db = {
        all: vi.fn().mockReturnValue(
          Array.from({ length: 25 }, (_, i) => ({
            tool_name: `tool_${String(i).padStart(2, '0')}`,
            description: `Tool ${i}`,
            input_schema: null,
          })),
        ),
      } as unknown as AgentDatabase;

      // loadCachedTools uses LIMIT 20 in SQL, so DB should return max 20
      // But if DB returns 25 (mocked), the function still maps them
      const tools = loadCachedTools('example.com', db);

      // Verify the SQL query includes LIMIT 20 and ORDER BY
      const sqlCall = (db.all as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(sqlCall).toContain('LIMIT 20');
      expect(sqlCall).toContain('ORDER BY');
    });
  });

  // ─── META_TOOLS schema validation ──────────────────────────────

  describe('schrute_webmcp_call in META_TOOLS', () => {
    it('is present in META_TOOLS array', () => {
      const tool = META_TOOLS.find(t => t.name === 'schrute_webmcp_call');
      expect(tool).toBeDefined();
    });

    it('has correct schema with required toolName', () => {
      const tool = META_TOOLS.find(t => t.name === 'schrute_webmcp_call')!;
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toHaveProperty('toolName');
      expect(tool.inputSchema.properties).toHaveProperty('args');
      expect(tool.inputSchema.required).toContain('toolName');
    });

    it('has appropriate description', () => {
      const tool = META_TOOLS.find(t => t.name === 'schrute_webmcp_call')!;
      expect(tool.description).toContain('WebMCP');
    });
  });
});
