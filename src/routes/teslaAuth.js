'use strict';

const express = require('express');
const { config } = require('../config');
const { setTokens } = require('../tesla/auth');

const router = express.Router();

/**
 * Start Tesla OAuth (desktop/phone — not while driving).
 * Scopes are read-only: openid offline_access vehicle_device_data
 */
router.get('/login', (_req, res) => {
  if (!config.tesla.clientId) {
    res.status(500).send('TESLA_CLIENT_ID is not configured');
    return;
  }
  const params = new URLSearchParams({
    client_id: config.tesla.clientId,
    locale: 'en-US',
    prompt: 'login',
    redirect_uri: config.tesla.redirectUri,
    response_type: 'code',
    scope: 'openid offline_access vehicle_device_data',
    state: `dh_${Date.now()}`,
  });
  // Authorize host (browser); token exchange uses fleet-auth
  const authorize = `https://auth.tesla.com/oauth2/v3/authorize?${params.toString()}`;
  res.redirect(authorize);
});

router.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    res.status(400).send('Missing code');
    return;
  }
  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.tesla.clientId,
      client_secret: config.tesla.clientSecret,
      code: String(code),
      audience: config.tesla.apiBase,
      redirect_uri: config.tesla.redirectUri,
    });
    const tokenRes = await fetch(`${config.tesla.authBase}/oauth2/v3/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = await tokenRes.json();
    if (!tokenRes.ok) {
      res.status(502).json({ ok: false, error: json });
      return;
    }
    setTokens({
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresIn: json.expires_in || 3600,
    });

    // Show tokens once so Nattaphon can paste refresh token into Hostinger env.
    // Do not log secrets to server logs.
    res.type('html').send(`<!doctype html>
<html lang="th"><head><meta charset="utf-8"><title>DriveHappy Tesla OAuth</title>
<style>
body{font-family:system-ui,sans-serif;background:#111;color:#eee;padding:2rem;max-width:52rem;margin:auto}
code,textarea{display:block;width:100%;background:#1b1b1b;color:#9fe870;border:1px solid #333;padding:1rem;border-radius:8px;white-space:pre-wrap;word-break:break-all}
.warn{color:#ffb454;margin:1rem 0}
</style></head><body>
<h1>Tesla OAuth สำเร็จ</h1>
<p>คัดลอก <strong>refresh_token</strong> ไปใส่ใน Hostinger Environment Variables เป็น <code>TESLA_REFRESH_TOKEN</code> แล้ว redeploy</p>
<p class="warn">หน้านี้แสดงครั้งเดียว — อย่าแชร์หรือ commit ค่านี้</p>
<label>refresh_token</label>
<textarea rows="5" readonly>${json.refresh_token || ''}</textarea>
<label style="margin-top:1rem;display:block">access_token (สั้นอายุ)</label>
<textarea rows="4" readonly>${json.access_token || ''}</textarea>
<p><a href="/" style="color:#9fe870">กลับแดชบอร์ด</a></p>
</body></html>`);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
