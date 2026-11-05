(() => {
  const $ = (id) => document.getElementById(id);

  const dashboard = $('dashboard');
  const app = $('youtube-app');
  const browse = $('yt-browse');
  const results = $('yt-results');
  const playerPage = $('yt-player-page');
  const canvas = $('yt-canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  const nowTitle = $('yt-now-title');
  const statusEl = $('yt-player-status');
  const loginPanel = $('yt-login-panel');

  /**
   * Tesla in-car browsers often restrict visible HTML <video> while driving.
   * Strategy: keep a detached (never-appended) HTMLMediaElement solely as a
   * decoder, draw every frame onto a full-screen <canvas>, and let the same
   * element feed audio. Pure canvas+WebAudio decode is not practical without
   * a WASM demuxer; off-DOM <video> + canvas is the Tesla-friendly compromise.
   */
  let decoder = null;
  let audioDecoder = null;
  let raf = 0;
  let playing = false;
  let lastObjectUrl = null;

  function setStatus(msg) {
    statusEl.textContent = msg || '';
  }

  function proxyMediaUrl(remoteUrl) {
    return `/api/youtube/media?url=${encodeURIComponent(remoteUrl)}`;
  }

  function revokeObjectUrl() {
    if (lastObjectUrl) {
      try {
        URL.revokeObjectURL(lastObjectUrl);
      } catch {
        // ignore
      }
      lastObjectUrl = null;
    }
  }

  function makeDecoder(tag) {
    const el = document.createElement(tag);
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    if (tag === 'video') {
      el.playsInline = true;
      el.setAttribute('playsinline', '');
      el.setAttribute('webkit-playsinline', '');
      el.muted = false;
      // Detached on purpose — never appendChild to the document.
    }
    return el;
  }

  function ensureDecoder() {
    if (!decoder) decoder = makeDecoder('video');
    return decoder;
  }

  function stopLoop() {
    playing = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function clearCanvas() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  /** Match canvas buffer to the on-screen stage for sharp Tesla/desktop frames. */
  function syncCanvasSize() {
    const stage = canvas.parentElement;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const w = Math.max(320, Math.floor(rect.width));
    const h = Math.max(180, Math.floor(rect.height));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function drawFrame() {
    if (!decoder) return;
    if (decoder.readyState >= 2 && decoder.videoWidth > 0) {
      syncCanvasSize();
      const cw = canvas.width;
      const ch = canvas.height;
      const vw = decoder.videoWidth;
      const vh = decoder.videoHeight;
      const scale = Math.min(cw / vw, ch / vh);
      const dw = vw * scale;
      const dh = vh * scale;
      const dx = (cw - dw) / 2;
      const dy = (ch - dh) / 2;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, cw, ch);
      try {
        ctx.drawImage(decoder, dx, dy, dw, dh);
      } catch {
        // transient decode glitch — keep looping
      }
    }
    if (playing) raf = requestAnimationFrame(drawFrame);
  }

  function resetMediaElement(el) {
    if (!el) return;
    try {
      el.pause();
      el.removeAttribute('src');
      el.load();
    } catch {
      // ignore
    }
  }

  function stopDecodeOnly() {
    stopLoop();
    resetMediaElement(decoder);
    resetMediaElement(audioDecoder);
    decoder = null;
    audioDecoder = null;
    revokeObjectUrl();
    clearCanvas();
    nowTitle.textContent = '';
    setStatus('');
  }

  function showBrowse() {
    playerPage.hidden = true;
    app.hidden = false;
    if (browse) browse.hidden = false;
    dashboard.hidden = true;
  }

  function showPlayerPage() {
    dashboard.hidden = true;
    app.hidden = true;
    playerPage.hidden = false;
    syncCanvasSize();
  }

  /** Leave the full-screen player and return to search results. */
  function backToResults() {
    stopDecodeOnly();
    showBrowse();
  }

  /** Leave YouTube entirely and return to the glanceable dashboard. */
  function closeToDashboard() {
    stopDecodeOnly();
    playerPage.hidden = true;
    app.hidden = true;
    dashboard.hidden = false;
  }

  function waitForEvent(el, event, timeoutMs = 25000) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error(`หมดเวลารอ ${event}`));
      }, timeoutMs);
      const onOk = () => {
        if (done) return;
        done = true;
        cleanup();
        resolve();
      };
      const onErr = () => {
        if (done) return;
        done = true;
        cleanup();
        const mediaErr = el.error;
        reject(new Error(mediaErr ? `media error ${mediaErr.code}` : 'media error'));
      };
      function cleanup() {
        clearTimeout(timer);
        el.removeEventListener(event, onOk);
        el.removeEventListener('error', onErr);
      }
      el.addEventListener(event, onOk, { once: true });
      el.addEventListener('error', onErr, { once: true });
    });
  }

  async function playResolved(data) {
    stopDecodeOnly();
    showPlayerPage();
    nowTitle.textContent = data.title || data.videoId;
    if (!data.streamUrl) {
      setStatus('ไม่พบสตรีมสำหรับคลิปนี้ — ลองคลิปอื่น หรือตั้ง YOUTUBE_API_KEY / Piped');
      return;
    }

    const needsSeparateAudio =
      Boolean(data.audioUrl) && Boolean(data.videoOnlyUrl) && data.streamUrl === data.videoOnlyUrl;
    const mediaUrl = proxyMediaUrl(data.streamUrl);

    setStatus(`กำลังโหลดสตรีม (${data.quality || data.mimeType || 'mp4'} · ${data.provider || ''})…`);

    const v = ensureDecoder();
    v.src = mediaUrl;

    try {
      await waitForEvent(v, 'loadeddata');
    } catch (err) {
      setStatus(`โหลดวิดีโอไม่สำเร็จ: ${err.message}`);
      return;
    }

    if (needsSeparateAudio && data.audioUrl) {
      audioDecoder = makeDecoder('audio');
      audioDecoder.src = proxyMediaUrl(data.audioUrl);
      try {
        await waitForEvent(audioDecoder, 'canplay');
      } catch (err) {
        setStatus(`โหลดเสียงไม่สำเร็จ: ${err.message} — จะเล่นภาพอย่างเดียว`);
        audioDecoder = null;
      }
    }

    try {
      const plays = [v.play()];
      if (audioDecoder) plays.push(audioDecoder.play());
      await Promise.all(plays);
      playing = true;
      drawFrame();
      setStatus('กำลังเล่นบน canvas (ถอดรหัสนอก DOM — ไม่มีแท็ก video ในหน้า)');
    } catch (err) {
      setStatus(`เล่นไม่สำเร็จ: ${err.message}. เบราว์เซอร์รถอาจบล็อกมีเดียบางชนิด`);
    }
  }

  async function openVideo(idOrUrl) {
    showPlayerPage();
    nowTitle.textContent = '';
    clearCanvas();
    setStatus('กำลังโหลดสตรีม…');
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
    stopDecodeOnly();
    showBrowse();
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
    stopDecodeOnly();
    playerPage.hidden = true;
    dashboard.hidden = true;
    app.hidden = false;
    if (browse) browse.hidden = false;
    loginPanel.hidden = true;
  }

  async function togglePlay() {
    const v = ensureDecoder();
    try {
      if (v.paused) {
        await v.play();
        if (audioDecoder) await audioDecoder.play();
        playing = true;
        drawFrame();
        setStatus('กำลังเล่นบน canvas');
      }
    } catch (err) {
      setStatus(err.message);
    }
  }

  function pause() {
    if (decoder) decoder.pause();
    if (audioDecoder) audioDecoder.pause();
    stopLoop();
    setStatus('หยุดชั่วคราว');
  }

  $('yt-close').addEventListener('click', closeToDashboard);
  $('yt-exit-dash').addEventListener('click', closeToDashboard);
  $('yt-back').addEventListener('click', backToResults);
  $('yt-search-btn').addEventListener('click', doSearch);
  $('yt-query').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
  });
  $('yt-open-url').addEventListener('click', () => {
    const url = $('yt-url').value.trim();
    if (url) openVideo(url);
  });
  $('yt-play').addEventListener('click', () => {
    togglePlay();
  });
  $('yt-pause').addEventListener('click', pause);
  // ปิดคลิป = stop and return to search results (not dashboard).
  $('yt-stop').addEventListener('click', backToResults);
  $('yt-login').addEventListener('click', () => {
    loginPanel.hidden = !loginPanel.hidden;
  });
  $('yt-login-dismiss').addEventListener('click', () => {
    loginPanel.hidden = true;
  });

  window.addEventListener('resize', () => {
    if (!playerPage.hidden) syncCanvasSize();
  });

  clearCanvas();

  window.DriveHappyYouTube = {
    open,
    close: closeToDashboard,
    openVideo,
    pause,
    play: togglePlay,
    backToResults,
  };
})();
