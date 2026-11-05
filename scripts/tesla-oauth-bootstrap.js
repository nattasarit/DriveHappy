#!/usr/bin/env node
'use strict';

/**
 * One-time Tesla OAuth helper (run on a phone/laptop — not while driving).
 *
 * Usage:
 *   1. Fill TESLA_CLIENT_ID / TESLA_CLIENT_SECRET / TESLA_REDIRECT_URI / TESLA_API_BASE in .env
 *   2. npm run oauth:tesla
 *   3. Open the printed authorize URL, sign in, allow vehicle_device_data only
 *   4. Or start the server and visit https://hd.bkksoftkit.com/api/tesla/login
 *   5. Paste the refresh_token into Hostinger env as TESLA_REFRESH_TOKEN and redeploy
 *
 * Scopes intentionally exclude vehicle_cmds (no wake / no commands).
 */

try {
  require('dotenv').config();
} catch {
  // optional
}

const clientId = process.env.TESLA_CLIENT_ID;
const redirectUri = process.env.TESLA_REDIRECT_URI || 'https://hd.bkksoftkit.com/api/tesla/callback';

if (!clientId) {
  console.error('Set TESLA_CLIENT_ID in .env first');
  process.exit(1);
}

const params = new URLSearchParams({
  client_id: clientId,
  locale: 'en-US',
  prompt: 'login',
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: 'openid offline_access vehicle_device_data',
  state: `bootstrap_${Date.now()}`,
});

const url = `https://auth.tesla.com/oauth2/v3/authorize?${params.toString()}`;

console.log('\nDriveHappy Tesla OAuth bootstrap');
console.log('--------------------------------');
console.log('1) Open this URL in a desktop/phone browser:\n');
console.log(url);
console.log('\n2) After redirect, the app callback page shows refresh_token.');
console.log('3) Put it in Hostinger → Environment Variables → TESLA_REFRESH_TOKEN');
console.log('4) Redeploy. DriveHappy never calls wake_up or commands.\n');
