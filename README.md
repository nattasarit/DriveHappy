# DriveHappy

In-car Tesla browser dashboard for **Nattaphon Churangsarit** — Thai-first, glanceable, Hostinger Node.js.

**Live domain:** [https://hd.bkksoftkit.com](https://hd.bkksoftkit.com)  
**Vehicle (MVP):** VIN `LRWYHCFJ7SC322078` (Model Y Juniper 2025)

## Hard rules

- **Never wake** the vehicle (`wake_up` is blocked in code).
- **Never send commands** (command endpoints are blocked in code).
- Prefer **`vehicle_data_cached`**; optional light live poll **only if already online**.
- Stay under the **~$10/mo** Tesla Fleet credit via aggressive TTL caching + soft call limit.

## Stack

- Express (`server.js`) + static `public/`
- In-memory TTL caches for Tesla + widgets + YouTube search/streams
- Node **24.x** on Hostinger

## Local run

```bash
cp .env.example .env
# fill Tesla + optional YouTube keys
npm install
npm start
# open http://localhost:3000
```

## Hostinger GitHub deploy (hd.bkksoftkit.com)

1. In hPanel → **Node.js** → connect this GitHub repo / branch.
2. Settings:
   - **Framework:** Express
   - **Node.js version:** **24**
   - **Entry file:** `server.js`
   - **Start command:** `npm start` (or auto from `package.json`)
   - **Build command:** none
3. Add environment variables from `.env.example` (never commit secrets).
4. Deploy. Confirm `https://hd.bkksoftkit.com/api/health`.

### Required after deploy (secrets only Nattaphon has)

| Variable | Notes |
| --- | --- |
| `TESLA_CLIENT_ID` | Fleet developer app |
| `TESLA_CLIENT_SECRET` | Fleet developer app |
| `TESLA_REFRESH_TOKEN` | From one-time OAuth (below) |
| `TESLA_API_BASE` | Region Fleet API host for your account |
| `TESLA_VIN` | Default already `LRWYHCFJ7SC322078` |
| `TESLA_REDIRECT_URI` | `https://hd.bkksoftkit.com/api/tesla/callback` (must match Tesla app) |
| `YOUTUBE_API_KEY` | Optional; improves **search** only |
| `YOUTUBE_COOKIES` | Optional; exported YouTube cookies for Innertube (hPanel) |
| `YOUTUBE_COOKIE_ADMIN_TOKEN` | Optional; enables paste UI at `/youtube-cookies-admin.html` |
| `PIPED_API_BASES` / `INVIDIOUS_API_BASES` | Optional proxy lists |

Optional: `NEWS_FEED_URL`, gold URL, cache TTLs, `TESLA_SOFT_LIMIT_CALLS`.

## One-time Tesla OAuth

Scopes used: `openid offline_access vehicle_device_data` (**no** `vehicle_cmds`).

1. Ensure redirect URI `https://hd.bkksoftkit.com/api/tesla/callback` is registered on the Tesla developer app.
2. Open `https://hd.bkksoftkit.com/api/tesla/login` on a phone/laptop (not while driving).
3. Sign in and approve.
4. Copy **`refresh_token`** from the success page into Hostinger `TESLA_REFRESH_TOKEN`.
5. Redeploy.

CLI helper (prints authorize URL): `npm run oauth:tesla`

Refresh tokens are single-use — when the server refreshes, it keeps the new token **in memory**. After process restart you need the latest refresh token in env; if login fails with `login_required`, run OAuth again and update Hostinger.

## Widgets

| Widget | Behavior |
| --- | --- |
| Weather | Browser **geolocation** → Open-Meteo °C; **Bangkok fallback** if denied |
| News | **ไทยรัฐ** RSS (`NEWS_FEED_URL`) |
| Gold | **ราคาบาท** (บาททอง) via Thai gold API |
| BTC | CoinGecko THB/USD |

## YouTube (canvas)

- In-app search, paste URL, and login entry points.
- **Playback UI is `<canvas>` only** — there is no `<video>` tag in `index.html`.
- Tapping a search result opens a **dedicated full-screen player page** (not an inline player under the results). **← รายการวิดีโอ** returns to the search results; dashboard exit is separate.
- Decoder choice (Tesla): a **detached** `HTMLVideoElement` created with `document.createElement('video')` and **never appended** to the DOM. Frames are painted with `canvas.drawImage(decoder)` each animation frame; the same element feeds audio. Pure canvas + WebAudio demux/decode would need a WASM pipeline we do not ship; off-DOM video + canvas is the practical path so the in-car browser sees canvas media, not a page-level `<video>`.
- Server `/api/youtube/resolve` tries **Innertube (ANDROID_VR / Android / iOS) → Piped (batched) → Invidious**, prefers progressive muxed MP4 (≈360p–720p), demotes LBRY/HLS, and probes the URL before returning. `/api/youtube/media` same-origin proxies bytes (and avoids broken Piped `Content-Range` probes).
- Play / pause on the player; **ปิดคลิป** / Back stop decode and return to results.
- **`YOUTUBE_API_KEY`** (Hostinger env): preferred for **search + video metadata**. It does **not** officially unlock stream URLs; playback still uses Innertube → Piped → Invidious (the key is also tried on Innertube player requests when set).
- **Cookies / LOGIN_REQUIRED (DRI-8):** the car browser on `hd.bkksoftkit.com` **cannot** read `youtube.com` cookies (same-origin). Options: (a) set **`YOUTUBE_COOKIES`** in hPanel, or (b) open **`/youtube-cookies-admin.html`**, enter **`YOUTUBE_COOKIE_ADMIN_TOKEN`**, paste Cookie header / Netscape export once (stored under `.tokens/`, not git). Silent “reuse the YouTube tab’s login” is impossible cross-origin.
- After setting/changing YouTube env vars in hPanel, **redeploy / restart** the Node app so the process picks them up. Check `GET /api/youtube/status` → `dataApiConfigured` / `cookiesConfigured` (booleans only; never returns secrets).

### Verify on the car

1. Open `https://hd.bkksoftkit.com` in the Tesla browser while parked/driving per your usual flow.
2. Tap **YouTube** → search → tap a result (opens a **full-screen** canvas page).
3. Confirm moving frames on the canvas (not native video chrome) and audio plays.
4. Tap **หยุดชั่วคราว** / **เล่น**, then **← รายการวิดีโอ** and confirm you are back on the search results with playback stopped. Use **แดชบอร์ด** / **← แดชบอร์ด** to leave YouTube entirely.

### Tesla browser limits (important)

- Google / YouTube **login inside iframes** often fails (`X-Frame-Options`, cookie partitioning).
- Third-party cookies may not persist between car browser sessions.
- Some media MIME types / autoplay policies still fail even with canvas — treat playback as **best-effort** per firmware.
- Stream resolution uses Piped + Innertube fallbacks; some clips (especially live / bot-gated) may require login or fail until YouTube softens checks.
- If login fails in the car: sign in on phone/desktop; use anonymous search in the car.
- Do not regress Tesla **read-only / no-wake / no-command** rules when touching vehicle APIs (YouTube path does not call Tesla).

## API surface

- `GET /api/health`
- `GET /api/vehicle` — cached Tesla snapshot
- `GET /api/widgets?lat=&lon=` — weather/news/gold/btc
- `GET /api/widgets/weather|news|gold|btc`
- `GET /api/youtube/status` — whether Data API / cookies are configured (booleans only)
- `GET /api/youtube/cookies/status` · `POST|DELETE /api/youtube/cookies` (admin token)
- `GET /api/youtube/search?q=`
- `GET /api/youtube/resolve?id=` / `?url=`
- `GET /api/youtube/media?url=` — CORS-safe media proxy
- `GET /api/tesla/login` · `GET /api/tesla/callback`

## Safety

The Tesla HTTP client **throws** if a path contains `wake_up`, `command`, or `signed_command`. Do not add those routes.
