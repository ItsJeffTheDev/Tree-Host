'use strict';
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { URL } = require('url');
const crypto = require('crypto');
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
const { Moderation, TYPES, REASONS } = require('./moderation');
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
const DISCORD_INVITE = env('DISCORD_INVITE', 'https://discord.gg/a37pbwajKd');
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
const moderation = new Moderation();
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

/** { lifetime, prioritySupport } for an account with an active lifetime plan (shown on the account and to staff). */
function lifetimeOf(user) {
  const subs = TEAM && user ? billing.forUser(user.id).filter((s) => s.oneTime && billing.usable(s)) : [];
  return { lifetime: subs.length > 0, prioritySupport: subs.some((s) => s.prioritySupport) };
}

manager.overheadMb = require('./billing').OVERHEAD_MB;
manager.planInfo = (inst) => {
  const sub = inst.cfg.subscriptionId ? billing.sub(inst.cfg.subscriptionId) : null;
  if (!sub) return null;
  const ramMb = sub.slots && inst.provider.kind === 'proxy' ? sub.proxyRamMb || 1024 : sub.ramMb;
  return { planName: sub.planName, ramMb, cpus: sub.cpus, diskGb: sub.diskGb, status: sub.status, usable: billing.usable(sub), renewsAt: sub.periodEnd || null, lifetime: !!sub.oneTime };
};
manager.startBlock = (inst) => {
  const mod = inst.cfg.moderation;
  if (mod) return `this server is ${mod.type} by Tree Host staff (action ${mod.actionId}). See your inbox for why and to appeal.`;
  const owner = inst.cfg.owner ? auth.userById(inst.cfg.owner) : null;
  if (owner && owner.restriction) return `the account that owns this server is ${owner.restriction.type}.`;
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
// A plan can run any number of servers (bundles like Lifetime: up to their slots); each server points at its plan.
const serversOnSub = (sub) => [...manager.instances.values()].filter((i) => i.cfg.subscriptionId === sub.id);
billing.hooks.serversOf = (sub) => serversOnSub(sub).map((i) => ({ id: i.cfg.id, name: i.cfg.name, kind: i.provider.kind }));
billing.hooks.suspend = (sub, reason) => {
  for (const inst of serversOnSub(sub)) {
    if (inst.cfg.suspended === reason) continue;
    inst.cfg.suspended = reason;
    inst.sysLog(reason === 'canceled' ? 'The plan for this server ended, so it was stopped.' : 'The payment for this server failed, so it was stopped. Update your card in Billing.');
    if (inst.proc) inst.stop();
    inst.emitStatus();
  }
  manager.save();
};
billing.hooks.unsuspend = (sub) => {
  for (const inst of serversOnSub(sub)) {
    if (!inst.cfg.suspended) continue;
    inst.cfg.suspended = null;
    inst.sysLog('Payment received: the server can be started again.');
    inst.emitStatus();
  }
  manager.save();
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
  mail.send(user.email, subject, paragraphs, PUBLIC_URL ? { text: 'Open Billing', url: `${PUBLIC_URL}/dashboard?billing` } : null, { replyTo: EMAILS.billing });
billing.hooks.sendEmail = (kind, user, sub) => (user && user.email ? sendEmail(user.email, EMAIL[kind](user, sub, siteUrl())) : Promise.resolve(false));

// ---------- emails (the layout is in mail.js) ----------

const siteUrl = (req) => PUBLIC_URL || (req ? publicOrigin(req) : 'https://treehost.online');
const niceDate = (t) => new Date(t).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

/** Each email as [subject, paragraphs, button, options] (see mail.send). Used for sending and for the previews. */
const EMAIL = {
  welcome: (user, base, verifyLink) => [
    'Welcome to Tree Host!',
    [
      `Hi **${user.username}**, thanks for joining Tree Host. Your account is ready.`,
      verifyLink ? 'First, please confirm your email address. It keeps your account safe and lets us reach you about your servers.' : "Here's how to get your Minecraft server running:",
    ],
    verifyLink ? { text: 'Confirm my email', url: verifyLink } : { text: 'Open my dashboard', url: `${base}/dashboard` },
    {
      heading: `Welcome, ${user.username}! 🌳`,
      preheader: 'Your Tree Host account is ready. Here is how to start your server.',
      details: [['1. Pick a plan', 'Sapling, Oak or Redwood, in Billing'], ['2. Create your server', 'Any type and version, ready in about a minute'], ['3. Join it', 'Copy the address into Minecraft → Multiplayer']],
      after: [`Guides for everything are at ${base}/help.html. Happy building!`],
    },
  ],
  verify: (username, link) => [
    'Confirm your email for Tree Host',
    [`Hi${username ? ` **${username}**` : ''}, please confirm this is your email address by pressing the button below.`],
    { text: 'Confirm my email', url: link },
    { heading: 'Confirm your email', preheader: 'One click to confirm your email address.', after: ["If you didn't create a Tree Host account, you can ignore this email."] },
  ],
  reset: (username, link) => [
    'Reset your Tree Host password',
    [`Hi${username ? ` **${username}**` : ''}, someone (hopefully you) asked to reset the password for your Tree Host account.`, 'Press the button to choose a new one. The link works for one hour and only once.'],
    { text: 'Choose a new password', url: link },
    {
      heading: 'Reset your password',
      preheader: 'Choose a new password for your Tree Host account.',
      after: ["Didn't ask for this? You can ignore this email: your password stays the same. Tree Host staff will **never** ask you for your password."],
    },
  ],
  planActive: (user, sub, base) => [
    `Your ${sub.planName} plan is active`,
    [`Thanks, **${user.username}**! Your ${sub.free ? 'free ' : ''}${sub.planName} plan is ready.`, 'Create your server from the dashboard: pick any server type and version and it is running in about a minute.'],
    { text: 'Create my server', url: `${base}/dashboard` },
    {
      heading: 'Your plan is ready 🎉',
      details: [
        ['Plan', sub.planName],
        ['Memory', `${+(sub.ramMb / 1024).toFixed(1)} GB RAM`],
        ['CPU and disk', `${sub.cpus} core${sub.cpus === 1 ? '' : 's'} · ${sub.diskGb} GB NVMe`],
        ...(sub.periodEnd ? [['Renews', niceDate(sub.periodEnd)]] : sub.freeUntil ? [['Free until', niceDate(sub.freeUntil)]] : []),
      ],
      after: ['You can change your card, see invoices or cancel any time in **Billing**.'],
      replyTo: EMAILS.billing,
    },
  ],
  planEnded: (user, sub, base) => [
    `Your ${sub.planName} plan has ended`,
    [`Hi **${user.username}**, your ${sub.planName} plan has ended, so its server was stopped.`, 'Your worlds and files are kept for **14 days**. Buy a plan in Billing before then to keep them.'],
    { text: 'Open Billing', url: `${base}/dashboard?billing` },
    { heading: 'Your plan has ended', replyTo: EMAILS.billing },
  ],
};

const sendEmail = (to, [subject, paragraphs, button, opts]) => mail.send(to, subject, paragraphs, button, opts);

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

/** The request body as bytes (uploads of pictures and other binary files). */
async function readBytes(req, limit) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw httpError(413, 'That file is too big.');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
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

// ---------- several accounts in one browser ----------
// th_session is the active account; th_accounts lists the session tokens of every account signed in on this browser
// (for the account switcher); th_device identifies the browser, so accounts used together are linked.
const ACCOUNTS_COOKIE = 'th_accounts';
const DEVICE_COOKIE = 'th_device';
const MAX_ACCOUNTS = 5;
const cookieStr = (req, name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;

/** Every account signed in on this browser (still valid), the active one first. */
function browserSessions(req) {
  const tokens = [getCookie(req, SESSION_COOKIE), ...String(getCookie(req, ACCOUNTS_COOKIE) || '').split('.')].filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const token of tokens) {
    const user = auth.userFromSession(token);
    if (user && !seen.has(user.id)) {
      seen.add(user.id);
      out.push({ token, user });
    }
  }
  return out;
}

const validDevice = (d) => (d && /^[\w-]{16,64}$/.test(d) ? d : null);

/**
 * Cookies after signing in (or switching) to `token`: it becomes the active account and the other accounts on this
 * browser stay in the switcher. Also remembers the browser on the account, which links accounts used together.
 */
async function signInCookies(req, token) {
  const user = auth.userFromSession(token);
  const cookies = [];
  let device = validDevice(getCookie(req, DEVICE_COOKIE));
  if (!device) {
    device = crypto.randomBytes(18).toString('base64url');
    cookies.push(cookieStr(req, DEVICE_COOKIE, device, 5 * 365 * 86400));
  }
  const others = browserSessions(req).filter((s) => !user || s.user.id !== user.id).map((s) => s.token);
  cookies.unshift(sessionCookie(req, token), cookieStr(req, ACCOUNTS_COOKIE, [token, ...others].slice(0, MAX_ACCOUNTS).join('.'), 30 * 86400));
  if (user && TEAM) await linkDevice(user, device).catch((e) => console.error(`[accounts] linking failed: ${e.message}`));
  return cookies;
}

/** Records the browser on the account; a new link to a suspended or banned account passes the action on. */
async function linkDevice(user, device) {
  if (!(await auth.recordDevice(user, device))) return;
  if (user.role !== 'customer' || user.restriction) return;
  // Only accounts used in this same browser pass their action on (not everything linked some other way).
  const restricted = auth.accountsOnDevice(device).filter((u) => u !== user && u.restriction && u.restriction.actionId);
  const from = restricted.find((u) => u.restriction.type === 'banned') || restricted[0];
  const parent = from && moderation.find(from.restriction.actionId);
  if (!parent || parent.status !== 'active') return;
  await linkedAction(parent, user, { id: 'system', username: 'Tree Host (automatic)', role: 'system', roleLabel: 'Automatic' }, { auto: true, email: true });
  await moderation.save();
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
  // A suspended or banned server is read-only for its owner (staff can still look into it).
  if (TEAM && action !== 'view' && inst.cfg.moderation && !rbac.isStaff(req.user)) {
    throw httpError(423, `This server is ${inst.cfg.moderation.type} (action ${inst.cfg.moderation.actionId}). See your inbox for why and to appeal.`, 'SERVER_RESTRICTED');
  }
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
  if (e.kind === 'moderation') return can(user, 'moderation.view');
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
  (req, res) => {
    const user = authenticate(req);
    // Accounts signed in before the account switcher existed: remember this browser on them too.
    if (TEAM && user && !user.local) {
      let device = validDevice(getCookie(req, DEVICE_COOKIE));
      if (!device) {
        device = crypto.randomBytes(18).toString('base64url');
        res.setHeader('Set-Cookie', cookieStr(req, DEVICE_COOKIE, device, 5 * 365 * 86400));
      }
      linkDevice(user, device).catch(() => {});
    }
    return {
      teamMode: TEAM,
      user: user ? { ...(user.local ? user : auth.publicUser(user)), ...(user.local ? {} : lifetimeOf(user)), roleLabel: rbac.role(user.role).label, permissions: TEAM ? rbac.permissionsOf(user) : PERMISSIONS.map((x) => x.id) } : null,
      publicUrl: publicUrl(),
      hosted: HOSTED,
      allowSignup: TEAM && auth.settings.allowSignup,
      mailEnabled: mail.enabled(),
      customEmails: TEAM && mail.enabled() && firebase.linksEnabled(),
      discordInvite: DISCORD_INVITE,
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
    if (r.created) {
      activity.log('people', r.user.username, r.user.role === 'customer' ? 'signed up' : `joined as ${r.user.role}`);
      if (r.user.email && mail.enabled()) welcomeEmail(req, r.user).catch((e) => console.error(`[mail] welcome email failed: ${e.message}`));
    }
    sendJson(res, 200, { ok: true, created: !!r.created }, { 'Set-Cookie': await signInCookies(req, r.token) });
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
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': await signInCookies(req, token) });
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
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': await signInCookies(req, token) });
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
    if (user.email && mail.enabled()) welcomeEmail(req, user).catch((e) => console.error(`[mail] welcome email failed: ${e.message}`));
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': await signInCookies(req, token) });
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
      await sendEmail(r.user.email, EMAIL.reset(r.user.username, `${siteUrl(req)}/dashboard?reset=${r.token}`));
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
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': await signInCookies(req, token) });
    return HANDLED;
  },
  { public: true },
);

route(
  'POST',
  '/api/auth/logout',
  async (req, res) => {
    const all = String(req.headers['content-length'] || '0') !== '0' ? (await readJson(req).catch(() => ({}))).all : false;
    const sessions = browserSessions(req);
    const current = getCookie(req, SESSION_COOKIE);
    for (const s of sessions) if (all || s.token === current) await auth.logout(s.token);
    await auth.logout(current);
    const left = all ? [] : sessions.filter((s) => s.token !== current);
    if (left.length) {
      // Another account is still signed in on this browser: switch to it.
      sendJson(res, 200, { ok: true, switchedTo: left[0].user.username }, { 'Set-Cookie': await signInCookies(req, left[0].token) });
    } else {
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': [sessionCookie(req, '', 0), cookieStr(req, ACCOUNTS_COOKIE, '', 0)] });
    }
    return HANDLED;
  },
  { public: true },
);

// The account switcher: every account signed in on this browser, and switching between them.
route('GET', '/api/auth/accounts', (req) => {
  if (!TEAM) return { accounts: [], max: MAX_ACCOUNTS };
  const sessions = browserSessions(req);
  return {
    max: MAX_ACCOUNTS,
    accounts: sessions.map(({ user }) => ({
      id: user.id, username: user.username, email: user.email || '', role: user.role, roleLabel: rbac.role(user.role).label,
      active: user.id === req.user.id, restricted: user.restriction ? user.restriction.type : null,
    })),
  };
}, { restrictedOk: true });
route('POST', '/api/auth/switch', async (req, res) => {
  const { userId } = await readJson(req);
  const s = browserSessions(req).find((x) => x.user.id === userId);
  if (!s) throw httpError(404, 'That account is not signed in on this browser any more. Sign in to it again.');
  sendJson(res, 200, { ok: true, username: s.user.username }, { 'Set-Cookie': await signInCookies(req, s.token) });
  return HANDLED;
}, { restrictedOk: true });

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
        linked: auth.linkedAccounts(u).map((x) => ({ id: x.id, username: x.username, role: x.role })),
        ...lifetimeOf(u),
      };
    }),
  { perm: 'users.view' },
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
// ---------- moderation: warnings, suspensions, bans, deletions, appeals, inbox (see moderation.js) ----------

const ACTION_PERM = { warn: 'moderation.act', suspend: 'moderation.act', ban: 'moderation.ban' };
const deletePerm = (target) => (target === 'server' ? 'servers.destroy' : 'users.manage');
const permFor = (type, target) => (type === 'delete' ? deletePerm(target) : ACTION_PERM[type]);
const fmtDate = (t) => new Date(t).toUTCString().replace(/:\d\d GMT$/, ' UTC');

/** What the customer looked like when the action was taken (kept even if the account is deleted later). */
function customerSnapshot(u) {
  if (!u) return {};
  return {
    id: u.id, username: u.username, email: u.email || '', role: u.role, roleLabel: rbac.role(u.role).label,
    createdAt: u.createdAt, lastLogin: u.lastLogin || null, firebase: !!u.firebaseUid, mcName: u.mcName || '',
    plans: billing.forUser(u.id).filter((x) => x.status === 'active' || x.status === 'past_due').map((x) => `${x.planName}${x.free ? ' (free)' : ''}`),
    servers: [...manager.instances.values()].filter((i) => i.cfg.owner === u.id).map((i) => ({ id: i.cfg.id, name: i.cfg.name, type: i.provider.label, version: i.cfg.version })),
    previous: moderation.forUser(u.id).map((a) => `${a.id} (${a.type})`),
  };
}

function serverSnapshot(inst) {
  const plan = manager.planInfo(inst);
  return {
    id: inst.cfg.id, name: inst.cfg.name, type: inst.provider.label, version: inst.cfg.version, createdAt: inst.cfg.createdAt || null,
    plan: plan ? plan.planName : '', address: inst.cfg.publicAddress || inst.cfg.autoAddress || '',
  };
}

const consoleLog = (inst, lines = 500) => inst.logs.slice(-lines).map((l) => l.t).join('\n');

/** The strongest active suspension/ban for an account or server, or null. */
function activeRestriction(match) {
  const active = [...moderation.actions.values()].filter((a) => a.status === 'active' && match(a));
  const pick = active.find((a) => a.type === 'ban') || active.find((a) => a.type === 'suspend');
  return pick ? { type: pick.type === 'ban' ? 'banned' : 'suspended', actionId: pick.id, until: pick.type === 'ban' ? null : pick.until } : null;
}

/** Brings an account's restriction in line with its active actions (stops its servers when restricted). */
async function refreshAccount(userId) {
  const u = auth.userById(userId);
  if (!u) return;
  const r = activeRestriction((a) => a.target === 'account' && a.customer.id === userId);
  if (!r && u.restriction && !u.restriction.actionId) return; // an old-style suspension: lifted from People
  if (JSON.stringify(r) === JSON.stringify(u.restriction ? { type: u.restriction.type, actionId: u.restriction.actionId, until: u.restriction.until } : null)) return;
  await auth.setRestriction(userId, r);
  if (r) for (const inst of manager.instances.values()) if (inst.cfg.owner === userId && inst.proc) inst.stop();
}

/** Same for a server. */
function refreshServer(serverId) {
  const inst = manager.instances.get(serverId);
  if (!inst) return;
  const r = activeRestriction((a) => a.target === 'server' && a.server && a.server.id === serverId);
  inst.cfg.moderation = r;
  manager.save();
  if (r && inst.proc) inst.stop();
  inst.emitStatus();
}

/** Tells the customer: a message in their Tree Host inbox and (optionally) an email. */
async function tellCustomer(a, user, { title, paragraphs, email = true, inbox = true, button = true }) {
  if (!user) return;
  if (inbox) {
    await moderation.message(user.id, { title, body: paragraphs.join('\n\n'), actionId: a ? a.id : null, kind: a ? 'action' : 'message' });
    if (a) a.notified.inbox = true;
  }
  if (email && user.email && mail.enabled()) {
    await mail.send(user.email, title, paragraphs, button && PUBLIC_URL ? { text: 'Open your inbox', url: `${PUBLIC_URL}/dashboard?inbox` } : null, { replyTo: EMAILS.support })
      .then(() => a && (a.notified.email = true))
      .catch((e) => console.error(`[moderation] email to ${user.email} failed: ${e.message}`));
  }
  if (a) await moderation.save();
}

function actionNotice(a) {
  const what = a.target === 'server' ? `your server "${a.server.name}"` : 'your Tree Host account';
  const title = {
    warn: a.target === 'server' ? `A warning about your server "${a.server.name}"` : 'A warning about your Tree Host account',
    suspend: `We've suspended ${what}`,
    ban: `We've banned ${what}`,
    delete: a.target === 'server' ? `We've deleted your server "${a.server.name}"` : "We've deleted your Tree Host account",
  }[a.type];
  const effect = {
    warn: 'No action has been taken on your account this time, but please make sure it does not happen again.',
    suspend: a.target === 'server'
      ? `The server is stopped and can't be started${a.until ? ` until ${fmtDate(a.until)}` : ' until the suspension is lifted'}. Your files are kept.`
      : `You can't use your servers${a.until ? ` until ${fmtDate(a.until)}` : ' until the suspension is lifted'}. Your servers and files are kept.`,
    ban: a.target === 'server'
      ? "The server is stopped and can't be started again."
      : "You can't use Tree Host any more. Your plans have been canceled.",
    delete: a.target === 'server' ? 'The server and its files have been removed.' : 'Your account, its servers and files have been removed.',
  }[a.type];
  const appeal = !a.appealable
    ? 'This decision is final.'
    : a.type === 'delete' && a.target === 'account'
      ? `If you think this is a mistake, reply to this email within 30 days and mention the action number.`
      : 'If you think this is a mistake, you can appeal: open your Tree Host inbox and press "Appeal", or reply to this email. Mention the action number.';
  return { title, paragraphs: [a.message, effect, `Reason: ${REASONS[a.reason]}. Action number: ${a.id}.`, appeal] };
}

const LOG_FILTERS = ['q', 'id', 'username', 'email', 'by', 'server', 'types', 'type', 'target', 'reason', 'status', 'appeal', 'from', 'to', 'sort'];
const logFilters = (q) => Object.fromEntries(LOG_FILTERS.map((k) => [k, q.get(k) || '']));

/**
 * Carries out an action on an account and tells the customer: suspensions and bans lock the account (bans also
 * cancel its plans), deletions remove it (they're told by email first, since the inbox goes with the account).
 */
async function enforceAccountAction(a, user, byName, { email = true } = {}) {
  const notice = actionNotice(a);
  if (a.type === 'suspend' || a.type === 'ban') {
    if (a.type === 'ban') {
      for (const sub of billing.forUser(user.id).filter((x) => x.status === 'active' || x.status === 'past_due')) {
        await billing.cancel(sub.id, `${byName} (ban ${a.id})`).catch((e) => moderation.note(a, 'Tree Host', `Could not cancel plan ${sub.planName}: ${e.message}`));
      }
    }
    await refreshAccount(user.id);
  }
  if (a.type === 'delete') {
    for (const sub of billing.forUser(user.id).filter((x) => x.status === 'active' || x.status === 'past_due')) {
      await billing.cancel(sub.id, `${byName} (deletion ${a.id})`);
    }
    await tellCustomer(a, user, { ...notice, inbox: false, email, button: false });
    for (const s of [...manager.instances.values()]) if (s.cfg.owner === user.id && s.isCustomer) await manager.remove(s.cfg.id);
    await auth.removeUser(user.id);
    await moderation.dropInbox(user.id);
    if (user.firebaseUid) await firebase.deleteAuthUser(user.firebaseUid).catch(() => {});
  } else {
    await tellCustomer(a, user, { ...notice, email });
  }
}

/** The same action on a linked account (used in the same browser), with its own number pointing at the first one. */
async function linkedAction(parent, other, by, { auto = false, email = true } = {}) {
  const what = parent.type === 'ban' ? 'banned' : parent.type === 'suspend' ? 'suspended' : parent.type === 'delete' ? 'deleted' : 'warned';
  const child = await moderation.create({
    type: parent.type,
    target: 'account',
    reason: auto ? 'evasion' : parent.reason,
    message: auto
      ? `This account was used on the same device as another Tree Host account that is ${what} (action ${parent.id}). Linked accounts share the same action.`
      : `${parent.message}\n\nThis applies to every account used on the same device, so it also applies to this account (linked to action ${parent.id}).`,
    notes: `Linked to ${parent.id} (${parent.customer.username}): the accounts were used in the same browser.${auto ? ' Applied automatically when the accounts became linked.' : ''}`,
    until: parent.until,
    appealable: parent.appealable,
    by,
    customer: customerSnapshot(other),
    server: null,
  });
  child.parentId = parent.id;
  parent.linked = [...(parent.linked || []), child.id];
  moderation.note(parent, by.username, `Also applied to the linked account ${other.username} (${child.id})`);
  await enforceAccountAction(child, other, by.username, { email });
  moderation.note(child, 'Tree Host', `Customer told by ${[child.notified.inbox && 'inbox', child.notified.email && 'email'].filter(Boolean).join(' and ') || 'nothing'}`);
  activity.log('moderation', by.username, `${what} the linked account ${other.username} (${child.id}, linked to ${parent.id})`);
  return child;
}

/** Lifting an action also lifts the ones it passed on to linked accounts. */
async function liftLinked(a, by, reason) {
  for (const id of a.linked || []) {
    const child = moderation.find(id);
    if (!child || child.status !== 'active') continue;
    await moderation.lift(child, by, `Lifted together with ${a.id}: ${reason}`);
    await refreshAccount(child.customer.id);
    await tellCustomer(child, auth.userById(child.customer.id), {
      title: 'Your Tree Host account can be used again',
      paragraphs: [`We've lifted the ${child.type === 'ban' ? 'ban' : 'suspension'} (action ${child.id}).`, String(reason || '').trim(), 'Thanks for your patience.'].filter(Boolean),
    });
  }
}

route('GET', '/api/admin/actions', (req, res, p, q) => ({
  actions: moderation.search(logFilters(q)),
  pendingAppeals: [...moderation.actions.values()].filter((a) => a.appeal && a.appeal.status === 'pending').length,
  total: moderation.actions.size,
  counts: Object.fromEntries(Object.keys(TYPES).map((t) => [t, [...moderation.actions.values()].filter((a) => a.type === t).length])),
  types: TYPES,
  reasons: REASONS,
}), { perm: 'moderation.view' });

route('GET', '/api/admin/actions.csv', (req, res, p, q) => {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Action', 'Type', 'Target', 'Status', 'Reason', 'Customer', 'Email', 'Server', 'Taken by', 'Taken at (UTC)', 'Ends (UTC)', 'Appeal', 'Evidence']];
  for (const a of moderation.search(logFilters(q))) {
    rows.push([a.id, a.typeLabel, a.target, a.status, a.reasonLabel, a.customer.username, a.customer.email, a.server ? a.server.name : '', a.by,
      new Date(a.createdAt).toISOString(), a.until ? new Date(a.until).toISOString() : '', a.appeal || '', a.evidence]);
  }
  audit(req, `exported the action logs (CSV${[...q.keys()].length ? ', filtered' : ''})`);
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="tree-host-action-logs-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' });
  res.end(`﻿${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`);
  return HANDLED;
}, { perm: 'moderation.view' });

route('GET', '/api/admin/actions/:aid', (req, res, p) => moderation.full(moderation.get(p.aid)), { perm: 'moderation.view' });

route('GET', '/api/admin/actions/:aid/report.pdf', async (req, res, p, q) => {
  const a = moderation.get(p.aid);
  const pdf = await moderation.report(a, `${req.user.username} (${rbac.role(req.user.role).label})`);
  audit(req, `${q.get('download') ? 'downloaded' : 'viewed'} the PDF report for ${a.id}`);
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `${q.get('download') ? 'attachment' : 'inline'}; filename="Tree-Host-${a.id}.pdf"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(pdf);
  return HANDLED;
}, { perm: 'moderation.view' });

route('GET', '/api/admin/actions/:aid/evidence/:eid', async (req, res, p) => {
  const { ev, data } = await moderation.evidenceFile(moderation.get(p.aid), p.eid);
  res.writeHead(200, {
    'Content-Type': ev.kind === 'image' ? 'image/jpeg' : 'text/plain; charset=utf-8',
    'Content-Disposition': `inline; filename="${ev.name.replace(/"/g, '')}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
  return HANDLED;
}, { perm: 'moderation.view' });

/**
 * Takes an action. Body: { target: 'account'|'server', userId | serverId, type, reason, message, notes, days (suspensions,
 * 0 = until lifted), appealable, email, includeLog, evidence: [{ kind, name, data | text }] }
 */
route('POST', '/api/admin/actions', async (req) => {
  const b = await readJson(req, 40 * 1024 * 1024);
  const target = b.target === 'server' ? 'server' : 'account';
  if (!['warn', 'suspend', 'ban', 'delete'].includes(b.type)) throw httpError(400, 'Pick what to do: warning, suspension, ban or deletion.');
  requirePerm(req, permFor(b.type, target));
  let inst = null;
  let user;
  if (target === 'server') {
    inst = manager.get(b.serverId);
    if (!inst) throw httpError(404, 'Server not found');
    user = auth.userById(inst.cfg.owner);
  } else {
    user = auth.userById(b.userId);
    if (!user) throw httpError(404, 'Account not found');
  }
  if (user && user.id === req.user.id) throw httpError(400, "You can't take action on your own account or servers. Ask another staff member.");
  if (user) requireOutranks(req, user.id);
  if (user && user.role === 'owner' && target === 'account' && b.type !== 'warn') throw httpError(400, 'Owners cannot be suspended, banned or deleted. Change their role first.');
  const days = Math.max(0, Math.min(3650, Math.round(Number(b.days) || 0)));
  const evidence = Array.isArray(b.evidence) ? b.evidence.slice(0, 20) : [];
  // Accounts used in the same browser get the same action (each with its own number). Staff at or above your level are skipped.
  const linked = target === 'account' && b.includeLinked !== false && user ? auth.linkedAccounts(user) : [];
  const linkedOk = linked.filter((u) => u.id !== req.user.id && u.role === 'customer'); // staff accounts are never included

  const a = await moderation.create({
    type: b.type, target, reason: b.reason, message: b.message, notes: b.notes, appealable: b.appealable !== false,
    until: b.type === 'suspend' && days ? Date.now() + days * 86400000 : null,
    by: { id: req.user.id, username: req.user.username, role: req.user.role, roleLabel: rbac.role(req.user.role).label },
    customer: customerSnapshot(user),
    server: inst ? serverSnapshot(inst) : null,
  });
  // Evidence: what staff attached, plus the console log(s) when asked (the proof is kept even if the server goes).
  for (const item of evidence) await moderation.addEvidence(a, item, req.user.username).catch((e) => moderation.note(a, 'Tree Host', `Evidence "${item.name}" was not saved: ${e.message}`));
  if (b.includeLog !== false) {
    const servers = inst ? [inst] : [...manager.instances.values()].filter((i) => user && i.cfg.owner === user.id);
    for (const s of servers) {
      const log = consoleLog(s);
      if (log.trim()) await moderation.addEvidence(a, { kind: 'log', name: `Console log of ${s.cfg.name} (last 500 lines).txt`, text: log }, 'Tree Host (automatic)');
    }
  }

  // Do it.
  if (target === 'account') {
    await enforceAccountAction(a, user, req.user.username, { email: b.email !== false });
    for (const other of linked.filter((u) => !linkedOk.includes(u))) moderation.note(a, 'Tree Host', `Linked account ${other.username} was skipped (staff account)`);
    for (const other of linkedOk) await linkedAction(a, other, a.by, { email: b.email !== false });
  } else {
    if (a.type === 'suspend' || a.type === 'ban') {
      refreshServer(inst.cfg.id);
      inst.sysLog(`This server was ${a.type === 'ban' ? 'banned' : 'suspended'} by Tree Host staff (action ${a.id}).`);
    }
    if (a.type === 'delete') {
      inst.logActivity('server', who(req), `deleted server "${inst.cfg.name}" (action ${a.id})`);
      await manager.remove(inst.cfg.id);
      billing.detachServer(inst.cfg.id);
    }
    if (a.type !== 'delete' || user) await tellCustomer(a, user, { ...actionNotice(a), email: b.email !== false });
  }

  const subject = target === 'server' ? `the server "${a.server.name}"${user ? ` of ${user.username}` : ''}` : `the account ${a.customer.username}`;
  moderation.note(a, 'Tree Host', `Customer told by ${[a.notified.inbox && 'inbox', a.notified.email && 'email'].filter(Boolean).join(' and ') || 'nothing (no email address or email is off)'}`);
  await moderation.save();
  audit(req, `${{ warn: 'warned', suspend: 'suspended', ban: 'banned', delete: 'deleted' }[a.type]} ${subject} (${a.id}: ${REASONS[a.reason]})${a.linked && a.linked.length ? ` and ${a.linked.length} linked account${a.linked.length === 1 ? '' : 's'}` : ''}`, inst && a.type !== 'delete' ? inst : null);
  return moderation.full(a);
}, { perm: 'console.access' });

route('POST', '/api/admin/actions/:aid/evidence', async (req, res, p) => {
  const a = moderation.get(p.aid);
  const b = await readJson(req, 40 * 1024 * 1024);
  for (const item of (Array.isArray(b.evidence) ? b.evidence : []).slice(0, 20)) await moderation.addEvidence(a, item, req.user.username);
  moderation.note(a, req.user.username, 'Added evidence');
  await moderation.save();
  audit(req, `added evidence to ${a.id}`);
  return moderation.full(a);
}, { perm: 'moderation.act' });

route('POST', '/api/admin/actions/:aid/lift', async (req, res, p) => {
  const a = moderation.get(p.aid);
  requirePerm(req, a.type === 'ban' ? 'moderation.ban' : 'moderation.act');
  const { reason } = await readJson(req);
  if (String(reason || '').trim().length < 5) throw httpError(400, 'Write why it is being lifted.');
  await moderation.lift(a, req.user, reason);
  if (a.target === 'server') refreshServer(a.server.id);
  else await refreshAccount(a.customer.id);
  await liftLinked(a, req.user, reason);
  const user = auth.userById(a.customer.id);
  await tellCustomer(a, user, {
    title: a.target === 'server' ? `Your server "${a.server.name}" can be used again` : 'Your Tree Host account can be used again',
    paragraphs: [`We've lifted the ${a.type === 'ban' ? 'ban' : 'suspension'} (action ${a.id}).`, String(reason).trim(), 'Thanks for your patience.'],
  });
  audit(req, `lifted ${a.id} (${a.type} of ${a.target === 'server' ? `"${a.server.name}"` : a.customer.username})`);
  return moderation.full(a);
}, { perm: 'console.access' });

route('POST', '/api/admin/actions/:aid/appeal', async (req, res, p) => {
  const a = moderation.get(p.aid);
  const { decision, response } = await readJson(req);
  if (!a.appeal || a.appeal.status !== 'pending') throw httpError(400, 'There is no appeal waiting for this action.');
  if (!['accept', 'deny'].includes(decision)) throw httpError(400, 'Accept or deny the appeal.');
  if (String(response || '').trim().length < 5) throw httpError(400, 'Write an answer for the customer.');
  a.appeal.status = decision === 'accept' ? 'accepted' : 'denied';
  a.appeal.response = String(response).trim().slice(0, 4000);
  a.appeal.decidedBy = req.user.username;
  a.appeal.decidedAt = Date.now();
  moderation.note(a, req.user.username, `Appeal ${a.appeal.status}`);
  if (decision === 'accept' && a.status === 'active') {
    await moderation.lift(a, req.user, `Appeal accepted: ${a.appeal.response}`);
    if (a.target === 'server') refreshServer(a.server.id);
    else await refreshAccount(a.customer.id);
    await liftLinked(a, req.user, `Appeal for ${a.id} accepted`);
  }
  await moderation.save();
  await tellCustomer(a, auth.userById(a.customer.id), {
    title: `Your appeal for ${a.id} was ${a.appeal.status}`,
    paragraphs: [
      decision === 'accept'
        ? `Good news: we've accepted your appeal${a.type === 'suspend' || a.type === 'ban' ? ' and lifted the action' : ''}.`
        : "We've looked at your appeal carefully and the decision stays.",
      a.appeal.response,
      `Action number: ${a.id}.`,
    ],
  });
  audit(req, `${a.appeal.status} the appeal for ${a.id}`);
  return moderation.full(a);
}, { perm: 'moderation.appeals' });

// Old-style suspensions (from before actions had numbers) are lifted from People.
route('POST', '/api/team/users/:uid/lift-legacy', async (req, res, p) => {
  requireOutranks(req, p.uid);
  const u = auth.userById(p.uid);
  if (!u || !u.restriction || u.restriction.actionId) throw httpError(400, 'This account has no old-style suspension.');
  await auth.setRestriction(u.id, null);
  audit(req, `lifted the old suspension of ${u.username}`);
  return auth.publicUser(u);
}, { perm: 'moderation.act' });

// Staff message to a customer's inbox (and email).
route('POST', '/api/admin/messages', async (req) => {
  const b = await readJson(req);
  const u = auth.userById(b.userId);
  if (!u) throw httpError(404, 'Account not found');
  const title = String(b.title || '').trim();
  const body = String(b.body || '').trim();
  if (title.length < 3 || body.length < 5) throw httpError(400, 'Write a subject and a message.');
  await tellCustomer(null, u, { title, paragraphs: [...body.split(/\n{2,}/), `From ${req.user.username}, Tree Host ${rbac.role(req.user.role).label}`], email: b.email !== false });
  audit(req, `sent a message to ${u.username}: "${title.slice(0, 80)}"`);
  return { ok: true };
}, { perm: 'messages.send' });

// ----- the customer's side: their inbox, their actions, appeals (allowed while suspended or banned) -----

route('GET', '/api/inbox', (req) => {
  if (!TEAM) return { messages: [], unread: 0 };
  const messages = moderation.inbox(req.user.id);
  return { messages, unread: messages.filter((m) => !m.read).length };
}, { restrictedOk: true });

route('POST', '/api/inbox/read', async (req) => {
  if (TEAM) await moderation.markRead(req.user.id, (await readJson(req)).id || null);
  return { ok: true };
}, { restrictedOk: true });

route('GET', '/api/moderation/mine', (req) => {
  if (!TEAM) return { restriction: null, actions: [] };
  const u = req.user;
  const actions = moderation.forUser(u.id).map((a) => moderation.forCustomer(a));
  const r = u.restriction ? { ...u.restriction, action: actions.find((a) => a.id === u.restriction.actionId) || null } : null;
  return { restriction: r, actions, supportEmail: EMAILS.support };
}, { restrictedOk: true });

route('POST', '/api/moderation/:aid/appeal', async (req, res, p) => {
  const a = moderation.find(p.aid);
  if (!a || a.customer.id !== req.user.id) throw httpError(404, 'Action not found.');
  if (!moderation.forCustomer(a).appealable) throw httpError(400, a.appeal ? 'You have already appealed this.' : 'This action cannot be appealed.');
  const text = String((await readJson(req)).text || '').trim();
  if (text.length < 20) throw httpError(400, 'Tell us why you think this was a mistake (at least 20 characters).');
  a.appeal = { text: text.slice(0, 4000), at: Date.now(), status: 'pending' };
  moderation.note(a, req.user.username, 'Appeal sent');
  await moderation.save();
  activity.log('moderation', req.user.username, `appealed ${a.id} (${TYPES[a.type].toLowerCase()} of ${a.target === 'server' ? `"${a.server.name}"` : 'their account'})`);
  await moderation.message(req.user.id, { title: `We got your appeal for ${a.id}`, body: "Thanks. A member of our team will look at it and you'll get the answer here and by email.", actionId: a.id, kind: 'appeal' });
  if (mail.enabled()) {
    mail.send(EMAILS.support, `New appeal for ${a.id} from ${req.user.username}`, [`${req.user.username} appealed ${a.id} (${TYPES[a.type]} of the ${a.target}).`, text, 'Decide it in the Staff Console → Action logs.'],
      PUBLIC_URL ? { text: 'Open the action', url: `${PUBLIC_URL}/admin#actions/${a.id}` } : null, { community: false, note: 'Sent to the Tree Host team.' }).catch(() => {});
  }
  return moderation.forCustomer(a);
}, { restrictedOk: true });

// Suspensions end by themselves on their end date.
async function expireActions() {
  if (!TEAM) return;
  for (const a of moderation.expired()) {
    await moderation.lift(a, { username: 'Tree Host' }, 'The end date passed', 'expired');
    if (a.target === 'server') refreshServer(a.server.id);
    else await refreshAccount(a.customer.id);
    await tellCustomer(a, auth.userById(a.customer.id), {
      title: a.target === 'server' ? `Your server "${a.server.name}" can be used again` : 'Your suspension has ended',
      paragraphs: [`The suspension (action ${a.id}) ended on ${fmtDate(a.until)}. Welcome back, and please keep to the rules.`],
    });
  }
}

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
    serverName: billing.serversOf(x).map((v) => v.name).join(', ') || null,
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
      `Hi **${target.username}**, you've been given a free ${c.planName} plan on Tree Host${c.days ? ` for ${c.length}` : ' for life'}! 🎁`,
      'Open Billing, choose **Have a code?**, and paste your code. It only works for your account.',
    ], PUBLIC_URL ? { text: 'Claim my server', url: `${PUBLIC_URL}/dashboard?billing` } : null, {
      heading: 'A free server for you 🎁', replyTo: EMAILS.promo,
      details: [['Your code', `**${c.code}**`], ['Plan', c.planName], ['For', c.days ? c.length : 'Life']],
    }).then(() => (c.emailed = true)).catch(() => (c.emailed = false));
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
        serverName: billing.serversOf(x).map((v) => v.name).join(', ') || null,
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
    running: !!i.proc, suspended: i.cfg.suspended || null, moderation: i.cfg.moderation || null, players: (j.players || []).length, maxPlayers: j.maxPlayers || null,
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

/** Welcome email; for an email that isn't verified yet it carries the confirm button. */
async function welcomeEmail(req, user) {
  let verifyLink = null;
  if (user.firebaseUid && !user.emailVerified && firebase.linksEnabled()) {
    verifyLink = await firebase.emailLink('verify', user.email, `${siteUrl(req)}/dashboard`).catch(() => null);
  }
  await sendEmail(user.email, EMAIL.welcome(user, siteUrl(req), verifyLink));
}

// Our own branded password reset and email confirmation emails (with Firebase making the one-time links).
// Without them set up, the browser asks Firebase to send its plain emails instead ({ fallback: true }).
route('POST', '/api/auth/email-link', async (req) => {
  const b = await readJson(req);
  const type = b.type === 'verify' ? 'verify' : 'reset';
  const email = String(b.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, 'Enter your email address.');
  if (!TEAM || !firebase.linksEnabled() || !mail.enabled()) return { ok: true, fallback: true };
  const keys = [`link:${clientIp(req)}`, `link:${email}`];
  auth.checkRate(keys);
  auth.recordFailure(keys);
  const user = auth.users.find((u) => u.email === email);
  const link = await firebase.emailLink(type, email, `${siteUrl(req)}/dashboard`);
  if (link) await sendEmail(email, type === 'verify' ? EMAIL.verify(user && user.username, link) : EMAIL.reset(user && user.username, link));
  // Same answer either way, so nobody can find out which emails have accounts.
  return { ok: true };
}, { public: true });

// Staff: email status, previews of every email, and a test email to yourself.
const PREVIEW_USER = { username: 'Steve', email: 'steve@example.com' };
const PREVIEW_SUB = { planName: 'Oak', ramMb: 4096, cpus: 2, diskGb: 30, periodEnd: Date.now() + 30 * 86400000 };
const PREVIEWS = {
  welcome: (base) => EMAIL.welcome(PREVIEW_USER, base, `${base}/dashboard`),
  verify: (base) => EMAIL.verify('Steve', `${base}/dashboard`),
  reset: (base) => EMAIL.reset('Steve', `${base}/dashboard`),
  planActive: (base) => EMAIL.planActive(PREVIEW_USER, PREVIEW_SUB, base),
  planEnded: (base) => EMAIL.planEnded(PREVIEW_USER, PREVIEW_SUB, base),
  paymentFailed: (base) => ['Your Tree Host payment failed', ["Hi Steve, we couldn't take the payment for your Oak server.", 'Your server keeps running for 3 days. Please update your card in Billing to keep it online.'], { text: 'Open Billing', url: `${base}/dashboard?billing` }, { replyTo: EMAILS.billing }],
  action: (base) => ["We've suspended your server \"Steve's SMP\"", ['Your server was running a crypto miner, which our Terms of Service do not allow.', "The server is stopped and can't be started for 7 days. Your files are kept.", 'Reason: Crypto mining. Action number: TH-000012.', 'If you think this is a mistake, you can appeal: open your Tree Host inbox and press "Appeal", or reply to this email. Mention the action number.'], { text: 'Open your inbox', url: `${base}/dashboard?inbox` }, {}],
};
route('GET', '/api/admin/emails', () => ({
  enabled: mail.enabled(),
  brandedLinks: firebase.linksEnabled(),
  from: process.env.MAIL_FROM || 'Tree Host <no-reply@treehost.online>',
  inboxes: EMAILS,
  previews: Object.keys(PREVIEWS),
}), { perm: 'settings.manage' });
route('GET', '/api/admin/emails/preview/:kind', (req, res, p) => {
  const make = PREVIEWS[p.kind];
  if (!make) throw httpError(404, 'No such email.');
  const [subject, paragraphs, button, opts] = make(siteUrl(req));
  const { html } = mail.render(subject, paragraphs, button, { ...opts, preview: true });
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'" });
  res.end(html);
  return HANDLED;
}, { perm: 'settings.manage' });
route('POST', '/api/admin/emails/test', async (req) => {
  if (!mail.enabled()) throw httpError(400, 'Emails are off: put RESEND_API_KEY in the settings file and restart.');
  if (!req.user.email) throw httpError(400, 'Your account has no email address.');
  const { kind } = await readJson(req);
  await sendEmail(req.user.email, (PREVIEWS[kind] || PREVIEWS.welcome)(siteUrl(req)));
  audit(req, 'sent a test email to themselves');
  return { ok: true, to: req.user.email };
}, { perm: 'settings.manage' });

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
    let kind = 'server';
    try {
      kind = providers.getProvider(String(body.type || 'paper')).kind;
    } catch {}
    const full = billing.slotError(sub, kind);
    if (full) throw httpError(400, full);
    body.memoryMb = sub.slots && kind === 'proxy' ? sub.proxyRamMb || 1024 : sub.ramMb;
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
  if (inst.isCustomer && body.type && body.type !== inst.cfg.type) {
    const sub = inst.cfg.subscriptionId ? billing.sub(inst.cfg.subscriptionId) : null;
    let kind = 'server';
    try {
      kind = providers.getProvider(String(body.type)).kind;
    } catch {}
    if (sub && sub.slots && kind !== inst.provider.kind) {
      const full = billing.slotError(sub, kind, inst.cfg.id);
      if (full) throw httpError(400, full);
      body.memoryMb = kind === 'proxy' ? sub.proxyRamMb || 1024 : sub.ramMb;
    }
  }
  return (await manager.update(p.id, body)).toJSON();
});
route('DELETE', '/api/servers/:id', async (req, res, p) => {
  const inst = getFor(req, p.id, 'manage');
  if (TEAM && inst.isCustomer && inst.cfg.owner && inst.cfg.owner !== req.user.id) {
    throw httpError(400, "To delete a customer's server, use 'Take action' → Delete: they get the reason and there is a report.", 'USE_ACTION');
  }
  inst.logActivity('server', who(req), `deleted server "${inst.cfg.name}"`);
  await manager.remove(p.id);
  billing.detachServer(p.id);
  return { ok: true };
});

// ---------- Tree Host staff in Minecraft ----------
// Staff (anyone who can open the Staff Console, with a Minecraft name in Account) get special treatment on customer
// servers, done with standard Minecraft commands so it works on Vanilla, Paper, Spigot, Purpur and Fabric:
// they can join even when the server is whitelisted, everyone sees a green-and-gold "Tree Host staff joined" notice,
// they wear a gold STAFF badge in chat and in the player list (hover: "Official Tree Host Staff"), and bans on them
// are undone at once. Only on online-mode servers, where Minecraft has checked that the name really is theirs.

const STAFF_TEAM = 'th_staff';
const mcName = /^[A-Za-z0-9_]{3,16}$/;
const staffFor = (name) => (TEAM && name ? auth.users.find((u) => u.mcName && u.mcName.toLowerCase() === name.toLowerCase() && rbac.isStaff(u)) : null);

function versionAtLeast(v, want) {
  const a = String(v || '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < want.length; i++) {
    if ((a[i] || 0) !== want[i]) return (a[i] || 0) > want[i];
  }
  return true;
}

/** A chat component as a command argument, in the format this Minecraft version understands. */
function component(inst, parts) {
  const snbt = versionAtLeast(inst.cfg.version, [1, 21, 5]);
  const conv = (p) => {
    const o = { text: p.text };
    if (p.color) o.color = p.color;
    if (p.bold) o.bold = true;
    if (p.hover) {
      if (snbt) o.hover_event = { action: 'show_text', value: { text: p.hover, color: 'green' } };
      else if (versionAtLeast(inst.cfg.version, [1, 16])) o.hoverEvent = { action: 'show_text', contents: { text: p.hover, color: 'green' } };
      else o.hoverEvent = { action: 'show_text', value: { text: p.hover, color: 'green' } };
    }
    return o;
  };
  return JSON.stringify(['', ...parts.map(conv)]);
}

const supportsStaffFeatures = (inst) => inst.provider.kind !== 'proxy' && versionAtLeast(inst.cfg.version, [1, 13]);

function staffWelcome(inst, name, user) {
  const role = rbac.role(user.role).label;
  const badge = { text: '✔ STAFF ', color: 'gold', bold: true, hover: 'Official Tree Host Staff' };
  inst.write(`team add ${STAFF_TEAM}`);
  inst.write(`team modify ${STAFF_TEAM} color gold`);
  inst.write(`team modify ${STAFF_TEAM} prefix ${component(inst, [badge])}`);
  inst.write(`team join ${STAFF_TEAM} ${name}`);
  inst.write(`tellraw @a ${component(inst, [
    { text: '🌳 Tree Host ', color: 'green', bold: true },
    { text: `» ${name} `, color: 'gold', bold: true },
    { text: `(${role}) joined. `, color: 'gold' },
    { text: `A Tree Host ${role} has joined your server.`, color: 'green', hover: 'Official Tree Host Staff' },
  ])}`);
  inst.sysLog(`Tree Host staff ${name} (${user.username}, ${role}) joined the server.`);
  inst.logActivity('staff', user.username, `joined "${inst.cfg.name}" in Minecraft as ${name} (${role})`);
}

manager.onConsoleLine = (inst, line) => {
  if (!TEAM || !inst.isCustomer || !supportsStaffFeatures(inst)) return;
  inst.staffJoined = inst.staffJoined || new Set();
  inst.staffWhitelisted = inst.staffWhitelisted || new Set();
  let m = /: ([A-Za-z0-9_]{3,16}) joined the game/.exec(line);
  if (m) {
    const user = staffFor(m[1]);
    if (!user) return;
    if (inst.onlineMode === false) {
      inst.sysLog(`${m[1]} has a Tree Host staff name, but this server is in offline mode, so it can't be checked: no staff badge.`);
      return;
    }
    inst.staffJoined.add(m[1].toLowerCase());
    staffWelcome(inst, m[1], user);
    return;
  }
  // A staff member stopped by the whitelist: let them in for this visit (they just join again).
  // Vanilla: "Steve (/1.2.3.4:5678) lost connection: You are not white-listed", Paper: "Disconnecting Steve (/1.2.3.4:5678): You are
  // not whitelisted", older: "...GameProfile@...[...name=Steve,...] ... You are not white-listed".
  m = /: ([A-Za-z0-9_]{3,16}) \(\/[^)]*\) lost connection: .*not white-?listed/i.exec(line)
    || /Disconnecting ([A-Za-z0-9_]{3,16}) \(\/[^)]*\): .*not white-?listed/i.exec(line)
    || /name=([A-Za-z0-9_]{3,16}).*not white-?listed/i.exec(line);
  if (m && staffFor(m[1]) && inst.onlineMode !== false) {
    inst.write(`whitelist add ${m[1]}`);
    inst.staffWhitelisted.add(m[1].toLowerCase());
    inst.sysLog(`Tree Host staff ${m[1]} was let through the whitelist for this visit.`);
    return;
  }
  m = /: ([A-Za-z0-9_]{3,16}) left the game/.exec(line);
  if (m && inst.staffJoined.has(m[1].toLowerCase())) {
    inst.staffJoined.delete(m[1].toLowerCase());
    inst.write(`team leave ${m[1]}`);
    if (inst.staffWhitelisted.delete(m[1].toLowerCase())) inst.write(`whitelist remove ${m[1]}`);
    return;
  }
  // Staff can't be banned from customer servers: undo it straight away.
  m = /: (?:\[[A-Za-z0-9_]{1,16}: )?Banned ([A-Za-z0-9_]{3,16})[:,]/.exec(line); // console or op feedback, never chat
  if (m && staffFor(m[1])) {
    inst.write(`pardon ${m[1]}`);
    inst.write(`tellraw @a ${component(inst, [{ text: '🌳 Tree Host ', color: 'green', bold: true }, { text: `» ${m[1]} is Tree Host staff and can't be banned.`, color: 'gold' }])}`);
    inst.sysLog(`Someone tried to ban Tree Host staff ${m[1]}; the ban was undone.`);
    return;
  }
  m = /: (?:\[[A-Za-z0-9_]{1,16}: )?Kicked ([A-Za-z0-9_]{3,16})[:,]/.exec(line);
  if (m && staffFor(m[1])) {
    inst.write(`tellraw @a ${component(inst, [{ text: '🌳 Tree Host ', color: 'green', bold: true }, { text: `» ${m[1]} is Tree Host staff. Please don't kick staff while they help you.`, color: 'gold' }])}`);
    inst.sysLog(`Tree Host staff ${m[1]} was kicked. They can join again at any time.`);
    return;
  }
  m = /: (?:\[[A-Za-z0-9_]{1,16}: )?Removed ([A-Za-z0-9_]{3,16}) from the whitelist/.exec(line);
  if (m && inst.staffJoined.has(m[1].toLowerCase()) && staffFor(m[1])) inst.write(`whitelist add ${m[1]}`);
};

// "Join as staff": lets you through the whitelist and any ban, and gives you the address.
route('POST', '/api/servers/:id/staff-join', async (req, res, p) => {
  const inst = getFor(req, p.id);
  if (!inst.proc || inst.status !== 'running') throw httpError(400, 'Start the server first (or ask the owner to).');
  const name = req.user.mcName;
  if (!name || !mcName.test(name)) throw httpError(400, 'Set your Minecraft name first (Account → Minecraft name).');
  if (!supportsStaffFeatures(inst)) throw httpError(400, 'Staff joining works on Minecraft servers 1.13 and newer (not proxies).');
  inst.staffWhitelisted = inst.staffWhitelisted || new Set();
  inst.write(`pardon ${name}`);
  inst.write(`whitelist add ${name}`);
  inst.staffWhitelisted.add(name.toLowerCase());
  audit(req, `joined the server "${inst.cfg.name}" in Minecraft as staff (${name})`, inst);
  return { ok: true, address: inst.toJSON().publicAddress, name, onlineMode: inst.onlineMode !== false };
}, { perm: 'console.access' });

// ---------- custom addresses (the owner's own domain instead of Tree Host's address) ----------

const dnsp = require('dns').promises;
const net = require('net');
const OWN_DOMAINS = ['treehost.online'];

function cleanDomain(input) {
  let d = String(input || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/:].*$/, '').replace(/\.$/, '');
  if (!d) return '';
  if (d.length > 200 || !/^(?=.{4,200}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d)) throw httpError(400, 'Enter a domain like play.yourserver.com (no http://, no port).');
  if (OWN_DOMAINS.some((o) => d === o || d.endsWith(`.${o}`))) throw httpError(400, "That's a Tree Host address. Use a domain you own.");
  return d;
}

/** The DNS records the owner adds at their domain provider so players can join with their own address. */
manager.domainRecords = (inst) => {
  const d = inst.cfg.customDomain;
  const host = manager.gameHost || 'play.treehost.online';
  if (!d) return [];
  const port = inst.cfg.port;
  const records = [];
  // If the game host is a bare IP, the domain itself gets an A record and the SRV record points at it.
  const target = net.isIP(host) ? d.host : host;
  if (net.isIP(host)) records.push({ type: 'A', name: d.host, value: host, note: 'Points your domain at the Tree Host machine.' });
  if (port === 25565 && !net.isIP(host)) records.push({ type: 'CNAME', name: d.host, value: host, note: 'Your server uses the default port, so this one record is enough.' });
  else records.push({ type: 'SRV', name: `_minecraft._tcp.${d.host}`, value: `0 5 ${port} ${target}`, priority: 0, weight: 5, port, target, note: 'Tells Minecraft which port to use, so players can type just your domain.' });
  return records;
};

/** Checks the owner's DNS: does their domain lead Minecraft to this server? */
async function checkDomain(inst) {
  const host = inst.cfg.customDomain.host;
  const gameHost = manager.gameHost;
  if (!gameHost || gameHost === 'localhost') return { ok: false, message: 'This Tree Host has no public game address yet, so custom domains can\'t be checked here.' };
  const port = inst.cfg.port;
  const ours = new Set(net.isIP(gameHost) ? [gameHost] : await dnsp.resolve4(gameHost).catch(() => []));
  const pointsHere = async (name) => name.toLowerCase() === gameHost.toLowerCase() || (await dnsp.resolve4(name).catch(() => [])).some((ip) => ours.has(ip));
  const srv = await dnsp.resolveSrv(`_minecraft._tcp.${host}`).catch(() => []);
  for (const r of srv) if (r.port === port && (await pointsHere(r.name))) return { ok: true };
  if (port === 25565 && (await pointsHere(host))) return { ok: true };
  if (srv.length) return { ok: false, message: `Found an SRV record, but it points to ${srv[0].name} port ${srv[0].port}. It should point to ${net.isIP(gameHost) ? host : gameHost} port ${port}.` };
  if (await pointsHere(host)) return { ok: false, message: `${host} points at Tree Host, but your server uses port ${port}, so the SRV record is needed too.` };
  return { ok: false, message: `No record found for ${host} yet. DNS changes usually take a few minutes (sometimes up to an hour). Check again later.` };
}

route('PUT', '/api/servers/:id/domain', async (req, res, p) => {
  const inst = getFor(req, p.id, 'settings');
  const host = cleanDomain((await readJson(req)).domain);
  if (!host) {
    inst.cfg.customDomain = null;
    manager.save();
    inst.emitStatus();
    return inst.toJSON();
  }
  const taken = [...manager.instances.values()].find((i) => i !== inst && i.cfg.customDomain && i.cfg.customDomain.host === host);
  if (taken) throw httpError(400, 'Another server already uses that domain.');
  inst.cfg.customDomain = { host, verified: false, addedAt: Date.now(), checkedAt: null, message: '' };
  const r = await checkDomain(inst).catch((e) => ({ ok: false, message: e.message }));
  Object.assign(inst.cfg.customDomain, { verified: r.ok, checkedAt: Date.now(), message: r.ok ? '' : r.message });
  manager.save();
  inst.logActivity('server', who(req), `set the custom address ${host}`);
  inst.emitStatus();
  return inst.toJSON();
});
route('POST', '/api/servers/:id/domain/check', async (req, res, p) => {
  const inst = getFor(req, p.id, 'settings');
  if (!inst.cfg.customDomain) throw httpError(400, 'Add your domain first.');
  const r = await checkDomain(inst).catch((e) => ({ ok: false, message: e.message }));
  const was = inst.cfg.customDomain.verified;
  Object.assign(inst.cfg.customDomain, { verified: r.ok, checkedAt: Date.now(), message: r.ok ? '' : r.message });
  manager.save();
  if (r.ok && !was) inst.sysLog(`Players can now join with ${inst.cfg.customDomain.host}.`);
  inst.emitStatus();
  return inst.toJSON();
});

// ---------- the public server list (servers whose owner turned it on) ----------

const LISTING_TAGS = ['Survival', 'SMP', 'Creative', 'Modded', 'PvP', 'Minigames', 'Skyblock', 'Roleplay', 'Factions', 'Economy', 'Parkour', 'Hardcore', 'Vanilla', 'Network'];

route('PUT', '/api/servers/:id/listing', async (req, res, p) => {
  const inst = getFor(req, p.id, 'settings');
  const b = await readJson(req);
  const discord = String(b.discord || '').trim();
  if (discord && !/^https:\/\/(discord\.gg|discord\.com\/invite)\/[\w-]{2,40}$/.test(discord)) throw httpError(400, 'The Discord link should look like https://discord.gg/abc123.');
  const website = String(b.website || '').trim();
  if (website && !/^https:\/\/[^\s"<>]{4,200}$/.test(website)) throw httpError(400, 'The website should start with https://.');
  inst.cfg.listing = {
    public: !!b.public,
    description: String(b.description || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    tags: [...new Set((Array.isArray(b.tags) ? b.tags : []).filter((t) => LISTING_TAGS.includes(t)))].slice(0, 4),
    discord,
    website,
    since: (inst.cfg.listing && inst.cfg.listing.since) || (b.public ? Date.now() : null),
  };
  manager.save();
  publicListCache = null;
  inst.logActivity('server', who(req), b.public ? 'listed the server on the public server list' : 'updated the server list settings');
  inst.emitStatus();
  return inst.toJSON();
});

/** Servers shown on the public list: listed by their owner, with an active plan, not suspended or banned. */
function listedServers() {
  return [...manager.instances.values()].filter((i) => {
    if (!i.cfg.listing || !i.cfg.listing.public || i.cfg.moderation || i.cfg.suspended) return false;
    const owner = auth.userById(i.cfg.owner);
    if (TEAM && (!owner || owner.restriction)) return false;
    const plan = manager.planInfo(i);
    return !TEAM || !i.isCustomer || (plan && plan.usable);
  });
}

function maxPlayers(inst) {
  try {
    const m = /^max-players=(\d+)/m.exec(fs.readFileSync(path.join(inst.dir, 'server.properties'), 'utf8'));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

let publicListCache = null;
route('GET', '/api/public/servers', () => {
  if (publicListCache && Date.now() - publicListCache.at < 15000) return publicListCache.data;
  const data = {
    tags: LISTING_TAGS,
    servers: listedServers().map((i) => {
      const j = i.toJSON();
      const online = !!i.proc && i.status === 'running';
      return {
        id: j.id,
        name: j.name,
        icon: j.icon ? `/api/public/servers/${encodeURIComponent(j.id)}/icon?v=${j.icon}` : null,
        description: i.cfg.listing.description,
        tags: i.cfg.listing.tags,
        discord: i.cfg.listing.discord || null,
        website: i.cfg.listing.website || null,
        software: j.typeLabel,
        version: j.version,
        kind: j.kind,
        address: j.publicAddress || null,
        online,
        players: online ? (j.players || []).length : 0,
        maxPlayers: maxPlayers(i),
        listedSince: i.cfg.listing.since || null,
      };
    }),
  };
  publicListCache = { at: Date.now(), data };
  return data;
}, { public: true });

route('GET', '/api/public/servers/:id/icon', async (req, res, p) => {
  const inst = listedServers().find((i) => i.cfg.id === p.id);
  const data = inst ? await fsp.readFile(path.join(inst.dir, 'server-icon.png')).catch(() => null) : null;
  if (!data) throw httpError(404, 'No icon.');
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
  return HANDLED;
}, { public: true });

// Server icon: server-icon.png (a 64x64 PNG) in the server folder, shown next to the server in Minecraft's server
// list. Paper, Spigot, Fabric, Vanilla, Velocity, BungeeCord and Waterfall all read it when they start.
function pngSize(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!buf || buf.length < 24 || sig.some((b, i) => buf[i] !== b) || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
route('GET', '/api/servers/:id/icon', async (req, res, p) => {
  const inst = getFor(req, p.id);
  const data = await fsp.readFile(path.join(inst.dir, 'server-icon.png')).catch(() => null);
  if (!data) throw httpError(404, 'This server has no icon.');
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=31536000', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
  return HANDLED;
});
route('PUT', '/api/servers/:id/icon', async (req, res, p) => {
  const inst = getFor(req, p.id, 'settings');
  const png = await readBytes(req, 512 * 1024);
  const size = pngSize(png);
  if (!size) throw httpError(400, 'The icon must be a PNG picture.');
  if (size.width !== 64 || size.height !== 64) throw httpError(400, `Minecraft needs the icon to be exactly 64×64 pixels (this one is ${size.width}×${size.height}).`);
  await fsp.mkdir(inst.dir, { recursive: true });
  await fsp.writeFile(path.join(inst.dir, 'server-icon.png'), png);
  inst.cfg.iconAt = Date.now();
  manager.save();
  inst.sysLog(`${who(req)} changed the server icon.${inst.proc ? ' Restart the server to show it in Minecraft.' : ''}`);
  inst.logActivity('server', who(req), 'changed the server icon');
  inst.emitStatus();
  return { ok: true, icon: inst.cfg.iconAt, restartNeeded: !!inst.proc };
});
route('DELETE', '/api/servers/:id/icon', async (req, res, p) => {
  const inst = getFor(req, p.id, 'settings');
  await fsp.unlink(path.join(inst.dir, 'server-icon.png')).catch(() => {});
  inst.cfg.iconAt = null;
  manager.save();
  inst.sysLog(`${who(req)} removed the server icon.`);
  inst.emitStatus();
  return { ok: true, restartNeeded: !!inst.proc };
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

route('GET', '/api/servers/:id/properties', (req, res, p) => getFor(req, p.id, 'settings').getProperties());
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
  '/servers': 'servers.html',
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
        if (req.user.restriction && !r.opts.restrictedOk) {
          throw httpError(403, `Your account is ${req.user.restriction.type}. Open the dashboard to see why and to appeal.`, 'RESTRICTED');
        }
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
    await moderation.init();
    setInterval(() => expireActions().catch((e) => console.error(`Moderation check failed: ${e.message}`)), 60 * 1000);
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
