import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// We need to create a concrete subclass since BaseBrowserAdapter is abstract
// Import after mocking
const { BaseBrowserAdapter } = await import('../../src/browser/base-browser-adapter.js');

class TestAdapter extends BaseBrowserAdapter {
  constructor(page: any, domainAllowlist: string[], options?: any) {
    super(page, domainAllowlist, options);
  }
}

function mockPage() {
  const mainFrameMock = {
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
  };

  return {
    goto: vi.fn().mockResolvedValue(undefined),
    goBack: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue('https://example.com'),
    title: vi.fn().mockResolvedValue('Example'),
    mainFrame: vi.fn().mockReturnValue(mainFrameMock),
    frames: vi.fn().mockReturnValue([mainFrameMock]),
    locator: vi.fn().mockReturnValue({
      ariaSnapshot: vi.fn().mockResolvedValue('- button "Test"'),
      innerText: vi.fn().mockResolvedValue('Test'),
      click: vi.fn().mockResolvedValue(undefined),
      fill: vi.fn().mockResolvedValue(undefined),
      hover: vi.fn().mockResolvedValue(undefined),
      dragTo: vi.fn().mockResolvedValue(undefined),
      setInputFiles: vi.fn().mockResolvedValue(undefined),
      selectOption: vi.fn().mockResolvedValue(undefined),
      screenshot: vi.fn().mockResolvedValue(Buffer.from([])),
      first: vi.fn().mockReturnThis(),
      nth: vi.fn().mockReturnThis(),
    }),
    getByRole: vi.fn().mockReturnValue({
      click: vi.fn().mockResolvedValue(undefined),
      fill: vi.fn().mockResolvedValue(undefined),
      hover: vi.fn().mockResolvedValue(undefined),
      nth: vi.fn().mockReturnThis(),
      getByRole: vi.fn().mockReturnThis(),
      first: vi.fn().mockReturnThis(),
    }),
    keyboard: { press: vi.fn().mockResolvedValue(undefined) },
    screenshot: vi.fn().mockResolvedValue(Buffer.from([])),
    on: vi.fn(),
    off: vi.fn(),
    context: vi.fn().mockReturnValue({ pages: () => [] }),
    setViewportSize: vi.fn().mockResolvedValue(undefined),
    setDefaultTimeout: vi.fn(),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('browser_batch_actions', () => {
  it('executes batch of clicks and returns results + snapshot', async () => {
    const page = mockPage();
    const adapter = new TestAdapter(page as any, [], {
      flags: {
        snapshotMode: 'full' as const,
        incrementalDiffs: false,
        modalTracking: false,
        screenshotResize: false,
        batchActions: true,
      },
    });

    const result = await adapter.proxyTool('browser_batch_actions', {
      actions: [
        { tool: 'browser_press_key', args: { key: 'Enter' } },
        { tool: 'browser_press_key', args: { key: 'Tab' } },
      ],
    }) as any;

    expect(result.results).toHaveLength(2);
    expect(result.results[0].success).toBe(true);
    expect(result.results[1].success).toBe(true);
    expect(result.snapshot).toBeDefined();
  });

  it('continues after individual action failure', async () => {
    const page = mockPage();
    page.keyboard.press.mockRejectedValueOnce(new Error('key not found'));
    page.keyboard.press.mockResolvedValueOnce(undefined);

    const adapter = new TestAdapter(page as any, [], {
      flags: {
        snapshotMode: 'full' as const,
        incrementalDiffs: false,
        modalTracking: false,
        screenshotResize: false,
        batchActions: true,
      },
    });

    const result = await adapter.proxyTool('browser_batch_actions', {
      actions: [
        { tool: 'browser_press_key', args: { key: 'BadKey' } },
        { tool: 'browser_press_key', args: { key: 'Enter' } },
      ],
    }) as any;

    expect(result.results[0].success).toBe(false);
    expect(result.results[0].error).toContain('key not found');
    expect(result.results[1].success).toBe(true);
  });

  it('rejects nested batch actions', async () => {
    const page = mockPage();
    const adapter = new TestAdapter(page as any, [], {
      flags: {
        snapshotMode: 'full' as const,
        incrementalDiffs: false,
        modalTracking: false,
        screenshotResize: false,
        batchActions: true,
      },
    });

    await expect(
      adapter.proxyTool('browser_batch_actions', {
        actions: [
          { tool: 'browser_batch_actions', args: { actions: [] } },
        ],
      }),
    ).rejects.toThrow('unsafe tool');
  });

  it('rejects exceeding max actions', async () => {
    const page = mockPage();
    const adapter = new TestAdapter(page as any, [], {
      flags: {
        snapshotMode: 'full' as const,
        incrementalDiffs: false,
        modalTracking: false,
        screenshotResize: false,
        batchActions: true,
      },
    });

    const actions = Array.from({ length: 25 }, () => ({
      tool: 'browser_press_key',
      args: { key: 'Enter' },
    }));

    await expect(
      adapter.proxyTool('browser_batch_actions', { actions }),
    ).rejects.toThrow('exceeds max');
  });

  it('rejects unsafe tools in batch (navigate)', async () => {
    const page = mockPage();
    const adapter = new TestAdapter(page as any, [], {
      flags: {
        snapshotMode: 'full' as const,
        incrementalDiffs: false,
        modalTracking: false,
        screenshotResize: false,
        batchActions: true,
      },
    });

    await expect(
      adapter.proxyTool('browser_batch_actions', {
        actions: [{ tool: 'browser_navigate', args: { url: 'https://evil.com' } }],
      }),
    ).rejects.toThrow('unsafe tool');
  });

  it('rejects unsafe tools in batch (close)', async () => {
    const page = mockPage();
    const adapter = new TestAdapter(page as any, [], {
      flags: {
        snapshotMode: 'full' as const,
        incrementalDiffs: false,
        modalTracking: false,
        screenshotResize: false,
        batchActions: true,
      },
    });

    await expect(
      adapter.proxyTool('browser_batch_actions', {
        actions: [{ tool: 'browser_close', args: {} }],
      }),
    ).rejects.toThrow('unsafe tool');
  });

  it('rejects when batch actions feature is disabled', async () => {
    const page = mockPage();
    const adapter = new TestAdapter(page as any, [], {
      flags: {
        snapshotMode: 'full' as const,
        incrementalDiffs: false,
        modalTracking: false,
        screenshotResize: false,
        batchActions: false,
      },
    });

    await expect(
      adapter.proxyTool('browser_batch_actions', {
        actions: [{ tool: 'browser_press_key', args: { key: 'Enter' } }],
      }),
    ).rejects.toThrow('disabled');
  });

  it('handles empty batch', async () => {
    const page = mockPage();
    const adapter = new TestAdapter(page as any, [], {
      flags: {
        snapshotMode: 'full' as const,
        incrementalDiffs: false,
        modalTracking: false,
        screenshotResize: false,
        batchActions: true,
      },
    });

    const result = await adapter.proxyTool('browser_batch_actions', {
      actions: [],
    }) as any;

    expect(result.results).toHaveLength(0);
    expect(result.snapshot).toBeDefined();
  });

  it('restores original timeout after batch', async () => {
    const page = mockPage();
    const adapter = new TestAdapter(page as any, [], {
      flags: {
        snapshotMode: 'full' as const,
        incrementalDiffs: false,
        modalTracking: false,
        screenshotResize: false,
        batchActions: true,
      },
    });

    await adapter.proxyTool('browser_batch_actions', {
      actions: [{ tool: 'browser_press_key', args: { key: 'Enter' } }],
    });

    // The last setDefaultTimeout call should restore the original
    const calls = page.setDefaultTimeout.mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[0]).toBe(30_000); // default timeout restored
  });
});
