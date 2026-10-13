'use strict';
// Tree Host website: one header and footer for every public page, live plans, contact details and the animations.
(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  window.esc = esc;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const page = document.body.dataset.page || '';

  // ---------- shared animation helpers ----------
  // countUp: 0 → value with an ease-out over ~1.2s, gated on the element actually being
  // in view (the social strip on the homepage, the traction numbers on /investors, the
  // donate figures). Under reduced motion it jumps straight to the final value.
  // Pages without site.js helpers fall back to instant text (see donate.html).
  const easeOut = (p) => 1 - Math.pow(1 - p, 3);
  const countUp = (el, to, fmt = (v) => String(v), dur = 1200) => {
    const done = () => { el.textContent = fmt(to); };
    if (reduceMotion || !Number.isFinite(to)) return done();
    const run = () => {
      const t0 = performance.now();
      const tick = (t) => {
        const p = Math.min(1, (t - t0) / dur);
        el.textContent = fmt(p < 1 ? Math.round(to * easeOut(p)) : to);
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    if ('IntersectionObserver' in window) {
      const cio = new IntersectionObserver((es, o) => {
        if (es.some((e) => e.isIntersecting)) { o.disconnect(); run(); }
      }, { threshold: 0.4 });
      cio.observe(el);
    } else run();
  };
  window.TH_COUNT_UP = countUp;
  // TH_REVEAL_BAR: run set() the first time the bar scrolls into view (donate page's
  // founding progress bar animates when seen, not on load). Reduced motion: immediate.
  window.TH_REVEAL_BAR = (el, set) => {
    if (reduceMotion || !('IntersectionObserver' in window)) return set();
    const bio = new IntersectionObserver((es, o) => {
      if (es.some((e) => e.isIntersecting)) { o.disconnect(); requestAnimationFrame(set); }
    }, { threshold: 0.4 });
    bio.observe(el);
  };
  // stagger: index-based transition-delay for reveal siblings in a grid (capped at
  // 420ms), cleared again once the element has revealed so hover transforms stay snappy.
  const stagger = (els) => {
    if (!io) return;
    [...els].forEach((el, i) => {
      el.style.transitionDelay = `${Math.min(i * 70, 420)}ms`;
      el.addEventListener('transitionend', () => { el.style.transitionDelay = ''; }, { once: true });
    });
  };

  // ---------- header & footer ----------

  const NAV = [
    ['features', '/features', 'Features'],
    ['why', '/why', 'Why Tree Host'],
    ['servers', '/servers', 'Servers'],
    ['pricing', '/pricing', 'Pricing'],
    ['creators', '/creators', 'Creators'],
    ['support', '/support', 'Support'],
    ['about', '/about', 'About'],
    ['investors', '/investors', 'Invest'],
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
            <a href="/about">About</a><a href="/creators">Creators</a><a href="/team">Meet the team</a><a href="/donate">Donate</a><a href="/investors">Invest</a><a href="/terms">Terms of Service</a><a href="/privacy">Privacy Policy</a><a href="/dmca">Copyright</a></div>
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

  // ---------- attribution: ?ref= capture + page-view beacon ----------
  // Session-scoped marker only (sessionStorage, dies with the tab — never a cookie). The
  // ref value is NOT validated here: creator codes are not known client-side, so any
  // non-empty value is passed through (uppercased) and the server's refValue() — with the
  // creator registry — is the single enforcement point. Nothing is stored when absent.

  const refFromUrl = () => {
    const raw = new URLSearchParams(location.search).get('ref');
    if (!raw) return null;
    const v = String(raw).trim().toUpperCase();
    return v || null;
  };
  try {
    const ref = refFromUrl();
    if (ref) sessionStorage.setItem('th_ref', ref);
  } catch {}

  // The server already counted this page view in serveStatic(); the beacon only carries
  // attribution (referrer host + ref) and is deduped server-side. Fire-and-forget: it must
  // never delay or break the page.
  fetch('/api/metrics/event', {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'pageview',
      path: location.pathname,
      referrerHost: (() => { try { return new URL(document.referrer).host || null; } catch { return null; } })(),
      ref: (() => { try { return sessionStorage.getItem('th_ref'); } catch { return null; } })(),
    }),
  }).catch(() => {});

  // ---------- social-proof strip (homepage only) ----------
  // Honest numbers from GET /api/metrics/social, used exactly as returned (already
  // rounded server-side). On ANY error the strip stays hidden — it must never break
  // the page or show made-up numbers.
  const strip = document.getElementById('social-strip');
  if (strip) {
    fetch('/api/metrics/social')
      .then((r) => { if (!r.ok) throw new Error('social ' + r.status); return r.json(); })
      .then((m) => {
        if (!m || typeof m !== 'object') throw new Error('bad social payload');
        let filled = 0;
        strip.querySelectorAll('[data-social]').forEach((el) => {
          const v = m[el.dataset.social];
          if (typeof v === 'number' && Number.isFinite(v)) { countUp(el, v); filled++; }
        });
        if (filled) {
          strip.hidden = false;
          requestAnimationFrame(() => strip.classList.add('in'));
        }
      })
      .catch(() => {}); // strip stays hidden
  }

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
        window.TH_DISCORD = site.discord; // pages without data-discord markup (donate founding card footer)
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
        // Pricing page: the plans failed → bring the static guide cards back as fallback.
        const guide = document.getElementById('plan-guide');
        if (!all.length) {
          plansEl.innerHTML = '<div class="loading">Plans are coming soon.</div>';
          if (guide) guide.hidden = false;
          return;
        }
        const popular = plans.length >= 3 ? plans[1].id : null;
        plansEl.innerHTML = plans
          .map(
            (p, i) => `<div class="plan reveal d${i + 1} ${p.id === popular ? 'popular' : ''} ${p.soldOut ? 'sold-out' : ''}" data-ram-mb="${p.ramMb}" data-plan-id="${esc(p.id)}">
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
      .catch(() => {
        if (plansEl) plansEl.innerHTML = '<div class="loading">Could not load plans. Please refresh.</div>';
        // Pricing page: plans failed → the static guide cards come back as the fallback.
        const guide = document.getElementById('plan-guide');
        if (guide) guide.hidden = false;
      });
  }

  // ---------- pricing recommender (pricing page only) ----------

  const recoEl = document.getElementById('recommender');
  if (recoEl && page === 'pricing') {
    const answers = { players: null, workload: null };
    const sub = document.getElementById('reco-sub');
    const hint = document.getElementById('reco-hint');
    // Recommendation in RAM terms: friends→2 GB, 5–20→4 GB, big→8 GB. A modpack
    // bumps one tier minimum — its floor is Oak's 4 GB (a modpack on a friends-size
    // server moves up from Sapling; 5–20 players is already Oak; a big community
    // stays Redwood). Pure RAM math, so it also matches custom plan sets — the
    // match is by ramMb.
    const needMb = (players, workload) => {
      const base = { friends: 2048, mid: 4096, big: 8192 }[players];
      return workload === 'modpack' ? Math.max(base, 4096) : base;
    };
    recoEl.hidden = false;
    // The static three-card guide below is the no-JS fallback: once the
    // recommender is live it takes over (the plans-API failure path un-hides it).
    const guide = document.getElementById('plan-guide');
    if (guide) guide.hidden = true;
    recoEl.querySelectorAll('.reco-opt').forEach((btn) =>
      btn.addEventListener('click', () => {
        answers[btn.dataset.q] = btn.dataset.v;
        recoEl.querySelectorAll(`.reco-opt[data-q="${btn.dataset.q}"]`).forEach((b) => {
          b.classList.toggle('picked', b === btn);
          b.setAttribute('aria-pressed', String(b === btn));
        });
        const both = answers.players && answers.workload;
        const needed = both ? needMb(answers.players, answers.workload) : null;
        const show = () => {
          // Exactly one card lights up: the smallest available plan whose memory
          // covers the answer (a modpack bumps one tier minimum via needMb).
          const candidates = [...document.querySelectorAll('#plans .plan')]
            .filter((el) => Number(el.dataset.ramMb) >= needed && !el.classList.contains('sold-out'))
            .sort((a, b) => Number(a.dataset.ramMb) - Number(b.dataset.ramMb));
          const target = both ? candidates[0] : null;
          document.querySelectorAll('#plans .plan').forEach((el) => {
            const hit = el === target;
            el.classList.toggle('recommended', hit);
            el.querySelectorAll('.reco-tag').forEach((t) => t.remove());
            if (hit) el.querySelector('h3').insertAdjacentHTML('beforebegin', '<div class="tag reco-tag">Recommended for you</div>');
          });
          if (target) {
            hint.textContent = `Recommended: ${target.querySelector('h3').textContent} — highlighted in the grid below.`;
            hint.hidden = false;
          } else {
            hint.hidden = true;
          }
        };
        show();
        if (both) {
          const bits = [];
          if (answers.players === 'friends') bits.push('a few friends');
          if (answers.players === 'mid') bits.push('5–20 players');
          if (answers.players === 'big') bits.push('a big community');
          bits.push(answers.workload === 'modpack' ? 'a modpack' : 'vanilla / plugins');
          sub.textContent = bits.join(' · ');
          sub.hidden = false;
        } else {
          sub.hidden = true;
          hint.hidden = true;
        }
      }),
    );
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
  // Automatic stagger inside the card grids (why-grid, plans, the feature grid): each
  // sibling gets a slightly longer transition-delay, capped at 420ms.
  for (const grid of document.querySelectorAll('.why-grid, .plans, .grid')) stagger(grid.querySelectorAll(':scope > .reveal'));

  // ---------- hero: load-in, rotating words and falling leaves ----------

  // One-time fade/rise of the hero columns once the page has settled. Only on the
  // homepage hero (a .hero section with a .hero-grid inside); reduced motion skips it.
  const hero = document.querySelector('.hero .hero-grid')?.closest('.hero');
  if (hero) {
    if (!reduceMotion) {
      // Hide first (double rAF so the hidden style is committed), then reveal.
      requestAnimationFrame(() => {
        hero.classList.add('hero-anim');
        requestAnimationFrame(() => requestAnimationFrame(() => hero.classList.add('ready')));
      });
    } else hero.classList.add('hero-anim', 'ready');
  }

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

  // ---------- donate page: Founding Lifetime card (TASK-004-008) ----------
  // State comes from GET /api/plans (the founding row), never /api/donations. On any
  // failure the card markup in donate.html simply stays hidden. The CTA is
  // context-aware: signed in → POST /api/billing/checkout with the same consent the
  // dashboard's checkout collects; signed out → the signup handoff
  // (/dashboard?signup&plan=founding-lifetime, per plan D10 / GAP-3).
  if (page === 'donate' && !document.getElementById('founding-card')) {
    const fc = document.createElement('div');
    fc.className = 'card fund-card founding-card reveal';
    fc.id = 'founding-card';
    fc.hidden = true;
    fc.innerHTML = `
      <span class="founding-tag">FOUNDING PRE-SALE</span>
      <div class="founding-head"><h3>Founding Lifetime</h3><div class="founding-price"><b>$199</b><span> once</span></div></div>
      <p class="muted small" style="margin:0 0 10px">Everything in the Lifetime plan, at the founding price. Pay once, keep it forever.</p>
      <ul class="founding-perks">
        <li><b>4 servers</b> of any type and version (4 GB each)</li>
        <li><b>2 proxies</b> (Velocity, BungeeCord, Waterfall)</li>
        <li><b>Priority support</b></li>
        <li><b>FOUNDER</b> in-game badge on every Tree Host server</li>
      </ul>
      <div class="fund-bar founding-bar" role="progressbar" aria-label="Founding spots claimed" aria-valuemin="0" aria-valuemax="25"><div class="founding-fill"></div></div>
      <p class="muted small" data-founding-count style="margin:6px 0 12px"></p>
      <button type="button" class="btn-cta block" data-founding-cta>Get Founding Lifetime — $199</button>
      <p class="muted small" data-founding-foot style="margin:10px 0 0" hidden></p>`;
    const fundCard = document.getElementById('fund');
    if (fundCard && fundCard.parentNode) fundCard.parentNode.insertBefore(fc, fundCard);
  }

  // ---------- product video ----------

  // The demo CTA gets a gentle attention pulse (CSS .btn-pulse); after the visitor has
  // hovered it once it stops for good (.seen), and reduced motion never starts it.
  const demoCta = document.querySelector('.hero-cta a[href*="demo=1"]');
  if (demoCta && !reduceMotion) {
    demoCta.classList.add('btn-pulse');
    demoCta.addEventListener('mouseenter', () => demoCta.classList.add('seen'), { once: true });
    demoCta.addEventListener('focus', () => demoCta.classList.add('seen'), { once: true });
  }

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
