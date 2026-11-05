'use strict';

const { config } = require('../config');
const { cache } = require('../cache');

async function fetchBtc() {
  const url =
    'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=thb,usd&include_24hr_change=true';
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'DriveHappy/1.0' },
  });
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  const json = await res.json();
  const btc = json.bitcoin || {};
  return {
    symbol: 'BTC',
    thb: btc.thb ?? null,
    usd: btc.usd ?? null,
    change24hPct: btc.thb_24h_change ?? btc.usd_24h_change ?? null,
    source: 'coingecko',
  };
}

async function getBtc() {
  const result = await cache.getOrFetch('btc:price', config.ttl.btc, fetchBtc);
  return {
    ...result.data,
    cached: result.cached,
    stale: Boolean(result.stale),
    storedAt: result.storedAt,
    ageMs: result.ageMs,
  };
}

module.exports = { getBtc };
