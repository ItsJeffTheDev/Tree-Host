'use strict';
// Team mode accounts: users, invite links, login sessions and personal API tokens.
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { DATA } = require('./paths');

const USERS_FILE = path.join(DATA, 'team-users.json');
const SESSIONS_FILE = path.join(DATA, 'team-sessions.json');
const SESSION_TTL = 30 * 86400000;
const INVITE_TTL = 7 * 86400000;
const RATE_WINDOW = 15 * 60000;
const RATE_MAX = 10;
const SCRYPT = { N: 16384, r: 8, p: 1 };

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });
const ROLES = ['admin', 'dev', 'tester'];
const cleanRole = (r) => (ROLES.includes(r) ? r : 'dev');

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
}

function validateMcName(n) {
  if (n && !/^[A-Za-z0-9_]{3,16}$/.test(n)) throw httpError(400, 'Minecraft name must be 3-16 letters, numbers or _');
}

class Auth {
  constructor() {
    this.users = [];
    this.invites = [];
    this.sessions = new Map();
    this.attempts = new Map();
    this.setupCode = null;
    this.settings = { allowSignup: true };
  }

  async init() {
    try {
      const d = JSON.parse(await fsp.readFile(USERS_FILE, 'utf8'));
      this.users = d.users || [];
      this.invites = (d.invites || []).filter((i) => i.expires > Date.now());
      this.settings = { ...this.settings, ...(d.settings || {}) };
    } catch {
      /* no team yet */
    }
    try {
      const list = JSON.parse(await fsp.readFile(SESSIONS_FILE, 'utf8'));
      for (const [hash, s] of list) if (s.expires > Date.now()) this.sessions.set(hash, s);
    } catch {
      /* no sessions yet */
    }
    if (!this.users.length) this.setupCode = crypto.randomInt(10000000, 99999999).toString();
  }

  async write(file, data) {
    await fsp.mkdir(DATA, { recursive: true });
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
    await fsp.rename(tmp, file);
  }

  save() {
    return this.write(USERS_FILE, { users: this.users, invites: this.invites, settings: this.settings });
  }

  saveSessions() {
    return this.write(SESSIONS_FILE, [...this.sessions]);
  }

  publicUser(u) {
    return { id: u.id, username: u.username, role: u.role, mcName: u.mcName || '', createdAt: u.createdAt };
  }

  /** Minecraft names of approved members (pending sign-ups are left out). */
  mcNames() {
    return this.users.filter((u) => u.role !== 'pending').map((u) => u.mcName).filter(Boolean);
  }

  userById(id) {
    return this.users.find((u) => u.id === id) || null;
  }

  firstAdmin() {
    return this.users.find((u) => u.role === 'admin') || null;
  }

  pendingCount() {
    return this.users.filter((u) => u.role === 'pending').length;
  }

  async setSettings({ allowSignup }) {
    if (allowSignup !== undefined) this.settings.allowSignup = !!allowSignup;
    await this.save();
    return this.settings;
  }

  /** Anyone can request an account; it stays "pending" until an admin approves it. */
  async signup(body, ip) {
    if (!this.users.length) throw httpError(400, 'The team is not set up yet.');
    if (!this.settings.allowSignup) throw httpError(403, 'Sign-ups are closed. Ask an admin for an invite link.');
    this.checkRate([`signup:${ip}`]);
    this.recordFailure([`signup:${ip}`]);
    const user = await this.createUser(body, 'pending');
    return this.createSession(user);
  }

  async approve(id, role) {
    const user = this.userById(id);
    if (!user) throw httpError(404, 'User not found');
    user.role = cleanRole(role);
    await this.save();
    return user;
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

  async createUser({ username, password, mcName }, role) {
    validateUsername(username);
    validatePassword(password);
    mcName = String(mcName || '').trim();
    validateMcName(mcName);
    if (this.users.some((u) => u.username.toLowerCase() === String(username).toLowerCase())) {
      throw httpError(400, 'That username is taken');
    }
    const user = {
      id: randomToken(6),
      username: String(username),
      passHash: await hashPassword(password),
      role,
      mcName,
      tokens: [],
      createdAt: Date.now(),
    };
    this.users.push(user);
    await this.save();
    return user;
  }

  async setup(body, ip) {
    if (this.users.length) throw httpError(400, 'The team is already set up. Sign in instead.');
    this.checkRate([`setup:${ip}`]);
    if (!this.setupCode || String(body.code || '').trim() !== this.setupCode) {
      this.recordFailure([`setup:${ip}`]);
      throw httpError(403, 'Wrong setup code. It is shown in the team server window.');
    }
    const user = await this.createUser(body, 'admin');
    this.setupCode = null;
    return this.createSession(user);
  }

  async login({ username, password }, ip) {
    const keys = [`ip:${ip}`, `user:${String(username || '').toLowerCase()}`];
    this.checkRate(keys);
    const user = this.users.find((u) => u.username.toLowerCase() === String(username || '').toLowerCase());
    const ok = user ? await verifyPassword(password, user.passHash) : await verifyPassword(password, 'scrypt$AAAA$AAAA');
    if (!user || !ok) {
      this.recordFailure(keys);
      throw httpError(401, 'Wrong username or password', 'LOGIN');
    }
    return this.createSession(user);
  }

  async createInvite(byUser, role) {
    const token = randomToken(24);
    this.invites.push({
      hash: sha256(token),
      role: cleanRole(role),
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

  async updateUser(user, { mcName, password, currentPassword }) {
    if (mcName !== undefined) {
      mcName = String(mcName).trim();
      validateMcName(mcName);
      user.mcName = mcName;
    }
    if (password) {
      if (!(await verifyPassword(currentPassword, user.passHash))) throw httpError(400, 'Current password is wrong');
      validatePassword(password);
      user.passHash = await hashPassword(password);
    }
    await this.save();
  }

  /** Changes a member's role (the last admin can't be demoted). */
  async setRole(id, role) {
    const user = this.userById(id);
    if (!user || user.role === 'pending') throw httpError(404, 'User not found');
    role = cleanRole(role);
    if (user.role === 'admin' && role !== 'admin' && this.users.filter((u) => u.role === 'admin').length === 1) {
      throw httpError(400, 'You cannot demote the last admin. Make someone else an admin first.');
    }
    user.role = role;
    await this.save();
    return user;
  }

  async removeUser(id) {
    const user = this.users.find((u) => u.id === id);
    if (!user) throw httpError(404, 'User not found');
    if (user.role === 'admin' && this.users.filter((u) => u.role === 'admin').length === 1) {
      throw httpError(400, 'You cannot remove the last admin');
    }
    this.users = this.users.filter((u) => u !== user);
    for (const [hash, s] of this.sessions) if (s.userId === id) this.sessions.delete(hash);
    await this.save();
    await this.saveSessions();
    return user;
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
    return this.users.find((u) => u.id === s.userId) || null;
  }

  async logout(token) {
    if (token && this.sessions.delete(sha256(token))) await this.saveSessions();
  }

  // ----- API tokens (for deploying from builds) -----

  async createApiToken(user, name) {
    const token = `mcpt_${randomToken(32)}`;
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
    if (!token || !token.startsWith('mcpt_')) return null;
    const hash = sha256(token);
    for (const u of this.users) {
      const t = u.tokens.find((x) => x.hash === hash);
      if (t) {
        t.lastUsed = Date.now();
        return u;
      }
    }
    return null;
  }
}

module.exports = { Auth };
