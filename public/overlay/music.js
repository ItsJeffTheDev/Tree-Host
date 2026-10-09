'use strict';
// "Now playing" card for the Tree Host stream music player (promo/stream-music/Play-Stream-Music.bat). The player
// writes /overlay/now-playing.json whenever something changes; this reads it every second. Each track has its own
// look, and the equalizer moves at the track's tempo. Hidden while paused or when the player is closed.
(() => {
  const THEMES = {
    dawn: { emoji: '🌅', desc: 'Mellow lo-fi · 80 bpm', a: '#ff9a76', b: '#ffcf71', bpm: 80 },
    chillhop: { emoji: '☕', desc: 'Jazzy and relaxed · 88 bpm', a: '#c49a6c', b: '#f0d3a8', bpm: 88 },
    warm: { emoji: '🌻', desc: 'Hopeful piano · 92 bpm', a: '#ffd166', b: '#f6a04d', bpm: 92 },
    pluck: { emoji: '⚡', desc: 'Upbeat synth · 112 bpm', a: '#5ee7ff', b: '#7cb7ff', bpm: 112 },
    tension: { emoji: '🌌', desc: 'Ambient and serious · 72 bpm', a: '#b388ff', b: '#7c4dff', bpm: 72 },
  };
  const FALLBACK = { emoji: '🎵', desc: 'Stream music', a: '#46c37b', b: '#7beaa6', bpm: 90 };
  const $ = (id) => document.getElementById(id);
  const card = $('np');
  let state = null;
  let shownChange = null;

  const mmss = (s) => {
    s = Math.max(0, Math.floor(s));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  function apply(d) {
    const t = THEMES[d.key] || FALLBACK;
    const swap = () => {
      card.style.setProperty('--np-a', t.a);
      card.style.setProperty('--np-b', t.b);
      card.style.setProperty('--np-beat', `${(60 / t.bpm).toFixed(3)}s`);
      $('emoji').textContent = t.emoji;
      $('title').textContent = d.title || 'Tree Host';
      $('desc').textContent = d.loop ? `${t.desc} · on repeat` : t.desc;
    };
    if (shownChange !== null && shownChange !== d.changed && !card.classList.contains('np-out')) {
      // A new song: flip the card over to it.
      card.classList.remove('np-swap');
      void card.offsetWidth;
      card.classList.add('np-swap');
      setTimeout(swap, 300);
    } else swap();
    shownChange = d.changed;
  }

  async function poll() {
    try {
      const r = await fetch(`/overlay/now-playing.json?t=${Date.now()}`, { cache: 'no-store' });
      const d = r.ok ? await r.json() : null;
      // Not updated for a long time while "playing" means the player was closed without saying so.
      const stale = d && d.playing && d.duration && Date.now() - d.at > (d.duration + 30) * 1000;
      if (d && d.playing && d.key && !stale) {
        if (!state || state.changed !== d.changed || state.loop !== d.loop || state.title !== d.title) apply(d);
        state = d;
        card.classList.remove('np-out');
      } else {
        state = d && d.key ? d : null;
        card.classList.add('np-out');
      }
    } catch {
      card.classList.add('np-out');
    }
    setTimeout(poll, 1000);
  }

  // Progress between polls.
  setInterval(() => {
    if (!state || !state.playing || !state.duration) return;
    const at = (state.position + (Date.now() - state.at) / 1000) % state.duration;
    $('pos').textContent = mmss(at);
    $('dur').textContent = mmss(state.duration);
    $('fill').style.width = `${(at / state.duration) * 100}%`;
  }, 250);

  // ?demo=1 cycles through every track, to place the source in OBS without the player running.
  if (new URLSearchParams(location.search).get('demo') === '1') {
    const keys = Object.keys(THEMES);
    let i = 0;
    const step = () => {
      const k = keys[i++ % keys.length];
      const d = { playing: true, key: k, title: { dawn: 'Dawn (lo-fi)', chillhop: 'Chillhop', warm: 'Warm', pluck: 'Pluck (upbeat)', tension: 'Tension (ambient)' }[k], duration: 600, position: 95, at: Date.now(), loop: false, changed: Date.now() };
      apply(d);
      state = d;
      card.classList.remove('np-out');
    };
    step();
    setInterval(step, 5000);
    return;
  }
  poll();
})();
