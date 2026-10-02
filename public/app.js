'use strict';

// ---------- helpers ----------

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof Blob) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.code === 'AUTH' && !url.startsWith('/api/auth/')) {
    showAuth();
    throw new Error('Please sign in.');
  }
  if (res.status === 403 && data.code === 'RESTRICTED' && !state.restrictedShown) {
    state.restrictedShown = true;
    location.reload(); // the account was just suspended or banned: show why
  }
  if (!res.ok) throw Object.assign(new Error(data.error || `${res.status} ${res.statusText}`), { code: data.code });
  return data;
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 7000 : 3500);
}

async function attempt(fn) {
  try {
    return await fn();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function fmtSize(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}

function fmtMem(mb) {
  return mb >= 1024 ? `${+(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}

const STATUS_LABEL = {
  stopped: 'Stopped',
  installing: 'Installing',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
};
const STATUS_BADGE = { stopped: '', installing: 'yellow', starting: 'yellow', running: 'green', stopping: 'yellow' };

// ---------- state ----------

const state = {
  servers: new Map(),
  types: [],
  typeMap: new Map(),
  system: null,
  selected: null,
  tab: 'console',
  log: { id: null, lastSeq: 0, loading: false },
  history: JSON.parse(localStorage.getItem('mcpt.history') || '[]'),
  histIdx: -1,
  files: { path: '', open: null, dirty: false },
};

// ---------- sidebar ----------

// ---------- Team / Solo spaces ----------

function currentSpace() {
  return isTeam() ? state.space : null;
}

/** Servers shown in the sidebar: customers see theirs; support and admins switch between their own and everyone's. */
function spaceServers() {
  const all = [...state.servers.values()].sort((a, b) => a.createdAt - b.createdAt);
  if (!isTeam() || !hasPerm('servers.viewAll')) return all;
  return state.space === 'all' ? all : all.filter((s) => s.owner === state.me.user.id);
}

function setSpace(space) {
  if (state.space === space) return;
  if (state.files.dirty && !confirm('You have unsaved file changes. Discard them?')) return;
  state.files.dirty = false;
  state.space = space;
  localStorage.setItem('hh.space', space);
  const first = spaceServers()[0];
  renderSpaceSwitch();
  state.selected = first ? first.id : null;
  renderSpaceSwitch();
  renderSidebar();
  renderMain();
}

function renderSpaceSwitch() {
  const el = $('#space-switch');
  if (!el) return;
  if (!isTeam()) {
    el.classList.add('hidden');
    return;
  }
  $('#btn-new').textContent = '+ New server';
  if (!hasPerm('servers.viewAll')) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  el.innerHTML = `
    <button class="${state.space !== 'all' ? 'active' : ''}" data-space="mine" title="Servers on your own plans">👤 My servers</button>
    <button class="${state.space === 'all' ? 'active' : ''}" data-space="all" title="Every customer's server (for support)">🌳 All servers</button>`;
  $$('[data-space]', el).forEach((b) => b.addEventListener('click', () => setSpace(b.dataset.space)));
}

function serverItem(s) {
  return `
      <button class="server-item ${s.id === state.selected ? 'active' : ''}" data-id="${esc(s.id)}">
        ${s.icon ? `<span class="si-icon"><img src="${iconUrl(s)}" alt=""><span class="dot ${esc(s.status)}"></span></span>` : `<span class="dot ${esc(s.status)}"></span>`}
        <div>
          <div class="si-name">${esc(s.name)}</div>
          <div class="si-sub">${esc(s.typeLabel)} ${esc(s.version)}${isCustomer() ? '' : ` · :${s.port}`}${s.status === 'running' && s.kind !== 'proxy' ? ` · <span class="si-online">👥 ${s.players.length}${s.maxPlayers ? `/${s.maxPlayers}` : ''}</span>` : ''}${s.suspended ? ' · <span style="color:var(--danger)">suspended</span>' : ''}${state.space === 'all' && !isCustomer() && s.ownerName ? ` · ${esc(s.ownerName)}` : ''}</div>
        </div>
      </button>`;
}

function renderSidebar() {
  const list = spaceServers();
  const mine = list;
  const others = [];
  const empty = isTeam() && state.space === 'all' ? 'Nobody has a server yet.' : 'No servers yet.';
  $('#server-list').innerHTML =
    (mine.length ? mine.map(serverItem).join('') : `<div class="muted small" style="padding:8px">${empty}</div>`) +
    (others.length
      ? `<div class="list-group">Other people's solo servers</div>` +
        others.map((s) => serverItem({ ...s, name: `${s.name} (${s.ownerName || 'someone'})` })).join('')
      : '');
  $$('#server-list .server-item').forEach((el) => el.addEventListener('click', () => select(el.dataset.id)));
}

function renderSysInfo() {
  const s = state.system;
  if (!s || s.customer) return;
  const javas = [...new Set([...(s.java.managed || []), ...(s.java.system ? [s.java.system] : [])])].sort((a, b) => a - b);
  const used = s.totalMemMb - s.freeMemMb;
  const pct = Math.round((used / s.totalMemMb) * 100);
  const running = (s.servers || []).filter((x) => state.servers.has(x.id));
  $('#sys-info').innerHTML = `
    <div title="${running.map((x) => `${esc(x.name)}: ${x.usedMb ? fmtMem(x.usedMb) : '?'} of ${fmtMem(x.maxMb)}`).join('&#10;') || 'No servers running'}">
      RAM: ${fmtMem(used)} of ${fmtMem(s.totalMemMb)} in use${running.length ? ` · ${running.length} server${running.length > 1 ? 's' : ''} running` : ''}
      <div class="mem-bar ${pct > 90 ? 'high' : pct > 75 ? 'mid' : ''}"><div style="width:${pct}%"></div></div>
      ${s.freeMemMb < 1024 ? '<div class="ub-warn">Memory is almost full. Stop a server or lower its memory.</div>' : ''}
    </div>
    <div>Java ready: ${javas.length ? javas.map((j) => `<b>${j}</b>`).join(', ') : 'none yet (auto-downloads)'}</div>`;
}

// ---------- main view ----------

function select(id) {
  if (state.files.dirty && !confirm('You have unsaved file changes. Discard them?')) return;
  state.selected = id;
  state.files = { path: '', open: null, dirty: false };
  localStorage.setItem('mcpt.selected', id || '');
  renderSidebar();
  renderMain();
}

function current() {
  return state.servers.get(state.selected);
}

function renderMain() {
  const s = current();
  const main = $('#main');
  if (!s && isTeam() && state.space !== 'all') {
    main.innerHTML = `
      <div class="welcome">
        <h1>Welcome to Tree Host, ${esc(state.me.user.username)}! 🌳</h1>
        <p>Your Minecraft server is two steps away:</p>
        <ol>
          <li><b>Pick a plan</b>: how much memory your server gets. You can buy more plans later for more servers.</li>
          <li><b>Create your server</b>: choose Paper, Purpur, Fabric, Vanilla... and any version. It's ready in about a minute.</li>
        </ol>
        <div class="row"><button class="btn primary" id="welcome-go">Get started</button>
          <a class="btn" href="help.html" target="_blank">📖 Read the guide</a></div>
      </div>`;
    $('#welcome-go').addEventListener('click', openNewServer);
    return;
  }
  if (!s) {
    main.innerHTML = `
      <div class="welcome">
        <h1>Test your plugins on a real server</h1>
        <p>Spin up Paper, Purpur, Folia, Spigot, Vanilla, Fabric or a proxy on any version in a couple of clicks.
        The correct Java version is downloaded for you.</p>
        <ol>
          <li>Create a server and pick the type and version you target.</li>
          <li>In <b>Plugins</b>, point auto-deploy at your build folder (e.g. <code>build/libs</code> or <code>target</code>).</li>
          <li>Build your plugin, and the server restarts with the new jar automatically.</li>
        </ol>
        <button class="btn primary" onclick="openNewServer()">+ Create your first server</button>
      </div>`;
    return;
  }
  if ((state.tab === 'files' && !can('files', s)) || (state.tab === 'settings' && !can('settings', s))) state.tab = 'console';
  main.innerHTML = `
    <header class="srv-header">
      <div id="srv-head"></div>
      <div class="tabs">
        ${['console', 'plugins', 'backups', 'files', 'settings']
          .filter((t) => (t === 'files' ? can('files', s) : t === 'settings' ? can('settings', s) : true))
          .map(
            (t) =>
              `<button class="tab ${state.tab === t ? 'active' : ''}" data-tab="${t}">${
                t === 'plugins' ? (s.pluginDir === 'mods' ? 'Mods' : 'Plugins') : t[0].toUpperCase() + t.slice(1)
              }</button>`,
          )
          .join('')}
      </div>
    </header>
    <section id="tab-body" class="tab-body"></section>`;
  $$('.tab', main).forEach((b) =>
    b.addEventListener('click', () => {
      if (state.tab === 'files' && state.files.dirty && !confirm('Discard unsaved file changes?')) return;
      state.files.dirty = false;
      state.tab = b.dataset.tab;
      $$('.tab', main).forEach((x) => x.classList.toggle('active', x === b));
      renderTab();
    }),
  );
  renderHeader();
  renderTab();
}

function renderHeader() {
  const s = current();
  const el = $('#srv-head');
  if (!s || !el) return;
  const busy = ['installing', 'starting', 'stopping'].includes(s.status);
  const alive = !!s.pid;
  const buildText = s.installedBuild && !['release', 'local', 'custom', 'latest'].includes(s.installedBuild) ? `build ${s.installedBuild}` : '';
  const addr = s.port === 25565 ? '127.0.0.1' : `127.0.0.1:${s.port}`;
  const player = playerName();
  let progress = '';
  if (s.client) {
    const cp = s.client.total ? Math.min(100, Math.round((s.client.done / s.client.total) * 100)) : null;
    progress += `
      <div class="progress">
        <div class="progress-label">🎮 ${esc(s.client.label || 'Preparing Minecraft...')}${cp !== null ? ` · ${cp}% (${fmtSize(s.client.done)} / ${fmtSize(s.client.total)})` : ''}</div>
        <div class="bar client ${cp === null ? 'indeterminate' : ''}"><div style="width:${cp ?? 0}%"></div></div>
      </div>`;
  }
  if (s.progress) {
    const pct = s.progress.total ? Math.min(100, Math.round((s.progress.done / s.progress.total) * 100)) : null;
    progress += `
      <div class="progress">
        <div class="progress-label">${esc(s.progress.label || 'Working...')}${pct !== null ? ` · ${pct}% (${fmtSize(s.progress.done)} / ${fmtSize(s.progress.total)})` : ''}</div>
        <div class="bar ${pct === null ? 'indeterminate' : ''}"><div style="width:${pct ?? 0}%"></div></div>
      </div>`;
  }
  el.innerHTML = `
    <div class="srv-top">
      <div class="srv-title">
        <h1>${esc(s.name)}
          ${isTeam() && s.owner !== state.me.user.id ? `<span class="badge blue" title="This server belongs to someone else">👤 ${esc(s.ownerName || 'customer')}</span>` : ''}
          ${s.plan ? `<span class="badge green" title="Plan">${esc(s.plan.planName)}</span>` : ''}
          <span class="badge ${STATUS_BADGE[s.status]}">${STATUS_LABEL[s.status] || s.status}</span>
          ${s.needsInstall && s.status === 'stopped' && s.installedBuild ? '<span class="badge blue" title="Type/version changed. The new jar is downloaded on next start.">update on start</span>' : ''}
        </h1>
        ${
          s.suspended
            ? `<div class="suspended-box">⛔ ${s.suspended === 'canceled' ? 'The plan for this server has ended.' : 'The payment for this server failed.'}
                 ${isCustomer() ? '<a href="#" id="hdr-billing">Open Billing</a> to fix it.' : ''}</div>`
            : ''
        }
        ${serverModerationBox(s)}
        <div class="meta">
          <span><b>${esc(s.typeLabel)}</b> ${esc(s.version)} ${buildText ? `<span class="muted">(${esc(buildText)})</span>` : ''}</span>
          <span title="Memory the server is using right now / the most it may use">RAM <b>${s.memUsedMb ? `${fmtMem(s.memUsedMb)} / ` : ''}${fmtMem(s.memoryMb)}</b></span>
          <span>Java <b>${s.javaMajor || 'auto'}</b></span>
          ${alive && s.startedAt ? `<span>Up <b id="uptime">${fmtUptime(Date.now() - s.startedAt)}</b></span>` : ''}
          ${s.autoRestart ? '<span title="Restarts by itself after a crash">♻ auto-restart</span>' : ''}
          ${s.plan && s.diskUsedMb ? `<span title="Disk used / plan limit">Disk <b>${+(s.diskUsedMb / 1024).toFixed(1)} / ${s.plan.diskGb} GB</b></span>` : ''}
          ${s.kind !== 'proxy' && alive ? `<span title="${esc(s.players.join(', '))}">Players <b>${s.players.length}${s.maxPlayers ? ` / ${s.maxPlayers}` : ''}</b>${s.players.length ? `: ${esc(s.players.slice(0, 5).join(', '))}${s.players.length > 5 ? '…' : ''}` : ''}</span>` : ''}
        </div>
      </div>
      <div class="address" title="In Minecraft: Multiplayer → Add Server → paste this as the Server Address">
        ${
          s.gateway
            ? `<div class="addr-label">Join through the Gateway <span class="muted">(click to copy)</span></div>
               ${
                 s.gateway.address
                   ? `<div class="addr-main copy" data-copy="${esc(s.gateway.address)}">${esc(s.gateway.address)}</div>`
                   : `<div class="addr-lan">The Gateway has no public address yet${hasPerm('system.view') ? ' (Team panel → Gateway)' : ''}.</div>`
               }
               <div class="addr-lan">then type <span class="copy" data-copy="/server ${esc(s.gateway.name)}"><b>/server ${esc(s.gateway.name)}</b></span>${
                 s.pid && !s.gateway.applied ? ' · <span style="color:#e8c27a">restart once to move it behind the Gateway</span>' : ''
               }</div>
               ${lanGameLine({ ...s, port: s.gateway.port })}`
            : s.publicAddress
            ? `<div class="addr-label">Join address <span class="muted">(click to copy)</span></div>
               <div class="addr-main copy" data-copy="${esc(s.publicAddress)}">${esc(s.publicAddress)}</div>
               ${lanGameLine(s)}`
            : state.me?.hosted
              ? `<div class="addr-label">Join address</div><div class="addr-lan">${hasPerm('system.view') ? 'Set TREEHOST_GAME_HOST on the server, or type an address in Settings.' : 'No address yet. Contact support.'}</div>`
              : `<div class="addr-label">Server address <span class="muted">(click to copy)</span></div>
                 <div class="addr-main copy" data-copy="${addr}">${addr}</div>
                 ${
                   isTeam()
                     ? lanGameLine(s)
                     : state.system?.lanIps?.length
                       ? `<div class="addr-lan">Other PCs on your network: <span class="copy" data-copy="${esc(state.system.lanIps[0])}:${s.port}">${esc(state.system.lanIps[0])}:${s.port}</span></div>`
                       : ''
                 }`
        }
      </div>
      ${
        hostFeatures() && !s.gateway
          ? `<div class="play">
        <button class="btn play-btn" id="btn-play" ${s.client ? 'disabled' : ''} title="Downloads this Minecraft version if needed, starts the server and joins it${isTeam() ? ' (opens on the host PC)' : ''}">🎮 Play${isTeam() ? ' on host' : ''}${s.clientsRunning ? ` (${s.clientsRunning} open)` : ''}</button>
        <div class="play-as">as <a id="play-name" title="Change username">${esc(player)}</a></div>
      </div>`
          : ''
      }
      <div class="actions">
        <button class="btn primary" data-act="start" ${alive || busy || s.suspended || s.moderation ? 'disabled' : ''}>▶ Start</button>
        <button class="btn" data-act="restart" ${!alive || s.status === 'stopping' ? 'disabled' : ''}>⟳ Restart</button>
        <button class="btn" data-act="stop" ${!alive || s.status === 'stopping' ? 'disabled' : ''}>■ Stop</button>
        <button class="btn danger" data-act="kill" ${!alive ? 'disabled' : ''} title="Force kill the Java process">Kill</button>
        ${hostFeatures() ? '<button class="btn" data-act="open-folder" title="Open the server folder">📁 Folder</button>' : ''}
        ${isTeam() && s.owner && s.owner !== state.me.user.id && hasPerm('console.access') && s.kind !== 'proxy' ? `<button class="btn" id="btn-staff-join" ${s.status === 'running' ? '' : 'disabled'} title="Join this server in Minecraft as Tree Host staff (gets you past the whitelist)">🎮 Join as staff</button>` : ''}
        ${isTeam() && s.owner && s.owner !== state.me.user.id && canTakeAction('server') ? '<button class="btn" id="btn-take-action" title="Warn, suspend, ban or delete this server, with a reason and evidence">🛡️ Take action</button>' : ''}
      </div>
    </div>
    ${s.notes ? `<div class="srv-notes"><span class="muted small">📝 Notes</span> ${esc(s.notes)}</div>` : ''}
    ${progress}`;
  $$('[data-act]', el).forEach((b) =>
    b.addEventListener('click', () => attempt(() => api('POST', `/api/servers/${s.id}/${b.dataset.act}`))),
  );
  if ($('#btn-play', el)) $('#btn-play', el).addEventListener('click', () => launchClient(s));
  if ($('#btn-staff-join', el)) $('#btn-staff-join', el).addEventListener('click', () => attempt(async () => {
    const r = await api('POST', `/api/servers/${s.id}/staff-join`);
    openModal(`<h2>🎮 Join as Tree Host staff</h2>
      <p>You're let through the whitelist as <b>${esc(r.name)}</b>. In Minecraft: Multiplayer → Add Server →</p>
      <div class="row"><code class="addr-main copy" data-copy="${esc(r.address)}" style="font-size:18px">${esc(r.address)}</code></div>
      ${r.onlineMode ? `<p class="hint">When you join, everyone sees a green-and-gold <b>Tree Host staff joined</b> notice, and you wear a gold <b>✔ STAFF</b> badge in chat and in the player list.
        Bans on you are undone automatically. Please be respectful: it's the customer's server.</p>`
        : '<div class="warn-box">This server is in offline mode, so Minecraft cannot confirm who you are: you join without the staff badge.</div>'}
      <div class="modal-actions"><button class="btn" data-close>Close</button></div>`);
    $$('#modal-root [data-copy]').forEach((c) => c.addEventListener('click', () => navigator.clipboard.writeText(c.dataset.copy).then(() => toast('Copied'))));
  }));
  if ($('#btn-take-action', el)) $('#btn-take-action', el).addEventListener('click', () => openTakeAction({ target: 'server', server: { id: s.id, name: s.name, ownerName: s.ownerName }, user: { id: s.owner, username: s.ownerName } }));
  $$('[data-mod-inbox]', el).forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    openInbox(a.dataset.modInbox);
  }));
  if ($('#hdr-billing', el))
    $('#hdr-billing', el).addEventListener('click', (e) => {
      e.preventDefault();
      openBilling();
    });
  if ($('#play-name', el)) $('#play-name', el).addEventListener('click', () => {
    const n = prompt('Username to play as (3-16 letters, numbers or _).\nUse a different name to join with a second client.', playerName());
    if (n === null) return;
    if (!/^[A-Za-z0-9_]{3,16}$/.test(n.trim())) return toast('Username must be 3-16 letters, numbers or _', 'error');
    localStorage.setItem('mcpt.player', n.trim());
    renderHeader();
  });
  $$('[data-copy]', el).forEach((b) =>
    b.addEventListener('click', () => {
      navigator.clipboard.writeText(b.dataset.copy).then(() => toast(`Copied ${b.dataset.copy}`));
    }),
  );
}

/** Game address for players on the host's home network (skips the internet round trip). */
function lanGameLine(s) {
  const ip = state.system?.lanIps?.[0];
  if (!ip || state.me?.hosted) return '';
  const a = s.port === 25565 ? ip : `${ip}:${s.port}`;
  return `<div class="addr-lan">Same home network: <span class="copy" data-copy="${esc(a)}">${esc(a)}</span></div>`;
}

function playerName() {
  const n = localStorage.getItem('mcpt.player');
  return n && /^[A-Za-z0-9_]{3,16}$/.test(n) ? n : 'Developer';
}

async function launchClient(s) {
  const body = { username: playerName() };
  try {
    const r = await api('POST', `/api/servers/${s.id}/launch-client`, body);
    toast(`Preparing Minecraft ${r.version}. The game opens once the server is ready.`);
  } catch (e) {
    if (e.code !== 'ONLINE_MODE') return toast(e.message, 'error');
    const ok = confirm(
      'This server is in online mode, so it only accepts players signed in through the official Minecraft Launcher.\n\n' +
        'Switch it to offline mode (recommended for plugin testing) and launch?' +
        (s.pid ? ' The server will restart.' : ''),
    );
    if (!ok) return;
    await attempt(async () => {
      const r = await api('POST', `/api/servers/${s.id}/launch-client`, { ...body, fixOnlineMode: true });
      toast(`Preparing Minecraft ${r.version}. The game opens once the server is ready.`);
    });
  }
}

setInterval(() => {
  const s = current();
  const el = $('#uptime');
  if (s && el && s.startedAt) el.textContent = fmtUptime(Date.now() - s.startedAt);
}, 1000);

function renderTab() {
  const body = $('#tab-body');
  if (!body) return;
  body.className = 'tab-body' + (state.tab === 'console' ? ' console-mode' : '');
  if (state.tab === 'console') renderConsole(body);
  else if (state.tab === 'plugins') renderPlugins(body);
  else if (state.tab === 'files') renderFiles(body);
  else if (state.tab === 'backups') renderBackups(body);
  else renderSettings(body);
}

// ---------- console ----------

const ANSI = ['#3b3f45', '#e5534b', '#34c77b', '#d9a441', '#4a9eff', '#c678dd', '#39c5cf', '#cfd3d8'];
const ANSI_BRIGHT = ['#7d858f', '#ff7b72', '#6fe0a5', '#f2cc60', '#8cc2ff', '#e39bf5', '#76e3ea', '#ffffff'];

function xterm256(n) {
  if (n < 8) return ANSI[n];
  if (n < 16) return ANSI_BRIGHT[n - 8];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  n -= 16;
  const c = (x) => (x ? x * 40 + 55 : 0);
  return `rgb(${c(Math.floor(n / 36))},${c(Math.floor(n / 6) % 6)},${c(n % 6)})`;
}

function renderAnsi(text, into) {
  text = text.replace(/\x1b\[[\d;?]*[A-HJKSTfhlnsu]/g, '');
  const re = /\x1b\[([\d;]*)m/g;
  let last = 0;
  let style = {};
  let m;
  const push = (s) => {
    if (!s) return;
    if (!style.color && !style.bold && !style.italic && !style.underline) {
      into.appendChild(document.createTextNode(s));
      return;
    }
    const span = document.createElement('span');
    span.textContent = s;
    if (style.color) span.style.color = style.color;
    if (style.bold) span.style.fontWeight = '700';
    if (style.italic) span.style.fontStyle = 'italic';
    if (style.underline) span.style.textDecoration = 'underline';
    into.appendChild(span);
  };
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index));
    last = re.lastIndex;
    const codes = m[1] ? m[1].split(';').map(Number) : [0];
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) style = {};
      else if (c === 1) style.bold = true;
      else if (c === 3) style.italic = true;
      else if (c === 4) style.underline = true;
      else if (c === 22) style.bold = false;
      else if (c === 23) style.italic = false;
      else if (c === 24) style.underline = false;
      else if (c >= 30 && c <= 37) style.color = ANSI[c - 30];
      else if (c >= 90 && c <= 97) style.color = ANSI_BRIGHT[c - 90];
      else if (c === 39) delete style.color;
      else if (c === 38 && codes[i + 1] === 5) {
        style.color = xterm256(codes[i + 2]);
        i += 2;
      } else if (c === 38 && codes[i + 1] === 2) {
        style.color = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
        i += 4;
      }
    }
  }
  push(text.slice(last));
}

function lineClass(t) {
  if (t.startsWith('[Tree Host]')) return 'l-sys';
  if (t.startsWith('> ')) return 'l-cmd';
  if (/\b(ERROR|SEVERE|FATAL)\b|Exception|^\s+at /.test(t)) return 'l-error';
  if (/\bWARN(ING)?\b/.test(t)) return 'l-warn';
  return '';
}

function quickCommands(s) {
  if (s.kind === 'proxy') {
    return s.family === 'velocity'
      ? [['velocity plugins', 'Plugins'], ['glist', 'Player list'], ['velocity dump', 'Dump']]
      : [['plugins', 'Plugins'], ['glist', 'Player list']];
  }
  const cmds = [
    ['op {player}', 'OP player…'],
    ['gamemode creative @a', 'Creative'],
    ['gamemode survival @a', 'Survival'],
    ['time set day', 'Day'],
    ['weather clear', 'Clear weather'],
    ['list', 'Players'],
  ];
  if (s.family === 'bukkit') cmds.push(['plugins', 'Plugins'], ['tps', 'TPS'], ['version', 'Version']);
  cmds.push(['save-all', 'Save']);
  if (isTeam()) cmds.unshift(['@team-whitelist', 'Whitelist me'], ['@team-op', 'OP me']);
  return cmds;
}

function renderConsole(body) {
  const s = current();
  body.innerHTML = `
    <div class="console-wrap">
      <div id="console" class="console"><div class="empty">Loading log...</div></div>
      <button id="jump" class="btn sm jump hidden">↓ Jump to latest</button>
    </div>
    ${can('command', s) ? '' : '<div class="readonly-note">👀 Read-only console: you can watch the log, but only developers and admins can type commands.</div>'}
    <div class="quick ${can('command', s) ? '' : 'hidden'}">
      ${quickCommands(s)
        .map(([cmd, label]) => `<button class="btn sm" data-cmd="${esc(cmd)}" title="${esc(cmd)}">${esc(label)}</button>`)
        .join('')}
      <button class="btn sm" id="clear-console" style="margin-left:auto">Clear view</button>
    </div>
    <form class="cmd ${can('command', s) ? '' : 'hidden'}" id="cmd-form" autocomplete="off">
      <span class="prompt">&gt;</span>
      <input type="text" id="cmd-input" placeholder="Type a server command (e.g. op YourName) and press Enter · ↑/↓ for history">
      <button class="btn">Send</button>
    </form>`;

  const con = $('#console');
  const jump = $('#jump');
  con.addEventListener('scroll', () => jump.classList.toggle('hidden', isAtBottom(con)));
  jump.addEventListener('click', () => {
    con.scrollTop = con.scrollHeight;
  });
  $('#clear-console').addEventListener('click', () => {
    con.innerHTML = '';
  });

  const input = $('#cmd-input');
  $('#cmd-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const cmd = input.value.trim();
    if (!cmd) return;
    sendCommand(cmd);
    input.value = '';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const h = state.history;
      if (!h.length) return;
      state.histIdx = e.key === 'ArrowUp' ? Math.min(h.length - 1, state.histIdx + 1) : Math.max(-1, state.histIdx - 1);
      input.value = state.histIdx >= 0 ? h[state.histIdx] : '';
    }
  });
  $$('[data-cmd]', body).forEach((b) =>
    b.addEventListener('click', () => {
      let cmd = b.dataset.cmd;
      if (cmd.startsWith('@team-')) {
        attempt(async () => {
          const { names } = await api('POST', `/api/servers/${s.id}/team-access`, { op: cmd === '@team-op' });
          toast(`${cmd === '@team-op' ? 'Whitelisted and opped' : 'Whitelisted'}: ${names.join(', ')}`);
        });
        return;
      }
      if (cmd.includes('{player}')) {
        const name = prompt('Player name:', localStorage.getItem('mcpt.player') || '');
        if (!name) return;
        localStorage.setItem('mcpt.player', name.trim());
        cmd = cmd.replace('{player}', name.trim());
      }
      sendCommand(cmd, false);
    }),
  );
  loadLog(s.id);
  input.focus();
}

function isAtBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

async function sendCommand(cmd, remember = true) {
  const s = current();
  if (!s) return;
  if (remember) {
    state.history = [cmd, ...state.history.filter((c) => c !== cmd)].slice(0, 100);
    localStorage.setItem('mcpt.history', JSON.stringify(state.history));
  }
  state.histIdx = -1;
  await attempt(() => api('POST', `/api/servers/${s.id}/command`, { command: cmd }));
}

async function loadLog(id) {
  state.log = { id, lastSeq: 0, loading: true };
  try {
    const { lines } = await api('GET', `/api/servers/${id}/log`);
    if (state.log.id !== id) return;
    const con = $('#console');
    if (!con) return;
    con.innerHTML = '';
    state.log.loading = false;
    if (!lines.length) {
      con.innerHTML = '<div class="empty">No output yet. Press <b>Start</b> to launch the server.</div>';
    }
    appendLines(lines, true);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function appendLines(lines, forceScroll = false) {
  const con = $('#console');
  if (!con || state.log.loading) return;
  const stick = forceScroll || isAtBottom(con);
  const empty = $('.empty', con);
  if (empty && lines.length) empty.remove();
  const frag = document.createDocumentFragment();
  for (const l of lines) {
    if (l.s <= state.log.lastSeq) continue;
    state.log.lastSeq = l.s;
    const div = document.createElement('div');
    const cls = lineClass(l.t.replace(/\x1b\[[\d;]*m/g, ''));
    if (cls) div.className = cls;
    renderAnsi(l.t, div);
    frag.appendChild(div);
  }
  con.appendChild(frag);
  while (con.childElementCount > 5000) con.firstElementChild.remove();
  if (stick) con.scrollTop = con.scrollHeight;
}

// ---------- plugins ----------

async function renderPlugins(body) {
  const s = current();
  const dirName = s.pluginDir;
  const isMods = dirName === 'mods';
  const noPlugins = s.family === 'vanilla';
  body.innerHTML = `
    ${noPlugins ? '<div class="card"><h3>Vanilla servers do not load plugins</h3><p class="hint" style="margin:0">Switch the type to Paper, Purpur or Spigot in Settings to test plugins.</p></div>' : ''}
    ${isTeam() && can('deploy', s) ? deployCardHtml(s) : ''}
    ${hostFeatures() ? `<div class="card">
      <h3>Auto-deploy from ${isTeam() ? 'a build folder on the host PC' : 'your build output'}</h3>
      <p class="hint">Add your plugin project's build folder (for example <code>C:\\dev\\MyPlugin\\build\\libs</code> or <code>…\\target</code>) or a specific jar.
      Each time you build, the newest jar is copied into <code>${dirName}/</code>${s.onPluginChange === 'restart' ? ' and the server restarts' : ''}.</p>
      <div id="watch-list"></div>
      <form id="watch-form" class="row" style="margin-top:8px">
        <input type="text" id="watch-path" placeholder="Full path to a .jar or a build folder">
        <button class="btn primary">Add</button>
      </form>
      <label class="field" style="margin-top:12px;max-width:420px">When a new build is detected while running
        <select id="watch-mode">
          <option value="restart" ${s.onPluginChange === 'restart' ? 'selected' : ''}>Restart the server automatically (recommended)</option>
          <option value="copy" ${s.onPluginChange === 'copy' ? 'selected' : ''}>Do nothing until I restart manually</option>
        </select>
      </label>
    </div>` : ''}
    <div class="card">
      <div class="row" style="justify-content:space-between;margin-bottom:10px">
        <h3>${isMods ? 'Installed mods' : 'Installed plugins'}</h3>
        <div class="row">
          ${!noPlugins && can('plugins', s) ? `<button class="btn sm primary" id="browse-plugins">🔎 Browse ${isMods ? 'mods' : 'plugins'}</button>` : ''}
          ${hostFeatures() ? `<button class="btn sm" id="open-plugins">📁 Open ${dirName}/</button>` : ''}
          <button class="btn sm" id="refresh-plugins">Refresh</button>
        </div>
      </div>
      <div class="dropzone ${can('plugins', s) ? '' : 'hidden'}" id="dropzone">
        Drop <b>.jar</b> files here or <label>browse<input type="file" id="plugin-file" accept=".jar" multiple hidden></label>
      </div>
      <div id="plugin-table" class="muted">Loading...</div>
    </div>`;

  bindDeployCard(body);
  if ($('#watch-form')) {
  renderWatches();
  $('#watch-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const p = $('#watch-path').value.trim();
    if (!p) return;
    attempt(async () => {
      await api('POST', `/api/servers/${s.id}/watches`, { path: p });
      $('#watch-path').value = '';
      toast('Auto-deploy added');
      setTimeout(loadPlugins, 800);
    });
  });
  $('#watch-mode').addEventListener('change', (e) =>
    attempt(() => api('PATCH', `/api/servers/${s.id}`, { onPluginChange: e.target.value })),
  );
  }
  if ($('#open-plugins')) {
    $('#open-plugins').addEventListener('click', () =>
      attempt(() => api('POST', `/api/servers/${s.id}/open-folder?sub=${encodeURIComponent(dirName)}`)),
    );
  }
  $('#refresh-plugins').addEventListener('click', loadPlugins);
  if ($('#browse-plugins')) $('#browse-plugins').addEventListener('click', () => openPluginBrowser(s));

  const dz = $('#dropzone');
  dz.addEventListener('dragover', (e) => {
    e.preventDefault();
    dz.classList.add('over');
  });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    uploadPlugins([...e.dataTransfer.files]);
  });
  $('#plugin-file').addEventListener('change', (e) => uploadPlugins([...e.target.files]));
  loadPlugins();
}

function renderWatches() {
  const s = current();
  const el = $('#watch-list');
  if (!el || !s) return;
  el.innerHTML = s.watches.length
    ? s.watches
        .map(
          (w) => `
      <div class="watch">
        <input type="checkbox" data-wtoggle="${w.id}" ${w.enabled ? 'checked' : ''} title="Enabled">
        <div class="w-path" title="${esc(w.path)}">${esc(w.path)}</div>
        ${w.missing ? '<span class="badge red" title="No .jar found at this path yet">no jar found</span>' : w.lastCopied ? `<span class="badge green" title="Last deployed">${esc(w.lastCopied)}</span>` : '<span class="badge">waiting</span>'}
        <button class="btn sm danger" data-wremove="${w.id}">Remove</button>
      </div>`,
        )
        .join('')
    : '<div class="muted small">No auto-deploy paths yet.</div>';
  $$('[data-wtoggle]', el).forEach((c) =>
    c.addEventListener('change', () =>
      attempt(() => api('PATCH', `/api/servers/${s.id}/watches/${c.dataset.wtoggle}`, { enabled: c.checked })),
    ),
  );
  $$('[data-wremove]', el).forEach((b) =>
    b.addEventListener('click', () => attempt(() => api('DELETE', `/api/servers/${s.id}/watches/${b.dataset.wremove}`))),
  );
}

async function loadPlugins() {
  const s = current();
  const el = $('#plugin-table');
  if (!el || !s) return;
  let list;
  try {
    list = await api('GET', `/api/servers/${s.id}/plugins`);
  } catch (e) {
    el.textContent = e.message;
    return;
  }
  if (!$('#plugin-table') || current() !== s) return;
  if (!list.length) {
    el.innerHTML = `<div class="muted">Nothing in <code>${esc(s.pluginDir)}/</code> yet.</div>`;
    return;
  }
  el.classList.remove('muted');
  el.innerHTML = `
    <table>
      <thead><tr><th>Name</th><th>Version</th><th>File</th><th>Size</th><th></th></tr></thead>
      <tbody>
        ${list
          .map(
            (p) => `
          <tr class="${p.enabled ? '' : 'disabled'}">
            <td>
              <div class="p-name">${esc(p.name || p.file.replace(/\.jar(\.disabled)?$/i, ''))}
                ${p.locked ? '<span class="badge lifetime-badge" title="Required by Tree Host on every server: lets official Tree Host staff help you">🔒 Required by Tree Host</span>' : ''}
                ${p.watched ? '<span class="badge blue" title="Deployed automatically from your build folder">auto</span>' : ''}
                ${p.format === 'paper-plugin.yml' ? '<span class="badge">paper-plugin</span>' : ''}
                ${p.invalid ? '<span class="badge red">invalid jar</span>' : ''}
                ${!p.invalid && !p.format ? '<span class="badge yellow" title="No plugin.yml found">not a plugin?</span>' : ''}
              </div>
              ${p.description ? `<div class="p-desc" title="${esc(p.description)}">${esc(p.description)}</div>` : ''}
            </td>
            <td>${esc(p.version || '')}${p.apiVersion ? ` <span class="muted small">api ${esc(p.apiVersion)}</span>` : ''}</td>
            <td class="small muted">${esc(p.file)}</td>
            <td class="small muted">${fmtSize(p.size)}</td>
            <td class="actions-cell">${
              p.locked
                ? '<span class="muted small">Can\'t be removed</span>'
                : can('plugins', s)
                ? `<button class="btn sm" data-ptoggle="${esc(p.file)}">${p.enabled ? 'Disable' : 'Enable'}</button>
              <button class="btn sm danger" data-pdelete="${esc(p.file)}">Delete</button>`
                : ''
            }</td>
          </tr>`,
          )
          .join('')}
      </tbody>
    </table>
    ${s.pid ? '<p class="hint small" style="margin:10px 0 0">Changes to plugins take effect after a restart.</p>' : ''}`;
  $$('[data-ptoggle]', el).forEach((b) =>
    b.addEventListener('click', () =>
      attempt(async () => {
        await api('POST', `/api/servers/${s.id}/plugins/${encodeURIComponent(b.dataset.ptoggle)}/toggle`);
        loadPlugins();
      }),
    ),
  );
  $$('[data-pdelete]', el).forEach((b) =>
    b.addEventListener('click', () => {
      if (!confirm(`Delete ${b.dataset.pdelete}?`)) return;
      attempt(async () => {
        await api('DELETE', `/api/servers/${s.id}/plugins/${encodeURIComponent(b.dataset.pdelete)}`);
        loadPlugins();
      });
    }),
  );
}

async function uploadPlugins(files) {
  const s = current();
  const jars = files.filter((f) => f.name.toLowerCase().endsWith('.jar'));
  if (!jars.length) return toast('Only .jar files can be added', 'error');
  for (const f of jars) {
    await attempt(async () => {
      await api('POST', `/api/servers/${s.id}/plugins?name=${encodeURIComponent(f.name)}`, f);
      toast(`Added ${f.name}${s.pid ? '. Restart to load it' : ''}`);
    });
  }
  loadPlugins();
}

// ---------- files ----------

const FILE_SHORTCUTS = {
  bukkit: ['server.properties', 'bukkit.yml', 'spigot.yml', 'config/paper-global.yml', 'config/paper-world-defaults.yml', 'ops.json'],
  vanilla: ['server.properties', 'ops.json', 'whitelist.json'],
  fabric: ['server.properties', 'ops.json'],
  velocity: ['velocity.toml'],
  bungee: ['config.yml'],
};

function renderFiles(body) {
  const s = current();
  body.innerHTML = `
    <div class="files">
      <div class="file-list" id="file-list"></div>
      <div class="editor" id="editor"></div>
    </div>`;
  loadDir(state.files.path);
  if (state.files.open) openFile(state.files.open);
  else renderEditorEmpty(s);
}

function renderEditorEmpty(s) {
  const shortcuts = FILE_SHORTCUTS[s.family] || FILE_SHORTCUTS.bukkit;
  $('#editor').innerHTML = `
    <div class="shortcuts">${shortcuts.map((f) => `<button class="btn sm" data-open="${esc(f)}">${esc(f)}</button>`).join('')}</div>
    <div class="editor-empty">Pick a file to edit. Most config files appear after the first start.</div>`;
  $$('[data-open]').forEach((b) => b.addEventListener('click', () => openFile(b.dataset.open)));
}

async function loadDir(p) {
  const s = current();
  const el = $('#file-list');
  if (!el) return;
  let list;
  try {
    list = await api('GET', `/api/servers/${s.id}/files?path=${encodeURIComponent(p)}`);
  } catch (e) {
    toast(e.message, 'error');
    if (p) return loadDir('');
    return;
  }
  state.files.path = p;
  const parts = p ? p.split('/') : [];
  const crumbs = [`<a data-dir="">${esc(s.name)}</a>`]
    .concat(parts.map((part, i) => `<span class="muted">/</span><a data-dir="${esc(parts.slice(0, i + 1).join('/'))}">${esc(part)}</a>`))
    .join('');
  el.innerHTML = `
    <div class="crumbs">${crumbs}</div>
    ${p ? `<div class="file-row" data-dir="${esc(parts.slice(0, -1).join('/'))}"><span>↩</span><span class="fname">..</span></div>` : ''}
    ${list
      .map((f) => {
        const rel = p ? `${p}/${f.name}` : f.name;
        return `<div class="file-row ${state.files.open === rel ? 'active' : ''}" ${f.dir ? `data-dir="${esc(rel)}"` : `data-file="${esc(rel)}"`}>
          <span>${f.dir ? '📁' : '📄'}</span><span class="fname">${esc(f.name)}</span>
          ${f.dir ? '' : `<span class="fsize">${fmtSize(f.size)}</span>`}
        </div>`;
      })
      .join('')}
    ${!list.length ? '<div class="muted small" style="padding:10px 12px">Empty folder.</div>' : ''}`;
  $$('[data-dir]', el).forEach((a) => a.addEventListener('click', () => loadDir(a.dataset.dir)));
  $$('[data-file]', el).forEach((a) => a.addEventListener('click', () => openFile(a.dataset.file)));
}

async function openFile(rel) {
  const s = current();
  if (state.files.dirty && state.files.open !== rel && !confirm('Discard unsaved changes?')) return;
  let content;
  try {
    ({ content } = await api('GET', `/api/servers/${s.id}/file?path=${encodeURIComponent(rel)}`));
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  state.files.open = rel;
  state.files.dirty = false;
  $$('#file-list .file-row').forEach((r) => r.classList.toggle('active', r.dataset.file === rel));
  const ed = $('#editor');
  ed.innerHTML = `
    <div class="row" style="justify-content:space-between">
      <div><b>${esc(rel)}</b> <span id="dirty" class="badge yellow hidden">unsaved</span></div>
      <div class="row">
        <button class="btn sm danger" id="file-delete">Delete</button>
        <button class="btn sm" id="file-close">Close</button>
        <button class="btn sm primary" id="file-save">Save (Ctrl+S)</button>
      </div>
    </div>
    <textarea id="file-content" spellcheck="false"></textarea>
    <div class="muted small">Most config changes need a server restart (or the plugin's reload command) to take effect.</div>`;
  const ta = $('#file-content');
  ta.value = content;
  ta.addEventListener('input', () => {
    state.files.dirty = true;
    $('#dirty').classList.remove('hidden');
  });
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveFile();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input'));
    }
  });
  $('#file-save').addEventListener('click', saveFile);
  $('#file-close').addEventListener('click', () => {
    if (state.files.dirty && !confirm('Discard unsaved changes?')) return;
    state.files.open = null;
    state.files.dirty = false;
    $$('#file-list .file-row').forEach((r) => r.classList.remove('active'));
    renderEditorEmpty(s);
  });
  $('#file-delete').addEventListener('click', () => {
    if (!confirm(`Delete ${rel}?`)) return;
    attempt(async () => {
      await api('DELETE', `/api/servers/${s.id}/file?path=${encodeURIComponent(rel)}`);
      state.files.open = null;
      state.files.dirty = false;
      renderEditorEmpty(s);
      loadDir(state.files.path);
    });
  });
}

async function saveFile() {
  const s = current();
  const rel = state.files.open;
  if (!rel) return;
  await attempt(async () => {
    await api('PUT', `/api/servers/${s.id}/file?path=${encodeURIComponent(rel)}`, { content: $('#file-content').value });
    state.files.dirty = false;
    $('#dirty').classList.add('hidden');
    toast(`Saved ${rel}`);
  });
}

// ---------- settings ----------

const PROPS = [
  ['motd', 'MOTD', 'text'],
  ['online-mode', 'Online mode', ['true', 'false'], 'false lets you join with any username (handy for testing with several clients)'],
  ['gamemode', 'Default gamemode', ['survival', 'creative', 'adventure', 'spectator']],
  ['difficulty', 'Difficulty', ['peaceful', 'easy', 'normal', 'hard']],
  ['max-players', 'Max players', 'number'],
  ['view-distance', 'View distance', 'number'],
  ['simulation-distance', 'Simulation distance', 'number'],
  ['spawn-protection', 'Spawn protection', 'number'],
  ['pvp', 'PvP', ['true', 'false']],
  ['allow-flight', 'Allow flight', ['true', 'false']],
  ['white-list', 'Whitelist', ['false', 'true']],
  ['enable-command-block', 'Command blocks', ['true', 'false']],
  ['level-type', 'World type', 'text', 'e.g. minecraft:normal, minecraft:flat'],
  ['level-seed', 'Seed', 'text'],
];

async function renderSettings(body) {
  const s = current();
  const type = state.typeMap.get(s.type);
  const memOptions = [512, 1024, 1536, 2048, 3072, 4096, 6144, 8192, 12288, 16384].filter(
    (m) => !state.system || m <= state.system.totalMemMb,
  );
  if (!memOptions.includes(s.memoryMb)) memOptions.push(s.memoryMb);
  memOptions.sort((a, b) => a - b);
  const javaIsPath = s.java && !/^(auto|\d+)$/.test(s.java);

  body.innerHTML = `
    ${iconCardHtml(s)}
    ${domainCardHtml(s)}
    ${listingCardHtml(s)}
    <form id="settings-form">
      <div class="card stack">
        <h3>General</h3>
        <div class="grid3">
          <label class="field">Name <input type="text" name="name" value="${esc(s.name)}"></label>
          ${
            s.plan || s.space === 'customer'
              ? `<label class="field">Memory <input type="text" value="${fmtMem(s.memoryMb)} (${esc(s.plan ? s.plan.planName : 'plan')})" disabled></label>
                 <label class="field">Port <input type="text" value="${s.port}" disabled></label>`
              : `<label class="field">Memory
                   <select name="memoryMb">${memOptions.map((m) => `<option value="${m}" ${m === s.memoryMb ? 'selected' : ''}>${fmtMem(m)}</option>`).join('')}</select>
                 </label>
                 <label class="field">Port <input type="number" name="port" min="1" max="65535" value="${s.port}"></label>`
          }
        </div>
        <label class="check"><input type="checkbox" name="autoStart" ${s.autoStart ? 'checked' : ''}>
          <span>Start automatically when Tree Host starts <span class="muted">(so it comes back by itself after the host PC restarts)</span></span></label>
        <label class="check"><input type="checkbox" name="autoRestart" ${s.autoRestart ? 'checked' : ''}>
          <span>Restart after a crash <span class="muted">(waits 5 seconds; gives up after 3 crashes in 10 minutes)</span></span></label>
        <label class="field">Notes <span class="muted small" style="font-weight:400">(shown to everyone at the top of this server, e.g. what it's for or test accounts)</span>
          <textarea name="notes" rows="2" maxlength="2000" placeholder="e.g. Used for testing the shop plugin. Don't reset the world.">${esc(s.notes || '')}</textarea>
        </label>
        <label class="field ${s.space === 'customer' ? 'hidden' : ''}">Public join address <span class="muted small" style="font-weight:400">(shown to everyone as the address to join)</span>
          <input type="text" name="publicAddress" value="${esc(s.manualAddress || '')}" placeholder="${s.autoAddress ? `Automatic: ${esc(s.autoAddress)} (leave empty to keep it)` : 'e.g. play.example.com:25565'}">
        </label>
        <label class="field ${hostFeatures() ? '' : 'hidden'}" style="max-width:420px">Minecraft version for the 🎮 Play button
          <input type="text" name="clientVersion" value="${s.clientVersion === 'auto' ? '' : esc(s.clientVersion)}" placeholder="Automatic (${s.kind === 'proxy' || s.type === 'custom' ? 'latest release' : 'same as the server'})">
        </label>
      </div>

      <div class="card stack">
        <h3>Server software</h3>
        ${
          can('manage', s)
            ? '<p class="hint" style="margin:0">Changing the type, version or build downloads the new jar on the next start. Worlds and plugins are kept.</p>'
            : `<div class="readonly-note">🔒 Only ${s.createdByName ? `<b>${esc(s.createdByName)}</b> (who created this server)` : 'the person who created this server'} or an admin can change its type or version.</div>`
        }
        <div class="grid3">
          <label class="field">Type
            <select name="type">${state.types.filter((t) => (hostFeatures() && s.space !== 'customer') || t.id !== 'custom' || t.id === s.type).map((t) => `<option value="${t.id}" ${t.id === s.type ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select>
          </label>
          <label class="field">Version <select name="version" id="set-version"><option>${esc(s.version)}</option></select></label>
          <label class="field"><span id="set-build-label">${esc(type?.buildLabel || 'Build')}</span> <select name="build" id="set-build"><option value="${esc(s.build)}">${esc(s.build)}</option></select></label>
        </div>
        <label class="check"><input type="checkbox" id="set-pre"> Show pre-releases and snapshots</label>
        <label class="field ${s.type === 'custom' ? '' : 'hidden'}" id="set-custom-wrap">Server jar path
          <input type="text" name="customJar" value="${esc(s.customJar)}" placeholder="C:\\path\\to\\server.jar">
        </label>
        <div class="row">
          <button type="button" class="btn sm" id="btn-reinstall" ${s.pid || s.status !== 'stopped' ? 'disabled' : ''}>Re-download jar now</button>
          <span class="muted small">Re-downloads (or rebuilds) the jar, e.g. to get the latest build.</span>
        </div>
      </div>

      <div class="card stack">
        <h3>Java</h3>
        <div class="grid2">
          <label class="field">Java runtime
            <select name="javaSel" id="java-sel">
              <option value="auto" ${s.java === 'auto' ? 'selected' : ''}>Automatic${s.javaMajor && s.java === 'auto' ? ` (Java ${s.javaMajor})` : ''} (recommended)</option>
              ${[8, 11, 17, 21, 25].map((v) => `<option value="${v}" ${s.java === String(v) ? 'selected' : ''}>Java ${v}</option>`).join('')}
              ${hostFeatures() ? `<option value="path" ${javaIsPath ? 'selected' : ''}>Custom path…</option>` : ''}
            </select>
          </label>
          <label class="field ${javaIsPath ? '' : 'hidden'}" id="java-path-wrap">Path to java.exe or JDK folder
            <input type="text" name="javaPath" value="${javaIsPath ? esc(s.java) : ''}" placeholder="C:\\Program Files\\Java\\jdk-21\\bin\\java.exe">
          </label>
        </div>
        <label class="field">Extra JVM arguments
          <input type="text" name="jvmArgs" value="${esc(s.jvmArgs)}" placeholder="e.g. -XX:+UseG1GC -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=5005">
        </label>
        <label class="field">Extra server arguments <input type="text" name="serverArgs" value="${esc(s.serverArgs)}" placeholder="e.g. --forceUpgrade"></label>
        <p class="hint small" style="margin:0">Tip: add <code>-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=5005</code> to attach your IDE's debugger to port 5005.</p>
      </div>

      ${
        s.kind !== 'proxy'
          ? `<div class="card stack">
        <h3>EULA</h3>
        <label class="check"><input type="checkbox" name="eula" ${s.eula ? 'checked' : ''}>
          <span>I agree to the <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noopener">Minecraft End User License Agreement</a>. The server will not start without it.</span></label>
      </div>`
          : ''
      }
      <div class="row" style="margin-bottom:16px"><button class="btn primary">Save settings</button></div>
    </form>

    ${
      s.kind !== 'proxy'
        ? `<form id="props-form" class="card stack">
      <h3>Game settings <span class="muted small">(server.properties)</span></h3>
      <div class="grid2" id="props-grid"><div class="muted">Loading...</div></div>
      <div class="row"><button class="btn primary">Save game settings</button><span class="muted small">Applied on next (re)start. Full file is in the Files tab.</span></div>
    </form>`
        : ''
    }

    <div class="card danger-zone stack">
      <h3>Danger zone</h3>
      ${
        can('manage', s)
          ? `<div class="row"><button class="btn danger" id="btn-reset" ${s.pid ? 'disabled' : ''}>Reset worlds</button><span class="muted small">Deletes the world folders so a fresh world is generated. Plugins and configs are kept.</span></div>
      <div class="row"><button class="btn danger" id="btn-delete" ${s.pid ? 'disabled' : ''}>Delete server</button><span class="muted small">Removes this server and all its files.</span></div>`
          : `<div class="readonly-note">🔒 Only ${s.createdByName ? `<b>${esc(s.createdByName)}</b>` : 'the person who created this server'} or an admin can reset its worlds or delete it.</div>`
      }
    </div>`;

  const form = $('#settings-form');
  const typeSel = form.elements.type;
  const verSel = $('#set-version');
  const buildSel = $('#set-build');
  const pre = $('#set-pre');
  const loadVersions = async (keepVersion) => {
    const t = state.typeMap.get(typeSel.value);
    $('#set-custom-wrap').classList.toggle('hidden', t.id !== 'custom');
    $('#set-build-label').textContent = t.buildLabel;
    await fillVersionSelect(verSel, t.id, pre.checked, keepVersion);
    await fillBuildSelect(buildSel, t, verSel.value, typeSel.value === s.type && verSel.value === s.version ? s.build : 'latest');
  };
  typeSel.addEventListener('change', () => loadVersions(null));
  pre.addEventListener('change', () => loadVersions(verSel.value));
  verSel.addEventListener('change', () => fillBuildSelect(buildSel, state.typeMap.get(typeSel.value), verSel.value, 'latest'));
  pre.checked = /-(pre|rc)|snapshot|w\d/i.test(s.version);
  const lockSoftware = () => {
    if (can('manage', s)) return;
    [typeSel, verSel, buildSel, pre].forEach((el) => (el.disabled = true));
  };
  lockSoftware();
  loadVersions(s.version).then(lockSoftware);

  $('#java-sel').addEventListener('change', (e) => $('#java-path-wrap').classList.toggle('hidden', e.target.value !== 'path'));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = form.elements;
    const javaSel = f.javaSel.value;
    const patch = {
      name: f.name.value,
      ...(f.memoryMb ? { memoryMb: Number(f.memoryMb.value), port: Number(f.port.value) } : {}),
      type: f.type.value,
      version: f.version.value,
      build: f.build.value || 'latest',
      customJar: f.customJar.value,
      java: javaSel === 'path' ? f.javaPath.value.trim() : javaSel,
      jvmArgs: f.jvmArgs.value,
      serverArgs: f.serverArgs.value,
      clientVersion: f.clientVersion.value.trim() || 'auto',
      ...(s.space === 'customer' ? {} : { publicAddress: f.publicAddress.value.trim() }),
      autoStart: f.autoStart.checked,
      autoRestart: f.autoRestart.checked,
      notes: f.notes.value,
    };
    if (f.eula) patch.eula = f.eula.checked;
    if (!hostFeatures()) {
      // Host-only settings stay as the admin set them.
      delete patch.customJar;
      if (javaIsPath) delete patch.java;
      if (patch.type === 'custom') delete patch.type;
    }
    attempt(async () => {
      try {
        await api('PATCH', `/api/servers/${s.id}`, patch);
      } catch (e) {
        if (e.code !== 'DOWNGRADE') throw e;
        // Going back to an older Minecraft version: only with a fresh world (the current one is backed up first).
        if (!confirm(`${e.message}

OK: back up the world, then switch to ${patch.version} with a fresh world.
Cancel: keep the current version.`)) return;
        await api('PATCH', `/api/servers/${s.id}`, { ...patch, downgrade: 'fresh-world' });
        toast(`Switched to ${patch.version} with a fresh world. Your old world is in Backups.`);
        return;
      }
      toast(s.pid ? 'Saved. Restart the server to apply.' : 'Settings saved');
    });
  });

  $('#btn-reinstall').addEventListener('click', () =>
    attempt(async () => {
      state.tab = 'console';
      renderMain();
      await api('POST', `/api/servers/${s.id}/install`);
      toast('Jar re-downloaded');
    }),
  );
  if ($('#btn-reset')) $('#btn-reset').addEventListener('click', () => {
    if (!confirm('Delete all worlds of this server? This cannot be undone.')) return;
    attempt(async () => {
      await api('POST', `/api/servers/${s.id}/reset-worlds`);
      toast('Worlds deleted');
    });
  });
  if ($('#btn-delete')) $('#btn-delete').addEventListener('click', () => {
    if (isTeam() && s.owner && s.owner !== state.me.user.id && s.plan) {
      return openTakeAction({ target: 'server', type: 'delete', server: { id: s.id, name: s.name, ownerName: s.ownerName }, user: { id: s.owner, username: s.ownerName } });
    }
    if (prompt(`Type the server name to delete it permanently:\n${s.name}`) !== s.name) return;
    attempt(async () => {
      await api('DELETE', `/api/servers/${s.id}`);
      toast('Server deleted');
    });
  });

  bindIconCard(s);
  bindDomainCard(s);
  bindListingCard(s);
  if (s.kind !== 'proxy') loadProps(s);
}

// ---------- custom address (the owner's own domain) ----------

function domainCardHtml(s) {
  if (!isTeam() || !s.providedAddress && !s.customDomain) return '';
  const edit = can('settings', s);
  const d = s.customDomain;
  const copy = (v) => `<span class="copy" data-copy="${esc(v)}" title="Click to copy">${esc(v)}</span>`;
  return `<div class="card stack" id="domain-card">
    <h3>Custom address <span class="muted small" style="font-weight:400">(use your own domain instead of ${esc(s.providedAddress || 'the Tree Host address')})</span></h3>
    ${
      !d
        ? `<p class="hint" style="margin:0">Got a domain? Players can join with <b>play.yourserver.com</b> instead of <b>${esc(s.providedAddress)}</b>.
            You add one DNS record at your domain provider and we check it for you.</p>
           ${edit ? `<form class="row" id="domain-form" style="flex-wrap:wrap"><input type="text" name="domain" placeholder="play.yourserver.com" style="max-width:300px" autocomplete="off"><button class="btn primary">Use this domain</button></form>` : ''}`
        : `<div class="row" style="flex-wrap:wrap;align-items:center;gap:8px">
             <b style="font-size:16px">${esc(d.host)}</b>
             ${d.verified ? '<span class="badge green">✓ Working: players can join with it</span>' : '<span class="badge yellow">Waiting for your DNS record</span>'}
           </div>
           ${d.verified ? '' : `<div class="warn-box">${esc(d.message || 'Add the record below, then press Check again.')}</div>`}
           <p class="hint" style="margin:0">Add ${d.records.length === 1 ? 'this record' : 'these records'} in your domain's DNS settings (Cloudflare, Namecheap, GoDaddy...). On Cloudflare, set it to <b>DNS only</b> (grey cloud).</p>
           <div style="overflow-x:auto"><table class="dns-table"><thead><tr><th>Type</th><th>Name / host</th><th>Value</th></tr></thead><tbody>${d.records
             .map((r) => `<tr><td><b>${esc(r.type)}</b></td><td>${copy(r.name)}</td><td>${
               r.type === 'SRV'
                 ? `Priority ${copy(String(r.priority))} · Weight ${copy(String(r.weight))} · Port ${copy(String(r.port))} · Target ${copy(r.target)}`
                 : copy(r.value)
             }<div class="small muted">${esc(r.note)}</div></td></tr>`)
             .join('')}</tbody></table></div>
           <p class="small muted" style="margin:0">Some providers want only the first part of the name (e.g. <b>${esc(d.records[d.records.length - 1].name.replace(/\.[^.]+\.[^.]+$/, ''))}</b>) because they add your domain themselves.
             The Tree Host address keeps working too.</p>
           ${edit ? `<div class="row" style="flex-wrap:wrap">
             <button class="btn ${d.verified ? '' : 'primary'}" id="domain-check" type="button">Check again</button>
             <button class="btn" id="domain-remove" type="button">Remove</button>
             ${d.checkedAt ? `<span class="small muted">Last checked ${new Date(d.checkedAt).toLocaleTimeString()}</span>` : ''}</div>` : ''}`
    }
  </div>`;
}

function bindDomainCard(s) {
  const redraw = (fresh) => {
    const card = $('#domain-card');
    if (card) {
      card.outerHTML = domainCardHtml(fresh);
      bindDomainCard(fresh);
    }
  };
  const form = $('#domain-form');
  if (form) form.addEventListener('submit', (e) => {
    e.preventDefault();
    attempt(async () => {
      const r = await api('PUT', `/api/servers/${s.id}/domain`, { domain: form.domain.value });
      toast(r.customDomain.verified ? `Done: players can join with ${r.customDomain.host}` : 'Saved. Now add the DNS record shown.');
      redraw(r);
    });
  });
  const check = $('#domain-check');
  if (check) check.addEventListener('click', () => attempt(async () => {
    check.disabled = true;
    check.textContent = 'Checking...';
    const r = await api('POST', `/api/servers/${s.id}/domain/check`).finally(() => {
      check.disabled = false;
      check.textContent = 'Check again';
    });
    toast(r.customDomain.verified ? `It works! Players can join with ${r.customDomain.host}` : 'Not found yet. DNS can take a few minutes.', r.customDomain.verified ? 'info' : 'error');
    redraw(r);
  }));
  const rm = $('#domain-remove');
  if (rm) rm.addEventListener('click', () => {
    if (!confirm('Stop using this domain? Players use the Tree Host address again.')) return;
    attempt(async () => redraw(await api('PUT', `/api/servers/${s.id}/domain`, { domain: '' })));
  });
  $$('#domain-card [data-copy]').forEach((el) => el.addEventListener('click', () => navigator.clipboard.writeText(el.dataset.copy).then(() => toast('Copied'))));
}

// ---------- public server list ----------

const LIST_TAGS = ['Survival', 'SMP', 'Creative', 'Modded', 'PvP', 'Minigames', 'Skyblock', 'Roleplay', 'Factions', 'Economy', 'Parkour', 'Hardcore', 'Vanilla', 'Network'];

function listingCardHtml(s) {
  if (!isTeam()) return '';
  const edit = can('settings', s);
  const l = s.listing || {};
  const tags = new Set(l.tags || []);
  return `<form class="card stack" id="listing-card">
    <h3>Public server list <span class="muted small" style="font-weight:400">(<a href="/servers" target="_blank">treehost.online/servers</a>)</span></h3>
    <label class="check"><input type="checkbox" name="public" ${l.public ? 'checked' : ''} ${edit ? '' : 'disabled'}>
      <span><b>Show this server on the Tree Host server list</b> <span class="muted">(anyone can see its name, icon, description, address and how many players are online)</span></span></label>
    <label class="field">Description <span class="muted small" style="font-weight:400">(up to 200 characters)</span>
      <textarea name="description" rows="2" maxlength="200" placeholder="e.g. Friendly survival SMP with land claims, shops and weekly events." ${edit ? '' : 'disabled'}>${esc(l.description || '')}</textarea></label>
    <div><div class="small muted" style="margin-bottom:6px">Tags (up to 4)</div>
      <div class="row" style="flex-wrap:wrap;gap:6px">${LIST_TAGS.map((t) => `<label class="tag-pick"><input type="checkbox" name="tag" value="${t}" ${tags.has(t) ? 'checked' : ''} ${edit ? '' : 'disabled'}> ${t}</label>`).join('')}</div></div>
    <div class="grid2">
      <label class="field">Discord invite <span class="muted small" style="font-weight:400">(optional)</span><input type="url" name="discord" value="${esc(l.discord || '')}" placeholder="https://discord.gg/..." ${edit ? '' : 'disabled'}></label>
      <label class="field">Website <span class="muted small" style="font-weight:400">(optional)</span><input type="url" name="website" value="${esc(l.website || '')}" placeholder="https://..." ${edit ? '' : 'disabled'}></label>
    </div>
    ${edit ? '<div class="row"><button class="btn primary">Save list settings</button></div>' : ''}
  </form>`;
}

function bindListingCard(s) {
  const form = $('#listing-card');
  if (!form) return;
  form.addEventListener('change', (e) => {
    if (e.target.name !== 'tag') return;
    const picked = $$('[name=tag]:checked', form);
    if (picked.length > 4) {
      e.target.checked = false;
      toast('Pick up to 4 tags.', 'error');
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    attempt(async () => {
      await api('PUT', `/api/servers/${s.id}/listing`, {
        public: form.public.checked,
        description: form.description.value,
        tags: $$('[name=tag]:checked', form).map((x) => x.value),
        discord: form.discord.value,
        website: form.website.value,
      });
      toast(form.public.checked ? 'Saved: your server is on the public list' : 'Saved: your server is not on the public list');
    });
  });
}


// ---------- server icon (server-icon.png, shown in Minecraft's server list) ----------

const iconUrl = (s) => `/api/servers/${encodeURIComponent(s.id)}/icon?v=${s.icon}`;

function iconCardHtml(s) {
  const edit = can('settings', s);
  return `<div class="card stack" id="icon-card">
    <h3>Server icon <span class="muted small" style="font-weight:400">(next to your server in Minecraft's server list)</span></h3>
    <div class="row icon-row">
      <div class="mc-entry" title="How it looks in Minecraft → Multiplayer">
        ${s.icon ? `<img class="mc-icon" src="${iconUrl(s)}" alt="Server icon">` : '<div class="mc-icon mc-icon-empty">?</div>'}
        <div class="mc-text">
          <div class="mc-name">${esc(s.name)}</div>
          <div class="mc-motd">${esc(s.typeLabel)} ${esc(s.version)} on Tree Host</div>
        </div>
        <div class="mc-ping">▮▮▮▮▮</div>
      </div>
      ${edit ? `<div class="stack" style="gap:8px">
        <div class="row" style="flex-wrap:wrap">
          <label class="btn primary">${s.icon ? 'Change icon' : 'Upload icon'}<input type="file" id="icon-file" accept="image/png,image/jpeg,image/webp,image/gif" hidden></label>
          ${s.icon ? '<button class="btn" id="icon-remove" type="button">Remove</button>' : ''}
        </div>
        <span class="muted small">Any picture works: we crop it to a square and make it 64×64 pixels, like Minecraft needs. It shows after the server restarts.</span>
      </div>` : ''}
    </div>
  </div>`;
}

/** Crops a picture to the middle square and scales it to 64x64 (Minecraft's size) as a PNG. */
function makeServerIcon(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.width, img.height);
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = side > 64; // keep pixel art crisp
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 64, 64);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not make the icon.'))), 'image/png');
    };
    img.onerror = () => reject(new Error("That file isn't a picture we can read. Try a PNG or JPEG."));
    img.src = url;
  });
}

function bindIconCard(s) {
  const afterChange = async (r, msg) => {
    toast(msg);
    const fresh = { ...s, icon: r.icon || null };
    const card = $('#icon-card');
    if (card) {
      card.outerHTML = iconCardHtml(fresh);
      bindIconCard(fresh);
    }
    if (r.restartNeeded && confirm(`${msg}

Restart the server now so players see it?`)) {
      await api('POST', `/api/servers/${s.id}/restart`).catch((e) => toast(e.message, 'error'));
    }
  };
  const file = $('#icon-file');
  if (file) file.addEventListener('change', () => {
    const f = file.files[0];
    if (!f) return;
    attempt(async () => {
      if (f.size > 15 * 1024 * 1024) throw new Error('That picture is too big (15 MB at most).');
      const r = await api('PUT', `/api/servers/${s.id}/icon`, await makeServerIcon(f));
      await afterChange(r, 'Server icon saved');
    });
  });
  const rm = $('#icon-remove');
  if (rm) rm.addEventListener('click', () => {
    if (!confirm('Remove the server icon?')) return;
    attempt(async () => afterChange(await api('DELETE', `/api/servers/${s.id}/icon`), 'Server icon removed'));
  });
}

async function loadProps(s) {
  let props;
  try {
    props = await api('GET', `/api/servers/${s.id}/properties`);
  } catch (e) {
    return toast(e.message, 'error');
  }
  const grid = $('#props-grid');
  if (!grid) return;
  grid.innerHTML = PROPS.map(([key, label, kind, hint]) => {
    const v = props[key] ?? '';
    let input;
    if (Array.isArray(kind)) {
      const opts = kind.includes(v) || v === '' ? kind : [v, ...kind];
      input = `<select name="${key}">${v === '' ? '<option value="">(default)</option>' : ''}${opts.map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    } else {
      input = `<input type="${kind === 'number' ? 'number' : 'text'}" name="${key}" value="${esc(v)}" placeholder="(default)">`;
    }
    return `<label class="field" ${hint ? `title="${esc(hint)}"` : ''}>${esc(label)} <span class="muted small" style="font-weight:400">${key}</span>${input}</label>`;
  }).join('');
  $('#props-form').onsubmit = (e) => {
    e.preventDefault();
    const updates = {};
    for (const [key] of PROPS) {
      const el = e.target.elements[key];
      if (el && (el.value !== '' || props[key] !== undefined)) updates[key] = el.value;
    }
    attempt(async () => {
      await api('PUT', `/api/servers/${s.id}/properties`, updates);
      toast(current()?.pid ? 'Saved. Restart to apply.' : 'Game settings saved');
    });
  };
}

// ---------- version pickers (shared by settings & new server) ----------

const versionCache = new Map();
async function getVersions(type) {
  if (!versionCache.has(type)) {
    versionCache.set(type, api('GET', `/api/types/${type}/versions`).catch((e) => {
      versionCache.delete(type);
      throw e;
    }));
  }
  return versionCache.get(type);
}

async function fillVersionSelect(sel, type, showPre, keep) {
  sel.innerHTML = '<option>Loading...</option>';
  sel.disabled = true;
  let list;
  try {
    list = await getVersions(type);
  } catch (e) {
    sel.innerHTML = '<option value="">Could not load versions</option>';
    toast(`Could not load versions: ${e.message}`, 'error');
    return;
  }
  let shown = showPre ? list : list.filter((v) => !v.pre);
  if (keep && !shown.some((v) => v.id === keep)) shown = [{ id: keep, pre: true }, ...shown];
  sel.innerHTML = shown.length
    ? shown.map((v) => `<option value="${esc(v.id)}">${esc(v.id)}${v.pre ? ' (pre-release)' : ''}</option>`).join('')
    : '<option value="">(not applicable)</option>';
  sel.disabled = !shown.length;
  if (keep) sel.value = keep;
}

/** Selects the newest version that has a stable build (brand-new versions often only have beta builds). */
async function preferStable(sel, type) {
  if (!type.hasBuilds) return;
  for (const opt of [...sel.options].slice(0, 6)) {
    try {
      const builds = await api('GET', `/api/types/${type.id}/versions/${encodeURIComponent(opt.value)}/builds`);
      if (!builds.length || builds.some((b) => !b.channel || b.channel === 'STABLE')) {
        sel.value = opt.value;
        return;
      }
    } catch {
      return;
    }
  }
}

async function fillBuildSelect(sel, type, version, keep) {
  if (!type.hasBuilds || !version) {
    sel.innerHTML = '<option value="latest">Latest</option>';
    sel.disabled = true;
    return;
  }
  sel.disabled = true;
  sel.innerHTML = '<option value="latest">Latest stable (recommended)</option>';
  try {
    const builds = await api('GET', `/api/types/${type.id}/versions/${encodeURIComponent(version)}/builds`);
    sel.innerHTML =
      '<option value="latest">Latest stable (recommended)</option>' +
      builds
        .slice(0, 300)
        .map(
          (b) =>
            `<option value="${esc(b.id)}">#${esc(b.id)}${b.channel && b.channel !== 'STABLE' ? ` · ${esc(b.channel.toLowerCase())}` : ''}${b.time ? ` · ${esc(b.time.slice(0, 10))}` : ''}</option>`,
        )
        .join('');
    if (keep && keep !== 'latest' && !builds.some((b) => b.id === keep)) sel.innerHTML += `<option value="${esc(keep)}">#${esc(keep)}</option>`;
    sel.value = keep || 'latest';
  } catch {
    /* keep "latest" */
  }
  sel.disabled = false;
}

// ---------- new server modal ----------

async function openNewServer() {
  const root = $('#modal-root');
  // Customers: a server needs an unused plan. No plan yet -> show the plans.
  let freePlans = [];
  const forCustomer = isTeam();
  if (forCustomer) {
    const b = await api('GET', '/api/billing').catch((e) => (toast(e.message, 'error'), null));
    if (!b) return;
    freePlans = b.subscriptions.filter((x) => x.usable && planHasRoom(x));
    if (!freePlans.length) return openPlans();
  }
  const memOptions = [1024, 2048, 3072, 4096, 6144, 8192].filter((m) => !state.system || m <= state.system.totalMemMb * 0.75);
  if (!memOptions.length) memOptions.push(1024);
  const defaultMem = memOptions.includes(2048) ? 2048 : memOptions[memOptions.length - 1];
  root.innerHTML = `
    <div class="modal-bg" id="modal-bg">
      <form class="modal" id="new-form" autocomplete="off">
        <h2>${forCustomer ? 'Create your server' : isTeam() ? (state.space === 'solo' ? 'New solo server <span class="muted small" style="font-weight:400">(private to you)</span>' : 'New team server <span class="muted small" style="font-weight:400">(shared with everyone)</span>') : 'New test server'}</h2>
        <div class="section-title">Server software</div>
        <div class="type-grid">
          ${state.types
            .filter((t) => (hostFeatures() && !forCustomer) || t.id !== 'custom')
            .map(
              (t) => `
            <button type="button" class="type-card ${t.id === 'paper' ? 'active' : ''}" data-type="${t.id}">
              <div class="tc-top">${esc(t.label)}
                <span class="badge ${t.kind === 'proxy' ? 'blue' : t.family === 'bukkit' ? 'green' : t.family === 'fabric' ? 'yellow' : ''}">${
                  t.kind === 'proxy' ? 'Proxy' : t.family === 'bukkit' ? 'Plugins' : t.family === 'fabric' ? 'Mods' : 'Vanilla'
                }</span>
              </div>
              <div class="tc-desc">${esc(t.description)}</div>
            </button>`,
            )
            .join('')}
        </div>
        <div class="stack">
          <div class="grid2" id="nv-version-row">
            <label class="field"><span id="nv-version-label">Minecraft version</span> <select id="nv-version"></select></label>
            <label class="field"><span id="nv-build-label">Build</span> <select id="nv-build"></select></label>
          </div>
          <label class="check" id="nv-pre-wrap"><input type="checkbox" id="nv-pre"> Show pre-releases and snapshots</label>
          <label class="field hidden" id="nv-custom-wrap">Path to your server jar
            <input type="text" id="nv-custom" placeholder="C:\\Downloads\\pufferfish-1.21.jar">
          </label>
          <div class="section-title" style="margin-top:6px">Server</div>
          ${
            forCustomer
              ? `<div class="grid2">
                  <label class="field">Name <input type="text" id="nv-name" maxlength="40"></label>
                  <label class="field">Plan <select id="nv-plan">${freePlans
                    .map((x) => `<option value="${esc(x.id)}">${esc(x.planName)}${
                      x.slots
                        ? ` (♾️ servers ${x.slotsUsed.servers}/${x.slots.servers}, proxies ${x.slotsUsed.proxies}/${x.slots.proxies})`
                        : `: ${fmtMem(x.ramMb)}, ${x.cpus} CPU, ${x.diskGb} GB disk${x.serverCount ? ` · ${x.serverCount} server${x.serverCount === 1 ? '' : 's'} already` : ''}`
                    }</option>`)
                    .join('')}</select></label>
                </div>
                <div class="hidden"><select id="nv-mem"><option value="0"></option></select><input type="number" id="nv-port"></div>`
              : `<div class="grid3">
            <label class="field">Name <input type="text" id="nv-name"></label>
            <label class="field">Memory
              <select id="nv-mem">${memOptions.map((m) => `<option value="${m}" ${m === defaultMem ? 'selected' : ''}>${fmtMem(m)}</option>`).join('')}</select>
            </label>
            <label class="field">Port <input type="number" id="nv-port" min="1" max="65535"></label>
          </div>`
          }
          <label class="check" id="nv-online-wrap"><input type="checkbox" id="nv-online" checked>
            <span>Online mode <span class="muted">(only real Minecraft accounts can join; recommended)</span></span></label>
          <label class="check" id="nv-eula-wrap"><input type="checkbox" id="nv-eula">
            <span>I agree to the <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noopener">Minecraft EULA</a></span></label>
          <label class="check"><input type="checkbox" id="nv-start" checked> Start the server when it's installed</label>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn" id="nv-cancel">Cancel</button>
          <button class="btn primary" id="nv-create">Create server</button>
        </div>
      </form>
    </div>`;

  let type = state.typeMap.get('paper') || state.types[0];
  let nameTouched = false;
  const verSel = $('#nv-version');
  const buildSel = $('#nv-build');
  const nameInput = $('#nv-name');
  const close = () => {
    root.innerHTML = '';
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  $('#modal-bg').addEventListener('mousedown', (e) => e.target.id === 'modal-bg' && close());
  $('#nv-cancel').addEventListener('click', close);

  const autoName = () => {
    if (nameTouched) return;
    nameInput.value = type.id === 'custom' ? 'Custom server' : `${type.label} ${verSel.value && verSel.value !== 'latest' ? verSel.value : ''}`.trim();
  };
  nameInput.addEventListener('input', () => (nameTouched = true));

  const setPort = async () => {
    if (forCustomer) return;
    try {
      $('#nv-port').value = (await api('GET', `/api/next-port?kind=${type.kind}`)).port;
    } catch {
      $('#nv-port').value = type.kind === 'proxy' ? 25577 : 25565;
    }
  };

  const onTypeChange = async () => {
    const isProxy = type.kind === 'proxy';
    $('#nv-custom-wrap').classList.toggle('hidden', type.id !== 'custom');
    $('#nv-version-row').classList.toggle('hidden', type.id === 'custom' || type.id === 'bungeecord');
    $('#nv-pre-wrap').classList.toggle('hidden', type.id === 'custom' || type.id === 'bungeecord' || type.id === 'spigot' || type.id === 'craftbukkit');
    // The EULA applies to every server type, proxies included (they connect players to Minecraft servers).
    $('#nv-online-wrap').classList.toggle('hidden', isProxy);
    // Proxies have their own version numbers (e.g. Velocity 3.x), not Minecraft's.
    $('#nv-version-label').textContent = isProxy ? `${type.label} version` : 'Minecraft version';
    $('#nv-build-label').textContent = type.buildLabel;
    setPort();
    if (type.id === 'custom') {
      autoName();
      return;
    }
    await fillVersionSelect(verSel, type.id, $('#nv-pre').checked);
    await preferStable(verSel, type);
    autoName();
    await fillBuildSelect(buildSel, type, verSel.value, 'latest');
  };

  $$('.type-card', root).forEach((c) =>
    c.addEventListener('click', () => {
      $$('.type-card', root).forEach((x) => x.classList.toggle('active', x === c));
      type = state.typeMap.get(c.dataset.type);
      onTypeChange();
    }),
  );
  $('#nv-pre').addEventListener('change', async () => {
    await fillVersionSelect(verSel, type.id, $('#nv-pre').checked, verSel.value);
    await fillBuildSelect(buildSel, type, verSel.value, 'latest');
  });
  verSel.addEventListener('change', () => {
    autoName();
    fillBuildSelect(buildSel, type, verSel.value, 'latest');
  });

  $('#new-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!$('#nv-eula').checked) {
      toast('Please accept the Minecraft EULA to create a server.', 'error');
      return;
    }
    const body = {
      type: type.id,
      version: type.id === 'custom' ? 'custom' : type.id === 'bungeecord' ? 'latest' : verSel.value,
      build: buildSel.disabled ? 'latest' : buildSel.value || 'latest',
      name: nameInput.value.trim(),
      memoryMb: Number($('#nv-mem').value),
      port: Number($('#nv-port').value),
      onlineMode: $('#nv-online').checked,
      eula: $('#nv-eula').checked,
      customJar: $('#nv-custom').value.trim(),
      startAfterInstall: $('#nv-start').checked,
      space: currentSpace() || undefined,
      ...(forCustomer ? { subscriptionId: $('#nv-plan').value } : {}),
    };
    if (type.id === 'custom' && !body.customJar) return toast('Enter the path to your server jar', 'error');
    if (!body.version) return toast('Pick a version', 'error');
    $('#nv-create').disabled = true;
    attempt(async () => {
      const created = await api('POST', '/api/servers', body);
      state.servers.set(created.id, created);
      close();
      state.tab = 'console';
      select(created.id);
    }).finally(() => {
      const b = $('#nv-create');
      if (b) b.disabled = false;
    });
  });

  onTypeChange();
}
window.openNewServer = openNewServer;

// ---------- live updates ----------

function applySnapshot(list) {
  state.servers = new Map(list.map((s) => [s.id, s]));
  const visible = spaceServers();
  if (!visible.some((s) => s.id === state.selected)) {
    const remembered = localStorage.getItem('mcpt.selected');
    state.selected = visible.some((s) => s.id === remembered) ? remembered : visible[0]?.id || null;
  }
  renderSidebar();
  renderMain();
}

function applyStatus(s) {
  const prev = state.servers.get(s.id);
  state.servers.set(s.id, s);
  renderSidebar();
  if (s.id === state.selected) {
    if (!$('#srv-head')) renderMain();
    else renderHeader();
    if (state.tab === 'plugins') {
      if ($('#watch-list') && JSON.stringify(prev?.watches) !== JSON.stringify(s.watches)) renderWatches();
      if (prev && prev.status !== s.status && (s.status === 'stopped' || s.status === 'running')) loadPlugins();
    }
  }
  if (prev && prev.status !== 'stopped' && s.status === 'stopped') refreshSystem();
}

function applyRemoved(id) {
  state.servers.delete(id);
  if (state.selected === id) state.selected = spaceServers()[0]?.id || null;
  renderSidebar();
  renderMain();
}

function connectEvents() {
  const es = new EventSource('/api/events');
  let gotSnapshot = false;
  // Some proxies (e.g. Cloudflare quick tunnels) hold back streaming responses; fall back to polling then.
  const fallback = setTimeout(() => {
    if (gotSnapshot) return;
    es.close();
    startPolling();
  }, 6000);
  es.addEventListener('open', () => $('#offline').classList.add('hidden'));
  es.addEventListener('error', () => {
    if (gotSnapshot) $('#offline').classList.remove('hidden');
  });
  es.addEventListener('snapshot', (e) => {
    gotSnapshot = true;
    clearTimeout(fallback);
    $('#offline').classList.add('hidden');
    applySnapshot(JSON.parse(e.data));
  });
  es.addEventListener('status', (e) => applyStatus(JSON.parse(e.data)));
  es.addEventListener('removed', (e) => applyRemoved(JSON.parse(e.data).id));
  es.addEventListener('activity', (e) => onActivity(JSON.parse(e.data)));
  es.addEventListener('log', (e) => {
    const { id, lines } = JSON.parse(e.data);
    if (id === state.selected && state.log.id === id) appendLines(lines);
  });
}

function startPolling() {
  let first = true;
  const tick = async () => {
    try {
      const list = await api('GET', '/api/servers');
      $('#offline').classList.add('hidden');
      if (first) {
        first = false;
        applySnapshot(list);
      } else {
        const ids = new Set(list.map((s) => s.id));
        for (const id of [...state.servers.keys()]) if (!ids.has(id)) applyRemoved(id);
        for (const s of list) {
          if (JSON.stringify(state.servers.get(s.id)) !== JSON.stringify(s)) applyStatus(s);
        }
      }
      const id = state.log.id;
      if (id && id === state.selected && !state.log.loading) {
        const { lines } = await api('GET', `/api/servers/${id}/log?since=${state.log.lastSeq}`);
        if (state.log.id === id) appendLines(lines);
      }
    } catch {
      $('#offline').classList.remove('hidden');
    }
    setTimeout(tick, 1500);
  };
  tick();
}

async function refreshSystem() {
  try {
    state.system = await api('GET', '/api/system');
    renderSysInfo();
  } catch {
    /* ignore */
  }
}

async function init() {
  try {
    state.me = await api('GET', '/api/auth/me');
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  const pending = sessionStorage.getItem('th.toast');
  if (pending) {
    sessionStorage.removeItem('th.toast');
    setTimeout(() => toast(pending), 300);
  }
  if (state.me.teamMode && (!state.me.user || new URLSearchParams(location.search).has('invite') || new URLSearchParams(location.search).has('add-account'))) {
    showAuth();
    return;
  }
  checkEmailVerified();
  if (state.me.user && state.me.user.restriction) {
    showRestricted().catch((e) => toast(e.message, 'error'));
    return;
  }
  if (location.pathname.replace(/\/$/, '') === '/admin') {
    initConsole();
    return;
  }
  const params = new URLSearchParams(location.search);
  if (state.me.teamMode && params.has('reset')) {
    showAuth('reset');
    return;
  }
  state.space = localStorage.getItem('hh.space') === 'all' ? 'all' : 'mine';
  renderSpaceSwitch();
  renderUserBox();
  $('#btn-new').addEventListener('click', openNewServer);
  $('#activity-link').addEventListener('click', (e) => {
    e.preventDefault();
    openActivity();
  });
  renderActivityLink();
  if (isTeam()) {
    $('#inbox-link').classList.remove('hidden');
    $('#inbox-link').addEventListener('click', (e) => {
      e.preventDefault();
      openInbox().catch((err) => toast(err.message, 'error'));
    });
    refreshInboxBadge(!params.has('inbox'));
    setInterval(() => refreshInboxBadge(), 60000);
    if (params.has('inbox')) {
      history.replaceState(null, '', location.pathname);
      openInbox().catch((err) => toast(err.message, 'error'));
    }
  }
  setInterval(refreshSystem, 20000);
  try {
    state.types = await api('GET', '/api/types');
    state.typeMap = new Map(state.types.map((t) => [t.id, t]));
  } catch (e) {
    toast(e.message, 'error');
  }
  await refreshSystem();
  connectEvents();
  // Back from Stripe Checkout, from a billing email, or right after signing up.
  if (params.has('billing') || params.has('welcome')) history.replaceState(null, '', location.pathname);
  if (params.get('billing') === 'success') {
    toast('Thanks! Your plan is active. Now create your server.');
    setTimeout(openNewServer, 600);
  } else if (params.get('billing') === 'canceled') toast('Checkout canceled. No payment was taken.');
  else if (params.has('billing')) openBilling();
  else if (params.has('welcome')) setTimeout(openPlans, 400);
}

window.addEventListener('beforeunload', (e) => {
  if (state.files.dirty) e.preventDefault();
});

init();
