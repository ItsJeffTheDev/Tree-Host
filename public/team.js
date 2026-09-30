'use strict';
// Team mode UI: sign-in screens, account & team panels, and deploy-from-build instructions.
// Loaded before app.js; uses app.js helpers ($, esc, api, toast, attempt, state) at call time.

function isTeam() {
  return !!(state.me && state.me.teamMode);
}

function isAdmin() {
  return !isTeam() || state.me.user?.role === 'admin';
}

const ROLE_LABEL = { admin: 'Admin', dev: 'Developer', tester: 'Tester', pending: 'Pending' };
const ROLE_OPTIONS = (selected) =>
  ['dev', 'tester', 'admin'].map((r) => `<option value="${r}" ${r === selected ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('');

/**
 * Mirrors the server's permission rules so the dashboard only shows what you can use.
 * Actions: view, control, command, plugins, files, settings, deploy, manage (delete / reset world / change version).
 */
function can(action, s) {
  if (!isTeam()) return true;
  const u = state.me.user;
  if (u.role === 'admin') return true;
  if (u.role === 'tester') return action === 'view' || action === 'control';
  if (s && s.isGateway && action !== 'view' && action !== 'control') return false;
  if (action === 'manage' && s && s.space !== 'solo') return s.createdBy === u.id;
  return true;
}

function isTester() {
  return isTeam() && state.me.user.role === 'tester';
}

/** Features that act on the host PC itself (Play, open folder, local build watching, custom paths). */
function hostFeatures() {
  // In the cloud there is no desktop to open folders or play on.
  return isAdmin() && !state.me?.cloud;
}

// ---------- sign in / setup / invite ----------

function showAuth(forceMode) {
  const invite = new URLSearchParams(location.search).get('invite');
  if (state.me?.user?.role === 'pending') return showPending();
  const mode = forceMode || (invite ? 'invite' : state.me?.needsSetup ? 'setup' : 'login');
  const titles = {
    login: ['Sign in', 'Sign in to Honey Host.'],
    setup: ['Set up Honey Host', 'Create the first admin account. The setup code is shown in the Honey Host window on the host PC.'],
    invite: ['Join the team', 'You were invited to the team\'s Minecraft test servers. Create your account.'],
    signup: ['Request access', 'Create an account. An admin has to approve it before you can use the servers.'],
  };
  const [title, sub] = titles[mode];
  document.body.innerHTML = `
    <div class="auth-screen">
      <form class="auth-card stack" id="auth-form" autocomplete="on">
        <div class="brand"><div class="logo"></div><div><div class="brand-name">Honey Host</div><div class="brand-sub">by Honey Pixel Studios</div></div></div>
        <h2>${esc(title)}</h2>
        <p class="muted" style="margin:0">${esc(sub)}</p>
        ${mode === 'setup' ? '<label class="field">Setup code <input type="text" name="code" inputmode="numeric" required autocomplete="off"></label>' : ''}
        <label class="field">Username <input type="text" name="username" required autocomplete="username"></label>
        <label class="field">Password <input type="password" name="password" required minlength="${mode === 'login' ? 1 : 8}" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}"></label>
        ${
          mode !== 'login'
            ? `<label class="field">Minecraft username <span class="muted small" style="font-weight:400">(so you're whitelisted on the test servers)</span>
                 <input type="text" name="mcName" maxlength="16" autocomplete="off"></label>`
            : ''
        }
        <div id="auth-error" class="auth-error hidden"></div>
        <button class="btn primary block">${mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Request access' : 'Create account'}</button>
        <p class="small muted" style="margin:0;text-align:center">New here? <a href="help.html" target="_blank">Read the getting-started guide</a></p>
        ${
          mode === 'login' && state.me?.allowSignup
            ? '<p class="small muted" style="margin:0;text-align:center">No account yet? <a href="#" id="to-signup">Request access</a></p>'
            : mode === 'signup'
              ? '<p class="small muted" style="margin:0;text-align:center">Already have an account? <a href="#" id="to-login">Sign in</a></p>'
              : ''
        }
      </form>
    </div>
    <div id="toasts" class="toasts"></div>`;
  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const body = { username: f.username.value.trim(), password: f.password.value };
    if (f.mcName) body.mcName = f.mcName.value.trim();
    if (f.code) body.code = f.code.value.trim();
    if (invite) body.invite = invite;
    const url = { login: '/api/auth/login', setup: '/api/auth/setup', invite: '/api/auth/accept-invite', signup: '/api/auth/signup' }[mode];
    try {
      await api('POST', url, body);
      location.href = '/';
    } catch (err) {
      const box = $('#auth-error');
      box.textContent = err.message;
      box.classList.remove('hidden');
    }
  });
  $('#auth-form input').focus();
  if ($('#to-signup')) $('#to-signup').addEventListener('click', (e) => (e.preventDefault(), showAuth('signup')));
  if ($('#to-login')) $('#to-login').addEventListener('click', (e) => (e.preventDefault(), showAuth('login')));
}

/** Shown to people whose sign-up hasn't been approved yet; checks every few seconds. */
function showPending() {
  document.body.innerHTML = `
    <div class="auth-screen">
      <div class="auth-card stack">
        <div class="brand"><div class="logo"></div><div><div class="brand-name">Honey Host</div><div class="brand-sub">by Honey Pixel Studios</div></div></div>
        <h2>Waiting for approval</h2>
        <p class="muted" style="margin:0">Thanks, <b>${esc(state.me.user.username)}</b>! An admin needs to approve your account.
          This page opens the dashboard automatically once you're approved.</p>
        <button class="btn" id="pending-logout">Sign out</button>
      </div>
    </div>`;
  $('#pending-logout').addEventListener('click', async () => {
    await api('POST', '/api/auth/logout').catch(() => {});
    location.href = '/';
  });
  const check = async () => {
    try {
      const me = await api('GET', '/api/auth/me');
      if (me.user && me.user.role !== 'pending') return location.reload();
      if (!me.user) return (location.href = '/');
    } catch {
      /* try again */
    }
    setTimeout(check, 5000);
  };
  setTimeout(check, 5000);
}

// ---------- sidebar user box ----------

function renderUserBox() {
  const el = $('#user-box');
  if (!el) return;
  if (!isTeam()) {
    el.classList.add('hidden');
    return;
  }
  const u = state.me.user;
  el.classList.remove('hidden');
  el.innerHTML = `
    <div class="ub-name">${esc(u.username)} <span class="badge ${u.role === 'admin' ? 'green' : u.role === 'tester' ? 'blue' : ''}">${ROLE_LABEL[u.role] || u.role}</span></div>
    ${u.mcName ? '' : '<div class="ub-warn">Set your Minecraft name in Account to be whitelisted.</div>'}
    ${
      state.me.publicUrl
        ? `<div class="ub-link small">Internet: <span class="copy" data-copy="${esc(state.me.publicUrl)}" title="Click to copy">${esc(state.me.publicUrl.replace('https://', ''))}</span></div>`
        : ''
    }
    ${
      state.me.lanUrls?.length
        ? `<div class="ub-link small">Home network: <span class="copy" data-copy="${esc(state.me.lanUrls[1] || state.me.lanUrls[0])}" title="Click to copy. Also works: ${esc(state.me.lanUrls.join(', '))}">${esc((state.me.lanUrls[1] || state.me.lanUrls[0]).replace('http://', ''))}</span></div>`
        : ''
    }
    <div class="row" style="flex-wrap:wrap;margin-top:6px">
      <button class="btn sm" id="ub-account">Account</button>
      ${isAdmin() ? `<button class="btn sm" id="ub-team">Team${state.me.pendingCount ? ` <span class="count">${state.me.pendingCount}</span>` : ''}</button>` : ''}
      <button class="btn sm" id="ub-logout">Sign out</button>
    </div>`;
  $('#ub-account').addEventListener('click', openAccount);
  if ($('#ub-team')) $('#ub-team').addEventListener('click', openTeam);
  $('#ub-logout').addEventListener('click', async () => {
    await api('POST', '/api/auth/logout').catch(() => {});
    location.href = '/';
  });
  $$('[data-copy]', el).forEach((b) =>
    b.addEventListener('click', () => navigator.clipboard.writeText(b.dataset.copy).then(() => toast('Copied'))),
  );
}

function openModal(html) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-bg" id="modal-bg"><div class="modal">${html}</div></div>`;
  const close = () => {
    root.innerHTML = '';
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  $('#modal-bg').addEventListener('mousedown', (e) => e.target.id === 'modal-bg' && close());
  $$('[data-close]', root).forEach((b) => b.addEventListener('click', close));
  return { root, close };
}

// ---------- account ----------

async function openAccount() {
  const u = state.me.user;
  const { root } = openModal(`
    <h2>Your account</h2>
    <form id="acc-mc" class="card stack">
      <h3>Minecraft name</h3>
      <p class="hint" style="margin:0">Test servers whitelist every team member's Minecraft name automatically.</p>
      <div class="row"><input type="text" name="mcName" maxlength="16" value="${esc(u.mcName)}" placeholder="YourMinecraftName"><button class="btn primary">Save</button></div>
    </form>
    <div class="card stack">
      <h3>API tokens</h3>
      <p class="hint" style="margin:0">Used by your build (Gradle, Maven or curl) to deploy plugins to the test servers. Treat them like passwords.</p>
      <div id="tok-list" class="muted">Loading...</div>
      <form id="tok-form" class="row"><input type="text" name="name" placeholder="Token name, e.g. Laptop" maxlength="60"><button class="btn primary">Create token</button></form>
      <div id="tok-new" class="hidden"></div>
    </div>
    <form id="acc-pw" class="card stack">
      <h3>Change password</h3>
      <div class="grid2">
        <input type="password" name="currentPassword" placeholder="Current password" autocomplete="current-password">
        <input type="password" name="password" placeholder="New password (8+ characters)" minlength="8" autocomplete="new-password">
      </div>
      <div><button class="btn">Change password</button></div>
    </form>
    <div class="modal-actions"><button class="btn" data-close>Close</button></div>`);

  const loadTokens = async () => {
    const list = await api('GET', '/api/auth/tokens');
    $('#tok-list', root).innerHTML = list.length
      ? `<table><tbody>${list
          .map(
            (t) => `<tr><td>${esc(t.name)}</td><td class="small muted">created ${new Date(t.createdAt).toLocaleDateString()}${
              t.lastUsed ? ` · last used ${new Date(t.lastUsed).toLocaleString()}` : ' · never used'
            }</td><td class="actions-cell"><button class="btn sm danger" data-tdel="${esc(t.id)}">Delete</button></td></tr>`,
          )
          .join('')}</tbody></table>`
      : 'No tokens yet.';
    $$('[data-tdel]', root).forEach((b) =>
      b.addEventListener('click', () => {
        if (!confirm('Delete this token? Builds using it will stop deploying.')) return;
        attempt(async () => {
          await api('DELETE', `/api/auth/tokens/${b.dataset.tdel}`);
          loadTokens();
        });
      }),
    );
  };
  loadTokens().catch((e) => toast(e.message, 'error'));

  $('#acc-mc', root).addEventListener('submit', (e) => {
    e.preventDefault();
    attempt(async () => {
      state.me.user = await api('PATCH', '/api/auth/me', { mcName: e.target.elements.mcName.value.trim() });
      renderUserBox();
      toast('Saved. You are whitelisted the next time a server starts (or an admin clicks "Whitelist team").');
    });
  });
  $('#acc-pw', root).addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target.elements;
    attempt(async () => {
      await api('PATCH', '/api/auth/me', { currentPassword: f.currentPassword.value, password: f.password.value });
      f.currentPassword.value = '';
      f.password.value = '';
      toast('Password changed');
    });
  });
  $('#tok-form', root).addEventListener('submit', (e) => {
    e.preventDefault();
    const name = e.target.elements.name.value.trim() || 'Token';
    attempt(async () => {
      const { token } = await api('POST', '/api/auth/tokens', { name });
      e.target.elements.name.value = '';
      const box = $('#tok-new', root);
      box.classList.remove('hidden');
      box.innerHTML = `
        <div class="token-box">
          <div class="small"><b>Copy this token now.</b> It won't be shown again.</div>
          <code class="copy" data-copy="${esc(token)}" title="Click to copy">${esc(token)}</code>
        </div>`;
      $('[data-copy]', box).addEventListener('click', (ev) =>
        navigator.clipboard.writeText(ev.target.dataset.copy).then(() => toast('Token copied')),
      );
      loadTokens();
    });
  });
}

// ---------- team (admins) ----------

async function openTeam() {
  const { root } = openModal(`
    <h2>Team</h2>
    <div class="card stack">
      <h3>Access requests</h3>
      <div id="req-list" class="muted">Loading...</div>
      <label class="check"><input type="checkbox" id="allow-signup"> Let people request access from the sign-in page</label>
    </div>
    <div class="card stack">
      <h3>Invite a developer</h3>
      <p class="hint" style="margin:0">Creates a one-time link valid for 7 days. Send it privately (e.g. in a DM).</p>
      <div class="row">
        <select id="inv-role" style="max-width:200px">${ROLE_OPTIONS('dev')}</select>
        <button class="btn primary" id="inv-create">Create invite link</button>
      </div>
      <div id="inv-link" class="hidden"></div>
      ${
        state.me.publicUrl
          ? ''
          : '<p class="hint small" style="margin:0">⚠ No public address yet. Invite links only work once the tunnel is running (start with Start-Team.bat).</p>'
      }
    </div>
    <div class="card stack" id="notify-card">
      <h3>Discord notifications</h3>
      <div id="notify-body" class="muted">Loading...</div>
    </div>
    <div class="card stack" id="gateway-card">
      <h3>Gateway: one address for every server</h3>
      <div id="gateway-body" class="muted">Loading...</div>
    </div>
    <div class="card stack" id="playit-card">
      <h3>Public game addresses (playit.gg)</h3>
      <div id="playit-body" class="muted">Loading...</div>
    </div>
    <div class="card">
      <h3 style="margin-bottom:4px">Members</h3>
      <p class="hint small" style="margin:0 0 8px">Change a role with its dropdown. <a href="help.html?doc=roles" target="_blank">What can each role do?</a></p>
      <div id="team-list" class="muted">Loading...</div>
    </div>
    <div class="modal-actions"><button class="btn" data-close>Close</button></div>`);

  const load = async () => {
    const all = await api('GET', '/api/team/users');
    const pending = all.filter((u) => u.role === 'pending');
    const users = all.filter((u) => u.role !== 'pending').sort((a, b) => ['admin', 'dev', 'tester'].indexOf(a.role) - ['admin', 'dev', 'tester'].indexOf(b.role));
    state.me.pendingCount = pending.length;
    renderUserBox();
    $('#req-list', root).innerHTML = pending.length
      ? `<table><tbody>${pending
          .map(
            (u) => `<tr><td><b>${esc(u.username)}</b><div class="small muted">Minecraft: ${esc(u.mcName) || 'not set'} · requested ${new Date(u.createdAt).toLocaleString()}</div></td>
              <td class="actions-cell">
                <select data-arole="${esc(u.id)}" style="width:auto">${ROLE_OPTIONS('dev')}</select>
                <button class="btn sm primary" data-approve="${esc(u.id)}">Approve</button>
                <button class="btn sm danger" data-udel="${esc(u.id)}">Reject</button>
              </td></tr>`,
          )
          .join('')}</tbody></table>`
      : 'No pending requests.';
    $$('[data-approve]', root).forEach((b) =>
      b.addEventListener('click', () =>
        attempt(async () => {
          const role = $(`[data-arole="${b.dataset.approve}"]`, root).value;
          await api('POST', `/api/team/users/${b.dataset.approve}/approve`, { role });
          toast('Approved');
          load();
        }),
      ),
    );
    $('#team-list', root).innerHTML = `<table><thead><tr><th>User</th><th>Role</th><th>Minecraft</th><th></th></tr></thead><tbody>${users
      .map(
        (u) => `<tr><td>${esc(u.username)}</td>
          <td>${
            u.id === state.me.user.id
              ? `<span class="badge green">${ROLE_LABEL[u.role]}</span>`
              : `<select data-role="${esc(u.id)}" style="width:auto">${ROLE_OPTIONS(u.role)}</select>`
          }</td>
          <td>${esc(u.mcName) || '<span class="muted">not set</span>'}</td>
          <td class="actions-cell">${u.id === state.me.user.id ? '<span class="muted small">you</span>' : `<button class="btn sm danger" data-udel="${esc(u.id)}">Remove</button>`}</td></tr>`,
      )
      .join('')}</tbody></table>`;
    $$('[data-role]', root).forEach((sel) =>
      sel.addEventListener('change', () =>
        attempt(async () => {
          await api('PUT', `/api/team/users/${sel.dataset.role}/role`, { role: sel.value });
          toast(`Role changed to ${ROLE_LABEL[sel.value]}`);
        }).then(load),
      ),
    );
    $$('[data-udel]', root).forEach((b) =>
      b.addEventListener('click', () => {
        if (!confirm('Remove this person? Their account, logins and API tokens stop working immediately.')) return;
        attempt(async () => {
          await api('DELETE', `/api/team/users/${b.dataset.udel}`);
          load();
        });
      }),
    );
  };
  load().catch((e) => toast(e.message, 'error'));
  renderPlayit(root).catch((e) => toast(e.message, 'error'));
  renderGateway(root);
  renderNotifications(root).catch((e) => toast(e.message, 'error'));
  api('GET', '/api/team/settings')
    .then((st) => {
      const box = $('#allow-signup', root);
      box.checked = !!st.allowSignup;
      box.addEventListener('change', () =>
        attempt(async () => {
          await api('PUT', '/api/team/settings', { allowSignup: box.checked });
          toast(box.checked ? 'People can now request access' : 'Sign-up requests are turned off');
        }),
      );
    })
    .catch(() => {});

  $('#inv-create', root).addEventListener('click', () =>
    attempt(async () => {
      const base = state.me.publicUrl || location.origin;
      const { link } = await api('POST', '/api/team/invites', { role: $('#inv-role', root).value });
      const shareLink = base + link.slice(link.indexOf('/?invite='));
      const box = $('#inv-link', root);
      box.classList.remove('hidden');
      box.innerHTML = `<div class="token-box"><div class="small">Invite link (one use, 7 days):</div>
        <code class="copy" data-copy="${esc(shareLink)}" title="Click to copy">${esc(shareLink)}</code></div>`;
      $('[data-copy]', box).addEventListener('click', (ev) =>
        navigator.clipboard.writeText(ev.target.dataset.copy).then(() => toast('Invite link copied')),
      );
    }),
  );
}

// ---------- deploy from build ----------

function deployCardHtml(s) {
  const base = state.me.publicUrl || location.origin;
  const endpoint = `${base}/api/servers/${s.id}/deploy`;
  const gradle = `// Deploy to the team test server with: ./gradlew deployTest
// Needs the MCPT_TOKEN environment variable (Account → API tokens).
// Optional: MCPT_URL if the team server address changed.
tasks.register("deployTest") {
    dependsOn("build")
    doLast {
        val jar = layout.buildDirectory.dir("libs").get().asFile.listFiles()!!
            .filter { it.name.endsWith(".jar") && !it.name.endsWith("-sources.jar") && !it.name.endsWith("-javadoc.jar") }
            .maxByOrNull { it.lastModified() } ?: throw GradleException("No jar found in build/libs")
        val base = System.getenv("MCPT_URL") ?: "${base}"
        val token = System.getenv("MCPT_TOKEN") ?: throw GradleException("Set the MCPT_TOKEN environment variable")
        val url = "$base/api/servers/${s.id}/deploy?name=" + java.net.URLEncoder.encode(jar.name, "UTF-8")
        val request = java.net.http.HttpRequest.newBuilder(java.net.URI(url))
            .header("Authorization", "Bearer $token")
            .POST(java.net.http.HttpRequest.BodyPublishers.ofFile(jar.toPath()))
            .build()
        val response = java.net.http.HttpClient.newHttpClient().send(request, java.net.http.HttpResponse.BodyHandlers.ofString())
        if (response.statusCode() !in 200..299) throw GradleException("Deploy failed: " + response.body())
        println("Deployed \${jar.name}: " + response.body())
    }
}`;
  const curlSh = `curl -f -X POST -H "Authorization: Bearer $MCPT_TOKEN" \\
  --data-binary @target/MyPlugin-1.0.jar \\
  "${endpoint}?name=MyPlugin-1.0.jar"`;
  const curlPs = `curl.exe -f -X POST -H "Authorization: Bearer $env:MCPT_TOKEN" \`
  --data-binary "@target\\MyPlugin-1.0.jar" \`
  "${endpoint}?name=MyPlugin-1.0.jar"`;
  const block = (code) => `<pre class="code"><button type="button" class="btn sm copy-code">Copy</button>${esc(code)}</pre>`;
  return `
    <div class="card">
      <h3>Deploy from your build</h3>
      <p class="hint">Send your plugin jar straight from your build to this server. Older versions of the same plugin are replaced
      and the server restarts if it's running. First create a token under <a href="#" id="open-account">Account → API tokens</a>
      and set it as the <code>MCPT_TOKEN</code> environment variable.</p>
      <details open><summary>Gradle (build.gradle.kts): <code>./gradlew deployTest</code></summary>${block(gradle)}</details>
      <details><summary>Maven / any build: curl (macOS, Linux, Git Bash)</summary>${block(curlSh)}</details>
      <details><summary>Maven / any build: PowerShell (Windows)</summary>${block(curlPs)}</details>
      ${
        state.me.publicUrl
          ? '<p class="hint small" style="margin:8px 0 0">The team address changes when the team server restarts. If deploys fail with a connection error, set <code>MCPT_URL</code> to the new address.</p>'
          : ''
      }
    </div>`;
}

function bindDeployCard(root) {
  const link = $('#open-account', root);
  if (link) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      openAccount();
    });
  }
  $$('.copy-code', root).forEach((b) =>
    b.addEventListener('click', () => {
      const text = b.parentElement.textContent.replace(/^Copy/, '');
      navigator.clipboard.writeText(text).then(() => toast('Copied'));
    }),
  );
}

function shareResultsHtml(results) {
  if (!results || !results.length) return '<p class="hint" style="margin:0">No servers yet. Create one and it gets an address automatically.</p>';
  return `<table><tbody>${results
    .map(
      (r) => `<tr><td><b>${esc(r.name)}</b>${r.isGateway ? ' <span class="badge green">Gateway</span>' : ''}<div class="small muted">port ${r.port} · ${r.isGateway ? 'the one address for everyone' : r.space === 'solo' ? 'solo' : 'team'}</div></td>
        <td>${
          r.viaGateway
            ? `<span class="muted small">joins through the Gateway: <code>/server ${esc(r.viaGateway)}</code></span>`
            : r.needsTunnel
            ? `<span class="badge yellow">needs a tunnel</span>
               <div class="small" style="margin-top:4px">On <a href="https://playit.gg/account/tunnels" target="_blank" rel="noopener">playit.gg → Tunnels</a> → <b>Add Tunnel</b>:
               type <b>Minecraft Java</b>, Local IP <b>127.0.0.1</b>, Local Port <b>${r.port}</b>, Proxy Protocol <b>none</b>. Then click <b>Check again</b>.</div>`
            : r.error
            ? `<span class="badge red">failed</span> <span class="small">${esc(r.error)}</span>`
            : `<span class="copy" data-copy="${esc(r.address)}" title="Click to copy"><b>${esc(r.address)}</b></span>${r.manual ? ' <span class="muted small">(typed in Settings)</span>' : ''}`
        }</td></tr>`,
    )
    .join('')}</tbody></table>`;
}

function bindCopies(el) {
  $$('[data-copy]', el).forEach((b) =>
    b.addEventListener('click', () => navigator.clipboard.writeText(b.dataset.copy).then(() => toast('Copied'))),
  );
}

async function renderPlayit(root, results) {
  const body = $('#playit-body', root);
  const st = await api('GET', '/api/playit');
  if (st.configured) {
    body.classList.remove('muted');
    body.innerHTML = `
      <p style="margin:0"><span class="badge ${st.error ? 'red' : 'green'}">${st.error ? 'Problem' : 'Connected'}</span>
        ${st.error ? esc(st.error) : "Honey Host finds each server's playit tunnel by its port and shows its address to everyone."}</p>
      ${
        st.otherAgent
          ? `<div class="warn-box">⚠ Honey Host is linked to a <b>different playit agent</b> than the playit app installed on this PC
               (probably the one on your previous PC). Tunnels would be created there, not here.
               <div style="margin-top:6px"><button class="btn sm primary" id="pl-relink">Use this PC's playit</button></div></div>`
          : ''
      }
      ${st.configured && !st.localInstalled ? '<p class="hint" style="margin:0">⚠ The playit app was not found on this PC. It has to run on the PC that hosts the servers.</p>' : ''}
      ${st.accountStatus && st.accountStatus !== 'ready' ? `<p class="hint" style="margin:0">playit.gg account status: <b>${esc(st.accountStatus)}</b>. Log in at playit.gg to fix it (e.g. verify your email).</p>` : ''}
      <p class="hint" style="margin:0">Keep the playit app running on the host PC: it carries the players' traffic. Manage tunnels at
        <a href="https://playit.gg/account/tunnels" target="_blank" rel="noopener">playit.gg</a>.</p>
      <div id="pl-results">${results ? shareResultsHtml(results) : ''}</div>
      <div class="row">
        <button class="btn sm primary" id="pl-share">Check again</button>
        <button class="btn sm danger" id="pl-disconnect">Disconnect</button>
      </div>`;
    bindCopies(body);
    if ($('#pl-relink', root)) {
      $('#pl-relink', root).addEventListener('click', () =>
        attempt(async () => {
          await api('DELETE', '/api/playit');
          const r = await api('POST', '/api/playit/detect');
          toast("Now using this PC's playit");
          renderPlayit(root, r.results);
        }),
      );
    }
    $('#pl-share', root).addEventListener('click', (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Asking playit.gg...';
      api('POST', '/api/playit/share-all')
        .then((r) => renderPlayit(root, r.results))
        .catch((err) => {
          toast(err.message, 'error');
          e.target.disabled = false;
          e.target.textContent = 'Check again';
        });
    });
    $('#pl-disconnect', root).addEventListener('click', () => {
      if (!confirm('Disconnect playit.gg? Existing tunnels keep working, but new servers will not get addresses automatically.')) return;
      attempt(async () => {
        await api('DELETE', '/api/playit');
        renderPlayit(root);
      });
    });
    return;
  }
  body.classList.remove('muted');
  body.innerHTML = `
    <p class="hint" style="margin:0">Give every team server a permanent public address (like <code>something.joinmc.link</code>) automatically.
      Free, no port forwarding, and your home IP stays hidden. One-time setup on the host PC:</p>
    <ol class="steps">
      <li>Download and install the playit app from <a href="https://playit.gg/download" target="_blank" rel="noopener">playit.gg/download</a>.</li>
      <li>Open it and follow its setup link to create your free playit.gg account and link the app.</li>
      <li>Click <b>Connect</b>. Honey Host finds the app's key automatically.</li>
    </ol>
    <div class="row"><button class="btn primary" id="pl-detect">Connect</button></div>
    <details><summary>Connect didn't work? Paste the key instead</summary>
      <p class="hint small">Open <code>C:\\ProgramData\\playit_gg\\playit.toml</code> (as administrator) or run <code>playit secret-path</code>
        to find the file, then paste the <code>secret_key</code> value here.</p>
      <div class="row"><input type="password" id="pl-secret" placeholder="secret_key"><button class="btn" id="pl-save">Save</button></div>
    </details>`;
  $('#pl-detect', root).addEventListener('click', () =>
    attempt(async () => {
      const r = await api('POST', '/api/playit/detect');
      toast('playit.gg connected');
      renderPlayit(root, r.results);
    }),
  );
  $('#pl-save', root).addEventListener('click', () =>
    attempt(async () => {
      const r = await api('POST', '/api/playit/secret', { secret: $('#pl-secret', root).value });
      toast('playit.gg connected');
      renderPlayit(root, r.results);
    }),
  );
}

// ---------- Gateway ----------

function renderGateway(root) {
  const body = $('#gateway-body', root);
  if (!body) return;
  body.classList.remove('muted');
  const servers = [...state.servers.values()];
  const gw = servers.find((s) => s.isGateway);
  if (!gw) {
    body.innerHTML = `
      <p class="hint" style="margin:0">Instead of a separate playit tunnel for every server, run one <b>Gateway</b> (a Velocity proxy) in front of all of them.
        Everyone joins <b>one address</b> and switches with <code>/server &lt;name&gt;</code>. New servers are added to it automatically.</p>
      <ol class="steps">
        <li>Click <b>Set up the Gateway</b>. Honey Host downloads and starts it.</li>
        <li>Create <b>one</b> tunnel on playit.gg for the Gateway's port (shown here once it's set up).</li>
        <li>Restart your running servers once, so they move behind the Gateway.</li>
      </ol>
      <div><button class="btn primary" id="gw-create">Set up the Gateway</button></div>`;
    $('#gw-create', root).addEventListener('click', (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Setting up...';
      api('POST', '/api/gateway')
        .then((g) => {
          state.servers.set(g.id, g);
          toast('Gateway created. It is downloading and starting now.');
          renderGateway(root);
        })
        .catch((err) => {
          toast(err.message, 'error');
          e.target.disabled = false;
          e.target.textContent = 'Set up the Gateway';
        });
    });
    return;
  }
  const backends = servers.filter((s) => s.gateway);
  const standalone = servers.filter((s) => !s.isGateway && s.kind !== 'proxy' && !s.gateway);
  const needRestart = backends.filter((s) => s.pid && s.gateway && !s.gateway.applied);
  body.innerHTML = `
    <p style="margin:0"><span class="badge ${gw.status === 'running' ? 'green' : 'yellow'}">${esc(STATUS_LABEL[gw.status] || gw.status)}</span>
      Gateway on port <b>${gw.port}</b>${gw.publicAddress ? ` · public address <span class="copy" data-copy="${esc(gw.publicAddress)}"><b>${esc(gw.publicAddress)}</b></span>` : ''}</p>
    ${
      gw.publicAddress
        ? ''
        : `<p class="hint" style="margin:0">Create <b>one</b> tunnel on <a href="https://playit.gg/account/tunnels" target="_blank" rel="noopener">playit.gg → Tunnels</a> → <b>Add Tunnel</b>:
             type <b>Minecraft Java</b>, Local IP <b>127.0.0.1</b>, Local Port <b>${gw.port}</b>, Proxy Protocol <b>none</b>. Then click <b>Check again</b> below.</p>`
    }
    ${
      needRestart.length
        ? `<div class="warn-box">Restart these servers once to move them behind the Gateway: <b>${needRestart.map((s) => esc(s.name)).join(', ')}</b></div>`
        : ''
    }
    ${
      standalone.length
        ? `<p class="hint small" style="margin:0">Not behind the Gateway (Vanilla and Fabric can't be): <b>${standalone.map((s) => esc(s.name)).join(', ')}</b>. Players join these directly with their own address.</p>`
        : ''
    }
    <label class="field" style="max-width:420px">Players land on
      <select id="gw-default">
        <option value="">${backends.length ? 'The first team server (automatic)' : 'No servers yet'}</option>
        ${backends.map((s) => `<option value="${esc(s.id)}" ${gw.gatewayDefault === s.id ? 'selected' : ''}>${esc(s.name)} (/server ${esc(s.gateway?.name || '')})</option>`).join('')}
      </select>
    </label>
    <p class="hint small" style="margin:0">Removing the Gateway: delete the "Gateway" server like any other; the servers go back to direct joins after a restart.</p>`;
  bindCopies(body);
  $('#gw-default', root).addEventListener('change', (e) =>
    attempt(async () => {
      await api('PUT', '/api/gateway', { defaultServer: e.target.value });
      toast('Saved. The Gateway was updated.');
    }),
  );
}
