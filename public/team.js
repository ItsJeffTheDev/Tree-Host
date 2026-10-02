'use strict';
// Accounts UI: sign-in screens, account, billing (plans and subscriptions) and the admin panel.
// Loaded before app.js; uses app.js helpers ($, esc, api, toast, attempt, state) at call time.

function isTeam() {
  return !!(state.me && state.me.teamMode);
}

function isAdmin() {
  return !isTeam() || state.me.user?.role === 'admin';
}

function isStaffUser() {
  return !isTeam() || ['admin', 'staff'].includes(state.me.user?.role);
}

function isCustomer() {
  return isTeam() && state.me.user?.role === 'customer';
}

const ROLE_LABEL = { admin: 'Admin', staff: 'Support', customer: 'Customer' };
const ROLE_OPTIONS = (selected, roles = ['customer', 'staff', 'admin']) =>
  roles.map((r) => `<option value="${r}" ${r === selected ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('');

/**
 * Mirrors the server's permission rules so the dashboard only shows what you can use.
 * Actions: view, control, command, plugins, files, settings, deploy, manage (delete / reset world / change version).
 */
function can(action, s) {
  if (!isTeam()) return true;
  const u = state.me.user;
  if (u.role === 'admin') return true;
  if (u.role === 'customer') return !s || s.owner === u.id;
  // Support staff can help with anyone's server, but not delete it, reset its world or change its version.
  return !s || s.owner === u.id || action !== 'manage';
}

/** Features that act on the host machine itself (Play, open folder, watching build folders, custom paths). */
function hostFeatures() {
  return isAdmin() && !state.me?.hosted;
}

function money(cents, currency = 'usd') {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

// ---------- Firebase sign-in ----------

const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
let fbPromise = null;

/** Loads Firebase Auth from Google's CDN (only on pages that need it). */
function firebaseAuth() {
  if (!state.me?.firebase) return Promise.resolve(null);
  if (!fbPromise) {
    fbPromise = (async () => {
      const app = await import(`${FIREBASE_SDK}/firebase-app.js`);
      const auth = await import(`${FIREBASE_SDK}/firebase-auth.js`);
      const instance = auth.getAuth(app.initializeApp(state.me.firebase));
      return { ...auth, auth: instance };
    })();
  }
  return fbPromise;
}

const FIREBASE_ERRORS = {
  'auth/invalid-credential': 'Wrong email or password.',
  'auth/wrong-password': 'Wrong email or password.',
  'auth/user-not-found': 'Wrong email or password.',
  'auth/invalid-email': 'That email address does not look right.',
  'auth/email-already-in-use': 'There is already an account with that email. Sign in instead.',
  'auth/weak-password': 'Please use a stronger password (at least 8 characters).',
  'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
  'auth/popup-closed-by-user': 'The Google window was closed before signing in.',
  'auth/popup-blocked': 'Your browser blocked the Google window. Allow pop-ups for this site and try again.',
  'auth/network-request-failed': 'Could not reach the sign-in service. Check your internet connection.',
  'auth/unauthorized-domain': 'This website address is not allowed in Firebase yet (Authentication → Settings → Authorized domains).',
  'auth/operation-not-allowed': 'This sign-in method is not turned on in Firebase yet.',
};
const fbMessage = (e) => FIREBASE_ERRORS[e && e.code] || (e && e.message) || String(e);

/** Firebase sign-in screens: sign in, sign up, Google, forgot password and support-staff invites. */
function showFirebaseAuth(forceMode) {
  const params = new URLSearchParams(location.search);
  const invite = params.get('invite');
  const mode = forceMode || (invite ? 'invite' : params.has('signup') && state.me?.allowSignup ? 'signup' : 'login');
  const titles = {
    login: ['Sign in', 'Welcome back! Sign in to manage your servers.'],
    signup: ['Create your account', 'Sign up, pick a plan and your Minecraft server is ready in about a minute.'],
    invite: ['Join Tree Host support', 'You were invited to help run Tree Host. Create your account or sign in.'],
    forgot: ['Forgot your password?', "Enter your account's email and we'll send you a link to choose a new password."],
    profile: ['Almost done', 'Pick a username for your Tree Host account.'],
  };
  const [title, sub] = titles[mode];
  const newAccount = ['signup', 'invite', 'profile'].includes(mode);
  document.body.innerHTML = `
    <div class="auth-screen">
      <form class="auth-card stack" id="auth-form" autocomplete="on">
        <a href="/" class="brand" style="text-decoration:none;color:inherit"><div class="logo"></div><div><div class="brand-name">Tree Host</div><div class="brand-sub">Minecraft server hosting</div></div></a>
        <h2>${esc(title)}</h2>
        <p class="muted" style="margin:0">${esc(sub)}</p>
        ${newAccount ? `<label class="field">Username <input type="text" name="username" required minlength="3" maxlength="32" autocomplete="username" value="${esc(state.pendingProfile?.suggested || '')}"></label>` : ''}
        ${mode !== 'profile' ? '<label class="field">Email <input type="email" name="email" required autocomplete="email"></label>' : ''}
        ${!['forgot', 'profile'].includes(mode) ? `<label class="field">Password <input type="password" name="password" required minlength="${mode === 'login' ? 1 : 8}" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}"></label>` : ''}
        ${
          ['signup', 'profile'].includes(mode) && !invite
            ? `<label class="check"><input type="checkbox" name="acceptTerms" required>
                 <span>I agree to the <a href="/terms" target="_blank">Terms of Service</a> and <a href="/privacy" target="_blank">Privacy Policy</a></span></label>`
            : ''
        }
        <div id="auth-error" class="auth-error hidden"></div>
        <div id="auth-ok" class="auth-ok hidden"></div>
        <button class="btn primary block" id="auth-submit">${
          { login: 'Sign in', signup: 'Create account', invite: 'Create account', forgot: 'Send reset link', profile: 'Continue' }[mode]
        }</button>
        ${
          ['login', 'signup', 'invite'].includes(mode)
            ? `<div class="auth-or"><span>or</span></div>
               <button type="button" class="btn block google-btn" id="auth-google">
                 <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
                 Continue with Google</button>`
            : ''
        }
        ${mode === 'login' ? '<p class="small muted" style="margin:0;text-align:center"><a href="#" data-mode="forgot">Forgot your password?</a></p>' : ''}
        ${
          mode === 'login' && state.me?.allowSignup
            ? '<p class="small muted" style="margin:0;text-align:center">No account yet? <a href="#" data-mode="signup">Sign up</a></p>'
            : ['signup', 'forgot'].includes(mode)
              ? '<p class="small muted" style="margin:0;text-align:center">Already have an account? <a href="#" data-mode="login">Sign in</a></p>'
              : mode === 'profile'
                ? '<p class="small muted" style="margin:0;text-align:center"><a href="#" id="auth-cancel">Use a different account</a></p>'
                : ''
        }
      </form>
    </div>
    <div id="toasts" class="toasts"></div>`;

  const errBox = $('#auth-error');
  const showError = (msg) => {
    errBox.textContent = msg;
    errBox.classList.remove('hidden');
  };
  const busy = (on) => {
    $('#auth-submit').disabled = on;
    if ($('#auth-google')) $('#auth-google').disabled = on;
  };
  const extra = () => {
    const f = $('#auth-form').elements;
    return {
      username: f.username ? f.username.value.trim() : undefined,
      acceptTerms: f.acceptTerms ? f.acceptTerms.checked : undefined,
      invite: invite || undefined,
    };
  };
  /** Hands the Firebase sign-in to Tree Host, which answers with a session (or asks for a username). */
  const finish = async (user, more = {}) => {
    const idToken = await user.getIdToken();
    const r = await api('POST', '/api/auth/firebase', { idToken, ...more });
    if (r.needsProfile) {
      state.pendingProfile = { suggested: r.suggested || '' };
      return showFirebaseAuth('profile');
    }
    location.href = r.created ? '/dashboard?welcome' : '/dashboard';
  };

  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.classList.add('hidden');
    busy(true);
    const f = e.target.elements;
    try {
      const fb = await firebaseAuth();
      if (mode === 'forgot') {
        await fb.sendPasswordResetEmail(fb.auth, f.email.value.trim());
        const ok = $('#auth-ok');
        ok.textContent = 'If an account uses that email, a reset link is on its way. Check your inbox (and spam).';
        ok.classList.remove('hidden');
        return;
      }
      if (mode === 'profile') return await finish(fb.auth.currentUser, extra());
      if (mode === 'login') {
        const cred = await fb.signInWithEmailAndPassword(fb.auth, f.email.value.trim(), f.password.value);
        return await finish(cred.user);
      }
      // New account (sign up, invite): create it in Firebase, or sign in if it already exists there.
      if (f.acceptTerms && !f.acceptTerms.checked) return showError('Please accept the Terms of Service and Privacy Policy.');
      let cred;
      try {
        cred = await fb.createUserWithEmailAndPassword(fb.auth, f.email.value.trim(), f.password.value);
        fb.sendEmailVerification(cred.user).catch(() => {});
      } catch (err) {
        if (err.code !== 'auth/email-already-in-use') throw err;
        cred = await fb.signInWithEmailAndPassword(fb.auth, f.email.value.trim(), f.password.value);
      }
      await finish(cred.user, extra());
    } catch (err) {
      showError(fbMessage(err));
    } finally {
      busy(false);
    }
  });
  if ($('#auth-google')) {
    $('#auth-google').addEventListener('click', async () => {
      errBox.classList.add('hidden');
      busy(true);
      try {
        const fb = await firebaseAuth();
        const cred = await fb.signInWithPopup(fb.auth, new fb.GoogleAuthProvider());
        await finish(cred.user, { invite: invite || undefined });
      } catch (err) {
        showError(fbMessage(err));
      } finally {
        busy(false);
      }
    });
  }
  if ($('#auth-cancel'))
    $('#auth-cancel').addEventListener('click', async (e) => {
      e.preventDefault();
      const fb = await firebaseAuth();
      await fb.signOut(fb.auth).catch(() => {});
      showFirebaseAuth('login');
    });
  const first = $('#auth-form input');
  if (first) first.focus();
  $$('[data-mode]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      history.replaceState(null, '', '/dashboard');
      showFirebaseAuth(a.dataset.mode);
    }),
  );
}

/** Firebase password reset email for an address (used by Account and by admins). */
async function sendResetEmail(email) {
  const fb = await firebaseAuth();
  await fb.sendPasswordResetEmail(fb.auth, email);
}

// ---------- sign in / sign up / setup / invite / password reset (without Firebase) ----------

function showAuth(forceMode) {
  if (state.me?.firebase) return showFirebaseAuth(forceMode === 'reset' ? 'login' : forceMode);
  const params = new URLSearchParams(location.search);
  const invite = params.get('invite');
  const reset = params.get('reset');
  const mode =
    forceMode ||
    (reset ? 'reset' : invite ? 'invite' : params.has('signup') && state.me?.allowSignup ? 'signup' : 'login');
  const titles = {
    login: ['Sign in', 'Welcome back! Sign in to manage your servers.'],
    invite: ['Join Tree Host support', 'You were invited to help run Tree Host. Create your account.'],
    signup: ['Create your account', 'Sign up, pick a plan and your Minecraft server is ready in about a minute.'],
    forgot: ['Forgot your password?', "Enter your account's email and we'll send you a link to choose a new password."],
    reset: ['Choose a new password', 'Enter a new password for your account.'],
  };
  const [title, sub] = titles[mode];
  const field = (html) => html;
  document.body.innerHTML = `
    <div class="auth-screen">
      <form class="auth-card stack" id="auth-form" autocomplete="on">
        <a href="/" class="brand" style="text-decoration:none;color:inherit"><div class="logo"></div><div><div class="brand-name">Tree Host</div><div class="brand-sub">Minecraft server hosting</div></div></a>
        <h2>${esc(title)}</h2>
        <p class="muted" style="margin:0">${esc(sub)}</p>
        ${
          mode === 'login'
            ? '<label class="field">Username or email <input type="text" name="username" required autocomplete="username"></label>'
            : ['invite', 'signup'].includes(mode)
              ? '<label class="field">Username <input type="text" name="username" required autocomplete="username" minlength="3" maxlength="32"></label>'
              : ''
        }
        ${
          ['invite', 'signup', 'forgot'].includes(mode)
            ? `<label class="field">Email <input type="email" name="email" ${mode === 'invite' ? '' : 'required'} autocomplete="email"></label>`
            : ''
        }
        ${
          mode !== 'forgot'
            ? `<label class="field">${mode === 'reset' ? 'New password' : 'Password'} <input type="password" name="password" required minlength="${mode === 'login' ? 1 : 8}" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}"></label>`
            : ''
        }
        ${
          mode === 'signup'
            ? `<label class="check"><input type="checkbox" name="acceptTerms" required>
                 <span>I agree to the <a href="/terms" target="_blank">Terms of Service</a> and <a href="/privacy" target="_blank">Privacy Policy</a></span></label>`
            : ''
        }
        <div id="auth-error" class="auth-error hidden"></div>
        <div id="auth-ok" class="auth-ok hidden"></div>
        <button class="btn primary block">${
          { login: 'Sign in', signup: 'Create account', forgot: 'Send reset link', reset: 'Save new password', invite: 'Create account' }[mode]
        }</button>
        ${mode === 'login' ? '<p class="small muted" style="margin:0;text-align:center"><a href="#" data-mode="forgot">Forgot your password?</a></p>' : ''}
        ${
          mode === 'login' && state.me?.allowSignup
            ? '<p class="small muted" style="margin:0;text-align:center">No account yet? <a href="#" data-mode="signup">Sign up</a></p>'
            : ['signup', 'forgot', 'reset'].includes(mode)
              ? '<p class="small muted" style="margin:0;text-align:center">Already have an account? <a href="#" data-mode="login">Sign in</a></p>'
              : ''
        }
      </form>
    </div>
    <div id="toasts" class="toasts"></div>`;
  const showError = (msg) => {
    const box = $('#auth-error');
    box.textContent = msg;
    box.classList.remove('hidden');
  };
  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    $('#auth-error').classList.add('hidden');
    const body = {};
    for (const k of ['username', 'email', 'password', 'mcName']) if (f[k]) body[k] = f[k].value.trim();
    if (f.password) body.password = f.password.value;
    if (f.acceptTerms) body.acceptTerms = f.acceptTerms.checked;
    if (invite) body.invite = invite;
    if (reset) body.token = reset;
    const url = {
      login: '/api/auth/login',
      invite: '/api/auth/accept-invite',
      signup: '/api/auth/signup',
      forgot: '/api/auth/forgot',
      reset: '/api/auth/reset',
    }[mode];
    try {
      await api('POST', url, body);
      if (mode === 'forgot') {
        const ok = $('#auth-ok');
        ok.textContent = 'If an account uses that email, a reset link is on its way. Check your inbox (and spam).';
        ok.classList.remove('hidden');
        return;
      }
      location.href = mode === 'signup' ? '/dashboard?welcome' : '/dashboard';
    } catch (err) {
      showError(err.message);
    }
  });
  const first = $('#auth-form input');
  if (first) first.focus();
  $$('[data-mode]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      history.replaceState(null, '', '/dashboard');
      showAuth(a.dataset.mode);
    }),
  );
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
    <div class="ub-name">${esc(u.username)} <span class="badge ${u.role === 'admin' ? 'green' : u.role === 'staff' ? 'blue' : ''}">${ROLE_LABEL[u.role] || u.role}</span></div>
    ${
      state.me.lanUrls?.length
        ? `<div class="ub-link small">Home network: <span class="copy" data-copy="${esc(state.me.lanUrls[1] || state.me.lanUrls[0])}" title="Click to copy">${esc((state.me.lanUrls[1] || state.me.lanUrls[0]).replace('http://', ''))}</span></div>`
        : ''
    }
    <div class="row" style="flex-wrap:wrap;margin-top:6px">
      <button class="btn sm" id="ub-account">Account</button>
      ${state.me.hosted ? '<button class="btn sm" id="ub-billing">💳 Billing</button>' : ''}
      ${isAdmin() ? '<button class="btn sm" id="ub-team">Admin</button>' : ''}
      <button class="btn sm" id="ub-logout">Sign out</button>
    </div>`;
  $('#ub-account').addEventListener('click', openAccount);
  if ($('#ub-billing')) $('#ub-billing').addEventListener('click', openBilling);
  if ($('#ub-team')) $('#ub-team').addEventListener('click', openTeam);
  $('#ub-logout').addEventListener('click', async () => {
    await api('POST', '/api/auth/logout').catch(() => {});
    const fb = await firebaseAuth().catch(() => null);
    if (fb) await fb.signOut(fb.auth).catch(() => {});
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
    <form id="acc-profile" class="card stack">
      <h3>Profile</h3>
      <div class="grid2">
        <label class="field">Email <input type="email" name="email" value="${esc(u.email || '')}" autocomplete="email" ${u.firebase ? 'disabled title="Your sign-in email"' : ''}></label>
        <label class="field">Minecraft name <input type="text" name="mcName" maxlength="16" value="${esc(u.mcName)}" placeholder="YourMinecraftName"></label>
      </div>
      <p class="hint" style="margin:0">Your email is used for receipts and password resets. Your Minecraft name is used by the
        <b>Whitelist me</b> and <b>OP me</b> buttons on your servers.</p>
      <div><button class="btn primary">Save</button></div>
    </form>
    <div class="card stack">
      <h3>API tokens</h3>
      <p class="hint" style="margin:0">Let your build (Gradle, Maven or curl) upload plugins to your servers. Treat them like passwords.</p>
      <div id="tok-list" class="muted">Loading...</div>
      <form id="tok-form" class="row"><input type="text" name="name" placeholder="Token name, e.g. Laptop" maxlength="60"><button class="btn primary">Create token</button></form>
      <div id="tok-new" class="hidden"></div>
    </div>
    ${
      u.firebase
        ? `<div class="card stack"><h3>Password</h3>
             <p class="hint" style="margin:0">We'll email <b>${esc(u.email)}</b> a link to choose a new password. (Signed in with Google? Manage your password at Google.)</p>
             <div><button class="btn" id="acc-reset">Send password reset email</button></div></div>`
        : ''
    }
    <form id="acc-pw" class="card stack ${u.firebase ? 'hidden' : ''}">
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

  $('#acc-profile', root).addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target.elements;
    attempt(async () => {
      state.me.user = await api('PATCH', '/api/auth/me', { mcName: f.mcName.value.trim(), ...(u.firebase ? {} : { email: f.email.value.trim() }) });
      renderUserBox();
      toast('Saved');
    });
  });
  if ($('#acc-reset', root))
    $('#acc-reset', root).addEventListener('click', () =>
      attempt(async () => {
        await sendResetEmail(u.email);
        toast('Reset email sent. Check your inbox.');
      }),
    );
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

// ---------- plans & billing ----------

function planCardHtml(p, currency) {
  return `<div class="plan-card ${p.soldOut ? 'sold-out' : ''}">
    <div class="plan-name">${esc(p.name)}</div>
    <div class="plan-price">${money(p.priceCents, currency)}<span>/month</span></div>
    <ul class="plan-specs">
      <li><b>${+(p.ramMb / 1024).toFixed(1)} GB</b> memory</li>
      <li><b>${p.cpus}</b> CPU core${p.cpus === 1 ? '' : 's'}</li>
      <li><b>${p.diskGb} GB</b> disk</li>
    </ul>
    <p class="small muted">${esc(p.description)}</p>
    <button class="btn ${p.soldOut ? '' : 'primary'} block" data-buy="${esc(p.id)}" ${p.soldOut ? 'disabled' : ''}>${p.soldOut ? 'Sold out' : 'Choose'}</button>
  </div>`;
}

/** Shows the plans; choosing one goes to Stripe Checkout (or activates instantly in demo mode). */
async function openPlans() {
  const data = await api('GET', '/api/plans');
  const { root } = openModal(`
    <h2>Choose a plan</h2>
    <p class="hint" style="margin-top:-6px">Each plan is one Minecraft server, billed monthly. Every server type and version, cancel any time.</p>
    ${data.mode === 'demo' ? '<div class="warn-box">Demo mode: no real payment is taken. Plans activate instantly.</div>' : ''}
    ${data.mode === 'off' ? '<div class="warn-box">Payments are not set up yet, so plans can\'t be bought right now.</div>' : ''}
    <div class="plan-grid">${data.plans.map((p) => planCardHtml(p, data.currency)).join('')}</div>
    <div class="modal-actions"><button class="btn" data-close>Close</button></div>`);
  root.querySelector('.modal').classList.add('wide');
  $$('[data-buy]', root).forEach((b) =>
    b.addEventListener('click', () => {
      b.disabled = true;
      b.textContent = 'Opening checkout...';
      api('POST', '/api/billing/checkout', { planId: b.dataset.buy })
        .then((r) => {
          if (r.demo) {
            toast('Plan activated (demo). Now create your server!');
            root.innerHTML = '';
            openNewServer();
          } else location.href = r.url;
        })
        .catch((err) => {
          toast(err.message, 'error');
          b.disabled = false;
          b.textContent = 'Choose';
        });
    }),
  );
}

const SUB_STATUS = {
  active: ['green', 'Active'],
  past_due: ['yellow', 'Payment failed'],
  canceled: ['red', 'Ended'],
  pending: ['', 'Waiting for payment'],
};

async function openBilling() {
  const { root, close } = openModal(`
    <h2>Billing</h2>
    <div id="bill-body" class="muted">Loading...</div>
    <div class="modal-actions"><button class="btn" data-close>Close</button></div>`);
  const b = await api('GET', '/api/billing').catch((e) => (toast(e.message, 'error'), null));
  if (!b) return;
  const el = $('#bill-body', root);
  el.classList.remove('muted');
  el.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between;margin-bottom:8px">
        <h3>Your plans</h3>
        <div class="row">
          ${b.hasPortal ? '<button class="btn sm" id="bill-portal">Payment method & invoices</button>' : ''}
          <button class="btn sm primary" id="bill-buy">+ Buy a plan</button>
        </div>
      </div>
      ${
        b.subscriptions.length
          ? `<table><thead><tr><th>Plan</th><th>Status</th><th>Server</th><th>Renews</th></tr></thead><tbody>${b.subscriptions
              .map((x) => {
                const [cls, label] = SUB_STATUS[x.status] || ['', x.status];
                return `<tr>
                  <td><b>${esc(x.planName)}</b> <span class="muted small">${+(x.ramMb / 1024).toFixed(1)} GB · ${x.free ? 'free' : `${money(x.priceCents, x.currency)}/mo`}</span></td>
                  <td><span class="badge ${cls}">${label}</span>${
                    x.status === 'past_due' ? '<div class="small muted">Update your card to keep the server running.</div>' : ''
                  }${x.deleteAt ? `<div class="small muted">Server deleted on ${new Date(x.deleteAt).toLocaleDateString()}</div>` : ''}${
                    x.cancelAtPeriodEnd ? '<div class="small muted">Ends at the end of this period</div>' : ''
                  }</td>
                  <td>${x.serverName ? esc(x.serverName) : x.usable ? '<button class="btn sm primary" data-create>Create server</button>' : '<span class="muted">-</span>'}</td>
                  <td class="small">${
                    x.status === 'canceled'
                      ? '<span class="muted">-</span>'
                      : x.free
                        ? x.freeUntil ? `Free until ${new Date(x.freeUntil).toLocaleDateString()}` : 'Free'
                        : x.renewsAt ? new Date(x.renewsAt).toLocaleDateString() : '<span class="muted">-</span>'
                  }</td>
                </tr>`;
              })
              .join('')}</tbody></table>`
          : '<p class="muted" style="margin:0">No plans yet. Buy one to create your first server.</p>'
      }
      ${b.hasPortal ? '<p class="hint small" style="margin:8px 0 0">To cancel a plan or change your card, use <b>Payment method & invoices</b>.</p>' : ''}
    </div>
    <form class="card row" id="bill-code" style="margin-top:12px;align-items:center">
      <span><b>Have a code?</b></span>
      <input type="text" id="bill-code-in" placeholder="e.g. TREE-7K2P-QX9M" autocomplete="off" style="max-width:240px;text-transform:uppercase">
      <button class="btn sm primary">Redeem</button>
    </form>`;
  $('#bill-code', root).addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('#bill-code-in', root).value.trim();
    if (!code) return;
    attempt(async () => {
      const s = await api('POST', '/api/billing/redeem', { code });
      toast(`Code redeemed: free ${s.planName}${s.freeUntil ? ` until ${new Date(s.freeUntil).toLocaleDateString()}` : ''}`);
      close();
      openBilling();
    });
  });
  $('#bill-buy', root).addEventListener('click', () => {
    close();
    openPlans();
  });
  $$('[data-create]', root).forEach((btn) =>
    btn.addEventListener('click', () => {
      close();
      openNewServer();
    }),
  );
  if ($('#bill-portal', root))
    $('#bill-portal', root).addEventListener('click', () =>
      attempt(async () => {
        location.href = (await api('POST', '/api/billing/portal')).url;
      }),
    );
}

// ---------- admin panel ----------

async function openTeam() {
  const { root } = openModal(`
    <h2>Admin</h2>
    <div class="tabs admin-tabs">
      <button class="tab active" data-atab="people">People</button>
      <button class="tab" data-atab="billing">Billing</button>
      <button class="tab" data-atab="plans">Plans</button>
      <button class="tab" data-atab="promos">Promo codes</button>
      <button class="tab" data-atab="settings">Settings</button>
    </div>
    <div id="admin-body" style="margin-top:14px"></div>
    <div class="modal-actions"><button class="btn" data-close>Close</button></div>`);
  root.querySelector('.modal').classList.add('wide');
  const show = (tab) => {
    $$('[data-atab]', root).forEach((t) => t.classList.toggle('active', t.dataset.atab === tab));
    const body = $('#admin-body', root);
    body.innerHTML = '<div class="muted">Loading...</div>';
    ({ people: adminPeople, billing: adminBilling, plans: adminPlans, promos: adminPromos, settings: adminSettings })[tab](body).catch((e) => (body.textContent = e.message));
  };
  $$('[data-atab]', root).forEach((t) => t.addEventListener('click', () => show(t.dataset.atab)));
  show('people');
}

async function adminPeople(body) {
  const [all, plans] = await Promise.all([api('GET', '/api/team/users'), api('GET', '/api/plans')]);
  let filter = 'all';
  let q = '';
  const draw = () => {
    const list = all
      .filter((u) => (filter === 'all' ? true : filter === 'staff' ? u.role !== 'customer' : u.role === 'customer'))
      .filter((u) => !q || u.username.toLowerCase().includes(q) || (u.email || '').includes(q));
    $('#ppl-list', body).innerHTML = `<table><thead><tr><th>User</th><th>Role</th><th>Plans</th><th></th></tr></thead><tbody>${list
      .map(
        (u) => `<tr>
          <td><b>${esc(u.username)}</b>${u.disabled ? ' <span class="badge red">suspended</span>' : ''}
            <div class="small muted">${esc(u.email) || 'no email'} · joined ${new Date(u.createdAt).toLocaleDateString()}${u.lastLogin ? ` · last seen ${new Date(u.lastLogin).toLocaleDateString()}` : ''}</div></td>
          <td>${
            u.id === state.me.user.id
              ? `<span class="badge green">${ROLE_LABEL[u.role]}</span>`
              : `<select data-role="${esc(u.id)}" style="width:auto">${ROLE_OPTIONS(u.role)}</select>`
          }</td>
          <td class="small">${u.activePlans.length ? esc(u.activePlans.join(', ')) : '<span class="muted">none</span>'}${u.servers ? ` · ${u.servers} server${u.servers > 1 ? 's' : ''}` : ''}</td>
          <td class="actions-cell">${
            u.id === state.me.user.id
              ? '<span class="muted small">you</span>'
              : `<details class="menu"><summary class="btn sm">More</summary><div class="menu-body">
                  <button class="btn sm" data-grant="${esc(u.id)}">Give a free plan</button>
                  ${
                    u.firebase
                      ? `<button class="btn sm" data-reset="${esc(u.email)}">Send password reset email</button>`
                      : `<button class="btn sm" data-temp="${esc(u.id)}">Temporary password</button>`
                  }
                  <button class="btn sm" data-dis="${esc(u.id)}" data-val="${u.disabled ? '0' : '1'}">${u.disabled ? 'Unsuspend' : 'Suspend'}</button>
                  <button class="btn sm danger" data-udel="${esc(u.id)}">Delete account</button>
                </div></details>`
          }</td></tr>`,
      )
      .join('')}</tbody></table>`;
    bindRows();
  };
  const reload = async () => {
    all.splice(0, all.length, ...(await api('GET', '/api/team/users')));
    draw();
  };
  const bindRows = () => {
    $$('[data-role]', body).forEach((sel) =>
      sel.addEventListener('change', () => {
        if (sel.value !== 'customer' && !confirm(`Make this person ${ROLE_LABEL[sel.value]}? They can see and manage every customer's server.`)) return reload();
        attempt(async () => {
          await api('PUT', `/api/team/users/${sel.dataset.role}/role`, { role: sel.value });
          toast(`Role changed to ${ROLE_LABEL[sel.value]}`);
        }).then(reload);
      }),
    );
    $$('[data-grant]', body).forEach((b) =>
      b.addEventListener('click', () => {
        const names = plans.plans.map((p) => p.id).join(', ');
        const id = prompt(`Which plan? (${names})`, plans.plans[0]?.id || '');
        if (!id) return;
        const months = prompt('For how many months? (0 = no end date)', '0');
        if (months === null) return;
        attempt(async () => {
          await api('POST', '/api/admin/subscriptions', { userId: b.dataset.grant, planId: id.trim(), months: Number(months) || 0 });
          toast(Number(months) > 0 ? `Free plan given for ${Number(months)} month(s)` : 'Free plan given');
          reload();
        });
      }),
    );
    $$('[data-reset]', body).forEach((b) =>
      b.addEventListener('click', () =>
        attempt(async () => {
          await sendResetEmail(b.dataset.reset);
          toast(`Reset email sent to ${b.dataset.reset}`);
        }),
      ),
    );
    $$('[data-temp]', body).forEach((b) =>
      b.addEventListener('click', () => {
        if (!confirm('Set a temporary password? They are signed out everywhere and must use it to sign in.')) return;
        attempt(async () => {
          const { password } = await api('POST', `/api/team/users/${b.dataset.temp}/temp-password`);
          prompt('Temporary password (send it privately, they should change it after signing in):', password);
        });
      }),
    );
    $$('[data-dis]', body).forEach((b) =>
      b.addEventListener('click', () => {
        const on = b.dataset.val === '1';
        if (on && !confirm('Suspend this account? They are signed out and their servers are stopped.')) return;
        attempt(async () => {
          await api('PUT', `/api/team/users/${b.dataset.dis}/disabled`, { disabled: on });
          reload();
        });
      }),
    );
    $$('[data-udel]', body).forEach((b) =>
      b.addEventListener('click', () => {
        if (!confirm('Delete this account and all of its servers? This cannot be undone.')) return;
        attempt(async () => {
          await api('DELETE', `/api/team/users/${b.dataset.udel}`);
          reload();
        });
      }),
    );
  };
  body.innerHTML = `
    <div class="row" style="margin-bottom:10px">
      <input type="search" id="ppl-q" placeholder="Search name or email" style="max-width:260px">
      <select id="ppl-filter" style="max-width:180px"><option value="all">Everyone</option><option value="customers">Customers</option><option value="staff">Support & admins</option></select>
      <span class="muted small">${all.length} account${all.length === 1 ? '' : 's'}</span>
    </div>
    <div id="ppl-list"></div>
    <div class="card stack" style="margin-top:14px">
      <h3>Invite support staff</h3>
      <p class="hint" style="margin:0">Support staff can see and help with every customer's server (but not delete them). Creates a one-time link valid for 7 days.</p>
      <div class="row">
        <select id="inv-role" style="max-width:200px">${ROLE_OPTIONS('staff', ['staff', 'admin'])}</select>
        <button class="btn primary" id="inv-create">Create invite link</button>
      </div>
      <div id="inv-link" class="hidden"></div>
    </div>`;
  $('#ppl-q', body).addEventListener('input', (e) => ((q = e.target.value.trim().toLowerCase()), draw()));
  $('#ppl-filter', body).addEventListener('change', (e) => ((filter = e.target.value), draw()));
  $('#inv-create', body).addEventListener('click', () =>
    attempt(async () => {
      const { link } = await api('POST', '/api/team/invites', { role: $('#inv-role', body).value });
      const shareLink = (state.me.publicUrl || location.origin) + link.slice(link.indexOf('/?invite=')).replace('/?', '/dashboard?');
      const box = $('#inv-link', body);
      box.classList.remove('hidden');
      box.innerHTML = `<div class="token-box"><div class="small">Invite link (one use, 7 days):</div>
        <code class="copy" data-copy="${esc(shareLink)}" title="Click to copy">${esc(shareLink)}</code></div>`;
      $('[data-copy]', box).addEventListener('click', (ev) => navigator.clipboard.writeText(ev.target.dataset.copy).then(() => toast('Invite link copied')));
    }),
  );
  draw();
}

async function adminBilling(body) {
  const d = await api('GET', '/api/admin/billing');
  const mrr = Object.entries(d.mrr).map(([c, v]) => money(v, c)).join(' + ') || money(0, d.currency);
  const pct = Math.min(100, Math.round((d.soldMb / Math.max(1, d.capacityMb)) * 100));
  body.innerHTML = `
    ${
      d.mode === 'off'
        ? '<div class="warn-box">Payments are off. Set <code>STRIPE_SECRET_KEY</code> and <code>STRIPE_WEBHOOK_SECRET</code> (see the hosting guide), or <code>BILLING_DEMO=1</code> to test.</div>'
        : d.mode === 'demo'
          ? '<div class="warn-box">Demo mode: plans activate without payment. Turn it off before going live.</div>'
          : !d.webhookReady
            ? '<div class="warn-box">STRIPE_WEBHOOK_SECRET is missing: payments go through but Tree Host never hears about them.</div>'
            : ''
    }
    <div class="stat-row">
      <div class="stat"><div class="stat-num">${mrr}</div><div class="stat-label">per month (MRR)</div></div>
      <div class="stat"><div class="stat-num">${d.activeCount}</div><div class="stat-label">active plans${d.pastDueCount ? ` · ${d.pastDueCount} unpaid` : ''}</div></div>
      <div class="stat"><div class="stat-num">${+(d.soldMb / 1024).toFixed(1)} / ${+(d.capacityMb / 1024).toFixed(1)} GB</div><div class="stat-label">memory sold</div>
        <div class="mem-bar ${pct > 90 ? 'high' : pct > 75 ? 'mid' : ''}"><div style="width:${pct}%"></div></div></div>
      <div class="stat"><div class="stat-num">${d.mode}</div><div class="stat-label">payment mode</div></div>
    </div>
    <div class="card">
      <h3 style="margin-bottom:8px">Subscriptions</h3>
      ${
        d.subscriptions.length
          ? `<table><thead><tr><th>Customer</th><th>Plan</th><th>Status</th><th>Server</th><th></th></tr></thead><tbody>${d.subscriptions
              .map((x) => {
                const [cls, label] = SUB_STATUS[x.status] || ['', x.status];
                return `<tr><td>${esc(x.username)}</td>
                  <td>${esc(x.planName)} <span class="muted small">${x.free ? 'free' : `${money(x.priceCents, x.currency)}/mo`}</span></td>
                  <td><span class="badge ${cls}">${label}</span></td>
                  <td class="small">${x.serverName ? esc(x.serverName) : '<span class="muted">none</span>'}</td>
                  <td class="actions-cell">${x.status !== 'canceled' ? `<button class="btn sm danger" data-cancel="${esc(x.id)}">Cancel</button>` : ''}</td></tr>`;
              })
              .join('')}</tbody></table>`
          : '<p class="muted" style="margin:0">No subscriptions yet.</p>'
      }
    </div>
    <p class="hint small">Unpaid plans keep running for ${d.graceDays} days, then the server is stopped. Servers of ended plans are deleted after ${d.deleteAfterDays} days.</p>`;
  $$('[data-cancel]', body).forEach((b) =>
    b.addEventListener('click', () => {
      if (!confirm('Cancel this subscription now? Stripe stops charging, the server is stopped, and it is deleted later. No automatic refund is made.')) return;
      attempt(async () => {
        await api('DELETE', `/api/admin/subscriptions/${b.dataset.cancel}`);
        toast('Canceled');
        adminBilling(body);
      });
    }),
  );
}

// Promo codes: free plans for creators, partners and giveaways. Customers redeem them in Billing.
async function adminPromos(body) {
  const [codes, plans] = await Promise.all([api('GET', '/api/admin/promos'), api('GET', '/api/admin/billing')]);
  const length = (m) => (m ? `${m} month${m === 1 ? '' : 's'}` : 'no end date');
  body.innerHTML = `
    <form class="card stack" id="promo-new">
      <h3>New code</h3>
      <p class="hint" style="margin:0">Give it to a creator, partner or giveaway winner. They redeem it under <b>Billing → Have a code?</b> and get the plan for free.</p>
      <div class="row" style="flex-wrap:wrap;align-items:flex-end">
        <label class="small">Code<br><input type="text" name="code" placeholder="blank = random" style="max-width:180px;text-transform:uppercase"></label>
        <label class="small">Plan<br><select name="planId" style="width:auto">${plans.plans.filter((p) => p.active).map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>
        <label class="small">Months free<br><input type="number" name="months" value="3" min="0" max="120" style="width:80px" title="0 = no end date"></label>
        <label class="small">Uses<br><input type="number" name="maxUses" value="1" min="1" style="width:70px"></label>
        <label class="small">Redeem by (optional)<br><input type="date" name="expiresAt" style="width:auto"></label>
        <label class="small" style="flex:1;min-width:160px">Note<br><input type="text" name="note" placeholder="e.g. Creator: Steve (YouTube)"></label>
        <button class="btn primary">Create code</button>
      </div>
    </form>
    <div class="card" style="margin-top:12px">
      <h3 style="margin-bottom:8px">Codes</h3>
      ${
        codes.length
          ? `<table><thead><tr><th>Code</th><th>Gives</th><th>Used</th><th>Note</th><th></th></tr></thead><tbody>${codes
              .map(
                (c) => `<tr>
                  <td><code class="copy" data-copy="${esc(c.code)}" title="Click to copy">${esc(c.code)}</code>
                    ${c.active ? '<span class="badge green">active</span>' : `<span class="badge">${c.disabled ? 'disabled' : 'used up / expired'}</span>`}</td>
                  <td class="small">${esc(c.planName)} · ${length(c.months)}${c.expiresAt ? `<div class="muted">redeem by ${new Date(c.expiresAt).toLocaleDateString()}</div>` : ''}</td>
                  <td class="small">${c.uses} / ${c.maxUses}${c.redeemedBy.length ? `<div class="muted">${c.redeemedBy.map((u) => esc(u.username)).join(', ')}</div>` : ''}</td>
                  <td class="small">${esc(c.note) || '<span class="muted">-</span>'}</td>
                  <td class="actions-cell">${c.disabled ? '' : `<button class="btn sm danger" data-pdis="${esc(c.code)}">Disable</button>`}</td>
                </tr>`,
              )
              .join('')}</tbody></table>`
          : '<p class="muted" style="margin:0">No codes yet.</p>'
      }
      <p class="hint small" style="margin:8px 0 0">When a free plan with an end date runs out, its server is stopped and the customer is emailed. They can buy a plan to keep it.</p>
    </div>`;
  $('#promo-new', body).addEventListener('submit', (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    attempt(async () => {
      const c = await api('POST', '/api/admin/promos', f);
      await navigator.clipboard.writeText(c.code).catch(() => {});
      toast(`Code ${c.code} created and copied`);
      adminPromos(body);
    });
  });
  $$('[data-copy]', body).forEach((el) => el.addEventListener('click', () => navigator.clipboard.writeText(el.dataset.copy).then(() => toast('Copied'))));
  $$('[data-pdis]', body).forEach((b) =>
    b.addEventListener('click', () => {
      if (!confirm(`Disable ${b.dataset.pdis}? Nobody can redeem it anymore (plans already given keep working).`)) return;
      attempt(async () => {
        await api('DELETE', `/api/admin/promos/${encodeURIComponent(b.dataset.pdis)}`);
        adminPromos(body);
      });
    }),
  );
}

async function adminPlans(body) {
  const d = await api('GET', '/api/admin/billing');
  const row = (p = {}) => `<tr class="plan-row">
    <td><input type="text" data-k="name" value="${esc(p.name || '')}" placeholder="Name"></td>
    <td><input type="number" data-k="ramGb" value="${p.ramMb ? +(p.ramMb / 1024).toFixed(2) : ''}" min="0.5" step="0.5" style="width:80px"></td>
    <td><input type="number" data-k="cpus" value="${p.cpus || 1}" min="0.5" step="0.5" style="width:70px"></td>
    <td><input type="number" data-k="diskGb" value="${p.diskGb || 10}" min="1" style="width:70px"></td>
    <td><input type="number" data-k="price" value="${p.priceCents !== undefined ? (p.priceCents / 100).toFixed(2) : ''}" min="0" step="0.01" style="width:90px"></td>
    <td><input type="text" data-k="description" value="${esc(p.description || '')}" placeholder="Who it's for"></td>
    <td><input type="checkbox" data-k="active" ${p.active !== false ? 'checked' : ''} title="Shown for sale"></td>
    <td><input type="hidden" data-k="id" value="${esc(p.id || '')}"><button type="button" class="btn sm danger" data-rm>✕</button></td>
  </tr>`;
  body.innerHTML = `
    <div class="card">
      <h3 style="margin-bottom:4px">Plans</h3>
      <p class="hint small" style="margin:0 0 10px">Prices are monthly in ${esc(d.currency.toUpperCase())}. Changes apply to new purchases; existing customers keep what they bought.
        Untick "for sale" to hide a plan.</p>
      <div style="overflow-x:auto"><table class="plans-edit"><thead><tr><th>Name</th><th>RAM (GB)</th><th>CPUs</th><th>Disk (GB)</th><th>Price</th><th>Description</th><th>For sale</th><th></th></tr></thead>
        <tbody id="plan-rows">${d.plans.map(row).join('')}</tbody></table></div>
      <div class="row" style="margin-top:10px"><button class="btn sm" id="plan-add">+ Add plan</button><button class="btn primary" id="plan-save">Save plans</button></div>
    </div>
    <div class="card stack">
      <h3>Capacity</h3>
      <p class="hint" style="margin:0">The most memory Tree Host sells on this machine (each server also needs ~384 MB extra). When it's full, plans show as sold out.
        Default: all memory except 2 GB (${+((d.totalMemMb - 2048) / 1024).toFixed(1)} GB of ${+(d.totalMemMb / 1024).toFixed(1)} GB).</p>
      <div class="row"><input type="number" id="cap-gb" min="1" step="1" placeholder="Automatic" value="${d.capacitySetting ? +(d.capacitySetting / 1024).toFixed(1) : ''}" style="max-width:160px"><span class="muted">GB</span>
        <button class="btn" id="cap-save">Save</button></div>
    </div>`;
  const bindRm = () => $$('[data-rm]', body).forEach((b) => (b.onclick = () => b.closest('tr').remove()));
  bindRm();
  $('#plan-add', body).addEventListener('click', () => {
    $('#plan-rows', body).insertAdjacentHTML('beforeend', row());
    bindRm();
  });
  $('#plan-save', body).addEventListener('click', () =>
    attempt(async () => {
      const plans = $$('.plan-row', body).map((tr) => {
        const v = (k) => $(`[data-k="${k}"]`, tr);
        return {
          id: v('id').value || v('name').value,
          name: v('name').value.trim(),
          ramMb: Math.round(Number(v('ramGb').value) * 1024),
          cpus: Number(v('cpus').value),
          diskGb: Number(v('diskGb').value),
          priceCents: Math.round(Number(v('price').value) * 100),
          description: v('description').value.trim(),
          active: v('active').checked,
        };
      });
      await api('PUT', '/api/admin/plans', { plans });
      toast('Plans saved');
      adminPlans(body);
    }),
  );
  $('#cap-save', body).addEventListener('click', () =>
    attempt(async () => {
      const gb = Number($('#cap-gb', body).value);
      await api('PUT', '/api/admin/billing-settings', { capacityMb: gb ? Math.round(gb * 1024) : null });
      toast('Capacity saved');
    }),
  );
}

async function adminSettings(body) {
  body.innerHTML = `
    <div class="card stack">
      <h3>Sign-ups</h3>
      <label class="check"><input type="checkbox" id="allow-signup"> Anyone can create an account on the website</label>
    </div>
    <div class="card stack" id="notify-card">
      <h3>Discord alerts for admins</h3>
      <div id="notify-body" class="muted">Loading...</div>
    </div>
`;
  renderNotifications(body).catch((e) => toast(e.message, 'error'));
  const st = await api('GET', '/api/team/settings');
  const box = $('#allow-signup', body);
  box.checked = !!st.allowSignup;
  box.addEventListener('change', () =>
    attempt(async () => {
      await api('PUT', '/api/team/settings', { allowSignup: box.checked });
      toast(box.checked ? 'Sign-ups are open' : 'Sign-ups are closed');
    }),
  );
}

// ---------- deploy from build ----------

function deployCardHtml(s) {
  const base = state.me.publicUrl || location.origin;
  const endpoint = `${base}/api/servers/${s.id}/deploy`;
  const gradle = `// Upload your plugin with: ./gradlew deployServer
// Needs the TREEHOST_TOKEN environment variable (Account → API tokens).
tasks.register("deployServer") {
    dependsOn("build")
    doLast {
        val jar = layout.buildDirectory.dir("libs").get().asFile.listFiles()!!
            .filter { it.name.endsWith(".jar") && !it.name.endsWith("-sources.jar") && !it.name.endsWith("-javadoc.jar") }
            .maxByOrNull { it.lastModified() } ?: throw GradleException("No jar found in build/libs")
        val token = System.getenv("TREEHOST_TOKEN") ?: throw GradleException("Set the TREEHOST_TOKEN environment variable")
        val url = "${endpoint}?name=" + java.net.URLEncoder.encode(jar.name, "UTF-8")
        val request = java.net.http.HttpRequest.newBuilder(java.net.URI(url))
            .header("Authorization", "Bearer $token")
            .POST(java.net.http.HttpRequest.BodyPublishers.ofFile(jar.toPath()))
            .build()
        val response = java.net.http.HttpClient.newHttpClient().send(request, java.net.http.HttpResponse.BodyHandlers.ofString())
        if (response.statusCode() !in 200..299) throw GradleException("Deploy failed: " + response.body())
        println("Deployed \${jar.name}: " + response.body())
    }
}`;
  const curlSh = `curl -f -X POST -H "Authorization: Bearer $TREEHOST_TOKEN" \\
  --data-binary @target/MyPlugin-1.0.jar \\
  "${endpoint}?name=MyPlugin-1.0.jar"`;
  const curlPs = `curl.exe -f -X POST -H "Authorization: Bearer $env:TREEHOST_TOKEN" \`
  --data-binary "@target\\MyPlugin-1.0.jar" \`
  "${endpoint}?name=MyPlugin-1.0.jar"`;
  const block = (code) => `<pre class="code"><button type="button" class="btn sm copy-code">Copy</button>${esc(code)}</pre>`;
  return `
    <div class="card">
      <details><summary><b>Developers: upload your plugin straight from your build</b></summary>
      <p class="hint">Older versions of the same plugin are replaced and the server restarts if it's running. First create a token under
      <a href="#" id="open-account">Account → API tokens</a> and set it as the <code>TREEHOST_TOKEN</code> environment variable.</p>
      <details open><summary>Gradle (build.gradle.kts): <code>./gradlew deployServer</code></summary>${block(gradle)}</details>
      <details><summary>Maven / any build: curl (macOS, Linux, Git Bash)</summary>${block(curlSh)}</details>
      <details><summary>Maven / any build: PowerShell (Windows)</summary>${block(curlPs)}</details>
      </details>
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

function bindCopies(el) {
  $$('[data-copy]', el).forEach((b) =>
    b.addEventListener('click', () => navigator.clipboard.writeText(b.dataset.copy).then(() => toast('Copied'))),
  );
}

