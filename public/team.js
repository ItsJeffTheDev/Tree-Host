'use strict';
// Accounts UI: sign-in screens, account, billing (plans and subscriptions) and the Staff Console sections.
// Loaded before app.js; uses app.js helpers ($, esc, api, toast, attempt, state) at call time.

function isTeam() {
  return !!(state.me && state.me.teamMode);
}

/** Role-based access: the server sends the signed-in user's permissions (see src/rbac.js). */
function hasPerm(permission) {
  return !isTeam() || (state.me.user?.permissions || []).includes(permission);
}

function isCustomer() {
  return isTeam() && state.me.user?.role === 'customer';
}

const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', developer: 'Developer', staff: 'Support', customer: 'Customer' };
const ROLE_BADGE = { owner: 'yellow', admin: 'green', developer: 'blue', staff: 'blue', customer: '' };
const ROLE_OPTIONS = (selected, roles = ['customer', 'staff', 'developer', 'admin']) =>
  roles.map((r) => `<option value="${r}" ${r === selected ? 'selected' : ''}>${ROLE_LABEL[r] || r}</option>`).join('');

/**
 * Mirrors the server's permission rules so the dashboard only shows what you can use.
 * Actions: view, control, command, plugins, files, settings, deploy, manage (delete / reset world / change version).
 */
const ACTION_PERMISSION = {
  control: 'servers.operate', command: 'servers.operate',
  plugins: 'servers.edit', files: 'servers.edit', settings: 'servers.edit', deploy: 'servers.edit',
  manage: 'servers.destroy',
};
const MEMBER_ACTIONS = { coowner: ['view', 'control', 'command', 'plugins', 'files', 'settings', 'deploy'], helper: ['view', 'control', 'command'], viewer: ['view'] };
const MEMBER_LABEL = { coowner: 'Co-owner', helper: 'Helper', viewer: 'Viewer' };
/** My role on a server someone shared with me (null if it isn't shared with me). */
const myMembership = (s) => (s && s.members && state.me.user ? s.members.find((m) => m.id === state.me.user.id) : null) || null;

function can(action, s) {
  if (!isTeam()) return true;
  const u = state.me.user;
  if (!s || action === 'view' || s.owner === u.id) return true;
  const mine = myMembership(s);
  if (mine && !hasPerm('console.access')) return MEMBER_ACTIONS[mine.role].includes(action);
  return hasPerm(ACTION_PERMISSION[action] || 'servers.viewAll');
}

/** Features that act on the host machine itself (Play, open folder, watching build folders, custom paths). */
function hostFeatures() {
  return hasPerm('servers.host') && !state.me?.hosted;
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
  'auth/unauthorized-domain': "Sign-in isn't available on this website address yet. Please contact support.",
  'auth/operation-not-allowed': "This sign-in method isn't available yet. Try another one, or contact support.",
};
const fbMessage = (e) => FIREBASE_ERRORS[e && e.code] || (e && e.message) || String(e);

/**
 * Accounts whose email isn't verified yet: shows a reminder, and notices the moment the link in the email is clicked
 * (on load and whenever this tab gets focus again), so anything tied to the email (like the Owner role) applies
 * without signing out and in again.
 */
async function checkEmailVerified() {
  const u = state.me?.user;
  if (!u || !u.firebase || u.emailVerified) return;
  const fb = await firebaseAuth().catch(() => null);
  if (!fb) return;
  await fb.auth.authStateReady();
  const cur = fb.auth.currentUser;
  if (!cur || (cur.email || '').toLowerCase() !== (u.email || '').toLowerCase()) return; // another account is signed in to Firebase
  const refresh = async () => {
    await cur.reload();
    if (!cur.emailVerified) return false;
    await api('POST', '/api/auth/firebase', { idToken: await cur.getIdToken(true) });
    location.reload();
    return true;
  };
  if (await refresh().catch(() => false)) return;
  window.addEventListener('focus', () => refresh().catch(() => {}));
  const bar = document.createElement('div');
  bar.className = 'warn-box';
  bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:16px;z-index:60;width:min(600px,calc(100vw - 32px));box-shadow:0 8px 30px rgba(0,0,0,.4)';
  bar.innerHTML = `<b>Verify your email.</b> We sent a link to <b>${esc(u.email)}</b> (check spam too).
    ${u.ownerPending ? 'This is an <b>Owner</b> email: you get the Owner role as soon as it is verified.' : ''}
    <div class="row" style="margin-top:8px;flex-wrap:wrap"><button class="btn sm primary" data-v="done">I've clicked the link</button>
    <button class="btn sm" data-v="send">Send the link again</button><button class="btn sm" data-v="hide">Later</button></div>`;
  document.body.appendChild(bar);
  bar.addEventListener('click', (e) => {
    const v = e.target.dataset && e.target.dataset.v;
    if (v === 'hide') bar.remove();
    if (v === 'send') sendEmailLink('verify', u.email, cur).then(() => toast(`Sent to ${u.email}`), (err) => toast(fbMessage(err), 'error'));
    if (v === 'done') refresh().then((ok) => ok || toast("It's not verified yet: open the link in the email first.", 'error'), (err) => toast(err.message, 'error'));
  });
}

/** Age gate: a neutral birth-year question (no hint about the minimum age). Under-13s are remembered on this device. */
function birthYearField() {
  const now = new Date().getFullYear();
  const years = Array.from({ length: 100 }, (_, i) => now - i);
  return `<label class="field">Year you were born <select name="birthYear" required><option value="">Choose...</option>${years.map((y) => `<option>${y}</option>`).join('')}</select></label>`;
}
const tooYoungKey = 'th_age_block';
const ageBlocked = () => {
  try {
    return localStorage.getItem(tooYoungKey) === '1';
  } catch {
    return false;
  }
};
function noteTooYoung(err) {
  if (!/at least 13/.test((err && err.message) || '')) return;
  try {
    localStorage.setItem(tooYoungKey, '1');
  } catch {}
}

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
        ${addAccountBanner()}
        <h2>${esc(title)}</h2>
        <p class="muted" style="margin:0">${esc(sub)}</p>
        ${newAccount ? `<label class="field">Username <input type="text" name="username" required minlength="3" maxlength="32" autocomplete="username" value="${esc(state.pendingProfile?.suggested || '')}"></label>` : ''}
        ${mode !== 'profile' ? '<label class="field">Email <input type="email" name="email" required autocomplete="email"></label>' : ''}
        ${!['forgot', 'profile'].includes(mode) ? `<label class="field">Password <input type="password" name="password" required minlength="${mode === 'login' ? 1 : 8}" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}"></label>` : ''}
        ${
          ['signup', 'profile'].includes(mode) && !invite
            ? `${birthYearField()}<label class="check"><input type="checkbox" name="acceptTerms" required>
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
      birthYear: f.birthYear ? Number(f.birthYear.value) : undefined,
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
        await sendEmailLink('reset', f.email.value.trim());
        const ok = $('#auth-ok');
        ok.textContent = 'If an account uses that email, a reset link is on its way. Check your inbox (and spam).';
        ok.classList.remove('hidden');
        return;
      }
      // The age gate runs before any account exists anywhere (Tree Host checks it again).
      if (f.birthYear && (ageBlocked() || new Date().getFullYear() - Number(f.birthYear.value) <= 13)) {
        noteTooYoung({ message: 'at least 13' });
        if (mode === 'profile') await fb.signOut(fb.auth).catch(() => {});
        return showError('Sorry, you need to be at least 13 to make a Tree Host account.');
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
        // With branded emails the welcome email carries the confirm button (sent when the account is made).
        if (!state.me.customEmails) fb.sendEmailVerification(cred.user).catch(() => {});
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
/**
 * Password reset / email confirmation. With branded emails set up, Tree Host sends them (our design, from our address);
 * otherwise Firebase sends its plain ones.
 */
async function sendEmailLink(type, email, fbUser) {
  if (state.me?.customEmails) {
    const r = await api('POST', '/api/auth/email-link', { type, email });
    if (!r.fallback) return;
  }
  const fb = await firebaseAuth();
  if (type === 'verify') await fb.sendEmailVerification(fbUser || fb.auth.currentUser);
  else await fb.sendPasswordResetEmail(fb.auth, email);
}

async function sendResetEmail(email) {
  await sendEmailLink('reset', email);
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
        ${addAccountBanner()}
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
            ? `${birthYearField()}<label class="check"><input type="checkbox" name="acceptTerms" required>
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
    if (f.birthYear) body.birthYear = Number(f.birthYear.value);
    if (mode === 'signup' && ageBlocked()) return showError('Sorry, you need to be at least 13 to make a Tree Host account.');
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
      noteTooYoung(err);
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
    <div class="ub-name">${esc(u.username)} <span class="badge ${ROLE_BADGE[u.role] || ''}">${esc(u.roleLabel || ROLE_LABEL[u.role] || u.role)}</span>${u.lifetime ? ' <span class="badge lifetime-badge" title="Lifetime member: paid once, yours forever">Lifetime</span>' : ''}</div>
    ${
      state.me.lanUrls?.length
        ? `<div class="ub-link small">Home network: <span class="copy" data-copy="${esc(state.me.lanUrls[1] || state.me.lanUrls[0])}" title="Click to copy">${esc((state.me.lanUrls[1] || state.me.lanUrls[0]).replace('http://', ''))}</span></div>`
        : ''
    }
    <div class="row" style="flex-wrap:wrap;margin-top:6px">
      <button class="btn sm" id="ub-account">Account</button>
      ${state.me.hosted ? '<button class="btn sm" id="ub-billing">' + ic('card') + ' Billing</button>' : ''}
      ${isTeam() && hasPerm('console.access') ? '<a class="btn sm" href="/admin">' + ic('tools') + ' Staff Console</a>' : ''}
      <button class="btn sm" id="ub-switch" title="Switch to another account or add one">⇄ Switch</button>
      <button class="btn sm" id="ub-logout">Sign out</button>
    </div>`;
  $('#ub-account').addEventListener('click', openAccount);
  $('#ub-switch').addEventListener('click', () => openAccountSwitcher().catch((e) => toast(e.message, 'error')));
  if ($('#ub-billing')) $('#ub-billing').addEventListener('click', openBilling);
  $('#ub-logout').addEventListener('click', () => signOut(false));
  $$('[data-copy]', el).forEach((b) =>
    b.addEventListener('click', () => navigator.clipboard.writeText(b.dataset.copy).then(() => toast('Copied'))),
  );
}

// ---------- several accounts: switch, add, sign out ----------

/** "Adding another account" note on the sign-in screen (with a way back). */
function addAccountBanner() {
  if (!new URLSearchParams(location.search).has('add-account') || !state.me?.user) return '';
  return `<div class="warn-box">Adding another account. You stay signed in as <b>${esc(state.me.user.username)}</b> and can switch between them.
    <a href="/dashboard">Cancel</a></div>`;
}

/** Signs out of this account (switching to another one on this browser if there is one), or of all of them. */
async function signOut(all) {
  const r = await api('POST', '/api/auth/logout', all ? { all: true } : undefined).catch(() => ({}));
  if (r.switchedTo) {
    sessionStorage.setItem('th.toast', `Signed out. You're now using ${r.switchedTo}.`);
    location.href = '/dashboard';
    return;
  }
  const fb = await firebaseAuth().catch(() => null);
  if (fb) await fb.signOut(fb.auth).catch(() => {});
  location.href = '/';
}

async function switchAccount(userId) {
  const r = await api('POST', '/api/auth/switch', { userId });
  sessionStorage.setItem('th.toast', `Switched to ${r.username}`);
  location.href = location.pathname.startsWith('/admin') ? '/dashboard' : location.pathname + location.hash;
}

async function openAccountSwitcher() {
  const { accounts, max } = await api('GET', '/api/auth/accounts');
  const { root } = openModal(`
    <h2>Switch account</h2>
    <p class="hint" style="margin-top:-8px">Accounts signed in on this browser. Tree Host treats accounts used together as linked.</p>
    <div class="stack" style="gap:8px">${accounts
      .map((a) => `<button class="acct-row ${a.active ? 'active' : ''}" data-switch="${esc(a.id)}" ${a.active ? 'disabled' : ''}>
        <span class="acct-avatar">${esc(a.username.slice(0, 1).toUpperCase())}</span>
        <span class="acct-text"><b>${esc(a.username)}</b><span class="small muted">${esc(a.email || 'no email')}</span></span>
        <span class="badge ${ROLE_BADGE[a.role] || ''}">${esc(a.roleLabel)}</span>
        ${a.restricted ? `<span class="badge red">${esc(a.restricted)}</span>` : ''}
        ${a.active ? '<span class="badge green">using now</span>' : ''}
      </button>`)
      .join('')}</div>
    <div class="row" style="margin-top:14px;flex-wrap:wrap">
      ${accounts.length < max ? '<a class="btn primary" href="/dashboard?add-account">＋ Add another account</a>' : `<span class="muted small">You can be signed in to ${max} accounts at once.</span>`}
      <span style="flex:1"></span>
      ${accounts.length > 1 ? '<button class="btn" id="sw-all">Sign out of all</button>' : ''}
    </div>
    <div class="modal-actions"><button class="btn" data-close>Close</button></div>`);
  $$('[data-switch]', root).forEach((b) => b.addEventListener('click', () => attempt(() => switchAccount(b.dataset.switch))));
  if ($('#sw-all', root)) $('#sw-all', root).addEventListener('click', () => confirm('Sign out of every account on this browser?') && signOut(true));
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
  if (p.oneTime) {
    const sl = p.slots || { servers: 0, proxies: 0 };
    return `<div class="plan-card lifetime ${p.soldOut ? 'sold-out' : ''}">
    <div class="plan-ribbon">${ic('infinity')} Pay once, keep forever</div>
    <div class="plan-name">${esc(p.name)}</div>
    <div class="plan-price">${money(p.priceCents, currency)}<span> once</span></div>
    <ul class="plan-specs">
      <li><b>${sl.servers} servers</b> of any type and version · ${+(p.ramMb / 1024).toFixed(1)} GB each</li>
      <li><b>${sl.proxies} prox${sl.proxies === 1 ? 'y' : 'ies'}</b> (Velocity, BungeeCord, Waterfall) · ${+((p.proxyRamMb || 1024) / 1024).toFixed(1)} GB each</li>
      <li><b>${p.cpus}</b> CPU core${p.cpus === 1 ? '' : 's'} and <b>${p.diskGb} GB</b> disk per server</li>
      ${p.prioritySupport ? '<li><b>' + ic('star') + ' Priority support</b></li>' : ''}
      <li>No monthly bills, ever</li>
    </ul>
    <p class="small muted">${esc(p.description)}</p>
    <button class="btn ${p.soldOut ? '' : 'primary'} block" data-buy="${esc(p.id)}" ${p.soldOut ? 'disabled' : ''}>${p.soldOut ? 'Sold out' : 'Get Lifetime'}</button>
  </div>`;
  }
  return `<div class="plan-card ${p.soldOut ? 'sold-out' : ''}">
    <div class="plan-name">${esc(p.name)}</div>
    <div class="plan-price">${money(p.priceCents, currency)}<span>/month</span></div>
    <ul class="plan-specs">
      <li><b>${+(p.ramMb / 1024).toFixed(1)} GB</b> memory</li>
      <li><b>${p.cpus}</b> CPU core${p.cpus === 1 ? '' : 's'}</li>
      <li><b>${p.diskGb} GB</b> disk</li>
      <li><b>Unlimited</b> servers</li>
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
    <p class="hint" style="margin-top:-6px">Monthly plans run as many servers as you like, each with the plan's full memory, CPU and disk. Or pay once for Lifetime. Every server type and version.</p>
    ${data.mode === 'demo' ? '<div class="warn-box">Demo mode: no real payment is taken. Plans activate instantly.</div>' : ''}
    ${data.mode === 'off' ? '<div class="warn-box">Payments are not set up yet, so plans can\'t be bought right now.</div>' : ''}
    <div class="plan-grid">${data.plans.map((p) => planCardHtml(p, data.currency)).join('')}</div>
    <div class="modal-actions"><button class="btn" data-close>Close</button></div>`);
  root.querySelector('.modal').classList.add('wide');
  $$('[data-buy]', root).forEach((b) =>
    b.addEventListener('click', () => {
      const plan = data.plans.find((p) => p.id === b.dataset.buy);
      root.innerHTML = '';
      confirmCheckout(plan, data.currency);
    }),
  );
}

/** The last step before paying: price, renewal terms and the boxes the law asks for. Agreeing is recorded by Tree Host. */
function confirmCheckout(plan, currency) {
  const price = money(plan.priceCents, currency);
  const { root } = openModal(`
    <h2>${plan.oneTime ? ic('infinity') : ''} ${esc(plan.name)}</h2>
    <div class="checkout-summary">
      <div class="checkout-price">${price}<span>${plan.oneTime ? ' once' : ' / month'}</span></div>
      <p class="small" style="margin:6px 0 0">${
        plan.oneTime
          ? 'A single payment. It never renews and you are never charged again for this plan.'
          : `<b>Renews automatically every month at ${price}</b> until you cancel. Cancel any time in <b>Billing</b> with one click; you keep the plan until the end of the month you paid for. No refunds for part of a month, except where the law gives you one.`
      }</p>
    </div>
    <form id="co-form" class="stack" style="margin-top:12px">
      ${
        plan.oneTime
          ? ''
          : `<label class="check"><input type="checkbox" name="renewal" required> <span>I understand ${esc(plan.name)} renews automatically at ${price} per month until I cancel.</span></label>`
      }
      <label class="check"><input type="checkbox" name="adult" required> <span>I am 18 or older, or my parent or guardian agrees and is paying.</span></label>
      <label class="check"><input type="checkbox" name="withdrawal" required> <span>Start my server right away. If I live in the EU or UK, I understand I lose my 14-day right to cancel once it starts.</span></label>
      <p class="small muted" style="margin:0">By paying you agree to the <a href="/terms" target="_blank">Terms of Service</a>, including the <a href="/terms#refunds" target="_blank">refund policy</a>.</p>
      <div class="modal-actions"><button type="button" class="btn" data-close>Back</button><button class="btn primary" id="co-go">${plan.oneTime ? `Pay ${price}` : `Subscribe for ${price}/month`}</button></div>
    </form>`);
  const form = $('#co-form', root);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const go = $('#co-go', root);
    const label = go.textContent;
    go.disabled = true;
    go.textContent = 'Opening checkout...';
    const consent = { renewal: plan.oneTime ? false : form.renewal.checked, adult: form.adult.checked, withdrawal: form.withdrawal.checked };
    api('POST', '/api/billing/checkout', { planId: plan.id, consent })
      .then((r) => {
        if (r.demo) {
          toast('Plan activated (demo). Now create your server!');
          root.innerHTML = '';
          openNewServer();
        } else location.href = r.url;
      })
      .catch((err) => {
        toast(err.message, 'error');
        go.disabled = false;
        go.textContent = label;
      });
  });
}

/** Monthly plans take any number of servers; bundles (Lifetime) up to their slots. */
const planHasRoom = (x) => !x.slots || x.slotsUsed.servers < x.slots.servers || x.slotsUsed.proxies < x.slots.proxies;

/** The big card on Billing for a lifetime plan: what's included and how much is in use. */
function lifetimeCardHtml(x) {
  const bar = (used, max) => `<div class="slot-bar"><span style="width:${max ? Math.min(100, (used / max) * 100) : 0}%"></span></div>`;
  return `<div class="card lifetime-card">
    <div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <div><div class="lifetime-kicker">${ic('infinity')} LIFETIME MEMBER</div><h3 style="margin:2px 0 0">${esc(x.planName)}${x.free ? ' <span class="muted small">(gift)</span>' : ''}</h3></div>
      <span class="badge lifetime-badge">Paid once · yours forever</span>
    </div>
    <div class="lifetime-slots">
      <div><div class="small"><b>Servers</b> ${x.slotsUsed.servers} of ${x.slots.servers} · ${+(x.ramMb / 1024).toFixed(1)} GB each</div>${bar(x.slotsUsed.servers, x.slots.servers)}</div>
      <div><div class="small"><b>Proxies</b> ${x.slotsUsed.proxies} of ${x.slots.proxies} · ${+((x.proxyRamMb || 1024) / 1024).toFixed(1)} GB each</div>${bar(x.slotsUsed.proxies, x.slots.proxies)}</div>
    </div>
    ${x.prioritySupport ? `<div class="small" style="margin-top:10px">${ic('star')} <b>Priority support</b>: your tickets and emails go to the front of the line. Write to <a href="mailto:support@treehost.online">support@treehost.online</a> or open a ticket on Discord.</div>` : ''}
  </div>`;
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
  const lifetimes = b.subscriptions.filter((x) => x.oneTime && x.usable);
  el.innerHTML = `
    ${lifetimes.map((x) => lifetimeCardHtml(x)).join('')}
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
                  <td><b>${esc(x.planName)}</b>${x.oneTime ? ' <span class="badge lifetime-badge">' + ic('infinity') + ' Lifetime</span>' : ''} <span class="muted small">${+(x.ramMb / 1024).toFixed(1)} GB · ${x.free ? 'free' : x.oneTime ? `${money(x.priceCents, x.currency)} once` : `${money(x.priceCents, x.currency)}/mo`}</span></td>
                  <td><span class="badge ${cls}">${label}</span>${
                    x.status === 'past_due' ? '<div class="small muted">Update your card to keep the server running.</div>' : ''
                  }${x.deleteAt ? `<div class="small muted">Server deleted on ${new Date(x.deleteAt).toLocaleDateString()}</div>` : ''}${
                    x.cancelAtPeriodEnd ? '<div class="small muted">Ends at the end of this period</div>' : ''
                  }</td>
                  <td>${x.servers.length ? `<div class="small">${x.servers.map((v) => esc(v.name)).join('<br>')}</div>` : ''}${
                    x.usable && planHasRoom(x) ? `<button class="btn sm ${x.servers.length ? '' : 'primary'}" data-create style="margin-top:4px">+ ${x.servers.length ? 'Another server' : 'Create server'}</button>` : x.servers.length ? '' : '<span class="muted">-</span>'
                  }</td>
                  <td class="small">${
                    x.status === 'canceled'
                      ? '<span class="muted">-</span>'
                      : x.oneTime
                        ? 'Never: yours for life'
                        : x.free
                          ? x.freeUntil ? `Free until ${new Date(x.freeUntil).toLocaleDateString()}` : 'Free (lifetime)'
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

// ---------- Staff Console sections (rendered by console.js) ----------

async function adminPeople(body) {
  const [all, plans, rbac] = await Promise.all([api('GET', '/api/team/users'), api('GET', '/api/plans'), api('GET', '/api/admin/roles')]);
  // You can only manage people (and hand out roles) below your own role; Owners can do everything.
  const me = state.me.user;
  const level = (role) => (rbac.roles.find((r) => r.id === role) || { level: 0 }).level;
  const iAmOwner = me.role === 'owner';
  const outranks = (u) => iAmOwner || level(u.role) < level(me.role);
  const assignable = rbac.roles.filter((r) => iAmOwner || r.level < level(me.role)).map((r) => r.id).reverse();
  const canRoles = hasPerm('users.roles');
  const canManage = hasPerm('users.manage');
  const canGrant = hasPerm('billing.manage');
  let filter = 'all';
  let q = '';
  const draw = () => {
    const list = all
      .filter((u) => (filter === 'all' ? true : filter === 'staff' ? u.role !== 'customer' : u.role === 'customer'))
      .filter((u) => !q || u.username.toLowerCase().includes(q) || (u.email || '').includes(q));
    $('#ppl-list', body).innerHTML = `<table><thead><tr><th>User</th><th>Role</th><th>Plans</th><th></th></tr></thead><tbody>${list
      .map(
        (u) => `<tr>
          <td><b>${esc(u.username)}</b>${u.lifetime ? ' <span class="badge lifetime-badge" title="Has a Lifetime plan">Lifetime</span>' : ''}${u.prioritySupport ? ' <span class="badge yellow" title="Priority support">Priority</span>' : ''}${restrictionBadge(u.restriction)}${u.linked && u.linked.length ? ` <span class="badge blue" title="Used on the same device as: ${esc(u.linked.map((l) => l.username).join(', '))}">${u.linked.length} linked</span>` : ''}
            <div class="small muted">${esc(u.email) || 'no email'} · joined ${new Date(u.createdAt).toLocaleDateString()}${u.lastLogin ? ` · last seen ${new Date(u.lastLogin).toLocaleDateString()}` : ''}</div></td>
          <td>${
            u.id !== me.id && canRoles && outranks(u)
              ? `<select data-role="${esc(u.id)}" style="width:auto">${ROLE_OPTIONS(u.role, assignable)}</select>`
              : `<span class="badge ${ROLE_BADGE[u.role] || ''}">${esc(u.roleLabel || ROLE_LABEL[u.role] || u.role)}</span>`
          }</td>
          <td class="small">${u.activePlans.length ? esc(u.activePlans.join(', ')) : '<span class="muted">none</span>'}${u.servers ? ` · ${u.servers} server${u.servers > 1 ? 's' : ''}` : ''}</td>
          <td class="actions-cell">${(() => {
            if (u.id === me.id) return '<span class="muted small">you</span>';
            const manage = canManage && outranks(u);
            const items = [
              hasPerm('promos.manage') ? `<button class="btn sm" data-code="${esc(u.id)}">${ic('ticket')} Give a free server code</button>` : '',
              canGrant ? `<button class="btn sm" data-grant="${esc(u.id)}">Give a free plan now</button>` : '',
              manage
                ? u.firebase
                  ? `<button class="btn sm" data-reset="${esc(u.email)}">Send password reset email</button>`
                  : `<button class="btn sm" data-temp="${esc(u.id)}">Temporary password</button>`
                : '',
              hasPerm('messages.send') ? `<button class="btn sm" data-msg="${esc(u.id)}">${ic('mail')} Send message</button>` : '',
              outranks(u) && canTakeAction('account') ? `<button class="btn sm" data-take="${esc(u.id)}">${ic('shield')} Take action (warn, suspend, ban, delete)</button>` : '',
              u.restriction && !u.restriction.actionId && hasPerm('moderation.act') && outranks(u) ? `<button class="btn sm" data-legacy="${esc(u.id)}">Lift old suspension</button>` : '',
            ].join('');
            return items ? `<details class="menu"><summary class="btn sm">More</summary><div class="menu-body">${items}</div></details>` : '';
          })()}</td></tr>`,
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
        const r = rbac.roles.find((x) => x.id === sel.value);
        if (sel.value !== 'customer' && !confirm(`Make this person ${r.label}?\n\n${r.description}`)) return reload();
        attempt(async () => {
          await api('PUT', `/api/team/users/${sel.dataset.role}/role`, { role: sel.value });
          toast(`Role changed to ${ROLE_LABEL[sel.value]}`);
        }).then(reload);
      }),
    );
    $$('[data-grant]', body).forEach((b) =>
      b.addEventListener('click', () => openGrantPlan(all.find((x) => x.id === b.dataset.grant), plans.plans, reload)),
    );
    $$('[data-code]', body).forEach((b) => b.addEventListener('click', () => openAccountCode(all.find((x) => x.id === b.dataset.code), plans.plans)));
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
    $$('[data-take]', body).forEach((b) =>
      b.addEventListener('click', () => {
        const u = all.find((x) => x.id === b.dataset.take);
        openTakeAction({ target: 'account', user: u, onDone: reload });
      }),
    );
    $$('[data-msg]', body).forEach((b) => b.addEventListener('click', () => openSendMessage(all.find((x) => x.id === b.dataset.msg))));
    $$('[data-legacy]', body).forEach((b) =>
      b.addEventListener('click', () =>
        attempt(async () => {
          await api('POST', `/api/team/users/${b.dataset.legacy}/lift-legacy`);
          toast('Suspension lifted');
          reload();
        }),
      ),
    );
  };
  body.innerHTML = `
    <div class="row" style="margin-bottom:10px">
      <input type="search" id="ppl-q" placeholder="Search name or email" style="max-width:260px">
      <select id="ppl-filter" style="max-width:180px"><option value="all">Everyone</option><option value="customers">Customers</option><option value="staff">Support & admins</option></select>
      <span class="muted small">${all.length} account${all.length === 1 ? '' : 's'}</span>
    </div>
    <div id="ppl-list"></div>
    ${
      canRoles && assignable.some((r) => ['staff', 'developer', 'admin'].includes(r))
        ? `<div class="card stack" style="margin-top:14px">
      <h3>Invite staff</h3>
      <p class="hint" style="margin:0">Creates a one-time sign-up link (valid for 7 days) that gives the new account this role. See <b>Roles</b> for what each role can do.</p>
      <div class="row">
        <select id="inv-role" style="max-width:200px">${ROLE_OPTIONS('staff', assignable.filter((r) => ['staff', 'developer', 'admin'].includes(r)))}</select>
        <button class="btn primary" id="inv-create">Create invite link</button>
      </div>
      <div id="inv-link" class="hidden"></div>
    </div>`
        : ''
    }`;
  $('#ppl-q', body).addEventListener('input', (e) => ((q = e.target.value.trim().toLowerCase()), draw()));
  $('#ppl-filter', body).addEventListener('change', (e) => ((filter = e.target.value), draw()));
  if ($('#inv-create', body)) $('#inv-create', body).addEventListener('click', () =>
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
        ? '<div class="warn-box">Payments are off. Set <code>STRIPE_SECRET_KEY</code> and <code>STRIPE_WEBHOOK_SECRET</code> (see Staff docs → Running Tree Host), or <code>BILLING_DEMO=1</code> to test.</div>'
        : d.mode === 'demo'
          ? '<div class="warn-box">Demo mode: plans activate without payment. Turn it off before going live.</div>'
          : !d.webhookReady
            ? '<div class="warn-box">STRIPE_WEBHOOK_SECRET is missing: payments go through but Tree Host never hears about them.</div>'
            : ''
    }
    <div class="stat-row">
      <div class="stat"><div class="stat-num">${mrr}</div><div class="stat-label">per month (MRR)</div></div>
      <div class="stat"><div class="stat-num">${Object.entries(d.oneTime || {}).map(([c, v]) => money(v, c)).join(' + ') || money(0, d.currency)}</div><div class="stat-label">${ic('infinity')} lifetime sales (${d.lifetimeCount || 0} active)</div></div>
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
                  <td class="actions-cell">${x.status !== 'canceled' && hasPerm('billing.manage') ? `<button class="btn sm danger" data-cancel="${esc(x.id)}">Cancel</button>` : ''}</td></tr>`;
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

// ---------- how long a free server lasts ----------
const FREE_DURATIONS = [
  [7, '1 week'], [14, '2 weeks'], [30, '1 month'], [90, '3 months'], [180, '6 months'], [365, '1 year'],
  [0, '' + ic('infinity') + ' Lifetime (never ends)'], ['custom', 'Custom number of days…'],
];
/** A "How long" field: presets, Lifetime, or a custom number of days. Read it with durationDays(form). */
function durationFieldHtml(defaultDays = 30) {
  return `<label class="small">How long<br>
    <select name="duration" style="width:auto">${FREE_DURATIONS.map(([v, l]) => `<option value="${v}" ${v === defaultDays ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <input type="number" name="customDays" min="1" max="3650" placeholder="days" class="hidden" style="width:90px"></label>`;
}
function bindDuration(form) {
  const sel = $('[name=duration]', form);
  const custom = $('[name=customDays]', form);
  sel.addEventListener('change', () => {
    custom.classList.toggle('hidden', sel.value !== 'custom');
    if (sel.value === 'custom') custom.focus();
  });
}
/** Days from the field (0 = lifetime). Throws a friendly error for an empty custom value. */
function durationDays(form) {
  const v = $('[name=duration]', form).value;
  if (v !== 'custom') return Number(v);
  const d = Math.round(Number($('[name=customDays]', form).value));
  if (!(d >= 1 && d <= 3650)) throw new Error('Enter how many days (1 to 3650), or pick Lifetime.');
  return d;
}
const durationLabel = (days) => (days ? (FREE_DURATIONS.find(([v]) => v === days) || [0, `${days} days`])[1] : 'Lifetime');

/** Give someone a free plan right away (no code needed). */
function openGrantPlan(user, planList, onDone) {
  const { root, close } = openModal(`
    <h2>Free plan for ${esc(user.username)}</h2>
    <p class="hint" style="margin-top:0">Activates right away in their Billing; they can create the server immediately.
      To let them claim it themselves, use <b>Give a free server code</b> instead.</p>
    <form id="gp-form" class="card stack">
      <div class="row" style="flex-wrap:wrap;align-items:flex-end">
        <label class="small">Plan<br><select name="planId" style="width:auto">${planList.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${+(p.ramMb / 1024).toFixed(1)} GB)</option>`).join('')}</select></label>
        ${durationFieldHtml(30)}
        <label class="small" style="flex:1;min-width:180px">Note<br><input type="text" name="note" placeholder="e.g. Staff server, partner"></label>
      </div>
      <div class="row"><button class="btn primary">Give free plan</button></div>
    </form>
    <div class="modal-actions"><button class="btn" data-close>Close</button></div>`);
  const form = $('#gp-form', root);
  bindDuration(form);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    attempt(async () => {
      const days = durationDays(form);
      await api('POST', '/api/admin/subscriptions', { userId: user.id, planId: form.planId.value, days, note: form.note.value });
      toast(`${user.username} got a free plan (${durationLabel(days)})`);
      close();
      if (onDone) onDone();
    });
  });
}

/** One-time code for one account: only that person can redeem it, once (Billing → Have a code?). */
function openAccountCode(user, planList) {
  const canEmail = !!(state.me.mailEnabled && user.email);
  const { root, close } = openModal(`
    <h2>Free server code for ${esc(user.username)}</h2>
    <p class="hint" style="margin-top:0">Creates a one-time code that <b>only ${esc(user.username)}</b> can redeem, under
      <b>Billing → Have a code?</b>. Anyone else who tries it is told it's for a different account.</p>
    <form id="ac-form" class="card stack">
      <div class="row" style="flex-wrap:wrap;align-items:flex-end">
        <label class="small">Plan<br><select name="planId" style="width:auto">${planList.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${+(p.ramMb / 1024).toFixed(1)} GB)</option>`).join('')}</select></label>
        ${durationFieldHtml(30)}
        <label class="small" style="flex:1;min-width:180px">Note<br><input type="text" name="note" placeholder="e.g. Creator promo, giveaway winner"></label>
      </div>
      ${canEmail ? `<label class="check"><input type="checkbox" name="email" checked> Email the code to ${esc(user.email)}</label>` : ''}
      <div class="row"><button class="btn primary">Create code</button></div>
    </form>
    <div id="ac-result"></div>
    <div class="modal-actions"><button class="btn" data-close>Close</button></div>`);
  bindDuration($('#ac-form', root));
  $('#ac-form', root).addEventListener('submit', (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    attempt(async () => {
      const days = durationDays(e.target);
      const c = await api('POST', '/api/admin/promos', { planId: f.planId, days, note: f.note || `For ${user.username}`, forUserId: user.id, email: !!f.email });
      const msg = `Here's your free Tree Host server: ${c.planName}${c.days ? ` for ${c.length}` : ', for life'}! Sign in, open Billing → "Have a code?" and enter ${c.code}. It only works for your account.`;
      $('#ac-form', root).classList.add('hidden');
      $('#ac-result', root).innerHTML = `<div class="card stack">
        <div class="small muted">Code (one use, only for ${esc(user.username)})</div>
        <code class="copy" data-copy="${esc(c.code)}" style="font-size:20px;padding:8px 12px" title="Click to copy">${esc(c.code)}</code>
        ${c.emailed ? `<div class="badge green" style="align-self:flex-start">Emailed to ${esc(user.email)}</div>` : ''}
        <div class="small muted">Message to send them:</div>
        <textarea readonly rows="3" style="width:100%">${esc(msg)}</textarea>
        <div class="row"><button class="btn sm" id="ac-copy-msg">Copy message</button></div>
      </div>`;
      $('[data-copy]', root).addEventListener('click', (ev) => navigator.clipboard.writeText(ev.target.dataset.copy).then(() => toast('Code copied')));
      $('#ac-copy-msg', root).addEventListener('click', () => navigator.clipboard.writeText(msg).then(() => toast('Message copied')));
      toast(`Code ${c.code} created for ${user.username}`);
    });
  });
  return { root, close };
}

// Promo codes: free plans for creators, partners and giveaways. Customers redeem them in Billing.
async function adminPromos(body) {
  const [codes, plans] = await Promise.all([api('GET', '/api/admin/promos'), api('GET', '/api/admin/billing')]);
  body.innerHTML = `
    <form class="card stack" id="promo-new">
      <h3>New code</h3>
      <p class="hint" style="margin:0">Give it to a creator, partner or giveaway winner. They redeem it under <b>Billing → Have a code?</b> and get the plan for free.</p>
      <div class="row" style="flex-wrap:wrap;align-items:flex-end">
        <label class="small">Code<br><input type="text" name="code" placeholder="blank = random" style="max-width:180px;text-transform:uppercase"></label>
        <label class="small">Plan<br><select name="planId" style="width:auto">${plans.plans.filter((p) => p.active).map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>
        ${durationFieldHtml(90)}
        <label class="small">Uses<br><input type="number" name="maxUses" value="1" min="1" style="width:70px"></label>
        <label class="small">Redeem by (optional)<br><input type="date" name="expiresAt" style="width:auto"></label>
        <label class="small">Only for account (optional)<br><input type="text" name="forUser" placeholder="username or email" style="max-width:200px" title="The code then works once, and only for this account"></label>
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
                  <td class="small">${esc(c.planName)} · ${c.days ? esc(c.length) : 'lifetime'}${c.forUsername ? `<div><span class="badge blue" title="Only this account can redeem it">only for ${esc(c.forUsername)}</span></div>` : ''}${c.expiresAt ? `<div class="muted">redeem by ${new Date(c.expiresAt).toLocaleDateString()}</div>` : ''}</td>
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
  bindDuration($('#promo-new', body));
  $('#promo-new', body).addEventListener('submit', (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    attempt(async () => {
      f.days = durationDays(e.target);
      delete f.duration;
      delete f.customDays;
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
    <td><input type="text" data-k="name" value="${esc(p.name || '')}" placeholder="Name">${
      p.oneTime
        ? `<input type="hidden" data-k="oneTime" value="1"><div class="small muted" style="margin-top:4px;white-space:nowrap">${ic('infinity')} Paid once ·
            <input type="number" data-k="slotServers" value="${p.slots ? p.slots.servers : 4}" min="0" style="width:52px"> servers +
            <input type="number" data-k="slotProxies" value="${p.slots ? p.slots.proxies : 2}" min="0" style="width:52px"> proxies of
            <input type="number" data-k="proxyGb" value="${+((p.proxyRamMb || 1024) / 1024).toFixed(2)}" min="0.5" step="0.5" style="width:60px"> GB ·
            <label><input type="checkbox" data-k="priority" ${p.prioritySupport ? 'checked' : ''}> priority support</label></div>`
        : ''
    }</td>
    <td><input type="number" data-k="ramGb" value="${p.ramMb ? +(p.ramMb / 1024).toFixed(2) : ''}" min="0.5" step="0.5" style="width:80px"></td>
    <td><input type="number" data-k="cpus" value="${p.cpus || 1}" min="0.5" step="0.5" style="width:70px"></td>
    <td><input type="number" data-k="diskGb" value="${p.diskGb || 10}" min="1" style="width:70px"></td>
    <td><input type="number" data-k="price" value="${p.priceCents !== undefined ? (p.priceCents / 100).toFixed(2) : ''}" min="0" step="0.01" style="width:90px"></td>
    <td><input type="text" data-k="description" value="${esc(p.description || '')}" placeholder="Who it's for"></td>
    <td><input type="checkbox" data-k="active" ${p.active !== false ? 'checked' : ''} title="Shown for sale"></td>
    <td><input type="hidden" data-k="id" value="${esc(p.id || '')}"><button type="button" class="btn sm danger" data-rm>${ic('x')}</button></td>
  </tr>`;
  body.innerHTML = `
    <div class="card">
      <h3 style="margin-bottom:4px">Plans</h3>
      <p class="hint small" style="margin:0 0 10px">Prices are monthly in ${esc(d.currency.toUpperCase())} (the ${ic('infinity')} Lifetime plan is a one-time price; its RAM is per server).
        Monthly plans run any number of servers. Changes apply to new purchases; existing customers keep what they bought.
        Untick "for sale" to hide a plan.</p>
      <div style="overflow-x:auto"><table class="plans-edit"><thead><tr><th>Name</th><th>RAM (GB)</th><th>CPUs</th><th>Disk (GB)</th><th>Price</th><th>Description</th><th>For sale</th><th></th></tr></thead>
        <tbody id="plan-rows">${d.plans.map(row).join('')}</tbody></table></div>
      <div class="row" style="margin-top:10px"><button class="btn sm" id="plan-add">+ Add plan</button><button class="btn primary" id="plan-save">Save plans</button></div>
    </div>
    <div class="card stack">
      <h3>Capacity</h3>
      <p class="hint" style="margin:0">The most memory Tree Host sells on this machine (each server also needs ~384 MB extra). When it's full, plans show as sold out.
        Default: about 90% of the RAM (${+(Math.floor(d.totalMemMb * 0.9) / 1024).toFixed(1)} GB of ${+(d.totalMemMb / 1024).toFixed(1)} GB).
        Every monthly plan always has room for one running server; extra servers on the same plan only start while there's unsold memory, and are refused when the machine is full.</p>
      <div class="row"><input type="number" id="cap-gb" min="1" step="1" placeholder="Automatic" value="${d.capacitySetting ? +(d.capacitySetting / 1024).toFixed(1) : ''}" style="max-width:160px"><span class="muted">GB</span></div>
      <p class="small muted" style="margin:0">Sold: ${+(d.soldMb / 1024).toFixed(1)} GB · extra servers running now: ${+((d.borrowedMb || 0) / 1024).toFixed(1)} GB · free: ${+((d.capacityMb - d.soldMb - (d.borrowedMb || 0)) / 1024).toFixed(1)} GB of ${+(d.capacityMb / 1024).toFixed(1)} GB</p>
      <label class="field">Lifetime plans sold on this machine (each holds its memory forever; 0 = no limit)
        <div class="row"><input type="number" id="cap-life" min="0" max="100" step="1" placeholder="2" value="${d.lifetimeSetting ?? ''}" style="max-width:160px"><span class="muted">${d.lifetimeCount} sold</span></div></label>
      <div class="row"><button class="btn" id="cap-save">Save</button></div>
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
          ...(v('oneTime')
            ? {
                oneTime: true,
                slots: { servers: Number(v('slotServers').value), proxies: Number(v('slotProxies').value) },
                proxyRamMb: Math.round(Number(v('proxyGb').value) * 1024),
                prioritySupport: v('priority').checked,
              }
            : {}),
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
      const life = $('#cap-life', body).value.trim();
      await api('PUT', '/api/admin/billing-settings', { capacityMb: gb ? Math.round(gb * 1024) : null, lifetimePerNode: life === '' ? null : Number(life) });
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
    <div class="card stack" id="email-card">
      <h3>Emails</h3>
      <div id="email-body" class="muted">Loading...</div>
    </div>
    <div class="card stack" id="notify-card">
      <h3>Discord alerts for admins</h3>
      <div id="notify-body" class="muted">Loading...</div>
    </div>
`;
  renderNotifications(body).catch((e) => toast(e.message, 'error'));
  renderEmailSettings(body).catch((e) => ($('#email-body', body).textContent = e.message));
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

const EMAIL_NAMES = {
  welcome: 'Welcome (with "confirm your email")',
  verify: 'Confirm your email',
  reset: 'Reset your password',
  planActive: 'Plan is active',
  planEnded: 'Plan has ended',
  paymentFailed: 'Payment failed',
  action: 'Staff action (suspension)',
};

async function renderEmailSettings(body) {
  const e = await api('GET', '/api/admin/emails');
  $('#email-body', body).innerHTML = `
    <div class="row" style="flex-wrap:wrap;gap:8px">
      ${e.enabled ? '<span class="badge green">Sending is on</span>' : '<span class="badge red">Off: no email key set</span>'}
      ${e.brandedLinks ? '<span class="badge green">Branded password and confirm emails</span>' : '<span class="badge yellow">Password and confirm emails use the plain default</span>'}
    </div>
    <p class="hint" style="margin:10px 0">Sent from <b>${esc(e.from)}</b>. Replies go to ${esc(e.inboxes.support)} (billing emails: ${esc(e.inboxes.billing)}, creators: ${esc(e.inboxes.promo)}).</p>
    <div class="small muted" style="margin-bottom:6px">See every email:</div>
    <div class="row" style="flex-wrap:wrap;gap:6px">${e.previews.map((k) => `<a class="btn sm" href="/api/admin/emails/preview/${k}" target="_blank">${esc(EMAIL_NAMES[k] || k)}</a>`).join('')}</div>
    <div class="row" style="margin-top:12px;flex-wrap:wrap">
      <select id="email-test-kind" style="width:auto">${e.previews.map((k) => `<option value="${k}">${esc(EMAIL_NAMES[k] || k)}</option>`).join('')}</select>
      <button class="btn" id="email-test" ${e.enabled ? '' : 'disabled'}>Send it to me (${esc(state.me.user.email || 'no email')})</button>
    </div>`;
  $('#email-test', body).addEventListener('click', () =>
    attempt(async () => {
      const r = await api('POST', '/api/admin/emails/test', { kind: $('#email-test-kind', body).value });
      toast(`Sent to ${r.to}. Check your inbox (and spam).`);
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

