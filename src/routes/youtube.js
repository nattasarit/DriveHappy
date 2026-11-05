'use strict';

const express = require('express');
const {
  searchVideos,
  resolveStreams,
  extractVideoId,
  youtubeIntegrationStatus,
} = require('../youtube/service');
const {
  assertAdminToken,
  saveYoutubeCookies,
  clearYoutubeCookies,
  cookiesStatus,
  getYoutubeCookieHeader,
} = require('../youtube/cookies');

const router = express.Router();

router.get('/status', (_req, res) => {
  res.json({ ok: true, data: youtubeIntegrationStatus() });
});

/**
 * Paste-once YouTube cookies (Netscape or Cookie header).
 * Auth: header X-DriveHappy-Admin-Token or body.token == YOUTUBE_COOKIE_ADMIN_TOKEN
 * Cannot read youtube.com cookies from the car browser — operator must export/paste.
 */
router.post('/cookies', (req, res) => {
  try {
    const token = req.get('x-drivehappy-admin-token') || req.body?.token || '';
    assertAdminToken(token);
    const raw = req.body?.cookies || req.body?.cookie || '';
    const data = saveYoutubeCookies(raw, { source: 'admin' });
    res.json({
      ok: true,
      data,
      message:
        'บันทึกคุกกี้ครบแล้ว — เซิร์ฟเวอร์จะใช้ Cookie + SAPISIDHASH กับ Innertube WEB ลองเล่นคลิปอีกครั้ง (อย่าแชร์โทเคน/คุกกี้ในแชท)',
    });
  } catch (err) {
    const status =
      err.code === 'UNAUTHORIZED' ? 401 : err.code === 'ADMIN_DISABLED' ? 503 : 400;
    res.status(status).json({
      ok: false,
      error: err.message,
      code: err.code || null,
      missingRequired: err.missingRequired || null,
      missingRecommended: err.missingRecommended || null,
    });
  }
});

router.delete('/cookies', (req, res) => {
  try {
    const token = req.get('x-drivehappy-admin-token') || req.body?.token || req.query?.token || '';
    assertAdminToken(token);
    const data = clearYoutubeCookies();
    res.json({ ok: true, data, message: 'ลบคุกกี้ที่วางไว้แล้ว (ค่า YOUTUBE_COOKIES ใน env ยังใช้ได้ถ้ามี)' });
  } catch (err) {
    const status =
      err.code === 'UNAUTHORIZED' ? 401 : err.code === 'ADMIN_DISABLED' ? 503 : 400;
    res.status(status).json({ ok: false, error: err.message, code: err.code || null });
  }
});

router.get('/cookies/status', (_req, res) => {
  res.json({ ok: true, data: cookiesStatus() });
});

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
    const errorKind = err.errorKind || 'unavailable';
    res.status(502).json({
      ok: false,
      error: err.message,
      errorKind,
      loginRequiredHint: Boolean(err.loginRequiredHint),
    });
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

    const cookie = getYoutubeCookieHeader();
    const upstream = await fetch(target, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/122.0.0.0 Mobile Safari/537.36 DriveHappy/1.0',
        Accept: '*/*',
        ...(forwardRange ? { Range: forwardRange } : {}),
        // googlevideo usually uses signed URLs; cookies help some edge cases when pasted.
        ...(cookie && /googlevideo\.com|youtube\.com/i.test(host) ? { Cookie: cookie } : {}),
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
