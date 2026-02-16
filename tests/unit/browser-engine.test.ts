import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Shared mock fns (created once via vi.hoisted, cleared between tests) ───
const mocks = vi.hoisted(() => ({
  playwrightLaunch: vi.fn(),
  patchrightLaunch: vi.fn(),
  camoufoxLaunch: vi.fn(),
}));

// Mock browser objects
function makeMockBrowser() {
  const mockPage = {
    setContent: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn().mockReturnValue({
      ariaSnapshot: vi.fn().mockResolvedValue('- button "probe"'),
    }),
    getByRole: vi.fn().mockReturnValue({
      count: vi.fn().mockResolvedValue(1),
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };

  const mockContext = {
    newPage: vi.fn().mockResolvedValue(mockPage),
    storageState: vi.fn().mockResolvedValue({ cookies: [], origins: [] }),
    close: vi.fn().mockResolvedValue(undefined),
  };

  const mockBrowser = {
    newContext: vi.fn().mockResolvedValue(mockContext),
    close: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    on: vi.fn(),
  };

  return { mockBrowser, mockContext, mockPage };
}

/**
 * Returns a fresh engine module with explicitly configured mocks.
 * Each call does vi.resetModules() + vi.doMock() + dynamic import,
 * so tests never leak mock state to each other.
 */
async function freshEngine(overrides?: {
  patchrightError?: Error;
  camoufoxError?: Error;
}) {
  vi.resetModules();

  vi.doMock('playwright', () => ({
    chromium: { launch: mocks.playwrightLaunch },
  }));

  if (overrides?.patchrightError) {
    // Use a getter to throw on property access instead of throwing from the
    // factory. Vitest wraps errors thrown from mock factories in its own
    // error wrapper, which strips the original error's `code` property and
    // breaks `isModuleNotFound()` detection. A getter defers the throw to
    // when engine.ts accesses `mod.chromium`, bypassing vitest's wrapping.
    const err = overrides.patchrightError;
    vi.doMock('patchright', () => ({
      get chromium() { throw err; },
    }));
  } else {
    vi.doMock('patchright', () => ({
      chromium: { launch: mocks.patchrightLaunch },
    }));
  }

  if (overrides?.camoufoxError) {
    const err = overrides.camoufoxError;
    vi.doMock('camoufox-js', () => ({
      get Camoufox() { throw err; },
    }));
  } else {
    vi.doMock('camoufox-js', () => ({
      Camoufox: mocks.camoufoxLaunch,
    }));
  }

  vi.doMock('../../src/core/logger.js', () => ({
    getLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  }));

  return import('../../src/browser/engine.js');
}

describe('Browser Engine Factory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('playwright engine', () => {
    it('launches vanilla playwright with correct capabilities', async () => {
      const { mockBrowser } = makeMockBrowser();
      mocks.playwrightLaunch.mockResolvedValue(mockBrowser);

      const { launchBrowserEngine } = await freshEngine();
      const result = await launchBrowserEngine('playwright');

      expect(result.browser).toBe(mockBrowser);
      expect(result.capabilities).toEqual({
        supportsConsoleEvents: true,
        supportsCDP: true,
        configuredEngine: 'playwright',
        effectiveEngine: 'playwright',
      });
      expect(mocks.playwrightLaunch).toHaveBeenCalledWith({ headless: true });
    });
  });

  describe('patchright engine', () => {
    it('launches patchright with correct capabilities', async () => {
      const { mockBrowser } = makeMockBrowser();
      mocks.patchrightLaunch.mockResolvedValue(mockBrowser);

      const { launchBrowserEngine } = await freshEngine();
      const result = await launchBrowserEngine('patchright');

      expect(result.browser).toBe(mockBrowser);
      expect(result.capabilities).toEqual({
        supportsConsoleEvents: false,
        supportsCDP: true,
        configuredEngine: 'patchright',
        effectiveEngine: 'patchright',
      });
    });

    it('falls back to playwright when patchright not found', async () => {
      const importErr = new Error("Cannot find module 'patchright'");
      (importErr as NodeJS.ErrnoException).code = 'ERR_MODULE_NOT_FOUND';
      const { mockBrowser } = makeMockBrowser();
      mocks.playwrightLaunch.mockResolvedValue(mockBrowser);

      const { launchBrowserEngine } = await freshEngine({ patchrightError: importErr });
      const result = await launchBrowserEngine('patchright');

      expect(result.capabilities.configuredEngine).toBe('patchright');
      expect(result.capabilities.effectiveEngine).toBe('playwright');
      expect(result.capabilities.supportsConsoleEvents).toBe(true);
    });

    it('throws on non-module-not-found patchright errors', async () => {
      const importErr = new Error('Some other error');
      (importErr as NodeJS.ErrnoException).code = 'ERR_MODULE_NOT_FOUND';

      const { launchBrowserEngine } = await freshEngine({ patchrightError: importErr });
      await expect(launchBrowserEngine('patchright')).rejects.toThrow('Some other error');
    });

    it('does not fallback when patchright launch fails (import OK)', async () => {
      mocks.patchrightLaunch.mockRejectedValue(new Error('Browser binary not found'));

      const { launchBrowserEngine } = await freshEngine();
      await expect(launchBrowserEngine('patchright')).rejects.toThrow('Browser binary not found');
      expect(mocks.playwrightLaunch).not.toHaveBeenCalled();
    });

    it('does not fallback when a transitive dep is missing (false-positive prevention)', async () => {
      // If patchright IS installed but one of its internal deps (e.g. patchright-core)
      // is missing, the ERR_MODULE_NOT_FOUND error should NOT trigger the playwright
      // fallback — only a top-level "patchright" not-found should.
      const importErr = new Error("Cannot find package 'patchright-core' imported from /node_modules/patchright/lib/index.js");
      (importErr as NodeJS.ErrnoException).code = 'ERR_MODULE_NOT_FOUND';

      const { launchBrowserEngine } = await freshEngine({ patchrightError: importErr });
      await expect(launchBrowserEngine('patchright')).rejects.toThrow('patchright-core');
      expect(mocks.playwrightLaunch).not.toHaveBeenCalled();
    });
  });

  describe('camoufox engine', () => {
    it('launches camoufox with probe and correct capabilities', async () => {
      const { mockBrowser } = makeMockBrowser();
      mocks.camoufoxLaunch.mockResolvedValue(mockBrowser);

      const { launchBrowserEngine } = await freshEngine();
      const result = await launchBrowserEngine('camoufox');

      expect(result.capabilities).toEqual({
        supportsConsoleEvents: true,
        supportsCDP: false,
        configuredEngine: 'camoufox',
        effectiveEngine: 'camoufox',
      });
    });

    it('throws clear error when camoufox-js not installed', async () => {
      const err = new Error("Cannot find module 'camoufox-js'");
      (err as NodeJS.ErrnoException).code = 'ERR_MODULE_NOT_FOUND';

      const { launchBrowserEngine } = await freshEngine({ camoufoxError: err });
      await expect(launchBrowserEngine('camoufox')).rejects.toThrow(
        'camoufox-js is not installed',
      );
    });

    it('skips probe on second launch (memoization)', async () => {
      const { mockBrowser } = makeMockBrowser();
      mocks.camoufoxLaunch.mockResolvedValue(mockBrowser);

      const { launchBrowserEngine } = await freshEngine();

      // First launch — probe runs
      await launchBrowserEngine('camoufox');
      expect(mockBrowser.newContext).toHaveBeenCalledTimes(1);

      // Second launch — probe skipped (same module instance, shared camoufoxProbePass)
      vi.clearAllMocks();
      const { mockBrowser: mockBrowser2 } = makeMockBrowser();
      mocks.camoufoxLaunch.mockResolvedValue(mockBrowser2);
      await launchBrowserEngine('camoufox');
      expect(mockBrowser2.newContext).not.toHaveBeenCalled();
    });

    it('throws on probe failure with version diagnostic', async () => {
      const mockPage = {
        setContent: vi.fn().mockResolvedValue(undefined),
        locator: vi.fn().mockReturnValue({
          ariaSnapshot: vi.fn().mockRejectedValue(new Error('ariaSnapshot not supported')),
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const mockContext = {
        newPage: vi.fn().mockResolvedValue(mockPage),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const mockBrowser = {
        newContext: vi.fn().mockResolvedValue(mockContext),
        close: vi.fn().mockResolvedValue(undefined),
      };
      mocks.camoufoxLaunch.mockResolvedValue(mockBrowser);

      const { launchBrowserEngine } = await freshEngine();
      await expect(launchBrowserEngine('camoufox')).rejects.toThrow('Camoufox runtime probe failed');
    });
  });

  describe('invalid engine', () => {
    it('throws on unknown engine', async () => {
      const { launchBrowserEngine } = await freshEngine();
      await expect(launchBrowserEngine('selenium' as any)).rejects.toThrow('Unknown browser engine');
    });
  });

  describe('headless option', () => {
    it('passes headless=false to playwright', async () => {
      const { mockBrowser } = makeMockBrowser();
      mocks.playwrightLaunch.mockResolvedValue(mockBrowser);

      const { launchBrowserEngine } = await freshEngine();
      await launchBrowserEngine('playwright', { headless: false });
      expect(mocks.playwrightLaunch).toHaveBeenCalledWith({ headless: false });
    });
  });
});
