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

/** Customer accounts: Customer, or YouTuber (a customer with a creator badge). */
const CUSTOMER_ROLES = ['customer', 'youtuber'];

function isCustomer() {
  return isTeam() && CUSTOMER_ROLES.includes(state.me.user?.role);
}

const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', developer: 'Developer', staff: 'Support', youtuber: 'YouTuber', customer: 'Customer' };
const ROLE_BADGE = { owner: 'yellow', admin: 'green', developer: 'blue', staff: 'blue', youtuber: 'youtuber', customer: '' };
const ROLE_OPTIONS = (selected, roles = ['customer', 'youtuber', 'staff', 'developer', 'admin']) =>
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
  // Demo server read-only for certain actions
  if (s.isDemo && ['plugins', 'files', 'settings', 'manage'].includes(action)) return false;
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

function fmtMem(mb) {
  return mb >= 1024 ? `${+(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

// Icon helper (uses icons.js which is loaded before team.js)
function ic(name, cls = '') {
  return `<svg class="ic${cls ? ` ${cls}` : ''}" aria-hidden="true" focusable="false"><use href="/icons.svg#${name}"/></svg>`;
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
function birthYearField(defaultYear = '') {
  const now = new Date().getFullYear();
  const years = Array.from({ length: 100 }, (_, i) => now - i);
  return `<label class="field">Year you were born <select name="birthYear" required><option value="">Choose...</option>${years.map((y) => `<option value="${y}"${y === Number(defaultYear) ? ' selected' : ''}>${y}</option>`).join('')}</select></label>`;
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
  const inv = invite ? state.inviteInfo || {} : {};
  const titles = {
    login: ['Sign in', invite && inv.customer ? 'Sign in to the account you want to use. You can accept the invite right after.' : 'Welcome back! Sign in to manage your servers.'],
    signup: ['Create your account', 'Sign up, pick a plan and your Minecraft server is ready in about a minute.'],
    invite: inviteTitle(inv, 'Create your account or sign in.'),
    forgot: ['Forgot your password?', "Enter your account's email and we'll send you a link to choose a new password."],
    profile: ['Almost done', 'Pick a username for your Tree Host account.'],
  };
  const [title, sub] = titles[mode];
  const newAccount = ['signup', 'invite', 'profile'].includes(mode);
  // Pre-fill saved onboarding data if available (fallback for Firebase sync issues)
  const savedUsername = localStorage.getItem('th_onboarding_username') || '';
  const savedBirthYear = localStorage.getItem('th_onboarding_birth_year') || '';
  document.body.innerHTML = `
    <div class="auth-screen">
      <form class="auth-card stack" id="auth-form" autocomplete="on">
        <a href="/" class="brand" style="text-decoration:none;color:inherit"><div class="logo"></div><div><div class="brand-name">Tree Host</div><div class="brand-sub">Minecraft server hosting</div></div></a>
        ${addAccountBanner()}
        <h2>${esc(title)}</h2>
        <p class="muted" style="margin:0">${esc(sub)}</p>
        ${invite ? invitePerksHtml(inv) : ''}
        ${newAccount ? `<label class="field">Username <input type="text" name="username" required minlength="3" maxlength="32" autocomplete="username" value="${esc(state.pendingProfile?.suggested || savedUsername)}"></label>` : ''}
        ${mode !== 'profile' ? '<label class="field">Email <input type="email" name="email" required autocomplete="email"></label>' : ''}
        ${!['forgot', 'profile'].includes(mode) ? `<label class="field">Password <input type="password" name="password" required minlength="${mode === 'login' ? 1 : 8}" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}"></label>` : ''}
        ${
          (['signup', 'profile'].includes(mode) && (!invite || inv.customer)) || (mode === 'invite' && inv.customer)
            ? `${birthYearField(savedBirthYear)}<label class="check"><input type="checkbox" name="acceptTerms" required>
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
                : mode === 'invite' && inv.customer
                  ? '<p class="small muted" style="margin:0;text-align:center">Already have a Tree Host account? <a href="#" id="auth-invite-login">Sign in</a></p>'
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
    // Attribution: where the visitor came from (?ref=, kept in sessionStorage by site.js).
    let ref = null;
    try { ref = localStorage.getItem('th_ref') || sessionStorage.getItem('th_ref'); } catch {}
    return {
      username: f.username ? f.username.value.trim() : undefined,
      acceptTerms: f.acceptTerms ? f.acceptTerms.checked : undefined,
      birthYear: f.birthYear ? Number(f.birthYear.value) : undefined,
      invite: invite || undefined,
      ...(ref ? { ref } : {}),
    };
  };
  /** Hands the Firebase sign-in to Tree Host, which answers with a session (or asks for a username). */
  const finish = async (user, more = {}) => {
    const idToken = await user.getIdToken();
    const r = await withSecondFactor((code) => api('POST', '/api/auth/firebase', { idToken, signupCode: testerCode(), ...more, ...(code ? { code } : {}) }));
    if (r.needsProfile) {
      state.pendingProfile = { suggested: r.suggested || '' };
      // Check if we've saved the username locally (fallback for Firebase sync issues)
      const savedUsername = localStorage.getItem('th_onboarding_username');
      const savedBirthYear = localStorage.getItem('th_onboarding_birth_year');
      if (savedUsername && savedBirthYear) {
        // Auto-fill with saved data to help user
        state.pendingProfile.suggested = savedUsername;
        $('#auth-form').elements.username.value = savedUsername;
        if ($('#auth-form').elements.birthYear) {
          $('#auth-form').elements.birthYear.value = savedBirthYear;
        }
      }
      return showFirebaseAuth('profile');
    }
    // Clear saved onboarding data after successful profile completion
    try {
      localStorage.removeItem('th_onboarding_username');
      localStorage.removeItem('th_onboarding_birth_year');
    } catch {}
    // GAP-3: a founding signup lands straight on the purchase step (mockup G flow).
    location.href = r.created && !invite && foundingIntent() ? '/dashboard?welcome&plan=founding-lifetime' : r.created ? '/dashboard?welcome' : invite ? `/dashboard?invite=${encodeURIComponent(invite)}` : '/dashboard';
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
  $('#auth-invite-login')?.addEventListener('click', (e) => {
    e.preventDefault();
    showFirebaseAuth('login'); // keeps ?invite=, so the invite can be accepted after signing in
  });
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

/**
 * GAP-3: is a Founding Lifetime signup handoff in progress? The donate page sets
 * th_founding_intent when a signed-out visitor clicks its CTA, and links to
 * /dashboard?signup&plan=founding-lifetime. Either marker alone is enough.
 */
const foundingIntent = () => {
  try {
    return new URLSearchParams(location.search).get('plan') === 'founding-lifetime' || sessionStorage.getItem('th_founding_intent') === '1';
  } catch {
    return false;
  }
};

/**
 * GAP-3: live founding-spot count for the signup screen, from /api/plans.
 * Returns the founding plan row, or null when it's gone (sold out, or the API failed —
 * in both cases the signup falls back to its normal wording and the founding flow is dropped).
 */
async function foundingPlanRow() {
  if (!foundingIntent()) return null;
  try {
    const row = (await api('GET', '/api/plans')).plans.find((p) => p.founding);
    return row && !row.soldOut ? row : null;
  } catch {
    return null;
  }
}

function showAuth(forceMode) {
  if (state.me?.firebase) return showFirebaseAuth(forceMode === 'reset' ? 'login' : forceMode);
  const params = new URLSearchParams(location.search);
  const invite = params.get('invite');
  const reset = params.get('reset');
  const mode =
    forceMode ||
    (reset ? 'reset' : invite ? 'invite' : params.has('signup') && state.me?.allowSignup ? 'signup' : 'login');
  const inv = invite ? state.inviteInfo || {} : {};
  const founding = mode === 'signup' && foundingIntent();
  const titles = {
    login: ['Sign in', invite && inv.customer ? 'Sign in to the account you want to use. You can accept the invite right after.' : 'Welcome back! Sign in to manage your servers.'],
    invite: inviteTitle(inv, 'Create your account.'),
    signup: founding ? ['Create your account', 'Your Founding Lifetime spot is waiting.'] : ['Create your account', 'Sign up, pick a plan and your Minecraft server is ready in about a minute.'],
    forgot: ['Forgot your password?', "Enter your account's email and we'll send you a link to choose a new password."],
    reset: ['Choose a new password', 'Enter a new password for your account.'],
  };
  const [title, sub] = titles[mode];
  const field = (html) => html;
  // Pre-fill saved onboarding data if available (fallback for Firebase sync issues)
  const savedUsername = localStorage.getItem('th_onboarding_username') || '';
  const savedBirthYear = localStorage.getItem('th_onboarding_birth_year') || '';
  document.body.innerHTML = `
    <div class="auth-screen">
      <form class="auth-card stack" id="auth-form" autocomplete="on">
        <a href="/" class="brand" style="text-decoration:none;color:inherit"><div class="logo"></div><div><div class="brand-name">Tree Host</div><div class="brand-sub">Minecraft server hosting</div></div></a>
        ${addAccountBanner()}
        <h2>${esc(title)}</h2>
        <p class="muted" style="margin:0" id="auth-sub">${esc(sub)}</p>
        ${invite ? invitePerksHtml(inv) : ''}
        ${
          mode === 'login'
            ? '<label class="field">Username or email <input type="text" name="username" required autocomplete="username"></label>'
            : ['invite', 'signup'].includes(mode)
              ? `<label class="field">Username <input type="text" name="username" required autocomplete="username" minlength="3" maxlength="32" value="${esc(savedUsername)}"></label>`
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
          mode === 'signup' || (mode === 'invite' && inv.customer)
            ? `${birthYearField(savedBirthYear)}<label class="check"><input type="checkbox" name="acceptTerms" required>
                 <span>I agree to the <a href="/terms" target="_blank">Terms of Service</a> and <a href="/privacy" target="_blank">Privacy Policy</a></span></label>`
            : ''
        }
        <div id="auth-error" class="auth-error hidden"></div>
        <div id="auth-ok" class="auth-ok hidden"></div>
        <button class="btn primary block">${
          { login: 'Sign in', signup: founding ? 'Create account & finish purchase' : 'Create account', forgot: 'Send reset link', reset: 'Save new password', invite: 'Create account' }[mode]
        }</button>
        ${founding ? '<p class="small muted" style="margin:0;text-align:center" id="auth-founding-note">You\'ll confirm the $199 Founding Lifetime checkout on the next screen.</p>' : ''}
        ${mode === 'login' ? '<p class="small muted" style="margin:0;text-align:center"><a href="#" data-mode="forgot">Forgot your password?</a></p>' : ''}
        ${
          mode === 'login' && state.me?.allowSignup
            ? '<p class="small muted" style="margin:0;text-align:center">No account yet? <a href="#" data-mode="signup">Sign up</a></p>'
            : ['signup', 'forgot', 'reset'].includes(mode)
              ? '<p class="small muted" style="margin:0;text-align:center">Already have an account? <a href="#" data-mode="login">Sign in</a></p>'
              : mode === 'invite' && inv.customer
                ? '<p class="small muted" style="margin:0;text-align:center">Already have a Tree Host account? <a href="#" id="auth-invite-login">Sign in</a></p>'
                : ''
        }
      </form>
    </div>
    <div id="toasts" class="toasts"></div>`;
  // GAP-3: swap in the founding wording with the live spot count (mockup G). If the spots
  // sold out (or the fetch failed) while the visitor was travelling, the normal wording stays.
  if (founding) {
    foundingPlanRow().then((row) => {
      const sub = $('#auth-sub');
      const note = $('#auth-founding-note');
      if (!sub) return;
      if (row) sub.textContent = `Your Founding Lifetime spot is waiting — ${row.unitsLeft} of ${row.capTotal} left.`;
      else {
        sub.textContent = 'Sign up, pick a plan and your Minecraft server is ready in about a minute.';
        const go = $('#auth-form .btn.primary');
        if (go) go.textContent = 'Create account';
        if (note) note.remove();
      }
    });
  }
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
    if ((mode === 'signup' || (mode === 'invite' && inv.customer)) && ageBlocked()) return showError('Sorry, you need to be at least 13 to make a Tree Host account.');
    if (invite) body.invite = invite;
    if (reset) body.token = reset;
    if (mode === 'signup') body.signupCode = testerCode();
    // Attribution: where the visitor came from (?ref=, kept in sessionStorage by site.js).
    if (mode === 'signup') {
      try {
        const ref = localStorage.getItem('th_ref') || sessionStorage.getItem('th_ref');
        if (ref) body.ref = ref;
      } catch {}
    }
    const url = {
      login: '/api/auth/login',
      invite: '/api/auth/accept-invite',
      signup: '/api/auth/signup',
      forgot: '/api/auth/forgot',
      reset: '/api/auth/reset',
    }[mode];
    try {
      if (mode === 'login') await withSecondFactor((code) => api('POST', url, code ? { ...body, code } : body));
      else await api('POST', url, body);
      if (mode === 'forgot') {
        const ok = $('#auth-ok');
        ok.textContent = 'If an account uses that email, a reset link is on its way. Check your inbox (and spam).';
        ok.classList.remove('hidden');
        return;
      }
      // Save onboarding data locally as fallback for Firebase sync issues
      if (body.username) {
        try {
          localStorage.setItem('th_onboarding_username', body.username);
          if (body.birthYear) localStorage.setItem('th_onboarding_birth_year', body.birthYear);
        } catch {}
      }
      // Clear saved data after successful login (not signup)
      if (mode === 'login') {
        try {
          localStorage.removeItem('th_onboarding_username');
          localStorage.removeItem('th_onboarding_birth_year');
        } catch {}
      }
      // GAP-3: coming from the donate page's founding CTA, land straight on the purchase step.
      location.href = mode === 'signup' || mode === 'invite' ? (mode === 'signup' && founding ? '/dashboard?welcome&plan=founding-lifetime' : '/dashboard?welcome') : invite ? `/dashboard?invite=${encodeURIComponent(invite)}` : '/dashboard';
    } catch (err) {
      noteTooYoung(err);
      showError(err.message);
    }
  });
  const first = $('#auth-form input');
  if (first) first.focus();
  $('#auth-invite-login')?.addEventListener('click', (e) => {
    e.preventDefault();
    showAuth('login'); // keeps ?invite=, so the invite can be accepted after signing in
  });
  $$('[data-mode]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      history.replaceState(null, '', '/dashboard');
      showAuth(a.dataset.mode);
    }),
  );
}

// ---------- invite links ----------

/** Title and subtitle of the sign-up screen for an invite link. */
function inviteTitle(inv, staffSub) {
  if (inv.error) return ['Invite link', inv.error];
  if (inv.customer) return [`Join Tree Host as a ${inv.roleLabel}`, `${inv.invitedBy || 'The Tree Host team'} invited you${inv.note ? ` (${inv.note})` : ''}. Create your account, or sign in if you already have one.`];
  return [`Join the Tree Host team as ${inv.roleLabel || 'staff'}`, `You were invited to help run Tree Host. ${staffSub}`];
}

/** What a YouTuber invite comes with. */
function invitePerksHtml(inv) {
  if (!inv.customer || inv.error) return '';
  const items = [
    '<b>▶ YOUTUBER</b> badge above your head, in chat and in the player list on every Tree Host server',
    'Your listed servers are <b>featured</b> on the public server list',
    'A YouTuber badge on your Tree Host profile',
    ...(inv.plan ? [`A free <b>${esc(inv.plan.name)}</b> plan for ${inv.plan.months} month${inv.plan.months === 1 ? '' : 's'}`] : []),
  ];
  return `<div class="invite-perks"><div class="small muted">What you get</div><ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul></div>`;
}

/** Signed in and opened a YouTuber invite: accept it on this account. */
function showInviteClaim(token) {
  const inv = state.inviteInfo;
  const u = state.me.user;
  const staffAccount = !CUSTOMER_ROLES.includes(u.role);
  document.body.innerHTML = `
    <div class="auth-screen">
      <div class="auth-card stack">
        <a href="/" class="brand" style="text-decoration:none;color:inherit"><div class="logo"></div><div><div class="brand-name">Tree Host</div><div class="brand-sub">Minecraft server hosting</div></div></a>
        <h2>${esc(inviteTitle(inv)[0])}</h2>
        <p class="muted" style="margin:0">${esc(inv.invitedBy || 'The Tree Host team')} invited you${inv.note ? ` (${esc(inv.note)})` : ''}.
          You're signed in as <b>${esc(u.username)}</b>${u.role === inv.role ? `, which is already a ${esc(inv.roleLabel)} account` : ''}.</p>
        ${invitePerksHtml(inv)}
        ${staffAccount ? `<div class="warn-box">This is a staff account, so it can't become a ${esc(inv.roleLabel)}. Sign in with the account the invite is for.</div>` : ''}
        <div id="auth-error" class="auth-error hidden"></div>
        <button class="btn primary block" id="claim-go" ${staffAccount ? 'disabled' : ''}>Accept on ${esc(u.username)}</button>
        <p class="small muted" style="margin:0;text-align:center"><a href="/dashboard?add-account&invite=${encodeURIComponent(token)}">Use a different account</a> · <a href="/dashboard">Not now</a></p>
      </div>
    </div>
    <div id="toasts" class="toasts"></div>`;
  $('#claim-go').addEventListener('click', async () => {
    $('#claim-go').disabled = true;
    try {
      const r = await api('POST', '/api/auth/invite/claim', { invite: token });
      sessionStorage.setItem('th.toast', `Welcome! You're now a Tree Host ${r.roleLabel}.${inv.plan ? ' Your free plan is in Billing.' : ''}`);
      location.href = '/dashboard';
    } catch (e) {
      $('#auth-error').textContent = e.message;
      $('#auth-error').classList.remove('hidden');
      $('#claim-go').disabled = false;
    }
  });
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
      <button class="btn sm ${u.needs2fa ? 'needs-attention' : ''}" id="ub-security" title="Two-factor sign-in">${ic('lock')} Security${u.needs2fa ? ' <span class="nav-count">!</span>' : ''}</button>
      ${state.me.hosted ? '<button class="btn sm" id="ub-billing">' + ic('card') + ' Billing</button>' : ''}
      ${isTeam() && (hasPerm('console.access') || state.me.user.needs2fa) ? '<a class="btn sm" href="/admin">' + ic('tools') + ' Staff Console</a>' : ''}
      <button class="btn sm" id="ub-streamer" title="Hide emails and IP addresses while you're live (Ctrl+Shift+S)">● Streamer mode</button>
      <button class="btn sm" id="ub-switch" title="Switch to another account or add one">⇄ Switch</button>
      <button class="btn sm" id="ub-logout">Sign out</button>
    </div>`;
  $('#ub-account').addEventListener('click', openAccount);
  $('#ub-security').addEventListener('click', openSecurity);
  $('#ub-switch').addEventListener('click', () => openAccountSwitcher().catch((e) => toast(e.message, 'error')));
  $('#ub-streamer').addEventListener('click', () => window.streamerMode && window.streamerMode.toggle());
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

/**
 * The page-level container with this id (#modal-root, #toasts), created if it's missing. The sign-in screen replaces
 * the whole <body>, which removes them; without this, the 2FA code prompt crashed and staff couldn't sign in.
 */
function pageLayer(id, className = '') {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    if (className) el.className = className;
    document.body.appendChild(el);
  }
  return el;
}

function openModal(html) {
  const root = pageLayer('modal-root');
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

// ---------- two-factor sign-in (authenticator app codes, src/totp.js) ----------

/** Asks for the 6-digit code (or a recovery code) during sign-in. Resolves with the code, or null if cancelled. */
function askSecondFactor(message) {
  return new Promise((resolve) => {
    const { root, close } = openModal(`
      <h2>${ic('lock')} Two-factor sign-in</h2>
      <p class="muted" style="margin-top:-6px">${esc(message || 'Enter the 6-digit code from your authenticator app.')}</p>
      <form id="tf-form" class="stack">
        <input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="11" placeholder="123456" required style="font-size:22px;letter-spacing:4px;text-align:center">
        <p class="hint" style="margin:0">Lost your phone? Type one of your recovery codes instead.</p>
        <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Sign in</button></div>
      </form>`);
    let done = false;
    $('#tf-form', root).addEventListener('submit', (e) => {
      e.preventDefault();
      done = true;
      const code = e.target.elements.code.value.trim();
      close();
      resolve(code);
    });
    $$('[data-close]', root).forEach((b) => b.addEventListener('click', () => !done && resolve(null)));
    $('input', root).focus();
  });
}

/** Runs a sign-in request, asking for the 2FA code (and retrying) when the account has it on. */
async function withSecondFactor(send) {
  try {
    return await send(undefined);
  } catch (err) {
    if (err.code !== 'MFA_REQUIRED') throw err;
    let message;
    for (;;) {
      const code = await askSecondFactor(message);
      if (!code) throw Object.assign(new Error('Sign-in cancelled.'), { code: 'CANCELLED' });
      try {
        return await send(code);
      } catch (e2) {
        if (e2.code !== 'MFA_INVALID') throw e2;
        message = e2.message;
      }
    }
  }
}

/** Account → Security: two-factor sign-in. */
function openSecurity() {
  const { root } = openModal(`
    <h2>${ic('lock')} Security</h2>
    <p class="muted" style="margin-top:-6px">Keep your Tree Host account safe, even if someone learns your password.</p>
    <div class="card stack" id="sec-2fa"></div>
    <div class="card stack" id="sec-sessions"><h3>${ic('globe')} Signed-in browsers</h3><p class="muted" style="margin:0">Loading...</p></div>
    <div class="card stack">
      <h3>${ic('key')} Password</h3>
      <p class="hint" style="margin:0">${state.me.user.firebase ? 'You sign in with your email or Google: change your password from the sign-in page with <b>Forgot password</b>.' : 'Change it in <b>Account</b>. Use a long one you don\'t use anywhere else.'}</p>
    </div>
    <div class="modal-actions"><button class="btn" data-close>Close</button></div>`);
  renderTwoFactorCard($('#sec-2fa', root));
  renderSessionsCard($('#sec-sessions', root));
}

/** Account → Security → Signed-in browsers: where this account is signed in (server-side sessions), with the
 *  option to sign out of one browser or all the others. 30 days after you last used one, it expires by itself. */
async function renderSessionsCard(box) {
  if (!box) return;
  let data;
  try {
    data = await api('GET', '/api/auth/sessions');
  } catch {
    box.innerHTML = `<h3>${ic('globe')} Signed-in browsers</h3><p class="hint" style="margin:0">Sessions are only tracked in accounts mode.</p>`;
    return;
  }
  const row = (s) => `<div class="row" style="align-items:center;gap:8px">
      <span style="flex:1;min-width:0">
        <b>${s.current ? 'This browser' : 'Another browser'}</b>
        ${s.current ? '<span class="badge green">using now</span>' : ''}
        <span class="small muted" style="display:block">signed in ${new Date(s.createdAt).toLocaleDateString()}
          · last used ${new Date(s.lastSeen).toLocaleString()}</span>
      </span>
      ${s.current ? '' : `<button class="btn sm danger" data-srev="${esc(s.id)}">Revoke</button>`}
    </div>`;
  const list = data.sessions;
  const others = list.filter((s) => !s.current).length;
  box.innerHTML = `<h3>${ic('globe')} Signed-in browsers</h3>
    <p class="hint" style="margin:0">Your account stays signed in for <b>${data.maxAgeDays} days</b> after each use, on each browser
      (2FA is only asked for when you sign in, never while the session lasts). Revoke a browser you don't recognise.</p>
    <div class="stack" style="gap:10px">${list.map(row).join('') || '<span class="muted small">No active sessions.</span>'}</div>
    ${others ? '<div class="row"><button class="btn sm" id="sec-revoke-others">Sign out everywhere else</button></div>' : ''}`;
  $$('[data-srev]', box).forEach((b) =>
    b.addEventListener('click', () => confirm('Sign this browser out of your account?') &&
      attempt(async () => {
        await api('POST', '/api/auth/sessions/revoke', { id: b.dataset.srev });
        toast('Signed out there.');
        renderSessionsCard(box);
      })));
  if ($('#sec-revoke-others', box)) {
    $('#sec-revoke-others', box).addEventListener('click', () => confirm(`Sign out of your account on all ${others} other browser${others > 1 ? 's' : ''}?`) &&
      attempt(async () => {
        const r = await api('POST', '/api/auth/sessions/revoke', { all: true });
        toast(`Signed out of ${r.revoked} other browser${r.revoked === 1 ? '' : 's'}.`);
        renderSessionsCard(box);
      }));
  }
}

function renderTwoFactorCard(box) {
  if (!box) return;
  const u = state.me.user;
  const required = !!u.needs2fa || (u.twoFactor && isTeam() && hasPerm('console.access') && /^https:/.test(state.me.publicUrl || ''));
  box.innerHTML = u.twoFactor
    ? `<h3>${ic('lock')} Two-factor sign-in</h3>
       <p style="margin:0"><span class="badge green">${ic('check')} On</span> Signing in asks for a code from your authenticator app.</p>
       ${required ? '<p class="hint" style="margin:0">Staff accounts must keep it on.</p>' : '<div class="row"><button class="btn sm" id="tf-off">Turn off</button></div>'}`
    : `<h3>${ic('lock')} Two-factor sign-in</h3>
       <p class="hint" style="margin:0">Protects your account even if someone learns your password: signing in also asks for a 6-digit code
       from an app like Google Authenticator, Authy or 1Password.${u.needs2fa ? ' <b>Staff need it on to use the Staff Console.</b>' : ''}</p>
       <div class="row"><button class="btn primary sm" id="tf-on">Set up two-factor sign-in</button></div>`;
  if ($('#tf-on', box)) $('#tf-on', box).addEventListener('click', () => attempt(() => setUpTwoFactor(box)));
  if ($('#tf-off', box)) {
    $('#tf-off', box).addEventListener('click', () => attempt(async () => {
      const code = await askSecondFactor('Enter a current code to turn two-factor sign-in off.');
      if (!code) return;
      await api('POST', '/api/auth/2fa/disable', { code });
      state.me.user.twoFactor = false;
      toast('Two-factor sign-in is off.');
      openAccount();
    }));
  }
}

async function setUpTwoFactor(box) {
  const { secret, uri } = await api('POST', '/api/auth/2fa/setup');
  box.innerHTML = `<h3>${ic('lock')} Set up two-factor sign-in</h3>
    <div class="tf-setup">
      <div class="tf-qr">${typeof qrSvg === 'function' ? qrSvg(uri, 228) : ''}</div>
      <ol class="tf-steps">
        <li>Install an authenticator app on your phone if you don't have one: <b>Google Authenticator</b>, <b>Microsoft Authenticator</b>, <b>Authy</b> or <b>1Password</b>.</li>
        <li>In the app, add an account and <b>scan this QR code</b>.</li>
        <li>Type the 6-digit code the app shows below.</li>
      </ol>
    </div>
    <details class="tf-manual"><summary>Can't scan it?</summary>
      <p class="small" style="margin:6px 0">Choose <b>Enter a setup key</b> in the app, name it <b>Tree Host</b>, and type this key:</p>
      <code class="tf-key">${esc(secret.replace(/(.{4})/g, '$1 ').trim())}</code> <button type="button" class="btn sm" id="tf-copy">${ic('copy')} Copy</button>
      <br><a href="${esc(uri)}" class="small">On your phone? Open it in your authenticator app</a>
    </details>
    <form id="tf-enable" class="row"><input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" required style="max-width:160px;letter-spacing:3px">
      <button class="btn primary">Turn on</button></form>`;
  $('#tf-copy', box).addEventListener('click', () => navigator.clipboard.writeText(secret).then(() => toast('Key copied.')));
  $('#tf-enable', box).addEventListener('submit', (e) => {
    e.preventDefault();
    attempt(async () => {
      const { recovery } = await api('POST', '/api/auth/2fa/enable', { code: e.target.elements.code.value.trim() });
      state.me.user.twoFactor = true;
      delete state.me.user.needs2fa;
      box.innerHTML = `<h3>${ic('check')} Two-factor sign-in is on</h3>
        <p style="margin:0">Save these <b>recovery codes</b> somewhere safe (a password manager, or printed). Each one signs you in once
        if you lose your phone. They are only shown now.</p>
        <pre class="tf-codes">${recovery.map(esc).join('\n')}</pre>
        <div class="row"><button type="button" class="btn sm" id="tf-copy-codes">${ic('copy')} Copy codes</button>
        ${location.pathname.startsWith('/admin') ? '<button type="button" class="btn primary sm" id="tf-reload">Open the Staff Console</button>' : ''}</div>`;
      $('#tf-copy-codes', box).addEventListener('click', () => navigator.clipboard.writeText(recovery.join('\n')).then(() => toast('Recovery codes copied.')));
      if ($('#tf-reload', box)) $('#tf-reload', box).addEventListener('click', () => location.reload());
    });
  });
  $('input', box).focus();
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
    ${
      u.teamProfile
        ? `<form id="acc-team" class="card stack">
             <h3>${ic('users')} Team page</h3>
             <p class="hint" style="margin:0">You're on the public <a href="/team" target="_blank">Meet the team</a> page as <b>${esc(u.username)}</b>
               (${esc(u.roleLabel)}), with your Minecraft head as your picture${u.mcName ? '' : ' (add your Minecraft name above)'}.</p>
             <label class="check"><input type="checkbox" name="show" ${u.teamProfile.show !== false ? 'checked' : ''}> Show me on the team page</label>
             <label class="field">Title <span class="muted small">(optional, e.g. Founder, Lead developer)</span>
               <input type="text" name="title" maxlength="40" value="${esc(u.teamProfile.title || '')}"></label>
             <label class="field">About you <span class="muted small">(a sentence or two, 280 characters)</span>
               <textarea name="bio" maxlength="280" rows="3">${esc(u.teamProfile.bio || '')}</textarea></label>
             <div><button class="btn primary">Save</button></div>
           </form>`
        : ''
    }
    ${
      u.staffPrefs
        ? `<form id="acc-staff" class="card stack">
             <h3>${ic('shield')} In Minecraft</h3>
             <p class="hint" style="margin:0">How you show up when you join customers' servers as Tree Host staff${u.mcName ? ` (as <b>${esc(u.mcName)}</b>)` : ' (add your Minecraft name above first)'}.
               You can also change these in-game: <code>/thstaff</code> opens the staff menu.</p>
             <label class="check"><input type="checkbox" name="announce" ${u.staffPrefs.announce ? 'checked' : ''}> <span><b>Announce me when I join</b><br><span class="muted small">"A Tree Host staff member has joined your server". Off: a normal join message.</span></span></label>
             <label class="check"><input type="checkbox" name="badge" ${u.staffPrefs.badge ? 'checked' : ''}> <span><b>Badge above my head</b><br><span class="muted small">A floating ✔ STAFF tag that everyone sees, and you see it too in third person (F5). Needs Minecraft 1.19.4 or newer on the server.</span></span></label>
             <label class="check"><input type="checkbox" name="autoOp" ${u.staffPrefs.autoOp ? 'checked' : ''} ${u.staffPrefs.canOp ? '' : 'disabled'}> <span><b>Make me operator while I'm on a server</b><br><span class="muted small">${u.staffPrefs.canOp ? 'Taken away again when you leave. The owner sees everything you run.' : "Your role can't run commands on customers' servers, so you aren't made operator."}</span></span></label>
             <div><button class="btn primary">Save</button></div>
           </form>`
        : ''
    }
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
    <div class="card stack" id="acc-2fa"></div>
    <div class="modal-actions"><button class="btn" data-close>Close</button></div>`);
  renderTwoFactorCard($('#acc-2fa', root));

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
      state.me.user = { ...state.me.user, ...(await api('PATCH', '/api/auth/me', { mcName: f.mcName.value.trim(), ...(u.firebase ? {} : { email: f.email.value.trim() }) })) };
      renderUserBox();
      toast('Saved');
    });
  });
  if ($('#acc-team', root))
    $('#acc-team', root).addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target.elements;
      attempt(async () => {
        state.me.user.teamProfile = await api('PUT', '/api/account/team-profile', { show: f.show.checked, title: f.title.value, bio: f.bio.value });
        toast('Team page updated');
      });
    });
  if ($('#acc-staff', root))
    $('#acc-staff', root).addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target.elements;
      attempt(async () => {
        state.me.user.staffPrefs = await api('PUT', '/api/account/staff-prefs', { announce: f.announce.checked, badge: f.badge.checked, autoOp: f.autoOp.checked });
        toast('Saved. Servers pick it up within a few seconds.');
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
  if (state.me && state.me.staging) return toast("This is the staging site: servers and plans open at launch. Everything else works, so look around!");
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
  const { root, close } = openModal(`
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
  // Optional creator / viewer discount code: % off this first payment. A free-plan code belongs in
  // Billing's redeem box, not here; a dead code never blocks the purchase — checkout continues at full price.
  const codeRow = document.createElement('div');
  codeRow.className = 'row';
  codeRow.style.cssText = 'align-items:center;margin:10px 0 0';
  codeRow.innerHTML = `<input type="text" id="co-code" placeholder="Creator or discount code (optional)" autocomplete="off" style="max-width:260px;text-transform:uppercase">
    <span class="small muted" id="co-code-hint">A creator code takes % off your first payment.</span>`;
  form.insertBefore(codeRow, form.querySelector('.modal-actions'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const go = $('#co-go', root);
    const label = go.textContent;
    go.disabled = true;
    go.textContent = 'Opening checkout...';
    const consent = { renewal: plan.oneTime ? false : form.renewal.checked, adult: form.adult.checked, withdrawal: form.withdrawal.checked };
    const hint = $('#co-code-hint', root);
    const goCheckout = (viewerCode) =>
      api('POST', '/api/billing/checkout', { planId: plan.id, consent, viewerCode: viewerCode || undefined });
    const codeEntered = () => $('#co-code', root).value.trim();
    goCheckout(codeEntered())
      .catch((err) => {
        if (err.code === 'FREE_PLAN_CODE') {
          hint.textContent = `${err.message} Use the Have a code? box in Billing.`;
          hint.classList.add('code-warn');
          throw err;
        }
        if (err.code === 'DISCOUNT_CODE' && codeEntered()) {
          // Dead / expired / used-up code: say why and drop it. The checkout continues at full
          // price when the customer presses Pay again (a dead code never blocks the purchase).
          hint.textContent = `${err.message} Continuing at full price — press ${plan.oneTime ? 'Pay' : 'Subscribe'} again.`;
          hint.classList.add('code-warn');
          $('#co-code', root).value = '';
          go.disabled = false;
          go.textContent = label;
          return new Promise(() => {}); // stay open; the resubmit goes out without the code
        }
        throw err;
      })
      .then(async (r) => {
        if (r && r.demo) {
          // Demo mode activated instantly: read the sub back to confirm the discount the code bought.
          // Rendered through openModal so [data-close] is re-bound (the raw innerHTML swap loses the
          // handlers and would trap the customer in a modal they can't dismiss).
          const wanted = codeEntered().toUpperCase();
          const done = (disc) =>
            openModal(`
              <h2>You're in!</h2>
              <div class="checkout-summary">
                <div class="checkout-price">${money((disc ? disc.priceCents - disc.discountCents : plan.priceCents), plan.currency)}<span>${plan.oneTime ? ' once' : ' / month'}</span></div>
                ${
                  disc
                    ? `<p class="small" style="margin:6px 0 0"><span class="badge green">${esc(disc.promoCode)} — ${disc.percentOff}% off</span> your first payment: ${money(disc.priceCents, disc.currency)} → ${money(disc.priceCents - disc.discountCents, disc.currency)}</p>`
                    : ''
                }
              </div>
              <p class="small muted" style="margin:10px 0 0">${esc(plan.name)} is active. Create your server whenever you like.</p>
              <div class="modal-actions"><button class="btn primary" data-close>Create a server</button></div>`);
          toast('Plan activated (demo). Now create your server!');
          try {
            const b = await api('GET', '/api/billing');
            // Only a sub discounted by exactly the code entered counts: an earlier discount on the
            // account must never be presented as this purchase's price.
            const subs = (b.subscriptions || []).filter((x) => x.percentOff && wanted && x.promoCode === wanted);
            done(subs.sort((a, z) => z.createdAt - a.createdAt)[0] || null);
          } catch {
            done(null);
          }
        } else if (r && r.url) {
          if ($('#co-code', root).value.trim()) toast('Your discount code is applied to this checkout.');
          location.href = r.url;
        }
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
      <span class="small muted">Codes for a <b>free plan</b>. Buying a plan with a % off code? Enter it at checkout instead.</span>
    </form>`;
  $('#bill-code', root).addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('#bill-code-in', root).value.trim();
    if (!code) return;
    // attempt() toasts anything we rethrow, so a handled case resolves silently instead.
    attempt(async () => {
      let handled = false;
      try {
        const s = await api('POST', '/api/billing/redeem', { code });
        toast(`Code redeemed: free ${s.planName}${s.freeUntil ? ` until ${new Date(s.freeUntil).toLocaleDateString()}` : ''}`);
        close();
        openBilling();
      } catch (err) {
        if (err.code === 'DISCOUNT_CODE') {
          handled = true;
          // A percent-off code was entered in the free-plan box: it redeems at checkout, not here.
          toast('That was a discount code — enter it during checkout instead.', 'error');
          close();
          openPlans();
        }
        if (!handled) throw err;
      }
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
  const invitable = assignable.filter((r) => ['youtuber', 'staff', 'developer', 'admin'].includes(r));
  const canManage = hasPerm('users.manage');
  const canGrant = hasPerm('billing.manage');
  let filter = 'all';
  let q = '';
  const draw = () => {
    const list = all
      .filter((u) => (filter === 'all' ? true : filter === 'staff' ? !CUSTOMER_ROLES.includes(u.role) : filter === 'youtubers' ? u.role === 'youtuber' : CUSTOMER_ROLES.includes(u.role)))
      .filter((u) => !q || u.username.toLowerCase().includes(q) || (u.email || '').includes(q));
    $('#ppl-list', body).innerHTML = `<table><thead><tr><th>User</th><th>Role</th><th>Plans</th><th></th></tr></thead><tbody>${list
      .map(
        (u) => `<tr data-user-id="${esc(u.id)}">
          <td><b class="clickable-user" data-view-details="${esc(u.id)}">${esc(u.username)}</b>${u.lifetime ? ' <span class="badge lifetime-badge" title="Has a Lifetime plan">Lifetime</span>' : ''}${u.prioritySupport ? ' <span class="badge yellow" title="Priority support">Priority</span>' : ''}${restrictionBadge(u.restriction)}${u.linked && u.linked.length ? ` <span class="badge blue" title="Used on the same device as: ${esc(u.linked.map((l) => l.username).join(', '))}">${u.linked.length} linked</span>` : ''}
            <div class="small muted">${esc(u.email) || 'no email'} · joined ${new Date(u.createdAt).toLocaleDateString()}${u.lastLogin ? ` · last seen ${new Date(u.lastLogin).toLocaleDateString()}` : ''}</div></td>
          <td>${
            u.id !== me.id && canRoles && outranks(u)
              ? `<select data-role="${esc(u.id)}" style="width:auto">${ROLE_OPTIONS(u.role, assignable)}</select>`
              : `<span class="badge ${ROLE_BADGE[u.role] || ''}">${esc(u.roleLabel || ROLE_LABEL[u.role] || u.role)}</span>`
          }</td>
          <td class="small">${u.activePlans.length ? esc(u.activePlans.join(', ')) : '<span class="muted">none</span>'}${u.servers ? ` · ${u.servers} server${u.servers > 1 ? 's' : ''}` : ''}</td>
          <td class="actions-cell">${(() => {
            const isMe = u.id === me.id;
            const manage = canManage && outranks(u);
            const items = [
              `<button class="btn sm" data-view-details="${esc(u.id)}">${ic('info')} View Details</button>`,
              !isMe && hasPerm('promos.manage') ? `<button class="btn sm" data-code="${esc(u.id)}">${ic('ticket')} Give a free server code</button>` : '',
              !isMe && canGrant ? `<button class="btn sm" data-grant="${esc(u.id)}">Give a free plan now</button>` : '',
              manage
                ? u.firebase
                  ? `<button class="btn sm" data-reset="${esc(u.email)}">Send password reset email</button>`
                  : `<button class="btn sm" data-temp="${esc(u.id)}">Temporary password</button>`
                : '',
              manage ? `<button class="btn sm" data-change-email="${esc(u.id)}">Change Email</button>` : '',
              !isMe && hasPerm('messages.send') ? `<button class="btn sm" data-msg="${esc(u.id)}">${ic('mail')} Send message</button>` : '',
              !isMe && outranks(u) && canTakeAction('account') ? `<button class="btn sm" data-take="${esc(u.id)}">${ic('shield')} Take action (warn, suspend, ban, delete)</button>` : '',
              u.restriction && !u.restriction.actionId && hasPerm('moderation.act') && outranks(u) ? `<button class="btn sm" data-legacy="${esc(u.id)}">Lift old suspension</button>` : '',
            ].join('');
            if (isMe) return `<span class="muted small">you</span> ${items ? `<details class="menu"><summary class="btn sm">Manage</summary><div class="menu-body">${items}</div></details>` : ''}`;
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
    $$('.clickable-user', body).forEach((b) =>
      b.addEventListener('click', () => showUserDetails(b.dataset.viewDetails)),
    );
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
    $$('[data-view-details]', body).forEach((b) =>
      b.addEventListener('click', () => showUserDetails(b.dataset.viewDetails)),
    );
    $$('[data-change-email]', body).forEach((b) =>
      b.addEventListener('click', () => showChangeEmailModal(b.dataset.changeEmail)),
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
      <select id="ppl-filter" style="max-width:180px"><option value="all">Everyone</option><option value="customers">Customers</option><option value="youtubers">YouTubers</option><option value="staff">Support & admins</option></select>
      <span class="muted small">${all.length} account${all.length === 1 ? '' : 's'}</span>
    </div>
    <div id="ppl-list"></div>
    ${
      canRoles && invitable.length
        ? `<div class="card stack" style="margin-top:14px" id="inv-card">
      <h3>Invite people</h3>
      <p class="hint" style="margin:0">A one-time link that gives the account this role. <b>YouTuber</b> links also work for people who already have an account:
        they sign in and accept. See <b>Roles &amp; permissions</b> for what each role gets.</p>
      <div class="inv-grid">
        <label class="field">Role <select id="inv-role">${ROLE_OPTIONS(invitable.includes('youtuber') ? 'youtuber' : 'staff', invitable)}</select></label>
        <label class="field">Who it's for <span class="muted small" style="font-weight:400">(optional, only you see it)</span><input type="text" id="inv-note" maxlength="60" placeholder="e.g. Steve's channel, @CraftyFox"></label>
        <label class="field">Link works for <select id="inv-days"><option value="1">1 day</option><option value="3">3 days</option><option value="7" selected>7 days</option><option value="14">14 days</option><option value="30">30 days</option></select></label>
        ${canGrant ? `<label class="field inv-yt">Free plan <span class="muted small" style="font-weight:400">(YouTubers)</span><select id="inv-plan"><option value="">None</option>${plans.plans.map((pl) => `<option value="${esc(pl.id)}">${esc(pl.name)}</option>`).join('')}</select></label>
        <label class="field inv-yt">For <select id="inv-months">${[1, 2, 3, 6, 12].map((m) => `<option value="${m}" ${m === 3 ? 'selected' : ''}>${m} month${m === 1 ? '' : 's'}</option>`).join('')}</select></label>` : ''}
      </div>
      <div class="row"><button class="btn primary" id="inv-create">Create invite link</button></div>
      <div id="inv-link" class="hidden"></div>
      <div id="inv-pending"></div>
    </div>`
        : ''
    }`;
  $('#ppl-q', body).addEventListener('input', (e) => ((q = e.target.value.trim().toLowerCase()), draw()));
  $('#ppl-filter', body).addEventListener('change', (e) => ((filter = e.target.value), draw()));
  const drawPending = async () => {
    const el = $('#inv-pending', body);
    if (!el) return;
    const list = await api('GET', '/api/team/invites').catch(() => []);
    const planName = (id) => (plans.plans.find((x) => x.id === id) || { name: id }).name;
    el.innerHTML = list.length
      ? `<h4 style="margin:6px 0">Waiting to be used (${list.length})</h4><table><tbody>${list
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
          .map((i) => `<tr><td><span class="badge ${ROLE_BADGE[i.role] || ''}">${esc(ROLE_LABEL[i.role] || i.role)}</span> ${i.note ? esc(i.note) : '<span class="muted">no note</span>'}
              ${i.plan ? `<div class="small muted">with a free ${esc(planName(i.plan.planId))} plan for ${i.plan.months} month${i.plan.months === 1 ? '' : 's'}</div>` : ''}</td>
            <td class="small muted">by ${esc(i.createdBy)} · expires ${new Date(i.expires).toLocaleDateString()}</td>
            <td class="actions-cell"><button class="btn sm danger" data-revoke="${esc(i.id)}">Revoke</button></td></tr>`)
          .join('')}</tbody></table>`
      : '';
    $$('[data-revoke]', el).forEach((b) => b.addEventListener('click', () => attempt(async () => {
      await api('DELETE', `/api/team/invites/${encodeURIComponent(b.dataset.revoke)}`);
      toast('Invite revoked: the link no longer works.');
      drawPending();
    })));
  };
  const syncInviteForm = () => $$('.inv-yt', body).forEach((el) => el.classList.toggle('hidden', $('#inv-role', body).value !== 'youtuber'));
  if ($('#inv-role', body)) {
    $('#inv-role', body).addEventListener('change', syncInviteForm);
    syncInviteForm();
    drawPending();
  }
  if ($('#inv-create', body)) $('#inv-create', body).addEventListener('click', () =>
    attempt(async () => {
      const role = $('#inv-role', body).value;
      const planId = role === 'youtuber' && $('#inv-plan', body) ? $('#inv-plan', body).value : '';
      const { link, expires } = await api('POST', '/api/team/invites', {
        role,
        note: $('#inv-note', body).value.trim(),
        days: Number($('#inv-days', body).value),
        ...(planId ? { planId, months: Number($('#inv-months', body).value) } : {}),
      });
      const box = $('#inv-link', body);
      box.classList.remove('hidden');
      box.innerHTML = `<div class="token-box"><div class="small">${esc(ROLE_LABEL[role] || role)} invite link (one use, until ${new Date(expires).toLocaleDateString()}). Click to copy:</div>
        <code class="copy" data-copy="${esc(link)}" title="Click to copy">${esc(link)}</code></div>`;
      $('[data-copy]', box).addEventListener('click', (ev) => navigator.clipboard.writeText(ev.target.dataset.copy).then(() => toast('Invite link copied')));
      $('#inv-note', body).value = '';
      drawPending();
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
    <p class="hint small">Unpaid plans keep running for ${d.graceDays} days, then the server is stopped. Servers of ended plans are deleted after ${d.deleteAfterDays} days.</p>
    <div class="card stack" id="fund-card"><h3>${ic('sprout')} Launch fund (donations)</h3><div class="muted">Loading...</div></div>`;
  adminDonations($('#fund-card', body)).catch((e) => ($('#fund-card', body).innerHTML = `<div class="warn-box">${esc(e.message)}</div>`));
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

/** One editable line of the donate page's cost receipt. */
function costRow(c = {}) {
  const opt = (list, cur) => list.map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('');
  return `<tr data-id="${esc(c.id || '')}">
    <td><input type="text" data-k="name" maxlength="60" value="${esc(c.name || '')}" placeholder="Domain name" style="min-width:150px"></td>
    <td><input type="text" data-k="detail" maxlength="160" value="${esc(c.detail || '')}" placeholder="treehost.online, renewed yearly" style="min-width:220px"></td>
    <td><input type="number" data-k="amount" min="0" step="0.01" value="${c.cents !== undefined ? +(c.cents / 100).toFixed(2) : ''}" style="width:90px"></td>
    <td><select data-k="period">${opt([['month', 'Monthly'], ['year', 'Yearly'], ['once', 'One-time']], c.period)}</select></td>
    <td><select data-k="status">${opt([['unpaid', 'Not paid yet'], ['paid', 'Paid']], c.status)}</select></td>
    <td><button type="button" class="btn sm danger" data-crm>Remove</button></td></tr>`;
}

/** The donate page's goal, every donation, and hiding a public message that shouldn't be there. */
async function adminDonations(card) {
  const d = await api('GET', '/api/admin/donations');
  const g = d.goal || {};
  const dollars = (c) => (c ? +(c / 100).toFixed(2) : '');
  const manage = hasPerm('billing.manage');
  card.innerHTML = `
    <h3>${ic('sprout')} Launch fund (donations)</h3>
    <p class="hint" style="margin:0">Shown on <a href="/donate" target="_blank">/donate</a>: <b>${money(d.raisedCents, d.currency)}</b>${d.targetCents ? ` of ${money(d.targetCents, d.currency)}` : ''} from ${d.count} supporter${d.count === 1 ? '' : 's'}.
      Donations made outside the website (the old Stripe link, cash, Ko-fi) can be added below so the total is right.</p>
    ${
      manage
        ? `<form id="goal-form" class="row" style="flex-wrap:wrap;align-items:flex-end">
             <label class="small">Name<br><input type="text" name="title" maxlength="60" value="${esc(g.title || 'Launch fund')}" style="width:170px"></label>
             <label class="small">Goal ($)<br><input type="number" name="target" min="0" step="1" value="${dollars(g.targetCents)}" placeholder="none" style="width:110px"></label>
             <label class="small">Raised elsewhere ($)<br><input type="number" name="extra" min="0" step="0.01" value="${dollars(g.extraCents)}" placeholder="0" style="width:130px"></label>
             <label class="small">Supporters elsewhere<br><input type="number" name="extraCount" min="0" step="1" value="${g.extraCount || ''}" placeholder="0" style="width:120px"></label>
             <button class="btn primary">Save</button></form>`
        : ''
    }
    <div class="stack" style="gap:8px">
      <h4 style="margin:6px 0 0">Costs on the donate page</h4>
      <p class="hint" style="margin:0">Shown as a receipt on /donate, with what's paid and how far donations go (one-time costs first, then months of running costs).
        Keep it honest and current: the date updates when you save.</p>
      <div style="overflow-x:auto"><table class="plans-edit"><thead><tr><th>Cost</th><th>What it's for</th><th>Amount ($)</th><th>How often</th><th>Status</th><th></th></tr></thead>
        <tbody id="cost-rows">${(d.costs.items || []).map(costRow).join('')}</tbody></table></div>
      ${manage ? '<div class="row"><button class="btn sm" id="cost-add">+ Add cost</button><button class="btn primary" id="cost-save">Save costs</button></div>' : ''}
    </div>
    ${
      d.donations.length
        ? `<div style="overflow-x:auto"><table><thead><tr><th>When</th><th>Amount</th><th>Name</th><th>Message</th><th>Status</th><th></th></tr></thead><tbody>${d.donations
            .map((x) => `<tr>
              <td class="small">${new Date(x.paidAt || x.createdAt).toLocaleString()}</td>
              <td>${money(x.amountCents, x.currency)}</td>
              <td>${esc(x.name || '')}${x.username ? ` <span class="muted small">(${esc(x.username)})</span>` : ''}${x.public ? '' : ' <span class="muted small">private</span>'}</td>
              <td class="small">${x.message ? (x.hidden ? `<s class="muted">${esc(x.message)}</s>` : esc(x.message)) : ''}</td>
              <td><span class="badge ${x.status === 'paid' ? 'green' : ''}">${esc(x.status)}</span></td>
              <td class="actions-cell">${manage && x.public && x.status === 'paid' ? `<button class="btn sm" data-dhide="${esc(x.id)}" data-h="${x.hidden ? '' : '1'}">${x.hidden ? 'Show on page' : 'Hide from page'}</button>` : ''}</td></tr>`)
            .join('')}</tbody></table></div>`
        : '<p class="muted" style="margin:0">No donations through the website yet.</p>'
    }`;
  const bindCostRm = () => $$('[data-crm]', card).forEach((b) => (b.onclick = () => b.closest('tr').remove()));
  bindCostRm();
  if ($('#cost-add', card))
    $('#cost-add', card).addEventListener('click', () => {
      $('#cost-rows', card).insertAdjacentHTML('beforeend', costRow({ period: 'month', status: 'unpaid' }));
      bindCostRm();
    });
  if ($('#cost-save', card))
    $('#cost-save', card).addEventListener('click', () =>
      attempt(async () => {
        const items = $$('#cost-rows tr', card).map((tr) => {
          const v = (k) => $(`[data-k="${k}"]`, tr).value;
          return { id: tr.dataset.id || '', name: v('name').trim(), detail: v('detail').trim(), cents: Math.round(Number(v('amount')) * 100), period: v('period'), status: v('status') };
        });
        await api('PUT', '/api/admin/costs', { items });
        toast('Costs saved');
        adminDonations(card);
      }),
    );
  const form = $('#goal-form', card);
  if (form)
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = form.elements;
      attempt(async () => {
        await api('PUT', '/api/admin/donation-goal', {
          title: f.title.value,
          targetCents: Math.round(Number(f.target.value) * 100),
          extraCents: Math.round(Number(f.extra.value) * 100),
          extraCount: Number(f.extraCount.value),
        });
        toast('Launch fund saved');
        adminDonations(card);
      });
    });
  $$('[data-dhide]', card).forEach((b) =>
    b.addEventListener('click', () =>
      attempt(async () => {
        await api('PUT', `/api/admin/donations/${b.dataset.dhide}`, { hidden: !!b.dataset.h });
        adminDonations(card);
      }),
    ),
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

// ---------- Creators tab (src/creators.js; mockups C–F) ----------

const CREATOR_PAYOUT_METHODS = [
  ['paypal', 'PayPal'],
  ['iban', 'IBAN / bank transfer'],
  ['giftcard', 'Gift card'],
];

function creatorBalanceHtml(c) {
  if (c.stats.balanceCents >= 0) return money(c.stats.balanceCents);
  return `<span style="color:#f08a84;font-weight:700">${money(c.stats.balanceCents)}</span><div class="small muted">net against future commission</div>`;
}

function creatorTierBadge(tier) {
  return `<span class="badge ${tier.id === 'gold' ? 'yellow' : tier.id === 'silver' ? 'blue' : ''}">${esc(tier.label)} ${tier.percent}%</span>`;
}

async function adminCreators(body, sub) {
  if (sub) return creatorLedger(body, sub);
  const d = await api('GET', '/api/admin/creators');
  body.innerHTML = `
    <div class="row" style="justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px">
      <p class="muted" style="margin:0 0 10px;max-width:620px">The creator (affiliate) program. A creator shares their personal link — <code>${esc((state.me.publicUrl || location.origin).replace(/^https?:\/\//, ''))}/CODE</code> — and earns a % of every referred customer's first payment. An optional viewer discount code gives their audience % off at checkout.</p>
      <button class="btn primary" id="cr-add">+ Add creator</button>
    </div>
    <div class="card" style="margin-bottom:12px">
      <div class="row" style="flex-wrap:wrap;gap:10px;align-items:flex-end">
        <label class="field" style="min-width:230px">Share links
          <select id="cr-share-pick" style="width:auto;min-width:230px">
            <option value="">Pick a creator…</option>
            ${d.creators.filter((c) => c.status === 'active').map((c) => `<option value="${esc(c.code)}">${esc(c.name)}${c.handle ? ` (${esc(c.handle)})` : ''}</option>`).join('')}
          </select>
        </label>
        <label class="field" style="flex:1;min-width:260px">Referral link
          <input type="text" id="cr-share-link" readonly value="" placeholder="Pick a creator to see their link">
        </label>
        <button class="btn sm" id="cr-share-copylink" disabled>Copy link</button>
        <label class="field" style="flex:1;min-width:200px">Viewer discount code
          <input type="text" id="cr-share-code" readonly value="" placeholder="">
          <span class="small muted" id="cr-share-code-hint"></span>
        </label>
        <button class="btn sm" id="cr-share-copycode" disabled>Copy code</button>
        <button class="btn sm" id="cr-share-add">+ Add creator</button>
      </div>
    </div>
    <div class="stat-row">
      <div class="stat"><div class="stat-num">${d.totals.creators}</div><div class="stat-label">creators</div></div>
      <div class="stat"><div class="stat-num">${d.totals.signups}</div><div class="stat-label">referred signups</div></div>
      <div class="stat"><div class="stat-num">${d.totals.payingReferrals}</div><div class="stat-label">paying referrals</div></div>
      <div class="stat"><div class="stat-num">${money(d.totals.earnedCents)}</div><div class="stat-label">commission earned (all time)</div></div>
      <div class="stat"><div class="stat-num">${money(d.totals.balanceCents)}</div><div class="stat-label">unpaid balances</div></div>
    </div>
    <div class="card" style="overflow-x:auto">
      ${
        d.creators.length
          ? `<table>
        <thead><tr><th>Creator</th><th>Code</th><th>Tier</th><th>Signups</th><th>Paying</th><th>Earned</th><th>Balance</th><th>Viewer code</th><th>Status</th><th></th></tr></thead>
        <tbody>${d.creators
          .map(
            (c) => `<tr>
          <td><b>${esc(c.name)}</b>${c.handle ? `<div class="small muted">${esc(c.handle)}${c.platform ? ` · ${esc(c.platform)}` : ''}</div>` : ''}</td>
          <td><code class="copy" data-copy="${esc(c.code)}" title="Click to copy the code">${esc(c.code)}</code><div><a class="small" href="#" data-link="${esc(c.code)}">copy link</a></div></td>
          <td>${creatorTierBadge(c.tier)}</td>
          <td>${c.stats.signups}</td>
          <td>${c.stats.payingReferrals}</td>
          <td>${money(c.stats.earnedCents)}</td>
          <td>${creatorBalanceHtml(c)}</td>
          <td class="small">${c.viewerCode ? `<code class="copy" data-copy="${esc(c.viewerCode.code)}" title="Click to copy">${esc(c.viewerCode.code)}</code><div class="muted">${c.viewerCode.percentOff}% off${c.viewerCode.active ? '' : ' · paused'}</div>` : '<span class="muted">-</span>'}</td>
          <td>${c.status === 'active' ? '<span class="badge green">active</span>' : '<span class="badge red">disabled</span>'}</td>
          <td class="actions-cell" style="white-space:nowrap">
            <button class="btn sm" data-ledger="${esc(c.code)}">Ledger</button>
            <button class="btn sm" data-edit="${esc(c.code)}">Edit</button>
            <button class="btn sm" data-payout="${esc(c.code)}">Mark payout</button>
            <button class="btn sm danger" data-toggle="${esc(c.code)}" data-disable="${c.status === 'active' ? 1 : 0}">${c.status === 'active' ? 'Disable' : 'Enable'}</button>
          </td>
        </tr>`,
          )
          .join('')}</tbody></table>`
          : '<p class="muted" style="margin:0">No creators yet. Add the first one and send them their link.</p>'
      }
    </div>
    <p class="hint small" style="margin-top:8px">Balances are real money owed — payouts are sent by hand (PayPal, bank transfer or gift card) and marked here, which is what keeps the ledger and the audit log truthful. A negative balance means a refund clawed back more than was left after a payout; it clears against future commission.</p>`;
  $('#cr-add', body).addEventListener('click', () => creatorModal(null, () => adminCreators(body)));
  $('#cr-share-add', body).addEventListener('click', () => creatorModal(null, () => adminCreators(body)));
  // Share links picker: selecting a creator fills their path-style referral link
  // ({publicUrl or origin}/CODE — same shape as the deploy endpoint and what creators
  // paste into YouTube descriptions) and their viewer discount code, if any.
  const base = state.me.publicUrl || location.origin;
  const shareLink = $('#cr-share-link', body);
  const shareCode = $('#cr-share-code', body);
  const codeHint = $('#cr-share-code-hint', body);
  const pick = $('#cr-share-pick', body);
  const copyBtns = [$('#cr-share-copylink', body), $('#cr-share-copycode', body)];
  const syncShare = () => {
    const c = d.creators.find((x) => x.code === pick.value);
    shareLink.value = c ? `${base}/${c.code}` : '';
    shareCode.value = c?.viewerCode?.code || '';
    codeHint.textContent = c ? (c.viewerCode ? `${c.viewerCode.percentOff}% off${c.viewerCode.active ? '' : ' · paused'}` : '') : '';
    shareCode.placeholder = c && !c.viewerCode ? 'No viewer code yet' : '';
    copyBtns[0].disabled = !c;
    copyBtns[1].disabled = !(c && c.viewerCode);
  };
  pick.addEventListener('change', syncShare);
  copyBtns[0].addEventListener('click', () => navigator.clipboard.writeText(shareLink.value).then(() => toast('Referral link copied')));
  copyBtns[1].addEventListener('click', () => navigator.clipboard.writeText(shareCode.value).then(() => toast('Viewer code copied')));
  $$('[data-copy]', body).forEach((el) => el.addEventListener('click', () => navigator.clipboard.writeText(el.dataset.copy).then(() => toast('Copied'))));
  $$('[data-link]', body).forEach((el) =>
    el.addEventListener('click', (e) => {
      e.preventDefault();
      navigator.clipboard.writeText(`${state.me.publicUrl || location.origin}/${el.dataset.link}`).then(() => toast('Referral link copied'));
    }),
  );
  $$('[data-ledger]', body).forEach((b) => b.addEventListener('click', () => (location.hash = `#creators/${b.dataset.ledger}`)));
  $$('[data-edit]', body).forEach((b) => b.addEventListener('click', () => creatorModal(d.creators.find((c) => c.code === b.dataset.edit), () => adminCreators(body))));
  $$('[data-payout]', body).forEach((b) => b.addEventListener('click', () => payoutModal(d.creators.find((c) => c.code === b.dataset.payout), () => adminCreators(body))));
  $$('[data-toggle]', body).forEach((b) =>
    b.addEventListener('click', () => {
      const off = b.dataset.disable === '1';
      if (off && !confirm(`Disable ${b.dataset.toggle}? Their link stops attributing new signups and their viewer code pauses. Stats, ledger and balance are kept, and payouts stay possible.`)) return;
      attempt(async () => {
        const row = await api('DELETE', `/api/admin/creators/${encodeURIComponent(b.dataset.toggle)}`);
        toast(`Creator ${row.code} ${row.status === 'active' ? 're-enabled' : 'disabled'}`);
        adminCreators(body);
      });
    }),
  );
}

/** Add/Edit creator modal (mockup D). `existing` null = create; otherwise edit (code immutable). */
function creatorModal(existing, done) {
  const editing = !!existing;
  const { root, close } = openModal(`
    <h2>${editing ? 'Edit creator' : 'Add creator'}</h2>
    <p class="muted" style="margin-top:-6px">The code is what their audience puts in <code>?ref=</code>. Keep it short and easy to say out loud in videos.</p>
    <form id="cr-form" class="stack">
      <label class="field">Name<input type="text" name="name" maxlength="40" value="${esc(existing?.name || '')}" placeholder="Alex" required></label>
      <div class="row" style="gap:10px">
        <label class="field" style="flex:1">Channel handle<input type="text" name="handle" maxlength="40" value="${esc(existing?.handle || '')}" placeholder="@sparkbuilds"></label>
        <label class="field" style="flex:1">Platform<input type="text" name="platform" maxlength="20" value="${esc(existing?.platform || '')}" placeholder="YouTube"></label>
      </div>
      <label class="field">Creator code
        <input type="text" name="code" maxlength="32" value="${esc(existing?.code || '')}" placeholder="SPARK" style="text-transform:uppercase;max-width:220px" ${editing ? 'readonly class="readonly"' : ''}>
        <span class="small muted">${editing ? 'The code never changes — renaming it would break attribution on every link already shared.' : 'A–Z, 0–9 and dashes, 3–32 characters, unique (a collision with a channel name or promo code is rejected).'}</span>
      </label>
      <div class="row" style="gap:10px;align-items:flex-end">
        <label class="field" style="flex:1">Viewer discount code ${editing && existing.viewerCode ? `<span class="small muted">(exists: ${esc(existing.viewerCode.code)})</span>` : '<span class="small muted">(optional)</span>'}
          <input type="text" name="vcode" maxlength="32" value="${esc(existing?.viewerCode?.code || '')}" placeholder="SPARK10" style="text-transform:uppercase" ${editing && existing.viewerCode ? 'readonly' : ''}>
        </label>
        <label class="field" style="width:110px">% off<input type="number" name="pct" min="1" max="99" value="${existing?.viewerCode?.percentOff ?? 10}" style="width:100px"></label>
      </div>
      ${editing && existing.viewerCode ? `<label class="row small" style="gap:6px;align-items:center"><input type="checkbox" name="vactive" ${existing.viewerCode.active ? 'checked' : ''}> viewer code active</label>` : ''}
      <label class="field">Internal note <span class="small muted">(only staff see this)</span><input type="text" name="note" maxlength="200" value="${esc(existing?.note || '')}" placeholder="SMP series starting March — expect a spike"></label>
      <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">${editing ? 'Save changes' : 'Create creator'}</button></div>
    </form>`);
  $('#cr-form', root).addEventListener('submit', (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const bodyReq = {
      name: f.name,
      handle: f.handle,
      platform: f.platform,
      note: f.note,
    };
    if (!editing) {
      bodyReq.code = f.code;
      if (f.vcode.trim()) bodyReq.viewerCode = { code: f.vcode.trim(), percentOff: Number(f.pct) };
    } else if (existing.viewerCode) {
      bodyReq.viewerCode = { percentOff: Number(f.pct), active: !!f.vactive };
    } else if (f.vcode.trim()) {
      bodyReq.viewerCode = { code: f.vcode.trim(), percentOff: Number(f.pct) };
    }
    attempt(async () => {
      const row = editing
        ? await api('PUT', `/api/admin/creators/${encodeURIComponent(existing.code)}`, bodyReq)
        : await api('POST', '/api/admin/creators', bodyReq);
      toast(`Creator ${row.code} ${editing ? 'updated' : 'created'}${row.viewerCode ? ` — viewer code ${row.viewerCode.code} at ${row.viewerCode.percentOff}% off` : ''}`);
      close();
      done();
    });
  });
}

/** Mark-payout modal (mockup E). Amount is capped at the balance with a live "after saving" preview. */
function payoutModal(creator, done) {
  const bal = creator.stats.balanceCents;
  const { root, close } = openModal(`
    <h2>Mark payout · ${esc(creator.name)}</h2>
    <p class="muted" style="margin-top:-6px">Record a payout you sent by hand. This is the audit trail: who was paid, how much, how.</p>
    <form id="pay-form" class="stack">
      <label class="field">Amount (USD) <span class="small muted">balance is ${money(bal)}${bal < 0 ? ' — negative, clear it against future commission first' : ''}</span>
        <input type="number" name="amount" min="0" step="0.01" value="${(Math.max(0, bal) / 100).toFixed(2)}" style="max-width:180px">
      </label>
      <div class="field">Method
        <div class="row" style="gap:6px" id="pay-methods">
          ${CREATOR_PAYOUT_METHODS.map(([v, l], i) => `<label class="row" style="gap:5px;align-items:center"><input type="radio" name="method" value="${v}" ${i === 0 ? 'checked' : ''}> ${l}</label>`).join('')}
        </div>
      </div>
      <label class="field">Reference <span class="small muted">(PayPal transaction id, IBAN last 4, …)</span><input type="text" name="reference" maxlength="100" placeholder="PAYID-8KJ2194A" required></label>
      <label class="field">Note (optional)<input type="text" name="note" maxlength="200" placeholder="March earnings, paid in full"></label>
      <div class="hint small" id="pay-preview"></div>
      <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save payout</button></div>
    </form>`);
  const amountEl = $('[name=amount]', root);
  const preview = $('#pay-preview', root);
  const update = () => {
    const cents = Math.round(parseFloat(amountEl.value || '0') * 100);
    const after = bal - cents;
    preview.innerHTML = cents > bal
      ? `<span style="color:#f08a84">That is more than the ${money(bal)} balance. Payouts are capped at the balance.</span>`
      : `After saving: balance <b>${money(after)}</b> · the ledger gains a payout entry of <b>-${money(cents)}</b>.`;
  };
  amountEl.addEventListener('input', update);
  update();
  $('#pay-form', root).addEventListener('submit', (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const cents = Math.round(parseFloat(f.amount || '0') * 100);
    if (!(cents > 0)) return toast('Enter an amount above zero.', 'error');
    if (cents > bal) return toast(`That is more than the creator's balance of ${money(bal)}.`, 'error');
    attempt(async () => {
      const row = await api('POST', `/api/admin/creators/${encodeURIComponent(creator.code)}/payout`, {
        amountCents: cents,
        method: f.method,
        reference: f.reference,
        note: f.note,
      });
      toast(`Marked a ${money(cents)} payout to ${row.code} — balance now ${money(row.stats.balanceCents)}`);
      close();
      done();
    });
  });
}

/** Per-creator detail view (mockup F): stat row, funnel bars, ledger table newest-first, Load more cursor. */
async function creatorLedger(body, code, before) {
  const d = await api('GET', `/api/admin/creators/${encodeURIComponent(code)}/ledger${before ? `?before=${encodeURIComponent(before)}` : ''}`);
  let list = body.querySelector('.cr-ledger-rows');
  if (!list) {
    body.innerHTML = `
      <p><a href="#creators">← Back to all creators</a></p>
      <h2 style="margin:6px 0 2px">${esc(d.creator.code)}</h2>
      <div class="stat-row" style="margin-top:10px">
        <div class="stat"><div class="stat-num" data-fv="linkPageviews">0</div><div class="stat-label">link pageviews</div></div>
        <div class="stat"><div class="stat-num" data-fv="signups">0</div><div class="stat-label">signups</div></div>
        <div class="stat"><div class="stat-num" data-fv="firstPayments">0</div><div class="stat-label">paying referrals</div></div>
        <div class="stat"><div class="stat-num">${money(d.funnel.earnedCents)}</div><div class="stat-label">earned (all time)</div></div>
        <div class="stat"><div class="stat-num">${money(d.creator.balanceCents)}</div><div class="stat-label">balance owed</div></div>
      </div>
      <div class="card">
        <h3 style="margin-bottom:8px">Funnel — link → signup → first payment</h3>
        <div id="cr-funnel"></div>
        <p class="hint small" style="margin:8px 0 0">Pageviews and signups are attributed by the <code>${esc(d.creator.code)}</code> ref parameter; a referral counts as paying on their first payment.</p>
      </div>
      <div class="card" style="margin-top:12px">
        <h3 style="margin-bottom:8px">Ledger</h3>
        <table>
          <thead><tr><th>When</th><th>Type</th><th>Detail</th><th>Amount</th><th>Balance after</th></tr></thead>
          <tbody class="cr-ledger-rows"></tbody>
        </table>
        <p class="cr-more hidden" style="margin:10px 0 0"><button class="btn sm" id="cr-more">Load more</button></p>
      </div>`;
    const fx = (v) => (v > 0 ? Math.max(2, Math.round((v / Math.max(1, d.funnel.linkPageviews)) * 100)) : 0);
    const steps = [
      ['link pageviews', d.funnel.linkPageviews, ''],
      ['signups', d.funnel.signups, 'blue'],
      ['first payments', d.funnel.firstPayments, 'green'],
    ];
    const maxV = Math.max(1, d.funnel.linkPageviews);
    $('#cr-funnel', body).innerHTML = steps
      .map(([label, v, cls]) => `<div class="row" style="gap:8px;align-items:center;margin:4px 0">
        <span class="small" style="width:120px">${label}</span>
        <div style="flex:1;background:var(--panel-2);border:1px solid var(--border);border-radius:6px;overflow:hidden"><div class="${cls}" style="height:16px;width:${Math.max(1, Math.round((v / maxV) * 100))}%;background:${cls === 'green' ? 'rgba(52,199,123,.6)' : cls === 'blue' ? 'rgba(74,158,255,.6)' : 'var(--muted)'}"></div></div>
        <b class="small" style="width:40px;text-align:right">${v}</b></div>`)
      .join('');
    list = body.querySelector('.cr-ledger-rows');
  }
  list.insertAdjacentHTML(
    'beforeend',
    d.entries
      .map((e) => {
        const det = e.type === 'commission'
          ? `${esc(e.detail.username || 'a customer')} · ${esc(e.detail.planName || 'a plan')}${e.detail.discountCents ? ` (−${money(e.detail.discountCents)} discount)` : ''} · ${e.detail.percent}% ${esc(e.detail.tierAtPost || '')}`
          : e.type === 'clawback'
            ? `commission refunded — the ${e.detail.percent ? `${e.detail.percent}% ${esc(e.detail.tierAtPost || '')} commission` : 'commission'} for a ${esc(e.detail.planName || 'referred payment')} was reversed`
            : `${esc({ paypal: 'PayPal', iban: 'bank transfer', giftcard: 'gift card', other: 'other' }[e.detail.method] || e.detail.method || 'payout')} · ref ${esc(e.detail.reference || '-')}${e.detail.note ? ` · ${esc(e.detail.note)}` : ''}`;
        return `<tr>
          <td class="small">${new Date(e.at).toLocaleString()}</td>
          <td><span class="badge ${e.type === 'commission' ? 'green' : e.type === 'clawback' ? 'yellow' : 'red'}">${esc(e.type)}</span></td>
          <td class="small">${det}</td>
          <td class="small" style="color:${e.amountCents < 0 ? '#f08a84' : '#6fe0a5'}">${e.amountCents < 0 ? '−' : '+'}${money(Math.abs(e.amountCents))}</td>
          <td class="small">${money(e.balanceAfterCents)}</td>
        </tr>`;
      })
      .join(''),
  );
  const more = $('#cr-more', body);
  if (d.hasMore && d.cursor) {
    more?.closest('.cr-more').classList.remove('hidden');
    more.onclick = () => creatorLedger(body, code, d.cursor);
  } else if (more) more.closest('.cr-more').classList.add('hidden');
}

async function adminPlans(body) {
  const d = await api('GET', '/api/admin/billing');
  // Memory sizes to price: every plan's size (servers), so each plan can be compared like for like.
  const cmpSizes = [...new Set(d.plans.filter((p) => p.active !== false).map((p) => p.ramMb))].sort((a, b) => a - b);
  const dollars = (c) => (c ? +(c / 100).toFixed(2) : '');
  const cmpRow = (h = { prices: {} }) => `<tr class="cmp-edit-row">
    <td><input type="text" data-k="name" maxlength="40" value="${esc(h.name || '')}" placeholder="Host name" style="min-width:120px"></td>
    <td><input type="text" inputmode="url" data-k="url" maxlength="300" value="${esc(h.url || '')}" placeholder="https://..." style="min-width:200px"></td>
    ${cmpSizes.map((mb) => `<td><input type="number" data-mb="${mb}" min="0" step="0.01" value="${dollars((h.prices || {})[mb])}" style="width:80px"></td>`).join('')}
    <td><input type="number" data-k="flat" min="0" step="0.01" value="${dollars(h.flatCents)}" style="width:80px"></td>
    <td><input type="text" data-k="note" maxlength="120" value="${esc(h.note || '')}" placeholder="e.g. Up to 10 players" style="min-width:150px"></td>
    <td><button type="button" class="btn sm danger" data-cmprm>Remove</button></td></tr>`;
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
      ${d.unlimited ? '<div class="warn-box">Test site on this PC: plans never sell out here, and the Lifetime limit is off. Type a capacity to try the real limits.</div>' : ''}
      <p class="small muted" style="margin:0">"Sold" is every paid plan, plus checkouts started in the last 30 minutes. A plan keeps its
        memory even with no servers on it (the customer can make one any time); canceling the plan frees it, deleting a server doesn't.</p>
      <p class="small muted" style="margin:0">Sold: ${+(d.soldMb / 1024).toFixed(1)} GB · extra servers running now: ${+((d.borrowedMb || 0) / 1024).toFixed(1)} GB · free: ${+((d.capacityMb - d.soldMb - (d.borrowedMb || 0)) / 1024).toFixed(1)} GB of ${+(d.capacityMb / 1024).toFixed(1)} GB</p>
      <label class="field">Lifetime plans sold on this machine (each holds its memory forever; 0 = no limit)
        <div class="row"><input type="number" id="cap-life" min="0" max="100" step="1" placeholder="2" value="${d.lifetimeSetting ?? ''}" style="max-width:160px"><span class="muted">${d.lifetimeCount} sold</span></div></label>
      <div class="row"><button class="btn" id="cap-save">Save</button></div>
    </div>
    <div class="card stack" id="cmp-card">
      <h3>Price comparison <span class="muted small" style="font-weight:400">(Why page → How we compare)</span></h3>
      <p class="hint" style="margin:0">Other hosts' <b>regular</b> monthly prices for the same memory as your plans (leave first-month discounts out).
        A host with a flat price (like Realms) uses <b>Flat price</b> instead. Check them every month or two, then update the date: the page shows it.</p>
      <div class="row"><label class="small">Checked on<br><input type="date" id="cmp-date" value="${esc(d.competitors.checkedAt || '')}"></label></div>
      <div style="overflow-x:auto"><table class="plans-edit"><thead><tr><th>Host</th><th>Pricing page (https)</th>${cmpSizes.map((mb) => `<th>${+(mb / 1024).toFixed(1)} GB ($)</th>`).join('')}<th>Flat price ($)</th><th>Note</th><th></th></tr></thead>
        <tbody id="cmp-rows">${d.competitors.hosts.map(cmpRow).join('')}</tbody></table></div>
      <div class="row"><button class="btn sm" id="cmp-add">+ Add host</button><button class="btn primary" id="cmp-save">Save comparison</button></div>
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
  const bindCmpRm = () => $$('[data-cmprm]', body).forEach((b) => (b.onclick = () => b.closest('tr').remove()));
  bindCmpRm();
  $('#cmp-add', body).addEventListener('click', () => {
    $('#cmp-rows', body).insertAdjacentHTML('beforeend', cmpRow());
    bindCmpRm();
  });
  $('#cmp-save', body).addEventListener('click', () =>
    attempt(async () => {
      const hosts = $$('#cmp-rows tr', body).map((tr) => {
        const prices = {};
        // Sizes no plan uses any more are kept as they were.
        const before = (d.competitors.hosts.find((h) => h.name === $('[data-k=name]', tr).value.trim()) || {}).prices || {};
        Object.assign(prices, before);
        $$('[data-mb]', tr).forEach((i) => {
          const c = Math.round(Number(i.value) * 100);
          if (c > 0) prices[i.dataset.mb] = c;
          else delete prices[i.dataset.mb];
        });
        return { name: $('[data-k=name]', tr).value.trim(), url: $('[data-k=url]', tr).value.trim(), note: $('[data-k=note]', tr).value.trim(), flatCents: Math.round(Number($('[data-k=flat]', tr).value) * 100), prices };
      });
      await api('PUT', '/api/admin/competitors', { hosts, checkedAt: $('#cmp-date', body).value });
      toast('Comparison saved');
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

// ---------- User Details Modal ----------

async function showUserDetails(userId) {
  try {
    const details = await api('GET', `/api/admin/users/${userId}/details`);
    const { root, close } = openModal(`
      <h2>${ic('user')} ${esc(details.username)}</h2>
      <div class="card stack">
        <h3>Account Information</h3>
        <table>
          <tr><td class="muted">Username</td><td><b>${esc(details.username)}</b></td></tr>
          <tr><td class="muted">Email</td><td>${esc(details.email || 'No email')}</td></tr>
          <tr><td class="muted">Role</td><td><span class="badge ${ROLE_BADGE[details.role] || ''}">${esc(details.roleLabel || details.role)}</span></td></tr>
          <tr><td class="muted">Joined</td><td>${new Date(details.createdAt).toLocaleString()}</td></tr>
          <tr><td class="muted">Last Login</td><td>${details.lastLogin ? new Date(details.lastLogin).toLocaleString() : 'Never'}</td></tr>
          <tr><td class="muted">Minecraft Name</td><td>${esc(details.mcName || 'Not set')}</td></tr>
          ${details.firebaseUid ? `<tr><td class="muted">Firebase UID</td><td><code class="small">${esc(details.firebaseUid)}</code></td></tr>` : ''}
          ${details.restriction ? `<tr><td class="muted">Status</td><td><span class="badge red">${esc(details.restriction.type)}: ${esc(details.restriction.actionId || 'system')}</span></td></tr>` : ''}
          ${details.prioritySupport ? `<tr><td class="muted">Support</td><td><span class="badge yellow">Priority</span></td></tr>` : ''}
          ${details.lifetime ? `<tr><td class="muted">Plan</td><td><span class="badge lifetime-badge">Lifetime</span></td></tr>` : ''}
        </table>
      </div>
      <div class="card stack">
        <h3>Servers (${details.servers.length})</h3>
        ${details.servers.length ? `
        <table>
          ${details.servers.map(s => `
            <tr>
              <td><b>${esc(s.name)}</b></td>
              <td class="small">${esc(s.type)} ${esc(s.version)}</td>
              <td class="small">${esc(s.status)}</td>
              <td class="small">${fmtMem(s.memoryMb)}</td>
              <td class="small">${s.diskUsedMb ? fmtSize(s.diskUsedMb) : 'N/A'}</td>
            </tr>
          `).join('')}
        </table>
        ` : '<p class="muted" style="margin:0">No servers yet.</p>'}
      </div>
      <div class="card stack">
        <h3>Subscriptions (${details.subscriptions.length})</h3>
        ${details.subscriptions.length ? `
        <table>
          ${details.subscriptions.map(s => `
            <tr>
              <td><b>${esc(s.planName)}</b></td>
              <td class="small">${esc(s.status)}</td>
              <td class="small">${fmtMem(s.ramMb)}</td>
              <td class="small">${s.startedAt ? new Date(s.startedAt).toLocaleDateString() : 'Not started'}</td>
              <td class="small">${s.endsAt ? new Date(s.endsAt).toLocaleDateString() : 'Ongoing'}</td>
            </tr>
          `).join('')}
        </table>
        ` : '<p class="muted" style="margin:0">No subscriptions yet.</p>'}
      </div>
      <div class="card stack">
        <h3>Recent Activity (Last 50)</h3>
        ${details.activity.length ? `
        <div class="stack" style="gap:6px">
          ${details.activity.map(a => `
            <div class="small muted" style="padding:4px;border-left:2px solid #ddd;margin-left:8px">
              <span class="muted">${new Date(a.t).toLocaleString()}</span> · ${esc(a.kind)}: ${esc(a.text)}
            </div>
          `).join('')}
        </div>
        ` : '<p class="muted" style="margin:0">No recent activity.</p>'}
      </div>
      ${details.linked && details.linked.length ? `
      <div class="card stack">
        <h3>Linked Accounts (${details.linked.length})</h3>
        <table>
          ${details.linked.map(l => `
            <tr>
              <td><b>${esc(l.username)}</b></td>
              <td><span class="badge ${ROLE_BADGE[l.role] || ''}">${esc(l.role)}</span></td>
            </tr>
          `).join('')}
        </table>
      </div>
      ` : ''}
      <div class="modal-actions"><button class="btn primary" data-close>Close</button></div>
    `);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function showChangeEmailModal(userId) {
  const { root, close } = openModal(`
    <h2>Change Email</h2>
    <form id="change-email-form" class="stack">
      <p class="hint" style="margin:0">A verification email will be sent to the new address. The user must click the link to confirm the change.</p>
      <label class="field">New Email Address
        <input type="email" name="newEmail" placeholder="user@example.com" required>
      </label>
      <div class="modal-actions">
        <button type="button" data-close>Cancel</button>
        <button type="submit" class="btn primary">Send Verification Email</button>
      </div>
    </form>
  `);

  $('#change-email-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const newEmail = form.newEmail.value.trim();
    
    try {
      const result = await api('POST', `/api/admin/users/${userId}/change-email`, { newEmail });
      toast(result.message);
      if (result.verifyLink) {
        alert(`Verification link (for testing): ${result.verifyLink}`);
      }
      close();
    } catch (e) {
      toast(e.message, 'error');
    }
  });
}

async function adminSettings(body) {
  body.innerHTML = `
    <div class="card stack">
      <h3>Sign-ups</h3>
      <label class="check"><input type="checkbox" id="allow-signup"> Anyone can create an account on the website</label>
    </div>
    <div class="card stack">
      <h3>Base URL</h3>
      <p class="hint" style="margin:0 0 10px">The base URL used for invite links and other generated URLs. Leave empty to use the current domain.</p>
      <div class="row" style="gap:8px">
        <input type="text" id="base-url" placeholder="https://yourdomain.com" style="flex:1">
        <button class="btn" id="save-base-url">Save</button>
      </div>
    </div>
    <div class="card stack" id="email-card">
      <h3>Emails</h3>
      <div id="email-body" class="muted">Loading...</div>
    </div>
    <div class="card stack" id="broadcast-card">
      <h3>Broadcast email</h3>
      <div id="broadcast-body" class="muted">Loading...</div>
    </div>
    <div class="card stack" id="notify-card">
      <h3>Discord alerts for admins</h3>
      <div id="notify-body" class="muted">Loading...</div>
    </div>
`;
  renderNotifications(body).catch((e) => toast(e.message, 'error'));
  renderEmailSettings(body).catch((e) => ($('#email-body', body).textContent = e.message));
  renderBroadcast(body);
  const st = await api('GET', '/api/team/settings');
  const box = $('#allow-signup', body);
  box.checked = !!st.allowSignup;
  box.addEventListener('change', () =>
    attempt(async () => {
      await api('PUT', '/api/team/settings', { allowSignup: box.checked });
      toast(box.checked ? 'Sign-ups are open' : 'Sign-ups are closed');
    }),
  );
  const baseUrlInput = $('#base-url', body);
  baseUrlInput.value = st.baseUrl || '';
  $('#save-base-url', body).addEventListener('click', () =>
    attempt(async () => {
      await api('PUT', '/api/team/settings', { baseUrl: baseUrlInput.value });
      toast('Base URL saved');
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

// ---------- broadcast email (Owner: Settings → Broadcast email) ----------

// The composer for emailing everyone who signed up, or a hand-typed list of addresses. Two-step send:
// Send… opens a confirm dialog showing how many inboxes this goes to; the request only goes out with
// confirm: true. Results list the addresses that failed so they can be retried.
function renderBroadcast(body) {
  const host = $('#broadcast-body', body);
  host.innerHTML = '<div class="muted">Loading...</div>';
  api('GET', '/api/admin/broadcast').then((b) => {
    host.innerHTML = `
      <div class="row" style="flex-wrap:wrap;gap:8px;margin-bottom:10px">
        ${b.enabled ? '<span class="badge green">Sending is on</span>' : '<span class="badge red">Off: no email key set</span>'}
        <span class="badge">${b.count} account${b.count === 1 ? '' : 's'} with an email</span>
      </div>
      <div class="stack">
        <div class="row" style="flex-wrap:wrap;gap:14px;align-items:center">
          <label class="small">From
            <select id="bc-from">${b.fromOptions.map((o) => `<option value="${esc(o.address)}">${esc(o.address)} (${esc(o.label)})</option>`).join('')}</select>
          </label>
          <label class="check" style="margin:0"><input type="radio" name="bc-aud" value="signedup" checked> Everyone who signed up</label>
          <label class="check" style="margin:0"><input type="radio" name="bc-aud" value="manual"> A list I enter</label>
        </div>
        <textarea id="bc-emails" rows="4" style="display:none" placeholder="One email per line (comma-separated works too)&#10;steve@example.com&#10;anna@example.com"></textarea>
        <input type="text" id="bc-subject" maxlength="120" placeholder="Subject" style="width:100%">
        <textarea id="bc-bodytext" rows="6" style="width:100%" placeholder="Your message. A blank line starts a new paragraph; **bold** works like in the other emails."></textarea>
        <div class="row" style="flex-wrap:wrap;gap:8px">
          <input type="text" id="bc-btn-text" placeholder="Button text (optional)" style="flex:1;min-width:160px">
          <input type="text" id="bc-btn-url" placeholder="Button link https://…" style="flex:1;min-width:220px">
        </div>
        <div class="row" style="gap:8px">
          <button class="btn" id="bc-preview">Preview</button>
          <button class="btn primary" id="bc-send" ${b.enabled ? '' : 'disabled'}>Send…</button>
        </div>
        <div id="bc-result"></div>
      </div>`;
    const aud = () => host.querySelector('input[name="bc-aud"]:checked');
    $$('input[name="bc-aud"]', host).forEach((r) =>
      r.addEventListener('change', () => { $('#bc-emails', host).style.display = aud().value === 'manual' ? '' : 'none'; }));
    const payload = (confirm) => ({
      from: $('#bc-from', host).value,
      audience: aud().value,
      emails: $('#bc-emails', host).value,
      subject: $('#bc-subject', host).value,
      body: $('#bc-bodytext', host).value,
      button: { text: $('#bc-btn-text', host).value.trim(), url: $('#bc-btn-url', host).value.trim() },
      confirm,
    });
    const countRecipients = (p) =>
      p.audience === 'manual'
        ? new Set(p.emails.split(/[\n,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean)).size
        : b.count;
    $('#bc-preview', host).addEventListener('click', () =>
      attempt(async () => {
        const res = await fetch('/api/admin/broadcast/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload(false)) });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Preview failed');
        const w = window.open('', '_blank');
        if (!w) throw new Error('Allow pop-ups to see the preview.');
        w.document.write(await res.text());
        w.document.close();
      }));
    const doSend = () =>
      attempt(async () => {
        const r = await api('POST', '/api/admin/broadcast/send', payload(true));
        const fails = r.failed.map((f) => `<div class="small" style="color:#b23b3b">${esc(f.email)} — ${esc(f.error)}</div>`).join('');
        $('#bc-result', host).innerHTML = `
          <div class="card" style="margin-top:10px">
            <b>Sent to ${r.sent} of ${r.total}</b>${r.skipped ? ` · ${r.skipped} skipped` : ''}${r.failed.length ? ` · ${r.failed.length} failed` : ''}
            ${fails ? `<div style="margin-top:6px">${fails}<div class="hint" style="margin-top:6px">Fix the problem, then send again to just these addresses (paste them into “A list I enter”).</div></div>` : ''}
          </div>`;
        toast(`Broadcast sent: ${r.sent} ok${r.failed.length ? `, ${r.failed.length} failed` : ''}`, r.failed.length ? 'error' : 'info');
      });
    $('#bc-send', host).addEventListener('click', () =>
      attempt(async () => {
        const p = payload(false);
        const n = countRecipients(p);
        if (!n) throw new Error('There is nobody to send to.');
        const { close, root } = openModal(`
          <h2>${ic('mail')} Send to ${n} ${p.audience === 'manual' ? (n === 1 ? 'address' : 'addresses') : (n === 1 ? 'account' : 'accounts')}?</h2>
          <p class="muted" style="margin-top:-6px">From <b>${esc(p.from)}</b> · Subject: “${esc(p.subject)}”.</p>
          <p class="hint">This goes out to real inboxes and can't be taken back.</p>
          <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="bc-confirm">Send it</button></div>`);
        $('#bc-confirm', root).addEventListener('click', () => { close(); doSend(); });
      }));
  }).catch((e) => { host.textContent = e.message; });
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


/** The code from a tester link (/dashboard?code=...), kept for the visit so it survives switching to Sign up. */
function testerCode() {
  const fromUrl = new URLSearchParams(location.search).get('code');
  try {
    if (fromUrl) sessionStorage.setItem('th_signup_code', fromUrl);
    return fromUrl || sessionStorage.getItem('th_signup_code') || '';
  } catch {
    return fromUrl || '';
  }
}
testerCode();
