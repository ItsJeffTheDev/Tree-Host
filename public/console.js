'use strict';
// Staff Console (/admin): a full-page view for Owners, Admins, Developers and Support. Every section is shown only
// if your role has the permission it needs (the server checks the same permissions on every request: src/rbac.js).
// Loaded before app.js; app.js calls initConsole() when the page is /admin. Uses app.js and team.js helpers.

const CONSOLE_SECTIONS = [
  { id: 'overview', icon: 'chart', label: 'Overview', perm: 'console.access', render: consoleOverview },
  { id: 'servers', icon: 'server', label: 'Servers', perm: 'servers.viewAll', render: consoleServers },
  { id: 'chat', icon: 'chat', label: 'Support chat', perm: 'support.chat', render: (b, sub) => consoleSupportChat(b, sub) },
  { id: 'people', icon: 'users', label: 'People', perm: 'users.view', render: (b) => adminPeople(b) },
  { id: 'billing', icon: 'card', label: 'Billing', perm: 'billing.view', render: (b) => adminBilling(b) },
  { id: 'plans', icon: 'box', label: 'Plans', perm: 'billing.manage', render: (b) => adminPlans(b) },
  { id: 'promos', icon: 'ticket', label: 'Promo codes', perm: 'promos.manage', render: (b) => adminPromos(b) },
  { id: 'actions', icon: 'scroll', label: 'Action logs', perm: 'moderation.view', render: (b, sub) => consoleActions(b, sub) },
  { id: 'roles', icon: 'key', label: 'Roles & permissions', perm: 'console.access', render: consoleRoles },
  { id: 'audit', icon: 'receipt', label: 'Audit log', perm: 'audit.view', render: consoleAudit },
  { id: 'system', icon: 'gear', label: 'System', perm: 'system.view', render: consoleSystem },
  { id: 'settings', icon: 'sliders', label: 'Settings', perm: 'settings.manage', render: (b) => adminSettings(b) },
  { id: 'staff-plugin', icon: 'puzzle', label: 'Managed Plugins', perm: 'system.view', render: consoleStaffPlugin },
];

// Helper functions
function fmtSize(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}

// Define esc helper if not already defined (loaded before app.js)
if (typeof esc === 'undefined') {
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  window.esc = esc;
}

// Define $ and $$ helpers if not already defined (loaded before app.js)
if (typeof $ === 'undefined') {
  const $ = (sel, el = document) => el.querySelector(sel);
  window.$ = $;
}
if (typeof $$ === 'undefined') {
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  window.$$ = $$;
}

function initConsole() {
  document.title = 'Staff Console · Tree Host';
  const side = $('.sidebar');
  if (isTeam() && state.me.user && state.me.user.needs2fa) {
    // Staff must turn on two-factor sign-in before the Staff Console opens (src/server.js: STAFF_2FA).
    $('#main').innerHTML = `<div class="card stack" style="max-width:620px;margin:60px auto">
      <h2>${ic('lock')} Turn on two-factor sign-in</h2>
      <p class="muted" style="margin:0">Staff accounts can see customers' details and act on their servers, so the Staff Console needs
      two-factor sign-in: a 6-digit code from an authenticator app each time you sign in. It takes a minute.</p>
      <div class="card stack" id="acc-2fa"></div>
      <a class="help-link" href="/dashboard">← Back to dashboard</a></div>`;
    side.classList.add('hidden');
    renderTwoFactorCard($('#acc-2fa'));
    return;
  }
  if (!isTeam() || !hasPerm('console.access')) {
    $('#main').innerHTML = `<div class="card stack" style="max-width:520px;margin:60px auto">
      <h2>Staff Console</h2>
      <p class="muted" style="margin:0">Your account doesn't have access to the Staff Console.</p>
      <a class="btn primary" href="/dashboard">Back to your dashboard</a></div>`;
    side.classList.add('hidden');
    return;
  }
  const sections = CONSOLE_SECTIONS.filter((s) => hasPerm(s.perm));
  side.innerHTML = `
    <a href="/" class="brand" style="text-decoration:none;color:inherit"><div class="logo"></div><div><div class="brand-name">Tree Host</div><div class="brand-sub">Staff Console</div></div></a>
    <button class="sn-bell" id="sn-bell" type="button">${ic('bell')} Notifications<span class="nav-count hidden" id="sn-count"></span></button>
    <nav class="console-nav">${sections.map((s) => `<a href="#${s.id}" data-sec="${s.id}">${ic(s.icon)} ${s.label}</a>`).join('')}</nav>
    <a class="help-link" href="/dashboard">← Back to dashboard</a>
    <a class="help-link" href="/staff-docs" target="_blank">${ic('books')} Staff docs</a>
    <a class="help-link" href="help.html" target="_blank">${ic('book')} Customer help &amp; guides</a>
    <div id="user-box" class="user-box"></div>`;
  renderUserBox();
  startAgentChatEvents(); // the Support chat count in the menu stays live on every page
  startStaffNotices(); // the bell, and the counts on Billing, People, Action logs and Servers
  $('#main').addEventListener('click', (e) => e.target.closest('#ov-2fa') && openSecurity()); // the 2FA reminder on Overview
  const show = () => {
    $('#modal-root').innerHTML = ''; // a dialog from the previous section must not stay open over this one
    const [id, sub] = location.hash.slice(1).split('/'); // e.g. #actions/TH-000012
    const sec = sections.find((s) => s.id === id) || sections[0];
    $$('[data-sec]', side).forEach((a) => a.classList.toggle('active', a.dataset.sec === sec.id));
    markNoticesRead(sec.id); // opening a section clears its count
    const main = $('#main');
    main.innerHTML = `<div class="console-page"><h1 class="console-title">${sec.label}</h1><div id="console-body"><div class="muted">Loading...</div></div></div>`;
    sec.render($('#console-body'), sub).catch((e) => ($('#console-body').innerHTML = `<div class="warn-box">${esc(e.message)}</div>`));
  };
  window.addEventListener('hashchange', show);
  consoleRefresh = show;
  show();
}

// Re-draws the open section when something new happens there (a new subscription while Billing is open), but never
// while someone is typing or has a dialog open, so nothing they're doing is lost.
let consoleRefresh = null;
let refreshTimer = null;
function refreshOpenSection() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    const busy = $('#modal-root').children.length || (document.activeElement && document.activeElement.matches('input, textarea, select'));
    if (consoleRefresh && !busy) consoleRefresh();
  }, 800);
}

// ---------- staff notifications (src/staff-notices.js) ----------
// A new support chat, a failed payment, a sign-up, an appeal or a crash: the bell counts them, each menu section shows
// its own count, a pop-up appears the moment one arrives, and (if turned on) a desktop alert when the tab is hidden.

const staffNotes = { items: [], unread: 0, sections: {} };
const NOTE_ICON = { chat: 'chat', billing: 'card', people: 'users', actions: 'scroll', servers: 'crash' };

async function startStaffNotices() {
  $('#sn-bell').addEventListener('click', openNoticePanel);
  applyNotices(await api('GET', '/api/staff/notices').catch(() => null));
  const es = agentChat.es || new EventSource('/api/events'); // one live connection (the chat one) when it exists
  es.addEventListener('staffnote', (e) => onStaffNote(JSON.parse(e.data)));
  setInterval(() => api('GET', '/api/staff/notices').then(applyNotices).catch(() => {}), 60000);
}

function applyNotices(d) {
  if (!d) return;
  Object.assign(staffNotes, { items: d.items, unread: d.unread, sections: d.sections || {} });
  renderNoticeCounts();
  if ($('#sn-list')) renderNoticeList();
}

function renderNoticeCounts() {
  const c = $('#sn-count');
  if (!c) return;
  c.textContent = staffNotes.unread > 99 ? '99+' : staffNotes.unread;
  c.classList.toggle('hidden', !staffNotes.unread);
  for (const a of $$('.console-nav [data-sec]')) {
    if (a.dataset.sec === 'chat') continue; // Support chat keeps its own count (chats waiting for an answer)
    const n = staffNotes.sections[a.dataset.sec] || 0;
    let b = $('.nav-count', a);
    if (!b && !n) continue;
    if (!b) {
      b = document.createElement('span');
      b.className = 'nav-count';
      a.appendChild(b);
    }
    b.textContent = n;
    b.classList.toggle('hidden', !n);
  }
}

async function markNoticesRead(section) {
  if (section ? !staffNotes.sections[section] : !staffNotes.unread) return;
  applyNotices(await api('POST', '/api/staff/notices/read', section ? { section } : {}).catch(() => null));
}

function onStaffNote(n) {
  const here = !document.hidden && location.hash.slice(1).split('/')[0] === n.section;
  staffNotes.items = [{ ...n, unread: !here }, ...staffNotes.items].slice(0, 60);
  const open = location.hash.slice(1).split('/')[0] || 'overview';
  if ((here && n.section !== 'chat') || open === 'overview') refreshOpenSection(); // chat updates itself live already
  if (here) api('POST', '/api/staff/notices/read', { section: n.section }).catch(() => {});
  else {
    staffNotes.unread++;
    staffNotes.sections[n.section] = (staffNotes.sections[n.section] || 0) + 1;
  }
  renderNoticeCounts();
  if ($('#sn-list')) renderNoticeList();
  // A pop-up you can click to go straight there (new chats already get one from the chat code: chat.js)
  if (n.section !== 'chat') showNoticeToast(n);
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    const d = new Notification(`Tree Host: ${n.title}`, { body: n.text, tag: n.id, icon: '/brand/tree-host-logo-512.png' });
    d.onclick = () => {
      window.focus();
      location.hash = n.link;
      d.close();
    };
  }
}

function showNoticeToast(n) {
  const el = document.createElement('div');
  el.className = `toast sn-toast ${n.urgent ? 'error' : 'info'}`;
  el.innerHTML = `<b>${esc(n.title)}</b><br>${esc(n.text)}`;
  el.addEventListener('click', () => {
    location.hash = n.link;
    el.remove();
  });
  pageLayer('toasts', 'toasts').appendChild(el);
  setTimeout(() => el.remove(), n.urgent ? 12000 : 7000);
}

function openNoticePanel() {
  const { root, close } = openModal(`
    <div class="row" style="justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
      <h2 style="margin:0">${ic('bell')} Notifications</h2>
      <div class="row" style="gap:8px">
        <span id="sn-desk"></span>
        <button class="btn sm" id="sn-all">Mark all read</button>
      </div>
    </div>
    <p class="muted small" style="margin:6px 0 12px">New support chats, billing, sign-ups, appeals and crashes. You only see what your role can open.</p>
    <div class="sn-list" id="sn-list"></div>
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn" data-close>Close</button></div>`);
  renderNoticeList();
  renderDesktopToggle();
  $('#sn-all', root).addEventListener('click', () => markNoticesRead(null));
  $('#sn-list', root).addEventListener('click', (e) => {
    const a = e.target.closest('[data-link]');
    if (!a) return;
    close();
    location.hash = a.dataset.link;
  });
}

function renderNoticeList() {
  const list = $('#sn-list');
  if (!list) return;
  list.innerHTML = staffNotes.items.length
    ? staffNotes.items.map((n) => `<button class="sn-item ${n.unread ? 'unread' : ''} ${n.urgent ? 'urgent' : ''}" data-link="${esc(n.link)}">
        <span class="sn-ic">${ic(NOTE_ICON[n.section] || 'bell')}</span>
        <span class="sn-body"><b>${esc(n.title)}</b><span class="muted small">${esc(n.text)}</span></span>
        <span class="muted small sn-when">${esc(timeAgo(n.t))}</span></button>`).join('')
    : '<div class="muted" style="padding:20px;text-align:center">Nothing yet. New support chats, payments, sign-ups and appeals show up here.</div>';
}

function renderDesktopToggle() {
  const el = $('#sn-desk');
  if (!el || !('Notification' in window)) return;
  if (Notification.permission === 'granted') el.innerHTML = `<span class="badge green">${ic('check')} Desktop alerts on</span>`;
  else if (Notification.permission === 'denied') el.innerHTML = '<span class="badge" title="Allow notifications for this site in your browser settings">Desktop alerts blocked</span>';
  else {
    el.innerHTML = '<button class="btn sm" id="sn-desk-on">Turn on desktop alerts</button>';
    $('#sn-desk-on').addEventListener('click', async () => {
      await Notification.requestPermission();
      renderDesktopToggle();
    });
  }
}

// ---------- overview ----------
async function consoleOverview(body) {
  const [d, growth, plans] = await Promise.all([
    api('GET', '/api/admin/overview'),
    api('GET', '/api/admin/metrics').catch(() => null), // the growth card is additive: the rest of the overview still renders without it
    api('GET', '/api/plans').catch(() => null), // founding row supplies the price for the "X of 25 sold · $Y" line
  ]);
  const stat = (num, label, extra = '') => `<div class="stat"><div class="stat-num">${num}</div><div class="stat-label">${label}</div>${extra}</div>`;
  const cards = [
    stat(d.servers.total, 'servers'),
    stat(d.servers.running, 'running now'),
    d.servers.suspended ? stat(d.servers.suspended, 'suspended') : '',
  ];
  if (d.people) {
    cards.push(stat(d.people.customer || 0, 'customers'));
    if (d.people.youtuber) cards.push(stat(d.people.youtuber, 'YouTubers'));
    const staff = ['owner', 'admin', 'developer', 'staff'].reduce((n, r) => n + (d.people[r] || 0), 0);
    cards.push(stat(staff, 'staff'));
  }
  if (d.billing) {
    const mrr = Object.entries(d.billing.mrr).map(([c, v]) => money(v, c)).join(' + ') || money(0, d.billing.currency);
    const pct = Math.min(100, Math.round((d.billing.soldMb / Math.max(1, d.billing.capacityMb)) * 100));
    cards.push(stat(mrr, 'per month (MRR)'));
    cards.push(stat(d.billing.activeCount, `active plans${d.billing.pastDueCount ? ` · ${d.billing.pastDueCount} unpaid` : ''}`));
    cards.push(stat(`${pct}%`, 'memory sold', `<div class="mem-bar ${pct > 90 ? 'high' : pct > 75 ? 'mid' : ''}"><div style="width:${pct}%"></div></div>`));
  }
  if (d.system) {
    const used = d.system.totalMemMb - d.system.freeMemMb;
    cards.push(stat(`${fmtMem(used)} / ${fmtMem(d.system.totalMemMb)}`, 'machine memory used'));
    cards.push(stat(fmtUptime(d.system.uptimeSec * 1000), `Tree Host uptime · Node ${esc(d.system.node)}`));
  }
  const me = state.me.user;
  const remind2fa = !me.twoFactor
    ? `<div class="warn-box sn-2fa"><b>${ic('lock')} Protect your staff account.</b> Turn on two-factor sign-in, so a stolen password isn't enough to get in.
       <button class="btn sm primary" id="ov-2fa">Set it up</button></div>`
    : '';
  body.innerHTML = `${remind2fa}
    <p class="muted" style="margin-top:0">Signed in as <b>${esc(me.username)}</b> · <span class="badge ${ROLE_BADGE[me.role] || ''}">${esc(me.roleLabel)}</span>
      · you see the parts of the console your role allows (<a href="#roles">what can each role do?</a>).</p>
    <div class="stat-row">${cards.join('')}</div>
    ${growthCard(growth, plans)}
    ${d.billing && d.billing.mode === 'demo' ? '<div class="warn-box">Demo mode: plans activate without payment. Turn it off before going live.</div>' : ''}
    <div class="card"><h3 style="margin-bottom:8px">Recent activity</h3>
      ${d.activity.length ? d.activity.map((e) => activityItem(e)).join('') : '<div class="muted">Nothing yet.</div>'}</div>`;
}

// ---------- growth funnel card (read-only) ----------
// Fed by GET /api/admin/metrics (perm console.access — src/metrics.js adminSummary()). Everything on it is a count or
// a price; no buttons, no actions, no personal data. Returns '' when the API is unavailable so the rest of the
// overview is untouched. Anonymous cookie-free counters: page path + referrer host only (src/metrics.js header).
function growthCard(m, plans) {
  if (!m || !m.funnel) return '';
  const money = (cents) => {
    const currency = ((plans && plans.currency) || 'usd').toUpperCase();
    const dollars = (cents || 0) / 100;
    const dp = Number.isInteger(dollars) ? 0 : 2; // founding prices are whole dollars: "$398", not "$398.00"
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: dp, maximumFractionDigits: 2 }).format(dollars);
    } catch {
      return `$${dollars.toFixed(dp)}`;
    }
  };
  const stages = [
    ['Visitors', m.funnel.visitors, ''],
    ['Demos', m.funnel.demos, 'green'],
    ['Signups', m.funnel.signups, 'deep'],
    ['Paid', m.funnel.paid, 'gold'],
  ];
  const top = Math.max(1, ...stages.map(([, v]) => (v && v.total) || 0));
  const bars = stages.map(([label, v, cls]) => {
    const total = (v && v.total) || 0;
    const week = (v && v.week) || 0;
    return `<div class="grow-funnel-row">
      <span class="grow-funnel-label">${label}</span>
      <span class="grow-funnel-bar"><span class="grow-funnel-fill ${cls}" style="width:${Math.round((total / top) * 100)}%"></span></span>
      <span class="grow-funnel-nums">${week} this week · ${total} all-time</span>
    </div>`;
  }).join('');
  const refNames = { discord: 'Discord', youtube: 'YouTube', reddit: 'Reddit', serverlist: 'Serverlist', other: 'Other' };
  const refs = Object.entries(m.refs || {}).sort((a, b) => b[1] - a[1]);
  const refLine = refs.length
    ? refs.map(([k, n]) => `${refNames[k] || esc(k)} (${n})`).join(', ')
    : '<span class="muted">no attributed signups yet</span>';
  const founding = m.founding || {};
  const foundingRow = plans && plans.plans && plans.plans.some((p) => p.founding)
    ? plans.plans.filter((p) => p.founding)
        .map((p) => `<div><b>Founding:</b> ${founding.sold || 0} of ${founding.capTotal || p.capTotal || 25} sold · ${money((founding.sold || 0) * p.priceCents)}${founding.unitsLeft === 0 ? ' · sold out' : ''}</div>`)
        .join('')
    : `<div><b>Founding:</b> ${founding.sold || 0} of ${founding.capTotal || 25} sold${founding.unitsLeft === 0 ? ' · sold out' : ''}</div>`;
  return `<div class="card" id="growth-card"><h3 style="margin-bottom:4px">${ic('chart')} Growth funnel</h3>
    <p class="muted small" style="margin:0 0 10px">visitors → demos → signups → paid</p>
    <div class="grow-funnel">${bars}</div>
    <div class="grow-facts">
      <div><b>Signups by source:</b> ${refLine}</div>
      ${foundingRow}
      <div><b>Donations:</b> ${(m.donations && m.donations.started) || 0} started · ${(m.donations && m.donations.completed) || 0} completed</div>
    </div>
    <p class="muted small" style="margin:8px 0 0">Read-only · cookie-free counters (page path + referrer host only, no IPs, no personal data)</p>
  </div>`;
}

// ---------- every server (support's main tool) ----------
async function consoleServers(body) {
  const list = await api('GET', '/api/admin/servers');
  let q = '';
  let filter = 'all';
  const statusBadge = (s) =>
    s.moderation ? restrictionBadge(s.moderation)
      : s.suspended ? '<span class="badge red">not paid</span>'
      : s.running ? `<span class="badge green">${esc(s.status || 'running')}</span>`
        : '<span class="badge">stopped</span>';
  const draw = () => {
    const rows = list
      .filter((s) => filter === 'all' || (filter === 'running' ? s.running : filter === 'suspended' ? s.suspended || s.moderation : !s.running))
      .filter((s) => !q || [s.name, s.owner && s.owner.username, s.owner && s.owner.email, s.type, s.version, s.id].some((x) => String(x || '').toLowerCase().includes(q)));
    $('#srv-list', body).innerHTML = rows.length
      ? `<table><thead><tr><th>Server</th><th>Owner</th><th>Plan</th><th>Status</th><th>Memory</th><th></th></tr></thead><tbody>${rows
          .map((s) => `<tr>
            <td><b>${esc(s.name)}</b><div class="small muted">${esc(s.type)} ${esc(s.version)} · port ${s.port}${s.running ? ` · ${ic('users')} ${s.players}${s.maxPlayers ? `/${s.maxPlayers}` : ''} online` : ''}</div></td>
            <td class="small">${s.owner ? `${esc(s.owner.username)}${s.owner.email ? `<div class="muted">${esc(s.owner.email)}</div>` : ''}` : '<span class="muted">-</span>'}</td>
            <td class="small">${s.plan ? `${esc(s.plan.planName)}${s.plan.usable ? '' : ' <span class="badge red">not paid</span>'}` : '<span class="muted">-</span>'}</td>
            <td>${statusBadge(s)}</td>
            <td class="small">${s.memUsedMb ? `${fmtMem(s.memUsedMb)} / ` : ''}${s.memoryMb ? fmtMem(s.memoryMb) : '-'}</td>
            <td class="actions-cell">
              ${hasPerm('servers.operate') && !s.suspended && !s.moderation ? `<button class="btn sm" data-act="${s.running ? 'stop' : 'start'}" data-id="${esc(s.id)}">${s.running ? 'Stop' : 'Start'}</button>` : ''}
              ${s.owner && s.owner.id !== state.me.user.id && canTakeAction('server') ? `<button class="btn sm" data-take-srv="${esc(s.id)}" title="Warn, suspend, ban or delete">Action</button>` : ''}
              <button class="btn sm primary" data-open="${esc(s.id)}">Open</button></td>
          </tr>`)
          .join('')}</tbody></table>`
      : '<p class="muted" style="margin:0">No servers match.</p>';
    $$('[data-open]', body).forEach((b) => b.addEventListener('click', () => {
      // The dashboard opens on this server, with the "All servers" list showing.
      localStorage.setItem('mcpt.selected', b.dataset.open);
      localStorage.setItem('hh.space', 'all');
      location.href = '/dashboard';
    }));
    $$('[data-take-srv]', body).forEach((b) => b.addEventListener('click', () => {
      const s = list.find((x) => x.id === b.dataset.takeSrv);
      openTakeAction({ target: 'server', server: { id: s.id, name: s.name, ownerName: s.owner.username }, user: s.owner, onDone: () => consoleServers(body) });
    }));
    $$('[data-act]', body).forEach((b) => b.addEventListener('click', () => attempt(async () => {
      await api('POST', `/api/servers/${b.dataset.id}/${b.dataset.act}`);
      toast(b.dataset.act === 'start' ? 'Starting...' : 'Stopping...');
      setTimeout(() => consoleServers(body), 1500);
    })));
  };
  body.innerHTML = `
    <div class="row" style="margin-bottom:10px">
      <input type="search" id="srv-q" placeholder="Search server, owner, email, version" style="max-width:320px">
      <select id="srv-filter" style="max-width:170px"><option value="all">All</option><option value="running">Running</option><option value="stopped">Stopped</option><option value="suspended">Suspended</option></select>
      <span class="muted small">${list.length} server${list.length === 1 ? '' : 's'}</span>
    </div>
    <div class="card" id="srv-list"></div>`;
  $('#srv-q', body).addEventListener('input', (e) => ((q = e.target.value.trim().toLowerCase()), draw()));
  $('#srv-filter', body).addEventListener('change', (e) => ((filter = e.target.value), draw()));
  draw();
}

// ---------- roles & permissions ----------
async function consoleRoles(body) {
  const d = await api('GET', '/api/admin/roles');
  const editable = hasPerm('roles.manage');
  const roles = d.roles;
  const groups = [...new Set(d.permissions.map((p) => p.group))];
  body.innerHTML = `
    <p class="muted" style="margin-top:0">${editable
      ? 'Tick what each role may do. Changes apply right away to everyone with that role and are saved to the database. Owner always has everything; Customers only ever manage their own servers.'
      : 'What each role may do. Only people with <b>Edit roles</b> can change this.'}</p>
    <div class="role-cards">${roles.map((r) => `<div class="stat"><div class="stat-num" style="font-size:16px"><span class="badge ${ROLE_BADGE[r.id] || ''}">${esc(r.label)}</span></div>
      <div class="stat-label" style="margin-top:6px">${esc(r.description)}</div></div>`).join('')}</div>
    <div class="card" style="margin-top:12px;overflow-x:auto">
      <table class="perm-table"><thead><tr><th>Permission</th>${roles.map((r) => `<th class="c">${esc(r.label)}</th>`).join('')}</tr></thead><tbody>
      ${groups.map((g) => `<tr class="perm-group"><td colspan="${roles.length + 1}">${esc(g)}</td></tr>${d.permissions.filter((p) => p.group === g).map((p) => `<tr>
        <td><b>${esc(p.label)}</b><div class="small muted">${esc(p.description)}</div></td>
        ${roles.map((r) => `<td class="c"><input type="checkbox" data-role="${r.id}" data-perm="${p.id}" ${r.permissions.includes(p.id) ? 'checked' : ''} ${!editable || r.locked ? 'disabled' : ''} title="${esc(r.label)}: ${esc(p.label)}"></td>`).join('')}
      </tr>`).join('')}`).join('')}
      </tbody></table>
    </div>
    ${editable ? '<div class="row" style="margin-top:10px"><button class="btn sm" id="roles-reset">Reset all roles to the defaults</button></div>' : ''}`;
  $$('input[data-role]', body).forEach((box) => box.addEventListener('change', () => attempt(async () => {
    const role = box.dataset.role;
    const perms = $$(`input[data-role="${role}"]`, body).filter((b) => b.checked).map((b) => b.dataset.perm);
    await api('PUT', `/api/admin/roles/${role}`, { permissions: perms });
    toast(`${roles.find((r) => r.id === role).label} updated`);
  }).catch(() => (box.checked = !box.checked))));
  if ($('#roles-reset', body)) $('#roles-reset', body).addEventListener('click', () => {
    if (!confirm('Reset every role to the default permissions?')) return;
    attempt(async () => {
      await api('POST', '/api/admin/roles/reset');
      toast('Roles reset');
      consoleRoles(body);
    });
  });
}

// ---------- audit log ----------
async function consoleAudit(body) {
  const list = await api('GET', '/api/admin/audit?limit=500');
  let q = '';
  const draw = () => {
    const rows = list.filter((e) => !q || `${e.who} ${e.text}`.toLowerCase().includes(q));
    $('#audit-list', body).innerHTML = rows.length
      ? `<table><thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead><tbody>${rows.map((e) => `<tr>
          <td class="small" title="${esc(new Date(e.t).toLocaleString())}">${esc(timeAgo(e.t))}</td>
          <td><b>${esc(e.who)}</b></td><td>${esc(e.text)}${e.serverName ? ` <span class="muted small">(${esc(e.serverName)})</span>` : ''}</td></tr>`).join('')}</tbody></table>`
      : '<p class="muted" style="margin:0">No staff actions yet.</p>';
  };
  body.innerHTML = `
    <p class="muted" style="margin-top:0">Every staff action: role changes, suspensions, free plans, promo codes, plan and setting changes.</p>
    <div class="row" style="margin-bottom:10px"><input type="search" id="audit-q" placeholder="Search who or what" style="max-width:320px"><span class="muted small">${list.length} entries</span></div>
    <div class="card" id="audit-list"></div>`;
  $('#audit-q', body).addEventListener('input', (e) => ((q = e.target.value.trim().toLowerCase()), draw()));
  draw();
}

// ---------- system ----------
async function consoleSystem(body) {
  const [sys, ov] = await Promise.all([api('GET', '/api/system'), api('GET', '/api/admin/overview')]);
  const row = (k, v) => `<tr><td class="muted">${k}</td><td>${v}</td></tr>`;
  body.innerHTML = `
    <div class="card"><table>
      ${row('Platform', esc(sys.platform))}
      ${row('Node.js', esc(ov.system ? ov.system.node : '-'))}
      ${row('Tree Host uptime', ov.system ? fmtUptime(ov.system.uptimeSec * 1000) : '-')}
      ${row('Memory', `${fmtMem(sys.totalMemMb - sys.freeMemMb)} used of ${fmtMem(sys.totalMemMb)}`)}
      ${row('Server isolation', sys.isolated ? '<span class="badge green">Docker: every server in its own container</span>' : '<span class="badge yellow">off (servers run directly on the machine)</span>')}
      ${row('Data folder', `<code>${esc(sys.dataDir)}</code>`)}
      ${row('Java', `System: ${sys.java && sys.java.system ? `<code>Java ${esc(sys.java.system)}</code>` : '<span class="muted">none</span>'}
        · Downloaded by Tree Host: ${sys.java && sys.java.managed && sys.java.managed.length ? sys.java.managed.map((m) => `<code>Java ${esc(m)}</code>`).join(' ') : '<span class="muted">none yet (downloaded when a server needs it)</span>'}`)}
    </table></div>
    <div class="card" style="margin-top:12px"><h3 style="margin-bottom:8px">Running servers</h3>
      ${sys.servers.length ? `<table><thead><tr><th>Server</th><th>Memory</th></tr></thead><tbody>${sys.servers.map((s) => `<tr><td>${esc(s.name)}</td><td class="small">${s.usedMb ? fmtMem(s.usedMb) : '?'} / ${s.maxMb ? fmtMem(s.maxMb) : '?'}</td></tr>`).join('')}</tbody></table>` : '<p class="muted" style="margin:0">None running.</p>'}</div>`;
}

// ---------- managed plugins (#staff-plugin) ----------
// Every plugin Tree Host puts on servers by itself: the built-in Tree Host Staff plugin and any staff add here.
// Server side: src/managed-plugins.js. Viewing needs system.view; changes need system.manage.

const MP_STATES = {
  current: { label: 'Up to date', badge: 'green' },
  outdated: { label: 'Different version', badge: 'yellow' },
  missing: { label: 'Missing', badge: 'red' },
  disabled: { label: 'Turned off by owner', badge: '' },
  removed: { label: 'Removed by owner', badge: '' },
};

async function consoleStaffPlugin(body) {
  const canManage = hasPerm('system.manage');
  let data = await api('GET', '/api/admin/managed-plugins');
  let q = '';
  const typeLabel = (id) => (data.types.find((t) => t.id === id) || { label: id }).label;
  const fitsLabel = (p) => mpFits(p.platforms);

  const reload = async () => {
    data = await api('GET', '/api/admin/managed-plugins');
    draw();
  };

  const coverageBar = (c) => {
    if (!c.total) return '<div class="mp-cov"><div class="mp-bar empty"></div><div class="small muted">No servers it applies to yet.</div></div>';
    const seg = (n, cls) => (n ? `<div class="${cls}" style="flex:${n}"></div>` : '');
    const off = c.disabled + c.removed;
    const issues = [c.outdated && `${c.outdated} different version`, c.missing && `${c.missing} missing`, off && `${off} turned off or removed by the owner`].filter(Boolean);
    return `<div class="mp-cov">
      <div class="mp-bar">${seg(c.current, 'ok')}${seg(c.outdated, 'warn')}${seg(c.missing, 'bad')}${seg(off, 'off')}</div>
      <div class="small"><b>${c.current}</b> <span class="muted">of ${c.total} server${c.total === 1 ? '' : 's'} up to date${issues.length ? ` · ${issues.join(' · ')}` : ''}</span></div>
    </div>`;
  };

  const card = (p) => {
    const badges = [
      p.builtIn ? '<span class="badge blue">Built in</span>' : '',
      p.locked ? `<span class="badge yellow" title="Customers can't remove, turn off or replace it; it's put back if it goes missing">${ic('lock')} Locked</span>` : '<span class="badge" title="Owners may remove or turn it off">Optional</span>',
      p.paused ? '<span class="badge red" title="Not installed anywhere new and not enforced">Paused</span>' : '',
      !p.builtIn && !p.autoInstall && !p.paused ? '<span class="badge" title="Only installed when you push it">Manual</span>' : '',
      p.builtIn && p.source === 'uploaded' ? '<span class="badge green" title="A build uploaded here, not the one bundled with Tree Host">Uploaded build</span>' : '',
      p.builtIn && p.source === 'missing' ? '<span class="badge red">Jar missing</span>' : '',
    ].join('');
    const types = p.serverTypes.length ? p.serverTypes.map((t) => `<span class="tag">${esc(typeLabel(t))}</span>`).join('') : `<span class="tag">${esc(fitsLabel(p))}</span>`;
    return `<div class="mp-card${p.paused ? ' paused' : ''}" data-id="${esc(p.id)}">
      <div class="mp-icon${p.builtIn ? ' builtin' : ''}">${ic(p.builtIn ? 'shield' : 'puzzle')}</div>
      <div class="mp-main">
        <div class="mp-title"><b>${esc(p.name)}</b>${p.version ? `<span class="mp-ver">v${esc(p.version)}</span>` : ''}${badges}</div>
        ${p.description ? `<p class="mp-desc">${esc(p.description)}</p>` : ''}
        <div class="mp-meta small muted"><code>${esc(p.filename)}</code> · ${fmtSize(p.size)}${p.uploadedAt ? ` · updated ${esc(timeAgo(p.uploadedAt))}${p.uploadedBy ? ` by ${esc(p.uploadedBy)}` : ''}` : ''}</div>
        <div class="plugin-tags">${types}</div>
        ${coverageBar(p.coverage)}
      </div>
      <div class="mp-actions">
        <button class="btn sm" data-mp="details">${ic('eye')} Details</button>
        ${canManage ? `<button class="btn sm" data-mp="version">${ic('upload')} New version</button>` : ''}
        ${canManage && !p.builtIn ? `<button class="btn sm" data-mp="edit">${ic('sliders')} Settings</button>` : ''}
        ${canManage && !p.paused ? `<button class="btn sm" data-mp="push" title="Install it on every server it belongs on now${p.locked ? '' : ', including where an owner removed it'}">${ic('refresh')} Push now</button>` : ''}
        ${canManage && !p.builtIn ? `<button class="btn sm danger" data-mp="remove">${ic('trash')} Remove</button>` : ''}
      </div>
    </div>`;
  };

  function draw() {
    const all = data.plugins;
    const list = all.filter((p) => !q || [p.name, p.filename, p.description, p.version].some((v) => String(v || '').toLowerCase().includes(q)));
    const sum = all.reduce((a, p) => ((a.total += p.coverage.total), (a.current += p.coverage.current), (a.bad += p.coverage.outdated + p.coverage.missing), a), { total: 0, current: 0, bad: 0 });
    const pct = sum.total ? Math.round((sum.current / sum.total) * 100) : 100;
    const stat = (num, label, cls = '') => `<div class="stat ${cls}"><div class="stat-num">${num}</div><div class="stat-label">${label}</div></div>`;
    body.innerHTML = `
      <p class="muted" style="margin-top:0;max-width:760px">Plugins Tree Host installs on customer, demo and team servers by itself. Every server is checked when it starts and every 30 seconds.
        <b>Locked</b> plugins are put back if they go missing and can't be removed by owners; <b>optional</b> ones are installed once per version.</p>
      <div class="stat-row">
        ${stat(all.length, `managed plugin${all.length === 1 ? '' : 's'}`)}
        ${stat(all.filter((p) => p.locked && !p.paused).length, 'locked on servers')}
        ${stat(`${pct}%`, 'installs up to date', pct < 100 ? 'mp-stat-warn' : '')}
        ${stat(sum.bad, 'installs needing attention', sum.bad ? 'mp-stat-bad' : '')}
      </div>
      <div class="mp-toolbar">
        <input type="search" id="mp-q" placeholder="Search plugins..." value="${esc(q)}">
        <span style="flex:1"></span>
        ${canManage ? `<button class="btn" id="mp-sync" title="Check every server for every managed plugin now">${ic('refresh')} Check all servers</button>
        <button class="btn primary" id="mp-add">${ic('plus')} Add plugin</button>` : ''}
      </div>
      <div class="mp-list">${list.length ? list.map(card).join('') : `<div class="card muted">No plugins match "${esc(q)}".</div>`}</div>
      ${!canManage ? '<p class="hint small">You can look, but adding or changing managed plugins needs the "Manage required plugins" permission.</p>' : ''}`;

    const search = $('#mp-q', body);
    search.addEventListener('input', () => {
      q = search.value.trim().toLowerCase();
      const pos = search.selectionStart;
      draw();
      $('#mp-q', body).focus();
      $('#mp-q', body).setSelectionRange(pos, pos);
    });
    $('#mp-add', body)?.addEventListener('click', () => mpAddModal(data.types, reload));
    $('#mp-sync', body)?.addEventListener('click', (e) =>
      mpBusy(e.currentTarget, async () => {
        const r = await api('POST', '/api/admin/managed-plugins-sync');
        toast(`Checked ${r.servers} server${r.servers === 1 ? '' : 's'}: ${r.installed} installed, ${r.restored} put back${r.failed ? `, ${r.failed} failed` : ''}.`);
        await reload();
      }),
    );
    $$('.mp-card', body).forEach((el) => {
      const p = data.plugins.find((x) => x.id === el.dataset.id);
      $$('[data-mp]', el).forEach((b) =>
        b.addEventListener('click', () => {
          const act = b.dataset.mp;
          if (act === 'details') mpDetailsModal(p.id, { typeLabel, fitsLabel, canManage, reload });
          if (act === 'version') mpVersionModal(p, reload);
          if (act === 'edit') mpSettingsModal(p, data.types, reload);
          if (act === 'remove') mpRemoveModal(p, reload);
          if (act === 'push')
            mpBusy(b, async () => {
              const r = await api('POST', `/api/admin/managed-plugins/${encodeURIComponent(p.id)}/push`);
              toast(`${p.name}: ${r.installed + r.restored} server${r.installed + r.restored === 1 ? '' : 's'} updated, ${r.servers} checked${r.failed ? `, ${r.failed} failed` : ''}.`);
              await reload();
            });
        }),
      );
    });
  }
  draw();
}

/** Disables a button while its action runs (and shows errors as toasts). */
async function mpBusy(btn, fn) {
  btn.disabled = true;
  try {
    await fn();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

/**
 * plugin.yml from a .jar picked in the browser, so the form can fill itself in. Reads the zip's central directory
 * and inflates just that one entry. Returns { name, version, description } or null (old browser, odd jar...).
 */
async function mpReadPluginYml(file) {
  try {
    const tail = new DataView(await file.slice(Math.max(0, file.size - 65557)).arrayBuffer());
    let eocd = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) return null;
    const count = tail.getUint16(eocd + 10, true);
    const cdSize = tail.getUint32(eocd + 12, true);
    const cdOff = tail.getUint32(eocd + 16, true);
    const cd = new DataView(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
    const dec = new TextDecoder();
    let hit = null;
    for (let i = 0, p = 0; i < count && p + 46 <= cd.byteLength; i++) {
      const nameLen = cd.getUint16(p + 28, true);
      const name = dec.decode(new Uint8Array(cd.buffer, p + 46, nameLen));
      const rank = { 'plugin.yml': 4, 'paper-plugin.yml': 3, 'velocity-plugin.json': 2, 'bungee.yml': 1 }[name] || 0;
      if (rank > (hit ? hit.rank : 0)) hit = { name, rank, method: cd.getUint16(p + 10, true), size: cd.getUint32(p + 20, true), local: cd.getUint32(p + 42, true) };
      p += 46 + nameLen + cd.getUint16(p + 30, true) + cd.getUint16(p + 32, true);
    }
    if (!hit || hit.size > 1 << 20) return null;
    const lh = new DataView(await file.slice(hit.local, hit.local + 30).arrayBuffer());
    const start = hit.local + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    let blob = file.slice(start, start + hit.size);
    if (hit.method === 8) {
      if (typeof DecompressionStream === 'undefined') return null;
      blob = await new Response(blob.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
    } else if (hit.method !== 0) return null;
    const text = await blob.text();
    if (hit.name.endsWith('.json')) {
      const j = JSON.parse(text);
      return { file: hit.name, name: j.name || j.id || '', version: j.version || '', description: j.description || '' };
    }
    const field = (k) => {
      const m = new RegExp(`^${k}\\s*:\\s*(.*)$`, 'm').exec(text);
      return m ? m[1].replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '') : '';
    };
    return { file: hit.name, name: field('name'), version: field('version'), description: field('description') };
  } catch {
    return null;
  }
}

/** A drop area for one .jar; onFile(file, pluginYml) runs when one is picked. */
function mpJarPicker(root, onFile) {
  const dz = $('.mp-drop', root);
  const input = $('input[type=file]', dz);
  const pick = async (f) => {
    if (!f) return;
    if (!/\.jar$/i.test(f.name)) return toast('Pick a .jar file.', 'error');
    if (f.size > 50 * 1024 * 1024) return toast('Plugins can be up to 50 MB.', 'error');
    const yml = await mpReadPluginYml(f);
    dz.classList.add('has-file');
    $('.mp-drop-text', dz).innerHTML = `${ic('check')} <b>${esc(f.name)}</b> <span class="muted">· ${fmtSize(f.size)}${yml && yml.name ? ` · ${esc(yml.file)}: ${esc(yml.name)} ${esc(yml.version)}` : ''}</span>`;
    onFile(f, yml);
  };
  dz.addEventListener('dragover', (e) => (e.preventDefault(), dz.classList.add('over')));
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    pick(e.dataTransfer.files[0]);
  });
  input.addEventListener('change', () => pick(input.files[0]));
}
const MP_DROP = `<div class="mp-drop"><input type="file" accept=".jar" hidden id="mp-file">
  <div class="mp-drop-text">${ic('upload')} Drop a <b>.jar</b> here or <label for="mp-file">choose a file</label> <span class="muted">(up to 50 MB)</span></div></div>`;

/** Where a plugin goes when no server types are picked: every server its jar is a plugin for. */
function mpFits(platforms) {
  const names = { bukkit: 'Paper-family servers', velocity: 'Velocity proxies', bungee: 'BungeeCord and Waterfall proxies' };
  const list = (platforms && platforms.length ? platforms : ['bukkit']).map((x) => names[x]).filter(Boolean);
  return `Every one of: ${list.join(', ')}`;
}

const mpTypePicks = (types, picked) =>
  `<div class="row" style="flex-wrap:wrap;gap:6px">${types.map((t) => `<label class="tag-pick"><input type="checkbox" name="type" value="${esc(t.id)}" ${picked.includes(t.id) ? 'checked' : ''}> ${esc(t.label)}${t.family !== 'bukkit' ? ' <span class="muted small">(proxy)</span>' : ''}</label>`).join('')}</div>
   <div class="hint small" style="margin:4px 0 0">None picked = every server the jar is a plugin for: plugin.yml → Paper family, velocity-plugin.json → Velocity, bungee.yml → BungeeCord and Waterfall.</div>`;

function mpAddModal(types, reload) {
  const { root, close } = openModal(`
    <h2>${ic('plus')} Add a managed plugin</h2>
    <form id="mp-add-form" class="stack">
      ${MP_DROP}
      <div class="grid2">
        <label class="field">Name <input type="text" name="name" maxlength="60" placeholder="Read from the jar" required></label>
        <label class="field">Version <input type="text" name="version" maxlength="40" placeholder="Read from the jar"></label>
      </div>
      <label class="field">Description <textarea name="description" rows="2" maxlength="500" placeholder="What it does (owners see this on their Plugins tab)"></textarea></label>
      <div class="mp-field"><span>Server types</span>${mpTypePicks(types, [])}</div>
      <label class="check"><input type="checkbox" name="locked" checked> <span><b>Locked</b><br><span class="muted small">Owners can't remove, turn off or replace it, and it's put back if it goes missing.</span></span></label>
      <label class="check"><input type="checkbox" name="autoInstall" checked> <span><b>Install automatically</b><br><span class="muted small">On every matching server now and on new ones. Off: only when you press Push now.</span></span></label>
      <label class="field">Notes for staff (optional) <textarea name="notes" rows="2" maxlength="1000" placeholder="Why we run it, config tips, ..."></textarea></label>
      <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary" disabled>Add plugin</button></div>
    </form>`);
  const form = $('#mp-add-form', root);
  let file = null;
  mpJarPicker(root, (f, yml) => {
    file = f;
    if (yml) {
      if (yml.name && !form.name.value) form.name.value = yml.name;
      if (yml.version) form.version.value = yml.version;
      if (yml.description && !form.description.value) form.description.value = yml.description;
    }
    if (!form.name.value) form.name.value = f.name.replace(/\.jar$/i, '');
    $('[type=submit]', form).disabled = false;
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!file) return toast('Pick the plugin .jar first.', 'error');
    mpBusy($('[type=submit]', form), async () => {
      const qs = new URLSearchParams({
        filename: file.name,
        name: form.name.value.trim(),
        version: form.version.value.trim(),
        description: form.description.value.trim(),
        notes: form.notes.value.trim(),
        locked: form.locked.checked ? '1' : '0',
        autoInstall: form.autoInstall.checked ? '1' : '0',
        types: $$('[name=type]:checked', form).map((c) => c.value).join(','),
      });
      const p = await api('POST', `/api/admin/managed-plugins?${qs}`, file);
      toast(`${p.name} added${p.autoInstall ? ': servers get it within a minute' : ''}.`);
      close();
      await reload();
    });
  });
}

function mpVersionModal(p, reload) {
  const { root, close } = openModal(`
    <h2>${ic('upload')} New version of ${esc(p.name)}</h2>
    <p class="muted" style="margin-top:0">Servers have <b>${p.version ? `v${esc(p.version)}` : 'the current build'}</b> (<code>${esc(p.filename)}</code>).
      The new build replaces it on every server within a minute${p.locked ? '' : ' (and on servers where the owner removed the old one)'}.
      ${p.builtIn ? 'It must be the Tree Host staff plugin (<code>name: TreeHostStaff</code> in plugin.yml).' : ''}</p>
    <form id="mp-ver-form" class="stack">
      ${MP_DROP}
      <label class="field">Version <input type="text" name="version" maxlength="40" placeholder="Read from plugin.yml"></label>
      ${p.builtIn ? '' : '<label class="check hidden" id="mp-rename"><input type="checkbox" name="rename" checked> <span>Use the new file name <code id="mp-newname"></code> on servers (the old file is removed)</span></label>'}
      <label class="field">What changed (optional) <textarea name="notes" rows="3" maxlength="1000" placeholder="Release notes for staff"></textarea></label>
      <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary" disabled>Upload and roll out</button></div>
    </form>`);
  const form = $('#mp-ver-form', root);
  let file = null;
  mpJarPicker(root, (f, yml) => {
    file = f;
    if (yml && yml.version) form.version.value = yml.version;
    if (yml && yml.name && p.builtIn && yml.name !== 'TreeHostStaff') toast(`That jar is "${yml.name}", not TreeHostStaff.`, 'error');
    const rn = $('#mp-rename', root);
    if (rn) {
      rn.classList.toggle('hidden', f.name === p.filename);
      $('#mp-newname', root).textContent = f.name;
    }
    $('[type=submit]', form).disabled = false;
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!file) return toast('Pick the new .jar first.', 'error');
    mpBusy($('[type=submit]', form), async () => {
      const qs = new URLSearchParams({ version: form.version.value.trim(), notes: form.notes.value.trim() });
      if (form.rename && form.rename.checked && file.name !== p.filename) qs.set('filename', file.name);
      const r = await api('POST', `/api/admin/managed-plugins/${encodeURIComponent(p.id)}/jar?${qs}`, file);
      toast(`${r.name} ${r.version ? `v${r.version} ` : ''}is rolling out to servers.`);
      close();
      await reload();
    });
  });
}

function mpSettingsModal(p, types, reload) {
  const { root, close } = openModal(`
    <h2>${ic('sliders')} ${esc(p.name)} settings</h2>
    <form id="mp-set-form" class="stack">
      <div class="grid2">
        <label class="field">Name <input type="text" name="name" maxlength="60" value="${esc(p.name)}" required></label>
        <label class="field">Version label <input type="text" name="version" maxlength="40" value="${esc(p.version)}"></label>
      </div>
      <label class="field">Description <textarea name="description" rows="2" maxlength="500">${esc(p.description)}</textarea></label>
      <div class="mp-field"><span>Server types</span>${mpTypePicks(types, p.serverTypes)}</div>
      <label class="check"><input type="checkbox" name="locked" ${p.locked ? 'checked' : ''}> <span><b>Locked</b><br><span class="muted small">Owners can't remove, turn off or replace it, and it's put back if it goes missing.</span></span></label>
      <label class="check"><input type="checkbox" name="autoInstall" ${p.autoInstall ? 'checked' : ''}> <span><b>Install automatically</b><br><span class="muted small">Off: only installed when you press Push now.</span></span></label>
      <label class="check"><input type="checkbox" name="paused" ${p.paused ? 'checked' : ''}> <span><b>Paused</b><br><span class="muted small">Not installed or enforced anywhere. Copies already on servers stay, and owners can remove them.</span></span></label>
      <label class="field">Notes for staff <textarea name="notes" rows="3" maxlength="1000">${esc(p.notes || '')}</textarea></label>
      <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Save</button></div>
    </form>`);
  const form = $('#mp-set-form', root);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    mpBusy($('[type=submit]', form), async () => {
      await api('PUT', `/api/admin/managed-plugins/${encodeURIComponent(p.id)}`, {
        name: form.name.value.trim(),
        version: form.version.value.trim(),
        description: form.description.value.trim(),
        notes: form.notes.value.trim(),
        locked: form.locked.checked,
        autoInstall: form.autoInstall.checked,
        paused: form.paused.checked,
        serverTypes: $$('[name=type]:checked', form).map((c) => c.value),
      });
      toast('Saved.');
      close();
      await reload();
    });
  });
}

function mpRemoveModal(p, reload) {
  const { root, close } = openModal(`
    <h2>${ic('trash')} Stop managing ${esc(p.name)}?</h2>
    <p class="muted" style="margin-top:0">Tree Host stops installing and enforcing it. What should happen to the copies on ${p.coverage.total} server${p.coverage.total === 1 ? '' : 's'}?</p>
    <form id="mp-rm-form" class="stack">
      <label class="check"><input type="radio" name="purge" value="0" checked> <span><b>Leave them</b><br><span class="muted small">They become the owners' own plugin: they can keep or delete it.</span></span></label>
      <label class="check"><input type="radio" name="purge" value="1"> <span><b>Delete them from every server too</b><br><span class="muted small">Running servers keep it loaded until their next restart.</span></span></label>
      <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn danger">Remove</button></div>
    </form>`);
  const form = $('#mp-rm-form', root);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    mpBusy($('[type=submit]', form), async () => {
      const purge = $('[name=purge]:checked', form).value === '1';
      const r = await api('DELETE', `/api/admin/managed-plugins/${encodeURIComponent(p.id)}${purge ? '?purge=1' : ''}`);
      toast(`${p.name} is no longer managed${purge ? ` (deleted ${r.removedFrom} file${r.removedFrom === 1 ? '' : 's'} from servers)` : ''}.`);
      close();
      await reload();
    });
  });
}

async function mpDetailsModal(id, { typeLabel, fitsLabel, canManage, reload }) {
  const p = await api('GET', `/api/admin/managed-plugins/${encodeURIComponent(id)}`).catch((e) => toast(e.message, 'error'));
  if (!p) return;
  let filter = 'all';
  const row = (k, v) => `<tr><td class="muted" style="width:150px">${k}</td><td>${v}</td></tr>`;
  const { root, close } = openModal(`
    <h2>${ic(p.builtIn ? 'shield' : 'puzzle')} ${esc(p.name)} ${p.version ? `<span class="mp-ver">v${esc(p.version)}</span>` : ''}</h2>
    ${p.description ? `<p style="margin-top:0">${esc(p.description)}</p>` : ''}
    <div class="card"><table>
      ${row('File on servers', `<code>${esc(p.filename)}</code> · ${fmtSize(p.size)}`)}
      ${row('SHA-256', `<code class="mp-hash" title="Click to copy">${esc(p.hash || 'unknown')}</code>`)}
      ${row('Rules', `${p.locked ? `${ic('lock')} Locked: owners can't remove it` : 'Optional: owners may remove or turn it off'}${p.paused ? ' · <b>paused</b>' : ''}${!p.builtIn && !p.autoInstall ? ' · installed only when pushed' : ''}`)}
      ${row('Server types', p.serverTypes.length ? p.serverTypes.map((t) => esc(typeLabel(t))).join(', ') : esc(fitsLabel(p)))}
      ${p.builtIn ? row('Source', p.source === 'uploaded' ? 'Uploaded in the Staff Console' : p.source === 'bundled' ? 'Bundled with Tree Host (<code>minecraft-plugin/TreeHostStaff.jar</code>)' : '<span class="badge red">missing</span>') : ''}
      ${p.uploadedAt ? row('Uploaded', `${esc(new Date(p.uploadedAt).toLocaleString())}${p.uploadedBy ? ` by <b>${esc(p.uploadedBy)}</b>` : ''}`) : ''}
      ${p.notes ? row('Notes', `<div style="white-space:pre-wrap">${esc(p.notes)}</div>`) : ''}
    </table></div>
    ${p.history && p.history.length ? `<div class="card" style="margin-top:12px"><h3 style="margin-bottom:8px">Earlier versions</h3><table>
      ${p.history.map((h) => `<tr><td>${h.version ? `v${esc(h.version)}` : '<span class="muted">unnamed</span>'}</td><td class="small muted">${h.uploadedAt ? esc(new Date(h.uploadedAt).toLocaleDateString()) : 'bundled'}${h.uploadedBy ? ` · ${esc(h.uploadedBy)}` : ''}</td><td class="small"><code title="${esc(h.hash || '')}">${esc((h.hash || '').slice(0, 12))}</code></td></tr>`).join('')}
    </table></div>` : ''}
    <div class="card" style="margin-top:12px">
      <div class="row" style="justify-content:space-between;flex-wrap:wrap;margin-bottom:8px"><h3 style="margin:0">Servers (${p.servers.length})</h3>
        <div class="row" id="mp-filter" style="flex-wrap:wrap;gap:6px"></div></div>
      <div id="mp-servers"></div>
    </div>
    <div class="modal-actions">
      <a class="btn" href="/api/admin/managed-plugins/${encodeURIComponent(p.id)}/jar">${ic('download')} Download jar</a>
      ${canManage && p.builtIn && p.canRevert ? `<button class="btn danger" id="mp-revert">Go back to the bundled build</button>` : ''}
      <span style="flex:1"></span>
      <button class="btn primary" data-close>Close</button>
    </div>`);
  const drawServers = () => {
    const counts = p.servers.reduce((a, s) => ((a[s.state] = (a[s.state] || 0) + 1), a), {});
    $('#mp-filter', root).innerHTML = ['all', ...Object.keys(MP_STATES).filter((k) => counts[k])]
      .map((k) => `<button type="button" class="chip${filter === k ? ' on' : ''}" data-f="${k}">${k === 'all' ? `All ${p.servers.length}` : `${MP_STATES[k].label} ${counts[k]}`}</button>`).join('');
    $$('[data-f]', root).forEach((b) => b.addEventListener('click', () => ((filter = b.dataset.f), drawServers())));
    const rows = p.servers.filter((s) => filter === 'all' || s.state === filter);
    $('#mp-servers', root).innerHTML = rows.length
      ? `<table><thead><tr><th>Server</th><th>Type</th><th>Status</th></tr></thead><tbody>${rows
          .map((s) => `<tr><td><b>${esc(s.name)}</b> <span class="small muted">${esc(s.space)}${s.running ? ' · running' : ''}</span></td><td class="small">${esc(typeLabel(s.type))}</td><td><span class="badge ${MP_STATES[s.state].badge}">${MP_STATES[s.state].label}</span></td></tr>`)
          .join('')}</tbody></table>`
      : '<p class="muted" style="margin:0">No servers here.</p>';
  };
  drawServers();
  $('.mp-hash', root).addEventListener('click', () => navigator.clipboard && navigator.clipboard.writeText(p.hash).then(() => toast('Hash copied.')));
  $('#mp-revert', root)?.addEventListener('click', (e) =>
    mpBusy(e.currentTarget, async () => {
      await api('DELETE', `/api/admin/managed-plugins/${encodeURIComponent(p.id)}/jar`);
      toast('Servers are going back to the bundled staff plugin.');
      close();
      await reload();
    }),
  );
}
