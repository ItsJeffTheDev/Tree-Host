'use strict';
// World + plugin backups for a server: plain folder copies under data/backups/<server id>/<backup id>/.
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { DATA } = require('./paths');

const ROOT = path.join(DATA, 'backups');
const KEEP_AUTOMATIC = 7; // automatic backups kept per server (manual ones are kept until deleted)

async function dirSize(p) {
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(p, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(p, e.name);
    if (e.isDirectory()) total += await dirSize(full);
    else if (e.isFile()) total += (await fsp.lstat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

/**
 * Copies a folder. Files a running server keeps locked (session.lock, some plugin databases) can't be read on
 * Windows; they are skipped and listed instead of failing the whole backup.
 */
async function copyDir(src, dest, skipped, rel = '') {
  await fsp.mkdir(dest, { recursive: true });
  for (const e of await fsp.readdir(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isSymbolicLink()) continue; // never follow links out of the server folder
    if (e.isDirectory()) await copyDir(from, to, skipped, path.join(rel, e.name));
    else if (!e.isFile() || e.name === 'session.lock') continue;
    else {
      try {
        await fsp.copyFile(from, to);
      } catch (err) {
        if (!['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) throw err;
        skipped.push(path.join(rel, e.name));
      }
    }
  }
}

/** Folders a backup contains: the world folders plus the plugins/mods folder (plugin configs and data). */
async function backupFolders(inst) {
  const level = (await inst.getProperties())['level-name'] || 'world';
  const names = inst.kind === 'proxy' ? ['plugins'] : [level, `${level}_nether`, `${level}_the_end`, inst.pluginDirName];
  const out = [];
  for (const n of names) {
    const st = await fsp.lstat(path.join(inst.dir, n)).catch(() => null);
    if (st && st.isDirectory()) out.push(n);
  }
  return out;
}

async function list(inst) {
  const dir = path.join(ROOT, inst.cfg.id);
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const id of entries) {
    try {
      out.push(JSON.parse(await fsp.readFile(path.join(dir, id, 'backup.json'), 'utf8')));
    } catch {
      /* incomplete backup: ignore */
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** Makes a backup. While the server runs, it saves and pauses world writes so the copy is consistent. */
async function create(inst, { label = '', by = 'Tree Host', automatic = false, maxManual = 0 } = {}) {
  if (maxManual && !automatic && (await list(inst)).filter((b) => !b.automatic).length >= maxManual) {
    throw Object.assign(new Error(`You can keep up to ${maxManual} backups on this plan. Delete an old one first.`), { status: 400 });
  }
  if (inst.backingUp) throw Object.assign(new Error('A backup of this server is already running.'), { status: 400 });
  inst.backingUp = true;
  const running = inst.proc && inst.status === 'running' && inst.kind !== 'proxy';
  try {
    const folders = await backupFolders(inst);
    if (!folders.length) throw Object.assign(new Error('Nothing to back up yet: start the server once to create its world.'), { status: 400 });
    if (running) {
      inst.write('save-off');
      inst.write('save-all flush');
      await new Promise((r) => setTimeout(r, 4000));
    }
    const id = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${crypto.randomBytes(2).toString('hex')}`;
    const dest = path.join(ROOT, inst.cfg.id, id);
    await fsp.mkdir(dest, { recursive: true });
    const skipped = [];
    for (const f of folders) await copyDir(path.join(inst.dir, f), path.join(dest, f), skipped, f);
    const meta = {
      id,
      createdAt: Date.now(),
      label: String(label || '').slice(0, 80) || (automatic ? 'Automatic backup' : 'Backup'),
      by,
      automatic,
      folders,
      size: await dirSize(dest),
      version: `${inst.provider.label} ${inst.cfg.version}`,
      skipped,
    };
    await fsp.writeFile(path.join(dest, 'backup.json'), JSON.stringify(meta, null, 2));
    if (automatic) await prune(inst);
    return meta;
  } finally {
    if (running && inst.proc) inst.write('save-on');
    inst.backingUp = false;
  }
}

async function prune(inst) {
  const autos = (await list(inst)).filter((b) => b.automatic);
  // Customer servers keep fewer automatic backups (they take disk space on the host).
  for (const b of autos.slice(inst.isCustomer ? 3 : KEEP_AUTOMATIC)) await remove(inst, b.id);
}

function backupDir(inst, id) {
  if (!/^[\w-]+$/.test(id)) throw Object.assign(new Error('Backup not found'), { status: 404 });
  return path.join(ROOT, inst.cfg.id, id);
}

/** Puts a backup back: replaces the world folders and plugins folder with the backup's copies. */
async function restore(inst, id) {
  if (inst.proc || inst.status !== 'stopped') throw Object.assign(new Error('Stop the server before restoring a backup.'), { status: 400 });
  const src = backupDir(inst, id);
  const meta = JSON.parse(await fsp.readFile(path.join(src, 'backup.json'), 'utf8').catch(() => 'null'));
  if (!meta) throw Object.assign(new Error('Backup not found'), { status: 404 });
  for (const f of meta.folders) {
    await fsp.rm(path.join(inst.dir, f), { recursive: true, force: true });
    await fsp.cp(path.join(src, f), path.join(inst.dir, f), { recursive: true, force: true });
  }
  return meta;
}

async function remove(inst, id) {
  await fsp.rm(backupDir(inst, id), { recursive: true, force: true });
}

async function removeAll(serverId) {
  await fsp.rm(path.join(ROOT, serverId), { recursive: true, force: true }).catch(() => {});
}

/** A path inside a backup, checked so it can't leave the backup (or the server folder it's restored into). */
function insidePath(root, rel) {
  const clean = path.normalize(String(rel || '').replace(/\\/g, '/')).replace(/^([/\\])+/, '');
  if (clean.split(/[/\\]/).includes('..')) throw Object.assign(new Error('That path is not allowed.'), { status: 400 });
  const full = path.resolve(root, clean === '.' ? '' : clean);
  if (full !== root && !full.startsWith(root + path.sep)) throw Object.assign(new Error('That path is not allowed.'), { status: 400 });
  return { clean: clean === '.' ? '' : clean, full };
}

/** The files and folders at one level of a backup (for browsing it). */
async function listFiles(inst, id, rel = '') {
  const root = path.resolve(backupDir(inst, id));
  const { clean, full } = insidePath(root, rel);
  const st = await fsp.lstat(full).catch(() => null);
  if (!st || !st.isDirectory()) throw Object.assign(new Error('Folder not found in this backup.'), { status: 404 });
  const out = [];
  for (const e of await fsp.readdir(full, { withFileTypes: true })) {
    if (e.isSymbolicLink() || (!clean && e.name === 'backup.json')) continue;
    const s = e.isFile() ? await fsp.stat(path.join(full, e.name)).catch(() => null) : null;
    out.push({ name: e.name, dir: e.isDirectory(), size: s ? s.size : null });
  }
  return { path: clean.replace(/\\/g, '/'), entries: out.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name)) };
}

/** Restores one file or folder from a backup to the same place in the server folder. World files need the server stopped. */
async function restoreFile(inst, id, rel) {
  const root = path.resolve(backupDir(inst, id));
  const meta = JSON.parse(await fsp.readFile(path.join(root, 'backup.json'), 'utf8').catch(() => 'null'));
  if (!meta) throw Object.assign(new Error('Backup not found'), { status: 404 });
  const { clean, full } = insidePath(root, rel);
  if (!clean || clean === 'backup.json') throw Object.assign(new Error('Pick a file or folder to restore.'), { status: 400 });
  const st = await fsp.lstat(full).catch(() => null);
  if (!st || st.isSymbolicLink()) throw Object.assign(new Error('That file is not in this backup.'), { status: 404 });
  const top = clean.split(/[/\\]/)[0];
  const inWorld = top !== inst.pluginDirName;
  if (inWorld && (inst.proc || inst.status !== 'stopped')) throw Object.assign(new Error('Stop the server first: world files can only be restored while it is stopped.'), { status: 400 });
  const dest = insidePath(path.resolve(inst.dir), clean).full;
  // Never write through a link left inside the server folder
  const realDir = await fsp.realpath(path.dirname(dest)).catch(() => null);
  const realRoot = await fsp.realpath(inst.dir);
  if (realDir && realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) throw Object.assign(new Error('That path is not allowed.'), { status: 400 });
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.cp(full, dest, { recursive: true, force: true });
  return { path: clean.replace(/\\/g, '/'), folder: st.isDirectory(), backup: meta };
}

module.exports = { list, create, restore, remove, removeAll, listFiles, restoreFile };
