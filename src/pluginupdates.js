'use strict';
// Plugin and mod updates, and the upgrade assistant. Modrinth identifies installed jars by their hash (even ones
// uploaded by hand), so no install records are needed:
//   - check(inst)              which plugins have a newer version for this server's type and Minecraft version
//   - update(inst, files)      downloads the new jars and keeps the old ones aside; if the server then crashes before it
//                              finishes starting, rollback() puts the old jars back (server.js calls it on a crash)
//   - upgradeReport(inst, ver) before switching Minecraft versions: which plugins have a build for the new version
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { download } = require('./util');

const API = 'https://api.modrinth.com/v2';
const UA = 'TreeHost/1.0 (Minecraft server hosting)';
const KEEP_DIR = '.treehost-plugin-rollback'; // in the server folder, outside plugins/ so the old jars don't load

async function post(url, body) {
  const res = await fetch(`${API}${url}`, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw Object.assign(new Error(`Modrinth answered ${res.status}`), { status: 502 });
  return res.json();
}
async function get(url) {
  const res = await fetch(`${API}${url}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw Object.assign(new Error(`Modrinth answered ${res.status}`), { status: 502 });
  return res.json();
}

const sha1 = async (file) => crypto.createHash('sha1').update(await fsp.readFile(file)).digest('hex');

function loadersFor(inst) {
  const type = inst.cfg.type;
  if (type === 'folia') return ['folia'];
  if (type === 'purpur') return ['purpur', 'paper', 'spigot', 'bukkit'];
  if (type === 'paper' || type === 'custom') return ['paper', 'spigot', 'bukkit'];
  if (type === 'spigot' || type === 'craftbukkit') return ['spigot', 'bukkit'];
  if (inst.provider.family === 'velocity') return ['velocity'];
  if (inst.provider.family === 'bungee') return ['bungeecord', 'waterfall'];
  if (inst.provider.family === 'fabric') return ['fabric'];
  return [];
}
const gameVersion = (inst, version = inst.cfg.version) => (inst.kind === 'proxy' ? null : String(version).split('-')[0]);

/** The installed jars (enabled and disabled) with their hashes. Tree Host's own staff plugin and managed plugins are left out. */
async function installed(inst) {
  const out = [];
  let names = [];
  try {
    names = await fsp.readdir(inst.pluginDir);
  } catch {
    return out;
  }
  for (const file of names) {
    if (!/\.jar(\.disabled)?$/i.test(file)) continue;
    const full = path.join(inst.pluginDir, file);
    const st = await fsp.lstat(full).catch(() => null);
    if (!st || !st.isFile() || inst.isProtectedPath(full)) continue;
    out.push({ file, full, hash: await sha1(full) });
  }
  return out;
}

async function titles(projectIds) {
  if (!projectIds.length) return {};
  const list = await get(`/projects?ids=${encodeURIComponent(JSON.stringify(projectIds))}`).catch(() => []);
  return Object.fromEntries(list.map((p) => [p.id, { title: p.title, icon: p.icon_url || null, slug: p.slug }]));
}

/** For a target Minecraft version (or the current one): each plugin's current and newest fitting version. */
async function lookup(inst, version) {
  const loaders = loadersFor(inst);
  if (!loaders.length) return { jars: [], current: {}, newest: {}, info: {} };
  const jars = await installed(inst);
  const hashes = jars.map((j) => j.hash);
  if (!hashes.length) return { jars, current: {}, newest: {}, info: {} };
  const gv = gameVersion(inst, version);
  const [current, newest] = await Promise.all([
    post('/version_files', { hashes, algorithm: 'sha1' }),
    post('/version_files/update', { hashes, algorithm: 'sha1', loaders, ...(gv ? { game_versions: [gv] } : {}) }),
  ]);
  const ids = [...new Set(Object.values(current).map((v) => v.project_id))];
  return { jars, current, newest, info: await titles(ids) };
}

const fileOf = (v) => (v && (v.files.find((f) => f.primary) || v.files[0])) || null;

/** Which installed plugins have updates for this server as it is now. */
async function check(inst) {
  const { jars, current, newest, info } = await lookup(inst);
  return jars.map((j) => {
    const cur = current[j.hash];
    const next = newest[j.hash];
    const p = cur ? info[cur.project_id] || {} : {};
    return {
      file: j.file,
      onModrinth: !!cur,
      title: p.title || j.file.replace(/\.jar(\.disabled)?$/i, ''),
      icon: p.icon || null,
      url: p.slug ? `https://modrinth.com/project/${p.slug}` : null,
      current: cur ? cur.version_number : null,
      latest: next ? next.version_number : null,
      update: !!(cur && next && next.id !== cur.id && fileOf(next)),
    };
  }).sort((a, b) => (b.update - a.update) || a.title.localeCompare(b.title));
}

/** Updates the given jars (or all with updates). The old jars are kept aside until the server starts fine. */
async function update(inst, files, by) {
  const { jars, current, newest } = await lookup(inst);
  const wanted = files && files.length ? new Set(files) : null;
  const keep = path.join(inst.dir, KEEP_DIR);
  await fsp.mkdir(keep, { recursive: true });
  const done = [];
  for (const j of jars) {
    if (wanted && !wanted.has(j.file)) continue;
    const cur = current[j.hash];
    const next = newest[j.hash];
    const f = fileOf(next);
    if (!cur || !next || next.id === cur.id || !f) continue;
    const name = path.basename(f.filename);
    if (!/\.jar$/i.test(name)) continue;
    const disabled = /\.disabled$/i.test(j.file);
    const target = path.join(inst.pluginDir, disabled ? `${name}.disabled` : name);
    const tmp = path.join(inst.dir, `.update-${crypto.randomBytes(6).toString('hex')}.jar`);
    await download(f.url, tmp, f.hashes && f.hashes.sha1 ? { checksum: { algo: 'sha1', value: f.hashes.sha1 } } : {});
    await fsp.rename(j.full, path.join(keep, j.file));
    await fsp.rename(tmp, target);
    done.push({ oldFile: j.file, newFile: path.basename(target), from: cur.version_number, to: next.version_number });
  }
  if (done.length) {
    // Watch the next start: a crash before it finishes starting puts the old jars back.
    const prev = (inst.cfg.pluginUpdate && inst.cfg.pluginUpdate.items) || [];
    inst.cfg.pluginUpdate = { at: Date.now(), by, items: [...prev, ...done] };
    inst.save();
  }
  return done;
}

/** Puts the old jars back (after a crash, or by hand). Synchronous, so it finishes before an automatic restart. */
function rollback(inst) {
  const pending = inst.cfg.pluginUpdate;
  if (!pending || !pending.items.length) return [];
  const keep = path.join(inst.dir, KEEP_DIR);
  const back = [];
  for (const it of pending.items) {
    const oldPath = path.join(keep, it.oldFile);
    if (!fs.existsSync(oldPath)) continue;
    fs.rmSync(path.join(inst.pluginDir, it.newFile), { force: true });
    fs.renameSync(oldPath, path.join(inst.pluginDir, it.oldFile));
    back.push(it);
  }
  delete inst.cfg.pluginUpdate;
  inst.save();
  return back;
}

/** The server started fine after an update: the old jars aren't needed any more. */
function confirm(inst) {
  if (!inst.cfg.pluginUpdate) return;
  delete inst.cfg.pluginUpdate;
  inst.save();
  fsp.rm(path.join(inst.dir, KEEP_DIR), { recursive: true, force: true }).catch(() => {});
}

/** Before switching to another Minecraft version: which plugins have a build for it, which don't, which we can't tell. */
async function upgradeReport(inst, version) {
  if (!version) throw Object.assign(new Error('Pick a version'), { status: 400 });
  const { jars, current, newest, info } = await lookup(inst, version);
  const items = jars.map((j) => {
    const cur = current[j.hash];
    const next = newest[j.hash];
    const p = cur ? info[cur.project_id] || {} : {};
    const title = p.title || j.file.replace(/\.jar(\.disabled)?$/i, '');
    if (!cur) return { file: j.file, title, status: 'unknown', note: "Not on Modrinth, so it can't be checked. Check its own page for which versions it supports." };
    if (!next) return { file: j.file, title, status: 'missing', note: `No version for Minecraft ${version} yet. It may stop the server from starting: remove or disable it before switching.` };
    return { file: j.file, title, status: 'ok', note: next.id === cur.id ? 'This version already works there.' : `Version ${next.version_number} works there (you have ${cur.version_number}).`, update: next.id !== cur.id };
  });
  return {
    version,
    items,
    ok: items.filter((i) => i.status === 'ok').length,
    missing: items.filter((i) => i.status === 'missing').length,
    unknown: items.filter((i) => i.status === 'unknown').length,
  };
}

module.exports = { check, update, rollback, confirm, upgradeReport, KEEP_DIR };
