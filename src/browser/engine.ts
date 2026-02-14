import type { Browser } from 'playwright';
import type { BrowserEngine } from '../skill/types.js';
import { getLogger } from '../core/logger.js';

const log = getLogger();

export interface EngineCapabilities {
  supportsConsoleEvents: boolean;
  supportsCDP: boolean;
  configuredEngine: BrowserEngine;
  effectiveEngine: BrowserEngine;
}

export interface LaunchResult {
  browser: Browser;
  capabilities: EngineCapabilities;
}

// Camoufox probe memoization — only run once per process
let camoufoxProbePass = false;

function isModuleNotFound(err: unknown, packageName: string): boolean {
  if ((err as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') return false;
  const msg = String((err as Error).message);
  return msg.includes(`"${packageName}"`) || msg.includes(`'${packageName}'`)
    || msg.includes(`Cannot find package ${packageName}`)
    || msg.includes(`Cannot find module ${packageName}`);
}

export async function launchBrowserEngine(
  engine: BrowserEngine,
  options?: { headless?: boolean },
): Promise<LaunchResult> {
  const headless = options?.headless ?? true;

  switch (engine) {
    case 'playwright': {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless });
      return {
        browser,
        capabilities: {
          supportsConsoleEvents: true,
          supportsCDP: true,
          configuredEngine: engine,
          effectiveEngine: 'playwright',
        },
      };
    }

    case 'patchright': {
      // patchright re-exports playwright-compatible API but uses patchright-core types internally.
      // Cast to `any` to avoid nominal type mismatch between patchright-core and playwright-core.
      let patchrightChromium: typeof import('playwright')['chromium'];
      try {
        const mod = await import('patchright');
        patchrightChromium = mod.chromium as any;
      } catch (importErr) {
        const isTopLevel = isModuleNotFound(importErr, 'patchright');
        if (isTopLevel) {
          log.warn('Patchright package not found — falling back to vanilla Playwright. ' +
            'Install patchright for stealth: npm install patchright && npx patchright install chromium');
          const { chromium } = await import('playwright');
          const browser = await chromium.launch({ headless });
          return {
            browser,
            capabilities: {
              supportsConsoleEvents: true,
              supportsCDP: true,
              configuredEngine: engine,
              effectiveEngine: 'playwright',
            },
          };
        }
        throw importErr;
      }
      const browser = await patchrightChromium.launch({ headless });
      log.info('Launched Patchright (stealth Chromium)');
      return {
        browser,
        capabilities: {
          supportsConsoleEvents: false,
          supportsCDP: true,
          configuredEngine: engine,
          effectiveEngine: 'patchright',
        },
      };
    }

    case 'camoufox': {
      log.warn('Camoufox is EXPERIMENTAL — Firefox-based, no CDP');
      let browser: Browser;
      try {
        const { Camoufox } = await import('camoufox-js');
        browser = await Camoufox({ headless }) as unknown as Browser;
      } catch (err) {
        if (isModuleNotFound(err, 'camoufox-js')) {
          throw new Error(
            'Camoufox engine selected but camoufox-js is not installed. ' +
            'Install with: npm install camoufox-js && npx camoufox-js fetch',
          );
        }
        throw err;
      }

      // Runtime probe — invoke exact APIs the adapter depends on (one-time per process)
      if (!camoufoxProbePass) {
        const probeCtx = await browser.newContext();
        const probePage = await probeCtx.newPage();
        try {
          await probePage.setContent('<main><button>probe</button></main>');

          const yaml = await probePage.locator('body').ariaSnapshot({ timeout: 5000 });
          if (typeof yaml !== 'string') throw new Error('ariaSnapshot() returned non-string');

          const state = await probeCtx.storageState();
          if (!state || typeof state !== 'object') throw new Error('storageState() returned invalid result');

          const roleLocator = probePage.getByRole('button', { name: 'probe' });
          const count = await roleLocator.count();
          if (count !== 1) throw new Error(`getByRole() expected 1 match, got ${count}`);
        } catch (probeErr) {
          await probePage.close().catch((err) => log.debug({ err }, 'Probe page cleanup failed'));
          await probeCtx.close().catch((err) => log.debug({ err }, 'Probe context cleanup failed'));
          await browser.close().catch((err) => log.debug({ err }, 'Browser cleanup failed'));
          let pwVersion = 'unknown';
          try {
            const { createRequire } = await import('node:module');
            const req = createRequire(import.meta.url);
            pwVersion = req('playwright-core/package.json').version;
          } catch { /* version diagnostic is best-effort */ }
          throw new Error(
            `Camoufox runtime probe failed: ${probeErr instanceof Error ? probeErr.message : String(probeErr)}. ` +
            `This may be a playwright-core version mismatch (installed: ${pwVersion}). ` +
            'Try: npm update camoufox-js playwright',
          );
        }
        await probePage.close();
        await probeCtx.close();
        camoufoxProbePass = true;
      }

      return {
        browser,
        capabilities: {
          supportsConsoleEvents: true,
          supportsCDP: false,
          configuredEngine: engine,
          effectiveEngine: 'camoufox',
        },
      };
    }

    default:
      throw new Error(`Unknown browser engine: ${engine}`);
  }
}

/**
 * Reset the camoufox probe flag — for testing only.
 */
export function _resetCamoufoxProbe(): void {
  camoufoxProbePass = false;
}
