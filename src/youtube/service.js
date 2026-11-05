'use strict';

const { config } = require('../config');
const { cache } = require('../cache');

function extractVideoId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^[\w-]{11}$/.test(s)) return s;

  // Piped relative paths: /watch?v=VIDEOID
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

async function searchWithYoutubeDataApi(query) {
  const key = config.youtubeApiKey;
  const url =
    `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=12` +
    `&q=${encodeURIComponent(query)}&key=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube Data API ${res.status}`);
  const json = await res.json();
  return (json.items || []).map((item) => ({
    videoId: item.id?.videoId,
    title: item.snippet?.title,
    channel: item.snippet?.channelTitle,
    thumbnail: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url,
  })).filter((v) => v.videoId);
}

async function searchWithPiped(query) {
  let lastErr;
  for (const base of config.pipedApiBases) {
    try {
      const res = await fetch(`${base}/search?q=${encodeURIComponent(query)}&filter=videos`, {
        headers: { Accept: 'application/json' },
        redirect: 'follow',
      });
      const contentType = res.headers.get('content-type') || '';
      if (!res.ok) throw new Error(`Piped ${res.status}`);
      if (!contentType.includes('json')) throw new Error(`Piped non-JSON from ${base}`);
      const json = await res.json();
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

async function searchVideos(query) {
  const q = String(query || '').trim();
  if (!q) return { items: [], query: q };
  const key = `yt:search:${q.toLowerCase()}`;
  const result = await cache.getOrFetch(key, config.ttl.youtube, async () => {
    if (config.youtubeApiKey) {
      try {
        const items = await searchWithYoutubeDataApi(q);
        return { items, provider: 'youtube-data-api' };
      } catch {
        // fall through to Piped
      }
    }
    const items = await searchWithPiped(q);
    return { items, provider: 'piped' };
  });
  return {
    query: q,
    ...result.data,
    cached: result.cached,
    storedAt: result.storedAt,
  };
}

/**
 * Score Piped/Innertube candidate streams for Tesla canvas playback.
 * Prefer progressive muxed MP4 (itag 18/360p/720p). Demote LBRY mirrors and HLS —
 * LBRY often wins a naive height sort (height=0) but returns multi‑GB junk that
 * the off-DOM decoder cannot usefully play.
 */
function streamScore(s) {
  if (!s?.url) return -10000;
  const mime = String(s.mimeType || s.format || '').toLowerCase();
  const quality = String(s.quality || s.qualityLabel || '').toLowerCase();
  const codec = String(s.codec || '').toLowerCase();
  const height = Number(s.height) || 0;
  let score = 0;

  if (/lbry/.test(quality) || /odycdn\.com|lbry/.test(s.url)) score -= 500;
  if (/mpegurl|m3u8|hls/.test(mime) || /\bhls\b/.test(quality)) score -= 400;
  if (/webm/.test(mime)) score -= 20; // MP4 more reliable in car browsers
  if (/mp4/.test(mime)) score += 80;
  if (/avc1|h264/.test(mime + codec)) score += 20;
  if (/mp4a|aac/.test(mime + codec)) score += 15;

  if (height) score += Math.min(height, 720);
  else if (/1080/.test(quality)) score += 500; // prefer ≤720 below
  else if (/720/.test(quality)) score += 720;
  else if (/480/.test(quality)) score += 480;
  else if (/360/.test(quality)) score += 360;
  else if (/240|144/.test(quality)) score += 200;

  // Cap preference: 360–720p is ideal for in-car bandwidth
  if (height > 720 || /1080|1440|2160|4k/.test(quality)) score -= 150;
  if (/720/.test(quality) || height === 720) score += 40;
  if (/360/.test(quality) || height === 360) score += 60;

  if (s.videoOnly === true) score -= 80; // need separate audio
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

async function resolveViaPiped(id) {
  let lastErr;
  for (const base of config.pipedApiBases) {
    try {
      const res = await fetch(`${base}/streams/${encodeURIComponent(id)}`, {
        headers: { Accept: 'application/json' },
        redirect: 'follow',
      });
      const contentType = res.headers.get('content-type') || '';
      if (!res.ok) throw new Error(`Piped streams ${res.status}`);
      if (!contentType.includes('json')) throw new Error(`Piped streams non-JSON from ${base}`);
      const json = await res.json();
      if (json.error) throw new Error(String(json.error).slice(0, 160));
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
      // If Piped only offered LBRY/HLS (filtered out by score), fail so Innertube can win.
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
        audioUrl: audioOnly[0]?.url || null,
        videoOnlyUrl: videoOnly[0]?.url || null,
        provider: `piped:${base}`,
        loginRequiredHint: false,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Piped stream resolve failed');
}

async function resolveViaInnertube(id) {
  const body = {
    context: {
      client: {
        hl: 'en',
        gl: 'US',
        clientName: 'ANDROID_VR',
        clientVersion: '1.57.29',
        deviceMake: 'Oculus',
        deviceModel: 'Quest 3',
        osName: 'Android',
        osVersion: '12L',
      },
    },
    videoId: id,
    contentCheckOk: true,
    racyCheckOk: true,
    playbackContext: {
      contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' },
    },
  };
  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent':
        'com.google.android.apps.youtube.vr.oculus/1.57.29 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  const status = json?.playabilityStatus?.status;
  if (status && status !== 'OK') {
    const err = new Error(`YouTube playability ${status}`);
    err.loginRequiredHint = status === 'LOGIN_REQUIRED';
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
  if (!chosen?.url) throw new Error('Innertube returned no progressive URL');
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
    provider: 'innertube:ANDROID_VR',
    loginRequiredHint: false,
  };
}

async function resolveStreams(videoId) {
  const id = extractVideoId(videoId) || videoId;
  if (!id) throw new Error('Invalid video id');
  const key = `yt:streams:${id}`;
  const result = await cache.getOrFetch(key, config.ttl.youtube, async () => {
    const errors = [];
    try {
      return await resolveViaPiped(id);
    } catch (err) {
      errors.push(err.message);
    }
    try {
      return await resolveViaInnertube(id);
    } catch (err) {
      errors.push(err.message);
      const hint = err.loginRequiredHint
        ? 'คลิปนี้อาจต้องล็อกอิน YouTube — ใช้ปุ่มเข้าสู่ระบบ หรือลองคลิปอื่น'
        : 'ลองคลิปอื่น หรือตั้งค่า Piped / รอ YouTube ผ่อนบอทเช็ค';
      const e = new Error(`ไม่พบสตรีม: ${errors.join(' | ')}. ${hint}`);
      e.loginRequiredHint = Boolean(err.loginRequiredHint);
      throw e;
    }
  });

  return {
    ...result.data,
    cached: result.cached,
    storedAt: result.storedAt,
  };
}

module.exports = {
  extractVideoId,
  searchVideos,
  resolveStreams,
};
