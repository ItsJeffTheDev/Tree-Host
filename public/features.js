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
