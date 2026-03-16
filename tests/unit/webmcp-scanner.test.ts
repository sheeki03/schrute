import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scanWebMcp, loadCachedTools } from '../../src/discovery/webmcp-scanner.js';
import type { BrowserProvider, SealedModelContextRequest, SealedModelContextResponse } from '../../src/skill/types.js';
import type { AgentDatabase } from '../../src/storage/database.js';

// ─── Mocks ───────────────────────────────────────────────────────────

function mockBrowser(
  modelContextResult?: SealedModelContextResponse,
): BrowserProvider {
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
      // Track inserts for verification
      if (sql.includes('INSERT')) {
        const key = `${params[0]}:${params[1]}`;
        store.set(key, params);
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

// ─── Tests ───────────────────────────────────────────────────────────

describe('webmcp-scanner', () => {
  describe('scanWebMcp', () => {
    it('returns unavailable when browser lacks listModelContextTools', async () => {
      const browser = mockBrowser(); // no evaluateModelContext
      const db = mockDatabase();

      const result = await scanWebMcp('example.com', browser, db);

      expect(result.available).toBe(false);
      expect(result.tools).toEqual([]);
    });

    it('returns unavailable when probe returns error', async () => {
      const browser = mockBrowser({ result: null, error: 'Not supported' });
      const db = mockDatabase();

      const result = await scanWebMcp('example.com', browser, db);

      expect(result.available).toBe(false);
      expect(result.tools).toEqual([]);
    });

    it('discovers WebMCP tools from browser', async () => {
      const tools = [
        { name: 'search', description: 'Search products', inputSchema: { type: 'object' } },
        { name: 'addToCart', description: 'Add item to cart', inputSchema: { type: 'object' } },
      ];

      const browser = mockBrowser({ result: tools });
      const db = mockDatabase();

      const result = await scanWebMcp('example.com', browser, db);

      expect(result.available).toBe(true);
      expect(result.tools).toHaveLength(2);
      // Tools are sorted alphabetically
      expect(result.tools[0].name).toBe('addToCart');
      expect(result.tools[0].description).toBe('Add item to cart');
      expect(result.tools[1].name).toBe('search');
    });

    it('stores discovered tools in database', async () => {
      const tools = [
        { name: 'search', description: 'Search', inputSchema: { type: 'object' } },
      ];

      const browser = mockBrowser({ result: tools });
      const db = mockDatabase();

      await scanWebMcp('example.com', browser, db);

      expect(db.run).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO webmcp_tools'),
        'example.com',
        'search',
        'Search',
        '{"type":"object"}',
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
      );
    });

    it('returns available=true with empty tools when probe succeeds but no tools', async () => {
      const browser = mockBrowser({ result: [] });
      const db = mockDatabase();

      const result = await scanWebMcp('example.com', browser, db);

      expect(result.available).toBe(true);
      expect(result.tools).toEqual([]);
    });

    it('handles exceptions gracefully', async () => {
      const browser = mockBrowser();
      browser.listModelContextTools = vi.fn().mockRejectedValue(new Error('Crash'));
      const db = mockDatabase();

      const result = await scanWebMcp('example.com', browser, db);

      expect(result.available).toBe(false);
      expect(result.tools).toEqual([]);
    });
  });

  describe('loadCachedTools', () => {
    it('loads tools from database', () => {
      const db = {
        all: vi.fn().mockReturnValue([
          { tool_name: 'search', description: 'Search items', input_schema: '{"type":"object"}' },
          { tool_name: 'checkout', description: null, input_schema: null },
        ]),
      } as unknown as AgentDatabase;

      const tools = loadCachedTools('example.com', db);

      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe('search');
      expect(tools[0].description).toBe('Search items');
      expect(tools[0].inputSchema).toEqual({ type: 'object' });
      expect(tools[1].name).toBe('checkout');
      expect(tools[1].description).toBeUndefined();
      expect(tools[1].inputSchema).toBeUndefined();
    });

    it('returns empty array when no cached tools', () => {
      const db = {
        all: vi.fn().mockReturnValue([]),
      } as unknown as AgentDatabase;

      const tools = loadCachedTools('example.com', db);
      expect(tools).toEqual([]);
    });
  });
});
