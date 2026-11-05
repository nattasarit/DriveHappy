'use strict';

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

const config = {
  port: intEnv('PORT', 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  tesla: {
    clientId: process.env.TESLA_CLIENT_ID || '',
    clientSecret: process.env.TESLA_CLIENT_SECRET || '',
    refreshToken: process.env.TESLA_REFRESH_TOKEN || '',
    accessToken: process.env.TESLA_ACCESS_TOKEN || '',
    apiBase: (process.env.TESLA_API_BASE || 'https://fleet-api.prd.na.vn.cloud.tesla.com').replace(/\/$/, ''),
    authBase: (process.env.TESLA_AUTH_BASE || 'https://fleet-auth.prd.vn.cloud.tesla.com').replace(/\/$/, ''),
    vin: process.env.TESLA_VIN || 'LRWYHCFJ7SC322078',
    redirectUri: process.env.TESLA_REDIRECT_URI || 'https://hd.bkksoftkit.com/api/tesla/callback',
    allowLiveIfOnline: boolEnv('TESLA_ALLOW_LIVE_IF_ONLINE', true),
    softLimitCalls: intEnv('TESLA_SOFT_LIMIT_CALLS', 4000),
  },
  ttl: {
    vehicle: intEnv('CACHE_TTL_VEHICLE_MS', 10 * 60 * 1000),
    vehiclesList: intEnv('CACHE_TTL_VEHICLES_LIST_MS', 3 * 60 * 1000),
    liveVehicle: intEnv('CACHE_TTL_LIVE_VEHICLE_MS', 3 * 60 * 1000),
    weather: intEnv('CACHE_TTL_WEATHER_MS', 15 * 60 * 1000),
    news: intEnv('CACHE_TTL_NEWS_MS', 15 * 60 * 1000),
    gold: intEnv('CACHE_TTL_GOLD_MS', 15 * 60 * 1000),
    btc: intEnv('CACHE_TTL_BTC_MS', 2 * 60 * 1000),
    youtube: intEnv('CACHE_TTL_YOUTUBE_MS', 5 * 60 * 1000),
  },
  weatherFallback: {
    lat: Number.parseFloat(process.env.WEATHER_FALLBACK_LAT || '13.7563'),
    lon: Number.parseFloat(process.env.WEATHER_FALLBACK_LON || '100.5018'),
    label: 'กรุงเทพฯ',
  },
  newsFeedUrl: process.env.NEWS_FEED_URL || 'https://www.thairath.co.th/rss/news',
  goldApiUrl: process.env.GOLD_API_URL || 'https://api.chnwt.dev/thai-gold-api/latest',
  youtubeApiKey: process.env.YOUTUBE_API_KEY || '',
  // Optional browser cookies (VISITOR_INFO1_LIVE / SID / …) to ease YouTube bot checks from Hostinger.
  // Never commit real values — set only in hPanel. Helps stream resolve; not required for search.
  youtubeCookies: (process.env.YOUTUBE_COOKIES || '').trim(),
  pipedApiBases: (process.env.PIPED_API_BASES ||
    [
      'https://api.piped.private.coffee',
      'https://pipedapi.ducks.party',
      'https://pipedapi.adminforge.de',
      'https://pipedapi.kavin.rocks',
      'https://pipedapi.reallyaweso.me',
      'https://pipedapi.darkness.services',
    ].join(','))
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean),
  invidiousApiBases: (process.env.INVIDIOUS_API_BASES ||
    [
      'https://inv.nadeko.net',
      'https://invidious.nerdvpn.de',
      'https://yewtu.be',
      'https://invidious.flokinet.to',
      'https://vid.puffyan.us',
    ].join(','))
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean),
};

module.exports = { config };
