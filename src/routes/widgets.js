'use strict';

const express = require('express');
const { getWeather } = require('../widgets/weather');
const { getNews } = require('../widgets/news');
const { getGold } = require('../widgets/gold');
const { getBtc } = require('../widgets/btc');

const router = express.Router();

router.get('/weather', async (req, res) => {
  try {
    const lat = req.query.lat != null ? Number(req.query.lat) : null;
    const lon = req.query.lon != null ? Number(req.query.lon) : null;
    const data = await getWeather({ lat, lon });
    res.json({ ok: true, data });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

router.get('/news', async (_req, res) => {
  try {
    const data = await getNews();
    res.json({ ok: true, data });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

router.get('/gold', async (_req, res) => {
  try {
    const data = await getGold();
    res.json({ ok: true, data });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

router.get('/btc', async (_req, res) => {
  try {
    const data = await getBtc();
    res.json({ ok: true, data });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

router.get('/', async (req, res) => {
  const lat = req.query.lat != null ? Number(req.query.lat) : null;
  const lon = req.query.lon != null ? Number(req.query.lon) : null;
  const settled = await Promise.allSettled([
    getWeather({ lat, lon }),
    getNews(),
    getGold(),
    getBtc(),
  ]);
  const pack = (r) =>
    r.status === 'fulfilled' ? { ok: true, data: r.value } : { ok: false, error: r.reason?.message || 'error' };
  res.json({
    ok: true,
    data: {
      weather: pack(settled[0]),
      news: pack(settled[1]),
      gold: pack(settled[2]),
      btc: pack(settled[3]),
    },
  });
});

module.exports = router;
