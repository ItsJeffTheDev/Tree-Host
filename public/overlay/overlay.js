'use strict';
// Shared code for the stream overlays: reads /api/overlay (it only answers OBS on the PC that runs Tree Host) every few
// seconds and fills in [data-o] elements. Pages add their own behavior with Overlay.on(fn).
const Overlay = (() => {
  const LOGO = '<svg class="logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="29" y="30" width="6" height="26" rx="2" fill="#2c9a5c"/><g fill="#46c37b"><circle cx="32" cy="23" r="16"/><circle cx="20" cy="31" r="11"/><circle cx="44" cy="31" r="11"/><rect x="20" y="29" width="24" height="12" rx="6"/></g><g fill="#0f1712"><rect x="22" y="20" width="20" height="5" rx="2"/><rect x="29.5" y="20" width="5" height="18" rx="2"/></g></svg>';
  const params = new URLSearchParams(location.search);
  const listeners = [];
  let last = null;
  let lastQrFor = '';

  const short = (url) => String(url || '').replace(/^https?:\/\//, '');
  const left = (at) => {
    const ms = Math.max(0, at - Date.now());
    const d = Math.floor(ms / 86400000);
    const h = Math.floor((ms % 86400000) / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m ${String(s).padStart(2, '0')}s`;
  };

  function fill(d) {
    const set = (key, value) => document.querySelectorAll(`[data-o="${key}"]`).forEach((el) => (el.textContent = value));
    set('servers', d.servers);
    set('running', d.running);
    set('players', d.players);
    set('link', params.get('link') || short(d.link) || 'Link coming soon');
    if (d.testSite) {
      set('reset', left(d.testSite.nextResetAt));
      set('hours', d.testSite.resetHours);
    }
    const qrFor = params.get('link') ? `https://${params.get('link').replace(/^https?:\/\//, '')}` : d.link;
    if (qrFor && qrFor !== lastQrFor && typeof QR !== 'undefined') {
      lastQrFor = qrFor;
      document.querySelectorAll('[data-o="qr"]').forEach((el) => (el.innerHTML = QR.svg(qrFor, Number(el.dataset.size) || 140)));
    }
  }

  async function poll() {
    try {
      const since = last ? last.seq : 0;
      const r = await fetch(`/api/overlay?since=${since}`, { cache: 'no-store' });
      if (r.ok) {
        const d = await r.json();
        const first = !last;
        last = d;
        fill(d);
        // Alerts only for what happens after the overlay opened (not the history).
        if (!first) for (const fn of listeners) fn(d);
      }
    } catch {}
    setTimeout(poll, 3000);
  }

  // The reset countdown ticks every second between polls.
  setInterval(() => last && fill(last), 1000);
  document.querySelectorAll('[data-logo]').forEach((el) => (el.innerHTML = LOGO));
  poll();
  return { on: (fn) => listeners.push(fn), params, LOGO };
})();
