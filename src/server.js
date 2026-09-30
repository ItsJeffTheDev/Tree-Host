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
const { Tunnel } = require('./tunnel');
const { Playit } = require('./playit');
const { migrateTeamData } = require('./migrate');
const { detectFunnel } = require('./funnel');
const { keepAwake } = require('./keepawake');
const providers = require('./providers');
const java = require('./java');
const { Activity } = require('./activity');
const backups = require('./backups');
const modrinth = require('./modrinth');
const { startPlayitAgent } = require('./playitagent');

// Cloud hosting (Render sets RENDER=true): always team mode, behind the host's HTTPS proxy, on the port it gives us.
const CLOUD = process.env.RENDER === 'true' || process.env.MCPT_CLOUD === '1';
const CLOUD_URL = process.env.RENDER_EXTERNAL_URL || process.env.MCPT_PUBLIC_URL || null;
// Team mode: logins required, reachable through a tunnel, deploy API for remote developers.
const TEAM = process.env.MCPT_TEAM === '1' || CLOUD;
const USE_TUNNEL = TEAM && !CLOUD && process.env.MCPT_TUNNEL === '1';
const PORT = Number(process.env.MCPT_PORT) || (CLOUD && Number(process.env.PORT)) || (TEAM ? 8766 : 8765);
// Team mode also listens on the local network (logins protect it); personal mode stays on this PC only.
const HOST = process.env.MCPT_HOST || (TEAM ? '0.0.0.0' : '127.0.0.1');
const NO_OPEN = process.argv.includes('--no-open') || CLOUD;
const LOCAL_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const SESSION_COOKIE = 'mcpt_session';
// In personal mode everyone who can reach the dashboard is the PC's owner.
const LOCAL_ADMIN = { id: 'local', username: 'you', role: 'admin', local: true };

const manager = new Manager();
const auth = new Auth();
const tunnel = new Tunnel();
const playit = new Playit();
const activity = new Activity();
manager.teamMode = TEAM;
manager.activity = activity;
// Who gets whitelisted on a server: everyone for team servers, only the owner for solo servers.
manager.accessNames = (inst) => {
  if (inst.cfg.space === 'solo') {
    const owner = auth.userById(inst.cfg.owner);
    return owner && owner.mcName ? [owner.mcName] : [];
  }
  return auth.mcNames();
};
manager.ownerName = (id) => (auth.userById(id) || {}).username || null;
manager.playit = TEAM ? playit : null;

// ---------- tiny router ----------

const routes = [];
const HANDLED = Symbol('handled');

/** opts.public: no login needed. opts.admin: admins only (in team mode). */
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

/**
 * True for requests from this PC, which is where the Cloudflare tunnel connects from.
 * In the cloud every request comes through the host's own proxy, so its forwarding headers are trusted.
 */
function fromThisPc(req) {
  if (CLOUD) return true;
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

// Forwarding headers are only trusted from the local tunnel; anyone on the network could fake them otherwise.
function clientIp(req) {
  if (fromThisPc(req)) {
    const fwd = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
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

// The public dashboard link: a permanent Tailscale Funnel link if set up, otherwise the Cloudflare quick tunnel.
let funnelUrl = null;

const publicUrl = () => CLOUD_URL || funnelUrl || tunnel.url;

function sessionCookie(req, token, maxAge = 30 * 86400) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}

function authenticate(req) {
  if (!TEAM) return LOCAL_ADMIN;
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  if (bearer) return auth.userFromApiToken(bearer[1]);
  return auth.userFromSession(getCookie(req, SESSION_COOKIE));
}

function requireAdmin(req) {
  if (TEAM && req.user.role !== 'admin') throw httpError(403, 'Only team admins can do that.');
}

/** Team servers are visible to everyone; solo servers only to their owner (and admins). */
function canView(user, inst) {
  if (!TEAM || !user) return !TEAM;
  if (inst.cfg.space !== 'solo') return true;
  return inst.cfg.owner === user.id || user.role === 'admin';
}

/**
 * What each role may do with a server it can see.
 *   Tester:    view, control (start/stop/restart)
 *   Developer: everything, except delete / reset world / change version of team servers someone else created,
 *              and anything beyond start/stop on the Gateway
 *   Admin:     everything
 */
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
  if (!TEAM || !user || user.role === 'admin') return null;
  if (user.role === 'tester' && action !== 'view' && action !== 'control') {
    return `Testers can't ${ACTION_TEXT[action] || 'do that'}. Ask an admin if you need developer access.`;
  }
  if (inst && inst.cfg.gateway && action !== 'view' && action !== 'control') return 'Only admins can change the Gateway.';
  if (inst && action === 'manage' && inst.cfg.space !== 'solo' && inst.cfg.createdBy !== user.id) {
    const who = inst.cfg.createdBy ? auth.userById(inst.cfg.createdBy) : null;
    return `Only the person who created this team server${who ? ` (${who.username})` : ''} or an admin can ${ACTION_TEXT.manage}.`;
  }
  return null;
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

/** In team mode, settings that point at files or programs on the host PC are admin-only. */
function checkHostSettings(req, body) {
  if (!TEAM || req.user.role === 'admin') return;
  if (body.java !== undefined && !/^(auto|\d+)$/.test(String(body.java))) throw httpError(403, 'Only admins can set a custom Java path.');
  if (body.customJar) throw httpError(403, 'Only admins can use a custom server jar from the host PC.');
  if (body.type === 'custom') throw httpError(403, 'Only admins can create Custom JAR servers.');
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

/** Activity about a solo server is only shown to its owner and admins; sign-ups only to admins. */
function canSeeEvent(user, e) {
  if (!TEAM) return true;
  if (!user) return false;
  if (e.kind === 'people') return user.role === 'admin';
  if (e.space === 'solo') return e.owner === user.id || user.role === 'admin';
  return true;
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
      needsSetup: TEAM && auth.users.length === 0,
      user: user ? (user.local ? user : auth.publicUser(user)) : null,
      publicUrl: publicUrl(),
      permanentLink: !!(funnelUrl || CLOUD_URL),
      cloud: CLOUD,
      allowSignup: TEAM && auth.settings.allowSignup,
      pendingCount: user && user.role === 'admin' && TEAM ? auth.pendingCount() : 0,
      lanUrls: TEAM && !CLOUD && HOST !== '127.0.0.1' && user ? lanUrls() : [],
    };
  },
  { public: true },
);

route(
  'POST',
  '/api/auth/setup',
  async (req, res) => {
    const token = await auth.setup(await readJson(req), clientIp(req));
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token) });
    return HANDLED;
  },
  { public: true },
);

route(
  'POST',
  '/api/auth/login',
  async (req, res) => {
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
    const body = await readJson(req);
    const token = await auth.acceptInvite(body, clientIp(req));
    activity.log('people', String(body.username || 'Someone'), 'joined the team with an invite link');
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token) });
    return HANDLED;
  },
  { public: true },
);

route(
  'POST',
  '/api/auth/signup',
  async (req, res) => {
    const body = await readJson(req);
    const token = await auth.signup(body, clientIp(req));
    activity.log('people', String(body.username || 'Someone'), 'asked to join the team (waiting for approval)');
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
  await auth.updateUser(req.user, await readJson(req));
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

route('GET', '/api/team/users', () => auth.users.map((u) => auth.publicUser(u)), { admin: true });
route(
  'POST',
  '/api/team/invites',
  async (req) => {
    const { role } = await readJson(req);
    const invite = await auth.createInvite(req.user, role);
    return { link: `${publicOrigin(req)}/?invite=${invite}`, expiresInDays: 7 };
  },
  { admin: true },
);
route(
  'POST',
  '/api/team/users/:uid/approve',
  async (req, res, p) => {
    const u = auth.publicUser(await auth.approve(p.uid, (await readJson(req)).role));
    activity.log('people', who(req), `approved ${u.username} as ${u.role}`);
    return u;
  },
  { admin: true },
);
route(
  'PUT',
  '/api/team/users/:uid/role',
  async (req, res, p) => {
    if (p.uid === req.user.id) throw httpError(400, 'Ask another admin to change your own role.');
    return auth.publicUser(await auth.setRole(p.uid, (await readJson(req)).role));
  },
  { admin: true },
);
route('PUT', '/api/team/settings', async (req) => auth.setSettings(await readJson(req)), { admin: true });
route('GET', '/api/team/settings', () => auth.settings, { admin: true });
route(
  'DELETE',
  '/api/team/users/:uid',
  async (req, res, p) => {
    if (p.uid === req.user.id) throw httpError(400, 'You cannot remove yourself.');
    await auth.removeUser(p.uid);
    return { ok: true };
  },
  { admin: true },
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
route('GET', '/api/team/notifications', () => activity.publicSettings(), { admin: true });
route('PUT', '/api/team/notifications', async (req) => activity.setSettings(await readJson(req)), { admin: true });
route(
  'POST',
  '/api/team/notifications/test',
  async (req) => {
    await activity.testDiscord(who(req));
    return { ok: true };
  },
  { admin: true },
);

// ---------- playit.gg (public game addresses) ----------

route('GET', '/api/playit', () => playit.status(), { admin: true });
/**
 * Creates (or finds) a playit.gg tunnel for every server that doesn't have a manual address,
 * running or not, and reports what happened for each one.
 */
async function shareAllServers() {
  const results = [];
  const gw = manager.gateway();
  // With a Gateway only it needs a tunnel; list it first.
  const list = [...manager.instances.values()].sort((a, b) => !!b.cfg.gateway - !!a.cfg.gateway);
  for (const inst of list) {
    const base = { id: inst.cfg.id, name: inst.cfg.name, port: inst.cfg.port, space: inst.cfg.space || 'team', isGateway: !!inst.cfg.gateway };
    if (gw && inst.canUseGateway) {
      results.push({ ...base, viaGateway: manager.gatewayName(inst) });
      continue;
    }
    if (inst.cfg.publicAddress) {
      results.push({ ...base, address: inst.cfg.publicAddress, manual: true });
      continue;
    }
    try {
      results.push({ ...base, address: await inst.shareOnline() });
    } catch (e) {
      inst.sysLog(`Could not get a public address from playit.gg: ${e.message}`);
      results.push({ ...base, error: e.message, needsTunnel: e.code === 'CREATE_ON_WEBSITE' });
    }
  }
  return results;
}
route(
  'POST',
  '/api/playit/detect',
  async () => ({ ...(await playit.detect()), results: await shareAllServers() }),
  { admin: true },
);
route(
  'POST',
  '/api/playit/secret',
  async (req) => ({ ...(await playit.setSecret((await readJson(req)).secret)), results: await shareAllServers() }),
  { admin: true },
);
route('POST', '/api/playit/share-all', async () => ({ results: await shareAllServers() }), { admin: true });
route(
  'DELETE',
  '/api/playit',
  async () => {
    await playit.disconnect();
    return await playit.status();
  },
  { admin: true },
);
route('POST', '/api/servers/:id/share', async (req, res, p) => ({ address: await getFor(req, p.id, 'control').shareOnline() }));

// ---------- Gateway (one address for every server) ----------

route(
  'POST',
  '/api/gateway',
  async (req) => {
    if (manager.gateway()) throw httpError(400, 'There is already a Gateway.');
    const versions = await providers.getProvider('velocity').versions();
    const pick = versions.find((v) => !v.pre && v.id.startsWith('4.')) || versions.find((v) => !v.pre) || versions[0];
    if (!pick) throw httpError(502, 'Could not find a Velocity version to install.');
    const inst = await manager.create(
      {
        type: 'velocity',
        version: pick.id,
        name: 'Gateway',
        memoryMb: 512,
        port: await manager.nextFreePort('proxy'),
        startAfterInstall: true,
        gateway: true,
      },
      { space: TEAM ? 'team' : undefined, createdBy: req.user.id },
    );
    return inst.toJSON();
  },
  { admin: true },
);
route(
  'PUT',
  '/api/gateway',
  async (req) => {
    const gw = manager.gateway();
    if (!gw) throw httpError(404, 'There is no Gateway yet.');
    const { defaultServer } = await readJson(req);
    gw.cfg.gatewayDefault = defaultServer || null;
    manager.save();
    manager.serversChanged();
    return gw.toJSON();
  },
  { admin: true },
);

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
route('GET', '/api/system', async (req) => ({
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
}));

route('GET', '/api/types', () => providers.describe());
route('GET', '/api/types/:type/versions', (req, res, p) => providers.getProvider(p.type).versions());
route('GET', '/api/types/:type/versions/:version/builds', async (req, res, p) => {
  const prov = providers.getProvider(p.type);
  return prov.hasBuilds ? prov.builds(p.version) : [];
});
route('GET', '/api/next-port', async (req, res, p, q) => ({ port: await manager.nextFreePort(q.get('kind')) }));

route('GET', '/api/servers', (req) => visibleList(req.user));
route('POST', '/api/servers', async (req) => {
  const body = await readJson(req);
  checkHostSettings(req, body);
  delete body.gateway;
  if (TEAM && req.user.role === 'tester') throw httpError(403, "Testers can't create servers.");
  const space = TEAM ? (body.space === 'solo' ? 'solo' : 'team') : undefined;
  const inst = await manager.create(body, { space, owner: space === 'solo' ? req.user.id : undefined, createdBy: req.user.id });
  inst.logActivity('server', who(req), `created ${inst.provider.label} ${inst.cfg.version} server "${inst.cfg.name}"`);
  return inst.toJSON();
});
route('GET', '/api/servers/:id', (req, res, p) => getFor(req, p.id).toJSON());
route('PATCH', '/api/servers/:id', async (req, res, p) => {
  const body = await readJson(req);
  checkHostSettings(req, body);
  const inst = getFor(req, p.id, 'settings');
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

route('POST', '/api/servers/:id/watches', async (req, res, p) => manager.addWatch(p.id, (await readJson(req)).path), { admin: true });
route(
  'PATCH',
  '/api/servers/:id/watches/:wid',
  async (req, res, p) => {
    manager.updateWatch(p.id, p.wid, await readJson(req));
    return { ok: true };
  },
  { admin: true },
);
route(
  'DELETE',
  '/api/servers/:id/watches/:wid',
  (req, res, p) => {
    manager.removeWatch(p.id, p.wid);
    return { ok: true };
  },
  { admin: true },
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

route('POST', '/api/servers/:id/launch-client', async (req, res, p) => getFor(req, p.id).launchClient(await readJson(req)), {
  admin: true,
});

// "I'm testing this": tells the team someone is using a server right now.
route('POST', '/api/servers/:id/claim', async (req, res, p) => {
  const inst = getFor(req, p.id, 'control');
  const body = await readJson(req);
  const cl = manager.claim(p.id, req.user.local ? { id: 'local', username: 'You' } : req.user, body);
  inst.logActivity('claim', who(req), `started testing${cl.note ? `: ${cl.note}` : ''}`);
  return inst.toJSON();
});
route('DELETE', '/api/servers/:id/claim', async (req, res, p) => {
  const inst = getFor(req, p.id, 'control');
  const cl = inst.activeClaim();
  if (cl && TEAM && cl.userId !== req.user.id && req.user.role !== 'admin') {
    throw httpError(403, `${cl.username} is testing on this server. Only they or an admin can end it.`);
  }
  manager.release(p.id);
  if (cl) inst.logActivity('claim', who(req), cl.userId === req.user.id ? 'finished testing' : `ended ${cl.username}'s test session`);
  return inst.toJSON();
});

// Backups
route('GET', '/api/servers/:id/backups', (req, res, p) => backups.list(getFor(req, p.id)));
route('POST', '/api/servers/:id/backups', async (req, res, p) => {
  const inst = getFor(req, p.id, 'control');
  const b = await backups.create(inst, { label: (await readJson(req)).label, by: who(req) });
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
    case 'start':
      if (!inst.proc) inst.logActivity('start', who(req), 'started the server');
      inst.crashTimes = [];
      inst.start();
      break;
    case 'stop':
      if (inst.proc) inst.logActivity('stop', who(req), 'stopped the server');
      inst.stop();
      break;
    case 'restart':
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
      requireAdmin(req);
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
};

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
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
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
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
        if (req.user.role === 'pending') throw httpError(403, 'Your account is waiting for an admin to approve it.', 'PENDING');
        if (r.opts.admin) requireAdmin(req);
      }
      const result = await r.handler(req, res, params, url.searchParams);
      if (result !== HANDLED) sendJson(res, 200, result === undefined ? { ok: true } : result);
    } catch (e) {
      if (!res.headersSent) sendJson(res, e.status || 400, { error: e.message || String(e), code: e.code });
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
    await playit.init();
    manager.defaultOwner = () => (auth.firstAdmin() || {}).id || null;
  }
  await activity.init();
  await manager.init();
  const url = `http://localhost:${PORT}`;
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`Honey Host is already running at ${url} - opening it.`);
      if (!NO_OPEN) openBrowser(url);
      setTimeout(() => process.exit(0), 500);
    } else {
      console.error(e);
      process.exit(1);
    }
  });
  server.listen(PORT, HOST, () => {
    console.log('');
    console.log(`  Honey Host by Honey Pixel Studios${TEAM ? ' - TEAM SERVER' : ' - local Minecraft test server manager'}`);
    console.log(`  Dashboard on this PC: ${url}`);
    if (CLOUD) {
      console.log(`  Running in the cloud${CLOUD_URL ? ` at ${CLOUD_URL}` : ''}.`);
      console.log('  Minecraft players can only join through playit.gg here (set PLAYIT_SECRET). See docs/cloud-hosting.');
    } else if (TEAM && HOST !== '127.0.0.1') {
      console.log('  Dashboard from other PCs on your network:');
      for (const u of lanUrls()) console.log(`    ${u}`);
    }
    console.log(`  Data folder: ${DATA}`);
    console.log('');
    if (TEAM && auth.setupCode) {
      banner(['FIRST-TIME SETUP', `Open the dashboard and enter this setup code: ${auth.setupCode}`, 'to create the first admin account.']);
      console.log('');
    }
    console.log('  Keep this window open while you use it. Press Ctrl+C to stop all servers and quit.');
    console.log('');
    if (!NO_OPEN) openBrowser(url);
    if (TEAM && !CLOUD && keepAwake()) console.log('  This PC will not go to sleep while Honey Host runs (the screen can still turn off).');
    if (USE_TUNNEL) startPublicLink();
    if (process.env.PLAYIT_SECRET) startPlayitAgent(process.env.PLAYIT_SECRET.trim()).catch((e) => console.log(`  playit agent: ${e.message}`));
  });
}

/** Uses a permanent Tailscale Funnel link when available, otherwise a Cloudflare quick tunnel. Rechecks every 5 minutes. */
async function startPublicLink() {
  tunnel.on('url', (u) => {
    if (u && !funnelUrl) {
      console.log('');
      banner([
        'Your team can open the dashboard at:',
        u,
        'This address changes each time Honey Host restarts.',
        'For a permanent free link, run Setup-Permanent-Link.bat.',
      ]);
      console.log('');
    }
  });
  const check = async () => {
    const found = await detectFunnel(PORT);
    if (found && found !== funnelUrl) {
      funnelUrl = found;
      tunnel.stop();
      console.log('');
      banner(['Your team can open the dashboard at (permanent link):', found]);
      console.log('');
    } else if (!found && funnelUrl) {
      funnelUrl = null;
      console.log('  The Tailscale Funnel link is gone; switching back to a Cloudflare link.');
      tunnel.start(PORT).catch((e) => console.error(`  Could not start the tunnel: ${e.message}`));
    }
  };
  await check();
  if (!funnelUrl) {
    console.log('  Starting the public tunnel for your team...');
    tunnel.start(PORT).catch((e) => console.error(`  Could not start the tunnel: ${e.message}`));
  }
  setInterval(() => check().catch(() => {}), 5 * 60 * 1000);
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received - stopping all servers...`);
  tunnel.stop();
  await manager.shutdownAll();
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => shutdown(sig));

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
