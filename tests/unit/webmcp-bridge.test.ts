import { describe, it, expect, vi } from 'vitest';
import { executeWebMcpTool } from '../../src/browser/webmcp-bridge.js';
import type { BrowserProvider, SealedModelContextRequest, SealedModelContextResponse } from '../../src/skill/types.js';

// ─── Mocks ───────────────────────────────────────────────────────────

function mockBrowser(
  response?: SealedModelContextResponse,
): BrowserProvider {
  const base: BrowserProvider = {
    navigate: vi.fn(),
    snapshot: vi.fn(),
    click: vi.fn(),
    type: vi.fn(),
    evaluateFetch: vi.fn(),
    screenshot: vi.fn(),
    networkRequests: vi.fn(),
  };

  if (response !== undefined) {
    base.evaluateModelContext = vi.fn().mockResolvedValue(response);
  }

  return base;
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('webmcp-bridge', () => {
  const allowedTools = ['search', 'addToCart', 'getProduct'];

  it('executes allowed tool successfully', async () => {
    const browser = mockBrowser({ result: { items: [1, 2, 3] } });
    const req: SealedModelContextRequest = { toolName: 'search', args: { q: 'test' } };

    const result = await executeWebMcpTool(req, browser, allowedTools);

    expect(result.result).toEqual({ items: [1, 2, 3] });
    expect(result.error).toBeUndefined();
    expect(browser.evaluateModelContext).toHaveBeenCalledWith(req);
  });

  it('rejects tool not in allowlist', async () => {
    const browser = mockBrowser({ result: 'should not reach' });
    const req: SealedModelContextRequest = { toolName: 'deleteAll', args: {} };

    const result = await executeWebMcpTool(req, browser, allowedTools);

    expect(result.error).toContain('not in the allowed tools list');
    expect(result.result).toBeNull();
    expect(browser.evaluateModelContext).not.toHaveBeenCalled();
  });

  it('rejects invalid tool name format', async () => {
    const browser = mockBrowser({ result: 'should not reach' });
    const allowList = ['a; rm -rf /'];
    const req: SealedModelContextRequest = { toolName: 'a; rm -rf /', args: {} };

    const result = await executeWebMcpTool(req, browser, allowList);

    expect(result.error).toContain('Invalid tool name');
    expect(result.result).toBeNull();
  });

  it('rejects when browser lacks evaluateModelContext', async () => {
    const browser = mockBrowser(); // no evaluateModelContext
    const req: SealedModelContextRequest = { toolName: 'search', args: {} };

    const result = await executeWebMcpTool(req, browser, allowedTools);

    expect(result.error).toContain('does not support evaluateModelContext');
    expect(result.result).toBeNull();
  });

  it('rejects non-object args', async () => {
    const browser = mockBrowser({ result: 'should not reach' });
    const req = { toolName: 'search', args: null } as unknown as SealedModelContextRequest;

    const result = await executeWebMcpTool(req, browser, allowedTools);

    expect(result.error).toContain('args must be a plain object');
  });

  it('rejects array args', async () => {
    const browser = mockBrowser({ result: 'should not reach' });
    const req = { toolName: 'search', args: [1, 2, 3] } as unknown as SealedModelContextRequest;

    const result = await executeWebMcpTool(req, browser, allowedTools);

    expect(result.error).toContain('args must be a plain object');
  });

  it('propagates error from evaluateModelContext', async () => {
    const browser = mockBrowser({ result: null, error: 'Tool not found' });
    const req: SealedModelContextRequest = { toolName: 'search', args: {} };

    const result = await executeWebMcpTool(req, browser, allowedTools);

    expect(result.error).toBe('Tool not found');
  });

  it('handles evaluateModelContext throwing', async () => {
    const browser = mockBrowser();
    browser.evaluateModelContext = vi.fn().mockRejectedValue(new Error('Connection lost'));
    const req: SealedModelContextRequest = { toolName: 'search', args: {} };

    const result = await executeWebMcpTool(req, browser, allowedTools);

    expect(result.error).toContain('Execution failed');
    expect(result.error).toContain('Connection lost');
    expect(result.result).toBeNull();
  });

  it('accepts valid tool name with dots and dashes', async () => {
    const browser = mockBrowser({ result: 'ok' });
    const tools = ['my-tool.v2'];
    const req: SealedModelContextRequest = { toolName: 'my-tool.v2', args: {} };

    const result = await executeWebMcpTool(req, browser, tools);

    expect(result.result).toBe('ok');
    expect(result.error).toBeUndefined();
  });

  it('rejects tool name starting with number', async () => {
    const browser = mockBrowser({ result: 'ok' });
    const tools = ['123tool'];
    const req: SealedModelContextRequest = { toolName: '123tool', args: {} };

    const result = await executeWebMcpTool(req, browser, tools);

    expect(result.error).toContain('Invalid tool name');
  });

  it('rejects empty tool name', async () => {
    const browser = mockBrowser({ result: 'ok' });
    const req: SealedModelContextRequest = { toolName: '', args: {} };

    const result = await executeWebMcpTool(req, browser, ['']);

    expect(result.error).toContain('Invalid tool name');
  });
});
