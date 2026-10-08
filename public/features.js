'use strict';
// Server-page features added on top of app.js: the Players tab, the lag doctor, plugin updates and the upgrade
// assistant, restoring single files from backups, world tools, free subdomains, Discord, and the live map.
// Loaded before app.js; app.js calls these when their tab or card is shown. Staff can use them on anyone's server
// (the server checks the same permissions as everywhere else: src/server.js getFor).

const fmtDur = (ms) => {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} days ${h % 24} h`;
};
const head = (name, size = 32) => `<img class="pl-head" src="https://mc-heads.net/avatar/${encodeURIComponent(name)}/${size}" width="${size}" height="${size}" alt="" loading="lazy">`;

// =====================================================================================================
// Players tab
// =====================================================================================================

async function renderPlayers(body) {
  const s = current();
  body.innerHTML = '<div class="muted">Loading players…</div>';
  const d = await api('GET', `/api/servers/${s.id}/players`);
  if (current() !== s || state.tab !== 'players') return;
  const act = can('command', s) && d.running;
  const btn = (action, name, label, cls = '') => (act ? `<button class="btn sm ${cls}" data-pa="${action}" data-name="${esc(name)}">${label}</button>` : '');
  const isOp = (n) => d.ops.some((x) => x.toLowerCase() === n.toLowerCase());
  const isWl = (n) => d.whitelist.some((x) => x.toLowerCase() === n.toLowerCase());
  body.innerHTML = `
    ${!d.running ? '<div class="warn-box">The server is stopped. Start it to kick, ban, op or whitelist players (the lists below are read from its files).</div>' : ''}
    <div class="card stack">
      <div class="row" style="justify-content:space-between;align-items:center"><h3 style="margin:0">${ic('users')} Online now <span class="muted small">(${d.online.length})</span></h3>
        ${act ? `<button class="btn sm" data-pa="${d.whitelistOn ? 'whitelist-off' : 'whitelist-on'}" data-name="">${d.whitelistOn ? 'Turn whitelist off' : 'Turn whitelist on'}</button>` : ''}</div>
      ${d.online.length
        ? `<div class="pl-online">${d.online.map((p) => `<div class="pl-card">${head(p.name, 40)}<div class="pl-info"><b>${esc(p.name)}</b>
            <span class="muted small">${p.since ? `online for ${fmtDur(Date.now() - p.since)}` : 'online'}${isOp(p.name) ? ' · op' : ''}</span></div>
            <div class="row" style="gap:6px;flex-wrap:wrap">${btn('kick', p.name, 'Kick')}${btn(isOp(p.name) ? 'deop' : 'op', p.name, isOp(p.name) ? 'De-op' : 'Op')}${btn('ban', p.name, 'Ban', 'danger')}</div></div>`).join('')}</div>`
        : '<p class="muted" style="margin:0">Nobody is online right now.</p>'}
    </div>
    ${act ? `<form class="card row" id="pl-add" style="align-items:flex-end;flex-wrap:wrap;gap:10px">
        <label class="field" style="flex:1;min-width:180px">Player name <input name="name" maxlength="16" placeholder="Steve" required></label>
        <button class="btn" data-add="whitelist-add">Add to whitelist</button><button class="btn" data-add="op">Make op</button><button class="btn danger" data-add="ban">Ban</button></form>` : ''}
    <div class="grid2">
      <div class="card stack"><h3 style="margin:0">Whitelist <span class="muted small">(${d.whitelistOn ? 'on' : 'off'})</span></h3>
        ${d.whitelist.length ? d.whitelist.map((n) => `<div class="pl-row">${head(n, 20)}<span>${esc(n)}</span>${btn('whitelist-remove', n, 'Remove')}</div>`).join('') : '<p class="muted small" style="margin:0">Nobody yet.</p>'}</div>
      <div class="card stack"><h3 style="margin:0">Operators</h3>
        ${d.ops.length ? d.ops.map((n) => `<div class="pl-row">${head(n, 20)}<span>${esc(n)}</span>${btn('deop', n, 'De-op')}</div>`).join('') : '<p class="muted small" style="margin:0">No ops.</p>'}</div>
    </div>
    <div class="card stack"><h3 style="margin:0">Bans</h3>
      ${d.bans.length ? d.bans.map((b) => `<div class="pl-row">${head(b.name, 20)}<span><b>${esc(b.name)}</b> <span class="muted small">${esc(b.reason)}</span></span>${btn('pardon', b.name, 'Unban')}</div>`).join('') : '<p class="muted small" style="margin:0">Nobody is banned.</p>'}</div>
    <div class="card stack"><h3 style="margin:0">Everyone who has played <span class="muted small">(${d.known.length})</span></h3>
      ${d.known.length ? `<table><thead><tr><th>Player</th><th>Playtime</th><th>Visits</th><th>First seen</th><th>Last seen</th></tr></thead><tbody>
        ${d.known.map((p) => `<tr><td>${head(p.name, 20)} ${esc(p.name)} ${p.online ? '<span class="badge green">online</span>' : ''}</td><td>${fmtDur(p.playMs)}</td><td>${p.sessions || 0}</td>
          <td class="small muted">${p.first ? new Date(p.first).toLocaleDateString() : ''}</td><td class="small muted">${p.last ? timeAgo(p.last) : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="muted small" style="margin:0">Nobody has joined yet. Playtime is counted from now on.</p>'}</div>
    <div class="card stack"><div class="row" style="justify-content:space-between;align-items:center"><h3 style="margin:0">Chat log</h3>
      <input type="search" id="pl-chat-q" placeholder="Search name or message" style="max-width:240px"></div>
      <div class="pl-chat" id="pl-chat"></div></div>`;
  const drawChat = (q = '') => {
    const lines = d.chat.filter((c) => !q || c.name.toLowerCase().includes(q) || c.text.toLowerCase().includes(q)).slice(-150).reverse();
    $('#pl-chat', body).innerHTML = lines.length
      ? lines.map((c) => `<div><span class="muted small">${new Date(c.t).toLocaleString()}</span> <b>${esc(c.name)}</b> ${esc(c.text)}</div>`).join('')
      : `<p class="muted small" style="margin:0">${d.chat.length ? 'No messages match.' : 'No chat yet.'}</p>`;
  };
  drawChat();
  $('#pl-chat-q', body).addEventListener('input', (e) => drawChat(e.target.value.trim().toLowerCase()));
  const run = (action, name, reason) => attempt(async () => {
    if (action === 'ban' && reason === undefined) {
      reason = prompt(`Ban ${name}? You can add a reason (shown to them):`, '');
      if (reason === null) return;
    }
    await api('POST', `/api/servers/${s.id}/players/action`, { action, name, reason });
    toast(`Done: ${action.replace('-', ' ')} ${name}`.trim());
    setTimeout(() => state.tab === 'players' && renderPlayers(body), 1200); // the server needs a moment to write its files
  });
  $$('[data-pa]', body).forEach((b) => b.addEventListener('click', () => run(b.dataset.pa, b.dataset.name)));
  const form = $('#pl-add', body);
  if (form) $$('[data-add]', form).forEach((b) => b.addEventListener('click', (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    run(b.dataset.add, form.elements.name.value.trim());
  }));
}

// =====================================================================================================
// Lag doctor (on the Performance tab)
// =====================================================================================================

const LAG_COLORS = { bad: 'var(--danger)', warn: '#e3a008', info: 'var(--accent2, #4a9eff)', good: 'var(--accent)' };

/** The lag doctor card, added at the top of the Performance tab. */
async function lagDoctorCard(box, s) {
  if (s.kind === 'proxy') return;
  const last = await api('GET', `/api/servers/${s.id}/lag-doctor`).catch(() => null);
  const draw = (r, busy) => {
    box.innerHTML = `<div class="card stack lag-card">
      <div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <div><h3 style="margin:0">${ic('pulse')} Lag doctor</h3>
          <p class="muted small" style="margin:4px 0 0">Checks TPS, tick times, entities, memory and settings while the server runs, and explains what's slowing it down.</p></div>
        ${can('command', s) ? `<button class="btn primary sm" id="lag-run" ${busy || !s.running ? 'disabled' : ''}>${busy ? 'Checking… (about 10 s)' : r ? 'Check again' : 'Check for lag'}</button>` : ''}
      </div>
      ${!s.running && !r ? '<p class="muted small" style="margin:0">Start the server to check it.</p>' : ''}
      ${r ? `<div class="lag-nums">${[
        r.numbers.tps != null ? ['TPS', r.numbers.tps.toFixed(1)] : null,
        r.numbers.mspt ? ['ms a tick', r.numbers.mspt.avg.toFixed(1)] : null,
        r.numbers.entities != null ? ['entities', r.numbers.entities] : null,
        r.numbers.items != null ? ['dropped items', r.numbers.items] : null,
        r.numbers.memMaxMb ? ['memory', `${Math.round(r.numbers.memUsedMb || 0)} / ${r.numbers.memMaxMb} MB`] : null,
        ['view / sim distance', `${r.numbers.viewDistance} / ${r.numbers.simulationDistance}`],
      ].filter(Boolean).map(([k, v]) => `<div class="stat"><div class="stat-num">${esc(v)}</div><div class="stat-label">${esc(k)}</div></div>`).join('')}</div>
      ${r.findings.map((f, i) => `<div class="lag-item" style="border-left-color:${LAG_COLORS[f.severity]}">
        <div><b>${esc(f.title)}</b> <span class="muted small">${esc(f.detail)}</span></div>
        <div class="small">${ic('arrow')} ${esc(f.fix)}</div>
        ${f.action && f.action.type === 'command' && can('command', s) && s.running ? `<button class="btn sm" data-lag-cmd="${i}" style="margin-top:6px">${esc(f.action.label)}</button>` : ''}
        ${f.action && f.action.type === 'settings' && can('settings', s) ? '<button class="btn sm" data-lag-settings style="margin-top:6px">Open Settings</button>' : ''}
      </div>`).join('')}
      <p class="muted small" style="margin:0">Checked ${timeAgo(r.at)}.</p>` : ''}
    </div>`;
    const run = $('#lag-run', box);
    if (run) run.addEventListener('click', () => attempt(async () => {
      draw(r, true);
      try {
        draw(await api('POST', `/api/servers/${s.id}/lag-doctor`), false);
      } catch (e) {
        draw(r, false);
        throw e;
      }
    }));
    $$('[data-lag-cmd]', box).forEach((b) => b.addEventListener('click', () => attempt(async () => {
      const f = r.findings[Number(b.dataset.lagCmd)];
      await api('POST', `/api/servers/${s.id}/command`, { command: f.action.command });
      toast('Done.');
    })));
    $$('[data-lag-settings]', box).forEach((b) => b.addEventListener('click', () => $('.tab[data-tab="settings"]')?.click()));
  };
  draw(last, false);
}

// =====================================================================================================
// Plugin updates (Plugins tab) and the upgrade assistant (Settings → Server software)
// =====================================================================================================

async function pluginUpdatesCard(box, s) {
  const pending = s.pluginUpdate;
  const draw = (list, busy) => {
    const ups = (list || []).filter((p) => p.update);
    box.innerHTML = `<div class="card stack">
      <div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <h3 style="margin:0">${ic('refresh')} Updates</h3>
        <div class="row" style="gap:8px">
          ${list && ups.length > 1 && can('plugins', s) ? `<button class="btn sm primary" id="pu-all">Update all (${ups.length})</button>` : ''}
          <button class="btn sm" id="pu-check" ${busy ? 'disabled' : ''}>${busy ? 'Checking…' : list ? 'Check again' : 'Check for updates'}</button>
        </div>
      </div>
      ${pending ? `<div class="warn-box">Updated ${timeAgo(pending.at)}: ${pending.items.map((i) => esc(`${i.newFile} (${i.from} → ${i.to})`)).join(', ')}.
        ${s.running ? 'Restart to load it.' : ''} If the next start crashes, the old version comes back by itself.
        ${can('plugins', s) && !s.pid ? '<button class="btn sm" id="pu-undo" style="margin-left:6px">Undo now</button>' : ''}</div>` : ''}
      ${list ? (list.length ? list.map((p) => `<div class="pl-row">
          ${p.icon ? `<img src="${esc(p.icon)}" width="22" height="22" alt="" style="border-radius:4px">` : ic('puzzle')}
          <span><b>${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>` : esc(p.title)}</b>
            <span class="muted small">${p.onModrinth ? `${esc(p.current || '')}${p.update ? ` → <b>${esc(p.latest)}</b>` : ' · up to date'}` : 'not on Modrinth: update it from its own page'}</span></span>
          ${p.update && can('plugins', s) ? `<button class="btn sm" data-pu="${esc(p.file)}">Update</button>` : ''}
        </div>`).join('') : '<p class="muted small" style="margin:0">No plugins installed.</p>')
        : '<p class="muted small" style="margin:0">Checks Modrinth for newer versions that fit this server type and Minecraft version, including plugins you uploaded yourself.</p>'}
    </div>`;
    $('#pu-check', box).addEventListener('click', () => attempt(async () => {
      draw(list, true);
      try {
        draw(await api('GET', `/api/servers/${s.id}/plugin-updates`), false);
      } catch (e) {
        draw(list, false);
        throw e;
      }
    }));
    const doUpdate = (files) => attempt(async () => {
      const r = await api('POST', `/api/servers/${s.id}/plugin-updates`, { files });
      toast(r.updated.length ? `Updated ${r.updated.length}. ${s.running ? 'Restart to load it.' : ''}` : 'Nothing to update.');
      renderTab();
    });
    $$('[data-pu]', box).forEach((b) => b.addEventListener('click', () => doUpdate([b.dataset.pu])));
    if ($('#pu-all', box)) $('#pu-all', box).addEventListener('click', () => doUpdate(null));
    if ($('#pu-undo', box)) $('#pu-undo', box).addEventListener('click', () => attempt(async () => {
      await api('POST', `/api/servers/${s.id}/plugin-updates/rollback`);
      toast('Update undone: the old version is back.');
      renderTab();
    }));
  };
  draw(null, false);
}

/** Under the version picker: check every plugin against the version you're about to switch to. */
function upgradeAssistant(box, s, getVersion) {
  if (!box) return;
  const draw = (r, busy) => {
    const v = getVersion();
    const changed = v && v !== s.version;
    box.innerHTML = changed || r ? `<div class="upgrade-box">
      <div class="row" style="justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <span>${ic('puzzle')} <b>Upgrade assistant</b> <span class="muted small">Do your plugins work on ${esc(v)}?</span></span>
        <button type="button" class="btn sm" id="ua-run" ${busy ? 'disabled' : ''}>${busy ? 'Checking…' : 'Check plugins'}</button></div>
      ${r ? `<p class="small" style="margin:8px 0 4px">${r.ok} ready · <b style="color:${r.missing ? 'var(--danger)' : 'inherit'}">${r.missing} without a ${esc(r.version)} version</b> · ${r.unknown} can't be checked</p>
        ${r.items.map((i) => `<div class="small ua-item ua-${i.status}">${i.status === 'ok' ? '✅' : i.status === 'missing' ? '⛔' : '❔'} <b>${esc(i.title)}</b> <span class="muted">${esc(i.note)}</span></div>`).join('')}
        ${r.items.some((i) => i.update) ? '<p class="small muted" style="margin:6px 0 0">After switching, use Plugins → Updates to get the versions that fit.</p>' : ''}` : ''}
    </div>` : '';
    const btn = $('#ua-run', box);
    if (btn) btn.addEventListener('click', () => attempt(async () => {
      draw(r, true);
      try {
        draw(await api('GET', `/api/servers/${s.id}/upgrade-check?version=${encodeURIComponent(getVersion())}`), false);
      } catch (e) {
        draw(r, false);
        throw e;
      }
    }));
  };
  draw(null, false);
  return () => draw(null, false);
}
