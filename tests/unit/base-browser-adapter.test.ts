import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { BaseBrowserAdapter } = await import('../../src/browser/base-browser-adapter.js');

class TestAdapter extends BaseBrowserAdapter {
  constructor(page: any, domainAllowlist: string[], options?: any) {
    super(page, domainAllowlist, options);
  }
}

function mockPage(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

function getResponseHandler(page: ReturnType<typeof mockPage>) {
  const call = (page.on as ReturnType<typeof vi.fn>).mock.calls.find(([event]) => event === 'response');
  return call?.[1] as ((response: unknown) => Promise<void>) | undefined;
}

function makeResponseMock(overrides: Partial<{
  url: string;
  method: string;
  status: number;
  resourceType: string;
  requestBody: string;
  responseBody: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
}> = {}) {
  const request = {
    timing: vi.fn().mockReturnValue({ startTime: 1000, responseEnd: 1100 }),
    url: vi.fn().mockReturnValue(overrides.url ?? 'https://api.example.com/users'),
    method: vi.fn().mockReturnValue(overrides.method ?? 'GET'),
    resourceType: vi.fn().mockReturnValue(overrides.resourceType ?? 'fetch'),
    postData: vi.fn().mockReturnValue(overrides.requestBody),
    allHeaders: vi.fn().mockResolvedValue(overrides.requestHeaders ?? { accept: 'application/json' }),
  };

  const response = {
    request: vi.fn().mockReturnValue(request),
    status: vi.fn().mockReturnValue(overrides.status ?? 200),
    text: vi.fn().mockResolvedValue(overrides.responseBody ?? '{"ok":true}'),
    allHeaders: vi.fn().mockResolvedValue(overrides.responseHeaders ?? { 'content-type': 'application/json' }),
  };

  return { request, response };
}

describe('BaseBrowserAdapter network capture', () => {
  it('skips request and response body reads for obvious noise', async () => {
    const page = mockPage();
    new TestAdapter(page as any, ['example.com']);

    const handler = getResponseHandler(page)!;
    const { request, response } = makeResponseMock({
      url: 'https://cdn.example.com/app.js',
      resourceType: 'script',
      responseHeaders: { 'content-type': 'application/javascript' },
    });

    await handler(response as any);

    expect(request.postData).not.toHaveBeenCalled();
    expect(response.text).not.toHaveBeenCalled();
  });

  it('captures request and response bodies for same-origin json responses', async () => {
    const page = mockPage();
    const adapter = new TestAdapter(page as any, ['example.com']);

    const handler = getResponseHandler(page)!;
    const { request, response } = makeResponseMock({
      url: 'https://api.example.com/users',
      method: 'POST',
      requestBody: '{"name":"Pam"}',
      responseBody: '{"id":2}',
      responseHeaders: { 'content-type': 'application/json' },
    });

    await handler(response as any);

    expect(request.postData).toHaveBeenCalled();
    expect(response.text).toHaveBeenCalled();

    const entries = await adapter.networkRequests(true);
    expect(entries).toHaveLength(1);
    expect(entries[0].requestBody).toBe('{"name":"Pam"}');
    expect(entries[0].responseBody).toBe('{"id":2}');
  });
});
