'use strict';
// Accounts: customers (public sign-up), staff and admins; login sessions, staff invite links,
// password resets and personal API tokens.
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { DATA } = require('./paths');
const store = require('./store');
const firebase = require('./firebase');

const SESSIONS_FILE = path.join(DATA, 'team-sessions.json');
const SESSION_TTL = 30 * 86400000;
const INVITE_TTL = 7 * 86400000;
const RESET_TTL = 60 * 60000;
const RATE_WINDOW = 15 * 60000;
const RATE_MAX = 10;
const SCRYPT = { N: 16384, r: 8, p: 1 };

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

// admin: runs Tree Host. staff: support (can help with any server). customer: everyone who signs up.
const ROLES = ['admin', 'staff', 'customer'];
const STAFF_ROLES = ['admin', 'staff'];
const cleanRole = (r) => (ROLES.includes(r) ? r : 'customer');
const isStaff = (u) => !!u && STAFF_ROLES.includes(u.role);

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

function validateUsername(u) {
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(String(u || ''))) throw httpError(400, 'Username must be 3-32 letters, numbers, dots, dashes or _');
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
    this.attempts = new Map();
    this.settings = { allowSignup: true };
    // Who becomes an admin: the emails in TREEHOST_ADMIN_EMAILS (once the email is verified).
    // allowFirstAdmin (local testing only): the very first account becomes an admin.
    this.adminEmails = new Set(
      String(process.env.TREEHOST_ADMIN_EMAILS || '')
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    );
    this.allowFirstAdmin = false;
  }

  async init() {
    const d = (await store.load('team-users')) || {};
    // The Realtime Database drops empty arrays: put them back.
    this.users = Object.values(d.users || {}).map((u) => ({ ...u, tokens: Object.values(u.tokens || {}) }));
    this.invites = Object.values(d.invites || {}).filter((i) => i.expires > Date.now());
    this.resets = Object.values(d.resets || {}).filter((r) => r.expires > Date.now());
    this.settings = { ...this.settings, ...(d.settings || {}) };
    // Roles from the old team-only version.
    let migrated = false;
    for (const u of this.users) {
      if (u.role === 'dev' || u.role === 'tester') (u.role = 'staff'), (migrated = true);
      if (u.role === 'pending') (u.role = 'customer'), (migrated = true);
    }
    if (migrated) await this.save();
    try {
      const list = JSON.parse(await fsp.readFile(SESSIONS_FILE, 'utf8'));
      for (const [hash, s] of list) if (s.expires > Date.now()) this.sessions.set(hash, s);
    } catch {
      /* no sessions yet */
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
    return this.write(SESSIONS_FILE, [...this.sessions]);
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
      disabled: !!u.disabled,
      lastLogin: u.lastLogin || null,
    };
  }

  /** Minecraft names of support staff and admins (only used by the local personal mode). */
  mcNames() {
    return this.users.filter((u) => isStaff(u) && !u.disabled).map((u) => u.mcName).filter(Boolean);
  }

  userById(id) {
    return this.users.find((u) => u.id === id) || null;
  }

  firstAdmin() {
    return this.users.find((u) => u.role === 'admin') || null;
  }

  async setSettings({ allowSignup }) {
    if (allowSignup !== undefined) this.settings.allowSignup = !!allowSignup;
    await this.save();
    return this.settings;
  }

  /** Public sign-up: creates a customer account right away. */
  async signup(body, ip) {
    if (!this.settings.allowSignup) throw httpError(403, 'Sign-ups are closed right now. Please try again later.');
    if (!body.acceptTerms) throw httpError(400, 'Please accept the Terms of Service and Privacy Policy.');
    this.checkRate([`signup:${ip}`]);
    this.recordFailure([`signup:${ip}`]);
    if (!cleanEmail(body.email)) throw httpError(400, 'Enter your email address');
    const first = !this.users.some((u) => u.role === 'admin');
    const user = await this.createUser(body, first && this.allowFirstAdmin ? 'admin' : 'customer');
    return { user, token: await this.createSession(user) };
  }

  // ----- rate limiting -----

  checkRate(keys) {
    const now = Date.now();
    for (const key of keys) {
      const recent = (this.attempts.get(key) || []).filter((t) => now - t < RATE_WINDOW);
      this.attempts.set(key, recent);
      if (recent.length >= RATE_MAX) throw httpError(429, 'Too many attempts. Try again in 15 minutes.');
    }
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

  async login({ username, password }, ip) {
    const keys = [`ip:${ip}`, `user:${String(username || '').toLowerCase()}`];
    this.checkRate(keys);
    const user = this.findByLogin(username);
    const ok = user ? await verifyPassword(password, user.passHash) : await verifyPassword(password, 'scrypt$AAAA$AAAA');
    if (!user || !ok) {
      this.recordFailure(keys);
      throw httpError(401, 'Wrong username, email or password', 'LOGIN');
    }
    if (user.disabled) throw httpError(403, 'This account has been suspended. Contact support.', 'DISABLED');
    user.lastLogin = Date.now();
    this.save().catch(() => {});
    return this.createSession(user);
  }

  /** Invite links add support staff or admins. Customers sign up on the website. */
  async createInvite(byUser, role) {
    const token = randomToken(24);
    this.invites.push({
      hash: sha256(token),
      role: role === 'admin' ? 'admin' : 'staff',
      createdBy: byUser.username,
      expires: Date.now() + INVITE_TTL,
    });
    await this.save();
    return token;
  }

  async acceptInvite(body, ip) {
    this.checkRate([`invite:${ip}`]);
    const hash = sha256(body.invite || '');
    const invite = this.invites.find((i) => i.hash === hash && i.expires > Date.now());
    if (!invite) {
      this.recordFailure([`invite:${ip}`]);
      throw httpError(400, 'This invite link is invalid or has expired. Ask an admin for a new one.');
    }
    const user = await this.createUser(body, invite.role);
    this.invites = this.invites.filter((i) => i !== invite);
    await this.save();
    return this.createSession(user);
  }

  async updateUser(user, { mcName, email, password, currentPassword }) {
    if (mcName !== undefined) {
      mcName = String(mcName).trim();
      validateMcName(mcName);
      user.mcName = mcName;
    }
    if (email !== undefined) {
      email = cleanEmail(email);
      if (!email && user.role === 'customer') throw httpError(400, 'Enter your email address');
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

  /** Changes someone's role (the last admin can't be demoted). */
  async setRole(id, role) {
    const user = this.userById(id);
    if (!user) throw httpError(404, 'User not found');
    role = cleanRole(role);
    if (user.role === 'admin' && role !== 'admin' && this.users.filter((u) => u.role === 'admin').length === 1) {
      throw httpError(400, 'You cannot demote the last admin. Make someone else an admin first.');
    }
    user.role = role;
    await this.save();
    return user;
  }

  /** Suspends or re-enables an account (suspended accounts are signed out everywhere). */
  async setDisabled(id, disabled) {
    const user = this.userById(id);
    if (!user) throw httpError(404, 'User not found');
    if (user.role === 'admin' && disabled) throw httpError(400, 'Admins cannot be suspended. Change their role first.');
    user.disabled = !!disabled;
    if (disabled) this.dropSessions(id);
    await this.save();
    await this.saveSessions();
    return user;
  }

  async removeUser(id) {
    const user = this.users.find((u) => u.id === id);
    if (!user) throw httpError(404, 'User not found');
    if (user.role === 'admin' && this.users.filter((u) => u.role === 'admin').length === 1) {
      throw httpError(400, 'You cannot remove the last admin');
    }
    this.users = this.users.filter((u) => u !== user);
    this.dropSessions(id);
    await this.save();
    await this.saveSessions();
    return user;
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
  async firebaseLogin(body, ip) {
    this.checkRate([`fb:${ip}`]);
    const id = await firebase.verifyIdToken(body.idToken);
    let user = this.findByFirebase(id.uid);
    if (!user && id.email && (id.emailVerified || id.provider === 'google.com')) {
      user = this.users.find((u) => !u.firebaseUid && u.email === id.email) || null;
      if (user) user.firebaseUid = id.uid;
    }
    const isOwner = this.isAdminEmail(id);
    if (user) {
      if (user.disabled) throw httpError(403, 'This account has been suspended. Contact support.', 'DISABLED');
      if (id.email && user.email !== id.email) user.email = id.email;
      if (isOwner && user.role !== 'admin') user.role = 'admin';
      user.lastLogin = Date.now();
      await this.save();
      return { user, token: await this.createSession(user) };
    }

    // A new account.
    let role = 'customer';
    let invite = null;
    if (isOwner || (this.allowFirstAdmin && !this.users.some((u) => u.role === 'admin'))) {
      role = 'admin';
    } else if (body.invite) {
      invite = this.invites.find((i) => i.hash === sha256(body.invite) && i.expires > Date.now());
      if (!invite) throw httpError(400, 'This invite link is invalid or has expired. Ask an admin for a new one.');
      role = invite.role;
    } else if (!this.settings.allowSignup) {
      throw httpError(403, 'Sign-ups are closed right now. Please try again later.');
    }
    const suggested = (id.name || id.email.split('@')[0] || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 32);
    if (!body.username) return { needsProfile: true, email: id.email, suggested };
    if (role === 'customer' && !body.acceptTerms) throw httpError(400, 'Please accept the Terms of Service and Privacy Policy.');
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
      role,
      mcName,
      tokens: [],
      createdAt: Date.now(),
      lastLogin: Date.now(),
    };
    this.users.push(user);
    if (invite) this.invites = this.invites.filter((i) => i !== invite);
    await this.save();
    return { user, token: await this.createSession(user), created: true };
  }

  // ----- sessions -----

  async createSession(user) {
    const token = randomToken(32);
    this.sessions.set(sha256(token), { userId: user.id, expires: Date.now() + SESSION_TTL });
    await this.saveSessions();
    return token;
  }

  userFromSession(token) {
    if (!token) return null;
    const s = this.sessions.get(sha256(token));
    if (!s || s.expires < Date.now()) return null;
    const user = this.users.find((u) => u.id === s.userId) || null;
    return user && !user.disabled ? user : null;
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
      if (u.disabled) continue;
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
