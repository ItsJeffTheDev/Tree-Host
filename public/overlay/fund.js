'use strict';
// Launch fund overlay: the goal bar from /api/overlay/fund (this PC only), and a pop-up for each new public backer with
// their tier badge. Names go through a word filter, like the alerts overlay.
(() => {
  const LOGO = '<svg class="logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="29" y="30" width="6" height="26" rx="2" fill="#2c9a5c"/><g fill="#46c37b"><circle cx="32" cy="23" r="16"/><circle cx="20" cy="31" r="11"/><circle cx="44" cy="31" r="11"/><rect x="20" y="29" width="24" height="12" rx="6"/></g><g fill="#0f1712"><rect x="22" y="20" width="20" height="5" rx="2"/><rect x="29.5" y="20" width="5" height="18" rx="2"/></g></svg>';
  document.querySelectorAll('[data-logo]').forEach((el) => (el.innerHTML = LOGO));
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const BADGE = { supporter: '♥ SUPPORTER', founder: '★ FOUNDER', legend: '✦ LEGEND' };
  const BAD = /(f+u+c+k|sh+i+t|b+i+t+c+h|c+u+n+t|d+i+c+k|p+u+s+s+y|n+i+g+|f+a+g+|r+e+t+a+r+d|p+o+r+n|n+a+z+i)/i;
  const money = (c) => `$${(c / 100).toLocaleString('en-US', { maximumFractionDigits: c % 100 ? 2 : 0 })}`;
  let lastAt = null;
  const queue = [];
  let showing = false;

  const popNext = () => {
    if (showing || !queue.length) return;
    showing = true;
    const s = queue.shift();
    const name = !s.name || BAD.test(String(s.name).replace(/[^a-z]/gi, '')) ? 'Someone' : s.name;
    $('backer-h').innerHTML = '';
    const b = document.createElement('b');
    b.textContent = name;
    $('backer-h').append(b, document.createTextNode(' just became a '));
    const t = document.createElement('span');
    t.className = `t-${s.tier || 'supporter'}`;
    t.textContent = BADGE[s.tier] || BADGE.supporter;
    $('backer-h').append(t, document.createTextNode('!'));
    $('backer-s').textContent = s.message ? `“${String(s.message).slice(0, 80)}”` : 'Thank you for backing Tree Host 💚';
    const el = $('backer');
    el.classList.remove('hidden', 'out');
    void el.offsetWidth;
    el.classList.add('in');
    setTimeout(() => el.classList.add('out'), 7000);
    setTimeout(() => {
      el.classList.add('hidden');
      el.classList.remove('in', 'out');
      showing = false;
      popNext();
    }, 7600);
  };

  const draw = (d) => {
    $('title').textContent = d.title || 'Launch fund';
    $('raised').textContent = money(d.raisedCents || 0);
    $('target').textContent = d.targetCents ? ` of ${money(d.targetCents)}` : ' raised';
    $('count').textContent = d.count ? `${d.count} supporter${d.count === 1 ? '' : 's'}` : '';
    const pct = d.targetCents ? Math.min(100, (d.raisedCents / d.targetCents) * 100) : 0;
    $('fill').style.width = `${Math.max(pct, d.raisedCents ? 2 : 0)}%`;
    const sup = d.supporters || [];
    const newest = sup.length ? Math.max(...sup.map((s) => s.at || 0)) : 0;
    if (lastAt !== null) for (const s of sup.filter((x) => (x.at || 0) > lastAt).sort((a, b) => a.at - b.at)) queue.push(s);
    lastAt = Math.max(lastAt || 0, newest);
    popNext();
  };

  if (params.get('demo') === '1') {
    draw({ title: 'Launch fund', raisedCents: 18500, targetCents: 60000, count: 14, supporters: [] });
    setTimeout(() => { queue.push({ name: 'Steve', tier: 'founder', message: 'Can\'t wait for launch!' }); popNext(); }, 800);
    return;
  }
  const poll = async () => {
    try {
      const r = await fetch('/api/overlay/fund', { cache: 'no-store' });
      if (r.ok) draw(await r.json());
    } catch {}
    setTimeout(poll, 10000);
  };
  poll();
})();
