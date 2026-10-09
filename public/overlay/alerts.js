'use strict';
// Pop-up alerts when a viewer makes or starts a server. Names go through a word filter (and ?names=0 hides them),
// so a rude username can't end up on stream.
(() => {
  const box = document.getElementById('alerts');
  const showNames = Overlay.params.get('names') !== '0';
  const sound = Overlay.params.get('sound') !== '0';
  const BAD = /(f+u+c+k|sh+i+t|b+i+t+c+h|c+u+n+t|d+i+c+k|p+u+s+s+y|a+s+s+h+o+l+e|n+i+g+|f+a+g+|r+e+t+a+r+d|s+e+x|p+o+r+n|n+a+z+i|k+i+l+l\s*y+o+u+r+s+e+l+f|kys)/i;
  const safe = (name, fallback) => {
    const n = String(name || '').trim();
    if (!showNames || !n || BAD.test(n.replace(/[^a-z]/gi, ''))) return fallback;
    return n;
  };
  const chime = () => {
    if (!sound) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [660, 880, 1320].forEach((f, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = f;
        o.type = 'sine';
        g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.09);
        g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + i * 0.09 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.09 + 0.35);
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + i * 0.09);
        o.stop(ctx.currentTime + i * 0.09 + 0.4);
      });
    } catch {}
  };
  const show = (icon, head, sub) => {
    const el = document.createElement('div');
    el.className = 'alert glass';
    const i = document.createElement('div');
    i.className = 'icon';
    i.textContent = icon;
    const t = document.createElement('div');
    const h = document.createElement('div');
    h.className = 'head';
    h.innerHTML = head; // built below from escaped parts only
    const s = document.createElement('div');
    s.className = 'sub';
    s.textContent = sub;
    t.append(h, s);
    el.append(i, t);
    box.prepend(el);
    chime();
    setTimeout(() => el.classList.add('out'), 7000);
    setTimeout(() => el.remove(), 7600);
    while (box.children.length > 4) box.lastChild.remove();
  };
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  Overlay.on((d) => {
    for (const e of d.feed) {
      const who = esc(safe(e.user, 'A viewer'));
      if (e.type === 'created') show('🎉', `<b>${who}</b> just made a server!`, `Join in: ${String(d.link || '').replace(/^https?:\/\//, '').split('/')[0]}`);
      else if (e.type === 'started') show('🟢', `<b>${who}</b>'s server is online`, `${d.running} test server${d.running === 1 ? '' : 's'} running now`);
      else if (e.type === 'reset') show('♻️', 'Fresh start: test servers were reset', 'Make a new one for free');
    }
  });

  // ?demo=1 shows a sample alert, to position the source in OBS.
  if (Overlay.params.get('demo') === '1') setTimeout(() => show('🎉', '<b>Steve</b> just made a server!', 'This is a sample alert'), 800);
})();
