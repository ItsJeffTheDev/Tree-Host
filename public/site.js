'use strict';
// Tree Host website: one header and footer for every public page, live plans, contact details and the animations.
(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const page = document.body.dataset.page || '';

  // ---------- header & footer ----------

  const NAV = [
    ['features', '/features', 'Features'],
    ['why', '/why', 'Why Tree Host'],
    ['servers', '/servers', 'Servers'],
    ['pricing', '/pricing', 'Pricing'],
    ['support', '/support', 'Support'],
    ['about', '/about', 'About'],
    ['donate', '/donate', 'Donate'],
  ];
  const header = document.getElementById('site-header');
  if (header) {
    header.className = 'site-header';
    header.innerHTML = `
      <div class="wrap nav">
        <a href="/" class="nav-brand"><img src="/brand/tree-host-icon.svg" alt="">Tree Host</a>
        <nav class="nav-links" id="nav-links">
          ${NAV.map(([id, href, label]) => `<a href="${href}" class="${page === id ? 'active' : ''}">${label}</a>`).join('')}
        </nav>
        <div class="nav-actions" id="nav-actions">
          <a href="/dashboard" class="btn-ghost btn-sm hide-sm">Sign in</a>
          <a href="/dashboard?signup" class="btn-cta btn-sm">Get started</a>
          <button class="nav-toggle" id="nav-toggle" aria-label="Menu"></button>
        </div>
      </div>`;
    document.getElementById('nav-toggle').addEventListener('click', () => document.getElementById('nav-links').classList.toggle('open'));
    const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 10);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  const footer = document.getElementById('site-footer');
  if (footer) {
    footer.className = 'site-footer';
    footer.innerHTML = `
      <div class="wrap">
        <div class="footer-grid">
          <div class="footer-brand">
            <a href="/" class="nav-brand"><img src="/brand/tree-host-icon.svg" alt="">Tree Host</a>
            <p>Minecraft server hosting that grows with you. Every server type and version, one-click plugins and automatic backups.</p>
          </div>
          <div class="footer-col"><h4>Product</h4>
            <a href="/features">Features</a><a href="/why">Why Tree Host</a><a href="/servers">Server list</a><a href="/pricing">Pricing</a><a href="/dashboard?signup">Create a server</a><a href="/dashboard">Dashboard</a></div>
          <div class="footer-col"><h4>Help</h4>
            <a href="/help.html">Guides</a><a href="/support">Contact &amp; FAQ</a><a href="/help.html?doc=billing">Billing help</a><span id="ft-discord"></span></div>
          <div class="footer-col"><h4>Company</h4>
            <a href="/about">About</a><a href="/team">Meet the team</a><a href="/donate">Donate</a><a href="/terms">Terms of Service</a><a href="/privacy">Privacy Policy</a><a href="/dmca">Copyright</a></div>
        </div>
        <div class="footer-bottom">
          <span>© ${new Date().getFullYear()} <span data-company>Tree Host</span>. All rights reserved.</span>
          <span>Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.</span>
        </div>
      </div>`;
  }

  // Signed in? Swap "Sign in / Get started" for the dashboard.
  fetch('/api/auth/me')
    .then((r) => r.json())
    .then((me) => {
      if (!me.user) return;
      const actions = document.getElementById('nav-actions');
      if (actions) {
        actions.innerHTML = `<a href="/dashboard" class="btn-cta btn-sm">Dashboard →</a><button class="nav-toggle" id="nav-toggle" aria-label="Menu"></button>`;
        document.getElementById('nav-toggle').addEventListener('click', () => document.getElementById('nav-links').classList.toggle('open'));
      }
      document.querySelectorAll('[data-signed-in-href]').forEach((a) => (a.href = a.dataset.signedInHref));
    })
    .catch(() => {});

  // ---------- business details ----------

  fetch('/api/site')
    .then((r) => r.json())
    .then((site) => {
      document.querySelectorAll('[data-company]').forEach((el) => (el.textContent = site.company));
      // data-email="" (support), "billing" or "promo": fills in the right inbox
      const inbox = { '': site.supportEmail, support: site.supportEmail, billing: site.billingEmail, promo: site.promoEmail, dmca: site.dmcaEmail };
      document.querySelectorAll('[data-email]').forEach((el) => {
        const addr = inbox[el.dataset.email] || site.supportEmail;
        if (addr) {
          el.textContent = addr;
          if (el.tagName === 'A') el.href = `mailto:${addr}`;
        }
      });
      if (site.discord) {
        const d = document.getElementById('ft-discord');
        if (d) d.innerHTML = `<a href="${esc(site.discord)}" target="_blank" rel="noopener">Discord</a>`;
        document.querySelectorAll('[data-discord]').forEach((el) => (el.href = site.discord));
        document.querySelectorAll('[data-discord-wrap]').forEach((el) => (el.hidden = false));
      }
      const fill = (key, value) => {
        if (!value) return;
        document.querySelectorAll(`[data-${key}]`).forEach((el) => (el.textContent = value));
        document.querySelectorAll(`[data-${key}-wrap]`).forEach((el) => (el.hidden = false));
      };
      fill('address', site.address);
      fill('cpu', site.cpu);
      fill('cpu-detail', site.cpuDetail);
      fill('hardware', site.hardware);
      if (site.cpu) document.querySelectorAll('[data-hw-wrap]').forEach((el) => (el.hidden = false));
      window.TH_CPU = site.cpu;
      const article = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a');
      document.querySelectorAll('[data-plan-cpu]').forEach((el) => (el.textContent = site.cpu ? ` on ${article(site.cpu)} ${site.cpu}` : ''));
      fill('dmca-agent', site.dmcaAgent);
      if (site.jurisdiction) document.querySelectorAll('[data-jurisdiction]').forEach((el) => (el.textContent = site.jurisdiction));
      else document.querySelectorAll('[data-jurisdiction-text]').forEach((el) => el.remove());
      if (!site.allowSignup) document.querySelectorAll('a[href="/dashboard?signup"]').forEach((a) => (a.textContent = 'Sign-ups closed'));
    })
    .catch(() => {});

  // ---------- plans ----------

  function money(cents, currency) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
    } catch {
      return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
    }
  }
  const plansEl = document.getElementById('plans');
  if (plansEl || document.getElementById('hero-price')) {
    fetch('/api/plans')
      .then((r) => r.json())
      .then((data) => {
        const all = data.plans || [];
        const plans = all.filter((p) => !p.oneTime);
        const lifetime = all.filter((p) => p.oneTime);
        const cheapest = plans.filter((p) => !p.soldOut).sort((a, b) => a.priceCents - b.priceCents)[0];
        const hp = document.getElementById('hero-price');
        if (hp && cheapest) hp.textContent = `From ${money(cheapest.priceCents, data.currency)}/month`;
        if (!plansEl) return;
        if (!all.length) {
          plansEl.innerHTML = '<div class="loading">Plans are coming soon.</div>';
          return;
        }
        const popular = plans.length >= 3 ? plans[1].id : null;
        plansEl.innerHTML = plans
          .map(
            (p, i) => `<div class="plan reveal d${i + 1} ${p.id === popular ? 'popular' : ''} ${p.soldOut ? 'sold-out' : ''}">
              ${p.id === popular ? '<div class="tag">Most popular</div>' : ''}
              <h3>${esc(p.name)}</h3>
              <div class="price">${money(p.priceCents, data.currency)}<span>/month</span></div>
              <ul>
                <li><b>${+(p.ramMb / 1024).toFixed(1)} GB</b> RAM</li>
                <li><b>${p.cpus}</b> CPU core${p.cpus === 1 ? '' : 's'}<small class="plan-cpu" data-plan-cpu>${window.TH_CPU ? ` on ${/^[aeiou]/i.test(window.TH_CPU) ? 'an' : 'a'} ${esc(window.TH_CPU)}` : ''}</small></li>
                <li><b>${p.diskGb} GB</b> NVMe disk</li>
                <li><b>Unlimited</b> servers</li>
                <li>Plugins, mods &amp; backups</li>
              </ul>
              <p>${esc(p.description)}</p>
              ${p.soldOut ? '<span class="btn-ghost block disabled">Sold out</span>' : `<a href="/dashboard?signup" class="${p.id === popular ? 'btn-cta' : 'btn-ghost'} block">Choose ${esc(p.name)}</a>`}
            </div>`,
          )
          .join('') + lifetime
          .map(
            (p) => `<div class="plan lifetime reveal">
              <div class="tag">${ic('infinity')} Pay once, keep forever</div>
              <div class="lifetime-body">
                <div>
                  <h3>${esc(p.name)}</h3>
                  <div class="price">${money(p.priceCents, data.currency)}<span> once</span></div>
                  <p>${esc(p.description)}</p>
                  ${p.soldOut ? '<span class="btn-ghost block disabled">Sold out</span>' : `<a href="/dashboard?signup" class="btn-cta block">Get ${esc(p.name)}</a>`}
                </div>
                <ul>
                  <li><b>${p.slots ? p.slots.servers : 0} servers</b> of any type and version</li>
                  <li><b>${+(p.ramMb / 1024).toFixed(1)} GB</b> RAM, ${p.cpus} CPU cores, ${p.diskGb} GB disk each</li>
                  <li><b>${p.slots ? p.slots.proxies : 0} proxies</b> (Velocity, BungeeCord, Waterfall)</li>
                  ${p.prioritySupport ? '<li><b>Priority support</b></li>' : ''}
                  <li>No monthly bills, ever</li>
                </ul>
              </div>
            </div>`,
          )
          .join('');
        observe(plansEl.querySelectorAll('.reveal'));
      })
      .catch(() => plansEl && (plansEl.innerHTML = '<div class="loading">Could not load plans. Please refresh.</div>'));
  }

  // ---------- scroll reveal ----------

  const io = 'IntersectionObserver' in window && !reduceMotion
    ? new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) {
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' })
    : null;
  function observe(list) {
    for (const el of list) io ? io.observe(el) : el.classList.add('in');
  }
  observe(document.querySelectorAll('.reveal, .steps'));

  // ---------- hero: rotating words and falling leaves ----------

  const rot = document.querySelector('.rotate[data-words]');
  if (rot && !reduceMotion) {
    const words = rot.dataset.words.split(',');
    let i = 0;
    setInterval(() => {
      rot.classList.remove('in');
      rot.classList.add('out');
      setTimeout(() => {
        i = (i + 1) % words.length;
        rot.textContent = words[i];
        rot.classList.remove('out');
        rot.classList.add('in');
      }, 340);
    }, 2600);
  }
  const leaves = document.querySelector('.leaves');
  if (leaves && !reduceMotion) {
    for (let n = 0; n < 14; n++) {
      const l = document.createElement('i');
      const size = 8 + Math.random() * 10;
      Object.assign(l.style, {
        left: `${Math.random() * 100}%`,
        width: `${size}px`,
        height: `${size}px`,
        animationDuration: `${12 + Math.random() * 14}s`,
        animationDelay: `${-Math.random() * 20}s`,
        opacity: (0.15 + Math.random() * 0.3).toFixed(2),
      });
      leaves.appendChild(l);
    }
  }

  // ---------- console typing demo ----------

  const consoleEl = document.getElementById('console-demo');
  if (consoleEl) {
    const lines = [
      ['', '[Tree Host] Installing Paper 26.2...'],
      ['', '[Tree Host] Starting in an isolated container (4096 MB)'],
      ['', '[Server] Preparing level "world"'],
      ['g', '[Server] Done (12.4s)! For help, type "help"'],
      ['', '[Server] Steve joined the game'],
      ['', '> op Steve'],
      ['', '[Server] Made Steve a server operator'],
      ['g', '[Tree Host] Installed LuckPerms v5.5 from Modrinth'],
      ['g', '[Tree Host] Automatic backup made (212 MB)'],
      ['y', '[Server] Alex joined the game'],
    ];
    let started = false;
    const run = async () => {
      if (started) return;
      started = true;
      const body = consoleEl.querySelector('.console-body');
      for (;;) {
        body.innerHTML = '';
        for (const [cls, text] of lines) {
          const div = document.createElement('div');
          if (cls) div.className = cls;
          body.appendChild(div);
          if (reduceMotion) {
            div.textContent = text;
            continue;
          }
          div.classList.add('c');
          for (let k = 1; k <= text.length; k += 2) {
            div.textContent = text.slice(0, k);
            await new Promise((r) => setTimeout(r, 14));
          }
          div.textContent = text;
          div.classList.remove('c');
          await new Promise((r) => setTimeout(r, 380));
        }
        if (reduceMotion) return;
        await new Promise((r) => setTimeout(r, 4000));
      }
    };
    if (io) new IntersectionObserver((e, o) => e[0].isIntersecting && (run(), o.disconnect()), { threshold: 0.3 }).observe(consoleEl);
    else run();
  }

  // ---------- product video ----------

  const heroVideo = document.querySelector('video[data-autoplay]');
  if (heroVideo) {
    if (reduceMotion) heroVideo.removeAttribute('autoplay');
    else heroVideo.play().catch(() => {});
  }
  document.querySelectorAll('[data-tour]').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const m = document.createElement('div');
      m.className = 'vmodal';
      m.innerHTML = `<button aria-label="Close">×</button>
        <video controls autoplay playsinline poster="/media/tree-host-tour.jpg">
          <source src="/media/tree-host-tour.mp4" type="video/mp4"><source src="/media/tree-host-tour.webm" type="video/webm"></video>`;
      const close = () => {
        m.remove();
        document.removeEventListener('keydown', key);
      };
      const key = (ev) => ev.key === 'Escape' && close();
      m.addEventListener('click', (ev) => (ev.target === m || ev.target.tagName === 'BUTTON') && close());
      document.addEventListener('keydown', key);
      document.body.appendChild(m);
    }),
  );
})();
