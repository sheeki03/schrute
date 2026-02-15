import { getLogger } from '../core/logger.js';
import { BrowserManager } from '../browser/manager.js';
import { CookieJar } from '../browser/cookie-jar.js';

const log = getLogger();

// ─── Singleton BrowserManager for refresh operations ────────────

let sharedBrowserManager: BrowserManager | null = null;

function getBrowserManager(): BrowserManager {
  if (!sharedBrowserManager) {
    sharedBrowserManager = new BrowserManager();
  }
  return sharedBrowserManager;
}

// ─── Cookie Refresh ──────────────────────────────────────────────

export async function refreshCookies(
  siteId: string,
  cookieJar?: CookieJar,
): Promise<boolean> {
  const manager = getBrowserManager();
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
      sameSite: (c.sameSite === 'Strict' ? 'Strict' : c.sameSite === 'Lax' ? 'Lax' : 'None') as 'Strict' | 'Lax' | 'None',
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
  }
}
