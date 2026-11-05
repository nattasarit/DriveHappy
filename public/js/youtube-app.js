(() => {
  const $ = (id) => document.getElementById(id);

  const dashboard = $('dashboard');
  const app = $('youtube-app');
  const results = $('yt-results');
  const player = $('yt-player');
  const canvas = $('yt-canvas');
  const ctx = canvas.getContext('2d');
  const nowTitle = $('yt-now-title');
  const statusEl = $('yt-player-status');
  const loginPanel = $('yt-login-panel');

  /** Off-DOM media element used only as a decoder — never inserted into the page as <video>. */
  let decoder = null;
  let raf = 0;
  let playing = false;

  function setStatus(msg) {
    statusEl.textContent = msg || '';
  }

  function ensureDecoder() {
    if (decoder) return decoder;
    decoder = document.createElement('video');
    decoder.playsInline = true;
    decoder.preload = 'auto';
    decoder.crossOrigin = 'anonymous';
    decoder.setAttribute('playsinline', '');
    // Intentionally NOT appended to the DOM — Tesla sees canvas, not a video tag in the document.
    return decoder;
  }

  function stopLoop() {
    playing = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function drawFrame() {
    if (!decoder) return;
    if (decoder.readyState >= 2) {
      const cw = canvas.width;
      const ch = canvas.height;
      const vw = decoder.videoWidth || 16;
      const vh = decoder.videoHeight || 9;
      const scale = Math.min(cw / vw, ch / vh);
      const dw = vw * scale;
      const dh = vh * scale;
      const dx = (cw - dw) / 2;
      const dy = (ch - dh) / 2;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(decoder, dx, dy, dw, dh);
    }
    if (playing) raf = requestAnimationFrame(drawFrame);
  }

  function destroyPlayback() {
    stopLoop();
    if (decoder) {
      try {
        decoder.pause();
        decoder.removeAttribute('src');
        decoder.load();
      } catch {
        // ignore
      }
      decoder = null;
    }
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    player.hidden = true;
    nowTitle.textContent = '';
    setStatus('');
  }

  async function playResolved(data) {
    player.hidden = false;
    nowTitle.textContent = data.title || data.videoId;
    if (!data.streamUrl) {
      setStatus('ไม่พบสตรีมสำหรับคลิปนี้ — ลองคลิปอื่น หรือตั้ง YOUTUBE_API_KEY / Piped');
      return;
    }
    const mediaUrl = `/api/youtube/media?url=${encodeURIComponent(data.streamUrl)}`;
    const v = ensureDecoder();
    v.src = mediaUrl;
    try {
      await v.play();
      playing = true;
      drawFrame();
      setStatus('กำลังเล่นบน canvas (ไม่มีแท็ก video ในหน้า)');
    } catch (err) {
      setStatus(`เล่นไม่สำเร็จ: ${err.message}. เบราว์เซอร์รถอาจบล็อกมีเดียบางชนิด`);
    }
  }

  async function openVideo(idOrUrl) {
    setStatus('กำลังโหลดสตรีม…');
    player.hidden = false;
    try {
      const res = await fetch(`/api/youtube/resolve?id=${encodeURIComponent(idOrUrl)}`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || 'resolve failed');
      await playResolved(json.data);
    } catch (err) {
      setStatus(err.message);
    }
  }

  function renderResults(items) {
    results.innerHTML = '';
    if (!items?.length) {
      results.textContent = 'ไม่พบผลลัพธ์';
      return;
    }
    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'yt-card';
      if (item.thumbnail) {
        const img = document.createElement('img');
        img.src = item.thumbnail;
        img.alt = '';
        btn.appendChild(img);
      }
      const strong = document.createElement('strong');
      strong.textContent = item.title || item.videoId;
      btn.appendChild(strong);
      if (item.channel) {
        const span = document.createElement('span');
        span.textContent = item.channel;
        btn.appendChild(span);
      }
      btn.addEventListener('click', () => openVideo(item.videoId));
      results.appendChild(btn);
    }
  }

  async function doSearch() {
    const q = $('yt-query').value.trim();
    if (!q) return;
    results.textContent = 'กำลังค้นหา…';
    try {
      const res = await fetch(`/api/youtube/search?q=${encodeURIComponent(q)}`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || 'search failed');
      renderResults(json.data.items || []);
    } catch (err) {
      results.textContent = err.message;
    }
  }

  function open() {
    dashboard.hidden = true;
    app.hidden = false;
    loginPanel.hidden = true;
  }

  function close() {
    destroyPlayback();
    app.hidden = true;
    dashboard.hidden = false;
  }

  $('yt-close').addEventListener('click', close);
  $('yt-search-btn').addEventListener('click', doSearch);
  $('yt-query').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
  });
  $('yt-open-url').addEventListener('click', () => {
    const url = $('yt-url').value.trim();
    if (url) openVideo(url);
  });
  $('yt-play').addEventListener('click', async () => {
    const v = ensureDecoder();
    try {
      await v.play();
      playing = true;
      drawFrame();
    } catch (err) {
      setStatus(err.message);
    }
  });
  $('yt-pause').addEventListener('click', () => {
    if (decoder) decoder.pause();
    stopLoop();
    setStatus('หยุดชั่วคราว');
  });
  $('yt-stop').addEventListener('click', destroyPlayback);
  $('yt-login').addEventListener('click', () => {
    loginPanel.hidden = !loginPanel.hidden;
  });
  $('yt-login-dismiss').addEventListener('click', () => {
    loginPanel.hidden = true;
  });

  window.DriveHappyYouTube = { open, close, openVideo };
})();
