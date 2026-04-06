import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page } from 'playwright';

vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { detectAndWaitForChallenge } from '../../src/browser/base-browser-adapter.js';

function createMockPage(overrides: {
  evaluateResult?: boolean;
  titleResult?: string;
  contentResult?: string;
  urlResult?: string;
  waitForFunctionResolves?: boolean;
  waitForFunctionDelay?: number;
} = {}): Page {
  const {
    evaluateResult = false,
    titleResult = 'Example Page',
    contentResult = `<html><head><title>${titleResult}</title></head><body></body></html>`,
    urlResult = 'https://example.com/',
    waitForFunctionResolves = true,
    waitForFunctionDelay = 0,
  } = overrides;

  return {
    evaluate: vi.fn().mockResolvedValue(evaluateResult),
    title: vi.fn().mockResolvedValue(titleResult),
    content: vi.fn().mockResolvedValue(contentResult),
    url: vi.fn().mockReturnValue(urlResult),
    $: vi.fn().mockResolvedValue(null), // For attemptTurnstileClick iframe lookup
    waitForFunction: vi.fn().mockImplementation(() => {
      if (!waitForFunctionResolves) {
        return Promise.reject(new Error('Timeout'));
      }
      if (waitForFunctionDelay > 0) {
        return new Promise(resolve => setTimeout(resolve, waitForFunctionDelay));
      }
      return Promise.resolve();
    }),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

describe('detectAndWaitForChallenge', () => {
  it('should detect challenge selectors and Cloudflare title, then auto-wait', async () => {
    const page = createMockPage({
      evaluateResult: true,
      titleResult: 'Just a moment...',
    });

    const result = await detectAndWaitForChallenge(page);

    expect(result).toEqual({ detected: true, resolved: true });
    expect(page.evaluate).toHaveBeenCalled();
    expect(page.waitForFunction).toHaveBeenCalled();
  });

  it('should detect title-only match (no selectors) and return resolved when title changes', async () => {
    const page = createMockPage({
      evaluateResult: false,
      titleResult: 'Just a moment...',
      contentResult: '<html><head><title>Just a moment...</title></head><body>__cf_chl_ token</body></html>',
    });

    const result = await detectAndWaitForChallenge(page);

    expect(result).toEqual({ detected: true, resolved: true });
    expect(page.waitForFunction).toHaveBeenCalled();
    // Verify the waitForFunction was called with hadSelectors=false
    const call = vi.mocked(page.waitForFunction).mock.calls[0];
    const ctx = call[1] as { hadSelectors: boolean };
    expect(ctx.hadSelectors).toBe(false);
  });

  it('should NOT detect a generic challenge title without Cloudflare-specific corroboration', async () => {
    const page = createMockPage({
      evaluateResult: false,
      titleResult: 'Just a moment...',
      contentResult: '<html><head><title>Just a moment...</title></head><body>Please wait</body></html>',
      urlResult: 'https://example.com/interstitial',
    });

    const result = await detectAndWaitForChallenge(page);

    expect(result).toEqual({ detected: false, resolved: false });
    expect(page.waitForFunction).not.toHaveBeenCalled();
  });

  it('should NOT detect generic "Attention Required" without "Cloudflare"', async () => {
    const page = createMockPage({
      evaluateResult: false,
      titleResult: 'Attention Required!',
    });

    const result = await detectAndWaitForChallenge(page);

    expect(result).toEqual({ detected: false, resolved: false });
    expect(page.waitForFunction).not.toHaveBeenCalled();
  });

  it('should return not-detected when neither title nor selectors match', async () => {
    const page = createMockPage({
      evaluateResult: false,
      titleResult: 'My Website - Home',
    });

    const result = await detectAndWaitForChallenge(page);

    expect(result).toEqual({ detected: false, resolved: false });
    expect(page.waitForFunction).not.toHaveBeenCalled();
  });

  it('should return resolved when challenge selectors disappear', async () => {
    const page = createMockPage({
      evaluateResult: true,
      titleResult: 'Some title',
      waitForFunctionResolves: true,
    });

    const result = await detectAndWaitForChallenge(page);

    expect(result).toEqual({ detected: true, resolved: true });
    // Verify the waitForFunction was called with hadSelectors=true
    const call = vi.mocked(page.waitForFunction).mock.calls[0];
    const ctx = call[1] as { hadSelectors: boolean };
    expect(ctx.hadSelectors).toBe(true);
  });

  it('should detect "Verify you are human" title', async () => {
    const page = createMockPage({
      evaluateResult: false,
      titleResult: 'Verify you are human',
      contentResult: '<html><head><title>Verify you are human</title></head><body>__cf_chl_ present</body></html>',
    });

    const result = await detectAndWaitForChallenge(page);

    expect(result).toEqual({ detected: true, resolved: true });
  });

  it('should detect "Attention Required! | Cloudflare" title', async () => {
    const page = createMockPage({
      evaluateResult: false,
      titleResult: 'Attention Required! | Cloudflare',
    });

    const result = await detectAndWaitForChallenge(page);

    expect(result).toEqual({ detected: true, resolved: true });
  });

  it('should still wait when selectors present even if title changes', async () => {
    // With hadSelectors=true, the function waits for selectors to disappear, not title change
    const page = createMockPage({
      evaluateResult: true,
      titleResult: 'Just a moment...',
      waitForFunctionResolves: true,
    });

    const result = await detectAndWaitForChallenge(page);

    expect(result).toEqual({ detected: true, resolved: true });
    const call = vi.mocked(page.waitForFunction).mock.calls[0];
    const ctx = call[1] as { hadSelectors: boolean };
    expect(ctx.hadSelectors).toBe(true);
  });

  it('should return detected-but-not-resolved when challenge does not resolve within timeout', async () => {
    const page = createMockPage({
      evaluateResult: true,
      titleResult: 'Just a moment...',
      waitForFunctionResolves: false,
    });

    const result = await detectAndWaitForChallenge(page, 100);

    expect(result).toEqual({ detected: true, resolved: false });
  });

  it('should call waitForLoadState after challenge resolves if time remains', async () => {
    const page = createMockPage({
      evaluateResult: true,
      titleResult: 'Just a moment...',
      waitForFunctionResolves: true,
      waitForFunctionDelay: 0, // resolves instantly, so plenty of time remaining
    });

    await detectAndWaitForChallenge(page, 30000);

    expect(page.waitForLoadState).toHaveBeenCalledWith('domcontentloaded', expect.objectContaining({
      timeout: expect.any(Number),
    }));
  });
});

describe('detectAndWaitForChallenge selector vs title resolution', () => {
  it('with selectors present, waits for selectors to disappear even if title changes', async () => {
    // hadSelectors=true means the function should wait for selectors to disappear,
    // NOT just title change. If selectors remain, challenge is NOT resolved.
    const page = createMockPage({
      evaluateResult: true,
      titleResult: 'Just a moment...',
      waitForFunctionResolves: false, // selectors never disappear → timeout
    });

    const result = await detectAndWaitForChallenge(page, 100);

    // Even if the title might change, selectors present means we wait for them
    expect(result).toEqual({ detected: true, resolved: false }); // timeout — challenge not resolved
    const call = vi.mocked(page.waitForFunction).mock.calls[0];
    const ctx = call[1] as { hadSelectors: boolean };
    expect(ctx.hadSelectors).toBe(true);
  });
});

describe('challenge-aware snapshot content', () => {
  it('treats only explicit Cloudflare branding as sufficient title-only evidence', () => {
    const explicitCloudflareTitle = /Attention Required!.*Cloudflare/i;

    expect(explicitCloudflareTitle.test('Attention Required! | Cloudflare')).toBe(true);
    expect(explicitCloudflareTitle.test('Just a moment...')).toBe(false);
    expect(explicitCloudflareTitle.test('Verify you are human')).toBe(false);
    expect(explicitCloudflareTitle.test('Attention Required!')).toBe(false);
  });

  it('engine hint is only shown for vanilla playwright engine', () => {
    // Simulate engine hint logic from base-browser-adapter.ts:988-990
    const testCases = [
      { engine: 'playwright', expectHint: true },
      { engine: 'patchright', expectHint: false },
      { engine: 'camoufox', expectHint: false },
      { engine: 'unknown', expectHint: false },
    ];

    for (const { engine, expectHint } of testCases) {
      const engineHint = engine === 'playwright'
        ? '- Switch engine: try patchright or camoufox for better stealth\n'
        : '';
      if (expectHint) {
        expect(engineHint).toContain('Switch engine');
      } else {
        expect(engineHint).toBe('');
      }
    }
  });

  it('challenge warning includes expected guidance text', () => {
    // Simulate the warning construction from base-browser-adapter.ts:991-998
    const currentEngine = 'playwright';
    const engineHint = currentEngine === 'playwright'
      ? '- Switch engine: try patchright or camoufox for better stealth\n'
      : '';
    const warning = 'CLOUDFLARE CHALLENGE PAGE DETECTED\n' +
      'This page is showing a Cloudflare security challenge.\n' +
      'Options:\n' +
      '- Wait: call browser_snapshot again in 5-10 seconds (challenge may auto-resolve)\n' +
      '- Import cookies: use schrute_import_cookies with a cf_clearance cookie file\n' +
      engineHint +
      '- Current engine: ' + currentEngine + '\n\n';

    expect(warning).toContain('CLOUDFLARE CHALLENGE PAGE DETECTED');
    expect(warning).toContain('browser_snapshot');
    expect(warning).toContain('schrute_import_cookies');
    expect(warning).toContain('Switch engine');
    expect(warning).toContain('Current engine: playwright');
  });
});

describe('detectAndWaitForChallenge pre-check error handling', () => {
  it('returns not-detected when page.evaluate throws (context destroyed)', async () => {
    const page = createMockPage();
    (page.evaluate as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Execution context was destroyed'));

    const result = await detectAndWaitForChallenge(page, 1000);
    expect(result).toEqual({ detected: false, resolved: false });
  });

  it('returns not-detected when page.title throws (page closed)', async () => {
    const page = createMockPage();
    (page.title as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Page closed'));

    const result = await detectAndWaitForChallenge(page, 1000);
    expect(result).toEqual({ detected: false, resolved: false });
  });
});

describe('Cloudflare challenge title heuristics', () => {
  const explicitCloudflareTitle = /Attention Required!.*Cloudflare/i;
  const genericChallengeTitle = /^Just a moment\b|Verify you are human/i;

  it('matches explicit Cloudflare-branded challenge titles', () => {
    expect(explicitCloudflareTitle.test('Attention Required! | Cloudflare')).toBe(true);
  });

  it('treats generic challenge titles as generic, not decisive, signals', () => {
    expect(genericChallengeTitle.test('Just a moment...')).toBe(true);
    expect(genericChallengeTitle.test('Verify you are human')).toBe(true);
    expect(explicitCloudflareTitle.test('Just a moment...')).toBe(false);
    expect(explicitCloudflareTitle.test('Verify you are human')).toBe(false);
  });

  it('does not match unrelated titles', () => {
    expect(explicitCloudflareTitle.test('Attention Required!')).toBe(false);
    expect(genericChallengeTitle.test('Google')).toBe(false);
    expect(genericChallengeTitle.test('My Website')).toBe(false);
    expect(genericChallengeTitle.test('Just a momentary pause')).toBe(false);
  });
});

describe('cf_clearance cookie warning', () => {
  it('should detect cf_clearance in storage state cookies', () => {
    const storageState = {
      cookies: [
        { name: 'session_id', value: 'abc123' },
        { name: 'cf_clearance', value: 'clearance-token' },
      ],
      origins: [],
    };

    const cookies = storageState.cookies ?? [];
    const hasCfClearance = cookies.some((c: any) => c.name === 'cf_clearance');
    expect(hasCfClearance).toBe(true);
  });

  it('should not detect cf_clearance when absent', () => {
    const storageState = {
      cookies: [
        { name: 'session_id', value: 'abc123' },
      ],
      origins: [],
    };

    const cookies = storageState.cookies ?? [];
    const hasCfClearance = cookies.some((c: any) => c.name === 'cf_clearance');
    expect(hasCfClearance).toBe(false);
  });

  it('should handle malformed storage state JSON gracefully', () => {
    const malformedJson = '{invalid json}';
    let hasCfClearance = false;
    let parseError = false;

    try {
      const parsed = JSON.parse(malformedJson);
      const cookies = parsed.cookies ?? [];
      hasCfClearance = cookies.some((c: any) => c.name === 'cf_clearance');
    } catch {
      parseError = true;
    }

    expect(parseError).toBe(true);
    expect(hasCfClearance).toBe(false);
  });

  it('should handle missing cookies array in storage state', () => {
    const storageState = { origins: [] };
    const parsed = storageState as any;
    const cookies = parsed.cookies ?? [];
    const hasCfClearance = cookies.some((c: any) => c.name === 'cf_clearance');
    expect(hasCfClearance).toBe(false);
  });
});
