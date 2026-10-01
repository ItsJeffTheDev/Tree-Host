'use strict';
// Team extras: activity feed, "I'm testing this" claims, backups, the Modrinth plugin browser and Discord notifications.
// Loaded before app.js; uses app.js/team.js helpers ($, esc, api, toast, attempt, state, openModal, can) at call time.

function timeAgo(t) {
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

function fmtCount(n) {
  return n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : String(n);
}

// ---------- activity feed ----------

const ACTIVITY_ICON = { crash: '💥', deploy: '🧩', start: '▶', stop: '■', claim: '🙋', backup: '💾', server: '🖥', people: '👤' };

function activityItem(e, withServer = true) {
  return `<div class="act-item act-${esc(e.kind)}">
    <span class="act-icon">${ACTIVITY_ICON[e.kind] || '•'}</span>
    <div class="act-text"><b>${esc(e.who)}</b> ${esc(e.text)}${withServer && e.serverName ? ` <span class="muted">on</span> <a class="act-server" data-sid="${esc(e.serverId)}">${esc(e.serverName)}</a>` : ''}
      <div class="small muted" title="${esc(new Date(e.t).toLocaleString())}">${timeAgo(e.t)}</div></div>
  </div>`;
}

async function openActivity() {
  state.unseenActivity = 0;
  renderActivityLink();
  const { root, close } = openModal(`
    <h2>Activity</h2>
    <p class="hint" style="margin-top:-6px">What everyone has been doing: starts, stops, deploys, crashes, backups and more.</p>
    <div class="row" style="margin-bottom:10px">
      <select id="act-filter" style="max-width:220px">
        <option value="">Everything</option>
        ${Object.entries({ crash: 'Crashes', deploy: 'Deploys & plugin installs', start: 'Starts', stop: 'Stops', claim: 'Testing sessions', backup: 'Backups', server: 'Servers created / deleted', people: 'People' })
          .map(([k, v]) => `<option value="${k}">${v}</option>`)
          .join('')}
      </select>
    </div>
    <div id="act-list" class="act-list muted">Loading...</div>
    <div class="modal-actions"><button class="btn" data-close>Close</button></div>`);
  let events = [];
  const draw = () => {
    const f = $('#act-filter', root).value;
    const list = events.filter((e) => !f || e.kind === f);
    $('#act-list', root).innerHTML = list.length ? list.map((e) => activityItem(e)).join('') : '<div class="muted">Nothing here yet.</div>';
    $$('.act-server', root).forEach((a) =>
      a.addEventListener('click', () => {
        if (!state.servers.has(a.dataset.sid)) return toast('That server no longer exists.', 'error');
        const s = state.servers.get(a.dataset.sid);
        close();
        if (isTeam()) setSpace(s.space === 'solo' ? 'solo' : 'team');
        select(a.dataset.sid);
      }),
    );
  };
  $('#act-filter', root).addEventListener('change', draw);
  state.activityRefresh = (e) => {
    if (!document.body.contains(root.firstChild)) return (state.activityRefresh = null);
    events.unshift(e);
    draw();
  };
  try {
    events = await api('GET', '/api/activity?limit=300');
    draw();
  } catch (e) {
    $('#act-list', root).textContent = e.message;
  }
}

function renderActivityLink() {
  const el = $('#activity-link');
  if (!el) return;
  el.innerHTML = `📋 Activity${state.unseenActivity ? ` <span class="count">${state.unseenActivity}</span>` : ''}`;
}

/** Live activity event from the server (SSE). */
function onActivity(e) {
  const mine = state.me?.user && e.who === state.me.user.username;
  if (!mine) {
    state.unseenActivity = (state.unseenActivity || 0) + 1;
    renderActivityLink();
  }
  if (state.activityRefresh) state.activityRefresh(e);
  if (e.kind === 'crash') toast(`💥 ${e.serverName || 'A server'} crashed. Check its console.`, 'error');
  else if (!mine && ['deploy', 'claim'].includes(e.kind) && e.serverId === state.selected) toast(`${e.who} ${e.text}`);
}

// ---------- backups ----------

async function renderBackups(body) {
  const s = current();
  const canMake = can('control', s);
  const canRestore = can('manage', s);
  body.innerHTML = `
    <div class="card stack">
      <h3>Make a backup</h3>
      <p class="hint" style="margin:0">Saves a copy of the world${s.kind === 'proxy' ? '' : 's (overworld, nether and end)'} and the <code>${esc(s.pluginDir)}/</code> folder, including plugin configs and data.
      Works while the server is running: the world is saved first.</p>
      ${
        canMake
          ? `<form id="bk-form" class="row">
              <input type="text" id="bk-label" maxlength="80" placeholder="Name (optional), e.g. before testing the new economy">
              <button class="btn primary" id="bk-make">💾 Back up now</button>
            </form>`
          : '<div class="readonly-note">🔒 Your role can\'t make backups.</div>'
      }
      ${can('settings', s) ? `<label class="field" style="max-width:360px">Automatic backups
        <select id="bk-auto">
          ${[['off', 'Off'], ['6h', 'Every 6 hours'], ['12h', 'Every 12 hours'], ['daily', 'Once a day']]
            .map(([v, l]) => `<option value="${v}" ${s.autoBackup === v ? 'selected' : ''}>${l}</option>`)
            .join('')}
        </select>
        <span class="muted small" style="font-weight:400">${
          s.space === 'customer'
            ? 'The newest 3 automatic backups are kept, and up to 5 you make yourself.'
            : 'The newest 7 automatic backups are kept. Backups you make yourself are kept until you delete them.'
        }</span>
      </label>` : ''}
    </div>
    <div class="card">
      <h3 style="margin-bottom:8px">Backups</h3>
      <div id="bk-list" class="muted">Loading...</div>
    </div>`;

  const load = async () => {
    const list = await api('GET', `/api/servers/${s.id}/backups`);
    const el = $('#bk-list', body);
    if (!el) return;
    el.innerHTML = list.length
      ? `<table><thead><tr><th>Backup</th><th>Made</th><th>Size</th><th></th></tr></thead><tbody>${list
          .map(
            (b) => `<tr>
              <td><b>${esc(b.label)}</b>${b.automatic ? ' <span class="badge">auto</span>' : ''}<div class="small muted">${esc(b.version)} · by ${esc(b.by)}</div></td>
              <td title="${esc(new Date(b.createdAt).toLocaleString())}">${timeAgo(b.createdAt)}</td>
              <td>${fmtSize(b.size)}</td>
              <td class="actions-cell">${
                canRestore
                  ? `<button class="btn sm" data-restore="${esc(b.id)}">Restore</button> <button class="btn sm danger" data-bdel="${esc(b.id)}">Delete</button>`
                  : ''
              }</td></tr>`,
          )
          .join('')}</tbody></table>`
      : 'No backups yet.';
    $$('[data-restore]', el).forEach((b) =>
      b.addEventListener('click', () => {
        const cur = current();
        if (cur.pid) return toast('Stop the server first, then restore.', 'error');
        if (!confirm('Replace the current world and plugins folder with this backup?\n\nAnything changed since the backup is lost. Tip: make a backup of the current state first.')) return;
        attempt(async () => {
          await api('POST', `/api/servers/${s.id}/backups/${b.dataset.restore}/restore`);
          toast('Backup restored. Start the server to use it.');
        });
      }),
    );
    $$('[data-bdel]', el).forEach((b) =>
      b.addEventListener('click', () => {
        if (!confirm('Delete this backup permanently?')) return;
        attempt(async () => {
          await api('DELETE', `/api/servers/${s.id}/backups/${b.dataset.bdel}`);
          load();
        });
      }),
    );
  };

  if ($('#bk-form', body)) {
    $('#bk-form', body).addEventListener('submit', (e) => {
      e.preventDefault();
      const btn = $('#bk-make', body);
      btn.disabled = true;
      btn.textContent = 'Backing up...';
      api('POST', `/api/servers/${s.id}/backups`, { label: $('#bk-label', body).value })
        .then((b) => {
          toast(`Backup made (${fmtSize(b.size)})`);
          $('#bk-label', body).value = '';
          return load();
        })
        .catch((err) => toast(err.message, 'error'))
        .finally(() => {
          btn.disabled = false;
          btn.textContent = '💾 Back up now';
        });
    });
  }
  if ($('#bk-auto', body)) {
    $('#bk-auto', body).addEventListener('change', (e) =>
      attempt(async () => {
        await api('PATCH', `/api/servers/${s.id}`, { autoBackup: e.target.value });
        toast(e.target.value === 'off' ? 'Automatic backups turned off' : 'Automatic backups turned on');
      }),
    );
  }
  load().catch((e) => {
    const el = $('#bk-list', body);
    if (el) el.textContent = e.message;
  });
}

// ---------- plugin / mod browser (Modrinth) ----------

function openPluginBrowser(s) {
  const what = s.pluginDir === 'mods' ? 'mods' : 'plugins';
  const { root } = openModal(`
    <h2>Browse ${what}</h2>
    <p class="hint" style="margin-top:-6px">From <a href="https://modrinth.com" target="_blank" rel="noopener">Modrinth</a>, showing only ${what} that work on
      <b>${esc(s.typeLabel)} ${esc(s.version)}</b>. Installing downloads the newest matching version into <code>${esc(s.pluginDir)}/</code>.</p>
    <form id="mr-form" class="row" style="margin-bottom:10px">
      <input type="search" id="mr-q" placeholder="Search, e.g. LuckPerms, WorldEdit, Vault..." autofocus>
      <button class="btn primary">Search</button>
    </form>
    <div id="mr-results" class="mr-results muted">Loading popular ${what}...</div>
    <div class="modal-actions"><button class="btn" data-close>Close</button></div>`);
  root.querySelector('.modal').classList.add('wide');
  const search = async () => {
    const out = $('#mr-results', root);
    out.innerHTML = 'Searching...';
    try {
      const hits = await api('GET', `/api/servers/${s.id}/modrinth/search?q=${encodeURIComponent($('#mr-q', root).value.trim())}`);
      out.classList.remove('muted');
      out.innerHTML = hits.length
        ? hits
            .map(
              (h) => `<div class="mr-item">
                ${h.icon ? `<img src="${esc(h.icon)}" alt="" loading="lazy">` : '<div class="mr-noicon">🧩</div>'}
                <div class="mr-body">
                  <div><a href="${esc(h.url)}" target="_blank" rel="noopener"><b>${esc(h.title)}</b></a> <span class="muted small">by ${esc(h.author)} · ⬇ ${fmtCount(h.downloads)}</span></div>
                  <div class="small muted">${esc(h.description)}</div>
                </div>
                <button class="btn sm primary" data-install="${esc(h.id)}" data-title="${esc(h.title)}">Install</button>
              </div>`,
            )
            .join('')
        : `<div class="muted">No ${what} found for this version.</div>`;
      $$('[data-install]', out).forEach((b) =>
        b.addEventListener('click', () => {
          b.disabled = true;
          b.textContent = 'Installing...';
          api('POST', `/api/servers/${s.id}/modrinth/install`, { project: b.dataset.install, title: b.dataset.title })
            .then((r) => {
              b.textContent = '✓ Installed';
              toast(`Installed ${r.file}${current()?.pid ? '. Restart the server to load it.' : ''}`);
              if (state.tab === 'plugins') loadPlugins();
            })
            .catch((err) => {
              toast(err.message, 'error');
              b.disabled = false;
              b.textContent = 'Install';
            });
        }),
      );
    } catch (e) {
      out.textContent = e.message;
    }
  };
  $('#mr-form', root).addEventListener('submit', (e) => {
    e.preventDefault();
    search();
  });
  search();
}

// ---------- Discord notifications (Team panel) ----------

async function renderNotifications(root) {
  const el = $('#notify-body', root);
  const st = await api('GET', '/api/team/notifications');
  el.classList.remove('muted');
  el.innerHTML = `
    <p class="hint" style="margin:0">Posts to a private channel in your Discord when something happens, so admins notice new customers, payments and crashes.
      To get a link: Discord → channel settings (⚙) → Integrations → Webhooks → New Webhook → Copy Webhook URL.</p>
    <div class="row">
      <input type="password" id="dc-url" placeholder="${st.discordConnected ? 'Connected. Paste a new link to change it' : 'https://discord.com/api/webhooks/...'}" autocomplete="off">
      <button class="btn primary" id="dc-save">Save</button>
      ${st.discordConnected ? '<button class="btn" id="dc-test">Send test</button><button class="btn danger" id="dc-off">Disconnect</button>' : ''}
    </div>
    <div class="notify-kinds">${Object.entries(st.available)
      .map(([k, label]) => `<label class="check"><input type="checkbox" data-kind="${k}" ${st.kinds[k] ? 'checked' : ''}> ${esc(label)}</label>`)
      .join('')}</div>`;
  const redraw = () => renderNotifications(root).catch((e) => toast(e.message, 'error'));
  $('#dc-save', el).addEventListener('click', () =>
    attempt(async () => {
      const url = $('#dc-url', el).value.trim();
      if (!url) return toast('Paste the webhook link first.', 'error');
      await api('PUT', '/api/team/notifications', { discordWebhook: url });
      toast('Discord connected');
      redraw();
    }),
  );
  if ($('#dc-test', el))
    $('#dc-test', el).addEventListener('click', () =>
      attempt(async () => {
        await api('POST', '/api/team/notifications/test');
        toast('Test message sent. Check your Discord channel.');
      }),
    );
  if ($('#dc-off', el))
    $('#dc-off', el).addEventListener('click', () =>
      attempt(async () => {
        await api('PUT', '/api/team/notifications', { discordWebhook: '' });
        toast('Discord disconnected');
        redraw();
      }),
    );
  $$('[data-kind]', el).forEach((c) =>
    c.addEventListener('change', () => attempt(() => api('PUT', '/api/team/notifications', { kinds: { [c.dataset.kind]: c.checked } }))),
  );
}
