'use strict';

const { config } = require('../config');
const { ensureAccessToken, refreshAccessToken } = require('./auth');

/**
 * Read-only Tesla Fleet HTTP client.
 * HARD RULE: never call wake_up or any command endpoints.
 */
const FORBIDDEN_PATH_PARTS = [
  '/wake_up',
  '/command',
  '/signed_command',
  '/commands',
];

const usage = {
  monthKey: monthKeyNow(),
  calls: 0,
};

function monthKeyNow() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`;
}

function getUsage() {
  const key = monthKeyNow();
  if (usage.monthKey !== key) {
    usage.monthKey = key;
    usage.calls = 0;
  }
  return { monthKey: usage.monthKey, calls: usage.calls, softLimit: config.tesla.softLimitCalls };
}

function assertReadOnlyPath(path) {
  const lower = path.toLowerCase();
  for (const bad of FORBIDDEN_PATH_PARTS) {
    if (lower.includes(bad)) {
      throw new Error(`Blocked Tesla path (read-only policy): ${path}`);
    }
  }
}

function softLimitReached() {
  const u = getUsage();
  return u.calls >= u.softLimit;
}

async function teslaGet(path, { retryAuth = true } = {}) {
  assertReadOnlyPath(path);
  if (softLimitReached()) {
    const err = new Error('Tesla soft call limit reached for this month (protecting ~$10 credit)');
    err.code = 'TESLA_SOFT_LIMIT';
    throw err;
  }

  const token = await ensureAccessToken();
  const url = `${config.tesla.apiBase}${path.startsWith('/') ? path : `/${path}`}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  // Count billable-ish responses (<500) toward soft budget
  if (res.status < 500) {
    getUsage();
    usage.calls += 1;
  }

  if (res.status === 401 && retryAuth) {
    await refreshAccessToken();
    return teslaGet(path, { retryAuth: false });
  }

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(`Tesla API ${res.status} for ${path}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }

  return json;
}

module.exports = { teslaGet, getUsage, softLimitReached, assertReadOnlyPath };
