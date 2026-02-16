import { getLogger } from '../core/logger.js';
import { getConfig } from '../core/config.js';
import { BrowserManager } from '../browser/manager.js';
import { CookieJar } from '../browser/cookie-jar.js';

const log = getLogger();

// ─── Singleton BrowserManager for refresh operations ────────────

let sharedBrowserManager: BrowserManager | null = null;

function getDefaultBrowserManager(): BrowserManager {
  if (!sharedBrowserManager) {
    sharedBrowserManager = new BrowserManager(getConfig());
  }
  return sharedBrowserManager;
}

// ─── sameSite mapping ───────────────────────────────────────────

const SAME_SITE_MAP: Record<string, 'Strict' | 'Lax' | 'None'> = {
  'Strict': 'Strict',
  'Lax': 'Lax',
  'None': 'None',
};

// ─── Cookie Refresh ──────────────────────────────────────────────

export async function refreshCookies(
  siteId: string,
  cookieJar?: CookieJar,
  browserManager?: BrowserManager,
): Promise<boolean> {
  // When no explicit manager is provided, create a per-cycle instance
  // to avoid leaking a long-lived singleton browser process (CR-11).
  const isDefaultManager = !browserManager;
  const manager = browserManager ?? getDefaultBrowserManager();
  const jar = cookieJar ?? new CookieJar();

  log.info({ siteId }, 'Starting cookie refresh');

  try {
    // Create a browser context for this site
    const context = await manager.getOrCreateContext(siteId);

    // Navigate to the site root to trigger cookie refresh
    const page = await context.newPage();
    const url = `https://${siteId}`;

    try {
      await page.goto(url, {
        waitUntil: 'networkidle',
        timeout: 30000,
      });
    } catch (err) {
      // networkidle may time out but cookies might still be set
      log.debug({ siteId, err }, 'Navigation timeout during cookie refresh (may be OK)');
    }

    // Extract cookies from the browser context
    const browserCookies = await context.cookies();

    if (browserCookies.length === 0) {
      log.warn({ siteId }, 'No cookies found after refresh');
      await page.close();
      return false;
    }

    // Map Playwright cookies to CookieJar format
    const entries = browserCookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: SAME_SITE_MAP[c.sameSite] ?? 'Lax',
    }));

    await jar.saveCookies(siteId, entries);

    log.info(
      { siteId, count: entries.length },
      'Cookie refresh complete',
    );

    await page.close();
    return true;
  } catch (err) {
    log.error({ siteId, err }, 'Cookie refresh failed');
    return false;
  } finally {
    // CR-11: Close the default singleton browser manager after each refresh
    // cycle to avoid leaking a long-lived browser process.
    if (isDefaultManager && sharedBrowserManager) {
      try {
        await sharedBrowserManager.closeAll();
      } catch (err) {
        log.warn({ err }, 'Failed to close shared browser manager after cookie refresh');
      }
      sharedBrowserManager = null;
    }
  }
}
