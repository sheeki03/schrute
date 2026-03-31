// Benchmark vanilla fetch vs CoinGecko endpoints
const API_URL = ['https://api.coingecko.com', '/api/v3/simple/price', '?ids=bitcoin', '&vs_currencies=usd'].join('');
const WWW_URL = 'https://www.coingecko.com/price_charts/bitcoin/usd/24_hours.json';

async function bench(label, url, runs) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    const ms = performance.now() - t0;
    times.push({ status: r.status, ms: Math.round(ms) });
    await r.text(); // consume body
  }
  const avg = Math.round(times.reduce((s, t) => s + t.ms, 0) / times.length);
  console.log(`${label}: ${times.map(t => `${t.status}/${t.ms}ms`).join(', ')}  avg=${avg}ms`);
}

await bench('Vanilla fetch (api.coingecko.com)', API_URL, 3);
await bench('Vanilla fetch (www.coingecko.com)', WWW_URL, 3);
