'use strict';

const fs = require('fs');
const path = require('path');
const { config } = require('../config');

/**
 * YouTube cookie handling for DriveHappy (DRI-8).
 *
 * Honest constraint: the Tesla / phone browser on hd.bkksoftkit.com CANNOT read
 * cookies belonging to youtube.com (same-origin policy). We never claim otherwise.
 *
 * Practical MVP: operator pastes exported cookies once (Hostinger env YOUTUBE_COOKIES
 * or authenticated admin paste). Server stores them and sends Cookie on Innertube.
 */

const STORE_DIR = path.join(__dirname, '..', '..', '.tokens');
const STORE_FILE = path.join(STORE_DIR, 'youtube-cookies.txt');

let runtimeHeader = null;
let runtimeMeta = { source: null, updatedAt: null, nameCount: 0 };

function ensureStoreDir() {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  } catch {
    // ignore
  }
}

/**
 * Accept either:
 * - Cookie header string: `SID=...; HSID=...; ...`
 * - Netscape / cookies.txt export (tab-separated, #HttpOnly_ lines)
 */
function normalizeCookieInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return { header: '', names: [] };

  // Netscape cookie file
  if (/^\s*#(?: Netscape| HttpOnly)/im.test(text) || /\tyoutube\.com\t/i.test(text)) {
    const map = new Map();
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        // #HttpOnly_.youtube.com ... still a data line in some exporters
        if (!trimmed.startsWith('#HttpOnly_')) continue;
      }
      const normalized = trimmed.replace(/^#HttpOnly_/, '');
      const parts = normalized.split('\t');
      if (parts.length < 7) continue;
      const domain = parts[0];
      const name = parts[5];
      const value = parts[6];
      if (!/youtube\.com|google\.com/i.test(domain)) continue;
      if (!name || value == null) continue;
      map.set(name, value);
    }
    const names = [...map.keys()];
    const header = names.map((n) => `${n}=${map.get(n)}`).join('; ');
    return { header, names };
  }

  // Already a Cookie header (or semicolon-separated pairs)
  const map = new Map();
  for (const part of text.split(';')) {
    const piece = part.trim();
    if (!piece) continue;
    const eq = piece.indexOf('=');
    if (eq <= 0) continue;
    const name = piece.slice(0, eq).trim();
    const value = piece.slice(eq + 1).trim();
    if (!name) continue;
    map.set(name, value);
  }
  const names = [...map.keys()];
  const header = names.map((n) => `${n}=${map.get(n)}`).join('; ');
  return { header, names };
}

function loadRuntimeFromDisk() {
  try {
    if (!fs.existsSync(STORE_FILE)) return;
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const { header, names } = normalizeCookieInput(raw);
    if (!header) return;
    runtimeHeader = header;
    runtimeMeta = {
      source: 'file',
      updatedAt: fs.statSync(STORE_FILE).mtime.toISOString(),
      nameCount: names.length,
    };
  } catch {
    // ignore corrupt store
  }
}

loadRuntimeFromDisk();

function getYoutubeCookieHeader() {
  if (runtimeHeader) return runtimeHeader;
  if (config.youtubeCookies) {
    const { header, names } = normalizeCookieInput(config.youtubeCookies);
    if (header) {
      // Env is source of truth until admin paste overrides
      runtimeMeta = {
        source: runtimeMeta.source || 'env',
        updatedAt: runtimeMeta.updatedAt,
        nameCount: names.length,
      };
      return header;
    }
  }
  return '';
}

function cookiesStatus() {
  const header = getYoutubeCookieHeader();
  const configured = Boolean(header);
  return {
    cookiesConfigured: configured,
    source: configured ? runtimeMeta.source || (config.youtubeCookies ? 'env' : null) : null,
    updatedAt: runtimeMeta.updatedAt,
    nameCount: configured ? runtimeMeta.nameCount || null : 0,
    adminPasteEnabled: Boolean(config.youtubeCookieAdminToken),
    crossOriginNote:
      'เบราว์เซอร์บน hd.bkksoftkit.com อ่านคุกกี้ของ youtube.com ไม่ได้ (same-origin) — ต้องวางคุกกี้ที่ export มา หรือใส่ YOUTUBE_COOKIES ใน Hostinger',
  };
}

function saveYoutubeCookies(raw, { source = 'admin' } = {}) {
  const { header, names } = normalizeCookieInput(raw);
  if (!header || names.length < 1) {
    const err = new Error('รูปแบบคุกกี้ไม่ถูกต้อง — วาง Cookie header หรือไฟล์ Netscape cookies.txt');
    err.code = 'INVALID_COOKIES';
    throw err;
  }
  // Prefer session-ish names present for a useful paste (soft check)
  const useful = ['SID', '__Secure-3PSID', 'SAPISID', '__Secure-3PAPISID', 'HSID', 'SSID', 'LOGIN_INFO'];
  const hit = useful.filter((n) => names.includes(n));
  if (hit.length === 0) {
    const err = new Error(
      'ไม่พบคุกกี้ YouTube/Google ที่จำเป็น (เช่น SID / __Secure-3PSID) — export ใหม่จากเบราว์เซอร์ที่ล็อกอิน YouTube แล้ว'
    );
    err.code = 'WEAK_COOKIES';
    throw err;
  }

  ensureStoreDir();
  fs.writeFileSync(STORE_FILE, header, { mode: 0o600 });
  runtimeHeader = header;
  runtimeMeta = {
    source,
    updatedAt: new Date().toISOString(),
    nameCount: names.length,
  };
  return cookiesStatus();
}

function clearYoutubeCookies() {
  runtimeHeader = null;
  runtimeMeta = { source: null, updatedAt: null, nameCount: 0 };
  try {
    if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
  } catch {
    // ignore
  }
  return cookiesStatus();
}

function assertAdminToken(provided) {
  const expected = config.youtubeCookieAdminToken;
  if (!expected) {
    const err = new Error('ยังไม่ได้ตั้ง YOUTUBE_COOKIE_ADMIN_TOKEN ใน Hostinger — ใช้ YOUTUBE_COOKIES env แทน');
    err.code = 'ADMIN_DISABLED';
    throw err;
  }
  if (!provided || String(provided) !== expected) {
    const err = new Error('โทเคนแอดมินไม่ถูกต้อง');
    err.code = 'UNAUTHORIZED';
    throw err;
  }
}

module.exports = {
  normalizeCookieInput,
  getYoutubeCookieHeader,
  cookiesStatus,
  saveYoutubeCookies,
  clearYoutubeCookies,
  assertAdminToken,
  STORE_FILE,
};
