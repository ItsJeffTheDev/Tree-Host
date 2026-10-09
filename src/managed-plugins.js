'use strict';
// Managed plugins: jars Tree Host puts on servers by itself, listed in the Staff Console (#staff-plugin).
//  - The Tree Host staff plugin (TreeHostStaff.jar) is built in. It ships in minecraft-plugin/, and staff can upload
//    a newer build (kept in the data folder so it survives redeploys) or go back to the bundled one.
//  - Staff can add more. A locked one works like the staff plugin: it's put back if it was removed or changed, and
//    customers can't delete, turn off or replace it. An unlocked one is installed once per version: if the owner
//    deletes it, it stays deleted until a new version is uploaded (or staff push it again).
// Which servers get them: customer, demo and team servers that load plugins (Paper, Purpur, Folia, ... and the Velocity,
// Waterfall and BungeeCord proxies). A plugin goes where its jar fits (plugin.yml = Paper family, bungee.yml = BungeeCord
// and Waterfall, velocity-plugin.json = Velocity), or only to the server types picked for it. The staff plugin is Paper
// family only. Each server remembers what it got in cfg.managedPlugins.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { DATA } = require('./paths');
const { describe } = require('./providers');

const STORE = path.join(DATA, 'managed-plugins');
const META_FILE = path.join(DATA, 'managed-plugins.json');
const STAFF_OVERRIDE = path.join(STORE, 'TreeHostStaff.jar');
const BUNDLED_STAFF = path.join(__dirname, '..', 'minecraft-plugin', 'TreeHostStaff.jar');
const LEGACY = { list: path.join(DATA, 'required-plugins.json'), dir: path.join(__dirname, '..', 'required-plugins'), staff: path.join(DATA, 'staff-plugin-info.json') };

const STAFF_ID = 'treehoststaff';
const STAFF_FILE = 'TreeHostStaff.jar';
const MAX_JAR = 50 * 1024 * 1024;
const HISTORY = 10;

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const PLUGIN_FAMILIES = ['bukkit', 'velocity', 'bungee'];
const PLUGIN_TYPES = describe().filter((p) => PLUGIN_FAMILIES.includes(p.family)).map((p) => ({ id: p.id, label: p.label, family: p.family }));
const BUKKIT_TYPES = PLUGIN_TYPES.filter((t) => t.family === 'bukkit');
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f<>]/g, '').trim().slice(0, n);
const err = (status, message) => Object.assign(new Error(message), { status });

/** A safe plugin file name: letters, digits, dots, dashes, underscores, plus, ending in .jar. */
function jarName(name) {
  const base = path.basename(String(name || '')).replace(/[^A-Za-z0-9._+-]/g, '_').replace(/^\.+/, '');
  if (!base || !/\.jar$/i.test(base) || base.length > 120) throw err(400, 'The file name must end in .jar (and be under 120 characters).');
  return base;
}

class ManagedPlugins {
  /**
   * @param {object} o
   * @param o.manager    the server manager (instances, save)
   * @param o.eligible   (inst) => true for servers that get managed plugins at all
   * @param o.readMeta   (file) => plugin.yml facts of a jar (name, version, description, invalid)
   * @param o.log        (inst, text) => record that a plugin was put back on a server
   */
  constructor({ manager, eligible, readMeta, log }) {
    this.manager = manager;
    this.eligible = eligible;
    this.readMeta = readMeta;
    this.log = log || (() => {});
    this.meta = { plugins: [], staff: null };
    this.staffJar = null;
    this.staffHash = null;
    this.hashCache = new Map(); // full path -> { size, mtimeMs, hash }: the 30-second check mustn't re-hash every jar
  }

  // ---------- storage ----------

  /** Reads everything at startup (synchronously: the staff plugin has to be known before servers start). */
  load() {
    fs.mkdirSync(STORE, { recursive: true });
    try {
      this.meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    } catch {
      this.meta = { plugins: [], staff: null };
      this.migrateLegacy();
    }
    this.meta.plugins = Array.isArray(this.meta.plugins) ? this.meta.plugins : [];
    for (const file of [STAFF_OVERRIDE, BUNDLED_STAFF]) {
      try {
        this.staffJar = fs.readFileSync(file);
        this.staffSource = file === STAFF_OVERRIDE ? 'uploaded' : 'bundled';
        break;
      } catch {}
    }
    this.staffHash = this.staffJar ? sha(this.staffJar) : null;
    if (this.staffSource === 'bundled' && this.meta.staff && this.meta.staff.hash !== this.staffHash) this.meta.staff = null; // stale info for an upload that's gone
    return this;
  }

  /** The first version of this page kept its lists elsewhere (and the jars in the app folder): bring them over once. */
  migrateLegacy() {
    try {
      const old = JSON.parse(fs.readFileSync(LEGACY.staff, 'utf8'));
      if (old && old.hash) this.meta.staff = { version: old.version, notes: old.notes || '', hash: old.hash, size: old.size, uploadedAt: old.uploadedAt, uploadedBy: old.uploadedBy, history: [] };
    } catch {}
    let list = [];
    try {
      list = JSON.parse(fs.readFileSync(LEGACY.list, 'utf8'));
    } catch {}
    for (const p of Array.isArray(list) ? list : []) {
      try {
        const buf = fs.readFileSync(path.join(LEGACY.dir, path.basename(p.filename)));
        const id = crypto.randomBytes(6).toString('hex');
        fs.writeFileSync(path.join(STORE, `${id}.jar`), buf);
        this.meta.plugins.push({
          id,
          name: p.name || p.title || p.filename,
          filename: jarName(p.filename),
          version: p.version || '',
          description: p.description || '',
          notes: '',
          locked: p.locked !== false,
          autoInstall: true,
          paused: false,
          serverTypes: p.serverTypes || p.targetTypes || [],
          size: buf.length,
          hash: sha(buf),
          uploadedAt: p.uploadedAt || Date.now(),
          uploadedBy: p.uploadedBy || 'unknown',
          history: [],
        });
      } catch {}
    }
    if (this.meta.staff || this.meta.plugins.length) this.saveSync();
  }

  saveSync() {
    fs.writeFileSync(META_FILE, JSON.stringify(this.meta, null, 2), { mode: 0o600 });
  }

  async save() {
    const tmp = `${META_FILE}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(this.meta, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, META_FILE);
  }

  jarPath(p) {
    return path.join(STORE, `${p.id}.jar`);
  }

  get(id) {
    const p = this.meta.plugins.find((x) => x.id === id);
    if (!p) throw err(404, 'There is no managed plugin with that id.');
    return p;
  }

  /** Checks an uploaded jar: a real plugin, and not something else pretending to be the staff plugin. */
  async inspect(buf, { staff = false } = {}) {
    if (!buf || !buf.length) throw err(400, 'The file is empty.');
    if (buf.length > MAX_JAR) throw err(413, 'Plugins can be up to 50 MB.');
    if (buf.readUInt32LE(0) !== 0x04034b50) throw err(400, "That isn't a .jar file (it's not a zip archive).");
    const tmp = path.join(STORE, `.inspect-${crypto.randomBytes(6).toString('hex')}.jar`);
    await fsp.writeFile(tmp, buf);
    try {
      const m = await this.readMeta(tmp);
      if (m.invalid) throw err(400, "That jar couldn't be read. Is it damaged?");
      m.platforms = (m.platforms || []).filter((x) => PLUGIN_FAMILIES.includes(x));
      if (!m.platforms.length) throw err(400, 'That jar is not a server plugin: it has no plugin.yml (Paper), bungee.yml (BungeeCord/Waterfall) or velocity-plugin.json (Velocity).');
      if (staff && m.format !== 'plugin.yml') throw err(400, 'The Tree Host staff plugin is a Paper plugin (it must have a plugin.yml).');
      if (staff && m.name !== 'TreeHostStaff') throw err(400, `That's "${m.name || 'an unnamed plugin'}", not the Tree Host staff plugin (its plugin.yml must say name: TreeHostStaff).`);
      if (!staff && m.name === 'TreeHostStaff') throw err(400, 'That is the Tree Host staff plugin: upload new versions of it on its own card.');
      return m;
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => {});
    }
  }

  // ---------- changes from the Staff Console ----------

  async add(buf, o, by) {
    const m = await this.inspect(buf);
    const filename = jarName(o.filename);
    if (filename.toLowerCase() === STAFF_FILE.toLowerCase()) throw err(400, 'That file name is taken by the Tree Host staff plugin.');
    if (this.meta.plugins.some((p) => p.filename.toLowerCase() === filename.toLowerCase())) throw err(409, `Another managed plugin already uses the file name ${filename}.`);
    const hash = sha(buf);
    const p = {
      id: crypto.randomBytes(6).toString('hex'),
      name: clean(o.name || m.name || filename.replace(/\.jar$/i, ''), 60),
      filename,
      version: clean(o.version || m.version || '', 40),
      description: clean(o.description || m.description || '', 500),
      notes: clean(o.notes, 1000),
      locked: o.locked !== false,
      autoInstall: o.autoInstall !== false,
      paused: false,
      platforms: m.platforms,
      serverTypes: this.types(o.serverTypes),
      size: buf.length,
      hash,
      uploadedAt: Date.now(),
      uploadedBy: by,
      history: [],
    };
    await fsp.writeFile(this.jarPath(p), buf);
    this.meta.plugins.push(p);
    await this.save();
    this.syncAllSoon();
    return p;
  }

  /** A new build of a plugin (the staff plugin too). Its file name may change: servers get the old file swapped out. */
  async replace(id, buf, o, by) {
    const staff = id === STAFF_ID;
    const m = await this.inspect(buf, { staff });
    const hash = sha(buf);
    const version = clean(o.version || m.version || '', 40);
    const notes = clean(o.notes, 1000);
    if (staff) {
      if (hash === this.staffHash) throw err(409, 'That is the version servers already have.');
      const prev = this.meta.staff || { version: this.staffSource === 'bundled' ? 'bundled' : '', hash: this.staffHash, size: this.staffJar ? this.staffJar.length : 0 };
      await fsp.writeFile(STAFF_OVERRIDE, buf);
      this.staffJar = buf;
      this.staffHash = hash;
      this.staffSource = 'uploaded';
      this.meta.staff = { version, notes, hash, size: buf.length, uploadedAt: Date.now(), uploadedBy: by, history: this.pushHistory(prev) };
      await this.save();
      this.syncAllSoon();
      return this.staffView();
    }
    const p = this.get(id);
    if (hash === p.hash) throw err(409, 'That is the version servers already have.');
    let filename = p.filename;
    if (o.filename) {
      filename = jarName(o.filename);
      if (filename.toLowerCase() === STAFF_FILE.toLowerCase()) throw err(400, 'That file name is taken by the Tree Host staff plugin.');
      if (this.meta.plugins.some((x) => x !== p && x.filename.toLowerCase() === filename.toLowerCase())) throw err(409, `Another managed plugin already uses the file name ${filename}.`);
    }
    p.history = this.pushHistory(p);
    await fsp.writeFile(this.jarPath(p), buf);
    Object.assign(p, { filename, version, notes, hash, size: buf.length, uploadedAt: Date.now(), uploadedBy: by, platforms: m.platforms });
    await this.save();
    this.syncAllSoon();
    return p;
  }

  pushHistory(prev) {
    const entry = { version: prev.version || '', hash: prev.hash, size: prev.size, uploadedAt: prev.uploadedAt || null, uploadedBy: prev.uploadedBy || null };
    return [entry, ...((prev.history || []).filter((h) => h.hash !== prev.hash))].slice(0, HISTORY);
  }

  /** The staff plugin goes back to the one in minecraft-plugin/ (shipped with Tree Host). */
  async revertStaff() {
    let bundled;
    try {
      bundled = await fsp.readFile(BUNDLED_STAFF);
    } catch {
      throw err(409, 'There is no bundled staff plugin (minecraft-plugin/TreeHostStaff.jar) to go back to.');
    }
    if (this.staffSource !== 'uploaded') throw err(409, 'Servers already use the bundled staff plugin.');
    await fsp.rm(STAFF_OVERRIDE, { force: true });
    this.staffJar = bundled;
    this.staffHash = sha(bundled);
    this.staffSource = 'bundled';
    this.meta.staff = null;
    await this.save();
    this.syncAllSoon();
    return this.staffView();
  }

  async update(id, body) {
    const p = this.get(id);
    if (body.name !== undefined) p.name = clean(body.name, 60) || p.name;
    if (body.version !== undefined) p.version = clean(body.version, 40);
    if (body.description !== undefined) p.description = clean(body.description, 500);
    if (body.notes !== undefined) p.notes = clean(body.notes, 1000);
    if (body.locked !== undefined) p.locked = !!body.locked;
    if (body.autoInstall !== undefined) p.autoInstall = !!body.autoInstall;
    if (body.paused !== undefined) p.paused = !!body.paused;
    if (body.serverTypes !== undefined) p.serverTypes = this.types(body.serverTypes);
    await this.save();
    this.syncAllSoon();
    return p;
  }

  /** Stops managing a plugin. purge: also deletes it from every server it was put on. */
  async remove(id, { purge = false } = {}) {
    const p = this.get(id);
    let removed = 0;
    for (const inst of this.manager.instances.values()) {
      const rec = inst.cfg.managedPlugins && inst.cfg.managedPlugins[id];
      if (!rec) continue;
      if (purge) {
        for (const f of [rec.file, `${rec.file}.disabled`]) {
          try {
            await fsp.rm(path.join(inst.pluginDir, path.basename(f)));
            removed++;
          } catch {}
        }
      }
      delete inst.cfg.managedPlugins[id];
    }
    this.manager.save();
    this.meta.plugins = this.meta.plugins.filter((x) => x !== p);
    await fsp.rm(this.jarPath(p), { force: true });
    await this.save();
    return { removedFrom: removed };
  }

  types(v) {
    const list = Array.isArray(v) ? v : String(v || '').split(',');
    const ok = new Set(PLUGIN_TYPES.map((t) => t.id));
    return [...new Set(list.map((t) => String(t).trim().toLowerCase()).filter((t) => ok.has(t)))];
  }

  // ---------- which plugins go where ----------

  /** Picked types win; none picked = every server the jar is a plugin for (plugins added before proxies: Paper family). */
  appliesTo(p, inst) {
    if (p.paused || !this.eligible(inst)) return false;
    return p.serverTypes.length ? p.serverTypes.includes(inst.cfg.type) : (p.platforms || ['bukkit']).includes(inst.provider.family);
  }

  /** The staff plugin is a Paper plugin: Paper-family servers only. */
  staffApplies(inst) {
    return !!this.staffJar && this.eligible(inst) && inst.provider.family === 'bukkit';
  }

  /** Lower-case file names on this server that customers can't touch (the staff plugin is handled by the instance). */
  lockedFiles(inst) {
    return this.meta.plugins.filter((p) => p.locked && this.appliesTo(p, inst)).map((p) => p.filename.toLowerCase());
  }

  /** What Tree Host knows about a file in a server's plugin folder, for the dashboard (null if it's the owner's own). */
  infoFor(inst, file) {
    const f = String(file).toLowerCase().replace(/\.disabled$/, '');
    if (f === STAFF_FILE.toLowerCase() && this.staffApplies(inst)) return { id: STAFF_ID, builtIn: true, locked: true, name: 'Tree Host Staff' };
    const p = this.meta.plugins.find((x) => x.filename.toLowerCase() === f && this.appliesTo(x, inst));
    return p ? { id: p.id, builtIn: false, locked: p.locked, name: p.name, description: p.description } : null;
  }

  // ---------- putting them on servers ----------

  async fileHash(full) {
    const st = await fsp.stat(full).catch(() => null);
    if (!st || !st.isFile()) return null;
    const c = this.hashCache.get(full);
    if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.hash;
    const hash = sha(await fsp.readFile(full));
    this.hashCache.set(full, { size: st.size, mtimeMs: st.mtimeMs, hash });
    return hash;
  }

  /** Brings one server up to date with every custom managed plugin. force: install even where the owner removed it. */
  async syncInstance(inst, { force = false, only = null } = {}) {
    const out = { installed: 0, restored: 0, failed: 0 };
    let changed = false;
    for (const p of this.meta.plugins) {
      if (only && p.id !== only) continue;
      if (!this.appliesTo(p, inst) || (!p.autoInstall && !force)) continue;
      const recs = (inst.cfg.managedPlugins ||= {});
      const rec = recs[p.id];
      const dir = inst.pluginDir;
      const target = path.join(dir, p.filename);
      const disabled = `${target}.disabled`;
      try {
        // A new version under a new file name: the old file goes.
        if (rec && rec.file && rec.file.toLowerCase() !== p.filename.toLowerCase()) {
          for (const f of [rec.file, `${rec.file}.disabled`]) await fsp.rm(path.join(dir, path.basename(f)), { force: true }).catch(() => {});
        }
        if (p.locked) await fsp.rm(disabled, { force: true }).catch(() => {});
        const current = await this.fileHash(target);
        if (current === p.hash) {
          if (!rec || rec.hash !== p.hash || rec.file !== p.filename) {
            recs[p.id] = { hash: p.hash, file: p.filename, at: Date.now() };
            changed = true;
          }
          continue;
        }
        const ownerRemoved = rec && rec.hash === p.hash && !current; // unlocked and deleted by the owner on purpose
        if (!p.locked && !force && ownerRemoved) continue;
        if (!p.locked && !force && rec && rec.hash === p.hash && current) continue; // owner swapped in their own build
        // Owner turned an unlocked plugin off: a new version stays off.
        const dest = !p.locked && !current && fs.existsSync(disabled) ? disabled : target;
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(dest, await fsp.readFile(this.jarPath(p)));
        this.hashCache.delete(dest);
        const restored = p.locked && rec && rec.hash === p.hash;
        recs[p.id] = { hash: p.hash, file: p.filename, at: Date.now() };
        changed = true;
        if (restored) {
          out.restored++;
          this.log(inst, `The ${p.name} plugin was removed or changed, so it was put back. Tree Host requires it on this server.`, p);
        } else out.installed++;
      } catch (e) {
        if (['EBUSY', 'EPERM'].includes(e.code)) continue; // in use by the running server (Windows): swapped before the next start
        out.failed++;
        console.error(`[managed plugins] ${inst.cfg.id} ${p.filename}: ${e.message}`);
      }
    }
    if (changed) this.manager.save();
    return out;
  }

  syncAllSoon() {
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => this.syncAll().catch(() => {}), 200);
  }

  async syncAll(opts) {
    const total = { servers: 0, installed: 0, restored: 0, failed: 0 };
    for (const inst of this.manager.instances.values()) {
      if (!this.eligible(inst)) continue;
      total.servers++;
      const r = await this.syncInstance(inst, opts);
      total.installed += r.installed;
      total.restored += r.restored;
      total.failed += r.failed;
    }
    return total;
  }

  // ---------- what the console shows ----------

  /** Where a plugin stands on each server it should be on. */
  async coverage(p) {
    const staff = p === STAFF_ID;
    const rows = [];
    for (const inst of this.manager.instances.values()) {
      if (staff ? !this.staffApplies(inst) : !this.appliesTo(p, inst)) continue;
      const file = staff ? STAFF_FILE : p.filename;
      const want = staff ? this.staffHash : p.hash;
      const full = path.join(inst.pluginDir, file);
      const have = await this.fileHash(full).catch(() => null);
      const rec = !staff && inst.cfg.managedPlugins && inst.cfg.managedPlugins[p.id];
      let state;
      if (have === want) state = 'current';
      else if (have) state = 'outdated';
      else if (!staff && fs.existsSync(`${full}.disabled`)) state = 'disabled';
      else if (!staff && !p.locked && rec) state = 'removed';
      else state = 'missing';
      rows.push({ id: inst.cfg.id, name: inst.cfg.name, type: inst.cfg.type, running: !!inst.proc, space: inst.cfg.space, state });
    }
    const counts = { total: rows.length, current: 0, outdated: 0, missing: 0, disabled: 0, removed: 0 };
    for (const r of rows) counts[r.state]++;
    return { counts, servers: rows };
  }

  staffView() {
    const s = this.meta.staff || {};
    return {
      id: STAFF_ID,
      builtIn: true,
      name: 'Tree Host Staff',
      filename: STAFF_FILE,
      version: s.version || (this.staffSource === 'bundled' ? 'bundled' : ''),
      description: 'Lets official Tree Host staff join and help on customer servers (even when whitelisted or full), makes staff who may run commands operator while they are there, logs every staff command for the owner, gives staff /sc, /thvanish and /thinfo, shows the ✔ STAFF badge, and plays the owner\'s animated MOTD. Required on every Bukkit-family server.',
      notes: s.notes || '',
      locked: true,
      autoInstall: true,
      paused: false,
      platforms: ['bukkit'],
      serverTypes: [],
      size: this.staffJar ? this.staffJar.length : 0,
      hash: this.staffHash,
      uploadedAt: s.uploadedAt || null,
      uploadedBy: s.uploadedBy || null,
      source: this.staffJar ? this.staffSource : 'missing',
      canRevert: this.staffSource === 'uploaded' && fs.existsSync(BUNDLED_STAFF),
      history: s.history || [],
    };
  }

  async view(id, { servers = false } = {}) {
    const p = id === STAFF_ID ? this.staffView() : { platforms: ['bukkit'], ...this.get(id), builtIn: false };
    const cov = await this.coverage(id === STAFF_ID ? STAFF_ID : this.get(id));
    return { ...p, coverage: cov.counts, ...(servers ? { servers: cov.servers } : {}) };
  }

  async list() {
    return Promise.all([STAFF_ID, ...this.meta.plugins.map((p) => p.id)].map((id) => this.view(id)));
  }

  /** The jar itself (for staff to download and check). */
  async jar(id) {
    if (id === STAFF_ID) {
      if (!this.staffJar) throw err(404, 'The staff plugin is missing.');
      return { buf: this.staffJar, filename: STAFF_FILE };
    }
    const p = this.get(id);
    return { buf: await fsp.readFile(this.jarPath(p)), filename: p.filename };
  }
}

module.exports = { ManagedPlugins, STAFF_ID, BUKKIT_TYPES, PLUGIN_TYPES, MAX_JAR };
