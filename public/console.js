'use strict';
// Staff Console (/admin): a full-page view for Owners, Admins, Developers and Support. Every section is shown only
// if your role has the permission it needs (the server checks the same permissions on every request: src/rbac.js).
// Loaded before app.js; app.js calls initConsole() when the page is /admin. Uses app.js and team.js helpers.

const CONSOLE_SECTIONS = [
  { id: 'overview', icon: 'chart', label: 'Overview', perm: 'console.access', render: consoleOverview },
  { id: 'servers', icon: 'server', label: 'Servers', perm: 'servers.viewAll', render: consoleServers },
  { id: 'people', icon: 'users', label: 'People', perm: 'users.view', render: (b) => adminPeople(b) },
  { id: 'billing', icon: 'card', label: 'Billing', perm: 'billing.view', render: (b) => adminBilling(b) },
  { id: 'plans', icon: 'box', label: 'Plans', perm: 'billing.manage', render: (b) => adminPlans(b) },
  { id: 'promos', icon: 'ticket', label: 'Promo codes', perm: 'promos.manage', render: (b) => adminPromos(b) },
  { id: 'actions', icon: 'scroll', label: 'Action logs', perm: 'moderation.view', render: (b, sub) => consoleActions(b, sub) },
  { id: 'roles', icon: 'key', label: 'Roles & permissions', perm: 'console.access', render: consoleRoles },
  { id: 'audit', icon: 'receipt', label: 'Audit log', perm: 'audit.view', render: consoleAudit },
  { id: 'system', icon: 'gear', label: 'System', perm: 'system.view', render: consoleSystem },
  { id: 'settings', icon: 'sliders', label: 'Settings', perm: 'settings.manage', render: (b) => adminSettings(b) },
];

function initConsole() {
  document.title = 'Staff Console · Tree Host';
  const side = $('.sidebar');
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
    <div class="brand"><div class="logo"></div><div><div class="brand-name">Tree Host</div><div class="brand-sub">Staff Console</div></div></div>
    <nav class="console-nav">${sections.map((s) => `<a href="#${s.id}" data-sec="${s.id}">${ic(s.icon)} ${s.label}</a>`).join('')}</nav>
    <a class="help-link" href="/dashboard">← Back to dashboard</a>
    <a class="help-link" href="/staff-docs" target="_blank">${ic('books')} Staff docs</a>
    <a class="help-link" href="help.html" target="_blank">${ic('book')} Customer help &amp; guides</a>
    <div id="user-box" class="user-box"></div>`;
  renderUserBox();
  const show = () => {
    $('#modal-root').innerHTML = ''; // a dialog from the previous section must not stay open over this one
    const [id, sub] = location.hash.slice(1).split('/'); // e.g. #actions/TH-000012
    const sec = sections.find((s) => s.id === id) || sections[0];
    $$('[data-sec]', side).forEach((a) => a.classList.toggle('active', a.dataset.sec === sec.id));
    const main = $('#main');
    main.innerHTML = `<div class="console-page"><h1 class="console-title">${sec.label}</h1><div id="console-body"><div class="muted">Loading...</div></div></div>`;
    sec.render($('#console-body'), sub).catch((e) => ($('#console-body').innerHTML = `<div class="warn-box">${esc(e.message)}</div>`));
  };
  window.addEventListener('hashchange', show);
  show();
}

// ---------- overview ----------
async function consoleOverview(body) {
  const d = await api('GET', '/api/admin/overview');
  const stat = (num, label, extra = '') => `<div class="stat"><div class="stat-num">${num}</div><div class="stat-label">${label}</div>${extra}</div>`;
  const cards = [
    stat(d.servers.total, 'servers'),
    stat(d.servers.running, 'running now'),
    d.servers.suspended ? stat(d.servers.suspended, 'suspended') : '',
  ];
  if (d.people) {
    cards.push(stat(d.people.customer || 0, 'customers'));
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
  body.innerHTML = `
    <p class="muted" style="margin-top:0">Signed in as <b>${esc(me.username)}</b> · <span class="badge ${ROLE_BADGE[me.role] || ''}">${esc(me.roleLabel)}</span>
      · you see the parts of the console your role allows (<a href="#roles">what can each role do?</a>).</p>
    <div class="stat-row">${cards.join('')}</div>
    ${d.billing && d.billing.mode === 'demo' ? '<div class="warn-box">Demo mode: plans activate without payment. Turn it off before going live.</div>' : ''}
    <div class="card"><h3 style="margin-bottom:8px">Recent activity</h3>
      ${d.activity.length ? d.activity.map((e) => activityItem(e)).join('') : '<div class="muted">Nothing yet.</div>'}</div>`;
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
