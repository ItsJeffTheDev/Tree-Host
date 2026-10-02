'use strict';
// Moderation in the browser.
// Staff: "Take action" (warn, suspend, ban, delete accounts and servers, with a reason and evidence), messages to
// customers, and the Action logs page (look up an action number, evidence, appeals, PDF reports, CSV export).
// Customers: the Tree Host inbox, the page shown to suspended or banned accounts, server notices and appeals.

const MOD_REASONS = {
  abuse: 'Harassment or abuse',
  cheating: 'Cheats, hacks or exploits',
  mining: 'Crypto mining',
  attack: 'Attacks, DDoS or scanning',
  illegal: 'Illegal or harmful content',
  eula: 'Minecraft EULA violation',
  spam: 'Spam or advertising',
  fraud: 'Fraud or chargeback',
  evasion: 'Ban evasion',
  security: 'Security risk',
  request: 'Requested by the customer',
  other: 'Other',
};
const MOD_TYPES = { warn: 'Warning', suspend: 'Suspension', ban: 'Ban', delete: 'Deletion' };
const MOD_STATUS = { active: ['Active', 'red'], lifted: ['Lifted', 'green'], expired: ['Ended', 'green'], done: ['Done', ''] };
const APPEAL_BADGE = { pending: ['Appeal waiting', 'yellow'], accepted: ['Appeal accepted', 'green'], denied: ['Appeal denied', ''] };
const when = (t) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
const badge = ([text, cls]) => `<span class="badge ${cls}">${text}</span>`;

/** Which actions this staff member may take on an account or a server. */
function allowedActions(target) {
  return Object.keys(MOD_TYPES).filter((t) =>
    t === 'delete' ? hasPerm(target === 'server' ? 'servers.destroy' : 'users.manage') : hasPerm(t === 'ban' ? 'moderation.ban' : 'moderation.act'),
  );
}
const canTakeAction = (target) => allowedActions(target).length > 0;

// ---------- evidence files: screenshots become JPEGs (they go into the PDF), text files stay text ----------

function imageToJpeg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.86).split(',')[1]);
    };
    img.onerror = () => reject(new Error(`"${file.name}" is not a picture we can read.`));
    img.src = url;
  });
}

async function readEvidence(files) {
  const out = [];
  for (const f of files) {
    if (f.type.startsWith('image/')) out.push({ kind: 'image', name: f.name.replace(/\.\w+$/, '.jpg'), data: await imageToJpeg(f) });
    else if (f.type.startsWith('text/') || /\.(txt|log|json|yml|yaml|properties|csv)$/i.test(f.name)) {
      if (f.size > 300 * 1024) throw new Error(`"${f.name}" is too big (300 KB at most for text files).`);
      out.push({ kind: 'text', name: f.name, text: await f.text() });
    } else throw new Error(`"${f.name}": attach screenshots (PNG, JPEG, WebP) or text files (.txt, .log).`);
  }
  return out;
}

const EVIDENCE_FIELD = `
  <label class="field">Evidence <span class="muted small">(screenshots or text/log files, they go into the report)</span>
    <input type="file" name="files" multiple accept="image/*,.txt,.log,.json,.yml,.yaml,.properties,.csv"></label>
  <div class="ev-picked small muted"></div>`;

function bindEvidencePicker(form) {
  const input = $('[name=files]', form);
  input.addEventListener('change', () => {
    $('.ev-picked', form).textContent = [...input.files].map((f) => `📎 ${f.name}`).join('   ');
  });
}

// ---------- Take action ----------

/**
 * opts: { target: 'account'|'server', user: { id, username, email }, server: { id, name, ownerName }, type, onDone }
 */
function openTakeAction(opts) {
  const { target } = opts;
  const types = allowedActions(target);
  if (!types.length) return toast("Your role can't take actions.", 'error');
  const subject = target === 'server' ? `the server "${esc(opts.server.name)}"${opts.server.ownerName ? ` (${esc(opts.server.ownerName)})` : ''}` : `${esc(opts.user.username)}${opts.user.email ? ` <span class="muted">(${esc(opts.user.email)})</span>` : ''}`;
  const effects = {
    warn: 'They get the message in their inbox and by email. Nothing else changes.',
    suspend: target === 'server' ? 'The server is stopped and can\'t be started until it ends or is lifted. Files are kept.' : 'They are locked out of their servers (which are stopped) until it ends or is lifted. They can still sign in to see why and appeal. Plans keep billing.',
    ban: target === 'server' ? "The server is stopped and can't be started again unless the ban is lifted." : 'They are locked out for good, their servers are stopped and their plans are canceled (no automatic refund). They can still sign in to appeal.',
    delete: target === 'server' ? 'The server and all its files are deleted. This cannot be undone. The console log is saved in the report first.' : 'The account, its servers and files are deleted and its plans are canceled. This cannot be undone. They are told by email.',
  };
  const { root, close } = openModal(`
    <h2>🛡️ Take action on ${subject}</h2>
    <form id="ta-form" class="stack">
      <div class="row" style="flex-wrap:wrap;gap:8px" id="ta-types">${types
        .map((t, i) => `<label class="ta-type"><input type="radio" name="type" value="${t}" ${(opts.type ? t === opts.type : i === 0) ? 'checked' : ''}> ${{ warn: '⚠️ Warn', suspend: '⏸️ Suspend', ban: '⛔ Ban', delete: '🗑️ Delete' }[t]}</label>`)
        .join('')}</div>
      <div class="warn-box" id="ta-effect"></div>
      <div class="grid2">
        <label class="field">Reason <select name="reason" required><option value="">Pick a reason…</option>${Object.entries(MOD_REASONS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <label class="field" id="ta-days">How long
          <select name="days"><option value="1">1 day</option><option value="3">3 days</option><option value="7" selected>7 days</option><option value="14">14 days</option><option value="30">30 days</option><option value="90">90 days</option><option value="0">Until lifted</option></select></label>
      </div>
      <label class="field">Message to the customer <span class="muted small">(they see this: what they did and what happens now)</span>
        <textarea name="message" rows="4" required minlength="10" placeholder="e.g. Your server was running a crypto miner, which our Terms of Service don't allow."></textarea></label>
      <label class="field">Staff notes <span class="muted small">(never shown to the customer: tickets, who reported it, what you checked)</span>
        <textarea name="notes" rows="3" placeholder="e.g. Reported in ticket #42. CPU at 100% for 6 hours, found xmrig in /plugins."></textarea></label>
      ${EVIDENCE_FIELD}
      ${(() => {
        const linked = target === 'account' ? (opts.user.linked || []).filter((l) => l.role === 'customer') : [];
        return linked.length ? `<div class="linked-box">
        <label class="check"><input type="checkbox" name="includeLinked" checked>
          <span><b>Also apply to ${linked.length} linked account${linked.length === 1 ? '' : 's'}</b> (used on the same device):
          ${linked.map((l) => esc(l.username)).join(', ')}. Each gets its own action number.</span></label></div>` : '';
      })()}
      <div class="stack" style="gap:6px">
        <label class="check"><input type="checkbox" name="includeLog" checked> Save the console log${target === 'server' ? '' : 's of their servers'} as evidence</label>
        <label class="check"><input type="checkbox" name="appealable" checked> They can appeal</label>
        <label class="check"><input type="checkbox" name="email" checked> Also email them${opts.user && opts.user.email ? ` (${esc(opts.user.email)})` : ''}</label>
      </div>
      <div class="modal-actions" style="margin-top:4px"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="ta-go">Take action</button></div>
    </form>`);
  const form = $('#ta-form', root);
  bindEvidencePicker(form);
  const sync = () => {
    const t = form.type.value;
    $('#ta-effect', root).textContent = effects[t];
    $('#ta-days', root).classList.toggle('hidden', t !== 'suspend');
    const go = $('#ta-go', root);
    go.textContent = { warn: 'Send warning', suspend: 'Suspend', ban: 'Ban', delete: 'Delete for good' }[t];
    go.classList.toggle('danger', t === 'ban' || t === 'delete');
    go.classList.toggle('primary', !(t === 'ban' || t === 'delete'));
  };
  form.addEventListener('change', sync);
  sync();
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const t = form.type.value;
    if ((t === 'ban' || t === 'delete') && !confirm(`${MOD_TYPES[t]} ${target === 'server' ? `the server "${opts.server.name}"` : opts.user.username}?\n\n${effects[t]}`)) return;
    attempt(async () => {
      $('#ta-go', root).disabled = true;
      try {
        const evidence = await readEvidence([...form.files.files]);
        const a = await api('POST', '/api/admin/actions', {
          target, type: t, userId: opts.user && opts.user.id, serverId: opts.server && opts.server.id,
          reason: form.reason.value, days: Number(form.days.value), message: form.message.value, notes: form.notes.value,
          includeLog: form.includeLog.checked, appealable: form.appealable.checked, email: form.email.checked, evidence,
          includeLinked: form.includeLinked ? form.includeLinked.checked : false,
        });
        close();
        toast(`Done: action ${a.id}${a.linked && a.linked.length ? ` (+ ${a.linked.length} linked account${a.linked.length === 1 ? '' : 's'}: ${a.linked.join(', ')})` : ''}. Look it up any time in Action logs.`);
        if (opts.onDone) opts.onDone(a);
      } finally {
        const b = $('#ta-go', root);
        if (b) b.disabled = false;
      }
    });
  });
}

/** A message to someone's Tree Host inbox (and email). */
function openSendMessage(user) {
  const { root, close } = openModal(`
    <h2>✉️ Message ${esc(user.username)}</h2>
    <form id="sm-form" class="stack">
      <label class="field">Subject <input type="text" name="title" maxlength="200" required placeholder="e.g. About your server's lag"></label>
      <label class="field">Message <textarea name="body" rows="6" required></textarea></label>
      <label class="check"><input type="checkbox" name="email" checked> Also email it${user.email ? ` to ${esc(user.email)}` : ''}</label>
      <p class="hint" style="margin:0">It arrives in their Tree Host inbox, signed with your name and role.</p>
      <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Send</button></div>
    </form>`);
  $('#sm-form', root).addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    attempt(async () => {
      await api('POST', '/api/admin/messages', { userId: user.id, title: f.title.value, body: f.body.value, email: f.email.checked });
      toast(`Message sent to ${user.username}`);
      close();
    });
  });
}

/** "banned · TH-000012" for an account or server (clickable for staff who can see actions). */
function restrictionBadge(r) {
  if (!r) return '';
  const label = `${r.type}${r.actionId ? ` · ${r.actionId}` : ''}`;
  return r.actionId && hasPerm('moderation.view')
    ? ` <a href="/admin#actions/${esc(r.actionId)}" class="badge red" title="Open the action">${esc(label)}</a>`
    : ` <span class="badge red">${esc(label)}</span>`;
}

// ---------- Staff Console: Action logs ----------

const TYPE_CHIP = { warn: '⚠️ Warnings', suspend: '⏸️ Suspensions', ban: '⛔ Bans', delete: '🗑️ Deletions' };
const isoDay = (d) => d.toISOString().slice(0, 10);

/** Every action taken, filtered by type, action number, username, email, staff member, server, reason, status, appeal and date. */
async function consoleActions(body, sub) {
  // Filters stay while you move around the console (this tab only).
  let f = {};
  try {
    f = JSON.parse(sessionStorage.getItem('th.actionLogs') || '{}');
  } catch {}
  const types = new Set((f.types || '').split(',').filter(Boolean));
  const field = (name, label, attrs = '') => `<label class="field">${label}<input type="search" name="${name}" value="${esc(f[name] || '')}" ${attrs}></label>`;
  const sel = (name, label, options) => `<label class="field">${label}<select name="${name}">${options.map(([v, l]) => `<option value="${v}" ${(f[name] || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
  body.innerHTML = `
    <div class="card">
      <form id="act-lookup" class="row" style="flex-wrap:wrap">
        <input type="search" name="id" placeholder="Go to an action number, e.g. TH-000012 or 12" style="max-width:340px">
        <button class="btn primary">Open</button>
      </form>
    </div>
    <form class="card stack" id="act-filters" autocomplete="off">
      <div class="row" style="flex-wrap:wrap;gap:8px">
        <button type="button" class="chip" data-type="">All actions <span class="muted" data-count="all"></span></button>
        ${Object.entries(TYPE_CHIP).map(([t, l]) => `<button type="button" class="chip" data-type="${t}">${l} <span class="muted" data-count="${t}"></span></button>`).join('')}
      </div>
      <div class="log-grid">
        ${field('id', 'Action number', 'placeholder="TH-000012"')}
        ${field('username', 'Username', 'placeholder="Customer username"')}
        ${field('email', 'Email', 'placeholder="customer@example.com"')}
        ${field('by', 'Taken by', 'placeholder="Staff member"')}
        ${field('server', 'Server', 'placeholder="Server name or ID"')}
        ${sel('reason', 'Reason', [['', 'Any reason'], ...Object.entries(MOD_REASONS)])}
        ${sel('target', 'On', [['', 'Accounts and servers'], ['account', 'Accounts'], ['server', 'Servers']])}
        ${sel('status', 'Status', [['', 'Any status'], ...Object.entries(MOD_STATUS).map(([k, [l]]) => [k, l])])}
        ${sel('appeal', 'Appeal', [['', 'Any'], ['pending', 'Waiting for a decision'], ['any', 'Has an appeal'], ['none', 'No appeal']])}
        <label class="field">From<input type="date" name="from" value="${esc(f.from || '')}"></label>
        <label class="field">To<input type="date" name="to" value="${esc(f.to || '')}"></label>
        ${sel('sort', 'Order', [['', 'Newest first'], ['oldest', 'Oldest first']])}
      </div>
      <div class="row" style="flex-wrap:wrap;gap:8px">
        <span class="small muted">Dates:</span>
        <button type="button" class="btn sm" data-range="0">Today</button>
        <button type="button" class="btn sm" data-range="7">Last 7 days</button>
        <button type="button" class="btn sm" data-range="30">Last 30 days</button>
        <button type="button" class="btn sm" data-range="all">All time</button>
        <span style="flex:1"></span>
        <button type="button" class="btn sm" id="act-clear">Clear filters</button>
        <a class="btn sm" id="act-csv" download>⬇ Export these (CSV)</a>
      </div>
    </form>
    <div class="small muted" id="act-count" style="margin:0 0 8px"></div>
    <div class="card" id="act-list"><div class="muted">Loading...</div></div>`;
  const form = $('#act-filters', body);
  const query = () => {
    const out = {};
    for (const el of form.elements) if (el.name && el.value.trim()) out[el.name] = el.value.trim();
    if (types.size) out.types = [...types].join(',');
    return out;
  };
  const syncChips = () => $$('[data-type]', form).forEach((c) => c.classList.toggle('on', c.dataset.type ? types.has(c.dataset.type) : !types.size));
  const draw = async () => {
    const qs = query();
    try {
      sessionStorage.setItem('th.actionLogs', JSON.stringify(qs));
    } catch {}
    const params = new URLSearchParams(qs);
    $('#act-csv', body).href = `/api/admin/actions.csv?${params}`;
    const d = await api('GET', `/api/admin/actions?${params}`);
    $('[data-count="all"]', form).textContent = d.total;
    for (const t of Object.keys(TYPE_CHIP)) $(`[data-count="${t}"]`, form).textContent = d.counts[t];
    const filtered = Object.keys(qs).some((k) => k !== 'sort');
    $('#act-count', body).textContent = `${d.actions.length} of ${d.total} action${d.total === 1 ? '' : 's'}${filtered ? ' match your filters' : ''}${d.pendingAppeals ? ` · ${d.pendingAppeals} appeal${d.pendingAppeals === 1 ? '' : 's'} waiting` : ''}`;
    $('#act-list', body).innerHTML = d.actions.length
      ? `<table><thead><tr><th>Action</th><th>Customer</th><th>Reason</th><th>Taken by</th><th>Date</th><th>Status</th><th></th></tr></thead><tbody>${d.actions
          .map((a) => `<tr>
            <td><b>${esc(a.id)}</b><div class="small muted">${MOD_TYPES[a.type]} · ${a.target === 'server' ? `🖥️ ${esc(a.server ? a.server.name : 'server')}` : '👤 account'}</div></td>
            <td class="small">${a.customer.username ? `<a href="#" data-filter="username" data-val="${esc(a.customer.username)}" title="Show every action for ${esc(a.customer.username)}">${esc(a.customer.username)}</a>` : '-'}${a.customer.email ? `<div><a href="#" class="muted" data-filter="email" data-val="${esc(a.customer.email)}">${esc(a.customer.email)}</a></div>` : ''}</td>
            <td class="small">${esc(a.reasonLabel)}${a.evidence ? `<div class="muted">📎 ${a.evidence} evidence</div>` : ''}</td>
            <td class="small"><a href="#" data-filter="by" data-val="${esc(a.by)}" title="Show every action by ${esc(a.by)}">${esc(a.by)}</a></td>
            <td class="small">${when(a.createdAt)}</td>
            <td>${badge(MOD_STATUS[a.status])}${a.appeal ? ` ${badge(APPEAL_BADGE[a.appeal])}` : ''}</td>
            <td class="actions-cell"><button class="btn sm primary" data-open-act="${esc(a.id)}">Open</button></td></tr>`)
          .join('')}</tbody></table>`
      : `<p class="muted" style="margin:0">${d.total ? 'No actions match these filters.' : 'No actions have been taken yet.'}</p>`;
    $$('[data-open-act]', body).forEach((b) => b.addEventListener('click', () => openActionDetail(b.dataset.openAct, draw)));
    $$('[data-filter]', body).forEach((l) => l.addEventListener('click', (e) => {
      e.preventDefault();
      form.elements[l.dataset.filter].value = l.dataset.val;
      redraw();
    }));
  };
  const redraw = () => draw().catch((err) => toast(err.message, 'error'));
  let timer;
  form.addEventListener('input', (e) => {
    if (e.target.type !== 'search') return;
    clearTimeout(timer);
    timer = setTimeout(redraw, 300);
  });
  form.addEventListener('change', (e) => e.target.type !== 'search' && redraw());
  form.addEventListener('submit', (e) => e.preventDefault());
  $$('[data-type]', form).forEach((c) => c.addEventListener('click', () => {
    if (!c.dataset.type) types.clear();
    else if (types.has(c.dataset.type)) types.delete(c.dataset.type);
    else types.add(c.dataset.type);
    syncChips();
    redraw();
  }));
  $$('[data-range]', form).forEach((b) => b.addEventListener('click', () => {
    const r = b.dataset.range;
    form.elements.from.value = r === 'all' ? '' : isoDay(new Date(Date.now() - Number(r) * 86400000));
    form.elements.to.value = r === 'all' ? '' : isoDay(new Date());
    redraw();
  }));
  $('#act-clear', body).addEventListener('click', () => {
    for (const el of form.elements) if (el.name) el.value = '';
    types.clear();
    syncChips();
    redraw();
  });
  $('#act-lookup', body).addEventListener('submit', (e) => {
    e.preventDefault();
    let id = e.target.id.value.trim().toUpperCase();
    if (/^\d+$/.test(id)) id = `TH-${id.padStart(6, '0')}`;
    if (id) openActionDetail(id, draw);
  });
  syncChips();
  await draw();
  if (sub) openActionDetail(decodeURIComponent(sub).toUpperCase(), draw);
}

async function openActionDetail(id, onChange) {
  let a;
  try {
    a = await api('GET', `/api/admin/actions/${encodeURIComponent(id)}`);
  } catch (e) {
    return toast(e.message, 'error');
  }
  const c = a.customer || {};
  const ev = (e) => {
    const src = `/api/admin/actions/${encodeURIComponent(a.id)}/evidence/${e.id}`;
    const meta = `<div class="small muted">${{ image: 'Screenshot', text: 'Text file', log: 'Console log', note: 'Note' }[e.kind]} · ${esc(e.addedBy)} · ${when(e.addedAt)}</div>`;
    if (e.kind === 'image') return `<div class="ev-item"><a href="${src}" target="_blank"><img src="${src}" alt="${esc(e.name)}" loading="lazy"></a><b class="small">${esc(e.name)}</b>${meta}</div>`;
    if (e.kind === 'note') return `<div class="ev-item ev-text"><b class="small">📝 ${esc(e.name)}</b>${meta}<div class="small pre">${esc(e.text)}</div></div>`;
    return `<div class="ev-item ev-text"><b class="small">📄 ${esc(e.name)}</b>${meta}<a class="btn sm" href="${src}" target="_blank">Open</a></div>`;
  };
  const canLift = a.status === 'active' && hasPerm(a.type === 'ban' ? 'moderation.ban' : 'moderation.act');
  const canDecide = a.appeal && a.appeal.status === 'pending' && hasPerm('moderation.appeals');
  const pdf = `/api/admin/actions/${encodeURIComponent(a.id)}/report.pdf`;
  const { root, close } = openModal(`
    <div class="row" style="flex-wrap:wrap;align-items:center;margin-bottom:12px">
      <h2 style="margin:0">${esc(a.id)}</h2>
      ${badge(MOD_STATUS[a.status])} ${a.appeal ? badge(APPEAL_BADGE[a.appeal.status]) : ''}
      <span style="flex:1"></span>
      <a class="btn" href="${pdf}" target="_blank">📄 View PDF report</a>
      <a class="btn primary" href="${pdf}?download=1">⬇ Download PDF</a>
    </div>
    <div class="card">
      <div class="kv">
        <span>Action</span><b>${esc(a.typeLabel)} of the ${a.target === 'server' ? `server "${esc(a.server.name)}"` : 'account'}</b>
        <span>Reason</span><b>${esc(a.reasonLabel)}</b>
        <span>Taken</span><b>${when(a.createdAt)} by ${esc(a.by.username)} (${esc(a.by.roleLabel || a.by.role)})</b>
        ${a.type === 'suspend' ? `<span>Ends</span><b>${a.until ? when(a.until) : 'When lifted'}</b>` : ''}
        <span>Customer</span><b>${esc(c.username || '-')}${c.email ? ` · ${esc(c.email)}` : ''} <span class="muted small">(${esc(c.id || '')})</span></b>
        <span>At the time</span><b class="small">${c.plans && c.plans.length ? esc(c.plans.join(', ')) : 'no plans'} · ${c.servers ? c.servers.length : 0} server(s)${c.previous && c.previous.length ? ` · earlier: ${esc(c.previous.join(', '))}` : ''}</b>
        <span>Told by</span><b>${[a.notified.inbox && 'inbox', a.notified.email && 'email'].filter(Boolean).join(' and ') || 'not notified'}</b>
        ${a.parentId ? `<span>Linked to</span><b><a href="#" data-goto="${esc(a.parentId)}">${esc(a.parentId)}</a> <span class="muted small">(same device)</span></b>` : ''}
        ${a.linked && a.linked.length ? `<span>Linked accounts</span><b>${a.linked.map((id) => `<a href="#" data-goto="${esc(id)}">${esc(id)}</a>`).join(', ')}</b>` : ''}
      </div>
    </div>
    <div class="card"><h3>Message shown to the customer</h3><div class="pre">${esc(a.message)}</div></div>
    ${a.notes ? `<div class="card note-card"><h3>Staff notes</h3><div class="pre">${esc(a.notes)}</div></div>` : ''}
    <div class="card"><h3>Evidence (${a.evidence.length})</h3>
      <div class="ev-grid">${a.evidence.map(ev).join('') || '<p class="muted" style="margin:0">None attached.</p>'}</div>
      ${hasPerm('moderation.act') ? `<form id="ad-ev" class="stack" style="margin-top:12px">${EVIDENCE_FIELD}
        <textarea name="note" rows="2" placeholder="Or write a note to add to the evidence"></textarea>
        <div><button class="btn sm">Add to the evidence</button></div></form>` : ''}
    </div>
    ${a.appeal ? `<div class="card"><h3>Appeal <span class="muted small">sent ${when(a.appeal.at)}</span></h3>
        <div class="pre">${esc(a.appeal.text)}</div>
        ${a.appeal.status !== 'pending' ? `<p class="small" style="margin:10px 0 0"><b>${a.appeal.status === 'accepted' ? 'Accepted' : 'Denied'}</b> by ${esc(a.appeal.decidedBy)} on ${when(a.appeal.decidedAt)}:</p><div class="pre small">${esc(a.appeal.response)}</div>` : ''}
        ${canDecide ? `<form id="ad-appeal" class="stack" style="margin-top:12px">
          <textarea name="response" rows="3" required placeholder="Your answer to the customer (they see this)"></textarea>
          <div class="row"><button class="btn primary" value="accept">Accept${a.status === 'active' ? ' and lift' : ''}</button><button class="btn danger" value="deny">Deny</button></div></form>` : ''}
      </div>` : ''}
    ${canLift ? `<div class="card"><h3>Lift this ${a.type === 'ban' ? 'ban' : 'suspension'}</h3>
        <form id="ad-lift" class="row" style="flex-wrap:wrap"><input type="text" name="reason" required minlength="5" placeholder="Why (the customer sees this)" style="flex:1;min-width:220px"><button class="btn">Lift</button></form></div>` : ''}
    ${a.lifted ? `<div class="card"><h3>${a.status === 'expired' ? 'Ended' : 'Lifted'}</h3><p class="small" style="margin:0">${when(a.lifted.at)} by ${esc(a.lifted.by)}${a.lifted.reason ? `: ${esc(a.lifted.reason)}` : ''}</p></div>` : ''}
    <div class="card"><h3>Timeline</h3>${a.history.map((h) => `<div class="small"><span class="muted">${when(h.at)}</span> · ${esc(h.text)} <span class="muted">(${esc(h.by)})</span></div>`).join('')}</div>
    <div class="modal-actions"><button class="btn" data-close>Close</button></div>`);
  const refresh = () => {
    close();
    if (onChange) onChange();
    openActionDetail(a.id, onChange);
  };
  $$('[data-goto]', root).forEach((l) => l.addEventListener('click', (e) => {
    e.preventDefault();
    close();
    openActionDetail(l.dataset.goto, onChange);
  }));
  const evForm = $('#ad-ev', root);
  if (evForm) {
    bindEvidencePicker(evForm);
    evForm.addEventListener('submit', (e) => {
      e.preventDefault();
      attempt(async () => {
        const items = await readEvidence([...evForm.files.files]);
        if (evForm.note.value.trim()) items.push({ kind: 'note', name: 'Note', text: evForm.note.value.trim() });
        if (!items.length) throw new Error('Pick a file or write a note first.');
        await api('POST', `/api/admin/actions/${encodeURIComponent(a.id)}/evidence`, { evidence: items });
        toast('Evidence added');
        refresh();
      });
    });
  }
  const appealForm = $('#ad-appeal', root);
  if (appealForm) {
    appealForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const decision = e.submitter && e.submitter.value;
      if (decision === 'deny' && !confirm('Deny this appeal? The customer gets your answer.')) return;
      attempt(async () => {
        await api('POST', `/api/admin/actions/${encodeURIComponent(a.id)}/appeal`, { decision, response: appealForm.response.value });
        toast(`Appeal ${decision === 'accept' ? 'accepted' : 'denied'}`);
        refresh();
      });
    });
  }
  const liftForm = $('#ad-lift', root);
  if (liftForm) {
    liftForm.addEventListener('submit', (e) => {
      e.preventDefault();
      attempt(async () => {
        await api('POST', `/api/admin/actions/${encodeURIComponent(a.id)}/lift`, { reason: liftForm.reason.value });
        toast(`${a.id} lifted`);
        refresh();
      });
    });
  }
}

// ---------- customers: inbox, appeals, the suspended/banned page ----------

let inboxCache = null;

async function refreshInboxBadge(announce = false) {
  if (!isTeam() || !state.me.user) return;
  try {
    inboxCache = await api('GET', '/api/inbox');
  } catch {
    return;
  }
  const el = $('#inbox-count');
  if (el) {
    el.textContent = inboxCache.unread || '';
    el.classList.toggle('hidden', !inboxCache.unread);
  }
  if (announce && inboxCache.unread) {
    toast(`📬 You have ${inboxCache.unread} new message${inboxCache.unread === 1 ? '' : 's'} from Tree Host. Open your Inbox.`);
  }
}

async function openInbox(focusAction) {
  const [inbox, mine] = await Promise.all([api('GET', '/api/inbox'), api('GET', '/api/moderation/mine')]);
  const actions = new Map(mine.actions.map((x) => [x.id, x]));
  const { root, close } = openModal(`
    <h2>📬 Inbox</h2>
    <p class="hint" style="margin-top:-8px">Messages from the Tree Host team. Questions? Write to <a href="mailto:${esc(mine.supportEmail || '')}">${esc(mine.supportEmail || '')}</a>.</p>
    <div class="stack" id="inbox-list">${
      inbox.messages.length
        ? inbox.messages.map((m) => inboxItem(m, actions.get(m.actionId))).join('')
        : '<div class="card"><p class="muted" style="margin:0">No messages yet.</p></div>'
    }</div>
    <div class="modal-actions"><button class="btn" data-close>Close</button></div>`);
  bindAppealButtons(root, actions, () => {
    close();
    openInbox();
  });
  if (inbox.unread) {
    api('POST', '/api/inbox/read', {}).then(() => refreshInboxBadge()).catch(() => {});
  }
  if (focusAction) {
    const b = $(`[data-appeal="${focusAction}"]`, root);
    if (b) b.scrollIntoView({ block: 'center' });
  }
}

function inboxItem(m, a) {
  return `<div class="card inbox-item ${m.read ? '' : 'unread'}">
    <div class="row" style="align-items:baseline;flex-wrap:wrap"><b>${esc(m.title)}</b><span style="flex:1"></span><span class="small muted">${when(m.createdAt)}</span></div>
    <div class="pre small" style="margin-top:6px">${esc(m.body)}</div>
    ${a ? actionFooter(a) : ''}
  </div>`;
}

/** Action number, status, and the appeal button or appeal status. */
function actionFooter(a) {
  const state2 = a.status === 'active' ? (a.until ? `until ${when(a.until)}` : 'active') : a.status === 'done' ? '' : a.status === 'expired' ? 'ended' : 'lifted';
  return `<div class="row small" style="margin-top:10px;flex-wrap:wrap;align-items:center">
    <span class="badge">${esc(a.id)}</span>${state2 ? `<span class="muted">${esc(a.typeLabel)} ${esc(state2)}</span>` : ''}
    <span style="flex:1"></span>
    ${a.appeal
      ? `${badge(APPEAL_BADGE[a.appeal.status])}`
      : a.appealable ? `<button class="btn sm primary" data-appeal="${esc(a.id)}">Appeal</button>` : ''}
  </div>
  ${a.appeal && a.appeal.response ? `<div class="small" style="margin-top:6px"><b>Our answer:</b> ${esc(a.appeal.response)}</div>` : ''}`;
}

function bindAppealButtons(root, actions, after) {
  $$('[data-appeal]', root).forEach((b) => b.addEventListener('click', () => openAppeal(actions.get(b.dataset.appeal), after)));
}

function openAppeal(a, after) {
  const { root, close } = openModal(`
    <h2>Appeal ${esc(a.id)}</h2>
    <div class="card"><b>${esc(a.typeLabel)}${a.server ? ` of "${esc(a.server.name)}"` : ''}</b> · ${esc(a.reasonLabel)}<div class="pre small" style="margin-top:6px">${esc(a.message)}</div></div>
    <form id="ap-form" class="stack">
      <label class="field">Why do you think this was a mistake?
        <textarea name="text" rows="6" required minlength="20" placeholder="Tell us what happened. A member of our team will read it and answer you here and by email."></textarea></label>
      <p class="hint" style="margin:0">You can appeal each action once, so include everything that matters.</p>
      <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Send appeal</button></div>
    </form>`);
  $('#ap-form', root).addEventListener('submit', (e) => {
    e.preventDefault();
    attempt(async () => {
      await api('POST', `/api/moderation/${encodeURIComponent(a.id)}/appeal`, { text: e.target.text.value });
      toast("Appeal sent. We'll answer in your inbox and by email.");
      close();
      if (after) after();
    });
  });
}

/** The whole page for a suspended or banned account: why, the action number, the appeal, and the inbox. */
async function showRestricted() {
  const [mine, inbox] = await Promise.all([api('GET', '/api/moderation/mine'), api('GET', '/api/inbox')]);
  const r = mine.restriction;
  const a = r.action;
  const actions = new Map(mine.actions.map((x) => [x.id, x]));
  document.title = `Account ${r.type} · Tree Host`;
  $('.app').classList.add('app-restricted');
  $('.app').innerHTML = `
    <div class="restricted-page">
      <div class="brand" style="margin-bottom:22px"><div class="logo"></div><div><div class="brand-name">Tree Host</div><div class="brand-sub">${esc(state.me.user.username)}</div></div></div>
      <div class="card restricted-card">
        <div class="restricted-icon">${r.type === 'banned' ? '⛔' : '⏸️'}</div>
        <h1>Your account is ${r.type}</h1>
        ${r.type === 'suspended' ? `<p class="lead">${r.until ? `Until <b>${when(r.until)}</b>. After that, everything works again by itself.` : 'Until our team lifts the suspension.'} Your servers and files are kept.</p>`
          : '<p class="lead">You can no longer use Tree Host. If you think this is a mistake, you can appeal below.</p>'}
        ${a ? `<div class="kv" style="margin:14px 0">
            <span>Reason</span><b>${esc(a.reasonLabel)}</b>
            <span>Date</span><b>${when(a.createdAt)}</b>
            <span>Action number</span><b>${esc(a.id)}</b></div>
          <div class="card" style="margin:0 0 14px"><div class="pre">${esc(a.message)}</div></div>
          ${actionFooter(a)}` : `<p class="muted">Contact <a href="mailto:${esc(mine.supportEmail)}">${esc(mine.supportEmail)}</a> to find out more.</p>`}
      </div>
      <h3 style="margin:22px 0 10px">📬 Messages from Tree Host</h3>
      <div class="stack">${inbox.messages.map((m) => inboxItem(m, actions.get(m.actionId))).join('') || '<p class="muted">No messages.</p>'}</div>
      <div class="row" style="margin-top:22px;flex-wrap:wrap">
        <a class="btn" href="mailto:${esc(mine.supportEmail)}">✉️ Email support</a>
        <button class="btn" id="rs-switch">⇄ Switch account</button>
        <button class="btn" id="rs-logout">Sign out</button>
        <a class="btn" href="/terms" target="_blank">Terms of Service</a>
      </div>
    </div>`;
  bindAppealButtons($('.app'), actions, () => showRestricted());
  $('#rs-logout').addEventListener('click', () => signOut(false));
  $('#rs-switch').addEventListener('click', () => openAccountSwitcher().catch((e) => toast(e.message, 'error')));
  if (inbox.unread) api('POST', '/api/inbox/read', {}).catch(() => {});
}

/** The notice on a suspended or banned server's page (owner: why and appeal; staff: link to the action). */
function serverModerationBox(s) {
  const m = s.moderation;
  if (!m) return '';
  const staffView = !isCustomer() && hasPerm('moderation.view');
  return `<div class="suspended-box">${m.type === 'banned' ? '⛔' : '⏸️'} This server is <b>${esc(m.type)}</b> by Tree Host staff${m.until ? ` until ${when(m.until)}` : ''} (action ${esc(m.actionId)}).
    ${staffView ? `<a href="/admin#actions/${esc(m.actionId)}">Open the action</a>` : `<a href="#" data-mod-inbox="${esc(m.actionId)}">See why / appeal</a>`}</div>`;
}
