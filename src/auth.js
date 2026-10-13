'use strict';
// Accounts: customers (public sign-up), staff and admins; login sessions, staff invite links,
// password resets and personal API tokens.
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { DATA } = require('./paths');
const store = require('./store');
const { refValue } = require('./metrics'); // ref allowlist (discord/youtube/reddit/serverlist); shared with the page-view beacon
const firebase = require('./firebase');
const totp = require('./totp');

const SESSIONS_FILE = path.join(DATA, 'team-sessions.json');
const SESSION_TTL = 30 * 86400000;
const INVITE_TTL = 7 * 86400000;
const RESET_TTL = 60 * 60000;
const RATE_WINDOW = 15 * 60000;
const RATE_MAX = 10;
const LOGIN_MAX = 5; // wrong passwords (or 2FA codes) per address and per account before a 15-minute lockout
const SCRYPT = { N: 16384, r: 8, p: 1 };

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

// Roles (what each may do is in rbac.js): owner runs Tree Host, admin runs the business, developer builds it,
// staff is Support, customer is everyone who signs up, and a YouTuber is a customer with a creator badge.
const ROLES = ['owner', 'admin', 'developer', 'staff', 'youtuber', 'customer'];
const CUSTOMER_ROLES = ['youtuber', 'customer'];
const cleanRole = (r) => (ROLES.includes(r) ? r : 'customer');
const isStaff = (u) => !!u && !CUSTOMER_ROLES.includes(u.role);
// Roles that are allowed to manage everything; the last one of the highest kind can't be removed.
const isOwner = (u) => !!u && u.role === 'owner';

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, 64, SCRYPT, (err, key) =>
      err ? reject(err) : resolve(`scrypt$${salt.toString('base64')}$${key.toString('base64')}`),
    );
  });
}

function verifyPassword(password, stored) {
  return new Promise((resolve) => {
    const [alg, salt, hash] = String(stored || '').split('$');
    if (alg !== 'scrypt' || !salt || !hash) return resolve(false);
    const expected = Buffer.from(hash, 'base64');
    crypto.scrypt(String(password), Buffer.from(salt, 'base64'), expected.length, SCRYPT, (err, key) =>
      resolve(!err && crypto.timingSafeEqual(key, expected)),
    );
  });
}

// Names that look official ("admin", "TreeHost_Support") are reserved, so nobody can pose as the team.
const RESERVED_EXACT = new Set(['root', 'sysadmin', 'superuser', 'support', 'staff', 'mod', 'mods', 'owner', 'system', 'security', 'billing',
  'help', 'info', 'abuse', 'postmaster', 'webmaster', 'hostmaster', 'noreply', 'api', 'server', 'console', 'null', 'undefined', 'team']);
const RESERVED_START = ['admin', 'administrator', 'treehost', 'moderator', 'official', 'staffteam', 'supportteam'];
function isReservedUsername(u) {
  const n = String(u || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/\d+$/, '');
  return RESERVED_EXACT.has(n) || RESERVED_START.some((r) => n.startsWith(r)) || n.endsWith('admin');
}

function validateUsername(u) {
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(String(u || ''))) throw httpError(400, 'Username must be 3-32 letters, numbers, dots, dashes or _');
  if (isReservedUsername(u)) throw httpError(400, "That username is reserved, so nobody can pretend to be the Tree Host team. Please pick another.");
}

function validatePassword(p) {
  if (String(p || '').length < 8) throw httpError(400, 'Password must be at least 8 characters');
  if (String(p).length > 200) throw httpError(400, 'Password is too long');
}

function validateMcName(n) {
  if (n && !/^[A-Za-z0-9_]{3,16}$/.test(n)) throw httpError(400, 'Minecraft name must be 3-16 letters, numbers or _');
}

function cleanEmail(e) {
  const email = String(e || '').trim().toLowerCase();
  if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 200)) throw httpError(400, 'That email address does not look right');
  return email;
}

class Auth {
  constructor() {
    this.users = [];
    this.invites = [];
    this.resets = [];
    this.sessions = new Map();
    this.renewed = null;
    this.attempts = new Map();
    this.settings = { allowSignup: true, baseUrl: '' };
    // Who becomes an admin: the emails in TREEHOST_ADMIN_EMAILS (once the email is verified).
    // allowFirstAdmin (local testing only): the very first account becomes an admin.
    this.adminEmails = new Set(
      String(process.env.TREEHOST_ADMIN_EMAILS || '')
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    );
    this.allowFirstAdmin = false;
    // TREEHOST_SIGNUP_CODE (a test site for invited testers): new accounts need the code from the tester link.
    this.signupCode = '';
    // Passkey challenges (an honest stub, src/passkeys.js): issued and burned, nothing else yet.
    this.passkeyChallenges = new Map();
  }

  async init() {
    const d = (await store.load('team-users')) || {};
    // The Realtime Database drops empty arrays: put them back.
    this.users = Object.values(d.users || {}).map((u) => ({ ...u, tokens: Object.values(u.tokens || {}) }));
    this.invites = Object.values(d.invites || {}).filter((i) => i.expires > Date.now());
    this.resets = Object.values(d.resets || {}).filter((r) => r.expires > Date.now());
    this.settings = { allowSignup: true, baseUrl: '', ...this.settings, ...(d.settings || {}) };
    // Roles from the old team-only version.
    let migrated = false;
    for (const u of this.users) {
      if (u.role === 'dev' || u.role === 'tester') (u.role = 'staff'), (migrated = true);
      if (u.role === 'pending') (u.role = 'customer'), (migrated = true);
      // Old-style suspensions become restrictions (people can sign in to see why and appeal).
      if (u.disabled) {
        u.restriction = { type: 'suspended', actionId: null, until: null, at: Date.now() };
        delete u.disabled;
        migrated = true;
      }
    }
    // Role-based access: there must always be an Owner. Emails in TREEHOST_ADMIN_EMAILS are Owners; if there is
    // none yet, the earliest admin becomes the Owner.
    for (const u of this.users) {
      if (u.role === 'admin' && u.email && this.adminEmails.has(u.email)) (u.role = 'owner'), (migrated = true);
    }
    if (!this.users.some(isOwner)) {
      const first = this.users.filter((u) => u.role === 'admin').sort((a, b) => a.createdAt - b.createdAt)[0];
      if (first) (first.role = 'owner'), (migrated = true);
    }
    if (migrated) await this.save();
    // Sessions live in the store (Firebase when set up), so a redeploy — which wipes the
    // ephemeral data folder — no longer signs everyone out. Local file stays as a migration
    // source for installs that had sessions saved the old way.
    try {
      const saved = await store.load('auth-sessions');
      for (const [hash, s] of Object.entries(saved || {})) {
        if (s && s.expires > Date.now()) this.sessions.set(hash, { ...s, userId: String(s.userId) });
      }
    } catch {
      /* none yet */
    }
    // One-time migration: sessions saved to the old local file move into the store.
    try {
      const list = JSON.parse(await fsp.readFile(SESSIONS_FILE, 'utf8'));
      let moved = 0;
      for (const [hash, s] of list) {
        if (s && s.expires > Date.now() && !this.sessions.has(hash)) {
          this.sessions.set(hash, s);
          moved++;
        }
      }
      if (moved) {
        await this.saveSessions();
        await fsp.unlink(SESSIONS_FILE).catch(() => {});
        console.log(`  Migrated ${moved} session${moved === 1 ? '' : 's'} to the store.`);
      }
    } catch {
      /* no legacy file */
    }
  }

  async write(file, data) {
    await fsp.mkdir(DATA, { recursive: true });
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, file);
  }

  save() {
    return store.save('team-users', { users: this.users, invites: this.invites, resets: this.resets, settings: this.settings });
  }

  saveSessions() {
    return store.save('auth-sessions', Object.fromEntries(this.sessions));
  }

  publicUser(u) {
    return {
      firebase: !!u.firebaseUid,
      id: u.id,
      username: u.username,
      email: u.email || '',
      role: u.role,
      mcName: u.mcName || '',
      createdAt: u.createdAt,
      disabled: !!u.restriction,
      restriction: u.restriction || null,
      lastLogin: u.lastLogin || null,
      emailVerified: u.firebaseUid ? !!u.emailVerified : true,
      twoFactor: !!(u.mfa && u.mfa.on),
      // Second-factor methods on the account, so the Security card can offer email codes and passkeys.
      mfaEmail: !!(u.mfa && u.mfa.email && u.mfa.email.on),
      mfaPasskey: false, // passkeys are an honest stub (see src/passkeys.js): nothing stored yet
      ref: u.ref || null,
      // The creator this account was attributed to at signup (their own display code; spec §11 E1).
      creatorCode: u.creatorCode || null,
      // An Owner email that isn't verified yet: it becomes Owner as soon as the email is verified.
      ownerPending: !!u.email && this.adminEmails.has(u.email) && u.role !== 'owner',
    };
  }

  /** Minecraft names of support staff and admins (only used by the local personal mode). */
  mcNames() {
    return this.users.filter((u) => isStaff(u) && !u.disabled && !u.restriction).map((u) => u.mcName).filter(Boolean);
  }

  userById(id) {
    return this.users.find((u) => u.id === id) || null;
  }

  firstAdmin() {
    return this.users.find(isOwner) || this.users.find((u) => u.role === 'admin') || null;
  }

  /** True when someone can run the place (an Owner exists). */
  hasOwner() {
    return this.users.some(isOwner);
  }

  async setSettings({ allowSignup, baseUrl }) {
    if (allowSignup !== undefined) this.settings.allowSignup = !!allowSignup;
    if (baseUrl !== undefined) {
      // Validate and normalize the base URL
      const url = String(baseUrl || '').trim();
      if (url) {
        // Ensure it has a protocol and ends without a trailing slash
        let normalized = url;
        if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
          normalized = 'https://' + normalized;
        }
        normalized = normalized.replace(/\/$/, '');
        this.settings.baseUrl = normalized;
      } else {
        this.settings.baseUrl = '';
      }
    }
    await this.save();
    return this.settings;
  }

  /** Age gate (COPPA): accounts are for people 13 and older, asked neutrally as a birth year. Returns the year. */
  checkAge(body) {
    const y = Math.round(Number(body.birthYear));
    const now = new Date().getFullYear();
    if (!(y >= 1900 && y <= now)) throw httpError(400, 'Choose the year you were born.');
    // Only the year is known, so someone who turns 13 this year counts as 12 (never let an under-13 through).
    if (now - y <= 13) throw httpError(403, 'Sorry, you need to be at least 13 to make a Tree Host account.', 'TOO_YOUNG');
    return y;
  }

  /**
   * Applies ?ref= attribution to a new user: static channels and active creator codes are kept
   * verbatim, everything else is 'other' (refValue). When the ref resolves to an active creator
   * (via the passed registry hook) the account is attributed to them for good — commissions and
   * stats read user.creatorCode/creatorId from then on. With no creators registered this is
   * exactly the old single-arg behavior.
   */
  applyRef(user, body, opts = {}) {
    const codes = Array.isArray(opts.creatorCodes) ? opts.creatorCodes : [];
    user.ref = refValue(body.ref, { creatorCodes: codes });
    const byCode = typeof opts.creatorByCode === 'function' ? opts.creatorByCode : null;
    const c = byCode && user.ref ? byCode(user.ref) : null;
    if (c && c.status === 'active') {
      user.creatorCode = c.code;
      user.creatorId = c.id;
    }
    return user;
  }

  /** Public sign-up: creates a customer account right away. */
  async signup(body, ip, opts = {}) {
    if (!this.settings.allowSignup) throw httpError(403, 'Sign-ups are closed right now. Please try again later.');
    if (!body.acceptTerms) throw httpError(400, 'Please accept the Terms of Service and Privacy Policy.');
    const birthYear = this.checkAge(body);
    this.checkRate([`signup:${ip}`]);
    this.checkSignupCode(body, [`signup:${ip}`]);
    this.recordFailure([`signup:${ip}`]);
    if (!cleanEmail(body.email)) throw httpError(400, 'Enter your email address');
    const first = !this.hasOwner();
    const user = await this.createUser(body, first && this.allowFirstAdmin ? 'owner' : 'customer');
    user.birthYear = birthYear;
    // Where the visitor came from (?ref=discord etc.), sanitized against the allowlist. A bad
    // or missing ref never fails the signup: refValue returns 'other' for junk, null for absent.
    this.applyRef(user, body, opts);
    await this.save();
    return { user, token: await this.createSession(user) };
  }

  // ----- rate limiting -----

  checkRate(keys, max = RATE_MAX) {
    const now = Date.now();
    for (const key of keys) {
      const recent = (this.attempts.get(key) || []).filter((t) => now - t < RATE_WINDOW);
      this.attempts.set(key, recent);
      if (recent.length >= max) throw httpError(429, 'Too many attempts. Try again in 15 minutes.');
    }
  }

  // ----- two-factor sign-in (authenticator app codes via src/totp.js, and email codes) -----

  /** The second-factor methods this account has on, in the order they're offered. */
  mfaMethods(user) {
    const m = user && user.mfa;
    if (!m || !m.on) return [];
    const methods = ['totp'];
    if (m.email) methods.push('email');
    return methods;
  }

  hasMfa(user) {
    return this.mfaMethods(user).length > 0;
  }

  /** Asks for (and checks) the 2FA code when the account has 2FA on. A wrong code counts like a wrong password.
   *  method: which method the code is for when several are on ('totp' default, 'email' fallback; recovery codes
   *  are accepted either way). Without a code the error carries the methods so the browser can ask which to use. */
  checkSecondFactor(user, code, keys, method) {
    const methods = this.mfaMethods(user);
    if (!methods.length) return;
    if (!code) {
      throw Object.assign(
        new Error(methods.length > 1 ? 'Two-factor sign-in is on for this account.' : 'Enter the 6-digit code from your authenticator app.'),
        { status: 401, code: 'MFA_REQUIRED', methods },
      );
    }
    if (!this.useSecondFactor(user, code, method)) {
      this.recordFailure(keys);
      throw httpError(401, "That code didn't work. Use the newest code in your authenticator app, a code we emailed you, or one of your recovery codes.", 'MFA_INVALID');
    }
  }

  /** A current authenticator code (each one works once), a one-time emailed code, or an unused recovery code.
   *  method: 'email' checks the emailed code first; anything else (or the default) checks the app first. */
  useSecondFactor(user, code, method) {
    const c = String(code || '').trim();
    const order = method === 'email' ? ['email', 'totp'] : ['totp', 'email'];
    for (const kind of order) {
      if (kind === 'totp' && user.mfa.secret) {
        const step = totp.verify(user.mfa.secret, c);
        if (step !== null && step > (user.mfa.lastStep || 0)) {
          user.mfa.lastStep = step;
          this.save().catch(() => {});
          return true;
        }
      } else if (kind === 'email' && user.mfa.email && this.useEmailedCode(user, c)) return true;
    }
    const h = sha256(c.toUpperCase().replace(/[^A-Z0-9]/g, ''));
    const i = (user.mfa.recovery || []).indexOf(h);
    if (i >= 0) {
      user.mfa.recovery.splice(i, 1);
      this.save().catch(() => {});
      return true;
    }
    return false;
  }

  /** The emailed sign-in code (issued by sendLoginEmailCode), each one working once. */
  useEmailedCode(user, code) {
    const p = user.mfa.loginCode;
    if (!p || Date.now() > p.expires) return false;
    if (!crypto.timingSafeEqual(Buffer.from(sha256(String(code || '').trim())), Buffer.from(p.hash))) return false;
    delete user.mfa.loginCode;
    this.save().catch(() => {});
    return true;
  }

  /** Step 1: a new secret to add to the authenticator app (not on until a code from it is entered). */
  async startTwoFactor(user) {
    if (this.hasMfa(user)) throw httpError(400, 'Two-factor authentication is already on.');
    const secret = totp.newSecret();
    user.mfaPending = { secret, at: Date.now() };
    await this.save();
    return { secret, uri: totp.uri(secret, user.email || user.username) };
  }

  /** Step 2: a code from the app turns it on. Returns 8 one-time recovery codes (shown once). */
  async enableTwoFactor(user, code) {
    const p = user.mfaPending;
    if (!p || Date.now() - p.at > 30 * 60000) throw httpError(400, 'Start the setup again (it expires after 30 minutes).');
    const step = totp.verify(p.secret, code);
    if (step === null) throw httpError(400, "That code didn't match. Check the time on your phone is set automatically, then try the newest code.");
    const recovery = Array.from({ length: 8 }, () => crypto.randomBytes(5).toString('hex').toUpperCase().replace(/(.{5})(.{5})/, '$1-$2'));
    user.mfa = { on: true, secret: p.secret, at: Date.now(), lastStep: step, recovery: recovery.map((r) => sha256(r.replace('-', ''))) };
    delete user.mfaPending;
    await this.save();
    return { recovery };
  }

  // ----- email codes (a second-factor method for accounts with an email on file) -----
  async enableTwoFactor(user, code) {
    const p = user.mfaPending;
    if (!p || Date.now() - p.at > 30 * 60000) throw httpError(400, 'Start the setup again (it expires after 30 minutes).');
    const step = totp.verify(p.secret, code);
    if (step === null) throw httpError(400, "That code didn't match. Check the time on your phone is set automatically, then try the newest code.");
    const recovery = Array.from({ length: 8 }, () => crypto.randomBytes(5).toString('hex').toUpperCase().replace(/(.{5})(.{5})/, '$1-$2'));
    user.mfa = { on: true, secret: p.secret, at: Date.now(), lastStep: step, recovery: recovery.map((r) => sha256(r.replace('-', ''))) };
    delete user.mfaPending;
    await this.save();
    return { recovery };
  }

  /** A one-time emailed code: 6 digits, good for 10 minutes, single use, max 5 wrong tries per code. */
  async startEmailCode(user, send) {
    if (!user.email) throw httpError(400, 'Add your email address in Account first, then set this up.');
    if (!user.mfa || !user.mfa.on) throw httpError(400, 'Turn on two-factor sign-in with an authenticator app first.');
    if (user.mfa.email && user.mfa.email.on) throw httpError(400, 'Email codes are already set up.');
    if (!send) throw httpError(503, 'Email is not set up yet. Please contact support.');
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    user.mfa.emailPending = { hash: sha256(code), expires: Date.now() + 10 * 60000, tries: 0 };
    await this.save();
    await send(user.email, code);
    return { sentTo: user.email };
  }

  /** A code from the inbox turns email codes on. */
  async enableEmailCode(user, code) {
    const p = user.mfa && user.mfa.emailPending;
    if (!p || Date.now() - p.expires > 10 * 60000) throw httpError(400, 'The code expired. Send a new one and try again.');
    p.tries++;
    if (!crypto.timingSafeEqual(Buffer.from(sha256(String(code || '').trim())), Buffer.from(p.hash))) {
      // Five tries per code, then the pending code goes away: send a new one.
      if (p.tries >= 5) delete user.mfa.emailPending;
      await this.save();
      throw httpError(400, "That code didn't match. Send a new one and try again.");
    }
    user.mfa.email = { on: true, at: Date.now() };
    delete user.mfa.emailPending;
    await this.save();
    return { ok: true };
  }

  /** Turns email codes off. Needs any working second factor, so a stolen session can't weaken the account. */
  async disableEmailCode(user, code) {
    if (!user.mfa || !user.mfa.email || !user.mfa.email.on) return;
    if (!this.useSecondFactor(user, code)) throw httpError(400, "That code didn't work.");
    delete user.mfa.email;
    await this.save();
  }

  // ----- email codes at sign-in -----

  /**
   * Issues a sign-in code to the account's email and remembers it on the account (hashed, like every other
   * code here). The browser only gets a random handle — never the user id — and the answer is identical
   * whether or not the address has an account, so this can't confirm who has one.
   */
  async sendLoginEmailCode(loginOrUser, send) {
    const user = typeof loginOrUser === 'string' ? this.findByLogin(loginOrUser) : loginOrUser;
    if (!send) throw httpError(503, 'Email is not set up yet. Please try an authenticator app or a recovery code.');
    if (user && user.email && this.hasMfa(user) && !user.disabled) {
      const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
      user.mfa.loginCode = { hash: sha256(code), expires: Date.now() + 10 * 60000, tries: 0 };
      await this.save();
      await send(user.email, code);
    }
    // Same shape (and same silence) either way, so this endpoint can't be used to find out who has an account.
    return { sent: true, handle: randomToken(12) };
  }

  /** Checks a sign-in code from the inbox (each one works once, max 5 wrong tries, 10 minutes). */
  checkLoginEmailCode(user, code) {
    const p = user.mfa && user.mfa.loginCode;
    if (!p || Date.now() > p.expires) throw httpError(400, 'That code expired. Send a new one and try again.');
    p.tries++;
    if (!crypto.timingSafeEqual(Buffer.from(sha256(String(code || '').trim())), Buffer.from(p.hash))) {
      if (p.tries >= 5) delete user.mfa.loginCode;
      this.save().catch(() => {});
      throw httpError(400, "That code didn't work. Send a new one and try again.");
    }
    delete user.mfa.loginCode;
    this.save().catch(() => {});
    return user;
  }

  async disableTwoFactor(user, code) {
    if (!this.hasMfa(user)) return;
    if (!this.useSecondFactor(user, code)) throw httpError(400, "That code didn't work.");
    delete user.mfa;
    await this.save();
  }

  recordFailure(keys) {
    for (const key of keys) this.attempts.set(key, [...(this.attempts.get(key) || []), Date.now()]);
  }

  // ----- accounts -----

  findByLogin(login) {
    const l = String(login || '').trim().toLowerCase();
    if (!l) return null;
    return this.users.find((u) => u.username.toLowerCase() === l || (u.email && u.email === l)) || null;
  }

  async createUser({ username, email, password, mcName }, role) {
    validateUsername(username);
    validatePassword(password);
    email = cleanEmail(email);
    mcName = String(mcName || '').trim();
    validateMcName(mcName);
    if (this.users.some((u) => u.username.toLowerCase() === String(username).toLowerCase())) {
      throw httpError(400, 'That username is taken');
    }
    if (email && this.users.some((u) => u.email === email)) throw httpError(400, 'There is already an account with that email. Sign in instead.');
    const user = {
      id: randomToken(6),
      username: String(username),
      email,
      passHash: await hashPassword(password),
      role: cleanRole(role),
      mcName,
      tokens: [],
      createdAt: Date.now(),
    };
    this.users.push(user);
    await this.save();
    return user;
  }

  async login({ username, password, code, method }, ip) {
    const keys = [`ip:${ip}`, `user:${String(username || '').toLowerCase()}`];
    this.checkRate(keys, LOGIN_MAX);
    const user = this.findByLogin(username);
    const ok = user ? await verifyPassword(password, user.passHash) : await verifyPassword(password, 'scrypt$AAAA$AAAA');
    if (!user || !ok) {
      this.recordFailure(keys);
      throw httpError(401, 'Wrong username, email or password', 'LOGIN');
    }
    if (user.disabled) throw httpError(403, 'This account has been suspended. Contact support.', 'DISABLED');
    this.checkSecondFactor(user, code, keys, method);
    user.lastLogin = Date.now();
    this.save().catch(() => {});
    return this.createSession(user);
  }

  /**
   * Invite links: staff (Support, Developer, Admin) or a YouTuber. One use each. A YouTuber invite may come with a free
   * plan (given by the caller when it's used) and works for an existing account too (see claimInvite).
   * Who may invite whom is checked by the caller (rbac).
   */
  async createInvite(byUser, role, { note = '', days = 7, plan = null } = {}) {
    if (!['admin', 'developer', 'staff', 'youtuber'].includes(role)) throw httpError(400, 'Invites are for Support, Developer, Admin or YouTuber.');
    const token = randomToken(24);
    const ttl = [1, 3, 7, 14, 30].includes(Number(days)) ? Number(days) * 86400000 : INVITE_TTL;
    this.invites.push({
      id: randomToken(6),
      hash: sha256(token),
      role,
      note: String(note || '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 60),
      plan: plan && plan.planId ? { planId: String(plan.planId), months: Math.max(1, Math.min(24, Math.round(Number(plan.months) || 1))) } : null,
      createdBy: byUser.username,
      createdAt: Date.now(),
      expires: Date.now() + ttl,
    });
    await this.save();
    return token;
  }

  findInvite(token) {
    const hash = sha256(token || '');
    return this.invites.find((i) => i.hash === hash && i.expires > Date.now()) || null;
  }

  /** Pending invites, for the Staff Console (never the links themselves: only their hashes are kept). */
  listInvites() {
    return this.invites
      .filter((i) => i.expires > Date.now())
      .map((i) => ({ id: i.id || i.hash.slice(0, 8), role: i.role, note: i.note || '', plan: i.plan || null, createdBy: i.createdBy, createdAt: i.createdAt || null, expires: i.expires }));
  }

  async revokeInvite(id) {
    const before = this.invites.length;
    this.invites = this.invites.filter((i) => (i.id || i.hash.slice(0, 8)) !== id);
    if (this.invites.length === before) throw httpError(404, 'That invite was already used, revoked or has expired.');
    await this.save();
  }

  async acceptInvite(body, ip, opts = {}) {
    this.checkRate([`invite:${ip}`]);
    const invite = this.findInvite(body.invite);
    if (!invite) {
      this.recordFailure([`invite:${ip}`]);
      throw httpError(400, 'This invite link is invalid or has expired. Ask an admin for a new one.');
    }
    // A YouTuber is a customer: the same terms and age check as signing up on the website.
    let birthYear;
    if (CUSTOMER_ROLES.includes(invite.role)) {
      if (!body.acceptTerms) throw httpError(400, 'Please accept the Terms of Service and Privacy Policy.');
      birthYear = this.checkAge(body);
    }
    const user = await this.createUser(body, invite.role);
    if (birthYear) user.birthYear = birthYear;
    this.applyRef(user, body, opts);
    this.invites = this.invites.filter((i) => i !== invite);
    await this.save();
    return { token: await this.createSession(user), user, invite };
  }

  /** A signed-in customer uses a YouTuber invite: their account becomes a YouTuber account. */
  async claimInvite(user, token) {
    const invite = this.findInvite(token);
    if (!invite) throw httpError(400, 'This invite link is invalid or has expired. Ask whoever sent it for a new one.');
    if (!CUSTOMER_ROLES.includes(invite.role)) throw httpError(400, 'This is a staff invite: it makes a new account. Sign out first, then open the link again.');
    if (!CUSTOMER_ROLES.includes(user.role)) throw httpError(400, "You're signed in with a staff account. Sign in with the account the invite is for.");
    user.role = invite.role;
    this.invites = this.invites.filter((i) => i !== invite);
    await this.save();
    return invite;
  }

  async updateUser(user, { mcName, email, password, currentPassword }) {
    if (mcName !== undefined) {
      mcName = String(mcName).trim();
      validateMcName(mcName);
      user.mcName = mcName;
    }
    if (email !== undefined) {
      email = cleanEmail(email);
      if (!email && CUSTOMER_ROLES.includes(user.role)) throw httpError(400, 'Enter your email address');
      if (email && this.users.some((u) => u !== user && u.email === email)) throw httpError(400, 'Another account already uses that email.');
      user.email = email;
    }
    if (password) {
      if (!(await verifyPassword(currentPassword, user.passHash))) throw httpError(400, 'Current password is wrong');
      validatePassword(password);
      user.passHash = await hashPassword(password);
    }
    await this.save();
  }

  /** Changes someone's role (the last Owner can't be demoted). Who may do it is checked by rbac in server.js. */
  async setRole(id, role) {
    const user = this.userById(id);
    if (!user) throw httpError(404, 'User not found');
    role = cleanRole(role);
    if (isOwner(user) && role !== 'owner' && this.users.filter(isOwner).length === 1) {
      throw httpError(400, 'You cannot demote the last Owner. Make someone else an Owner first.');
    }
    user.role = role;
    await this.save();
    return user;
  }

  /**
   * Suspends or bans an account (restriction: { type: 'suspended'|'banned', actionId, until }), or lifts it (null).
   * Restricted people can still sign in, but only see why, their inbox and the appeal form (checked in server.js).
   */
  async setRestriction(id, restriction) {
    const user = this.userById(id);
    if (!user) throw httpError(404, 'User not found');
    if (isOwner(user) && restriction) throw httpError(400, 'Owners cannot be suspended or banned. Change their role first.');
    if (restriction) {
      user.restriction = { ...restriction, at: Date.now() };
    } else {
      delete user.restriction;
    }
    await this.save();
    return user;
  }

  async removeUser(id) {
    const user = this.users.find((u) => u.id === id);
    if (!user) throw httpError(404, 'User not found');
    if (isOwner(user) && this.users.filter(isOwner).length === 1) {
      throw httpError(400, 'You cannot remove the last Owner');
    }
    this.users = this.users.filter((u) => u !== user);
    this.dropSessions(id);
    await this.save();
    await this.saveSessions();
    return user;
  }

  /**
   * Remembers that this account was used in a browser (the device id is stored hashed). Accounts that share a browser
   * are "linked": staff actions apply to all of them. Returns true if this browser is new for the account.
   */
  async recordDevice(user, deviceId) {
    if (!user || !deviceId) return false;
    const h = sha256(`device:${deviceId}`).slice(0, 32);
    const list = Object.values(user.devices || {});
    if (list.includes(h)) return false;
    user.devices = [...list, h].slice(-20);
    await this.save();
    return true;
  }

  /** Accounts used in one particular browser. */
  accountsOnDevice(deviceId) {
    const h = sha256(`device:${deviceId}`).slice(0, 32);
    return this.users.filter((u) => Object.values(u.devices || {}).includes(h));
  }

  /** Other accounts used in the same browser as this one. */
  linkedAccounts(user) {
    const mine = new Set(Object.values((user && user.devices) || {}));
    if (!mine.size) return [];
    return this.users.filter((u) => u !== user && Object.values(u.devices || {}).some((d) => mine.has(d)));
  }

  dropSessions(userId) {
    for (const [hash, s] of this.sessions) if (s.userId === userId) this.sessions.delete(hash);
  }

  // ----- password resets -----

  /** Creates a one-hour reset token for the account with this email (null if there is none). */
  async createReset(email, ip) {
    this.checkRate([`reset:${ip}`]);
    this.recordFailure([`reset:${ip}`]);
    const user = this.users.find((u) => u.email && u.email === cleanEmail(email));
    if (!user || user.disabled) return null;
    const token = randomToken(24);
    this.resets = this.resets.filter((r) => r.userId !== user.id && r.expires > Date.now());
    this.resets.push({ hash: sha256(token), userId: user.id, expires: Date.now() + RESET_TTL });
    await this.save();
    return { user, token };
  }

  async resetPassword({ token, password }, ip) {
    this.checkRate([`resetuse:${ip}`]);
    const r = this.resets.find((x) => x.hash === sha256(token || '') && x.expires > Date.now());
    if (!r) {
      this.recordFailure([`resetuse:${ip}`]);
      throw httpError(400, 'This reset link is invalid or has expired. Request a new one.');
    }
    validatePassword(password);
    const user = this.userById(r.userId);
    if (!user) throw httpError(400, 'Account not found');
    user.passHash = await hashPassword(password);
    this.resets = this.resets.filter((x) => x !== r);
    this.dropSessions(user.id);
    await this.save();
    await this.saveSessions();
    return this.createSession(user);
  }

  /** Admin help: sets a random temporary password and signs the user out everywhere. */
  async tempPassword(id) {
    const user = this.userById(id);
    if (!user) throw httpError(404, 'User not found');
    const password = randomToken(9);
    user.passHash = await hashPassword(password);
    this.dropSessions(id);
    await this.save();
    await this.saveSessions();
    return password;
  }

  // ----- Firebase sign-in -----

  /** True for a verified email listed in TREEHOST_ADMIN_EMAILS (Google accounts are always verified). */
  /** On a tester-only site, a new account needs the code from the tester link (a wrong one counts as a failed try). */
  checkSignupCode(body, rateKeys) {
    if (!this.signupCode) return;
    const a = sha256(String(body.signupCode || ''));
    const b = sha256(this.signupCode);
    if (crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))) return;
    this.recordFailure(rateKeys);
    throw httpError(403, 'This is a private test site: sign up with the tester link you were sent.', 'SIGNUP_CODE');
  }

  isAdminEmail(id) {
    return !!id.email && this.adminEmails.has(id.email) && (id.emailVerified || id.provider === 'google.com');
  }

  findByFirebase(uid) {
    return this.users.find((u) => u.firebaseUid === uid) || null;
  }

  /**
   * Signs in with a Firebase ID token. Existing accounts are found by their Firebase uid (or linked by a verified
   * email). New people get a customer account once they've picked a username and accepted the terms. Emails listed in
   * TREEHOST_ADMIN_EMAILS become admins (only once Firebase has verified the email); invite links make support staff.
   * Returns { token } or { needsProfile: true, email, suggested }.
   */
  async firebaseLogin(body, ip, opts = {}) {
    this.checkRate([`fb:${ip}`]);
    const id = await firebase.verifyIdToken(body.idToken);
    let user = this.findByFirebase(id.uid);
    if (!user && id.email && (id.emailVerified || id.provider === 'google.com')) {
      user = this.users.find((u) => !u.firebaseUid && u.email === id.email) || null;
      if (user) user.firebaseUid = id.uid;
    }
    const ownerEmail = this.isAdminEmail(id);
    if (user) {
      if (user.disabled) throw httpError(403, 'This account has been suspended. Contact support.', 'DISABLED');
      this.checkRate([`fb2fa:${user.id}`], LOGIN_MAX);
      this.checkSecondFactor(user, body.code, [`fb2fa:${user.id}`], body.method);
      if (id.email && user.email !== id.email) user.email = id.email;
      if (ownerEmail && user.role !== 'owner') user.role = 'owner';
      user.emailVerified = !!(id.emailVerified || id.provider === 'google.com');
      user.lastLogin = Date.now();
      await this.save();
      return { user, token: await this.createSession(user), needsDemoServer: !user.hasDemoServer };
    }

    // A new account.
    let role = 'customer';
    let invite = null;
    if (ownerEmail || (this.allowFirstAdmin && !this.hasOwner())) {
      role = 'owner';
    } else if (body.invite) {
      invite = this.invites.find((i) => i.hash === sha256(body.invite) && i.expires > Date.now());
      if (!invite) throw httpError(400, 'This invite link is invalid or has expired. Ask an admin for a new one.');
      role = invite.role;
    } else if (!this.settings.allowSignup) {
      throw httpError(403, 'Sign-ups are closed right now. Please try again later.');
    } else {
      this.checkSignupCode(body, [`fb:${ip}`]);
    }
    const suggested = (id.name || id.email.split('@')[0] || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 32);
    if (!body.username) return { needsProfile: true, email: id.email, suggested };
    if (CUSTOMER_ROLES.includes(role) && !body.acceptTerms) throw httpError(400, 'Please accept the Terms of Service and Privacy Policy.');
    const birthYear = CUSTOMER_ROLES.includes(role) ? this.checkAge(body) : undefined;
    validateUsername(body.username);
    if (this.users.some((u) => u.username.toLowerCase() === String(body.username).toLowerCase())) throw httpError(400, 'That username is taken');
    if (id.email && this.users.some((u) => u.email === id.email)) {
      throw httpError(400, 'There is already an account with that email. Verify your email (check your inbox), then sign in again.');
    }
    const mcName = String(body.mcName || '').trim();
    validateMcName(mcName);
    user = {
      id: randomToken(6),
      username: String(body.username),
      email: id.email,
      firebaseUid: id.uid,
      emailVerified: !!(id.emailVerified || id.provider === 'google.com'),
      role,
      mcName,
      birthYear,
      tokens: [],
      createdAt: Date.now(),
      lastLogin: Date.now(),
      hasDemoServer: false,
    };
    this.applyRef(user, body, opts);
    this.users.push(user);
    if (invite) this.invites = this.invites.filter((i) => i !== invite);
    await this.save();
    return { user, token: await this.createSession(user), created: true, invite };
  }

  // ----- sessions -----

  async createSession(user) {
    const token = randomToken(32);
    const now = Date.now();
    this.sessions.set(sha256(token), { userId: user.id, expires: now + SESSION_TTL, createdAt: now, lastSeen: now });
    await this.saveSessions();
    return token;
  }

  /** The session store key for a cookie token (what listSessions/revoke compare against). */
  sessionHash(token) {
    return sha256(String(token || ''));
  }

  userFromSession(token) {
    if (!token) return null;
    const s = this.sessions.get(sha256(token));
    if (!s || s.expires < Date.now()) return null;
    const user = this.users.find((u) => u.id === s.userId) || null;
    if (!user || user.disabled) return null;
    // Sliding renewal + last-seen, throttled to once an hour so the busiest route (GET /api/auth/me on every
    // dashboard load) doesn't rewrite the sessions file on every hit. A session past half its 30-day TTL gets
    // a fresh 30 days, so an account in regular use never expires. 2FA plays no part here: the code is only
    // asked for at a fresh login, never for an already-valid session. Tradeoff: the cookie's Max-Age only
    // catches up on the next sign-in or account switch (signInCookies), so a browser that stays logged in for
    // months may have its cookie expire client-side before the server session does — it then just signs in
    // again. A failed save never logs anybody out: the in-memory session is already renewed.
    const now = Date.now();
    s.lastSeen = now;
    if (now - (s.lastSavedAt || s.createdAt || 0) > 3600000) {
      s.lastSavedAt = now;
      if (s.expires - now < SESSION_TTL / 2) {
        s.expires = now + SESSION_TTL;
        this.renewed = { hash: sha256(token) }; // GET /api/auth/me re-issues the cookie with a fresh 30-day Max-Age
      }
      this.saveSessions().catch(() => {});
    }
    return user;
  }

  /** This account's still-valid sessions, most recently used first, for Account → Security. */
  listSessions(user, currentHash = '') {
    return [...this.sessions.entries()]
      .filter(([, s]) => s.userId === user.id && s.expires > Date.now())
      .map(([hash, s]) => ({
        id: hash.slice(0, 12),
        createdAt: s.createdAt || null,
        lastSeen: s.lastSeen || s.createdAt || null,
        current: hash === currentHash,
      }))
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  }

  /**
   * What userFromSession renewed on the last hit, as the cookie token to re-issue (null when nothing was renewed).
   * Only the session token itself is kept (it's a hash on disk anyway), for the hour-throttled GET /api/auth/me
   * cookie refresh; the token never leaves the server memory.
   */
  renewedSession(token) {
    const h = sha256(String(token || ''));
    return this.renewed && this.renewed.hash === h ? { token } : null;
  }

  /** Signs one session of this account out (by the short id from listSessions). False if it's already gone. */
  async revokeSession(user, id) {
    for (const [hash, s] of this.sessions) {
      if (s.userId === user.id && hash.startsWith(String(id || ''))) {
        this.sessions.delete(hash);
        await this.saveSessions();
        return true;
      }
    }
    return false;
  }

  /** "Sign out everywhere else": every session of this account except the current one. Returns how many died. */
  async revokeOtherSessions(user, currentHash = '') {
    let n = 0;
    for (const [hash, s] of this.sessions) {
      if (s.userId === user.id && hash !== currentHash) {
        this.sessions.delete(hash);
        n++;
      }
    }
    if (n) await this.saveSessions();
    return n;
  }

  async logout(token) {
    if (token && this.sessions.delete(sha256(token))) await this.saveSessions();
  }

  // ----- API tokens (for deploying from builds) -----

  async createApiToken(user, name) {
    if (user.tokens.length >= 20) throw httpError(400, 'You can have at most 20 API tokens. Delete one first.');
    const token = `th_${randomToken(32)}`;
    user.tokens.push({ id: randomToken(6), name: String(name || 'Token').slice(0, 60), hash: sha256(token), createdAt: Date.now() });
    await this.save();
    return token;
  }

  listApiTokens(user) {
    return user.tokens.map(({ id, name, createdAt, lastUsed }) => ({ id, name, createdAt, lastUsed }));
  }

  async deleteApiToken(user, id) {
    user.tokens = user.tokens.filter((t) => t.id !== id);
    await this.save();
  }

  userFromApiToken(token) {
    if (!token || !/^(th|mcpt)_/.test(token)) return null;
    const hash = sha256(token);
    for (const u of this.users) {
      if (u.disabled || u.restriction) continue;
      const t = u.tokens.find((x) => x.hash === hash);
      if (t) {
        t.lastUsed = Date.now();
        return u;
      }
    }
    return null;
  }
}

module.exports = { Auth, isStaff, ROLES };
