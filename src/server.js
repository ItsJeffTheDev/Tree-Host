'use strict';
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { URL } = require('url');
const { PUBLIC, DATA } = require('./paths');
const { Manager } = require('./instances');
const { Auth } = require('./auth');
const { Rbac, PERMISSIONS } = require('./rbac');
const { Billing, durationText } = require('./billing');
const mail = require('./mail');
const firebase = require('./firebase');
const store = require('./store');
const { migrateTeamData } = require('./migrate');
const { keepAwake } = require('./keepawake');
const providers = require('./providers');
const java = require('./java');
const { Activity } = require('./activity');
const backups = require('./backups');
const modrinth = require('./modrinth');

const env = (name, fallback) => process.env[`TREEHOST_${name}`] ?? process.env[`MCPT_${name}`] ?? fallback;
// Production: the public website address (e.g. https://treehost.online). Turns on accounts, billing and the landing page.
const PUBLIC_URL = (env('PUBLIC_URL', '') || '').replace(/\/$/, '') || null;
const HOSTED = !!PUBLIC_URL;
// Accounts mode: logins required (always on when hosted; TREEHOST_TEAM=1 for a private team setup).
const TEAM = env('TEAM') === '1' || HOSTED;
const PORT = Number(env('PORT')) || (TEAM ? 8766 : 8765);
// Hosted: only the reverse proxy (Caddy) on this machine talks to us. Team: the local network too.
const HOST = env('HOST') || (HOSTED ? '127.0.0.1' : TEAM ? '0.0.0.0' : '127.0.0.1');
const NO_OPEN = process.argv.includes('--no-open') || HOSTED;
const LOCAL_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const SESSION_COOKIE = 'th_session';
const MAX_CUSTOMER_BACKUPS = Number(env('MAX_BACKUPS')) || 5;
// Inboxes shown on the website and used as Reply-To on emails.
const EMAILS = {
  support: env('SUPPORT_EMAIL', 'support@treehost.online'),
  billing: env('BILLING_EMAIL', 'billing@treehost.online'),
  promo: env('PROMO_EMAIL', 'promotion@treehost.online'),
};
// In personal mode everyone who can reach the dashboard is the PC's owner.
const LOCAL_ADMIN = { id: 'local', username: 'you', role: 'owner', local: true };

const manager = new Manager();
const auth = new Auth();
const rbac = new Rbac();
const billing = new Billing();
const activity = new Activity();
manager.teamMode = TEAM;
// A test site on this PC (http://localhost...) may run customer servers without Docker; the real site never does.
if (HOSTED && /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(PUBLIC_URL + '/')) manager.allowUnsafe = true;
manager.activity = activity;
// Who gets whitelisted on a server: everyone for team servers, only the owner for solo servers.
// "Whitelist me" on a server whitelists its owner (personal mode: everyone in the old team list).
manager.accessNames = (inst) => {
  if (TEAM || inst.cfg.space === 'solo') {
    const owner = auth.userById(inst.cfg.owner);
    return owner && owner.mcName ? [owner.mcName] : [];
  }
  return auth.mcNames();
};
manager.ownerName = (id) => (auth.userById(id) || {}).username || null;

// ---------- billing <-> servers ----------

manager.overheadMb = require('./billing').OVERHEAD_MB;
manager.planInfo = (inst) => {
  const sub = inst.cfg.subscriptionId ? billing.sub(inst.cfg.subscriptionId) : null;
  if (!sub) return null;
  return { planName: sub.planName, ramMb: sub.ramMb, cpus: sub.cpus, diskGb: sub.diskGb, status: sub.status, usable: billing.usable(sub), renewsAt: sub.periodEnd || null };
};
manager.startBlock = (inst) => {
  if (!inst.isCustomer) return null;
  const sub = inst.cfg.subscriptionId ? billing.sub(inst.cfg.subscriptionId) : null;
  if (!sub) return 'this server has no plan. Contact support.';
  if (!billing.usable(sub)) {
    return sub.status === 'canceled'
      ? 'the plan for this server was canceled. Buy a plan in Billing to keep using it.'
      : 'the payment for this server failed. Update your card in Billing to start it again.';
  }
  if (sub.diskGb && inst.diskUsedMb && inst.diskUsedMb > sub.diskGb * 1024 * 1.1) {
    return `the server uses ${(inst.diskUsedMb / 1024).toFixed(1)} GB of disk, more than the ${sub.diskGb} GB in its plan. Delete old worlds or files first.`;
  }
  return null;
};
billing.hooks.suspend = (sub, reason) => {
  const inst = manager.instances.get(sub.serverId);
  if (!inst || inst.cfg.suspended === reason) return;
  inst.cfg.suspended = reason;
  manager.save();
  inst.sysLog(reason === 'canceled' ? 'The plan for this server ended, so it was stopped.' : 'The payment for this server failed, so it was stopped. Update your card in Billing.');
  if (inst.proc) inst.stop();
  inst.emitStatus();
};
billing.hooks.unsuspend = (sub) => {
  const inst = manager.instances.get(sub.serverId);
  if (!inst || !inst.cfg.suspended) return;
  inst.cfg.suspended = null;
  manager.save();
  inst.sysLog('Payment received: the server can be started again.');
  inst.emitStatus();
};
billing.hooks.deleteServer = async (id) => {
  const inst = manager.instances.get(id);
  if (!inst) return;
  activity.log('billing', 'Tree Host', `deleted the server "${inst.cfg.name}" of ${manager.ownerName(inst.cfg.owner) || 'a customer'} (plan ended)`);
  await manager.remove(id);
};
billing.hooks.userById = (id) => auth.userById(id);
billing.hooks.notify = (kind, sub, text) => activity.log(kind, (auth.userById(sub.userId) || {}).username || 'A customer', text);
billing.hooks.email = (user, subject, paragraphs) =>
  mail.send(user.email, subject, [...paragraphs, `Questions about billing? Just reply to this email or write to ${EMAILS.billing}.`],
    PUBLIC_URL ? { text: 'Open Billing', url: `${PUBLIC_URL}/dashboard?billing` } : null, { replyTo: EMAILS.billing });

// ---------- tiny router ----------

const routes = [];
const HANDLED = Symbol('handled');

/** opts.public: no login needed. opts.perm: the permission needed (see rbac.js). */
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler, opts });
}

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

async function readJson(req, limit = 2 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('Request too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function readRaw(req, limit) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('Request too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Error text for the browser: never shows host paths (like the data folder) or the names of the services behind
 * Tree Host to anyone without system info access. They get a plain message; the details go to the server log.
 */
const INTERNAL_WORDS = /firebase|realtime database|docker|container|stripe|resend|caddy|service account|ENOENT|EACCES|ECONNREFUSED/i;
function publicMessage(e, user) {
  let msg = (e && e.message) || String(e);
  if (TEAM && !can(user, 'system.view')) {
    if (INTERNAL_WORDS.test(msg) || (e && e.status === 500)) {
      console.error(`[Tree Host] error shown generically to ${user ? user.username : 'a visitor'}: ${msg}`);
      return 'Something went wrong on our side. Please try again in a minute, and contact support if it keeps happening.';
    }
    for (const p of [DATA, path.resolve(DATA)]) msg = msg.split(p).join('…');
    msg = msg.replace(/[A-Za-z]:\\[^\s'"]+|\/(?:home|opt|var|srv|root|tmp)\/[^\s'"]+/g, '…');
  }
  return msg;
}

function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function openInOs(target) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['explorer.exe', [target]]
      : process.platform === 'darwin'
        ? ['open', [target]]
        : ['xdg-open', [target]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

// ---------- auth helpers ----------

/** True for requests from this machine, which is where the reverse proxy (Caddy) connects from. */
function fromThisPc(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

// Forwarding headers are only trusted from the local reverse proxy; anyone else could fake them.
// Caddy replaces X-Forwarded-For with the real client address, but passes CF-Connecting-IP through untouched,
// so that one is only trusted when the site really sits behind Cloudflare's proxy (TREEHOST_TRUST_CLOUDFLARE=1).
const TRUST_CLOUDFLARE = env('TRUST_CLOUDFLARE') === '1';
function clientIp(req) {
  if (fromThisPc(req)) {
    const fwd = (TRUST_CLOUDFLARE && req.headers['cf-connecting-ip']) || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}

function lanUrls() {
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))
    .map((i) => `http://${i.address}:${PORT}`);
  return [`http://${os.hostname()}:${PORT}`, ...ips];
}

function getCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function isHttps(req) {
  return (
    fromThisPc(req) &&
    (req.headers['x-forwarded-proto'] === 'https' || /\.(trycloudflare\.com|ts\.net)(:\d+)?$/.test(req.headers.host || ''))
  );
}

const publicUrl = () => PUBLIC_URL;

function sessionCookie(req, token, maxAge = 30 * 86400) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}

function authenticate(req) {
  if (!TEAM) return LOCAL_ADMIN;
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  if (bearer) return auth.userFromApiToken(bearer[1]);
  return auth.userFromSession(getCookie(req, SESSION_COOKIE));
}

// ---------- role-based access control (see rbac.js) ----------

/** True if this user has the permission. Personal mode (no accounts) can do everything. */
const can = (user, permission) => !TEAM || rbac.can(user, permission);

function requirePerm(req, permission) {
  if (!can(req.user, permission)) {
    const p = PERMISSIONS.find((x) => x.id === permission);
    throw httpError(403, `You don't have access to that${p ? ` (needs: ${p.label})` : ''}.`, 'FORBIDDEN');
  }
}

/** Customers see only their own servers; staff with servers.viewAll see every server (to help). */
function canView(user, inst) {
  if (!TEAM) return true;
  if (!user || !inst) return false;
  return inst.cfg.owner === user.id || can(user, 'servers.viewAll');
}

/**
 * What someone may do with a server they can see. Everyone may do everything on their own servers (host-level
 * settings are checked separately). On other people's servers it depends on their role's permissions.
 */
const ACTION_PERMISSION = {
  control: 'servers.operate',
  command: 'servers.operate',
  plugins: 'servers.edit',
  files: 'servers.edit',
  settings: 'servers.edit',
  deploy: 'servers.edit',
  manage: 'servers.destroy',
};
const ACTION_TEXT = {
  control: 'start or stop servers',
  command: 'run console commands',
  plugins: 'change plugins',
  files: 'edit server files',
  settings: 'change server settings',
  deploy: 'deploy plugins',
  manage: 'delete this server, reset its world or change its version',
};

function permissionError(user, action, inst) {
  if (!TEAM) return null;
  if (!user) return 'Please sign in.';
  if (action === 'view' || (inst && inst.cfg.owner === user.id)) return null;
  if (!rbac.isStaff(user)) return 'That is not your server.';
  const perm = ACTION_PERMISSION[action];
  return perm && !can(user, perm) ? `Your role can't ${ACTION_TEXT[action] || action} on other people's servers.` : null;
}

function getFor(req, id, action = 'view') {
  const inst = manager.get(id);
  if (!canView(req.user, inst)) throw httpError(404, 'Server not found');
  const denied = permissionError(req.user, action, inst);
  if (denied) throw httpError(403, denied);
  return inst;
}

function visibleList(user) {
  return [...manager.instances.values()].filter((i) => canView(user, i)).map((i) => i.toJSON());
}

function publicOrigin(req) {
  return `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
}

/** Settings that point at files or programs on the host machine need servers.host. */
function checkHostSettings(req, body) {
  if (can(req.user, 'servers.host')) return;
  if (body.java !== undefined && !/^(auto|\d+)$/.test(String(body.java))) throw httpError(403, 'Only people with host access can set a custom Java path.');
  if (body.customJar) throw httpError(403, 'Only people with host access can use a custom server jar from the host machine.');
  if (body.type === 'custom') throw httpError(403, 'Only people with host access can create Custom JAR servers.');
}

/** Staff can only manage people below their own role (Owners can manage everyone). */
function requireOutranks(req, targetId) {
  const target = auth.userById(targetId);
  if (!target || !TEAM || req.user.role === 'owner') return;
  if (rbac.level(target.role) >= rbac.level(req.user.role)) {
    throw httpError(403, `Only someone above ${rbac.role(target.role).label} can do that to this account.`);
  }
}

/** Records a staff action in the audit log (only visible with audit.view). `inst`: the server it was about, if any. */
function audit(req, text, inst = null) {
  if (TEAM) activity.log('audit', who(req), text, inst);
}

// ---------- Server-sent events ----------

const clients = new Map(); // response -> signed-in user
const pendingLogs = new Map();

function broadcast(event, data, inst) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [res, user] of clients) if (!inst || canView(user, inst)) res.write(msg);
}

manager.on('status', (inst) => broadcast('status', inst.toJSON(), inst));
manager.on('removed', (id) => broadcast('removed', { id }));

/** Customers see their own servers' activity; staff see server events; sign-ups and billing need activity.viewAll. */
function canSeeEvent(user, e) {
  if (!TEAM) return true;
  if (!user) return false;
  if (e.kind === 'audit') return can(user, 'audit.view');
  if (e.kind === 'people' || e.kind === 'billing') return can(user, 'activity.viewAll');
  if (e.owner && e.owner === user.id) return true;
  return can(user, 'servers.viewAll') || can(user, 'activity.viewAll');
}
activity.listeners.add((e) => {
  const msg = `event: activity\ndata: ${JSON.stringify(e)}\n\n`;
  for (const [res, user] of clients) if (canSeeEvent(user, e)) res.write(msg);
});
const who = (req) => (req.user && !req.user.local ? req.user.username : 'You');
manager.on('log', (id, line) => {
  if (!pendingLogs.has(id)) pendingLogs.set(id, []);
  pendingLogs.get(id).push(line);
});
setInterval(() => {
  for (const [id, lines] of pendingLogs) {
    const inst = manager.instances.get(id);
    if (inst) broadcast('log', { id, lines }, inst);
  }
  pendingLogs.clear();
}, 100);
setInterval(() => {
  for (const res of clients.keys()) res.write(': ping\n\n');
}, 20000);

// ---------- auth & team API ----------

route(
  'GET',
  '/api/auth/me',
  (req) => {
    const user = authenticate(req);
    return {
      teamMode: TEAM,
      user: user ? { ...(user.local ? user : auth.publicUser(user)), roleLabel: rbac.role(user.role).label, permissions: TEAM ? rbac.permissionsOf(user) : PERMISSIONS.map((x) => x.id) } : null,
      publicUrl: publicUrl(),
      hosted: HOSTED,
      allowSignup: TEAM && auth.settings.allowSignup,
      mailEnabled: mail.enabled(),
      firebase: TEAM ? firebase.publicConfig() : null,
      billingMode: billing.mode,
      isolated: manager.docker,
      lanUrls: TEAM && !HOSTED && HOST !== '127.0.0.1' && user && can(user, 'system.view') ? lanUrls() : [],
    };
  },
  { public: true },
);

// Sign-in with Firebase (email/password or Google): the browser sends its Firebase ID token.
route(
  'POST',
  '/api/auth/firebase',
  async (req, res) => {
    if (!TEAM) throw httpError(400, 'Accounts only exist on a hosted Tree Host.');
    const r = await auth.firebaseLogin(await readJson(req), clientIp(req));
    if (!r.token) return r;
    if (r.created) activity.log('people', r.user.username, r.user.role === 'customer' ? 'signed up' : `joined as ${r.user.role}`);
    sendJson(res, 200, { ok: true, created: !!r.created }, { 'Set-Cookie': sessionCookie(req, r.token) });
    return HANDLED;
  },
  { public: true },
);

/** With Firebase sign-in on, the old password endpoints are closed. */
function passwordAuthOnly() {
  if (firebase.authEnabled()) throw httpError(400, 'Please use the sign-in form.', 'USE_FIREBASE');
}

route(
  'POST',
  '/api/auth/login',
  async (req, res) => {
    passwordAuthOnly();
    const token = await auth.login(await readJson(req), clientIp(req));
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token) });
    return HANDLED;
  },
  { public: true },
);

route(
  'POST',
  '/api/auth/accept-invite',
  async (req, res) => {
    passwordAuthOnly();
    const body = await readJson(req);
    const token = await auth.acceptInvite(body, clientIp(req));
    activity.log('people', String(body.username || 'Someone'), 'joined the support staff with an invite link');
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token) });
    return HANDLED;
  },
  { public: true },
);

route(
  'POST',
  '/api/auth/signup',
  async (req, res) => {
    passwordAuthOnly();
    const body = await readJson(req);
    const { user, token } = await auth.signup(body, clientIp(req));
    activity.log('people', user.username, 'signed up');
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token) });
    return HANDLED;
  },
  { public: true },
);

route(
  'POST',
  '/api/auth/forgot',
  async (req) => {
    passwordAuthOnly();
    const { email } = await readJson(req);
    if (!mail.enabled()) throw httpError(400, 'Password reset emails are not set up yet. Please contact support.');
    const r = await auth.createReset(email, clientIp(req));
    if (r) {
      await mail.send(r.user.email, 'Reset your Tree Host password', [
        `Hi ${r.user.username}, someone (hopefully you) asked to reset your Tree Host password.`,
        'The link works for one hour. If you did not ask for this, ignore this email.',
      ], { text: 'Choose a new password', url: `${PUBLIC_URL || publicOrigin(req)}/dashboard?reset=${r.token}` });
    }
    // Same answer either way, so nobody can find out which emails have accounts.
    return { ok: true };
  },
  { public: true },
);
route(
  'POST',
  '/api/auth/reset',
  async (req, res) => {
    passwordAuthOnly();
    const token = await auth.resetPassword(await readJson(req), clientIp(req));
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token) });
    return HANDLED;
  },
  { public: true },
);

route(
  'POST',
  '/api/auth/logout',
  async (req, res) => {
    await auth.logout(getCookie(req, SESSION_COOKIE));
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
    return HANDLED;
  },
  { public: true },
);

route('PATCH', '/api/auth/me', async (req) => {
  if (!TEAM) throw httpError(400, 'Accounts only exist in team mode.');
  const body = await readJson(req);
  if (req.user.firebaseUid) {
    // Email and password belong to the Firebase account.
    delete body.email;
    if (body.password) throw httpError(400, 'Change your password with "Send password reset email".');
  }
  await auth.updateUser(req.user, body);
  return auth.publicUser(req.user);
});
route('GET', '/api/auth/tokens', (req) => (TEAM ? auth.listApiTokens(req.user) : []));
route('POST', '/api/auth/tokens', async (req) => {
  if (!TEAM) throw httpError(400, 'API tokens only exist in team mode.');
  return { token: await auth.createApiToken(req.user, (await readJson(req)).name) };
});
route('DELETE', '/api/auth/tokens/:tid', async (req, res, p) => {
  await auth.deleteApiToken(req.user, p.tid);
  return { ok: true };
});

route(
  'GET',
  '/api/team/users',
  () =>
    auth.users.map((u) => {
      const subs = billing.forUser(u.id);
      return {
        ...auth.publicUser(u),
        servers: [...manager.instances.values()].filter((i) => i.cfg.owner === u.id && i.isCustomer).length,
        activePlans: subs.filter((x) => x.status === 'active' || x.status === 'past_due').map((x) => x.planName),
        roleLabel: rbac.role(u.role).label,
      };
    }),
  { perm: 'users.view' },
);
route(
  'PUT',
  '/api/team/users/:uid/disabled',
  async (req, res, p) => {
    if (p.uid === req.user.id) throw httpError(400, 'You cannot suspend yourself.');
    requireOutranks(req, p.uid);
    const { disabled } = await readJson(req);
    const u = await auth.setDisabled(p.uid, disabled);
    if (disabled) for (const inst of manager.instances.values()) if (inst.cfg.owner === u.id && inst.proc) inst.stop();
    activity.log('people', who(req), `${disabled ? 'suspended' : 'unsuspended'} the account ${u.username}`);
    audit(req, `${disabled ? 'suspended' : 'unsuspended'} the account ${u.username}`);
    return auth.publicUser(u);
  },
  { perm: 'users.manage' },
);
route(
  'POST',
  '/api/team/users/:uid/temp-password',
  async (req, res, p) => {
    requireOutranks(req, p.uid);
    if ((auth.userById(p.uid) || {}).firebaseUid) throw httpError(400, 'This account uses the sign-in form: use "Send password reset email" instead.');
    const password = await auth.tempPassword(p.uid);
    audit(req, `set a temporary password for ${(auth.userById(p.uid) || {}).username}`);
    return { password };
  },
  { perm: 'users.manage' },
);
route(
  'POST',
  '/api/team/invites',
  async (req) => {
    const { role } = await readJson(req);
    rbac.checkRoleChange(req.user, null, role);
    const invite = await auth.createInvite(req.user, role);
    audit(req, `created a ${rbac.role(role).label} invite link`);
    return { link: `${publicOrigin(req)}/?invite=${invite}`, expiresInDays: 7 };
  },
  { perm: 'users.roles' },
);
route(
  'PUT',
  '/api/team/users/:uid/role',
  async (req, res, p) => {
    if (p.uid === req.user.id) throw httpError(400, 'Ask someone else to change your own role.');
    const target = auth.userById(p.uid);
    if (!target) throw httpError(404, 'User not found');
    const role = (await readJson(req)).role;
    rbac.checkRoleChange(req.user, target, role);
    const before = rbac.role(target.role).label;
    const u = await auth.setRole(p.uid, role);
    audit(req, `changed ${u.username}'s role from ${before} to ${rbac.role(u.role).label}`);
    return auth.publicUser(u);
  },
  { perm: 'users.roles' },
);
route('PUT', '/api/team/settings', async (req) => {
  const r = await auth.setSettings(await readJson(req));
  audit(req, `changed site settings (sign-ups ${r.allowSignup ? 'open' : 'closed'})`);
  return r;
}, { perm: 'settings.manage' });
route('GET', '/api/team/settings', () => auth.settings, { perm: 'settings.manage' });
route(
  'DELETE',
  '/api/team/users/:uid',
  async (req, res, p) => {
    if (p.uid === req.user.id) throw httpError(400, 'You cannot remove yourself.');
    requireOutranks(req, p.uid);
    const u = auth.userById(p.uid);
    if (u && billing.forUser(u.id).some((x) => x.status === 'active' || x.status === 'past_due')) {
      throw httpError(400, 'This person still has an active plan. Cancel it in Billing first (or suspend the account instead).');
    }
    for (const inst of [...manager.instances.values()]) if (inst.cfg.owner === p.uid && inst.isCustomer) await manager.remove(inst.cfg.id);
    await auth.removeUser(p.uid);
    if (u && u.firebaseUid) await firebase.deleteAuthUser(u.firebaseUid).catch(() => {});
    if (u) audit(req, `deleted the account ${u.username}`);
    return { ok: true };
  },
  { perm: 'users.manage' },
);

// ---------- activity feed & Discord notifications ----------

route('GET', '/api/activity', (req, res, p, q) => {
  const serverId = q.get('server');
  const limit = Math.min(Number(q.get('limit')) || 100, 500);
  return activity.events
    .filter((e) => canSeeEvent(req.user, e) && (!serverId || e.serverId === serverId))
    .slice(-limit)
    .reverse();
});
route('GET', '/api/team/notifications', () => activity.publicSettings(), { perm: 'settings.manage' });
route('PUT', '/api/team/notifications', async (req) => {
  const r = await activity.setSettings(await readJson(req));
  audit(req, 'changed the Discord notification settings');
  return r;
}, { perm: 'settings.manage' });
route(
  'POST',
  '/api/team/notifications/test',
  async (req) => {
    await activity.testDiscord(who(req));
    return { ok: true };
  },
  { perm: 'settings.manage' },
);

// ---------- plans & billing ----------

route('GET', '/api/plans', () => billing.publicPlans(), { public: true });
// Business details shown on the website, Terms and Privacy pages.
route(
  'GET',
  '/api/site',
  () => ({
    company: env('COMPANY', 'Tree Host'),
    supportEmail: EMAILS.support,
    billingEmail: EMAILS.billing,
    promoEmail: EMAILS.promo,
    jurisdiction: env('JURISDICTION', ''),
    discord: env('DISCORD_INVITE', ''),
    location: env('LOCATION', ''),
    allowSignup: auth.settings.allowSignup,
  }),
  { public: true },
);
route('GET', '/api/billing', (req) => ({
  mode: billing.mode,
  currency: billing.publicPlans().currency,
  hasPortal: !!(req.user.stripeCustomerId && billing.mode !== 'demo'),
  subscriptions: billing.forUser(req.user.id).map((x) => ({
    ...billing.publicSub(x),
    serverName: x.serverId && manager.instances.get(x.serverId) ? manager.instances.get(x.serverId).cfg.name : null,
  })),
}));
route('POST', '/api/billing/checkout', async (req) => {
  if (!TEAM) throw httpError(400, 'Billing only exists on a hosted Tree Host.');
  if (req.user.role === 'customer' && !req.user.email) throw httpError(400, 'Add your email address in Account first.');
  return billing.checkout(req.user, (await readJson(req)).planId, PUBLIC_URL || publicOrigin(req));
});
route('POST', '/api/billing/portal', async (req) => billing.portal(req.user, PUBLIC_URL || publicOrigin(req)));
// Promo codes: customers redeem them in Billing (free plans for creators, partners, giveaways).
route('POST', '/api/billing/redeem', async (req) => {
  if (!TEAM) throw httpError(400, 'Codes only exist on a hosted Tree Host.');
  return billing.publicSub(await billing.redeem(req.user, (await readJson(req)).code));
});
route(
  'GET',
  '/api/admin/promos',
  () => billing.promos.map((p) => {
    const x = billing.publicPromo(p);
    x.redeemedBy = x.redeemedBy.map((u) => ({ ...u, username: (auth.userById(u.userId) || {}).username || '(deleted)' }));
    if (x.forUserId) x.forUsername = (auth.userById(x.forUserId) || {}).username || '(deleted)';
    return x;
  }).reverse(),
  { perm: 'promos.manage' },
);
route('POST', '/api/admin/promos', async (req) => {
  const body = await readJson(req);
  // "forUser": a username, email or account id. The code then only works for that account, once.
  let target = null;
  if (body.forUser || body.forUserId) {
    const key = String(body.forUserId || body.forUser).trim().toLowerCase();
    target = auth.userById(body.forUserId) || auth.users.find((u) => u.username.toLowerCase() === key || (u.email && u.email === key)) || null;
    if (!target) throw httpError(404, `No account called "${body.forUser || body.forUserId}". Use their username or email.`);
  }
  const c = await billing.createPromo({ ...body, forUserId: target ? target.id : null }, req.user.username);
  audit(req, `created promo code ${c.code} (${c.planName}, ${c.length}, ${target ? `only for ${target.username}` : `${c.maxUses} use${c.maxUses === 1 ? '' : 's'}`})`);
  if (target) c.forUsername = target.username;
  // Optionally email the code straight to them.
  if (target && body.email && target.email && mail.enabled()) {
    await mail.send(target.email, 'A free Tree Host server for you', [
      `Hi ${target.username}, you've been given a free ${c.planName} plan on Tree Host${c.days ? ` for ${c.length}` : ' for life'}!`,
      `Your code is ${c.code}. It only works for your account: open Billing, choose "Have a code?", and paste it.`,
    ], PUBLIC_URL ? { text: 'Open Billing', url: `${PUBLIC_URL}/dashboard?billing` } : null, { replyTo: EMAILS.promo }).then(() => (c.emailed = true)).catch(() => (c.emailed = false));
  }
  return c;
}, { perm: 'promos.manage' });
route('DELETE', '/api/admin/promos/:code', async (req, res, p) => {
  const c = await billing.disablePromo(p.code);
  audit(req, `disabled promo code ${c.code}`);
  return c;
}, { perm: 'promos.manage' });
route(
  'POST',
  '/api/billing/webhook',
  async (req) => {
    const raw = await readRaw(req, 1024 * 1024);
    return billing.webhook(raw, req.headers['stripe-signature'], auth);
  },
  { public: true },
);

route(
  'GET',
  '/api/admin/billing',
  () => ({
    ...billing.adminSummary(),
    plans: billing.plans,
    subscriptions: billing.subs
      .filter((x) => x.status !== 'pending')
      .map((x) => ({
        ...billing.publicSub(x),
        userId: x.userId,
        username: (auth.userById(x.userId) || {}).username || '(deleted)',
        serverName: x.serverId && manager.instances.get(x.serverId) ? manager.instances.get(x.serverId).cfg.name : null,
        stripeSubscriptionId: x.stripeSubscriptionId || null,
      }))
      .reverse(),
  }),
  { perm: 'billing.view' },
);
route('PUT', '/api/admin/plans', async (req) => {
  const r = await billing.setPlans((await readJson(req)).plans);
  audit(req, `changed the plans (${r.map((x) => `${x.name} ${(x.priceCents / 100).toFixed(2)}`).join(', ')})`);
  return r;
}, { perm: 'billing.manage' });
route('PUT', '/api/admin/billing-settings', async (req) => {
  const r = await billing.setSettings(await readJson(req));
  audit(req, `changed the sellable capacity to ${(r.capacityMb / 1024).toFixed(1)} GB`);
  return r;
}, { perm: 'billing.manage' });
route(
  'POST',
  '/api/admin/subscriptions',
  async (req) => {
    const { userId, planId, months, days, note } = await readJson(req);
    const u = auth.userById(userId);
    if (!u) throw httpError(404, 'User not found');
    const s = await billing.grant(u, planId, req.user.username, { months, days, note });
    audit(req, `gave ${u.username} a free ${s.planName} plan (${durationText(s.freeDays)})`);
    return billing.publicSub(s);
  },
  { perm: 'billing.manage' },
);
route(
  'DELETE',
  '/api/admin/subscriptions/:sid',
  async (req, res, p) => {
    const s = await billing.cancel(p.sid, req.user.username);
    audit(req, `canceled ${(auth.userById(s.userId) || {}).username || 'a customer'}'s ${s.planName} plan`);
    return billing.publicSub(s);
  },
  { perm: 'billing.manage' },
);

// ---------- Staff Console (/admin) ----------

/** Numbers for the console's first page; each part only if your role may see it. */
route('GET', '/api/admin/overview', (req) => {
  const u = req.user;
  const all = [...manager.instances.values()];
  const out = {
    servers: { total: all.length, running: all.filter((i) => i.proc).length, suspended: all.filter((i) => i.cfg.suspended).length },
    people: can(u, 'users.view')
      ? auth.users.reduce((acc, x) => ((acc[x.role] = (acc[x.role] || 0) + 1), acc), { total: auth.users.length })
      : null,
    billing: can(u, 'billing.view') ? billing.adminSummary() : null,
    system: can(u, 'system.view')
      ? { totalMemMb: Math.floor(os.totalmem() / 1048576), freeMemMb: Math.floor(os.freemem() / 1048576), uptimeSec: Math.floor(process.uptime()), isolated: manager.docker, node: process.version }
      : null,
    activity: activity.events.filter((e) => e.kind !== 'audit' && canSeeEvent(u, e)).slice(-15).reverse(),
  };
  return out;
}, { perm: 'console.access' });

/** Every server with its owner and plan (support's main tool). */
route('GET', '/api/admin/servers', (req) => [...manager.instances.values()].map((i) => {
  const j = i.toJSON();
  const owner = auth.userById(i.cfg.owner);
  return {
    id: j.id, name: j.name, type: j.typeLabel || j.type, version: j.version, port: j.port, status: j.status,
    running: !!i.proc, suspended: i.cfg.suspended || null, players: (j.players || []).length,
    memUsedMb: i.memUsedMb || null, memoryMb: Number(i.cfg.memoryMb) || null, diskUsedMb: i.diskUsedMb || null,
    owner: owner ? { id: owner.id, username: owner.username, email: can(req.user, 'users.view') ? owner.email : undefined } : null,
    plan: manager.planInfo(i),
    createdAt: i.cfg.createdAt || null,
  };
}), { perm: 'servers.viewAll' });

route('GET', '/api/admin/roles', () => rbac.publicRoles(), { perm: 'console.access' });
route('PUT', '/api/admin/roles/:role', async (req, res, p) => {
  const before = rbac.role(p.role).permissions.slice();
  const r = await rbac.setPermissions(p.role, (await readJson(req)).permissions);
  const after = rbac.role(p.role).permissions;
  const added = after.filter((x) => !before.includes(x));
  const removed = before.filter((x) => !after.includes(x));
  audit(req, `changed the ${rbac.role(p.role).label} role${added.length ? ` (+ ${added.join(', ')})` : ''}${removed.length ? ` (- ${removed.join(', ')})` : ''}`);
  return r;
}, { perm: 'roles.manage' });
route('POST', '/api/admin/roles/reset', async (req) => {
  const r = await rbac.resetDefaults();
  audit(req, 'reset every role to the default permissions');
  return r;
}, { perm: 'roles.manage' });

route('GET', '/api/admin/audit', (req, res, p, q) => {
  const limit = Math.min(Number(q.get('limit')) || 200, 1000);
  return activity.events.filter((e) => e.kind === 'audit').slice(-limit).reverse();
}, { perm: 'audit.view' });

// Staff docs: kept out of public/ (so they can't be fetched as static files) and served only to staff.
const STAFF_DOCS_DIR = path.join(__dirname, '..', 'staff-docs');
const STAFF_DOCS = [
  { id: 'support-playbook', title: 'Support playbook', icon: '🎧', group: 'Support', perm: 'console.access' },
  { id: 'roles', title: 'Roles & permissions', icon: '🔑', group: 'Support', perm: 'console.access' },
  { id: 'hosting-guide', title: 'Running Tree Host', icon: '🛠', group: 'Technical', perm: 'system.view' },
];
const staffDocsFor = (user) => STAFF_DOCS.filter((d) => can(user, d.perm)).map(({ perm, ...d }) => d);
route('GET', '/api/staff/docs', (req) => ({ docs: staffDocsFor(req.user) }), { perm: 'console.access' });
route('GET', '/api/staff/docs/:id', async (req, res, p) => {
  const doc = STAFF_DOCS.find((d) => d.id === p.id);
  if (!doc || !can(req.user, doc.perm)) throw httpError(404, 'No such staff guide.');
  return { ...doc, perm: undefined, markdown: await fsp.readFile(path.join(STAFF_DOCS_DIR, `${doc.id}.md`), 'utf8') };
}, { perm: 'console.access' });

// ---------- servers API ----------

route('GET', '/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Content-Encoding': 'identity',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  // Padding helps some proxies start streaming immediately.
  res.write(`: ${' '.repeat(2048)}\n\nretry: 2000\n\n`);
  res.write(`event: snapshot\ndata: ${JSON.stringify(visibleList(req.user))}\n\n`);
  clients.set(res, req.user);
  req.on('close', () => clients.delete(res));
  return HANDLED;
});

route('GET', '/api/health', () => ({ ok: true }), { public: true });
route('GET', '/api/system', async (req) => (!can(req.user, 'system.view') ? { customer: true, lanIps: [] } : {
  platform: process.platform,
  totalMemMb: Math.floor(os.totalmem() / 1048576),
  freeMemMb: Math.floor(os.freemem() / 1048576),
  servers: [...manager.instances.values()]
    .filter((i) => i.proc)
    .map((i) => ({ id: i.cfg.id, name: i.cfg.name, usedMb: i.memUsedMb || null, maxMb: Number(i.cfg.memoryMb) || null })),
  dataDir: DATA,
  lanIps: Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))
    .map((i) => i.address),
  java: await java.listJava(),
  isolated: manager.docker,
}));

route('GET', '/api/types', () => providers.describe());
route('GET', '/api/types/:type/versions', (req, res, p) => providers.getProvider(p.type).versions());
route('GET', '/api/types/:type/versions/:version/builds', async (req, res, p) => {
  const prov = providers.getProvider(p.type);
  return prov.hasBuilds ? prov.builds(p.version) : [];
});
route('GET', '/api/next-port', async (req, res, p, q) => {
  requirePerm(req, 'servers.host');
  return { port: await manager.nextFreePort(q.get('kind')) };
});

route('GET', '/api/servers', (req) => visibleList(req.user));
route('POST', '/api/servers', async (req) => {
  const body = await readJson(req);
  checkHostSettings(req, body);
  delete body.gateway;
  // Hosted: every server belongs to someone and uses one of their plans.
  const space = TEAM ? 'customer' : undefined;
  let extra = {};
  let sub = null;
  if (space === 'customer') {
    // A customer server uses one paid plan: its memory, CPU and disk come from the plan.
    if (!body.eula) throw httpError(400, 'Please accept the Minecraft EULA.');
    if (body.type === 'custom') throw httpError(403, 'Custom JAR servers are not available.');
    sub = billing.sub(String(body.subscriptionId || ''));
    if (!sub || (sub.userId !== req.user.id && !can(req.user, 'billing.manage'))) throw httpError(400, 'Pick one of your plans for this server.');
    if (!billing.usable(sub)) throw httpError(402, 'This plan is not active. Check Billing.');
    if (sub.serverId && manager.instances.has(sub.serverId)) throw httpError(400, 'This plan already has a server. Delete that server first, or buy another plan.');
    body.memoryMb = sub.ramMb;
    body.name = String(body.name || '').slice(0, 40);
    extra = { subscriptionId: sub.id };
  }
  const owner = space === 'customer' ? sub.userId : undefined;
  const inst = await manager.create(body, { space, owner, createdBy: req.user.id, extra });
  if (sub) billing.attachServer(sub.id, sub.userId, inst.cfg.id);
  inst.logActivity('server', who(req), `created ${inst.provider.label} ${inst.cfg.version} server "${inst.cfg.name}"`);
  return inst.toJSON();
});
route('GET', '/api/servers/:id', (req, res, p) => getFor(req, p.id).toJSON());
route('PATCH', '/api/servers/:id', async (req, res, p) => {
  const body = await readJson(req);
  checkHostSettings(req, body);
  const inst = getFor(req, p.id, 'settings');
  if (inst.isCustomer) {
    // Port and memory come from the plan; host-level settings are never available on customer servers.
    delete body.port;
    delete body.customJar;
    delete body.publicAddress;
    if (body.type === 'custom') throw httpError(403, 'Custom JAR servers are not available.');
    if (body.java !== undefined && !/^(auto|\d+)$/.test(String(body.java))) delete body.java;
    const plan = manager.planInfo(inst);
    if (body.memoryMb !== undefined) body.memoryMb = Math.min(Number(body.memoryMb) || 0, plan ? plan.ramMb : inst.cfg.memoryMb);
  }
  // Switching type/version/build replaces the server jar: same rule as deleting.
  const software = ['type', 'version', 'build', 'customJar'].some(
    (k) => body[k] !== undefined && String(body[k] || '') !== String(inst.cfg[k] || ''),
  );
  if (software) getFor(req, p.id, 'manage');
  return (await manager.update(p.id, body)).toJSON();
});
route('DELETE', '/api/servers/:id', async (req, res, p) => {
  const inst = getFor(req, p.id, 'manage');
  inst.logActivity('server', who(req), `deleted server "${inst.cfg.name}"`);
  await manager.remove(p.id);
  billing.detachServer(p.id);
  return { ok: true };
});

route('GET', '/api/servers/:id/log', (req, res, p, q) => {
  const since = Number(q.get('since')) || 0;
  const logs = getFor(req, p.id).logs;
  return { lines: since ? logs.filter((l) => l.s > since) : logs };
});
route('POST', '/api/servers/:id/command', async (req, res, p) => {
  getFor(req, p.id, 'command').command((await readJson(req)).command);
  return { ok: true };
});

route('GET', '/api/servers/:id/plugins', (req, res, p) => getFor(req, p.id).listPlugins());
route('POST', '/api/servers/:id/plugins', async (req, res, p, q) => ({
  file: await getFor(req, p.id, 'plugins').savePluginUpload(q.get('name'), req),
}));
route('POST', '/api/servers/:id/plugins/:file/toggle', async (req, res, p) => {
  await getFor(req, p.id, 'plugins').togglePlugin(p.file);
  return { ok: true };
});
route('DELETE', '/api/servers/:id/plugins/:file', async (req, res, p) => {
  await getFor(req, p.id, 'plugins').deletePlugin(p.file);
  return { ok: true };
});

// Deploy a plugin build (used by the Gradle/Maven task or curl with an API token).
route('POST', '/api/servers/:id/deploy', async (req, res, p, q) =>
  getFor(req, p.id, 'deploy').deployPlugin(q.get('name'), req, {
    restart: q.get('restart') !== '0',
    by: req.user.username,
  }),
);
route('POST', '/api/servers/:id/team-access', async (req, res, p) => {
  const { op } = await readJson(req);
  return { names: getFor(req, p.id, 'command').teamAccess({ op: !!op }) };
});

route('POST', '/api/servers/:id/watches', async (req, res, p) => {
  if (HOSTED) throw httpError(400, 'Watching folders on the host is not available on a hosted Tree Host. Use the deploy API.');
  return manager.addWatch(p.id, (await readJson(req)).path);
}, { perm: 'servers.host' });
route(
  'PATCH',
  '/api/servers/:id/watches/:wid',
  async (req, res, p) => {
    manager.updateWatch(p.id, p.wid, await readJson(req));
    return { ok: true };
  },
  { perm: 'servers.host' },
);
route(
  'DELETE',
  '/api/servers/:id/watches/:wid',
  (req, res, p) => {
    manager.removeWatch(p.id, p.wid);
    return { ok: true };
  },
  { perm: 'servers.host' },
);

route('GET', '/api/servers/:id/properties', (req, res, p) => getFor(req, p.id).getProperties());
route('PUT', '/api/servers/:id/properties', async (req, res, p) => {
  const inst = getFor(req, p.id, 'settings');
  await inst.setProperties(await readJson(req));
  inst.emitStatus();
  return { ok: true };
});

route('GET', '/api/servers/:id/files', (req, res, p, q) => getFor(req, p.id, 'files').listFiles(q.get('path')));
route('GET', '/api/servers/:id/file', async (req, res, p, q) => ({ content: await getFor(req, p.id, 'files').readFile(q.get('path')) }));
route('PUT', '/api/servers/:id/file', async (req, res, p, q) => {
  await getFor(req, p.id, 'files').writeFile(q.get('path'), (await readJson(req, 4 * 1024 * 1024)).content);
  return { ok: true };
});
route('DELETE', '/api/servers/:id/file', async (req, res, p, q) => {
  await getFor(req, p.id, 'files').deleteFile(q.get('path'));
  return { ok: true };
});

route('POST', '/api/servers/:id/launch-client', async (req, res, p) => {
  if (HOSTED) throw httpError(400, 'Playing on the host is not available on a hosted Tree Host.');
  return getFor(req, p.id).launchClient(await readJson(req));
}, {
  admin: true,
});

// ---------- backups ----------
route('GET', '/api/servers/:id/backups', (req, res, p) => backups.list(getFor(req, p.id)));
route('POST', '/api/servers/:id/backups', async (req, res, p) => {
  const inst = getFor(req, p.id, 'control');
  const b = await backups.create(inst, { label: (await readJson(req)).label, by: who(req), maxManual: inst.isCustomer ? MAX_CUSTOMER_BACKUPS : 0 });
  inst.sysLog(
    `Backup made by ${who(req)}: ${b.label} (${(b.size / 1048576).toFixed(1)} MB).` +
      (b.skipped.length ? ` Skipped ${b.skipped.length} file(s) the server had locked: ${b.skipped.slice(0, 5).join(', ')}` : ''),
  );
  inst.logActivity('backup', who(req), `made a backup "${b.label}"`);
  return b;
});
route('POST', '/api/servers/:id/backups/:bid/restore', async (req, res, p) => {
  const inst = getFor(req, p.id, 'manage');
  const b = await backups.restore(inst, p.bid);
  inst.sysLog(`${who(req)} restored the backup "${b.label}" from ${new Date(b.createdAt).toLocaleString()}.`);
  inst.logActivity('backup', who(req), `restored the backup "${b.label}"`);
  return b;
});
route('DELETE', '/api/servers/:id/backups/:bid', async (req, res, p) => {
  await backups.remove(getFor(req, p.id, 'manage'), p.bid);
  return { ok: true };
});

// Plugin / mod browser (Modrinth)
route('GET', '/api/servers/:id/modrinth/search', (req, res, p, q) => modrinth.search(getFor(req, p.id), q.get('q')));
route('POST', '/api/servers/:id/modrinth/install', async (req, res, p) => {
  const inst = getFor(req, p.id, 'plugins');
  const body = await readJson(req);
  const r = await modrinth.install(inst, body.project);
  const what = body.title || r.file;
  inst.sysLog(`${who(req)} installed ${what} ${r.version} from Modrinth${inst.proc ? ' (restart the server to load it)' : ''}.`);
  inst.logActivity('deploy', who(req), `installed ${what} ${r.version} from Modrinth`);
  return r;
});

route('POST', '/api/servers/:id/:action', async (req, res, p, q) => {
  const needs = { install: 'settings', 'reset-worlds': 'manage' }[p.action] || 'control';
  const inst = getFor(req, p.id, needs);
  switch (p.action) {
    case 'start': {
      const blocked = manager.startBlock(inst);
      if (blocked) throw httpError(402, `Can't start: ${blocked}`);
      if (!inst.proc) inst.logActivity('start', who(req), 'started the server');
      inst.crashTimes = [];
      inst.start();
      break;
    }
    case 'stop':
      if (inst.proc) inst.logActivity('stop', who(req), 'stopped the server');
      inst.stop();
      break;
    case 'restart':
      if (manager.startBlock(inst)) throw httpError(402, `Can't restart: ${manager.startBlock(inst)}`);
      inst.logActivity('start', who(req), 'restarted the server');
      inst.crashTimes = [];
      inst.restart();
      break;
    case 'kill':
      if (inst.proc) inst.logActivity('stop', who(req), 'force-killed the server');
      inst.kill();
      break;
    case 'install':
      await inst.install({ force: true });
      break;
    case 'reset-worlds':
      await inst.resetWorlds();
      inst.logActivity('server', who(req), 'reset the world');
      break;
    case 'open-folder': {
      requirePerm(req, 'servers.host');
      if (HOSTED) throw httpError(400, 'Not available on a hosted Tree Host.');
      const sub = q.get('sub');
      const target = sub ? inst.resolvePath(sub) : inst.dir;
      await fsp.mkdir(target, { recursive: true });
      openInOs(target);
      break;
    }
    default:
      throw httpError(404, 'Unknown action');
  }
  return { ok: true };
});

// ---------- static files ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};

// Clean URLs: the website pages, and the dashboard (also at /app for older links).
const PAGES = {
  '/dashboard': 'dashboard.html',
  '/app': 'dashboard.html',
  '/admin': 'dashboard.html',
  '/staff-docs': 'help.html', // the guides themselves come from /api/staff/docs (staff only)
  '/features': 'features.html',
  '/pricing': 'pricing.html',
  '/support': 'support.html',
  '/about': 'about.html',
  '/terms': 'terms.html',
  '/privacy': 'privacy.html',
};

async function serveStatic(req, res, pathname) {
  pathname = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  // The homepage is the website; without hosting (local use) it is the dashboard.
  let rel = PAGES[pathname] || (pathname === '/' ? (HOSTED ? 'index.html' : 'dashboard.html') : decodeURIComponent(pathname.slice(1)));
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...(isHttps(req) ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
    });
    res.end(data);
  } catch {
    // Pages get the friendly 404 page; missing files (images, scripts) a plain 404.
    const page = !path.extname(file) || file.endsWith('.html');
    const body = page ? await fsp.readFile(path.join(PUBLIC, '404.html')).catch(() => null) : null;
    if (body) res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }).end(body);
    else res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

// ---------- HTTP server ----------

const server = http.createServer(async (req, res) => {
  const host = req.headers.host || '';
  if (!TEAM) {
    // Personal mode: only this machine's browser may talk to us (blocks DNS rebinding).
    if (!LOCAL_HOSTS.has(host)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
  }
  // Block cross-site requests: a browser request that changes something must come from our own page.
  const origin = req.headers.origin;
  if (req.method !== 'GET' && origin && origin.replace(/^https?:\/\//, '') !== host) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  const url = new URL(req.url, `http://${host || 'localhost'}`);
  if (!url.pathname.startsWith('/api/')) {
    await serveStatic(req, res, url.pathname);
    return;
  }
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    try {
      if (!r.opts.public) {
        req.user = authenticate(req);
        if (!req.user) throw httpError(401, 'Please sign in.', 'AUTH');
        if (r.opts.perm) requirePerm(req, r.opts.perm);
      }
      const result = await r.handler(req, res, params, url.searchParams);
      if (result !== HANDLED) sendJson(res, 200, result === undefined ? { ok: true } : result);
    } catch (e) {
      if (!res.headersSent) sendJson(res, e.status || 400, { error: publicMessage(e, req.user), code: e.code });
    }
    return;
  }
  sendJson(res, 404, { error: 'Not found' });
});

function banner(lines) {
  const width = Math.max(...lines.map((l) => l.length)) + 6;
  console.log('  ' + '='.repeat(width));
  for (const l of lines) console.log(`  |  ${l.padEnd(width - 4)}|`);
  console.log('  ' + '='.repeat(width));
}

async function main() {
  if (TEAM) {
    await migrateTeamData();
    await auth.init();
    await rbac.init();
    // Local test sites (http://localhost...) make the first account the admin; real sites use TREEHOST_ADMIN_EMAILS.
    auth.allowFirstAdmin = !auth.adminEmails.size && (!HOSTED || /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(PUBLIC_URL + '/'));
    await billing.init();
    setInterval(() => billing.tick().catch((e) => console.error(`Billing check failed: ${e.message}`)), 5 * 60 * 1000);
    manager.defaultOwner = () => (auth.firstAdmin() || {}).id || null;
  }
  await activity.init();
  await manager.init();
  const url = `http://localhost:${PORT}`;
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`Tree Host is already running at ${url} - opening it.`);
      if (!NO_OPEN) openBrowser(url);
      setTimeout(() => process.exit(0), 500);
    } else {
      console.error(e);
      process.exit(1);
    }
  });
  server.listen(PORT, HOST, () => {
    console.log('');
    console.log(`  Tree Host${HOSTED ? ` - ${PUBLIC_URL}` : TEAM ? ' - team mode' : ' - local mode'}`);
    console.log(`  Listening on ${HOST}:${PORT}`);
    if (HOSTED) {
      console.log(`  Payments: ${billing.mode}${billing.mode === 'off' ? ' (set STRIPE_SECRET_KEY to sell plans)' : ''}. Emails: ${mail.enabled() ? 'on' : 'off (set RESEND_API_KEY)'}.`);
      console.log(`  Sign-in: ${firebase.authEnabled() ? 'Firebase' : 'passwords'}. Database: ${firebase.dbEnabled() ? 'Firebase Realtime Database' : 'local files'}.`);
      if (!manager.gameHost) console.log('  Set TREEHOST_GAME_HOST to the address players use (a domain or this server\'s public IP).');
    } else if (TEAM && HOST !== '127.0.0.1') {
      console.log('  Dashboard from other PCs on your network:');
      for (const u of lanUrls()) console.log(`    ${u}`);
    }
    console.log(`  Data folder: ${DATA}`);
    console.log('');
    if (TEAM && !auth.hasOwner()) {
      banner(
        auth.allowFirstAdmin
          ? ['No Owner yet: the first account you create becomes the Owner (local test mode).']
          : auth.adminEmails.size
            ? ['No Owner yet. Sign up on the website with one of these emails to become the Owner:', [...auth.adminEmails].join(', '), firebase.authEnabled() ? 'Verify the email (check your inbox), then sign in again.' : '']
            : ['No admin yet. Set TREEHOST_ADMIN_EMAILS=you@example.com in the settings and restart.'],
      );
      console.log('');
    }
    if (!HOSTED) console.log('  Keep this window open while you use it. Press Ctrl+C to stop all servers and quit.');
    console.log('');
    if (!NO_OPEN) openBrowser(url);
    if (TEAM && !HOSTED && keepAwake()) console.log('  This PC will not go to sleep while Tree Host runs (the screen can still turn off).');
  });
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received - stopping all servers...`);
  await manager.shutdownAll();
  await store.flushAll().catch(() => {});
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => shutdown(sig));

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
