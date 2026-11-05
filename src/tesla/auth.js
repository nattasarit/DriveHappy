'use strict';

const { config } = require('../config');

/**
 * In-process token state. Refresh tokens are single-use — persist new refresh
 * token back to Hostinger env after bootstrap / rotation.
 */
const state = {
  accessToken: config.tesla.accessToken || '',
  refreshToken: config.tesla.refreshToken || '',
  expiresAt: 0,
};

function getAccessToken() {
  return state.accessToken;
}

function getRefreshToken() {
  return state.refreshToken;
}

function setTokens({ accessToken, refreshToken, expiresIn }) {
  if (accessToken) state.accessToken = accessToken;
  if (refreshToken) state.refreshToken = refreshToken;
  if (expiresIn) state.expiresAt = Date.now() + (expiresIn - 60) * 1000;
}

async function refreshAccessToken() {
  if (!config.tesla.clientId) {
    throw new Error('TESLA_CLIENT_ID is not configured');
  }
  if (!state.refreshToken) {
    throw new Error('TESLA_REFRESH_TOKEN is not configured — run scripts/tesla-oauth-bootstrap.js');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.tesla.clientId,
    refresh_token: state.refreshToken,
  });

  const res = await fetch(`${config.tesla.authBase}/oauth2/v3/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Tesla token refresh failed (${res.status}): ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    throw new Error(`Tesla token refresh failed (${res.status}): ${json.error || text.slice(0, 200)}`);
  }

  setTokens({
    accessToken: json.access_token,
    refreshToken: json.refresh_token || state.refreshToken,
    expiresIn: json.expires_in || 3600,
  });

  return state.accessToken;
}

async function ensureAccessToken() {
  if (state.accessToken && Date.now() < state.expiresAt) {
    return state.accessToken;
  }
  if (state.accessToken && !state.refreshToken) {
    return state.accessToken;
  }
  return refreshAccessToken();
}

module.exports = {
  ensureAccessToken,
  refreshAccessToken,
  getAccessToken,
  getRefreshToken,
  setTokens,
};
