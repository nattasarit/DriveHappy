(() => {
  const $ = (id) => document.getElementById(id);

  const els = {
    battery: $('battery-level'),
    range: $('battery-range'),
    meta: $('vehicle-meta'),
    weatherTemp: $('weather-temp'),
    weatherSub: $('weather-sub'),
    goldPrice: $('gold-price'),
    goldSub: $('gold-sub'),
    btcPrice: $('btc-price'),
    btcSub: $('btc-sub'),
    newsList: $('news-list'),
    btnRefresh: $('btn-refresh'),
    btnYoutube: $('btn-youtube'),
    dashboard: $('dashboard'),
    youtubeApp: $('youtube-app'),
  };

  let geo = { lat: null, lon: null, source: 'pending' };

  function fmtNum(n, digits = 0) {
    if (n == null || Number.isNaN(Number(n))) return '--';
    return Number(n).toLocaleString('th-TH', {
      maximumFractionDigits: digits,
      minimumFractionDigits: digits,
    });
  }

  function ageLabel(ms) {
    if (ms == null) return '';
    const m = Math.round(ms / 60000);
    if (m < 1) return 'เมื่อสักครู่';
    if (m < 60) return `${m} นาทีที่แล้ว`;
    return `${Math.round(m / 60)} ชม. ที่แล้ว`;
  }

  async function requestGeo() {
    if (!navigator.geolocation) {
      geo = { lat: null, lon: null, source: 'fallback' };
      return geo;
    }
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          geo = {
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            source: 'device',
          };
          resolve(geo);
        },
        () => {
          geo = { lat: null, lon: null, source: 'fallback' };
          resolve(geo);
        },
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
      );
    });
  }

  async function loadVehicle() {
    try {
      const res = await fetch('/api/vehicle');
      const json = await res.json();
      const d = json.data || {};
      if (!d.configured) {
        els.battery.textContent = '--';
        els.range.textContent = '--';
        els.meta.textContent = d.message || 'ยังไม่ได้ตั้งค่า Tesla API';
        return;
      }
      const snap = d.snapshot || {};
      els.battery.textContent = snap.batteryLevel != null ? String(snap.batteryLevel) : '--';
      const range = snap.estBatteryRangeKm ?? snap.batteryRangeKm;
      els.range.textContent = range != null ? fmtNum(range, 0) : '--';
      const stateTh =
        d.state === 'online' ? 'ออนไลน์' : d.state === 'asleep' ? 'หลับ (แคช)' : d.state || 'ไม่ทราบสถานะ';
      const src = d.usedLive ? 'ไลฟ์ (รถตื่นอยู่แล้ว)' : 'แคช — ไม่ปลุกเครื่อง';
      els.meta.textContent = `${d.displayName || 'Tesla'} · ${stateTh} · ${src}` +
        (d.ageMs != null ? ` · อัปเดต ${ageLabel(d.ageMs)}` : '') +
        (d.softLimited ? ' · จำกัดโควต้า' : '');
    } catch (err) {
      els.meta.textContent = `โหลดข้อมูลรถไม่สำเร็จ: ${err.message}`;
    }
  }

  async function loadWidgets() {
    const qs =
      geo.lat != null && geo.lon != null
        ? `?lat=${encodeURIComponent(geo.lat)}&lon=${encodeURIComponent(geo.lon)}`
        : '';
    try {
      const res = await fetch(`/api/widgets${qs}`);
      const json = await res.json();
      const pack = json.data || {};

      const weather = pack.weather?.ok ? pack.weather.data : null;
      if (weather) {
        els.weatherTemp.textContent = weather.tempC != null ? `${fmtNum(weather.tempC, 0)}°` : '--°';
        const where = weather.fallback ? `${weather.label} (ค่าเริ่มต้น)` : weather.label;
        els.weatherSub.textContent = `${weather.conditionTh || ''} · ${where}`;
      } else {
        els.weatherSub.textContent = pack.weather?.error || 'โหลดอากาศไม่สำเร็จ';
      }

      const gold = pack.gold?.ok ? pack.gold.data : null;
      if (gold) {
        const price = gold.sell ?? gold.buy;
        els.goldPrice.textContent = price != null ? fmtNum(price, 0) : '--';
        els.goldSub.textContent = `บาททอง · ซื้อ ${fmtNum(gold.buy, 0)} / ขาย ${fmtNum(gold.sell, 0)}`;
      } else {
        els.goldSub.textContent = pack.gold?.error || 'โหลดทองไม่สำเร็จ';
      }

      const btc = pack.btc?.ok ? pack.btc.data : null;
      if (btc) {
        els.btcPrice.textContent = btc.thb != null ? fmtNum(btc.thb, 0) : '--';
        const ch = btc.change24hPct != null ? ` · ${btc.change24hPct > 0 ? '+' : ''}${fmtNum(btc.change24hPct, 1)}%` : '';
        els.btcSub.textContent = `THB${ch}${btc.usd != null ? ` · $${fmtNum(btc.usd, 0)}` : ''}`;
      } else {
        els.btcSub.textContent = pack.btc?.error || 'โหลด BTC ไม่สำเร็จ';
      }

      const news = pack.news?.ok ? pack.news.data : null;
      els.newsList.innerHTML = '';
      if (news?.items?.length) {
        for (const item of news.items) {
          const li = document.createElement('li');
          if (item.link) {
            const a = document.createElement('a');
            a.href = item.link;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = item.title;
            li.appendChild(a);
          } else {
            li.textContent = item.title;
          }
          els.newsList.appendChild(li);
        }
      } else {
        const li = document.createElement('li');
        li.textContent = pack.news?.error || 'ไม่มีข่าว';
        els.newsList.appendChild(li);
      }
    } catch (err) {
      els.weatherSub.textContent = err.message;
    }
  }

  async function refreshAll() {
    els.meta.textContent = 'กำลังรีเฟรช…';
    await requestGeo();
    await Promise.all([loadVehicle(), loadWidgets()]);
  }

  els.btnRefresh.addEventListener('click', () => {
    refreshAll();
  });

  els.btnYoutube.addEventListener('click', () => {
    if (window.DriveHappyYouTube) window.DriveHappyYouTube.open();
  });

  // Poll our API (server TTL decides Tesla upstream)
  refreshAll();
  setInterval(loadVehicle, 90_000);
  setInterval(loadWidgets, 300_000);
})();
