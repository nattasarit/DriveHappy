'use strict';

const Parser = require('rss-parser');
const { config } = require('../config');
const { cache } = require('../cache');

const parser = new Parser({
  timeout: 15000,
  headers: {
    'User-Agent': 'DriveHappy/1.0 (+https://hd.bkksoftkit.com)',
    Accept: 'application/rss+xml, application/xml, text/xml, */*',
  },
});

const FALLBACK_FEEDS = [
  config.newsFeedUrl,
  'https://www.thairath.co.th/rss/news.xml',
  'https://www.thairath.co.th/rss/news',
];

async function parseFirstWorkingFeed() {
  const tried = [];
  let lastErr;
  for (const url of [...new Set(FALLBACK_FEEDS.filter(Boolean))]) {
    tried.push(url);
    try {
      const feed = await parser.parseURL(url);
      const items = (feed.items || []).slice(0, 5).map((item) => ({
        title: item.title || 'ไม่มีหัวข้อ',
        link: item.link || null,
        publishedAt: item.isoDate || item.pubDate || null,
      }));
      return {
        source: 'ไทยรัฐ',
        feedUrl: url,
        title: feed.title || 'ไทยรัฐ',
        items,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error(`News feeds failed: ${tried.join(', ')}`);
}

async function getNews() {
  const result = await cache.getOrFetch('news:thairath', config.ttl.news, parseFirstWorkingFeed);
  return {
    ...result.data,
    cached: result.cached,
    stale: Boolean(result.stale),
    storedAt: result.storedAt,
    ageMs: result.ageMs,
  };
}

module.exports = { getNews };
