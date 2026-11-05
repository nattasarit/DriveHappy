'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { config } = require('../config');

/**
 * YouTube cookie handling for DriveHappy.
 *
 * Same-origin: hd.bkksoftkit.com cannot read youtube.com cookies from the browser.
 * Pasted cookies must be sent on Innertube as Cookie + (for WEB) SAPISIDHASH.
 *
 * Important: browser cookies authenticate WEB/MWEB only. Do not attach them to
 * ANDROID_VR / ANDROID / IOS clients (yt-dlp: account cookies not supported there).
 */

const STORE_DIR = path.join(__dirname, '..', '..', '.tokens');
const STORE_FILE = path.join(STORE_DIR, 'youtube-cookies.txt');

const YOUTUBE_ORIGIN = 'https://www.youtube.com';

/** Names that matter for a logged-in WEB Innertube session. */
const REQUIRED_ANY_SESSION = ['SID', '__Secure-3PSID'];
const REQUIRED_ANY_SAPISID = ['SAPISID', '__Secure-3PAPISID'];
const RECOMMENDED = [
  'HSID',
  'SSID',
  'APISID',
  '__Secure-3PAPISID',
  'LOGIN_INFO',
  'VISITOR_INFO1_LIVE',
  'PREF',
];

let runtimeHeader = null;
let runtimeNames = [];
let runtimeMeta = { source: null, updatedAt: null, nameCount: 0 };
let runtimeHygiene = null;

function ensureStoreDir() {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  } catch {
    // ignore
  }
}

/**
 * Hostinger / dotenv often wrap values in quotes. Strip one layer of wrapping
 * quotes from the whole blob and from individual cookie values — never log values.
 */
function stripWrappingQuotes(text) {
  let s = String(text || '').trim();
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    s = s.slice(1, -1).trim();
  }
  // Common paste: Cookie: SID=...
  s = s.replace(/^Cookie:\s*/i, '');
  return s;
}

function stripValueQuotes(value) {
  let v = String(value ?? '').trim();
  if (
    (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
    (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
  ) {
    v = v.slice(1, -1);
  }
  return v;
}

/**
 * Accept either:
 * - Cookie header string: `SID=...; HSID=...; ...`
 * - Netscape / cookies.txt export (tab-separated, #HttpOnly_ lines)
 */
function normalizeCookieInput(raw) {
  const original = String(raw || '');
  const envelopeQuoted =
    /^\s*["']/.test(original) && /["']\s*$/.test(original.trim());
  const text = stripWrappingQuotes(original);
  if (!text) return { header: '', names: [], map: new Map(), envelopeQuoted: false };

  const map = new Map();
  let valuesHadQuotes = 0;

  const looksNetscape =
    /^\s*#(?: Netscape| HttpOnly)/im.test(text) ||
    /\t(?:TRUE|FALSE)\t\/\t(?:TRUE|FALSE)\t\d+\t/i.test(text) ||
    /\tyoutube\.com\t/i.test(text) ||
    /\.youtube\.com\t/i.test(text);

  if (looksNetscape) {
    for (const line of text.split(/\r?\n/)) {
      let trimmed = line.trim();
      if (!trimmed) continue;
      const httpOnly = trimmed.startsWith('#HttpOnly_');
      if (trimmed.startsWith('#') && !httpOnly) continue;
      if (httpOnly) trimmed = trimmed.replace(/^#HttpOnly_/, '');
      const parts = trimmed.split('\t');
      if (parts.length < 7) continue;
      const domain = parts[0];
      const name = parts[5];
      let value = parts.slice(6).join('\t');
      if (!/youtube\.com|google\.com/i.test(domain)) continue;
      if (!name || value == null || value === '') continue;
      const cleaned = stripValueQuotes(value);
      if (cleaned !== value) valuesHadQuotes += 1;
      map.set(name, cleaned);
    }
  } else {
    for (const part of text.split(';')) {
      const piece = part.trim();
      if (!piece) continue;
      const eq = piece.indexOf('=');
      if (eq <= 0) continue;
      const name = piece.slice(0, eq).trim();
      let value = piece.slice(eq + 1).trim();
      if (!name) continue;
      const cleaned = stripValueQuotes(value);
      if (cleaned !== value) valuesHadQuotes += 1;
      map.set(name, cleaned);
    }
  }

  const names = [...map.keys()];
  const header = names.map((n) => `${n}=${map.get(n)}`).join('; ');
  return { header, names, map, envelopeQuoted, valuesHadQuotes };
}

function analyzeCookieNames(names) {
  const set = new Set(names || []);
  const hasSession = REQUIRED_ANY_SESSION.some((n) => set.has(n));
  const hasSapisid = REQUIRED_ANY_SAPISID.some((n) => set.has(n));
  const missingRequired = [];
  if (!hasSession) missingRequired.push('SID หรือ __Secure-3PSID');
  if (!hasSapisid) missingRequired.push('SAPISID หรือ __Secure-3PAPISID');
  const missingRecommended = RECOMMENDED.filter((n) => !set.has(n));
  return {
    hasSession,
    hasSapisid,
    complete: hasSession && hasSapisid,
    missingRequired,
    missingRecommended,
    presentRequired: [
      ...REQUIRED_ANY_SESSION.filter((n) => set.has(n)),
      ...REQUIRED_ANY_SAPISID.filter((n) => set.has(n)),
    ],
  };
}

/**
 * Hygiene without leaking secrets: lengths + flags only.
 * fingerprint = sha256 of "name=len" pairs — safe to put in cache keys / status.
 */
function analyzeCookieHygiene(map, { envelopeQuoted = false, valuesHadQuotes = 0 } = {}) {
  const entries = [...(map || new Map()).entries()];
  const lengths = entries.map(([name, value]) => ({
    name,
    len: String(value || '').length,
  }));
  const shortValues = lengths.filter((x) => x.len > 0 && x.len < 8).map((x) => x.name);
  const emptyValues = lengths.filter((x) => x.len === 0).map((x) => x.name);
  const sapisidLen =
    lengths.find((x) => x.name === '__Secure-3PAPISID')?.len ||
    lengths.find((x) => x.name === 'SAPISID')?.len ||
    0;
  const sidLen =
    lengths.find((x) => x.name === '__Secure-3PSID')?.len ||
    lengths.find((x) => x.name === 'SID')?.len ||
    0;

  const fingerprint = crypto
    .createHash('sha256')
    .update(
      lengths
        .map((x) => `${x.name}=${x.len}`)
        .sort()
        .join('|')
    )
    .digest('hex')
    .slice(0, 16);

  const suspicious =
    envelopeQuoted ||
    valuesHadQuotes > 0 ||
    shortValues.length > 0 ||
    emptyValues.length > 0 ||
    (sapisidLen > 0 && sapisidLen < 16) ||
    (sidLen > 0 && sidLen < 16);

  return {
    envelopeQuoted: Boolean(envelopeQuoted),
    valuesHadQuotes: valuesHadQuotes || 0,
    shortValueNames: shortValues,
    emptyValueNames: emptyValues,
    sapisidValueLengthBand: sapisidLen === 0 ? 'missing' : sapisidLen < 16 ? 'short' : sapisidLen > 200 ? 'long' : 'ok',
    sessionValueLengthBand: sidLen === 0 ? 'missing' : sidLen < 16 ? 'short' : 'ok',
    headerByteLength: lengths.reduce((n, x) => n + x.name.length + x.len + 2, 0),
    fingerprint,
    suspicious,
    sapisidHashReady: sapisidLen >= 16,
  };
}

function loadRuntimeFromDisk() {
  try {
    if (!fs.existsSync(STORE_FILE)) return;
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const { header, names, map, envelopeQuoted, valuesHadQuotes } = normalizeCookieInput(raw);
    if (!header) return;
    runtimeHeader = header;
    runtimeNames = names;
    runtimeHygiene = analyzeCookieHygiene(map, { envelopeQuoted, valuesHadQuotes });
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
    const { header, names, map, envelopeQuoted, valuesHadQuotes } = normalizeCookieInput(
      config.youtubeCookies
    );
    if (header) {
      runtimeNames = names;
      runtimeHygiene = analyzeCookieHygiene(map, { envelopeQuoted, valuesHadQuotes });
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

function getCookieMap() {
  const header = getYoutubeCookieHeader();
  if (!header) return new Map();
  return normalizeCookieInput(header).map;
}

function getCookieFingerprint() {
  getYoutubeCookieHeader();
  return runtimeHygiene?.fingerprint || 'none';
}

/**
 * YouTube WEB client requires Authorization: SAPISIDHASH <ts>_<sha1>.
 * Prefer __Secure-3PAPISID when present (newer accounts), else SAPISID.
 */
function buildSapisidHashAuthorization(cookieMap, origin = YOUTUBE_ORIGIN) {
  const sapisid = cookieMap.get('__Secure-3PAPISID') || cookieMap.get('SAPISID');
  if (!sapisid) return null;
  // Reject obviously quoted/truncated values that cannot form a valid hash identity.
  const cleaned = stripValueQuotes(sapisid);
  if (cleaned.length < 16) return null;
  const timestamp = Math.floor(Date.now() / 1000);
  const input = `${timestamp} ${cleaned} ${origin}`;
  const hash = crypto.createHash('sha1').update(input).digest('hex');
  return `SAPISIDHASH ${timestamp}_${hash}`;
}

function cookiesStatus() {
  const header = getYoutubeCookieHeader();
  const configured = Boolean(header);
  const names = configured
    ? runtimeNames.length
      ? runtimeNames
      : normalizeCookieInput(header).names
    : [];
  const analysis = analyzeCookieNames(names);
  if (configured && !runtimeHygiene) {
    runtimeHygiene = analyzeCookieHygiene(normalizeCookieInput(header).map);
  }
  return {
    cookiesConfigured: configured,
    source: configured ? runtimeMeta.source || (config.youtubeCookies ? 'env' : null) : null,
    updatedAt: runtimeMeta.updatedAt,
    nameCount: configured ? names.length : 0,
    adminPasteEnabled: Boolean(config.youtubeCookieAdminToken),
    cookieCompleteness: configured
      ? {
          complete: analysis.complete,
          hasSessionCookie: analysis.hasSession,
          hasSapisid: analysis.hasSapisid,
          missingRequired: analysis.missingRequired,
          missingRecommended: analysis.missingRecommended,
          // names only — never values
          presentRequiredNames: analysis.presentRequired,
        }
      : null,
    cookieHygiene: configured
      ? {
          ...runtimeHygiene,
          // never expose fingerprint collision material beyond short hash
        }
      : null,
    requiredCookieNames: {
      sessionAnyOf: REQUIRED_ANY_SESSION,
      sapisidAnyOf: REQUIRED_ANY_SAPISID,
      recommended: RECOMMENDED,
    },
    fetchProxyConfigured: Boolean(config.youtubeFetchProxy),
    crossOriginNote:
      'เบราว์เซอร์บน hd.bkksoftkit.com อ่านคุกกี้ของ youtube.com ไม่ได้ (same-origin) — ต้องวางคุกกี้ที่ export มา หรือใส่ YOUTUBE_COOKIES ใน Hostinger',
    datacenterNote:
      'Hostinger เป็น IP ดาต้าเซ็นเตอร์ — YouTube มักตอบ LOGIN_REQUIRED/บอทแม้คุกกี้ครบ (SAPISIDHASH). ถ้า complete=true แล้วยังเล่นไม่ได้ ให้ตั้ง YOUTUBE_FETCH_PROXY เป็นพร็อกซีบ้าน/residential แล้ว restart หรือ refresh คุกกี้ผ่านหน้าแอดมิน',
  };
}

function saveYoutubeCookies(raw, { source = 'admin' } = {}) {
  const { header, names, map, envelopeQuoted, valuesHadQuotes } = normalizeCookieInput(raw);
  if (!header || names.length < 1) {
    const err = new Error('รูปแบบคุกกี้ไม่ถูกต้อง — วาง Cookie header หรือไฟล์ Netscape cookies.txt');
    err.code = 'INVALID_COOKIES';
    throw err;
  }

  const analysis = analyzeCookieNames(names);
  if (!analysis.complete) {
    const err = new Error(
      'คุกกี้ไม่ครบสำหรับปลดล็อกบอท — ต้องมี (' +
        REQUIRED_ANY_SESSION.join(' หรือ ') +
        ') และ (' +
        REQUIRED_ANY_SAPISID.join(' หรือ ') +
        '). ตอนนี้ขาด: ' +
        analysis.missingRequired.join(', ') +
        '. Export ใหม่จาก Chrome ที่ล็อกอิน youtube.com แล้ว (Application → Cookies) หรือใช้ส่วนขยาย cookies.txt'
    );
    err.code = 'WEAK_COOKIES';
    err.missingRequired = analysis.missingRequired;
    err.missingRecommended = analysis.missingRecommended;
    throw err;
  }

  const hygiene = analyzeCookieHygiene(map, { envelopeQuoted, valuesHadQuotes });
  if (hygiene.suspicious && hygiene.sapisidValueLengthBand === 'short') {
    const err = new Error(
      'ค่า SAPISID สั้นผิดปกติ — อาจถูกตัดหรือใส่ quote ใน Hostinger env ลองวางผ่าน /youtube-cookies-admin.html หรือเอาเครื่องหมาย " ออกจาก YOUTUBE_COOKIES'
    );
    err.code = 'WEAK_COOKIES';
    err.missingRequired = ['SAPISID value looks truncated'];
    throw err;
  }

  ensureStoreDir();
  fs.writeFileSync(STORE_FILE, header, { mode: 0o600 });
  runtimeHeader = header;
  runtimeNames = names;
  runtimeHygiene = hygiene;
  runtimeMeta = {
    source,
    updatedAt: new Date().toISOString(),
    nameCount: names.length,
  };
  return cookiesStatus();
}

function clearYoutubeCookies() {
  runtimeHeader = null;
  runtimeNames = [];
  runtimeHygiene = null;
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
  analyzeCookieNames,
  analyzeCookieHygiene,
  stripWrappingQuotes,
  getYoutubeCookieHeader,
  getCookieMap,
  getCookieFingerprint,
  buildSapisidHashAuthorization,
  cookiesStatus,
  saveYoutubeCookies,
  clearYoutubeCookies,
  assertAdminToken,
  YOUTUBE_ORIGIN,
  REQUIRED_ANY_SESSION,
  REQUIRED_ANY_SAPISID,
  RECOMMENDED,
  STORE_FILE,
};
