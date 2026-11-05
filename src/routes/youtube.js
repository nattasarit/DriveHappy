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
 * Proxy media bytes so the off-DOM canvas decoder can load streams same-origin
 * (avoids CORS tainting when drawing video frames to <canvas>).
 *
 * Piped CDN proxies often return bogus Content-Range totals on Range requests
 * (e.g. bytes 0-1023/1024), which makes HTMLMediaElement abort. We therefore:
 *  - prefer full-response fetches for Piped proxy hosts
 *  - only forward Range to googlevideo / other direct CDNs that handle it correctly
 * Query: ?url=  (must be http/https)
 */
router.get('/media', async (req, res) => {
  try {
    const target = req.query.url;
    if (!target || !/^https?:\/\//i.test(target)) {
      res.status(400).json({ ok: false, error: 'Invalid url' });
      return;
    }

    let host = '';
    try {
      host = new URL(target).hostname.toLowerCase();
    } catch {
      res.status(400).json({ ok: false, error: 'Invalid url' });
      return;
    }

    const pipedProxy = host.includes('piped') || host.includes('odycdn');
    const rangeOk = !pipedProxy && /googlevideo\.com|ytimg\.com|ggpht\.com/.test(host);
    const forwardRange = rangeOk && req.headers.range ? req.headers.range : null;

    const upstream = await fetch(target, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/122.0.0.0 Mobile Safari/537.36 DriveHappy/1.0',
        Accept: '*/*',
        ...(forwardRange ? { Range: forwardRange } : {}),
      },
      redirect: 'follow',
    });

    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('content-type', contentType);
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) res.setHeader('content-length', contentLength);

    if (forwardRange) {
      const cr = upstream.headers.get('content-range');
      const ar = upstream.headers.get('accept-ranges');
      if (cr) res.setHeader('content-range', cr);
      if (ar) res.setHeader('accept-ranges', ar);
    } else {
      // Full body — do not advertise byte ranges (avoids broken Piped range probes).
      res.setHeader('Accept-Ranges', 'none');
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
