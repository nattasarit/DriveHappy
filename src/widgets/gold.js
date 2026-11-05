'use strict';

const { config } = require('../config');
const { cache } = require('../cache');

function parseThbNumber(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  const cleaned = String(value).replace(/,/g, '').replace(/[^\d.-]/g, '');
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

async function fetchGoldBaht() {
  const res = await fetch(config.goldApiUrl, {
    headers: { Accept: 'application/json', 'User-Agent': 'DriveHappy/1.0' },
  });
  if (!res.ok) throw new Error(`Gold API ${res.status}`);
  const json = await res.json();

  // api.chnwt.dev/thai-gold-api shape
  const price = json?.response?.price || json?.price || {};
  const gold = price.gold || price.ทองคำแท่ง || {};
  // ราคาบาท = jewelry / baht-gold (ทองรูปพรรณ) when available; else gold
  const baht = price.gold || price.ทองรูปพรรณ || gold;

  const buy = parseThbNumber(baht.buy ?? baht.Buy ?? baht.ซื้อ);
  const sell = parseThbNumber(baht.sell ?? baht.Sell ?? baht.ขาย);

  // Prefer explicit บาททอง fields if present in alternate APIs
  const altBuy = parseThbNumber(price?.['ทองรูปพรรณ']?.buy || price?.ornament?.buy);
  const altSell = parseThbNumber(price?.['ทองรูปพรรณ']?.sell || price?.ornament?.sell);

  return {
    label: 'ราคาบาท',
    unit: 'บาททอง',
    currency: 'THB',
    buy: altBuy ?? buy,
    sell: altSell ?? sell,
    updateDate: json?.response?.update_date || json?.update_date || null,
    updateTime: json?.response?.update_time || json?.update_time || null,
    source: config.goldApiUrl,
  };
}

async function getGold() {
  const result = await cache.getOrFetch('gold:baht', config.ttl.gold, fetchGoldBaht);
  return {
    ...result.data,
    cached: result.cached,
    stale: Boolean(result.stale),
    storedAt: result.storedAt,
    ageMs: result.ageMs,
  };
}

module.exports = { getGold };
