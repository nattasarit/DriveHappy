'use strict';

const express = require('express');
const { searchVideos, resolveStreams, extractVideoId } = require('../youtube/service');

const router = express.Router();

router.get('/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    const data = await searchVideos(q);
    res.json({ ok: true, data });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

router.get('/resolve', async (req, res) => {
  try {
    const id = extractVideoId(req.query.id || req.query.url || '') || req.query.id;
    if (!id) {
      res.status(400).json({ ok: false, error: 'Missing id or url' });
      return;
    }
    const data = await resolveStreams(id);
    res.json({ ok: true, data });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

/**
 * Proxy media bytes so the canvas decoder can load streams without browser CORS issues.
 * Query: ?url=  (must be http/https)
 */
router.get('/media', async (req, res) => {
  try {
    const target = req.query.url;
    if (!target || !/^https?:\/\//i.test(target)) {
      res.status(400).json({ ok: false, error: 'Invalid url' });
      return;
    }
    const upstream = await fetch(target, {
      headers: {
        'User-Agent': 'DriveHappy/1.0',
        Accept: '*/*',
        ...(req.headers.range ? { Range: req.headers.range } : {}),
      },
    });
    res.status(upstream.status);
    const pass = ['content-type', 'content-length', 'accept-ranges', 'content-range'];
    for (const h of pass) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('Cache-Control', 'public, max-age=300');
    if (!upstream.body) {
      res.end();
      return;
    }
    const { Readable } = require('stream');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).json({ ok: false, error: err.message });
    } else {
      res.destroy(err);
    }
  }
});

module.exports = router;
