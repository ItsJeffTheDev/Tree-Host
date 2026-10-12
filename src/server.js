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
const { Manager, readPluginMeta } = require('./instances');
const { SupportChat } = require('./support-chat');
const { ManagedPlugins, STAFF_ID, PLUGIN_TYPES, MAX_JAR } = require('./managed-plugins');
const { Auth } = require('./auth');
const { Rbac, PERMISSIONS, CREATOR_PERKS } = require('./rbac');
const { Billing, durationText } = require('./billing');
const mail = require('./mail');
const firebase = require('./firebase');
const store = require('./store');
const { migrateTeamData } = require('./migrate');
const { keepAwake } = require('./keepawake');
const providers = require('./providers');
const java = require('./java');
const { Activity } = require('./activity');
const { StaffNotices } = require('./staff-notices');
const { Players } = require('./players');
const lagdoctor = require('./lagdoctor');
const pluginUpdates = require('./pluginupdates');
const { Playit } = require('./playit');
const { TestSite } = require('./testsite');
// A test site on a home PC (tools/Start-Testers.ps1): resets every 48 hours, says it isn't dedicated hardware.
const TEST_SITE = process.env.TREEHOST_TEST_SITE === '1';
let testSite = null; // src/testsite.js (see main)
const { Moderation, TYPES, REASONS } = require('./moderation');
const MOTD = require('./motd');
const backups = require('./backups');
const modrinth = require('./modrinth');
const { Metrics } = require('./metrics');

const env = (name, fallback) => process.env[`TREEHOST_${name}`] ?? process.env[`MCPT_${name}`] ?? fallback;
// Production: the public website address (e.g. https://treehost.online). Turns on accounts, billing and the landing page.
const PUBLIC_URL = (env('PUBLIC_URL', '') || '').replace(/\/$/, '') || null;
const HOSTED = !!PUBLIC_URL;
// Staging (TREEHOST_STAGING=1): the whole site and dashboard work (sign-up, sign-in, account, staff console), but
// nobody can create servers or buy plans until launch. Every page shows a staging banner.
const STAGING = env('STAGING', '') === '1';
// Staff must use two-factor sign-in on the real site (an https address). TREEHOST_STAFF_2FA=1 or 0 overrides.
const STAFF_2FA = env('STAFF_2FA', '') ? env('STAFF_2FA', '') === '1' : /^https:\/\//.test(PUBLIC_URL);
const STAGING_MSG = "This is Tree Host's staging site: servers and plans open at launch. Everything else works, so look around!";
const stagingBlock = () => {
  if (STAGING) throw httpError(403, STAGING_MSG, 'STAGING');
};
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
  dmca: env('DMCA_EMAIL', 'dmca@treehost.online'),
};
// In personal mode everyone who can reach the dashboard is the PC's owner.
const LOCAL_ADMIN = { id: 'local', username: 'you', role: 'owner', local: true };

const manager = new Manager();
const auth = new Auth();
const rbac = new Rbac();
const billing = new Billing();
const activity = new Activity();
const staffNotices = new StaffNotices();
const players = new Players();
const moderation = new Moderation();
const metrics = new Metrics();
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
  return nodeFullFor(inst, sub);
};

// ----- running capacity -----
// Each monthly plan reserves memory for one running server (bundles like Lifetime: all their slots), so those always
// start. Extra servers on a monthly plan borrow memory nobody has bought, and can't start when the machine is full.
const isUp = (i) => !!i.proc || ['starting', 'running', 'stopping'].includes(i.status);
const memOf = (i) => ((manager.planInfo(i) || {}).ramMb || 0) + manager.overheadMb;
/** Memory used by running servers beyond what their plans reserve. */
function borrowedMb(except) {
  const bySub = new Map();
  for (const i of manager.instances.values()) {
    if (i === except || !i.isCustomer || !i.cfg.subscriptionId || !isUp(i)) continue;
    const list = bySub.get(i.cfg.subscriptionId) || [];
    list.push(i);
    bySub.set(i.cfg.subscriptionId, list);
  }
  let n = 0;
  for (const [subId, list] of bySub) {
    const sub = billing.sub(subId);
    if (sub && sub.slots) continue;
    for (const i of list.slice(1)) n += memOf(i);
  }
  return n;
}
billing.hooks.borrowedMb = () => borrowedMb(null);
// The test site on this PC (Start.bat): sells without memory limits unless capacity is set in the Staff Console.
billing.testSite = (TEST_SITE || (!!PUBLIC_URL && /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(PUBLIC_URL + '/')));
function nodeFullFor(inst, sub) {
  if (sub.slots || billing.unlimited()) return null;
  const others = serversOnSub(sub).filter((i) => i !== inst && isUp(i));
  if (!others.length) return null;
  const free = billing.capacityMb() - billing.soldMb() - borrowedMb(inst);
  if (memOf(inst) <= free) return null;
  const names = others.map((i) => i.cfg.name).join(', ');
  return `Tree Host's machine is full right now, so this extra server can't run at the same time as ${names}. Stop ${others.length === 1 ? 'that server' : 'one of them'} first (your plan always has room for one running server), or try again later.`;
}
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
billing.hooks.metric = (type, extra) => { try { metrics.count(type, extra); } catch {} };
billing.hooks.notify = (kind, sub, text) => activity.log(kind, (auth.userById(sub.userId) || {}).username || sub.donorName || 'A customer', text);
billing.hooks.email = (user, subject, paragraphs) => {
  const baseUrl = PUBLIC_URL || auth.settings.baseUrl;
  return mail.send(user.email, subject, paragraphs, baseUrl ? { text: 'Open Billing', url: `${baseUrl}/dashboard?billing` } : null, { replyTo: EMAILS.billing });
};
billing.hooks.sendEmail = (kind, user, sub) => {
  const baseUrl = auth.settings.baseUrl || PUBLIC_URL || 'https://treehost.online';
  return user && user.email ? sendEmail(user.email, EMAIL[kind](user, sub, baseUrl)) : Promise.resolve(false);
};

// ---------- emails (the layout is in mail.js) ----------

const siteUrl = (req) => PUBLIC_URL || auth.settings.baseUrl || (req ? publicOrigin(req) : 'https://treehost.online');
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
      heading: `Welcome, ${user.username}!`,
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
      heading: 'Your plan is ready',
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
  // Sent the moment a cancellation goes through (auto-renewal laws ask for a confirmation).
  canceled: (user, sub, base) => {
    const later = sub.status !== 'canceled' && sub.periodEnd && sub.periodEnd > Date.now();
    return [
      `Cancellation confirmed: ${sub.planName}`,
      [
        `Hi **${user.username}**, your ${sub.planName} plan is canceled. **You will not be charged again** for it.`,
        later
          ? `It stays active until **${niceDate(sub.periodEnd)}**, the end of the month you paid for. After that its servers stop, and your worlds and files are kept for 14 days.`
          : 'Its servers were stopped. Your worlds and files are kept for **14 days**: buy a plan in Billing before then to keep them.',
      ],
      { text: 'Open Billing', url: `${base}/dashboard?billing` },
      {
        heading: 'Cancellation confirmed',
        details: [['Plan', sub.planName], ['Canceled on', niceDate(Date.now())], ...(later ? [['Active until', niceDate(sub.periodEnd)]] : [])],
        after: ['Changed your mind? You can buy a plan again any time in **Billing**.'],
        replyTo: EMAILS.billing,
      },
    ];
  },
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
// TREEHOST_TRUST_PROXY=1: Tree Host runs behind a managed front end (Google Cloud Run), not Caddy on this machine.
const TRUST_PROXY = env('TRUST_PROXY') === '1';
function fromThisPc(req) {
  if (TRUST_PROXY) return true;
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

// Forwarding headers are only trusted from the local reverse proxy; anyone else could fake them.
// Caddy replaces X-Forwarded-For with the real client address, but passes CF-Connecting-IP through untouched,
// so that one is only trusted when the site really sits behind Cloudflare's proxy (TREEHOST_TRUST_CLOUDFLARE=1).
const TRUST_CLOUDFLARE = env('TRUST_CLOUDFLARE') === '1';
function clientIp(req) {
  if (fromThisPc(req)) {
    const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    // Caddy replaces the header (one entry). Cloud Run appends the real client to whatever the client sent,
    // so there the last entry is the one that can't be faked.
    const fwd = (TRUST_CLOUDFLARE && req.headers['cf-connecting-ip']) || (TRUST_PROXY ? hops[hops.length - 1] : hops[0]);
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}

// Sanctions (OFAC): no sign-ups or purchases from comprehensively sanctioned countries. The country comes from Cloudflare's
// CF-IPCountry header, so this works once the website is behind Cloudflare (TREEHOST_TRUST_CLOUDFLARE=1).
// TREEHOST_CHECKOUT_BLOCKED_COUNTRIES can also hold back checkout elsewhere (e.g. EU/UK until VAT registration).
const countryList = (v) => new Set(String(v || '').toUpperCase().split(',').map((c) => c.trim()).filter(Boolean));
const BLOCKED_COUNTRIES = countryList(env('BLOCKED_COUNTRIES', 'CU,IR,KP,SY'));
const CHECKOUT_BLOCKED_COUNTRIES = countryList(env('CHECKOUT_BLOCKED_COUNTRIES', ''));
const countryOf = (req) => (TRUST_CLOUDFLARE && fromThisPc(req) ? String(req.headers['cf-ipcountry'] || '').toUpperCase() : '');
function regionCheck(req, checkout = false) {
  const c = countryOf(req);
  if (c && BLOCKED_COUNTRIES.has(c)) throw httpError(451, 'Sorry, Tree Host is not available in your country or region.', 'REGION');
  if (checkout && c && CHECKOUT_BLOCKED_COUNTRIES.has(c)) {
    throw httpError(451, "Sorry, plans can't be bought from your country yet. Join our Discord to hear when they can.", 'REGION');
  }
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
  if (!rbac.isCustomer(user) || user.restriction) return;
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
/** A staff member who still has to turn on two-factor sign-in keeps only what customers can do until they do. */
const needs2fa = (user) => STAFF_2FA && TEAM && !!user && !user.local && rbac.can(user, 'console.access') && !(user.mfa && user.mfa.on);
const can = (user, permission) => !TEAM || (rbac.can(user, permission) && (!needs2fa(user) || rbac.role('customer').permissions.includes(permission)));

function requirePerm(req, permission) {
  if (needs2fa(req.user) && rbac.can(req.user, permission) && !can(req.user, permission)) {
    throw httpError(403, 'Turn on two-factor sign-in (Account → Two-factor sign-in) to use staff tools.', 'MFA_SETUP');
  }
  if (!can(req.user, permission)) {
    const p = PERMISSIONS.find((x) => x.id === permission);
    throw httpError(403, `You don't have access to that${p ? ` (needs: ${p.label})` : ''}.`, 'FORBIDDEN');
  }
}

/** Customers see only their own servers; staff with servers.viewAll see every server (to help). */
function canView(user, inst) {
  if (!TEAM) return true;
  if (!user || !inst) return false;
  // Customers can also see the shared demo server
  if (inst.cfg.isSharedDemo && rbac.isCustomer(user)) return true;
  return inst.cfg.owner === user.id || !!memberOf(inst, user) || can(user, 'servers.viewAll');
}

// ---------- sharing a server with friends ----------
// Co-owner: everything except deleting the server, resetting worlds or changing its version (and billing).
// Helper: console, start/stop/restart, commands. Viewer: watch the console and status.
const MEMBER_ROLES = {
  coowner: { label: 'Co-owner', actions: ['view', 'control', 'command', 'plugins', 'files', 'settings', 'deploy'] },
  helper: { label: 'Helper', actions: ['view', 'control', 'command'] },
  viewer: { label: 'Viewer', actions: ['view'] },
};
const memberOf = (inst, user) => (user && inst.cfg.members ? inst.cfg.members.find((m) => m.userId === user.id && auth.userById(m.userId)) : null) || null;

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
  // The shared demo server: anyone may start, stop and type commands; the rest is read-only for them.
  if (inst && inst.cfg.isSharedDemo && !rbac.isStaff(user)) {
    return ['control', 'command'].includes(action) ? null : "The demo server's files, plugins and settings are read-only. Create your own server to change them.";
  }
  const member = inst ? memberOf(inst, user) : null;
  if (member && !rbac.isStaff(user)) {
    return MEMBER_ROLES[member.role].actions.includes(action) ? null : `As a ${MEMBER_ROLES[member.role].label} on this server you can't ${ACTION_TEXT[action] || action}. Ask the owner.`;
  }
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

// Staff notifications (src/staff-notices.js): each one goes live to the staff members whose role can open it.
staffNotices.listeners.add((n) => {
  const msg = `event: staffnote
data: ${JSON.stringify({ ...n, perm: undefined, unread: true })}

`;
  for (const [res, user] of clients) if (user && TEAM && can(user, 'console.access') && can(user, n.perm)) res.write(msg);
});
activity.listeners.add((e) => {
  if (TEAM) staffNotices.onActivity(e);
});
manager.on('removed', (id) => broadcast('removed', { id }));

// The Players tab (src/players.js): joins, leaves and chat from every server's console.
manager.on('line', (inst, line) => players.onLine(inst, line).catch(() => {}));
manager.on('status', (inst) => {
  if (!inst.proc && inst.status === 'stopped') players.onStopped(inst).catch(() => {});
});
manager.on('removed', (id) => players.forget(id));
let playit = null; // src/playit.js, when TREEHOST_PLAYIT_SECRET_PATH is set (see main)
manager.on('removed', (id) => playit && playit.release(id).catch((e) => console.error(`[playit] ${id}: ${e.message}`)));

// Plugin updates (src/pluginupdates.js): the first start after an update decides whether to keep it.
manager.on('status', (inst) => {
  const u = inst.cfg.pluginUpdate;
  if (u && inst.status === 'running' && (inst.lastStartAt || 0) > u.at) {
    pluginUpdates.confirm(inst);
    inst.sysLog(`Plugin update kept: the server started fine with ${u.items.map((i) => i.newFile).join(', ')}.`);
  }
});
manager.onCrash = (inst) => {
  const u = inst.cfg.pluginUpdate;
  if (!u || (inst.lastStartAt || 0) < u.at) return;
  const back = pluginUpdates.rollback(inst);
  if (!back.length) return;
  inst.sysLog(`The server crashed right after a plugin update, so the update was undone: ${back.map((i) => `${i.newFile} → ${i.oldFile}`).join(', ')}. Start it again to use the old version${back.length === 1 ? '' : 's'}.`);
  inst.logActivity('crash', 'Tree Host', `undid a plugin update after a crash (${back.map((i) => i.oldFile).join(', ')})`);
};

/** Customers see their own servers' activity; staff see server events; sign-ups and billing need activity.viewAll. */
function canSeeEvent(user, e) {
  if (!TEAM) return true;
  if (!user) return false;
  if (e.kind === 'audit') return can(user, 'audit.view');
  if (e.kind === 'moderation') return can(user, 'moderation.view');
  if (e.kind === 'people' || e.kind === 'billing') return can(user, 'activity.viewAll');
  if (e.owner && e.owner === user.id) return true;
  const inst = e.serverId ? manager.instances.get(e.serverId) : null;
  if (inst && memberOf(inst, user)) return true;
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
      user: user ? { ...(user.local ? user : auth.publicUser(user)), ...(user.local ? {} : lifetimeOf(user)), roleLabel: rbac.role(user.role).label, ...(TEAM && !user.local && onTeamPage(user) ? { teamProfile: { show: true, title: '', bio: '', ...(user.teamProfile || {}) } } : {}), ...(TEAM && !user.local && rbac.isStaff(user) ? { staffPrefs: staffPrefsOf(user) } : {}), permissions: TEAM ? rbac.permissionsOf(user).filter((x) => can(user, x)) : PERMISSIONS.map((x) => x.id), ...(needs2fa(user) ? { needs2fa: true } : {}) } : null,
      publicUrl: publicUrl(),
      hosted: HOSTED,
      allowSignup: TEAM && auth.settings.allowSignup,
      mailEnabled: mail.enabled(),
      customEmails: TEAM && mail.enabled() && firebase.linksEnabled(),
      discordInvite: DISCORD_INVITE,
      firebase: TEAM ? firebase.publicConfig() : null,
      billingMode: billing.mode,
      staging: STAGING,
      testSite: testSite ? testSite.info() : null,
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
    const body = await readJson(req);
    if (body.username) regionCheck(req); // only when a new account is being made
    const r = await auth.firebaseLogin(body, clientIp(req));
    if (!r.token) return r;
    if (r.created) {
      activity.log('people', r.user.username, r.user.role === 'customer' ? 'signed up' : `joined as ${rbac.role(r.user.role).label}${r.invite ? ' with an invite link' : ''}`);
      if (r.invite) await inviteUsed(r.user, r.invite);
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
    regionCheck(req);
    const body = await readJson(req);
    const { token, user, invite } = await auth.acceptInvite(body, clientIp(req));
    activity.log('people', user.username, `joined as ${rbac.role(user.role).label} with an invite link`);
    await inviteUsed(user, invite);
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
    try { metrics.count('signup', { ref: body && body.ref }); } catch {}
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
      const baseUrl = auth.settings.baseUrl || siteUrl(req);
      await sendEmail(r.user.email, EMAIL.reset(r.user.username, `${baseUrl}/dashboard?reset=${r.token}`));
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
  if (body.mcName !== undefined) syncStaffListsSoon(); // staff badges follow the new Minecraft name right away
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

/** Get detailed user information including activity logs. */
route('GET', '/api/admin/users/:uid/details', async (req, res, p) => {
  const u = auth.userById(p.uid);
  if (!u) throw httpError(404, 'User not found');
  
  const subs = billing.forUser(u.id);
  const instances = [...manager.instances.values()].filter((i) => i.cfg.owner === u.id && i.isCustomer);
  const userActivity = activity.events.filter((e) => e.owner === u.id || e.kind === 'people' && e.text.includes(u.username));
  
  return {
    ...auth.publicUser(u),
    createdAt: u.createdAt,
    lastLogin: u.lastLogin,
    firebaseUid: u.firebaseUid,
    mcName: u.mcName,
    restriction: u.restriction,
    prioritySupport: u.prioritySupport,
    servers: instances.map((i) => ({
      id: i.cfg.id,
      name: i.cfg.name,
      type: i.cfg.type,
      version: i.cfg.version,
      status: i.status,
      memoryMb: i.cfg.memoryMb,
      diskUsedMb: i.diskUsedMb,
      createdAt: i.cfg.createdAt,
    })),
    subscriptions: subs.map((s) => ({
      id: s.id,
      planName: s.planName,
      status: s.status,
      ramMb: s.ramMb,
      startedAt: s.startedAt,
      endsAt: s.endsAt,
    })),
    activity: userActivity.slice(-50).reverse(), // Last 50 activities
    linked: auth.linkedAccounts(u).map((x) => ({ id: x.id, username: x.username, role: x.role })),
    ...lifetimeOf(u),
  };
}, { perm: 'users.view' });

/** Send password reset email (custom format). */
route('POST', '/api/admin/users/:uid/reset-password', async (req, res, p) => {
  const u = auth.userById(p.uid);
  if (!u) throw httpError(404, 'User not found');
  if (!u.firebaseUid) throw httpError(400, 'This account does not use Firebase auth');
  
  // Generate reset token
  const resetToken = crypto.randomBytes(32).toString('hex');
  const resetExpires = Date.now() + 3600000; // 1 hour
  
  // Store reset token
  u.passwordReset = { token: resetToken, expires: resetExpires };
  await auth.save();
  
  // In production, this would send a custom email via your email service
  // For now, we'll return the reset link for testing
  const resetLink = `${process.env.TREEHOST_PUBLIC_URL || 'http://localhost:8080'}/reset-password?token=${resetToken}`;
  
  audit(req, `sent a password reset email to ${u.username}`);
  
  // TODO: Send actual email using your custom email service
  // await sendCustomEmail(u.email, 'Password Reset', '...', resetLink);
  
  return { 
    success: true, 
    resetLink: resetLink, // Remove this in production
    message: `Password reset email sent to ${u.email}`
  };
}, { perm: 'users.manage' });

/** Request email change (sends verification email to new address). */
route('POST', '/api/admin/users/:uid/change-email', async (req, res, p) => {
  const { newEmail } = await readJson(req);
  if (!newEmail || !newEmail.includes('@')) throw httpError(400, 'Invalid email address');
  
  const u = auth.userById(p.uid);
  if (!u) throw httpError(404, 'User not found');
  
  // Generate verification token
  const verifyToken = crypto.randomBytes(32).toString('hex');
  const verifyExpires = Date.now() + 86400000; // 24 hours
  
  // Store pending email change
  u.pendingEmailChange = { newEmail, token: verifyToken, expires: verifyExpires };
  await auth.save();
  
  // Send verification email to new address
  const verifyLink = `${process.env.TREEHOST_PUBLIC_URL || 'http://localhost:8080'}/verify-email?token=${verifyToken}`;
  
  audit(req, `requested email change for ${u.username} to ${newEmail}`);
  
  // TODO: Send actual email using your custom email service
  // await sendCustomEmail(newEmail, 'Verify Email Change', '...', verifyLink);
  
  return { 
    success: true, 
    verifyLink: verifyLink, // Remove this in production
    message: `Verification email sent to ${newEmail}`
  };
}, { perm: 'users.manage' });
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
    const { role, note, days, planId, months } = await readJson(req);
    rbac.checkRoleChange(req.user, null, role);
    let plan = null;
    if (planId) {
      if (role !== 'youtuber') throw httpError(400, 'Only YouTuber invites can come with a free plan.');
      if (!can(req.user, 'billing.manage')) throw httpError(403, 'Giving free plans needs the Manage billing permission.');
      if (!billing.plan(planId)) throw httpError(400, 'Unknown plan.');
      plan = { planId, months };
    }
    const invite = await auth.createInvite(req.user, role, { note, days, plan });
    audit(req, `created a ${rbac.role(role).label} invite link${note ? ` (${String(note).slice(0, 60)})` : ''}${plan ? ' with a free plan' : ''}`);
    // The dashboard reads ?invite= (on a hosted site "/" is the website, which would drop it).
    // Use the configured base URL if set, otherwise fall back to the request's host.
    const baseUrl = auth.settings.baseUrl || publicOrigin(req);
    const made = auth.listInvites().slice(-1)[0];
    return { link: `${baseUrl}/dashboard?invite=${invite}`, expires: made.expires, invite: made };
  },
  { perm: 'users.roles' },
);
route('GET', '/api/team/invites', () => auth.listInvites(), { perm: 'users.roles' });
route('DELETE', '/api/team/invites/:id', async (req, res, p) => {
  await auth.revokeInvite(p.id);
  audit(req, 'revoked an invite link');
  return { ok: true };
}, { perm: 'users.roles' });

/** What an invite link is for, so the sign-up page can say so (the link itself is the secret). */
route('GET', '/api/auth/invite', (req, res, p, q) => {
  const i = auth.findInvite(q.get('invite'));
  if (!i) throw httpError(404, 'This invite link is invalid or has expired. Ask whoever sent it for a new one.');
  const plan = i.plan && billing.plan(i.plan.planId);
  return {
    role: i.role,
    roleLabel: rbac.role(i.role).label,
    customer: rbac.isCustomer({ role: i.role }),
    note: i.note || '',
    invitedBy: i.createdBy,
    expires: i.expires,
    plan: plan ? { name: plan.name, months: i.plan.months } : null,
  };
}, { public: true });

/** Someone who already has an account opens a YouTuber invite while signed in. */
route('POST', '/api/auth/invite/claim', async (req) => {
  const { invite: token } = await readJson(req);
  const before = rbac.role(req.user.role).label;
  const invite = await auth.claimInvite(req.user, token);
  activity.log('people', req.user.username, `became a ${rbac.role(req.user.role).label} with an invite link (was ${before})`);
  await inviteUsed(req.user, invite);
  publicListCache = null;
  syncStaffListsSoon();
  return { ok: true, role: req.user.role, roleLabel: rbac.role(req.user.role).label };
});

/** After an invite is used: the free plan it came with, if any. */
async function inviteUsed(user, invite) {
  if (!invite || !invite.plan) return;
  try {
    const s = await billing.grant(user, invite.plan.planId, invite.createdBy, { months: invite.plan.months, note: `${rbac.role(invite.role).label} invite` });
    activity.log('billing', invite.createdBy, `gave ${user.username} a free ${s.planName} plan with their invite (${invite.plan.months} month${invite.plan.months === 1 ? '' : 's'})`);
  } catch (e) {
    console.error(`[invite] free plan for ${user.username} failed: ${e.message}`);
  }
}
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
    publicListCache = null; // the YouTuber badge on their listed servers
    syncStaffListsSoon(); // and in-game
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
    await supportChat.removeUser(user.id);
    for (const s2 of manager.instances.values()) if (s2.cfg.members) s2.cfg.members = s2.cfg.members.filter((m) => m.userId !== user.id);
    manager.save();
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
  const linkedOk = linked.filter((u) => u.id !== req.user.id && rbac.isCustomer(u)); // staff accounts are never included

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
    dmcaEmail: EMAILS.dmca,
    // The business's mailing address (the Terms and the DMCA agent need one) and the named copyright agent.
    address: env('ADDRESS', ''),
    dmcaAgent: env('DMCA_AGENT', ''),
    jurisdiction: env('JURISDICTION', ''),
    discord: env('DISCORD_INVITE', ''),
    // The machine customer servers run on (shown on the pricing page; people rightly ask).
    cpu: TEST_SITE ? 'A home PC' : env('CPU', 'AMD Ryzen 7 9700X'),
    cpuDetail: TEST_SITE ? 'Test site: not dedicated hardware, so servers may be slow' : env('CPU_DETAIL', '8 cores, 16 threads, up to 5.5 GHz'),
    hardware: TEST_SITE ? 'A home PC running the Tree Host test site (not the real hosting machine)' : env('HARDWARE', 'OVH RISE-S dedicated server: DDR5 ECC memory, mirrored NVMe SSDs, anti-DDoS'),
    testSite: testSite ? testSite.info() : null,
    location: env('LOCATION', ''),
    allowSignup: auth.settings.allowSignup,
    staging: STAGING,
  }),
  { public: true },
);
route('GET', '/api/billing', async (req) => {
  // Paid in Stripe but the webhook hasn't arrived (always the case on a localhost test site): check with Stripe.
  for (const x of billing.pendingFor(req.user.id)) {
    if (x.checkoutSession && ['test', 'live'].includes(billing.mode)) await billing.confirmCheckout(req.user, x.checkoutSession, auth).catch(() => {});
  }
  return billingView(req);
});
const billingView = (req) => ({
  mode: billing.mode,
  currency: billing.publicPlans().currency,
  hasPortal: !!(req.user.stripeCustomerId && billing.mode !== 'demo'),
  subscriptions: billing.forUser(req.user.id).map((x) => ({
    ...billing.publicSub(x),
    serverName: billing.serversOf(x).map((v) => v.name).join(', ') || null,
  })),
});
route('POST', '/api/billing/checkout', async (req) => {
  if (!TEAM) throw httpError(400, 'Billing only exists on a hosted Tree Host.');
  stagingBlock();
  if (rbac.isCustomer(req.user) && !req.user.email) throw httpError(400, 'Add your email address in Account first.');
  regionCheck(req, true);
  const body = await readJson(req);
  const consent = { ...(body.consent || {}), ip: clientIp(req), userAgent: req.headers['user-agent'] };
  return billing.checkout(req.user, body.planId, PUBLIC_URL || auth.settings.baseUrl || publicOrigin(req), consent);
});
route('POST', '/api/billing/confirm', async (req) => billing.publicSub(await billing.confirmCheckout(req.user, (await readJson(req)).sessionId, auth)));
route('POST', '/api/billing/portal', async (req) => billing.portal(req.user, PUBLIC_URL || auth.settings.baseUrl || publicOrigin(req)));
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
      `Hi **${target.username}**, you've been given a free ${c.planName} plan on Tree Host${c.days ? ` for ${c.length}` : ' for life'}!`,
      'Open Billing, choose **Have a code?**, and paste your code. It only works for your account.',
    ], PUBLIC_URL ? { text: 'Claim my server', url: `${PUBLIC_URL}/dashboard?billing` } : null, {
      heading: 'A free server for you', replyTo: EMAILS.promo,
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
    competitors: billing.competitors(),
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
  publicListCache = null;
  syncStaffListsSoon();
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
  const baseUrl = auth.settings.baseUrl || siteUrl(req);
  if (user.firebaseUid && !user.emailVerified && firebase.linksEnabled()) {
    verifyLink = await firebase.emailLink('verify', user.email, `${baseUrl}/dashboard`).catch(() => null);
  }
  await sendEmail(user.email, EMAIL.welcome(user, baseUrl, verifyLink));
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
  const baseUrl = auth.settings.baseUrl || siteUrl(req);
  const link = await firebase.emailLink(type, email, `${baseUrl}/dashboard`);
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
  const baseUrl = auth.settings.baseUrl || siteUrl(req);
  const [subject, paragraphs, button, opts] = make(baseUrl);
  const { html } = mail.render(subject, paragraphs, button, { ...opts, preview: true });
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'" });
  res.end(html);
  return HANDLED;
}, { perm: 'settings.manage' });
route('POST', '/api/admin/emails/test', async (req) => {
  if (!mail.enabled()) throw httpError(400, 'Emails are off: put RESEND_API_KEY in the settings file and restart.');
  if (!req.user.email) throw httpError(400, 'Your account has no email address.');
  const { kind } = await readJson(req);
  const baseUrl = auth.settings.baseUrl || siteUrl(req);
  await sendEmail(req.user.email, (PREVIEWS[kind] || PREVIEWS.welcome)(baseUrl));
  audit(req, 'sent a test email to themselves');
  return { ok: true, to: req.user.email };
}, { perm: 'settings.manage' });

// Staff docs: kept out of public/ (so they can't be fetched as static files) and served only to staff.
const STAFF_DOCS_DIR = path.join(__dirname, '..', 'staff-docs');
const STAFF_DOCS = [
  { id: 'support-playbook', title: 'Support playbook', icon: 'lifebuoy', group: 'Support', perm: 'console.access' },
  { id: 'roles', title: 'Roles & permissions', icon: 'key', group: 'Support', perm: 'console.access' },
  { id: 'hosting-guide', title: 'Running Tree Host', icon: 'tools', group: 'Technical', perm: 'system.view' },
  { id: 'legal', title: 'Legal: providers and DPA', icon: 'scroll', group: 'Business', perm: 'billing.view' },
];
const staffDocsFor = (user) => STAFF_DOCS.filter((d) => can(user, d.perm)).map(({ perm, ...d }) => d);
route('GET', '/api/staff/docs', (req) => ({ docs: staffDocsFor(req.user) }), { perm: 'console.access' });

// Two-factor sign-in (authenticator app codes): set up, turn on (shows recovery codes once), turn off.
route('POST', '/api/auth/2fa/setup', async (req) => auth.startTwoFactor(req.user));
route('POST', '/api/auth/2fa/enable', async (req) => {
  const r = await auth.enableTwoFactor(req.user, (await readJson(req)).code);
  activity.log('audit', req.user.username, 'turned on two-factor sign-in');
  return r;
});
route('POST', '/api/auth/2fa/disable', async (req) => {
  if (STAFF_2FA && rbac.can(req.user, 'console.access')) throw httpError(400, 'Staff accounts must keep two-factor sign-in on.');
  await auth.disableTwoFactor(req.user, (await readJson(req)).code);
  activity.log('audit', req.user.username, 'turned off two-factor sign-in');
  return { ok: true };
});

// Staff notifications: the bell and the counts in the Staff Console menu.
route('GET', '/api/staff/notices', (req) => staffNotices.forUser(req.user, can), { perm: 'console.access' });
route('POST', '/api/staff/notices/read', async (req) => {
  const { section } = await readJson(req);
  staffNotices.markRead(req.user.id, section ? String(section).slice(0, 40) : null);
  return staffNotices.forUser(req.user, can);
}, { perm: 'console.access' });
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

// Stream overlays (public/overlay/*.html, added to OBS as browser sources on this PC). Only answers requests made on
// this PC directly: anything through the Cloudflare tunnel carries CF-Connecting-IP and is refused, so the tester
// code and the numbers aren't public.
// The launch fund for the stream overlay (public/overlay/fund.html): this site's own numbers, or, on the tester PC,
// the real site's (TREEHOST_FUND_URL, e.g. https://demo.treehost.online), fetched here so the page needs no CORS.
let fundCache = { at: 0, data: null };
route('GET', '/api/overlay/fund', async (req) => {
  if (!fromThisPc(req) || req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']) throw httpError(404, 'Not found');
  const src = env('FUND_URL', '');
  if (!src) return billing.donationSummary();
  if (Date.now() - fundCache.at > 15000 || !fundCache.data) {
    try {
      const r = await fetch(`${src.replace(/\/$/, '')}/api/donations`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) fundCache = { at: Date.now(), data: await r.json() };
    } catch {}
  }
  return fundCache.data || billing.donationSummary();
}, { public: true });

route('GET', '/api/overlay', (req, res, p, q) => {
  if (!fromThisPc(req) || req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']) throw httpError(404, 'Not found');
  const servers = [...manager.instances.values()].filter((i) => i.isCustomer);
  const since = Number(q.get('since')) || 0;
  const code = env('SIGNUP_CODE', '');
  return {
    link: PUBLIC_URL ? `${PUBLIC_URL}/dashboard?${code ? `code=${encodeURIComponent(code)}` : 'signup'}` : null,
    servers: servers.length,
    running: servers.filter((i) => i.proc && i.status === 'running').length,
    players: servers.reduce((n, i) => n + (i.proc ? i.players.size : 0), 0),
    testSite: testSite ? testSite.info() : null,
    feed: testSite ? testSite.feed.filter((e) => e.id > since) : [],
    seq: testSite ? testSite.seq : 0,
  };
}, { public: true });
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

// ---------- the shared demo server ----------
// One Paper server everyone can explore before buying a plan: start, stop, restart and commands work (simulated by
// src/demo-sim.js, so no Java runs and nothing is downloaded); files, plugins and settings are read-only.

/** Create (first time) or get the shared demo server. */
route('POST', '/api/servers/demo', async () => {
  if (!TEAM) throw httpError(400, 'The demo server is only available when accounts are on.');
  let demo = [...manager.instances.values()].find((i) => i.cfg.isDemo);
  if (!demo) {
    const owner = auth.users.find((u) => u.role === 'owner') || auth.users.find((u) => u.role === 'admin');
    if (!owner) throw httpError(400, 'The demo server needs an Owner or Admin account to belong to. Create one first.');
    demo = await manager.create(
      { name: 'Tree Host Demo', type: 'paper', version: '1.21.1', eula: true, memoryMb: 2048 },
      { space: 'team', owner: owner.id, createdBy: owner.id, extra: { isDemo: true, isSharedDemo: true, notes: '' } },
    );
    await setUpDemoServer(demo);
    activity.log('server', 'Tree Host', `created the shared demo server "${demo.cfg.name}"`);
  }
  try { metrics.count('demoLaunched'); } catch {}
  return demo.toJSON();
});

/** A tiny jar holding just a plugin.yml, so the demo's Plugins tab lists real-looking plugins (it never runs them). */
function demoPluginJar(name, version, description) {
  const { crc32 } = require('./zip');
  const data = Buffer.from(`name: ${name}\nversion: '${version}'\nmain: demo.${name}\napi-version: '1.21'\ndescription: ${description}\n`);
  const fileName = Buffer.from('plugin.yml');
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + fileName.length, 12);
  end.writeUInt32LE(30 + fileName.length + data.length, 16);
  return Buffer.concat([local, fileName, data, central, fileName, end]);
}

const DEMO_PLUGINS = [
  ['EssentialsX', '2.20.1', 'Homes, warps, kits, an economy and 130+ everyday commands.'],
  ['LuckPerms', '5.4.141', 'Permissions: groups, ranks and who may use which command.'],
  ['WorldEdit', '7.3.6', 'Build fast: select, copy, paste and reshape big areas.'],
  ['Vault', '1.7.3', 'Lets economy, chat and permission plugins work together.'],
];

const DEMO_MOTD = [
  '&#46c37b&lTree Host &7Demo Server\n&fStart it, stop it and try commands',
  '&#46c37b&lTree Host &7Demo Server\n&eYour own server is ready in a minute',
];
const DEMO_DESCRIPTION = 'The official Tree Host demo. Start it, stop it and try commands right from the dashboard before you make your own server.';

/** The demo's 64×64 server icon: a pixel-art tree on a hill (drawn at 16×16, scaled up 4×). */
function demoIcon() {
  const zlib = require('zlib');
  const { crc32 } = require('./zip');
  const hex = (h) => [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  const art = (x, y) => {
    const leaf = Math.hypot(x + 0.5 - 8, y + 0.5 - 6);
    if (y >= 14) return (x + y) % 3 ? '8d6e4a' : '7a5c3c'; // dirt
    if (y === 13) return x % 3 ? '4caf50' : '43a047'; // grass
    if (leaf <= 5.2) return x + y < 11 && (x * 7 + y * 3) % 4 === 0 ? '6fe0a5' : x + y > 15 ? '217a3c' : (x + y) % 5 === 0 ? '46c37b' : '2e9d4f';
    if ((x === 7 || x === 8) && y >= 9) return x === 8 ? '5a3d24' : '6d4c2f'; // trunk
    const t = y / 13; // sky, lighter towards the hill
    return [0, 1, 2].map((i) => Math.round(hex('3d8fd6')[i] * (1 - t) + hex('a8d8f0')[i] * t).toString(16).padStart(2, '0')).join('');
  };
  const raw = Buffer.alloc(64 * (64 * 4 + 1));
  for (let y = 0; y < 64; y++) {
    raw[y * 257] = 0; // filter: none
    for (let x = 0; x < 64; x++) {
      const [r, g, b] = hex(art(x >> 2, y >> 2));
      raw.set([r, g, b, 255], y * 257 + 1 + x * 4);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0);
  ihdr.writeUInt32BE(64, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** The demo's folder: the usual Paper config files and a few plugins. Also tidies demos made by older versions. */
async function setUpDemoServer(inst) {
  const dir = inst.dir;
  const plugins = path.join(dir, 'plugins');
  await fsp.mkdir(plugins, { recursive: true });
  // Left behind by the first demo: configs in the plugins folder and text files pretending to be world data.
  for (const junk of ['plugins/bukkit.yml', 'plugins/spigot.yml', 'world', 'world_nether', 'world_the_end', 'logs/latest.log']) {
    await fsp.rm(path.join(dir, junk), { recursive: true, force: true }).catch(() => {});
  }
  const files = {
    'eula.txt': 'eula=true\n',
    'server.properties': [
      `motd=${MOTD.propertiesValue(MOTD.toSection(DEMO_MOTD[0]))}`,
      'max-players=20',
      'gamemode=survival',
      'difficulty=easy',
      'pvp=true',
      'online-mode=true',
      'white-list=false',
      'view-distance=10',
      'simulation-distance=10',
      'spawn-protection=16',
      'level-name=world',
      `server-port=${inst.cfg.port}`,
      '',
    ].join('\n'),
    'bukkit.yml': 'settings:\n  allow-end: true\n  warn-on-overload: true\n  connection-throttle: 4000\nspawn-limits:\n  monsters: 70\n  animals: 10\nticks-per:\n  autosave: 6000\n',
    'spigot.yml': 'settings:\n  restart-on-crash: false\n  timeout-time: 60\nworld-settings:\n  default:\n    view-distance: default\n    mob-spawn-range: 8\n',
    'ops.json': '[]\n',
    'whitelist.json': '[]\n',
    'banned-players.json': '[]\n',
    'banned-ips.json': '[]\n',
  };
  for (const [name, text] of Object.entries(files)) await fsp.writeFile(path.join(dir, name), text);
  for (const [name, version, description] of DEMO_PLUGINS) {
    await fsp.writeFile(path.join(plugins, `${name}-${version}.jar`), demoPluginJar(name, version, description));
  }
  await fsp.writeFile(path.join(dir, 'server-icon.png'), demoIcon());
  // Set up like a server someone cares about, so every Settings card has something to show. Put back on every
  // Tree Host start, so the demo is always clean.
  const c = inst.cfg;
  c.installed = { type: c.type, version: c.version, build: c.build, resolvedBuild: '130' };
  c.iconAt = Date.now();
  c.motd = MOTD.normalize({ frames: DEMO_MOTD, interval: 4 });
  c.listing = { public: true, description: DEMO_DESCRIPTION, tags: ['Survival', 'SMP', 'Economy'], discord: '', website: '', since: (c.listing && c.listing.since) || Date.now() };
  c.schedules = [
    { id: 'demorestart', action: 'restart', when: { type: 'daily', time: '05:00', days: [] }, text: '', warn: true, enabled: true, lastRun: null, lastKey: null },
    { id: 'demohello', action: 'broadcast', when: { type: 'every', hours: 1 }, text: 'Enjoying the demo? Your own server is ready in about a minute.', warn: false, enabled: true, lastRun: null, lastKey: null },
    { id: 'demosave', action: 'command', when: { type: 'every', hours: 2 }, text: 'save-all', warn: false, enabled: true, lastRun: null, lastKey: null },
  ];
  c.timeZone = 'UTC';
  c.autoStart = true;
  c.autoRestart = true;
  c.notes = '';
  c.members = [];
  c.sleep = null;
  publicListCache = null;
  manager.save();
  await syncStaffPlugin(inst).catch(() => {});
  await managedPlugins.syncInstance(inst).catch(() => {});
}

route('POST', '/api/servers', async (req) => {
  stagingBlock();
  const body = await readJson(req);
  checkHostSettings(req, body);
  delete body.gateway;
  // Hosted: every server belongs to someone and uses one of their plans.
  const space = TEAM ? 'customer' : undefined;
  let extra = {};
  let sub = null;
  // From a modpack: the pack decides the type (Fabric), Minecraft version and loader.
  let pack = null;
  if (body.modpack && body.modpack.versionId) {
    pack = await readModpack(String(body.modpack.versionId));
    Object.assign(body, { type: 'fabric', version: pack.minecraft, build: pack.loader });
    if (!body.name) body.name = pack.title;
  }
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
  console.log(`[server create] ${inst.cfg.id}: space=${inst.cfg.space}, type=${inst.cfg.type}, family=${inst.provider.family}, isCustomer=${inst.isCustomer}`);
  await syncStaffPlugin(inst).catch((e) => console.error(`[staff plugin] ${inst.cfg.id}: ${e.message}`));
  await managedPlugins.syncInstance(inst).catch((e) => console.error(`[managed plugins] ${inst.cfg.id}: ${e.message}`));
  if (pack) {
    inst.cfg.modpack = { title: pack.title, slug: pack.slug, version: pack.versionNumber, versionId: pack.versionId, icon: pack.icon };
    manager.save();
    installModpackFiles(inst, pack).catch((e) => inst.sysLog(`Modpack install failed: ${e.message}`));
  }
  inst.logActivity('server', who(req), `created ${inst.provider.label} ${inst.cfg.version} server "${inst.cfg.name}"`);
  if (playit) playit.ensure(inst).catch((e) => inst.sysLog(`Could not get a playit address yet (${e.message}). Tree Host tries again in a few minutes.`));
  if (testSite) testSite.event('created', { user: req.user.username, server: inst.cfg.name });
  try { metrics.count('serverCreated', { ref: body && body.ref }); } catch {}
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
  // Minecraft can't open a world saved by a newer version (the server crashes). Going back needs a fresh world,
  // which Tree Host makes only when asked, after backing up the current one.
  if (body.version !== undefined && String(body.version) !== String(inst.cfg.version) && inst.provider.kind !== 'proxy') {
    const worldVersion = inst.cfg.worldVersion || inst.cfg.version;
    if (olderMinecraft(body.version, worldVersion) && (await inst.hasWorld())) {
      if (body.downgrade !== 'fresh-world') {
        throw httpError(409, `Your world was last played on Minecraft ${worldVersion}. Minecraft can't open a world in an older version, so ${body.version} would crash. To go back to ${body.version}, Tree Host can back up this world and start a fresh one (you can restore the backup any time).${inst.proc ? ' The server is stopped first.' : ''}`, 'DOWNGRADE');
      }
      // Asked for: stop it here, instead of failing and leaving the old version in place.
      if (inst.proc) {
        inst.sysLog(`Stopping the server to switch to ${body.version}...`);
        await inst.stopAndWait();
      }
      await backups.create(inst, { label: `World from ${worldVersion}, before switching to ${body.version}`, by: who(req) });
      await inst.resetWorlds();
      inst.cfg.worldVersion = null;
      inst.sysLog(`Backed up the ${worldVersion} world and started fresh for ${body.version}. Restore it from the Backups tab after switching back to ${worldVersion}.`);
    }
  }
  delete body.downgrade;
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

// ---------- donations (the launch fund) ----------
// Payments go through Stripe like plans. Without Stripe, the page links to TREEHOST_DONATE_URL (a Stripe payment link).
const DONATE_URL = env('DONATE_URL', 'https://buy.stripe.com/00wcN7cfK3Jh9lEgEf0oM00');
const optionalUser = (req) => {
  try {
    return authenticate(req) || null;
  } catch {
    return null;
  }
};
route('GET', '/api/donations', () => ({ ...billing.donationSummary(), mode: billing.mode, fallbackUrl: DONATE_URL }), { public: true });
route(
  'POST',
  '/api/donations',
  async (req) => {
    regionCheck(req, true);
    const ip = clientIp(req);
    auth.checkRate([`donate:${ip}`]);
    auth.recordFailure([`donate:${ip}`]);
    const body = await readJson(req);
    const user = optionalUser(req);
    try { metrics.count('donationStarted', { ref: body && body.ref }); } catch {}
    return billing.donate({ ...body, userId: user && !user.local ? user.id : null }, PUBLIC_URL || auth.settings.baseUrl || publicOrigin(req));
  },
  { public: true },
);
route('POST', '/api/donations/confirm', async (req) => billing.confirmDonation((await readJson(req)).sessionId), { public: true });

// ---------- page-view beacon + public metrics ----------
// Cookie-free, no IP stored: the beacon is attribution only (the server count in serveStatic is
// authoritative). Bots are dropped, rate-limited per IP (in-memory, ~30/min), and every failure
// answers a silent 204 — the beacon can never break a page or leak an error.
const BEACON_BOTS = ['bot', 'crawl', 'spider', 'slurp', 'headless', 'phantom', 'lighthouse', 'curl/', 'wget', 'python-requests', 'node-fetch', 'monitor', 'preview', 'facebookexternalhit', 'embedly', 'pinterest'];
const beaconBuckets = new Map(); // ip -> { tokens, at } (token bucket, ~30 per minute)

function beaconAllowed(ip) {
  const CAP = 30, REFILL_PER_SEC = 0.5, now = Date.now();
  const b = beaconBuckets.get(ip) || { tokens: CAP, at: now };
  b.tokens = Math.min(CAP, b.tokens + ((now - b.at) / 1000) * REFILL_PER_SEC);
  b.at = now;
  if (b.tokens < 1) {
    beaconBuckets.set(ip, b);
    return false;
  }
  b.tokens -= 1;
  beaconBuckets.set(ip, b);
  if (beaconBuckets.size > 10000) beaconBuckets.clear(); // never grows unbounded
  return true;
}

route('POST', '/api/metrics/event', async (req, res) => {
  const ip = clientIp(req);
  const ua = String(req.headers['user-agent'] || '');
  // Bots, health checkers and link-preview fetchers are dropped here — never counted, never stored.
  if (BEACON_BOTS.some((s) => ua.toLowerCase().includes(s))) { res.writeHead(204); res.end(); return HANDLED; }
  if (!beaconAllowed(ip)) { res.writeHead(204); res.end(); return HANDLED; }
  try {
    const body = await readJson(req, 2048);
    // Malformed body → 400. metrics.count() further validates (strips the query, caps the path,
    // drops implausible referrer hosts, allowlists ref) and drops what doesn't qualify.
    if (!body || body.type !== 'pageview' || typeof body.path !== 'string' || !body.path.startsWith('/')) {
      if (!res.headersSent) sendJson(res, 400, { error: 'Bad request' });
      return HANDLED;
    }
    metrics.count('pageview', { path: body.path, referrerHost: body.referrerHost, ref: body.ref, host: req.headers.host, beacon: true });
    if (!res.headersSent) { res.writeHead(204); res.end(); }
  } catch {
    // A bad JSON body → 400; anything else silent. The beacon can never produce a 5xx.
    if (!res.headersSent) sendJson(res, 400, { error: 'Bad request' });
  }
  return HANDLED;
}, { public: true });

route('GET', '/api/metrics/social', () => metrics.social({
  foundingUnitsLeft: billing.foundingUnitsLeft ? billing.foundingUnitsLeft() : null,
  foundingCapTotal: billing.foundingCap ? billing.foundingCap() : null,
}), { public: true });

route('GET', '/api/admin/metrics', () => ({
  ...metrics.adminSummary({ founding: billing.foundingUnitsLeft ? { sold: billing.foundingSold ? billing.foundingSold() : 0, capTotal: billing.foundingCap(), unitsLeft: billing.foundingUnitsLeft() } : null }),
}), { perm: 'console.access' });

route('GET', '/api/admin/donations', () => ({
  ...billing.donationSummary(),
  goal: billing.settings.donationGoal || {},
  donations: billing.donations
    .filter((d) => d.status !== 'pending')
    .sort((a, b) => (b.paidAt || b.createdAt) - (a.paidAt || a.createdAt))
    .map((d) => ({ ...d, username: d.userId ? (auth.userById(d.userId) || {}).username || null : null })),
}), { perm: 'billing.view' });
route('PUT', '/api/admin/donation-goal', async (req) => {
  const r = await billing.setDonationGoal(await readJson(req));
  audit(req, 'updated the launch fund goal');
  return r;
}, { perm: 'billing.manage' });
// "Compare your plan" (Why page): Tree Host's plans next to other hosts' prices for the same memory.
route('GET', '/api/compare', () => ({ ...billing.publicPlans(), competitors: billing.competitors() }), { public: true });
route('PUT', '/api/admin/competitors', async (req) => {
  const r = await billing.setCompetitors(await readJson(req));
  audit(req, 'updated the price comparison');
  return r;
}, { perm: 'billing.manage' });
route('PUT', '/api/admin/costs', async (req) => {
  const r = await billing.setCosts((await readJson(req)).items);
  audit(req, 'updated the costs on the donate page');
  return r;
}, { perm: 'billing.manage' });
route('PUT', '/api/admin/donations/:id', async (req, res, p) => {
  const body = await readJson(req);
  const d = await billing.setDonationHidden(p.id, body.hidden);
  audit(req, `${d.hidden ? 'hid' : 'showed'} a supporter message on the donate page`);
  return d;
}, { perm: 'billing.manage' });

// ---------- managed plugins (Staff Console #staff-plugin) ----------
// Every plugin Tree Host puts on servers by itself: the built-in staff plugin and any staff add. See src/managed-plugins.js.

/** Upload options come in the query string; the body is the jar itself. */
const pluginOpts = (q) => ({
  filename: q.get('filename'),
  name: q.get('name'),
  version: q.get('version'),
  description: q.get('description'),
  notes: q.get('notes'),
  locked: q.get('locked') !== '0',
  autoInstall: q.get('autoInstall') !== '0',
  serverTypes: q.get('types') || '',
});

/** Puts the staff plugin on every server that needs it now. */
async function pushStaffPlugin() {
  const r = { servers: 0, installed: 0, restored: 0, failed: 0 };
  for (const inst of manager.instances.values()) {
    if (!manager.protectedPlugin(inst)) continue;
    r.servers++;
    try {
      if (await syncStaffPlugin(inst)) r.restored++;
    } catch {
      r.failed++;
    }
  }
  return r;
}

route('GET', '/api/admin/managed-plugins', async () => ({
  types: PLUGIN_TYPES,
  plugins: await managedPlugins.list(),
}), { perm: 'system.view' });

route('GET', '/api/admin/managed-plugins/:id', (req, res, p) => managedPlugins.view(p.id, { servers: true }), { perm: 'system.view' });

route('GET', '/api/admin/managed-plugins/:id/jar', async (req, res, p) => {
  const { buf, filename } = await managedPlugins.jar(p.id);
  res.writeHead(200, {
    'Content-Type': 'application/java-archive',
    'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(buf);
  return HANDLED;
}, { perm: 'system.view' });

route('POST', '/api/admin/managed-plugins', async (req, res, p, q) => {
  const plugin = await managedPlugins.add(await readBytes(req, MAX_JAR), pluginOpts(q), req.user.username);
  audit(req, `added the managed plugin ${plugin.name} ${plugin.version} (${plugin.filename}${plugin.locked ? ', locked' : ''})`);
  return plugin;
}, { perm: 'system.manage' });

route('POST', '/api/admin/managed-plugins/:id/jar', async (req, res, p, q) => {
  const plugin = await managedPlugins.replace(p.id, await readBytes(req, MAX_JAR), pluginOpts(q), req.user.username);
  audit(req, `uploaded ${plugin.name} ${plugin.version} (managed plugin)`);
  return plugin;
}, { perm: 'system.manage' });

route('DELETE', '/api/admin/managed-plugins/:id/jar', async (req, res, p) => {
  if (p.id !== STAFF_ID) throw httpError(400, 'Only the staff plugin can go back to a bundled version.');
  const plugin = await managedPlugins.revertStaff();
  audit(req, 'put the Tree Host staff plugin back to the version bundled with Tree Host');
  return plugin;
}, { perm: 'system.manage' });

route('PUT', '/api/admin/managed-plugins/:id', async (req, res, p) => {
  if (p.id === STAFF_ID) throw httpError(400, "The staff plugin's settings can't be changed: it's required on every server.");
  const plugin = await managedPlugins.update(p.id, await readJson(req));
  audit(req, `changed the settings of the managed plugin ${plugin.name}`);
  return plugin;
}, { perm: 'system.manage' });

route('DELETE', '/api/admin/managed-plugins/:id', async (req, res, p, q) => {
  if (p.id === STAFF_ID) throw httpError(400, 'The staff plugin is built in and is required on every server.');
  const { name } = managedPlugins.get(p.id);
  const purge = q.get('purge') === '1';
  const r = await managedPlugins.remove(p.id, { purge });
  audit(req, `stopped managing the plugin ${name}${purge ? ` and removed it from servers (${r.removedFrom} file(s))` : ' (left on servers)'}`);
  return r;
}, { perm: 'system.manage' });

/** Installs one plugin everywhere it applies right now, including where an owner removed an unlocked one. */
route('POST', '/api/admin/managed-plugins/:id/push', async (req, res, p) => {
  const staff = p.id === STAFF_ID;
  const name = staff ? 'Tree Host Staff' : managedPlugins.get(p.id).name;
  const r = staff ? await pushStaffPlugin() : await managedPlugins.syncAll({ force: true, only: p.id });
  audit(req, `pushed the managed plugin ${name} to every server it belongs on`);
  return r;
}, { perm: 'system.manage' });

/** Checks every server for every managed plugin now (instead of waiting for the 30-second check). */
route('POST', '/api/admin/managed-plugins-sync', async (req) => {
  const staff = await pushStaffPlugin();
  const r = await managedPlugins.syncAll();
  audit(req, 'checked every server for its managed plugins');
  return { ...r, restored: r.restored + staff.restored, failed: r.failed + staff.failed };
}, { perm: 'system.manage' });

// ---------- the team page ----------
// Everyone with a role at Developer level or above (Owner, Admin, Developer, and custom roles that high) is shown,
// unless they turn it off. They set a title and a short bio in Account; the picture is their Minecraft head.
const TEAM_PAGE_LEVEL = 60;
const onTeamPage = (u) => !u.restriction && rbac.role(u.role).level >= TEAM_PAGE_LEVEL;
route('GET', '/api/team-page', () => {
  if (!TEAM) return { members: [] };
  return {
    members: auth.users
      .filter((u) => onTeamPage(u) && !(u.teamProfile && u.teamProfile.show === false))
      .map((u) => {
        const r = rbac.role(u.role);
        const tp = u.teamProfile || {};
        return { username: u.username, role: r.label, level: r.level, title: tp.title || '', bio: tp.bio || '', mcName: u.mcName || '', since: u.createdAt || null };
      })
      .sort((a, b) => b.level - a.level || (a.since || 0) - (b.since || 0))
      .map(({ level, ...m }) => m),
  };
}, { public: true });
route('PUT', '/api/account/staff-prefs', async (req) => {
  if (!rbac.isStaff(req.user)) throw httpError(403, 'Only Tree Host staff have in-game staff settings.');
  setStaffPrefs(req.user, await readJson(req));
  await auth.save();
  syncStaffListsSoon();
  return staffPrefsOf(req.user);
});
route('PUT', '/api/account/team-profile', async (req) => {
  if (!onTeamPage(req.user)) throw httpError(403, 'Only Owners, Admins and Developers are on the team page.');
  const body = await readJson(req);
  const clean = (v, n) => String(v || '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, n);
  req.user.teamProfile = { show: body.show !== false, title: clean(body.title, 40), bio: clean(body.bio, 280) };
  await auth.save();
  return req.user.teamProfile;
});

// ---------- the Tree Host staff plugin (Paper, Spigot, Purpur, Folia, CraftBukkit) ----------
// TreeHostStaff.jar goes on every customer server of these types when it's created, is checked before every start
// and every 30 seconds, and is put back if it was removed or changed. It can't be deleted, turned off or replaced
// from the dashboard. Tree Host keeps plugins/TreeHostStaff/staff.txt (who is staff) current.
// The jar is minecraft-plugin/TreeHostStaff.jar, unless staff uploaded a newer one in the Staff Console. Other
// plugins staff add there (src/managed-plugins.js) are synced right after it.

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const managedEligible = (inst) => TEAM && (inst.isCustomer || inst.cfg.isDemo || inst.cfg.space === 'team') && ['bukkit', 'velocity', 'bungee'].includes(inst.provider.family);
const managedPlugins = new ManagedPlugins({
  manager,
  eligible: managedEligible,
  readMeta: readPluginMeta,
  log: (inst, text, p) => {
    inst.sysLog(text);
    activity.log('moderation', 'Tree Host', `put the managed plugin ${p.name} back on "${inst.cfg.name}" of ${manager.ownerName(inst.cfg.owner) || 'a customer'} (it had been removed or changed)`);
  },
}).load();
if (!managedPlugins.staffJar) console.error('  The Tree Host staff plugin (minecraft-plugin/TreeHostStaff.jar) is missing: run node minecraft-plugin/build.js');

manager.protectedPlugin = (inst) => managedPlugins.staffApplies(inst);
manager.lockedPluginFiles = (inst) => managedPlugins.lockedFiles(inst);
manager.managedPluginInfo = (inst, file) => managedPlugins.infoFor(inst, file);

function staffListText() {
  const lines = auth.users
    .filter((u) => u.mcName && /^[A-Za-z0-9_]{3,16}$/.test(u.mcName) && !u.restriction && rbac.isStaff(u))
    .map((u) => `${u.mcName}|${rbac.role(u.role).label}`)
    .sort();
  // Each staff member's choices (Account, or the in-game staff menu): operator while they're on a server (only when
  // their role may run console commands on any server anyway), a join announcement, the badge floating over their head.
  const flags = [];
  for (const u of auth.users) {
    if (!u.mcName || !/^[A-Za-z0-9_]{3,16}$/.test(u.mcName) || u.restriction || !rbac.isStaff(u)) continue;
    const prefs = staffPrefsOf(u);
    if (prefs.autoOp && prefs.canOp) flags.push(`#op=${u.mcName}`);
    if (!prefs.announce) flags.push(`#quiet=${u.mcName}`);
    if (!prefs.badge) flags.push(`#nobadge=${u.mcName}`);
  }
  flags.sort();
  return `# Official Tree Host staff. Managed by Tree Host: changes here are undone.\n${lines.join('\n')}\n${flags.length ? `${flags.join('\n')}\n` : ''}`;
}

/** A staff member's in-game choices (everything on unless they turned it off). */
function staffPrefsOf(u) {
  const p = u.staffPrefs || {};
  return { announce: p.announce !== false, badge: p.badge !== false, autoOp: p.autoOp !== false, canOp: rbac.can(u, 'servers.operate') };
}

const STAFF_PREF_KEYS = ['announce', 'badge', 'autoOp'];
function setStaffPrefs(u, changes) {
  const next = { ...(u.staffPrefs || {}) };
  for (const k of STAFF_PREF_KEYS) if (changes[k] !== undefined) next[k] = !!changes[k];
  u.staffPrefs = next;
}

/**
 * Changes staff made in the in-game staff menu: the plugin writes "name|announce|off" lines to prefs-out.txt.
 * Only these three choices can be changed this way, and "op" still needs the role's permission.
 */
async function readStaffPrefsOutbox(inst) {
  const file = path.join(inst.dir, inst.pluginDirName, 'TreeHostStaff', 'prefs-out.txt');
  const text = await fsp.readFile(file, 'utf8').catch(() => null);
  if (text == null) return;
  await fsp.rm(file, { force: true }).catch(() => {});
  let changed = false;
  for (const line of text.split(/\r?\n/)) {
    const [name, key, value] = line.trim().split('|');
    if (!name || !STAFF_PREF_KEYS.includes(key) || !['on', 'off'].includes(value)) continue;
    const u = auth.users.find((x) => x.mcName && x.mcName.toLowerCase() === name.toLowerCase() && rbac.isStaff(x) && !x.restriction);
    if (!u) continue;
    setStaffPrefs(u, { [key]: value === 'on' });
    changed = true;
  }
  if (changed) {
    await auth.save();
    syncStaffListsSoon();
  }
}
const staffFileFor = (inst) => `${staffListText()}${manager.networkFor && manager.networkFor(inst) ? '#trust=proxy\n' : ''}`;

/** creators.txt for the staff plugin: "minecraftName|Role|perk,perk" for everyone (not staff) with creator perks. */
function creatorListText() {
  const lines = [];
  for (const u of auth.users) {
    if (!u.mcName || !/^[A-Za-z0-9_]{3,16}$/.test(u.mcName) || u.restriction || rbac.isStaff(u)) continue;
    const perks = Object.entries(CREATOR_PERKS).filter(([perm]) => rbac.can(u, perm)).map(([, perk]) => perk);
    if (perks.length) lines.push(`${u.mcName}|${rbac.role(u.role).label.replace(/[^A-Za-z0-9 ]/g, '').slice(0, 16) || 'Creator'}|${perks.join(',')}`);
  }
  return `# Tree Host creators (YouTubers) and their perks. Managed by Tree Host: changes here are undone.\n${lines.sort().join('\n')}\n`;
}

/** founders.txt for the staff plugin: "minecraftName|tier" for everyone who backed the launch fund (badge on every server). */
function founderListText() {
  const lines = billing.founders((id) => auth.userById(id))
    .filter((f) => /^[A-Za-z0-9_]{3,16}$/.test(f.mcName))
    .map((f) => `${f.mcName}|${f.tier.id}`)
    .sort();
  return `# Tree Host launch fund supporters (badge on every Tree Host server). Managed by Tree Host: changes here are undone.\n${lines.join('\n')}\n`;
}
billing.hooks.donated = (d) => {
  syncStaffListsSoon();
  const f = billing.founders((id) => auth.userById(id)).find((x) => (d.userId ? x.mcName === ((auth.userById(d.userId) || {}).mcName || d.mcName) : x.mcName === d.mcName));
  if (testSite) testSite.event('donation', { user: d.public ? d.name || 'Someone' : 'Someone', server: f ? f.tier.label : 'Supporter' });
};

/** Every server's staff and creator lists, now (after a role or its permissions change). */
const syncStaffListsSoon = () => setTimeout(() => {
  for (const i of manager.instances.values()) syncStaffPlugin(i).catch(() => {});
}, 100);

/** Puts the plugin and the staff list in place (if missing or changed). Returns true if the plugin had to be restored. */
async function syncStaffPlugin(inst) {
  if (!manager.protectedPlugin(inst)) return false;
  await readStaffPrefsOutbox(inst).catch((e) => console.error(`[staff plugin] ${inst.cfg.id} prefs: ${e.message}`));
  const dir = path.join(inst.dir, inst.pluginDirName);
  const jar = path.join(dir, 'TreeHostStaff.jar');
  await fsp.mkdir(path.join(dir, 'TreeHostStaff'), { recursive: true });
  let restored = false;
  await fsp.rm(`${jar}.disabled`, { force: true }).then(() => {}, () => {});
  const want = managedPlugins.staffHash;
  let current = (await managedPlugins.fileHash(jar)) === want;
  if (!current) {
    try {
      await fsp.writeFile(jar, managedPlugins.staffJar);
      console.log(`[staff plugin] ${inst.cfg.id}: installed TreeHostStaff.jar`);
      // Put back, not just updated to a newer build staff uploaded: the server had this exact version before.
      restored = !!inst.cfg.staffPluginInstalled && (!inst.cfg.staffPluginHash || inst.cfg.staffPluginHash === want);
      current = true;
    } catch (e) {
      // In use by the running server (Windows): it's loaded already, and gets replaced before the next start.
      if (!['EBUSY', 'EPERM'].includes(e.code)) throw e;
    }
  }
  // The owner's MOTD for the plugin to show (hex colors, and a new frame every few seconds when animated).
  const motdFile = path.join(dir, 'TreeHostStaff', 'motd.txt');
  const m = inst.cfg.motd;
  const motdText = m && m.frames && m.frames.length ? `#interval=${m.interval || 3}\n${m.frames.map((f) => MOTD.toSection(f)).join('\n---\n')}\n` : '';
  if ((await fsp.readFile(motdFile, 'utf8').catch(() => null)) !== motdText) await fsp.writeFile(motdFile, motdText);
  const list = path.join(dir, 'TreeHostStaff', 'staff.txt');
  const text = staffFileFor(inst);
  if ((await fsp.readFile(list, 'utf8').catch(() => null)) !== text) await fsp.writeFile(list, text);
  const foundersFile = path.join(dir, 'TreeHostStaff', 'founders.txt');
  const founders = founderListText();
  if ((await fsp.readFile(foundersFile, 'utf8').catch(() => null)) !== founders) await fsp.writeFile(foundersFile, founders);
  const creatorsFile = path.join(dir, 'TreeHostStaff', 'creators.txt');
  const creators = creatorListText();
  if ((await fsp.readFile(creatorsFile, 'utf8').catch(() => null)) !== creators) await fsp.writeFile(creatorsFile, creators);
  if (current && (!inst.cfg.staffPluginInstalled || inst.cfg.staffPluginHash !== want)) {
    inst.cfg.staffPluginInstalled = true;
    inst.cfg.staffPluginHash = want;
    manager.save();
  }
  if (restored) {
    inst.sysLog('The Tree Host staff plugin was removed or changed, so it was put back. It is required on every server.');
    activity.log('moderation', 'Tree Host', `put the Tree Host staff plugin back on "${inst.cfg.name}" of ${manager.ownerName(inst.cfg.owner) || 'a customer'} (it had been removed or changed)`);
  }
  return restored;
}

manager.beforeStart = async (inst) => {
  if (inst.cfg.sleeping || wakers.has(inst.cfg.id)) {
    inst.cfg.sleeping = false;
    manager.save();
    await closeWaker(inst);
  }
  await syncStaffPlugin(inst).catch((e) => console.error(`[staff plugin] ${inst.cfg.id}: ${e.message}`));
  await managedPlugins.syncInstance(inst).catch((e) => console.error(`[managed plugins] ${inst.cfg.id}: ${e.message}`));
};
setInterval(async () => {
  for (const inst of manager.instances.values()) {
    await syncStaffPlugin(inst).catch(() => {});
    await managedPlugins.syncInstance(inst).catch(() => {});
  }
}, 30 * 1000);

/** True if Minecraft version a is older than b (1.20.4 < 1.21.1 < 26.2). Snapshots and unknown formats: false. */
function olderMinecraft(a, b) {
  const parse = (v) => (/^\d+(\.\d+)*$/.test(String(v || '')) ? String(v).split('.').map(Number) : null);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  }
  return false;
}

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
    { text: 'Tree Host ', color: 'green', bold: true },
    { text: `» ${name} `, color: 'gold', bold: true },
    { text: `(${role}) joined. `, color: 'gold' },
    { text: `A Tree Host ${role} has joined your server.`, color: 'green', hover: 'Official Tree Host Staff' },
  ])}`);
  inst.sysLog(`Tree Host staff ${name} (${user.username}, ${role}) joined the server.`);
  inst.logActivity('staff', user.username, `joined "${inst.cfg.name}" in Minecraft as ${name} (${role})`);
}

manager.onConsoleLine = (inst, line) => {
  if (!TEAM || !inst.isCustomer || !supportsStaffFeatures(inst)) return;
  if (/\[TreeHostStaff\] Tree Host staff protection is active/.test(line)) inst.staffPluginLoaded = true;
  if (inst.staffPluginLoaded) return; // the plugin does it all (and better) on Paper, Spigot and friends
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
    inst.write(`tellraw @a ${component(inst, [{ text: 'Tree Host ', color: 'green', bold: true }, { text: `» ${m[1]} is Tree Host staff and can't be banned.`, color: 'gold' }])}`);
    inst.sysLog(`Someone tried to ban Tree Host staff ${m[1]}; the ban was undone.`);
    return;
  }
  m = /: (?:\[[A-Za-z0-9_]{1,16}: )?Kicked ([A-Za-z0-9_]{3,16})[:,]/.exec(line);
  if (m && staffFor(m[1])) {
    inst.write(`tellraw @a ${component(inst, [{ text: 'Tree Host ', color: 'green', bold: true }, { text: `» ${m[1]} is Tree Host staff. Please don't kick staff while they help you.`, color: 'gold' }])}`);
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
  if (!inst.staffPluginLoaded) {
    // Without the plugin (Vanilla, Fabric), let them through the whitelist and any ban with commands.
    inst.staffWhitelisted = inst.staffWhitelisted || new Set();
    inst.write(`pardon ${name}`);
    inst.write(`whitelist add ${name}`);
    inst.staffWhitelisted.add(name.toLowerCase());
  }
  audit(req, `joined the server "${inst.cfg.name}" in Minecraft as staff (${name})`, inst);
  return { ok: true, address: inst.toJSON().publicAddress, name, onlineMode: inst.onlineMode !== false };
}, { perm: 'console.access' });

// ---------- Networks: a customer's proxy (Velocity, BungeeCord, Waterfall) in front of their own servers ----------
// The owner ticks which of their servers join the proxy and where players start. Tree Host writes the proxy's server
// list and forwarding, and sets each server up to trust that proxy only (Paper: modern forwarding with a secret;
// Spigot/CraftBukkit: BungeeCord forwarding). Vanilla and Fabric servers can't sit behind a proxy this way.

const networkSlug = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'server';
const canJoinNetwork = (inst) => inst.provider.kind !== 'proxy' && inst.provider.family === 'bukkit';

/** The proxy that has this server in its network (same owner), or null. */
function proxyOf(inst) {
  for (const p of manager.instances.values()) {
    if (p.provider.kind === 'proxy' && p.cfg.network && (p.cfg.network.servers || []).includes(inst.cfg.id) && p.cfg.owner === inst.cfg.owner) return p;
  }
  return null;
}

/** What the proxy needs: its servers (name, address it can reach them at), forwarding mode and secret. */
manager.networkOf = (proxy) => {
  const n = proxy.cfg.network;
  if (!n) return null;
  const used = new Set(['try']);
  const backends = (n.servers || [])
    .map((id) => manager.instances.get(id))
    .filter((i) => i && canJoinNetwork(i) && i.cfg.owner === proxy.cfg.owner)
    .sort((a, b) => (b.cfg.id === n.default) - (a.cfg.id === n.default))
    .map((i) => {
      let name = networkSlug(i.cfg.name);
      for (let k = 2; used.has(name); k++) name = `${networkSlug(i.cfg.name)}-${k}`;
      used.add(name);
      // A proxy in its own container reaches the others through the ports they publish on this machine.
      return { id: i.cfg.id, name, label: i.cfg.name, address: `${proxy.isolated ? 'host.docker.internal' : '127.0.0.1'}:${i.cfg.port}` };
    });
  return { backends, mode: networkMode(proxy), secret: n.secret };
};

/** Modern forwarding when every server is Paper/Purpur/Folia 1.13+ (and the proxy is Velocity), else legacy. */
function networkMode(proxy) {
  if (proxy.provider.family !== 'velocity') return 'legacy';
  const servers = (proxy.cfg.network.servers || []).map((id) => manager.instances.get(id)).filter(Boolean);
  return servers.every((i) => ['paper', 'purpur', 'folia'].includes(i.cfg.type) && versionAtLeast(i.cfg.version, [1, 13])) ? 'modern' : 'legacy';
}

manager.networkFor = (inst) => {
  const p = proxyOf(inst);
  if (!p) return null;
  return { proxyId: p.cfg.id, proxyName: p.cfg.name, proxyAddress: p.toJSON().publicAddress, mode: networkMode(p), secret: p.cfg.network.secret };
};

route('GET', '/api/servers/:id/network', (req, res, p) => {
  const proxy = getFor(req, p.id);
  if (proxy.provider.kind !== 'proxy') throw httpError(400, 'Only proxies have a network.');
  const n = proxy.cfg.network || { servers: [], default: null };
  const candidates = [...manager.instances.values()].filter((i) => i !== proxy && i.provider.kind !== 'proxy' && i.cfg.owner === proxy.cfg.owner);
  return {
    servers: candidates.map((i) => {
      const other = proxyOf(i);
      return {
        id: i.cfg.id, name: i.cfg.name, type: i.provider.label, version: i.cfg.version, status: i.status,
        selected: (n.servers || []).includes(i.cfg.id), compatible: canJoinNetwork(i),
        inOtherNetwork: other && other !== proxy ? other.cfg.name : null,
      };
    }),
    default: n.default || null,
    mode: proxy.cfg.network ? networkMode(proxy) : null,
    names: (manager.networkOf(proxy) || { backends: [] }).backends.map((b) => ({ id: b.id, name: b.name })),
  };
});

route('PUT', '/api/servers/:id/network', async (req, res, p) => {
  const proxy = getFor(req, p.id, 'settings');
  if (proxy.provider.kind !== 'proxy') throw httpError(400, 'Only proxies have a network.');
  const b = await readJson(req);
  const ids = [...new Set(Array.isArray(b.servers) ? b.servers : [])];
  const chosen = ids.map((id) => manager.instances.get(id));
  for (const [k, i] of chosen.entries()) {
    if (!i || i.cfg.owner !== proxy.cfg.owner || i.provider.kind === 'proxy') throw httpError(400, 'You can only connect your own servers.');
    if (!canJoinNetwork(i)) throw httpError(400, `"${i.cfg.name}" is ${i.provider.label}: only Paper, Purpur, Folia, Spigot and CraftBukkit servers can go behind a proxy.`);
    const other = proxyOf(i);
    if (other && other !== proxy) throw httpError(400, `"${i.cfg.name}" is already in the network of "${other.cfg.name}".`);
    void k;
  }
  const before = new Set((proxy.cfg.network && proxy.cfg.network.servers) || []);
  proxy.cfg.network = ids.length
    ? { servers: ids, default: ids.includes(b.default) ? b.default : ids[0], secret: (proxy.cfg.network && proxy.cfg.network.secret) || crypto.randomBytes(18).toString('base64url') }
    : null;
  manager.save();
  // Apply now: the proxy's config, and each server's (they take it on their next start).
  const touched = [...new Set([...before, ...ids])].map((id) => manager.instances.get(id)).filter(Boolean);
  for (const i of touched) await i.applyNetworkBackend().catch((e) => i.sysLog(`Could not update the network settings: ${e.message}`));
  for (const i of touched) await syncStaffPlugin(i).catch(() => {}); // the staff list knows when names are checked by the proxy
  if (proxy.cfg.network || before.size) await proxy.prepareConfigFiles().catch(() => {});
  if (proxy.proc && proxy.status === 'running' && proxy.provider.family === 'velocity') proxy.write('velocity reload');
  const restart = [proxy, ...touched].filter((i) => i.proc).map((i) => ({ id: i.cfg.id, name: i.cfg.name }));
  proxy.logActivity('server', who(req), `updated the network (${ids.length} server${ids.length === 1 ? '' : 's'})`);
  proxy.emitStatus();
  return { ok: true, restart, mode: proxy.cfg.network ? networkMode(proxy) : null };
});

// ---------- sleep when nobody is online, wake up when someone joins ----------
// A sleeping server uses no memory or CPU. Tree Host answers on its port meanwhile: the server list shows
// "Sleeping - join to wake it up", and joining starts the real server (players join again ~30 seconds later).

const { Waker } = require('./waker');
const wakers = new Map(); // server id -> Waker
const canSleep = (inst) => inst.provider.kind !== 'proxy';

function iconDataUrl(inst) {
  try {
    return `data:image/png;base64,${fs.readFileSync(path.join(inst.dir, 'server-icon.png')).toString('base64')}`;
  } catch {
    return null;
  }
}

async function closeWaker(inst) {
  const w = wakers.get(inst.cfg.id);
  if (!w) return;
  wakers.delete(inst.cfg.id);
  await w.close();
}

async function startWaker(inst) {
  if (wakers.has(inst.cfg.id) || inst.proc || !manager.instances.has(inst.cfg.id)) return;
  if (!inst.cfg.sleep || !inst.cfg.sleep.enabled) {
    inst.cfg.sleeping = false;
    manager.save();
    return;
  }
  const firstLine = inst.cfg.motd && inst.cfg.motd.frames && inst.cfg.motd.frames[0] ? MOTD.toClassic(inst.cfg.motd.frames[0].split('\n')[0]) : `§f${inst.cfg.name}`;
  const w = new Waker({
    port: inst.cfg.port,
    status: () => ({
      motd: `${firstLine}\n§7Zz Sleeping §8· §aJoin to wake it up!`,
      favicon: iconDataUrl(inst),
      maxPlayers: inst.maxPlayers || 20,
      versionName: `Sleeping · ${inst.cfg.version}`,
    }),
    onJoin: (name) => {
      const blocked = manager.startBlock(inst);
      if (blocked) return `§cThis server can't start right now: ${blocked}`;
      // Wake up just after the "waking up" reply has gone out to the player.
      setTimeout(() => wake(inst, name || 'A player').catch((e) => inst.sysLog(`Could not wake up: ${e.message}`)), 300);
      return '§a§lWaking the server up!\n\n§7It takes about 30 seconds. §fJoin again in a moment.';
    },
  });
  try {
    await w.start();
    wakers.set(inst.cfg.id, w);
  } catch (e) {
    inst.sysLog(`Sleeping, but could not answer on port ${inst.cfg.port} (${e.code || e.message}). Start the server from the dashboard.`);
  }
}

async function wake(inst, by) {
  inst.cfg.sleeping = false;
  manager.save();
  await closeWaker(inst);
  inst.sysLog(`${by} wants to play: waking up...`);
  inst.logActivity('start', by, 'woke the server up by joining');
  inst.crashTimes = [];
  inst.start();
}

function goToSleep(inst, minutes) {
  inst.cfg.sleeping = true;
  manager.save();
  inst.sysLog(`Nobody has been online for ${minutes} minutes, so the server is going to sleep. It wakes up when someone joins.`);
  inst.logActivity('stop', 'Tree Host', `put the server to sleep (empty for ${minutes} minutes)`);
  inst.stop();
}

// After a sleeping server has stopped, answer on its port.
manager.on('status', (inst) => {
  // Status updates come often (memory readings): only a fresh start resets the "empty since" clock.
  if (inst.status === 'running' && inst.lastSeenStatus !== 'running') inst.emptySince = Date.now();
  inst.lastSeenStatus = inst.status;
  if (inst.cfg.sleeping && inst.status === 'stopped' && !inst.proc) startWaker(inst).catch(() => {});
});

setInterval(() => {
  for (const inst of manager.instances.values()) {
    const sl = inst.cfg.sleep;
    if (!sl || !sl.enabled || !canSleep(inst) || inst.status !== 'running') continue;
    if (inst.players.size > 0) {
      inst.emptySince = Date.now();
      continue;
    }
    inst.emptySince = inst.emptySince || Date.now();
    if (Date.now() - inst.emptySince >= sl.minutes * 60000) goToSleep(inst, sl.minutes);
  }
  for (const id of wakers.keys()) if (!manager.instances.has(id)) closeWaker({ cfg: { id } }).catch(() => {});
}, 30 * 1000);

route('PUT', '/api/servers/:id/sleep', async (req, res, p) => {
  const inst = getFor(req, p.id, 'settings');
  if (!canSleep(inst)) throw httpError(400, "Proxies can't sleep (they don't know when your players leave).");
  const b = await readJson(req);
  const minutes = [5, 10, 15, 30, 60, 120].includes(Number(b.minutes)) ? Number(b.minutes) : 15;
  inst.cfg.sleep = { enabled: !!b.enabled, minutes };
  if (!b.enabled && inst.cfg.sleeping) {
    inst.cfg.sleeping = false;
    await closeWaker(inst);
  }
  manager.save();
  inst.emitStatus();
  inst.logActivity('server', who(req), b.enabled ? `turned on sleep when empty (${minutes} min)` : 'turned off sleep when empty');
  return inst.toJSON();
});

// ---------- scheduled tasks: restarts (with countdown warnings), stops, starts, backups, commands, messages ----------

const TASK_ACTIONS = { restart: 'Restart', stop: 'Stop', start: 'Start', backup: 'Back up', command: 'Run a command', broadcast: 'Send a message' };
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function localParts(tz, t = Date.now()) {
  let parts;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  } catch {
    return localParts('UTC', t);
  }
  return { day: WEEKDAYS.indexOf(parts.weekday), time: `${parts.hour}:${parts.minute}`, date: `${parts.year}-${parts.month}-${parts.day}` };
}

function cleanTask(t) {
  const action = TASK_ACTIONS[t.action] ? t.action : null;
  if (!action) throw httpError(400, 'Pick what the task does.');
  const when = t.when && t.when.type === 'every'
    ? { type: 'every', hours: [1, 2, 3, 4, 6, 8, 12, 24].includes(Number(t.when.hours)) ? Number(t.when.hours) : 6 }
    : { type: 'daily', time: /^([01]\d|2[0-3]):[0-5]\d$/.test(t.when && t.when.time) ? t.when.time : '04:00', days: [...new Set((t.when && t.when.days) || [])].filter((d) => d >= 0 && d <= 6).sort() };
  const text = String(t.text || '').replace(/[\r\n]/g, ' ').trim().slice(0, 200);
  if ((action === 'command' || action === 'broadcast') && !text) throw httpError(400, action === 'command' ? 'Type the command to run.' : 'Type the message.');
  return { id: t.id && /^[a-z0-9]{6,16}$/.test(t.id) ? t.id : crypto.randomBytes(5).toString('hex'), action, when, text: text.replace(/^\//, ''), warn: t.warn !== false, enabled: t.enabled !== false, lastRun: t.lastRun || null, lastKey: t.lastKey || null };
}

/** A server process is running (or the demo's simulated one: src/demo-sim.js). */
const alive = (inst) => !!inst.proc || !!(inst.demo && inst.demo.alive);

const say = (inst, text) => {
  if (inst.demo) return inst.demo.alive && inst.demo.log(`[Server] ${text}`);
  if (inst.provider.kind === 'proxy' || !inst.proc) return;
  try {
    if (versionAtLeast(inst.cfg.version, [1, 13])) inst.write(`tellraw @a ${component(inst, [{ text: '[Server] ', color: 'gold', bold: true }, { text, color: 'yellow' }])}`);
    else inst.write(`say ${text}`);
  } catch {}
};

/** Restarts/stops warn players first: 60, 30, 10 and 5..1 seconds before. */
async function countdown(inst, verb) {
  for (const [left, wait] of [[60, 30], [30, 20], [10, 5], [5, 1], [4, 1], [3, 1], [2, 1], [1, 1]]) {
    if (!alive(inst)) return false;
    say(inst, `The server ${verb} in ${left} second${left === 1 ? '' : 's'}.`);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
  return alive(inst);
}

async function runTask(inst, task) {
  const label = TASK_ACTIONS[task.action];
  const running = alive(inst) && inst.status === 'running';
  switch (task.action) {
    case 'restart':
      if (!running) return inst.sysLog('Scheduled restart skipped: the server is not running.');
      if (task.warn && !(await countdown(inst, 'restarts'))) return;
      inst.sysLog('Scheduled restart.');
      inst.crashTimes = [];
      inst.restart();
      break;
    case 'stop':
      if (!running) return;
      if (task.warn && !(await countdown(inst, 'stops'))) return;
      inst.sysLog('Scheduled stop.');
      inst.stop();
      break;
    case 'start':
      if (alive(inst) || inst.cfg.sleeping) return;
      if (manager.startBlock(inst)) return inst.sysLog(`Scheduled start skipped: ${manager.startBlock(inst)}`);
      inst.sysLog('Scheduled start.');
      inst.start();
      break;
    case 'backup':
      await backups.create(inst, { label: 'Scheduled backup', by: 'Schedule', automatic: true }).catch((e) => inst.sysLog(`Scheduled backup failed: ${e.message}`));
      break;
    case 'command':
      if (!running) return;
      inst.command(task.text);
      break;
    case 'broadcast':
      if (running) say(inst, task.text);
      break;
    default:
      return;
  }
  inst.logActivity('server', 'Schedule', `ran the scheduled task "${label}${task.text ? `: ${task.text}` : ''}"`);
}

setInterval(() => {
  const now = Date.now();
  for (const inst of manager.instances.values()) {
    if (!inst.cfg.schedules || !inst.cfg.schedules.length) continue;
    const local = localParts(inst.cfg.timeZone);
    for (const task of inst.cfg.schedules) {
      if (!task.enabled) continue;
      let due = false;
      if (task.when.type === 'daily') {
        const key = `${local.date} ${task.when.time}`;
        due = local.time === task.when.time && (!task.when.days.length || task.when.days.includes(local.day)) && task.lastKey !== key;
        if (due) task.lastKey = key;
      } else {
        due = !task.lastRun ? false : now - task.lastRun >= task.when.hours * 3600000;
        if (!task.lastRun) task.lastRun = now; // "every N hours" counts from when it was set up
      }
      if (!due) continue;
      task.lastRun = now;
      manager.save();
      runTask(inst, task).catch((e) => inst.sysLog(`Scheduled task failed: ${e.message}`));
    }
  }
}, 20 * 1000);

route('PUT', '/api/servers/:id/schedules', async (req, res, p) => {
  const inst = getFor(req, p.id, 'settings');
  const b = await readJson(req);
  const list = (Array.isArray(b.schedules) ? b.schedules : []).slice(0, 20).map(cleanTask);
  inst.cfg.schedules = list;
  if (b.timeZone && typeof b.timeZone === 'string' && b.timeZone.length < 60) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: b.timeZone });
      inst.cfg.timeZone = b.timeZone;
    } catch {}
  }
  manager.save();
  inst.emitStatus();
  inst.logActivity('server', who(req), `updated the scheduled tasks (${list.length})`);
  return inst.toJSON();
});

route('POST', '/api/servers/:id/schedules/:tid/run', async (req, res, p) => {
  const inst = getFor(req, p.id, 'settings');
  const task = (inst.cfg.schedules || []).find((t) => t.id === p.tid);
  if (!task) throw httpError(404, 'No such task.');
  runTask(inst, task).catch((e) => inst.sysLog(`Task failed: ${e.message}`));
  return { ok: true };
});

// ---------- performance history (memory, CPU, players) for the Performance tab ----------
// One sample a minute while a server runs, the last 24 hours, kept in memory.

const STATS_KEEP = 24 * 60;
setInterval(() => {
  const t = Date.now();
  for (const inst of manager.instances.values()) {
    if (!(inst.proc || (inst.demo && inst.demo.alive)) || inst.status !== 'running') continue;
    inst.stats = inst.stats || [];
    inst.stats.push({ t, mem: inst.memUsedMb || null, cpu: typeof inst.cpuPct === 'number' ? inst.cpuPct : null, players: inst.players.size });
    if (inst.stats.length > STATS_KEEP) inst.stats.splice(0, inst.stats.length - STATS_KEEP);
  }
}, 60 * 1000);

route('GET', '/api/servers/:id/stats', (req, res, p) => {
  const inst = getFor(req, p.id);
  const plan = manager.planInfo(inst);

  const live = !!inst.proc || !!(inst.demo && inst.demo.alive); // the demo's numbers come from src/demo-sim.js
  return {
    samples: inst.stats || [],
    memLimitMb: Number(inst.cfg.memoryMb) || null,
    cpuLimit: plan && plan.cpus ? plan.cpus * 100 : null,
    maxPlayers: inst.maxPlayers || null,
    now: { mem: live ? inst.memUsedMb || null : null, cpu: live && typeof inst.cpuPct === 'number' ? inst.cpuPct : null, players: inst.players.size, running: live },
  };
});

// ---------- download / upload the world as a zip ----------

const { writeZip, extractZip } = require('./zip');

async function worldFolders(inst) {
  const level = (await inst.getProperties())['level-name'] || 'world';
  const out = [];
  for (const f of [level, `${level}_nether`, `${level}_the_end`]) if (await fsp.stat(path.join(inst.dir, f)).then((s) => s.isDirectory(), () => false)) out.push(f);
  return { level, folders: out };
}

route('GET', '/api/servers/:id/world.zip', async (req, res, p) => {
  const inst = getFor(req, p.id, 'files');
  if (inst.provider.kind === 'proxy') throw httpError(400, 'Proxies have no world.');
  const { folders } = await worldFolders(inst);
  if (!folders.length) throw httpError(404, 'This server has no world yet. Start it once to create one.');
  // A running server saves everything to disk first, and pauses saving while the zip is made.
  const running = inst.proc && inst.status === 'running';
  if (running) {
    inst.write('save-off');
    inst.write('save-all flush');
    await new Promise((r) => setTimeout(r, 3000));
  }
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${(inst.cfg.name || 'world').replace(/[^\w.-]+/g, '-')}-world.zip"`,
    'Cache-Control': 'no-store',
  });
  try {
    await writeZip(res, inst.dir, folders);
  } catch (e) {
    inst.sysLog(`World download failed: ${e.message}`);
  } finally {
    if (running && inst.proc) inst.write('save-on');
    res.end();
  }
  inst.logActivity('backup', who(req), 'downloaded the world');
  return HANDLED;
});

route('POST', '/api/servers/:id/world', async (req, res, p) => {
  const inst = getFor(req, p.id, 'files');
  if (inst.provider.kind === 'proxy') throw httpError(400, 'Proxies have no world.');
  if (inst.proc) throw httpError(400, 'Stop the server first, then upload the world.');
  const tmpZip = path.join(inst.dir, `.upload-world-${crypto.randomBytes(4).toString('hex')}.zip`);
  const tmpDir = path.join(inst.dir, `.upload-world-${crypto.randomBytes(4).toString('hex')}`);
  const LIMIT = 4 * 1024 ** 3;
  try {
    await new Promise((resolve, reject) => {
      let size = 0;
      const out = fs.createWriteStream(tmpZip);
      req.on('data', (c) => {
        size += c.length;
        if (size > LIMIT) {
          req.destroy();
          reject(httpError(413, 'That zip is too big (4 GB at most).'));
        }
      });
      req.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
      req.on('error', reject);
    });
    await extractZip(tmpZip, tmpDir);
    // The world is the folder with level.dat in it (at the top of the zip, or one level down).
    const find = async (dir, depth) => {
      if (await fsp.stat(path.join(dir, 'level.dat')).then(() => true, () => false)) return dir;
      if (depth >= 3) return null;
      for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name === '__MACOSX') continue;
        const hit = await find(path.join(dir, e.name), depth + 1);
        if (hit) return hit;
      }
      return null;
    };
    const worldDir = await find(tmpDir, 0);
    if (!worldDir) throw httpError(400, "That zip has no Minecraft world in it (there's no level.dat). Zip the world folder itself.");
    const { level, folders } = await worldFolders(inst);
    if (folders.length) await backups.create(inst, { label: 'Before uploading a world', by: who(req) });
    for (const f of folders) await fsp.rm(path.join(inst.dir, f), { recursive: true, force: true });
    await fsp.rename(worldDir, path.join(inst.dir, level));
    inst.cfg.worldVersion = null; // unknown until it runs once
    manager.save();
    inst.sysLog(`${who(req)} uploaded a world${folders.length ? ' (the old one is in Backups)' : ''}. Start the server to play it. Single-player nether and end are moved into place on the first start.`);
    inst.logActivity('backup', who(req), 'uploaded a world');
    return { ok: true, backedUp: folders.length > 0 };
  } finally {
    await fsp.rm(tmpZip, { force: true }).catch(() => {});
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------- modpacks from Modrinth (Fabric), installed in one click ----------
// A .mrpack is a zip with modrinth.index.json (Minecraft + loader versions, and the mod files to download) plus
// overrides/ and server-overrides/ folders (configs). We make a Fabric server of the right version, download every
// file the server needs (checked against its SHA-1), and copy the overrides in.

const { readZipEntries } = require('./util');
const MODRINTH = 'https://api.modrinth.com/v2';
const MR_HEADERS = { 'User-Agent': 'TreeHost/1.0 (treehost.online)' };
// Hosts the .mrpack format allows files to come from.
const PACK_HOSTS = ['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com', 'objects.githubusercontent.com'];

async function mrJson(url) {
  const res = await fetch(url, { headers: MR_HEADERS, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw httpError(502, `Modrinth didn't answer (${res.status}). Try again in a moment.`);
  return res.json();
}

route('GET', '/api/modpacks/search', async (req, res, p, q) => {
  const facets = JSON.stringify([['project_type:modpack'], ['categories:fabric'], ['server_side:required', 'server_side:optional']]);
  const d = await mrJson(`${MODRINTH}/search?limit=20&index=${q.get('q') ? 'relevance' : 'downloads'}&query=${encodeURIComponent(q.get('q') || '')}&facets=${encodeURIComponent(facets)}`);
  return d.hits.map((h) => ({
    id: h.project_id, slug: h.slug, title: h.title, description: h.description, icon: h.icon_url || null, author: h.author,
    downloads: h.downloads, gameVersions: (h.versions || []).slice(-3).reverse(),
  }));
});

route('GET', '/api/modpacks/:id/versions', async (req, res, p) => {
  const list = await mrJson(`${MODRINTH}/project/${encodeURIComponent(p.id)}/version?loaders=${encodeURIComponent('["fabric"]')}`);
  // Only builds that are really Fabric (some packs tag NeoForge/Forge/Quilt builds as Fabric too).
  const fabricOnly = list.filter((v) => (v.loaders || []).includes('fabric') && !(v.loaders || []).some((l) => /forge|quilt/i.test(l)) && !/neo ?forge|\bforge\b|quilt/i.test(`${v.name} ${v.version_number}`));
  return fabricOnly.slice(0, 30).map((v) => ({ id: v.id, name: v.name, number: v.version_number, gameVersions: v.game_versions, published: v.date_published, type: v.version_type }));
});

/** Downloads and reads a modpack version: what to create, and the files to fetch. */
async function readModpack(versionId) {
  const v = await mrJson(`${MODRINTH}/version/${encodeURIComponent(versionId)}`);
  const file = (v.files || []).find((f) => f.primary && f.filename.endsWith('.mrpack')) || (v.files || []).find((f) => f.filename.endsWith('.mrpack'));
  if (!file) throw httpError(400, "That modpack version has no .mrpack file, so it can't be installed automatically.");
  const project = await mrJson(`${MODRINTH}/project/${encodeURIComponent(v.project_id)}`);
  const tmp = path.join(DATA, 'cache', `modpack-${crypto.randomBytes(5).toString('hex')}.mrpack`);
  await fsp.mkdir(path.dirname(tmp), { recursive: true });
  const res = await fetch(file.url, { headers: MR_HEADERS, signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw httpError(502, `Could not download the modpack (${res.status}).`);
  await fsp.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  const entries = await readZipEntries(tmp, ['modrinth.index.json']);
  if (!entries['modrinth.index.json']) throw httpError(400, "That file isn't a Modrinth modpack.");
  const index = JSON.parse(entries['modrinth.index.json'].toString('utf8'));
  const deps = index.dependencies || {};
  if (!deps['fabric-loader']) throw httpError(400, `This modpack uses ${Object.keys(deps).filter((k) => k !== 'minecraft').join(', ') || 'another loader'}. Tree Host installs Fabric modpacks for now.`);
  return { tmp, index, minecraft: deps.minecraft, loader: deps['fabric-loader'], title: project.title, slug: project.slug, icon: project.icon_url || null, versionNumber: v.version_number, versionId: v.id };
}

/** Puts a modpack's files on a server (runs in the background after the server is created). */
async function installModpackFiles(inst, pack) {
  const files = (pack.index.files || []).filter((f) => !f.env || f.env.server !== 'unsupported');
  inst.sysLog(`Installing the modpack ${pack.title} ${pack.versionNumber}: ${files.length} files...`);
  let done = 0;
  let total = 0;
  for (const f of files) {
    const dest = path.resolve(inst.dir, f.path);
    if (!dest.startsWith(path.resolve(inst.dir) + path.sep)) throw new Error(`Unsafe path in the modpack: ${f.path}`);
    const url = (f.downloads || []).find((u) => {
      try {
        return PACK_HOSTS.includes(new URL(u).hostname);
      } catch {
        return false;
      }
    });
    if (!url) {
      inst.sysLog(`Skipped ${f.path}: it isn't hosted on a trusted site.`);
      continue;
    }
    const r = await fetch(url, { headers: MR_HEADERS, signal: AbortSignal.timeout(180000) });
    if (!r.ok) throw new Error(`Could not download ${path.basename(f.path)} (${r.status}).`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (f.hashes && f.hashes.sha1 && crypto.createHash('sha1').update(buf).digest('hex') !== f.hashes.sha1) throw new Error(`${path.basename(f.path)} didn't match its checksum.`);
    total += buf.length;
    if (total > 4 * 1024 ** 3) throw new Error('The modpack is too big (over 4 GB).');
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, buf);
    done++;
    if (done % 10 === 0 || done === files.length) inst.sysLog(`Modpack: ${done} of ${files.length} files`);
  }
  // Configs and other files the pack ships (overrides/ for everyone, server-overrides/ for servers).
  const tmpDir = `${pack.tmp}-x`;
  await extractZip(pack.tmp, tmpDir);
  for (const sub of ['overrides', 'server-overrides']) {
    const from = path.join(tmpDir, sub);
    if (await fsp.stat(from).then(() => true, () => false)) await fsp.cp(from, inst.dir, { recursive: true, force: true });
  }
  await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(pack.tmp, { force: true }).catch(() => {});
  inst.sysLog(`Modpack ${pack.title} installed (${done} files). Press Start to play.`);
  inst.logActivity('deploy', 'Tree Host', `installed the modpack ${pack.title} ${pack.versionNumber}`);
}

// ---------- Bedrock crossplay: Geyser + Floodgate, installed in one click ----------

// On a proxy (Velocity, Waterfall, BungeeCord) Geyser goes on the proxy, so Bedrock players reach every server behind it.
const GEYSER_DL = 'https://download.geysermc.org/v2/projects';
const GEYSER = {
  bukkit: { 'Geyser-Spigot.jar': `${GEYSER_DL}/geyser/versions/latest/builds/latest/downloads/spigot`, 'floodgate-spigot.jar': `${GEYSER_DL}/floodgate/versions/latest/builds/latest/downloads/spigot` },
  velocity: { 'Geyser-Velocity.jar': `${GEYSER_DL}/geyser/versions/latest/builds/latest/downloads/velocity`, 'floodgate-velocity.jar': `${GEYSER_DL}/floodgate/versions/latest/builds/latest/downloads/velocity` },
  bungee: { 'Geyser-BungeeCord.jar': `${GEYSER_DL}/geyser/versions/latest/builds/latest/downloads/bungeecord`, 'floodgate-bungee.jar': `${GEYSER_DL}/floodgate/versions/latest/builds/latest/downloads/bungee` },
};
const geyserCache = path.join(DATA, 'cache', 'geyser');

/** The latest Geyser and Floodgate for a platform, downloaded at most once a day and shared by every server. */
async function geyserJars(family, log) {
  await fsp.mkdir(geyserCache, { recursive: true });
  const out = {};
  for (const [name, url] of Object.entries(GEYSER[family])) {
    const file = path.join(geyserCache, name);
    const st = await fsp.stat(file).catch(() => null);
    if (!st || Date.now() - st.mtimeMs > 86400000) {
      log(`Downloading ${name.replace('.jar', '')}...`);
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180000) });
      if (!res.ok) throw httpError(502, `Could not download ${name} (HTTP ${res.status}). Try again in a minute.`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100000 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw httpError(502, `The ${name} download looks broken. Try again in a minute.`);
      await fsp.writeFile(`${file}.tmp`, buf);
      await fsp.rename(`${file}.tmp`, file);
    }
    out[name] = file;
  }
  return out;
}

route('POST', '/api/servers/:id/bedrock', async (req, res, p) => {
  const inst = getFor(req, p.id, 'plugins');
  const family = inst.provider.family;
  if (!GEYSER[family]) throw httpError(400, 'Bedrock crossplay works on Paper, Purpur, Folia and Spigot servers, and on Velocity, Waterfall and BungeeCord proxies.');
  if (family === 'bukkit' && !versionAtLeast(inst.cfg.version, [1, 16, 5])) throw httpError(400, 'Geyser needs Minecraft 1.16.5 or newer.');
  const { enabled } = await readJson(req);
  if (enabled && proxyOf(inst)) throw httpError(400, 'This server is behind your proxy: turn Bedrock crossplay on for the proxy instead, and Bedrock players reach every server in the network.');
  const dir = path.join(inst.dir, inst.pluginDirName);
  if (enabled) {
    const jars = await geyserJars(family, (m) => inst.sysLog(m));
    await fsp.mkdir(dir, { recursive: true });
    for (const [name, file] of Object.entries(jars)) await fsp.copyFile(file, path.join(dir, name));
    inst.cfg.bedrock = true;
    await inst.applyBedrock();
    inst.sysLog(`Bedrock crossplay is on: phones, consoles and Windows players join with the same address (port ${inst.cfg.port}).${inst.proc ? ' Restart the server to start it.' : ''}`);
  } else {
    for (const name of Object.keys(GEYSER[family])) await fsp.rm(path.join(dir, name), { force: true }).catch(() => {});
    inst.cfg.bedrock = false;
    inst.sysLog(`Bedrock crossplay is off.${inst.proc ? ' Restart the server to finish.' : ''}`);
  }
  manager.save();
  inst.logActivity('server', who(req), enabled ? 'turned on Bedrock crossplay (Geyser + Floodgate)' : 'turned off Bedrock crossplay');
  inst.emitStatus();
  return { ...inst.toJSON(), restartNeeded: !!inst.proc };
});

// ---------- people the owner shares a server with ----------

route('POST', '/api/servers/:id/members', async (req, res, p) => {
  const inst = getFor(req, p.id);
  if (TEAM && inst.cfg.owner !== req.user.id && !can(req.user, 'servers.edit')) throw httpError(403, 'Only the owner can share this server.');
  const b = await readJson(req);
  if (!MEMBER_ROLES[b.role]) throw httpError(400, 'Pick a role: Co-owner, Helper or Viewer.');
  const who2 = String(b.user || '').trim().toLowerCase();
  const user = auth.users.find((u) => u.username.toLowerCase() === who2 || (u.email && u.email === who2));
  if (!user) throw httpError(404, `No Tree Host account called "${b.user}". They need to sign up first (it's free).`);
  if (user.id === inst.cfg.owner) throw httpError(400, "That's the owner.");
  inst.cfg.members = (inst.cfg.members || []).filter((m) => auth.userById(m.userId));
  const existing = inst.cfg.members.find((m) => m.userId === user.id);
  if (!existing && inst.cfg.members.length >= 20) throw httpError(400, 'A server can be shared with up to 20 people.');
  if (existing) existing.role = b.role;
  else inst.cfg.members.push({ userId: user.id, role: b.role, addedAt: Date.now(), addedBy: req.user.id });
  manager.save();
  inst.emitStatus();
  inst.logActivity('server', who(req), `${existing ? 'changed' : 'shared the server with'} ${user.username} (${MEMBER_ROLES[b.role].label})`);
  if (!existing) {
    await moderation.message(user.id, {
      title: `${req.user.username} shared "${inst.cfg.name}" with you`,
      body: `You're now a ${MEMBER_ROLES[b.role].label} on ${inst.cfg.name}. Find it in your server list on the dashboard.`,
      kind: 'message',
      from: req.user.username,
    }).catch(() => {});
  }
  return inst.toJSON();
});

route('DELETE', '/api/servers/:id/members/:uid', async (req, res, p) => {
  const inst = getFor(req, p.id);
  const self = p.uid === req.user.id;
  if (TEAM && !self && inst.cfg.owner !== req.user.id && !can(req.user, 'servers.edit')) throw httpError(403, 'Only the owner can change who has access.');
  const before = (inst.cfg.members || []).length;
  inst.cfg.members = (inst.cfg.members || []).filter((m) => m.userId !== p.uid);
  if (inst.cfg.members.length === before) throw httpError(404, 'That person has no access to this server.');
  manager.save();
  inst.emitStatus();
  inst.logActivity('server', who(req), self ? 'left the server' : `removed ${manager.ownerName(p.uid) || 'someone'}'s access`);
  return { ok: true };
});

// ---------- MOTD (the message under the server's name in the server list) ----------

route('PUT', '/api/servers/:id/motd', async (req, res, p) => {
  const inst = getFor(req, p.id, 'settings');
  const b = await readJson(req);
  inst.cfg.motd = b.clear ? null : MOTD.normalize(b);
  manager.save();
  // Paper/Spigot servers with the Tree Host plugin show it right away; the others on their next start.
  const live = !!inst.proc && manager.protectedPlugin(inst);
  await syncStaffPlugin(inst).catch(() => {});
  if (!inst.proc) await inst.prepareConfigFiles().catch(() => {});
  inst.logActivity('server', who(req), b.clear ? 'reset the MOTD' : `changed the MOTD${inst.cfg.motd.animated ? ` (animated, ${inst.cfg.motd.frames.length} frames)` : ''}`);
  inst.emitStatus();
  return { ...inst.toJSON(), motdLive: live, motdAnimates: manager.protectedPlugin(inst) };
});

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
      const online = alive(i) && i.status === 'running';
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
        address: i.cfg.isDemo ? null : j.publicAddress || null,
        demo: !!i.cfg.isDemo,
        online,
        players: online ? (j.players || []).length : 0,
        maxPlayers: maxPlayers(i),
        listedSince: i.cfg.listing.since || null,
        creator: TEAM && (auth.userById(i.cfg.owner) || {}).role === 'youtuber',
        featured: TEAM && !rbac.isStaff(auth.userById(i.cfg.owner)) && rbac.can(auth.userById(i.cfg.owner), 'creator.featured'),
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
  const inst = getFor(req, p.id, 'command');
  inst.command((await readJson(req)).command);
  // Demo funnel: a command run inside the shared demo server means the visitor is really trying it.
  if (inst.cfg.isDemo) { try { metrics.count('demoCommand'); } catch {} }
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

route('GET', '/api/servers/:id/properties', (req, res, p) => {
  const demo = manager.instances.get(p.id)?.cfg.isSharedDemo; // visitors may look at the demo's settings
  return getFor(req, p.id, demo ? 'view' : 'settings').getProperties();
});
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
// Browse a backup and restore one file or folder (needs the same access as the Files tab).
route('GET', '/api/servers/:id/backups/:bid/files', (req, res, p, q) => backups.listFiles(getFor(req, p.id, 'files'), p.bid, q.get('path') || ''));
route('POST', '/api/servers/:id/backups/:bid/restore-file', async (req, res, p) => {
  const inst = getFor(req, p.id, 'files');
  const r = await backups.restoreFile(inst, p.bid, String((await readJson(req)).path || ''));
  inst.sysLog(`${who(req)} restored ${r.folder ? 'the folder' : ''} ${r.path} from the backup "${r.backup.label}" (${new Date(r.backup.createdAt).toLocaleString()}).`);
  inst.logActivity('backup', who(req), `restored ${r.path} from the backup "${r.backup.label}"`);
  if (TEAM && inst.cfg.owner !== req.user.id && rbac.isStaff(req.user)) audit(req, `restored ${r.path} on "${inst.cfg.name}" from a backup`, inst);
  return r;
});
route('DELETE', '/api/servers/:id/backups/:bid', async (req, res, p) => {
  await backups.remove(getFor(req, p.id, 'manage'), p.bid);
  return { ok: true };
});

// Players tab: who's online, playtime, chat, whitelist/ops/bans; actions run as console commands.
route('GET', '/api/servers/:id/players', (req, res, p) => players.summary(getFor(req, p.id)));
route('POST', '/api/servers/:id/players/action', async (req, res, p) => {
  const inst = getFor(req, p.id, 'command');
  const body = await readJson(req);
  const cmd = players.action(inst, body);
  inst.logActivity('audit', who(req), `ran "${cmd}" from the Players tab`);
  if (TEAM && inst.cfg.owner !== req.user.id && rbac.isStaff(req.user)) audit(req, `ran "${cmd}" on "${inst.cfg.name}" from the Players tab`, inst);
  return { ok: true, command: cmd };
});

// Lag doctor (src/lagdoctor.js): checks a running server for lag and explains it. The checks are console commands.
route('GET', '/api/servers/:id/lag-doctor', (req, res, p) => getFor(req, p.id).lagReport || null);
route('POST', '/api/servers/:id/lag-doctor', async (req, res, p) => {
  const inst = getFor(req, p.id, 'command');
  inst.sysLog(`${who(req)} ran the lag doctor: checking TPS, tick times and entities…`);
  const report = await lagdoctor.examine(inst);
  const worst = report.findings.find((f) => f.severity === 'bad') || report.findings[0];
  inst.sysLog(`Lag doctor: ${worst.title}.`);
  return report;
});

// Plugin updates and the upgrade assistant (Modrinth knows each jar by its hash).
route('GET', '/api/servers/:id/plugin-updates', (req, res, p) => pluginUpdates.check(getFor(req, p.id)));
route('POST', '/api/servers/:id/plugin-updates', async (req, res, p) => {
  const inst = getFor(req, p.id, 'plugins');
  const body = await readJson(req);
  const done = await pluginUpdates.update(inst, Array.isArray(body.files) ? body.files.map(String) : null, who(req));
  if (done.length) {
    inst.sysLog(`${who(req)} updated ${done.map((d) => `${d.newFile} (${d.from} → ${d.to})`).join(', ')}.${inst.proc ? ' Restart to load the new version.' : ''} If the next start crashes, the old version comes back by itself.`);
    inst.logActivity('deploy', who(req), `updated ${done.length} plugin${done.length === 1 ? '' : 's'}`);
  }
  return { updated: done };
});
route('POST', '/api/servers/:id/plugin-updates/rollback', async (req, res, p) => {
  const inst = getFor(req, p.id, 'plugins');
  if (inst.proc) throw httpError(400, 'Stop the server first, then undo the update.');
  const back = pluginUpdates.rollback(inst);
  if (back.length) inst.sysLog(`${who(req)} undid the plugin update: ${back.map((i) => i.oldFile).join(', ')}.`);
  return { restored: back };
});
route('GET', '/api/servers/:id/upgrade-check', (req, res, p, q) => pluginUpdates.upgradeReport(getFor(req, p.id), String(q.get('version') || '')));

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
  if (['start', 'restart', 'install'].includes(p.action)) stagingBlock();
  const needs = { install: 'settings', 'reset-worlds': 'manage' }[p.action] || 'control';
  const inst = getFor(req, p.id, needs);
  switch (p.action) {
    case 'start': {
      const blocked = manager.startBlock(inst);
      if (blocked) throw httpError(402, `Can't start: ${blocked}`);
      if (!inst.proc && !inst.cfg.isDemo) inst.logActivity('start', who(req), 'started the server');
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
      if (!inst.cfg.isDemo) inst.logActivity('start', who(req), 'restarted the server');
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
  '.woff2': 'font/woff2',
};

// Clean URLs: the website pages, and the dashboard (also at /app for older links).
const PAGES = {
  '/dashboard': 'dashboard.html',
  '/app': 'dashboard.html',
  '/admin': 'dashboard.html',
  '/staff-docs': 'help.html', // the guides themselves come from /api/staff/docs (staff only)
  '/features': 'features.html',
  '/servers': 'servers.html',
  '/why': 'why.html',
  '/dmca': 'dmca.html',
  '/donate': 'donate.html',
  '/team': 'team.html',
  '/copyright': 'dmca.html',
  '/pricing': 'pricing.html',
  '/support': 'support.html',
  '/about': 'about.html',
  '/terms': 'terms.html',
  '/privacy': 'privacy.html',
};

const seo = require('./seo');
const seoSite = () => ({ company: env('COMPANY', 'Tree Host'), supportEmail: EMAILS.support, discord: env('DISCORD_INVITE', '') });

async function serveStatic(req, res, pathname) {
  pathname = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  // Search engines and AI assistants (the public website only)
  if (HOSTED && ['/robots.txt', '/sitemap.xml', '/llms.txt'].includes(pathname)) {
    const body =
      pathname === '/robots.txt' ? seo.robotsTxt(PUBLIC_URL)
        : pathname === '/sitemap.xml' ? seo.sitemapXml(PUBLIC_URL)
          : seo.llmsTxt(PUBLIC_URL, { site: seoSite(), plans: billing.publicPlans() });
    res.writeHead(200, { 'Content-Type': pathname.endsWith('.xml') ? 'application/xml; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
    res.end(body);
    return;
  }
  // The homepage is the website; without hosting (local use) it is the dashboard.
  let rel = PAGES[pathname] || (pathname === '/' ? (HOSTED ? 'index.html' : 'dashboard.html') : decodeURIComponent(pathname.slice(1)));
  // Clean URLs for every page: /why serves why.html even without a PAGES entry.
  if (!path.extname(rel) && /^[a-z0-9-]+$/.test(rel) && (await require('./util').exists(path.join(PUBLIC, `${rel}.html`)))) rel += '.html';
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    let data = await fsp.readFile(file);
    // Public pages get their search and link-preview tags; the dashboard is kept out of search results.
    const seoPage = HOSTED && file.endsWith('.html') ? seo.pageFor(pathname === '' ? '/' : pathname) : null;
    if (seoPage) data = Buffer.from(seo.injectSeo(data.toString('utf8'), { base: PUBLIC_URL, path: seoPage.path, site: seoSite(), plans: billing.publicPlans() }));
    const noindex = file.endsWith('dashboard.html') || file.endsWith('404.html');
    const csp = file.endsWith('.html') ? { 'Content-Security-Policy': pageCsp(data, req) } : {};
    // Public pages let the browser send origin-only referrers (cross-origin: origin only, no paths) so
    // the page-view beacon can attribute traffic; the dashboard keeps the stricter no-referrer.
    const referrerPolicy = file.endsWith('.html') && !noindex ? 'strict-origin-when-cross-origin' : 'no-referrer';
    res.writeHead(200, {
      ...(noindex ? { 'X-Robots-Tag': 'noindex' } : {}),
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': file.endsWith('.woff2') ? 'public, max-age=604800' : 'no-cache', // fonts hardly ever change
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': referrerPolicy,
      ...csp,
      ...(isHttps(req) ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
    });
    // One page view per successful HTML response. Fire-and-forget: a broken counter store
    // must never stop the page from being served.
    if (file.endsWith('.html')) {
      try { metrics.count('pageview', { path: pathname, host: req.headers.host }); } catch {}
    }
    res.end(data);
  } catch {
    // Pages get the friendly 404 page; missing files (images, scripts) a plain 404.
    const page = !path.extname(file) || file.endsWith('.html');
    const body = page ? await fsp.readFile(path.join(PUBLIC, '404.html')).catch(() => null) : null;
    if (body) res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }).end(body);
    else res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

/**
 * Content Security Policy for a page: scripts only from Tree Host itself (plus Google's Firebase sign-in SDK when
 * sign-in uses Firebase), and the page's own inline scripts by their exact hash, so an injected script can't run.
 * Images may come from any https site (Modrinth plugin icons, Minecraft heads); nothing may frame the page.
 */
const cspCache = new Map(); // page body hash -> header
function pageCsp(body, req) {
  const html = body.toString('utf8');
  const fb = TEAM ? firebase.publicConfig() : null;
  const key = `${crypto.createHash('sha1').update(html).digest('hex')}|${fb ? fb.authDomain : ''}|${isHttps(req)}`;
  if (cspCache.has(key)) return cspCache.get(key);
  const hashes = [];
  for (const m of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1] || '';
    if (/\ssrc\s*=/i.test(attrs) || /type\s*=\s*["']?application\/ld\+json/i.test(attrs)) continue; // files and data blocks
    // Browsers hash the script as parsed, with CRLF line endings turned into LF (files checked out on Windows have CRLF).
    hashes.push(`'sha256-${crypto.createHash('sha256').update(m[2].replace(/\r\n?/g, '\n'), 'utf8').digest('base64')}'`);
  }
  const google = fb ? ['https://www.gstatic.com', 'https://apis.google.com'] : []; // Firebase sign-in, and Google's sign-in pop-up helper
  const header = [
    "default-src 'self'",
    `script-src 'self' ${[...google, ...hashes].join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self'",
    "media-src 'self'",
    `connect-src 'self'${fb ? ' https://*.googleapis.com https://www.gstatic.com' : ''}`,
    `frame-src ${fb ? `https://${fb.authDomain} https://accounts.google.com https://apis.google.com` : "'none'"}`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    ...(isHttps(req) ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
  if (cspCache.size > 200) cspCache.clear();
  cspCache.set(key, header);
  return header;
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
  // Behind a preview/deployment proxy the public host differs from the upstream host, so the
  // public URL's hostname is allowed too (TREEHOST_PUBLIC_URL). The proxy forwards its own Host
  // header, so a direct attack can't forge this — it must actually be our configured public host.
  const origin = req.headers.origin;
  const originHost = origin && origin.replace(/^https?:\/\//, '');
  const publicHost = PUBLIC_URL ? new URL(PUBLIC_URL).host : '';
  if (req.method !== 'GET' && origin && originHost !== host && originHost !== publicHost) {
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

// ---------- live support chat (src/support-chat.js) ----------
// Customers chat from the bubble in the dashboard; staff with support.chat answer in Staff Console → Support chat.
// Every change goes out instantly over /api/events as a "chat" event to the customer and to every agent online.

const supportChat = new SupportChat();
const canAnswer = (u) => TEAM && rbac.can(u, 'support.chat');
const chatEmailed = new Map(); // chat id -> when we last emailed the customer about a reply

/** Sends one live event to the people it concerns (signed-in users whose id matches, or who can answer chats). */
function chatEvent(c, data, { toCustomer = true, toAgents = true } = {}) {
  const msg = `event: chat\ndata: ${JSON.stringify({ chatId: c.id, userId: c.userId, ...data })}\n\n`;
  for (const [res, user] of clients) {
    if (!user) continue;
    if ((toCustomer && user.id === c.userId) || (toAgents && canAnswer(user))) res.write(msg);
  }
}
const agentsOnline = () => {
  const ids = new Set();
  for (const user of clients.values()) if (user && canAnswer(user)) ids.add(user.id);
  return ids.size;
};
const customerOnline = (userId) => [...clients.values()].some((u) => u && u.id === userId);

/** A conversation the signed-in person may see: their own, or any if they answer chats. */
function chatFor(req, chatId) {
  const c = supportChat.get(chatId);
  if (c.userId !== req.user.id && !canAnswer(req.user)) throw httpError(404, 'That conversation no longer exists.');
  return c;
}
const sideOf = (req, c) => (c.userId === req.user.id ? 'customer' : 'staff');

/** Staff replied while the customer is away: one email (at most every 15 minutes per chat) so they come back. */
async function emailReply(req, c, m) {
  const u = auth.userById(c.userId);
  if (!u || !u.email || !mail.enabled() || customerOnline(u.id)) return;
  if (Date.now() - (chatEmailed.get(c.id) || 0) < 15 * 60000) return;
  chatEmailed.set(c.id, Date.now());
  const base = auth.settings.baseUrl || publicOrigin(req);
  await mail.send(u.email, 'Tree Host support replied to your chat', [
    `Hi ${u.username},`,
    `${m.name} from Tree Host support replied to "${c.subject}":`,
    `"${m.text.length > 400 ? `${m.text.slice(0, 400)}…` : m.text}"`,
  ], { text: 'Open the chat', url: `${base}/dashboard?chat=${c.id}` }).catch((e) => console.error(`[chat] reply email failed: ${e.message}`));
}

// Customers (and anyone with an account) ---------------------------------------------------------

route('GET', '/api/support/chats', (req) => {
  if (!TEAM) throw httpError(400, 'Support chat needs accounts.');
  return { agentsOnline: agentsOnline(), chats: supportChat.forUser(req.user.id).map((c) => supportChat.summary(c, 'customer')) };
});

route('POST', '/api/support/chats', async (req) => {
  if (!TEAM) throw httpError(400, 'Support chat needs accounts.');
  const b = await readJson(req);
  const serverId = b.serverId && manager.instances.get(b.serverId) && canView(req.user, manager.instances.get(b.serverId)) ? b.serverId : null;
  const c = await supportChat.create(req.user, { text: b.text, subject: b.subject, serverId });
  chatEvent(c, { type: 'new', chat: supportChat.summary(c, 'staff') }, { toCustomer: false });
  activity.log('people', req.user.username, `started a support chat: "${c.subject}"`);
  staffNotices.add({ section: 'chat', perm: 'support.chat', title: 'New support chat', who: req.user.username, text: `${req.user.username}: "${c.subject}"`, link: `chat/${c.id}`, urgent: true });
  return supportChat.full(c, 'customer');
});

route('GET', '/api/support/chats/:id', (req, res, p) => {
  const c = chatFor(req, p.id);
  return { ...supportChat.full(c, sideOf(req, c)), agentsOnline: agentsOnline() };
});

route('POST', '/api/support/chats/:id/messages', async (req, res, p) => {
  const c = chatFor(req, p.id);
  const side = sideOf(req, c);
  if (c.status === 'closed' && side === 'customer') throw httpError(400, 'This chat is closed. Start a new one if you need more help.');
  const staff = side === 'staff' ? { roleLabel: rbac.role(req.user.role).label } : null;
  const wasUnassigned = !c.assignedTo;
  const m = await supportChat.post(c, req.user, (await readJson(req)).text, staff);
  chatEvent(c, { type: 'message', message: m, chat: supportChat.summary(c, 'staff') });
  if (staff) {
    if (wasUnassigned) audit(req, `answered the support chat of ${c.username}`);
    emailReply(req, c, m);
  }
  return m;
});

route('POST', '/api/support/chats/:id/read', async (req, res, p) => {
  const c = chatFor(req, p.id);
  const side = sideOf(req, c);
  await supportChat.read(c, side);
  chatEvent(c, { type: 'read', side, at: Date.now() });
  return { ok: true };
});

/** "is typing…" (not stored). */
route('POST', '/api/support/chats/:id/typing', (req, res, p) => {
  const c = chatFor(req, p.id);
  const side = sideOf(req, c);
  chatEvent(c, { type: 'typing', side, name: req.user.username }, { toCustomer: side === 'staff', toAgents: true });
  return { ok: true };
});

route('POST', '/api/support/chats/:id/close', async (req, res, p) => {
  const c = chatFor(req, p.id);
  const m = await supportChat.close(c, sideOf(req, c) === 'staff' ? `${req.user.username} (Tree Host support)` : req.user.username);
  if (m) chatEvent(c, { type: 'message', message: m, chat: supportChat.summary(c, 'staff') });
  return supportChat.full(c, sideOf(req, c));
});

// Staff ------------------------------------------------------------------------------------------

route('GET', '/api/admin/support/chats', (req, res, p, q) => {
  const status = q.get('status') || 'active';
  const list = supportChat.chats
    .filter((c) => (status === 'all' ? true : status === 'closed' ? c.status === 'closed' : c.status !== 'closed'))
    .sort((a, b) => (b.status === 'open') - (a.status === 'open') || b.updatedAt - a.updatedAt) // waiting for an answer first
    .slice(0, 200)
    .map((c) => supportChat.summary(c, 'staff'));
  return { agentsOnline: agentsOnline(), chats: list };
}, { perm: 'support.chat' });

/** Who the customer is, next to the conversation: plans, servers, email. */
route('GET', '/api/admin/support/chats/:id/customer', (req, res, p) => {
  const c = supportChat.get(p.id);
  const u = auth.userById(c.userId);
  if (!u) return { deleted: true, username: c.username };
  const servers = [...manager.instances.values()].filter((i) => i.cfg.owner === u.id).map((i) => ({ id: i.cfg.id, name: i.cfg.name, type: i.provider.label, version: i.cfg.version, running: !!i.proc || !!(i.demo && i.demo.alive) }));
  return {
    id: u.id,
    username: u.username,
    email: can(req.user, 'users.view') ? u.email || '' : '',
    role: u.role,
    roleLabel: rbac.role(u.role).label,
    mcName: u.mcName || '',
    createdAt: u.createdAt || null,
    restriction: u.restriction ? u.restriction.type : null,
    plans: billing.forUser(u.id).filter((s) => billing.usable(s)).map((s) => s.planName),
    servers,
    otherChats: supportChat.forUser(u.id).filter((x) => x.id !== c.id).length,
  };
}, { perm: 'support.chat' });

route('POST', '/api/admin/support/chats/:id/claim', async (req, res, p) => {
  const c = supportChat.get(p.id);
  const m = await supportChat.claim(c, req.user);
  if (m) chatEvent(c, { type: 'message', message: m, chat: supportChat.summary(c, 'staff') });
  return supportChat.full(c, 'staff');
}, { perm: 'support.chat' });

route('POST', '/api/admin/support/chats/:id/reopen', async (req, res, p) => {
  const c = supportChat.get(p.id);
  const m = await supportChat.reopen(c, `${req.user.username} (Tree Host support)`);
  if (m) chatEvent(c, { type: 'message', message: m, chat: supportChat.summary(c, 'staff') });
  return supportChat.full(c, 'staff');
}, { perm: 'support.chat' });

async function main() {
  console.log('  Starting Tree Host...');
  if (TEAM) {
    await migrateTeamData();
    await auth.init();
    await rbac.init();
    // Local test sites (http://localhost...) make the first account the admin; real sites use TREEHOST_ADMIN_EMAILS.
    auth.signupCode = env('SIGNUP_CODE', '');
    auth.allowFirstAdmin = !auth.adminEmails.size && (!HOSTED || /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(PUBLIC_URL + '/'));
    await billing.init();
    await moderation.init();
    await supportChat.load();
    setInterval(() => expireActions().catch((e) => console.error(`Moderation check failed: ${e.message}`)), 60 * 1000);
    setInterval(() => billing.tick().catch((e) => console.error(`Billing check failed: ${e.message}`)), 5 * 60 * 1000);
    manager.defaultOwner = () => (auth.firstAdmin() || {}).id || null;
  }
  await activity.init();
  await metrics.init();
  if (TEAM) await staffNotices.init();
  await manager.init();
  // playit.gg addresses for every server (the tester site on a PC without port forwarding: tools/Start-Testers.ps1).
  if (TEST_SITE) {
    testSite = new TestSite({
      manager,
      dataDir: DATA,
      hours: env('RESET_HOURS', '48'),
      // Kept: staff servers, team servers and demos. Everything testers made goes.
      keep: (inst) => !!inst.cfg.isDemo || inst.cfg.space !== 'customer' || (() => {
        const u = inst.cfg.owner && auth.userById(inst.cfg.owner);
        return !!(u && rbac.isStaff(u));
      })(),
      onRemoved: (inst) => billing.detachServer(inst.cfg.id),
    });
    testSite.start();
    manager.on('status', (inst) => {
      if (inst.status === 'running' && inst._announcedRun !== inst.startedAt) {
        inst._announcedRun = inst.startedAt;
        if (inst.isCustomer) testSite.event('started', { user: manager.ownerName(inst.cfg.owner) || '', server: inst.cfg.name });
      }
    });
    const left = Math.round((testSite.info().nextResetAt - Date.now()) / 3600000);
    console.log(`  Test site: testers' servers are deleted every ${testSite.hours} hours (next reset in about ${left} h).`);
  }
  if (env('PLAYIT_SECRET_PATH', '')) {
    try {
      // Behind a proxy, players come in through the proxy; demo servers are for the tour.
      playit = new Playit(env('PLAYIT_SECRET_PATH', ''), { skip: (inst) => !!inst.cfg.isDemo || !!proxyOf(inst) });
      const sync = () => playit.reconcile(manager).catch((e) => console.error(`[playit] ${e.message}`));
      sync();
      setInterval(sync, 5 * 60 * 1000);
      console.log('  Addresses: every server gets a free playit.gg address.');
    } catch (e) {
      console.error(`  playit is not set up: ${e.message}`);
    }
  }
  for (const inst of manager.instances.values()) if (inst.cfg.sleeping && !inst.proc) startWaker(inst).catch(() => {});
  // The demo server is set up again on every start (fresh settings, and demos made by older versions get tidied).
  for (const inst of manager.instances.values()) if (inst.cfg.isDemo) setUpDemoServer(inst).catch((e) => console.error(`[demo server] ${e.message}`));
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
