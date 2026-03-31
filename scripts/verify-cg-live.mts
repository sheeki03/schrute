/**
 * Live CoinGecko diagnostic — check what the browser page actually shows
 * and what evaluateFetch does.
 */
import { getConfig } from '../src/core/config.js';
import { Engine } from '../src/core/engine.js';

const config = getConfig();
const engine = new Engine(config);

try {
  // Explore to get a browser session
  const explore = await engine.explore('https://www.coingecko.com');
  console.log('Explore result:', explore.status);

  // Get the browser provider via the session
  const session = engine.getMultiSessionManager().getOrCreate();
  const page = await session.browserManager.getSelectedOrFirstPage('www.coingecko.com');
  const url = page.url();
  const title = await page.title();
  console.log('Page URL:', url);
  console.log('Page title:', title);

  // Check for CF challenge
  const hasCfChallenge = await page.evaluate((selectors: string[]) => {
    return selectors.some(sel => document.querySelector(sel) !== null);
  }, ['#challenge-running', '#challenge-spinner', '#cf-please-wait', '#turnstile-wrapper', '#cf-challenge-running']);
  console.log('Has CF challenge DOM elements:', hasCfChallenge);

  // Try evaluateFetch directly
  console.log('\nAttempting evaluateFetch to /price_charts/bitcoin/usd/24_hours.json...');
  try {
    const result = await page.evaluate(async () => {
      const resp = await fetch('https://www.coingecko.com/price_charts/bitcoin/usd/24_hours.json', {
        headers: { 'accept': 'application/json' },
      });
      return { status: resp.status, ok: resp.ok, contentType: resp.headers.get('content-type'), bodyPreview: (await resp.text()).slice(0, 200) };
    });
    console.log('evaluateFetch result:', JSON.stringify(result, null, 2));
  } catch (err) {
    console.log('evaluateFetch THREW:', err instanceof Error ? err.message : String(err));
    // After throw, check page state
    const snapTitle = await page.title();
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) ?? '');
    console.log('Page title after throw:', snapTitle);
    console.log('Page body after throw:', bodyText.slice(0, 300));
  }
} catch (err) {
  console.error('Error:', err);
} finally {
  await engine.close();
}
