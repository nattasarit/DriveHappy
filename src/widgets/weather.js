'use strict';

const { config } = require('../config');
const { cache } = require('../cache');

const WMO_TH = {
  0: 'ท้องฟ้าแจ่มใส',
  1: 'ส่วนใหญ่แจ่มใส',
  2: 'มีเมฆบางส่วน',
  3: 'เมฆมาก',
  45: 'หมอก',
  48: 'หมอกน้ำแข็ง',
  51: 'ฝนปรอยเล็กน้อย',
  53: 'ฝนปรอย',
  55: 'ฝนปรอยหนัก',
  61: 'ฝนเล็กน้อย',
  63: 'ฝนปานกลาง',
  65: 'ฝนหนัก',
  71: 'หิมะเล็กน้อย',
  80: 'ฝนซู่เล็กน้อย',
  81: 'ฝนซู่',
  82: 'ฝนซู่หนัก',
  95: 'พายุฝนฟ้าคะนอง',
};

function roundCoord(n) {
  return Math.round(Number(n) * 100) / 100;
}

async function reverseLabel(lat, lon) {
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/reverse?latitude=${lat}&longitude=${lon}&language=th&format=json`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    return json?.city || json?.name || json?.locality || null;
  } catch {
    return null;
  }
}

async function fetchWeather(lat, lon, { fallback = false } = {}) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m` +
    `&timezone=Asia%2FBangkok`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const json = await res.json();
  const cur = json.current || {};
  const code = cur.weather_code;
  const label = (await reverseLabel(lat, lon)) || (fallback ? config.weatherFallback.label : `${lat}, ${lon}`);
  return {
    lat,
    lon,
    label,
    fallback,
    tempC: cur.temperature_2m ?? null,
    humidity: cur.relative_humidity_2m ?? null,
    windKmh: cur.wind_speed_10m ?? null,
    weatherCode: code ?? null,
    conditionTh: WMO_TH[code] || 'สภาพอากาศ',
    observedAt: cur.time || null,
  };
}

async function getWeather({ lat, lon } = {}) {
  let useLat = lat;
  let useLon = lon;
  let fallback = false;

  if (useLat == null || useLon == null || Number.isNaN(Number(useLat)) || Number.isNaN(Number(useLon))) {
    useLat = config.weatherFallback.lat;
    useLon = config.weatherFallback.lon;
    fallback = true;
  }

  useLat = roundCoord(useLat);
  useLon = roundCoord(useLon);
  const key = `weather:${useLat},${useLon}`;

  const result = await cache.getOrFetch(key, config.ttl.weather, () =>
    fetchWeather(useLat, useLon, { fallback })
  );

  return {
    ...result.data,
    cached: result.cached,
    stale: Boolean(result.stale),
    storedAt: result.storedAt,
    ageMs: result.ageMs,
  };
}

module.exports = { getWeather };
