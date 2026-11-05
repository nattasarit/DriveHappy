'use strict';

const { config } = require('../config');
const { cache } = require('../cache');

const FETCH_TIMEOUT_MS = 12_000;

function extractVideoId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^[\w-]{11}$/.test(s)) return s;

  const rel = s.match(/[?&]v=([\w-]{11})/);
  if (rel) return rel[1];
  const shortPath = s.match(/youtu\.be\/([\w-]{11})/);
  if (shortPath) return shortPath[1];
  const embed = s.match(/\/(?:embed|shorts)\/([\w-]{11})/);
  if (embed) return embed[1];

  try {
    const u = new URL(s, 'https://www.youtube.com');
    if (u.hostname.includes('youtu.be')) {
      return u.pathname.split('/').filter(Boolean)[0] || null;
    }
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    const parts = u.pathname.split('/').filter(Boolean);
    const embedIdx = parts.indexOf('embed');
    if (embedIdx >= 0 && parts[embedIdx + 1]) return parts[embedIdx + 1];
    const shortsIdx = parts.indexOf('shorts');
    if (shortsIdx >= 0 && parts[shortsIdx + 1]) return parts[shortsIdx + 1];
  } catch {
    // not a URL
  }
  return null;
}

function classifyUpstreamError(message, status) {
  const m = String(message || '');
  const lower = m.toLowerCase();
  if (
    /sign in to confirm|you.re not a bot|you’re not a bot|signinconfirmed|bot/i.test(m) ||
    status === 'LOGIN_REQUIRED' && /bot|confirm/i.test(m)
  ) {
    return 'bot_check';
  }
  if (
    status === 'LOGIN_REQUIRED' ||
    /login_required|age.?restrict|sign in to|please sign in|ต้องล็อกอิน/i.test(lower)
  ) {
    return 'login_required';
  }
  if (/403|429|502|503|526|timeout|abort|fetch failed|econn|non-json|shutdown/i.test(lower)) {
    return 'transient';
  }
  return 'unavailable';
}

function thaiErrorMessage(kind) {
  switch (kind) {
    case 'bot_check':
      return (
        'YouTube บล็อกการดึงสตรีมจากเซิร์ฟเวอร์ (ตรวจบอท) — ยังเล่นแบบไม่ล็อกอินในรถไม่ได้สำหรับคลิปนี้ ' +
        'ลองคลิปอื่นก่อน หรือให้ผู้ดูแลใส่ YOUTUBE_COOKIES ใน Hostinger สำหรับคลิปที่ติดบ่อย'
      );
    case 'login_required':
      return (
        'คลิปนี้ต้องล็อกอิน / จำกัดอายุบน YouTube — ใช้ปุ่มเข้าสู่ระบบบนโทรศัพท์/คอม แล้วลองใหม่ ' +
        'หรือเลือกคลิปอื่นที่เล่นได้โดยไม่ล็อกอิน'
      );
    case 'transient':
      return 'พร็อกซีสตรีมขัดข้องชั่วคราว (Piped/Invidious) — ลองคลิปอื่นหรือรอสักครู่แล้วลองใหม่';
    default:
      return 'ไม่พบสตรีมที่เล่นบน canvas ได้ — ลองคลิปอื่น';
  }
}

async function fetchJson(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal, redirect: 'follow' });
    const contentType = res.headers.get('content-type') || '';
    const text = await res.text();
    let json = null;
    if (contentType.includes('json') || text.trim().startsWith('{') || text.trim().startsWith('[')) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { res, text, json, contentType };
  } finally {
    clearTimeout(timer);
  }
}

async function searchWithYoutubeDataApi(query) {
  const key = config.youtubeApiKey;
  if (!key) throw new Error('YOUTUBE_API_KEY not configured');
  const url =
    `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=12` +
    `&q=${encodeURIComponent(query)}&key=${encodeURIComponent(key)}`;
  const { res, json, text } = await fetchJson(url);
  if (!res.ok) {
    const apiErr = json?.error?.message || text.slice(0, 120);
    throw new Error(`YouTube Data API ${res.status}: ${apiErr}`);
  }
  return (json.items || [])
    .map((item) => ({
      videoId: item.id?.videoId,
      title: item.snippet?.title,
      channel: item.snippet?.channelTitle,
      thumbnail: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url,
    }))
    .filter((v) => v.videoId);
}

/** Metadata only — Data API never returns playable stream URLs. */
async function fetchVideoMetaViaDataApi(id) {
  const key = config.youtubeApiKey;
  if (!key) return null;
  const url =
    `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,status` +
    `&id=${encodeURIComponent(id)}&key=${encodeURIComponent(key)}`;
  const { res, json } = await fetchJson(url);
  if (!res.ok) return null;
  const item = json?.items?.[0];
  if (!item) return null;
  const thumb =
    item.snippet?.thumbnails?.medium?.url ||
    item.snippet?.thumbnails?.high?.url ||
    item.snippet?.thumbnails?.default?.url ||
    null;
  return {
    videoId: id,
    title: item.snippet?.title || id,
    channel: item.snippet?.channelTitle || null,
    thumbnail: thumb,
    duration: null,
    embeddable: item.status?.embeddable !== false,
    privacyStatus: item.status?.privacyStatus || null,
  };
}

async function searchWithPiped(query) {
  let lastErr;
  for (const base of config.pipedApiBases) {
    try {
      const { res, json, contentType } = await fetchJson(
        `${base}/search?q=${encodeURIComponent(query)}&filter=videos`,
        { headers: { Accept: 'application/json' } }
      );
      if (!res.ok) throw new Error(`Piped ${res.status}`);
      if (!contentType.includes('json') && !json) throw new Error(`Piped non-JSON from ${base}`);
      const items = Array.isArray(json) ? json : json.items || [];
      const mapped = items
        .filter((i) => i && (i.type === 'stream' || String(i.url || '').includes('watch')))
        .slice(0, 12)
        .map((i) => ({
          videoId: extractVideoId(i.url) || extractVideoId(i.id) || null,
          title: i.title,
          channel: i.uploaderName || i.uploader || i.channelName,
          thumbnail: i.thumbnail || (i.thumbnails && i.thumbnails[0]?.url) || null,
          duration: i.duration || null,
        }))
        .filter((v) => v.videoId);
      if (!mapped.length) throw new Error(`Piped empty results from ${base}`);
      return mapped;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('All Piped search bases failed');
}

async function searchWithInvidious(query) {
  let lastErr;
  for (const base of config.invidiousApiBases) {
    try {
      const { res, json } = await fetchJson(
        `${base}/api/v1/search?q=${encodeURIComponent(query)}&type=video`,
        { headers: { Accept: 'application/json' } }
      );
      if (!res.ok) throw new Error(`Invidious ${res.status}`);
      const items = Array.isArray(json) ? json : [];
      const mapped = items
        .filter((i) => i && (i.type === 'video' || i.videoId))
        .slice(0, 12)
        .map((i) => ({
          videoId: i.videoId || extractVideoId(i.videoId),
          title: i.title,
          channel: i.author,
          thumbnail: i.videoThumbnails?.[1]?.url || i.videoThumbnails?.[0]?.url || null,
          duration: i.lengthSeconds || null,
        }))
        .filter((v) => v.videoId);
      if (!mapped.length) throw new Error(`Invidious empty results from ${base}`);
      return mapped;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('All Invidious search bases failed');
}

async function searchVideos(query) {
  const q = String(query || '').trim();
  if (!q) return { items: [], query: q };
  // Bust cache when Data API key appears/disappears so Hostinger env updates take effect.
  const cacheKey = `yt:search:${config.youtubeApiKey ? 'gapi' : 'anon'}:${q.toLowerCase()}`;
  const result = await cache.getOrFetch(cacheKey, config.ttl.youtube, async () => {
    const attempts = [];
    if (config.youtubeApiKey) {
      try {
        const items = await searchWithYoutubeDataApi(q);
        return {
          items,
          provider: 'youtube-data-api',
          dataApiConfigured: true,
        };
      } catch (err) {
        attempts.push(`data-api: ${err.message}`);
      }
    }
    try {
      const items = await searchWithPiped(q);
      return {
        items,
        provider: 'piped',
        dataApiConfigured: Boolean(config.youtubeApiKey),
        dataApiFallback: attempts[0] || null,
      };
    } catch (err) {
      attempts.push(`piped: ${err.message}`);
    }
    try {
      const items = await searchWithInvidious(q);
      return {
        items,
        provider: 'invidious',
        dataApiConfigured: Boolean(config.youtubeApiKey),
        dataApiFallback: attempts[0] || null,
      };
    } catch (err) {
      attempts.push(`invidious: ${err.message}`);
      throw new Error(`ค้นหาไม่สำเร็จ: ${attempts.join(' | ')}`);
    }
  });
  return {
    query: q,
    ...result.data,
    cached: result.cached,
    storedAt: result.storedAt,
  };
}

/**
 * Score candidate streams for Tesla canvas playback.
 * Prefer progressive muxed MP4 (~360–720p). Demote LBRY / HLS.
 */
function streamScore(s) {
  if (!s?.url) return -10000;
  const mime = String(s.mimeType || s.format || s.type || '').toLowerCase();
  const quality = String(s.quality || s.qualityLabel || '').toLowerCase();
  const codec = String(s.codec || '').toLowerCase();
  const height = Number(s.height) || 0;
  let score = 0;

  if (/lbry/.test(quality) || /odycdn\.com|lbry/.test(s.url)) score -= 500;
  if (/mpegurl|m3u8|hls/.test(mime) || /\bhls\b/.test(quality)) score -= 400;
  if (/webm/.test(mime)) score -= 20;
  if (/mp4/.test(mime)) score += 80;
  if (/avc1|h264/.test(mime + codec)) score += 20;
  if (/mp4a|aac/.test(mime + codec)) score += 15;

  if (height) score += Math.min(height, 720);
  else if (/1080/.test(quality)) score += 500;
  else if (/720/.test(quality)) score += 720;
  else if (/480/.test(quality)) score += 480;
  else if (/360/.test(quality)) score += 360;
  else if (/240|144/.test(quality)) score += 200;

  if (height > 720 || /1080|1440|2160|4k/.test(quality)) score -= 150;
  if (/720/.test(quality) || height === 720) score += 40;
  if (/360/.test(quality) || height === 360) score += 60;

  if (s.videoOnly === true) score -= 80;
  return score;
}

function pickBestStream(streams) {
  const ranked = (streams || [])
    .filter((s) => s && s.url)
    .map((s) => ({ s, score: streamScore(s) }))
    .filter((x) => x.score > -300)
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.s || null;
}

function innertubeHeaders(client) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': client.ua,
    Accept: 'application/json',
  };
  if (config.youtubeCookies) {
    headers.Cookie = config.youtubeCookies;
  }
  if (client.visitorData) {
    headers['X-Goog-Visitor-Id'] = client.visitorData;
  }
  return headers;
}

async function fetchVisitorData() {
  try {
    const { json } = await fetchJson(
      'https://www.youtube.com/youtubei/v1/visitor_id?prettyPrint=false',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent':
            'com.google.android.apps.youtube.vr.oculus/1.61.48 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
          ...(config.youtubeCookies ? { Cookie: config.youtubeCookies } : {}),
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: 'ANDROID_VR',
              clientVersion: '1.61.48',
              hl: 'en',
              gl: 'US',
            },
          },
        }),
      },
      8000
    );
    return json?.responseContext?.visitorData || json?.visitorData || null;
  } catch {
    return null;
  }
}

function buildInnertubeClients() {
  const clients = [
    {
      name: 'ANDROID_VR',
      ua: 'com.google.android.apps.youtube.vr.oculus/1.61.48 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
      client: {
        clientName: 'ANDROID_VR',
        clientVersion: '1.61.48',
        deviceMake: 'Oculus',
        deviceModel: 'Quest 3',
        osName: 'Android',
        osVersion: '12L',
      },
    },
    {
      name: 'ANDROID_VR_LEGACY',
      ua: 'com.google.android.apps.youtube.vr.oculus/1.57.29 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
      client: {
        clientName: 'ANDROID_VR',
        clientVersion: '1.57.29',
        deviceMake: 'Oculus',
        deviceModel: 'Quest 3',
        osName: 'Android',
        osVersion: '12L',
      },
    },
    {
      name: 'ANDROID',
      ua: 'com.google.android.youtube/19.35.36 (Linux; U; Android 13) gzip',
      key: 'AIzaSyA8eiZmM1FaDVzGye-UOe6p3ig-sVo44u8',
      client: {
        clientName: 'ANDROID',
        clientVersion: '19.35.36',
        androidSdkVersion: 33,
      },
    },
    {
      name: 'IOS',
      ua: 'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)',
      key: 'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc',
      client: {
        clientName: 'IOS',
        clientVersion: '19.45.4',
        deviceMake: 'Apple',
        deviceModel: 'iPhone16,2',
        osName: 'iPhone',
        osVersion: '17.5.1.21F90',
      },
    },
  ];
  // Prefer the Hostinger YOUTUBE_API_KEY on Innertube player attempts when present.
  // (Data API keys are for googleapis search/metadata; if Google accepts it on youtubei, great — otherwise ignored.)
  if (config.youtubeApiKey) {
    clients.unshift({
      name: 'ANDROID_VR+GAPI',
      ua: 'com.google.android.apps.youtube.vr.oculus/1.61.48 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
      key: config.youtubeApiKey,
      client: {
        clientName: 'ANDROID_VR',
        clientVersion: '1.61.48',
        deviceMake: 'Oculus',
        deviceModel: 'Quest 3',
        osName: 'Android',
        osVersion: '12L',
      },
    });
  }
  return clients;
}

async function resolveViaInnertube(id, visitorData) {
  const errors = [];
  for (const spec of buildInnertubeClients()) {
    try {
      const client = { ...spec.client, visitorData: visitorData || undefined };
      const body = {
        context: { client: { hl: 'en', gl: 'US', ...client } },
        videoId: id,
        contentCheckOk: true,
        racyCheckOk: true,
        playbackContext: {
          contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' },
        },
      };
      const url = spec.key
        ? `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(spec.key)}&prettyPrint=false`
        : 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
      const { res, json } = await fetchJson(url, {
        method: 'POST',
        headers: innertubeHeaders({ ua: spec.ua, visitorData }),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Innertube HTTP ${res.status}`);
      const status = json?.playabilityStatus?.status;
      const reason = json?.playabilityStatus?.reason || json?.playabilityStatus?.messages?.[0] || '';
      if (status && status !== 'OK') {
        const err = new Error(`YouTube playability ${status}: ${reason}`);
        err.errorKind = classifyUpstreamError(reason, status);
        err.loginRequiredHint = err.errorKind === 'login_required' || err.errorKind === 'bot_check';
        throw err;
      }

      const formats = (json?.streamingData?.formats || []).map((f) => ({
        url: f.url,
        mimeType: f.mimeType,
        quality: f.qualityLabel || f.quality,
        height: f.height,
        codec: f.mimeType,
        videoOnly: false,
      }));
      const adaptive = json?.streamingData?.adaptiveFormats || [];
      const audioOnly = adaptive
        .filter((f) => f.url && String(f.mimeType || '').startsWith('audio/'))
        .map((f) => ({
          url: f.url,
          mimeType: f.mimeType,
          quality: f.bitrate ? `${Math.round(f.bitrate / 1000)}kbps` : null,
          height: 0,
          videoOnly: false,
        }))
        .sort((a, b) => streamScore(b) - streamScore(a));
      const videoOnly = adaptive
        .filter((f) => f.url && String(f.mimeType || '').startsWith('video/'))
        .map((f) => ({
          url: f.url,
          mimeType: f.mimeType,
          quality: f.qualityLabel || f.quality,
          height: f.height,
          codec: f.mimeType,
          videoOnly: true,
        }));

      const chosen = pickBestStream(formats) || pickBestStream(videoOnly);
      if (!chosen?.url) throw new Error(`Innertube ${spec.name} returned no playable URL`);

      return {
        videoId: id,
        title: json?.videoDetails?.title || id,
        channel: json?.videoDetails?.author || null,
        thumbnail: json?.videoDetails?.thumbnail?.thumbnails?.slice(-1)?.[0]?.url || null,
        duration: Number(json?.videoDetails?.lengthSeconds) || null,
        streamUrl: chosen.url,
        mimeType: chosen.mimeType || null,
        quality: chosen.quality || chosen.height || null,
        audioUrl: chosen.videoOnly ? audioOnly[0]?.url || null : null,
        videoOnlyUrl: chosen.videoOnly ? chosen.url : videoOnly[0]?.url || null,
        provider: `innertube:${spec.name}`,
        loginRequiredHint: false,
        errorKind: null,
      };
    } catch (err) {
      errors.push(err);
    }
  }
  const preferred =
    errors.find((e) => e.errorKind === 'bot_check') ||
    errors.find((e) => e.errorKind === 'login_required') ||
    errors[errors.length - 1] ||
    new Error('Innertube resolve failed');
  throw preferred;
}

function mapPipedPayload(id, base, json) {
  if (json.error) {
    const err = new Error(`Piped error: ${String(json.error).slice(0, 180)}`);
    err.errorKind = classifyUpstreamError(String(json.error));
    err.loginRequiredHint = err.errorKind === 'login_required' || err.errorKind === 'bot_check';
    throw err;
  }
  const allVideo = json.videoStreams || json.video_streams || [];
  const progressive = allVideo.filter(
    (s) => s && (s.videoOnly === false || s.videoOnly == null) && s.url
  );
  const videoOnly = allVideo
    .filter((s) => s.videoOnly && s.url)
    .sort((a, b) => streamScore(b) - streamScore(a));
  const audioOnly = (json.audioStreams || json.audio_streams || [])
    .filter((s) => s.url)
    .sort((a, b) => streamScore(b) - streamScore(a));
  const chosen = pickBestStream(progressive);
  const fallbackVideo = pickBestStream(videoOnly);
  if (!chosen?.url && !fallbackVideo?.url) {
    throw new Error(`No canvas-friendly progressive stream from ${base}`);
  }
  return {
    videoId: id,
    title: json.title,
    channel: json.uploader || json.uploaderName,
    thumbnail: json.thumbnailUrl || json.thumbnail,
    duration: json.duration,
    streamUrl: chosen?.url || fallbackVideo?.url || null,
    mimeType: chosen?.mimeType || chosen?.format || fallbackVideo?.mimeType || null,
    quality: chosen?.quality || chosen?.height || fallbackVideo?.quality || null,
    audioUrl: chosen?.url ? audioOnly[0]?.url || null : audioOnly[0]?.url || null,
    videoOnlyUrl: videoOnly[0]?.url || null,
    provider: `piped:${base}`,
    loginRequiredHint: false,
    errorKind: null,
  };
}

async function resolveViaPiped(id) {
  const errors = [];
  // Try instances in parallel batches for speed; first success wins.
  const bases = config.pipedApiBases;
  const batchSize = 3;
  for (let i = 0; i < bases.length; i += batchSize) {
    const batch = bases.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (base) => {
        try {
          const { res, json, text, contentType } = await fetchJson(
            `${base}/streams/${encodeURIComponent(id)}`,
            { headers: { Accept: 'application/json' } }
          );
          if (!res.ok) {
            const err = new Error(`Piped streams ${res.status} @ ${base}`);
            err.errorKind = classifyUpstreamError(`${res.status} ${text}`, String(res.status));
            throw err;
          }
          if (!json) {
            throw Object.assign(new Error(`Piped non-JSON from ${base}: ${text.slice(0, 80)}`), {
              errorKind: 'transient',
            });
          }
          return mapPipedPayload(id, base, json);
        } catch (err) {
          return { __error: err };
        }
      })
    );
    for (const r of results) {
      if (r && !r.__error) return r;
      if (r?.__error) errors.push(r.__error);
    }
  }
  const preferred =
    errors.find((e) => e.errorKind === 'bot_check') ||
    errors.find((e) => e.errorKind === 'login_required') ||
    errors[errors.length - 1] ||
    new Error('Piped stream resolve failed');
  throw preferred;
}

async function resolveViaInvidious(id) {
  const errors = [];
  for (const base of config.invidiousApiBases) {
    try {
      const { res, json, text } = await fetchJson(
        `${base}/api/v1/videos/${encodeURIComponent(id)}`,
        { headers: { Accept: 'application/json' } }
      );
      if (!res.ok) {
        const err = new Error(`Invidious ${res.status} @ ${base}`);
        err.errorKind = classifyUpstreamError(`${res.status} ${text}`);
        throw err;
      }
      if (!json || typeof json !== 'object') throw new Error(`Invidious non-JSON from ${base}`);
      if (json.error) {
        const err = new Error(`Invidious error: ${String(json.error).slice(0, 160)}`);
        err.errorKind = classifyUpstreamError(String(json.error));
        throw err;
      }
      const progressive = (json.formatStreams || []).map((s) => ({
        url: s.url,
        mimeType: s.type || s.mimeType,
        quality: s.qualityLabel || s.quality,
        height: Number(String(s.qualityLabel || '').replace(/\D/g, '')) || 0,
        videoOnly: false,
      }));
      const adaptive = json.adaptiveFormats || [];
      const audioOnly = adaptive
        .filter((s) => s.url && String(s.type || '').startsWith('audio'))
        .map((s) => ({
          url: s.url,
          mimeType: s.type,
          quality: s.bitrate ? `${Math.round(s.bitrate / 1000)}kbps` : null,
          height: 0,
          videoOnly: false,
        }));
      const videoOnly = adaptive
        .filter((s) => s.url && String(s.type || '').startsWith('video'))
        .map((s) => ({
          url: s.url,
          mimeType: s.type,
          quality: s.qualityLabel || s.quality,
          height: s.height || 0,
          videoOnly: true,
        }));
      const chosen = pickBestStream(progressive) || pickBestStream(videoOnly);
      if (!chosen?.url) throw new Error(`No playable Invidious formats from ${base}`);
      return {
        videoId: id,
        title: json.title,
        channel: json.author,
        thumbnail: json.videoThumbnails?.[0]?.url || null,
        duration: json.lengthSeconds,
        streamUrl: chosen.url,
        mimeType: chosen.mimeType || null,
        quality: chosen.quality || chosen.height || null,
        audioUrl: chosen.videoOnly ? audioOnly[0]?.url || null : null,
        videoOnlyUrl: chosen.videoOnly ? chosen.url : videoOnly[0]?.url || null,
        provider: `invidious:${base}`,
        loginRequiredHint: false,
        errorKind: null,
      };
    } catch (err) {
      errors.push(err);
    }
  }
  throw errors[errors.length - 1] || new Error('Invidious resolve failed');
}

/** Quick probe that the chosen URL looks like media (avoid returning dead Piped links). */
async function validateStreamUrl(url) {
  if (!url) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Range: 'bytes=0-1023',
          'User-Agent': 'DriveHappy/1.0',
          Accept: '*/*',
        },
        signal: ctrl.signal,
        redirect: 'follow',
      });
      if (!(res.ok || res.status === 206)) return false;
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('json') || ct.includes('html') || ct.includes('text/plain')) return false;
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

async function resolveStreams(videoId) {
  const id = extractVideoId(videoId) || videoId;
  if (!id) throw new Error('Invalid video id');
  const key = `yt:streams:${config.youtubeApiKey ? 'gapi' : 'anon'}:${id}`;
  const result = await cache.getOrFetch(key, config.ttl.youtube, async () => {
    const errors = [];
    const visitorData = await fetchVisitorData();
    const meta = await fetchVideoMetaViaDataApi(id);

    // Streams never come from Data API. Prefer Innertube (optionally keyed), then Piped, then Invidious.
    const attempts = [
      () => resolveViaInnertube(id, visitorData),
      () => resolveViaPiped(id),
      () => resolveViaInvidious(id),
    ];

    for (const attempt of attempts) {
      try {
        const data = await attempt();
        if (!data?.streamUrl) continue;
        const ok = await validateStreamUrl(data.streamUrl);
        if (!ok) {
          errors.push(
            Object.assign(new Error(`Stream URL failed probe (${data.provider})`), {
              errorKind: 'transient',
            })
          );
          continue;
        }
        return {
          ...data,
          title: data.title || meta?.title || id,
          channel: data.channel || meta?.channel || null,
          thumbnail: data.thumbnail || meta?.thumbnail || null,
          dataApiConfigured: Boolean(config.youtubeApiKey),
        };
      } catch (err) {
        errors.push(err);
      }
    }

    const kinds = errors.map((e) => e.errorKind || classifyUpstreamError(e.message));
    const kind = kinds.includes('bot_check')
      ? 'bot_check'
      : kinds.includes('login_required')
        ? 'login_required'
        : kinds.includes('transient')
          ? 'transient'
          : 'unavailable';

    const detail = errors
      .map((e) => e.message)
      .filter(Boolean)
      .slice(0, 3)
      .join(' | ');
    const e = new Error(`${thaiErrorMessage(kind)}${detail ? ` (${detail})` : ''}`);
    e.errorKind = kind;
    e.loginRequiredHint = kind === 'login_required' || kind === 'bot_check';
    e.meta = meta;
    throw e;
  });

  return {
    ...result.data,
    cached: result.cached,
    storedAt: result.storedAt,
  };
}

function youtubeIntegrationStatus() {
  return {
    dataApiConfigured: Boolean(config.youtubeApiKey),
    cookiesConfigured: Boolean(config.youtubeCookies),
    pipedBases: config.pipedApiBases.length,
    invidiousBases: config.invidiousApiBases.length,
    note:
      'YOUTUBE_API_KEY improves search/metadata only; playable streams use Innertube/Piped/Invidious (optional YOUTUBE_COOKIES for bot-checks).',
  };
}

module.exports = {
  extractVideoId,
  searchVideos,
  resolveStreams,
  classifyUpstreamError,
  thaiErrorMessage,
  youtubeIntegrationStatus,
};
