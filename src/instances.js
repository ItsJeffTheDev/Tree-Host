'use strict';
const MOTD = require('./motd');
const { diagnose } = require('./doctor');
const { scanJar } = require('./jarscan');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const { SERVERS, CONFIG_FILE, DATA, CACHE } = require('./paths');
const { getProvider } = require('./providers');
const { DemoSim } = require('./demo-sim');
const java = require('./java');
const os = require('os');
const backups = require('./backups');
const client = require('./client');
const docker = require('./docker');
const {
  exists,
  splitArgs,
  isPortFree,
  parseProperties,
  updateProperties,
  readZipEntries,
  stripAnsi,
  run,
} = require('./util');

const MAX_LOG_LINES = 5000;
const STOP_TIMEOUT_MS = 60000;

// ---------- Safe file access ----------
// A server (and so a customer's plugin) can create symlinks in its own folder, e.g. server.properties -> /etc/passwd.
// Tree Host itself must never follow those, or a customer could read or overwrite files outside their server.

/** Throws if `full` is outside `root` or any part of the path below `root` is a symlink. */
async function assertNoLinks(root, full) {
  const rel = path.relative(root, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw Object.assign(new Error('Path is outside the server folder'), { status: 400 });
  let cur = root;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    const st = await fsp.lstat(cur).catch(() => null);
    if (!st) return;
    if (st.isSymbolicLink()) throw Object.assign(new Error(`${path.relative(root, cur)} is a link, which Tree Host does not open for safety.`), { status: 400 });
  }
}

/** Opens a file without following links and checks (on Linux, via /proc) that it really is inside root. */
async function openInside(root, full, flags) {
  await assertNoLinks(root, full);
  const fh = await fsp.open(full, flags | (fs.constants.O_NOFOLLOW || 0), 0o644);
  if (process.platform === 'linux') {
    const real = await fsp.readlink(`/proc/self/fd/${fh.fd}`).catch(() => null);
    const realRoot = await fsp.realpath(root);
    if (!real || !(real === realRoot || real.startsWith(realRoot + path.sep))) {
      await fh.close();
      throw Object.assign(new Error('Path is outside the server folder'), { status: 400 });
    }
  }
  return fh;
}

async function readInside(root, full) {
  const fh = await openInside(root, full, fs.constants.O_RDONLY);
  try {
    return await fh.readFile();
  } finally {
    await fh.close();
  }
}

async function writeInside(root, full, data) {
  const fh = await openInside(root, full, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC);
  try {
    await fh.writeFile(data);
  } finally {
    await fh.close();
  }
}

async function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(full);
    else if (e.isFile()) total += (await fsp.lstat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

/** Deletes every symlink in a folder tree (servers have no reason to contain any). Returns how many. */
async function removeSymlinks(dir) {
  let removed = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) {
      await fsp.unlink(full).catch(() => fsp.rmdir(full).catch(() => {}));
      removed++;
    } else if (e.isDirectory()) removed += await removeSymlinks(full);
  }
  return removed;
}

// ---------- Plugin helpers ----------

function yamlField(text, key) {
  const m = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm').exec(text);
  if (!m) return null;
  return m[1].replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '') || null;
}

async function readPluginMeta(file) {
  const names = ['paper-plugin.yml', 'plugin.yml', 'bungee.yml', 'velocity-plugin.json', 'fabric.mod.json'];
  let entries;
  try {
    entries = await readZipEntries(file, names);
  } catch {
    return { invalid: true };
  }
  for (const n of ['paper-plugin.yml', 'plugin.yml', 'bungee.yml']) {
    if (entries[n]) {
      const t = entries[n].toString('utf8');
      return {
        format: n,
        name: yamlField(t, 'name'),
        version: yamlField(t, 'version'),
        apiVersion: yamlField(t, 'api-version'),
        main: yamlField(t, 'main'),
        description: yamlField(t, 'description'),
      };
    }
  }
  for (const n of ['velocity-plugin.json', 'fabric.mod.json']) {
    if (entries[n]) {
      try {
        const j = JSON.parse(entries[n].toString('utf8'));
        return { format: n, name: j.name || j.id, version: j.version, description: j.description };
      } catch {
        return { format: n };
      }
    }
  }
  return { format: null };
}

/** A watch path is either a jar, or a folder whose newest jar is used (e.g. build/libs). */
async function resolveWatchJar(p) {
  const st = await fsp.stat(p);
  if (st.isFile()) return p.toLowerCase().endsWith('.jar') ? { file: p, mtimeMs: st.mtimeMs, size: st.size } : null;
  if (!st.isDirectory()) return null;
  let best = null;
  for (const name of await fsp.readdir(p)) {
    if (!name.toLowerCase().endsWith('.jar')) continue;
    if (/-(sources|javadoc)\.jar$/i.test(name) || /^original-/i.test(name)) continue;
    const full = path.join(p, name);
    const s = await fsp.stat(full).catch(() => null);
    if (s && s.isFile() && (!best || s.mtimeMs > best.mtimeMs)) best = { file: full, mtimeMs: s.mtimeMs, size: s.size };
  }
  return best;
}

const slug = (v) =>
  String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);

/** Replaces a whole [section] of a TOML file (up to the next [section] header), or appends it. */
function replaceTomlSection(text, name, block) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `[${name}]`);
  const blockLines = block.replace(/\n+$/, '').split('\n').concat('');
  if (start < 0) return `${text.replace(/\n*$/, '\n\n')}${blockLines.join('\n')}`;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[[^\[\]]+\]\s*$/.test(lines[end])) end++;
  lines.splice(start, end - start, ...blockLines);
  return lines.join('\n');
}

/** Replaces a top-level YAML block ("key:" and everything indented under it), or appends it. */
function replaceYamlBlock(text, key, block) {
  const lines = String(text || '').split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^${key}:\\s*(#.*)?$`).test(l));
  const blockLines = block.replace(/\n+$/, '').split('\n');
  if (start < 0) return `${String(text || '').replace(/\n*$/, text ? '\n' : '')}${blockLines.join('\n')}\n`;
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === '' || /^\s/.test(lines[end]) || lines[end].trim().startsWith('#'))) end++;
  lines.splice(start, end - start, ...blockLines);
  return lines.join('\n');
}

/** Replaces "  key:" (and what's indented under it) inside a top-level parent block, adding it if missing. */
function replaceYamlChild(text, parent, key, block) {
  const lines = String(text || '').split(/\r?\n/);
  const p = lines.findIndex((l) => new RegExp(`^${parent}:\\s*(#.*)?$`).test(l));
  const blockLines = block.replace(/\n+$/, '').split('\n');
  if (p < 0) return `${String(text || '').replace(/\n*$/, text ? '\n' : '')}${parent}:\n${blockLines.join('\n')}\n`;
  let i = p + 1;
  while (i < lines.length && !(new RegExp(`^  ${key}:`).test(lines[i])) && (lines[i].trim() === '' || /^\s/.test(lines[i]))) i++;
  if (i < lines.length && new RegExp(`^  ${key}:`).test(lines[i])) {
    let end = i + 1;
    while (end < lines.length && (/^ {3,}/.test(lines[end]) || lines[end].trim() === '')) end++;
    lines.splice(i, end - i, ...blockLines);
  } else {
    lines.splice(p + 1, 0, ...blockLines);
  }
  return lines.join('\n');
}

function versionAtLeastMc(v, want) {
  const a = String(v || '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < want.length; i++) if ((a[i] || 0) !== want[i]) return (a[i] || 0) > want[i];
  return true;
}

function safeFileName(name) {
  const base = path.basename(String(name || ''));
  if (!base || base.startsWith('.') || /[<>:"|?*\x00-\x1f]/.test(base)) throw new Error('Invalid file name');
  return base;
}

// ---------- Instance ----------

class Instance extends EventEmitter {
  constructor(manager, cfg) {
    super();
    this.manager = manager;
    this.cfg = cfg;
    this.dir = path.join(SERVERS, cfg.id);
    // Servers from before icon uploads: notice an icon that is already there (e.g. uploaded in Files).
    if (cfg.iconAt === undefined) {
      try {
        cfg.iconAt = Math.round(fs.statSync(path.join(this.dir, 'server-icon.png')).mtimeMs);
      } catch {
        cfg.iconAt = null;
      }
    }
    this.status = 'stopped';
    this.progress = null;
    this.proc = null;
    this.logs = [];
    this.seq = 0;
    this.players = new Set();
    this.javaMajor = cfg.javaMajor || null;
    this.watchState = new Map();
    this.restartPending = false;
    this.startedAt = null;
    this.lastProgressEmit = 0;
    this.client = null;
    this.clientsRunning = 0;
    if (cfg.isDemo) this.demo = new DemoSim(this); // the shared demo server never runs a real process
  }

  /** Runs in a Docker container (always for customer servers on a production host). */
  get isolated() {
    return !!this.manager.docker;
  }

  get isCustomer() {
    return this.cfg.space === 'customer';
  }

  get provider() {
    return getProvider(this.cfg.type);
  }

  get kind() {
    return this.provider.kind;
  }

  get pluginDirName() {
    return this.provider.family === 'fabric' ? 'mods' : 'plugins';
  }

  get pluginDir() {
    return path.join(this.dir, this.pluginDirName);
  }

  toJSON() {
    const c = this.cfg;
    const p = this.provider;
    // A running process, or the demo server's simulated one (src/demo-sim.js).
    const live = !!this.proc || !!(this.demo && this.demo.alive);

    return {
      id: c.id,
      name: c.name,
      type: c.type,
      typeLabel: p.label,
      kind: p.kind,
      family: p.family,
      version: c.version,
      build: c.build,
      installedBuild: c.installed ? c.installed.resolvedBuild : null,
      needsInstall: this.needsInstallSync(),
      memoryMb: c.memoryMb,
      port: c.port,
      java: c.java,
      javaMajor: this.javaMajor,
      jvmArgs: c.jvmArgs,
      serverArgs: c.serverArgs,
      eula: !!c.eula,
      customJar: c.customJar || '',
      clientVersion: c.clientVersion || 'auto',
      space: c.space || 'solo',
      isGateway: !!c.gateway,
      autoStart: !!c.autoStart,
      autoRestart: !!c.autoRestart,
      autoBackup: c.autoBackup || 'off',
      notes: c.notes || '',
      claim: this.activeClaim(),
      isolated: this.isolated,
      suspended: c.suspended || null,
      moderation: c.moderation || null,
      icon: c.iconAt || null,
      motd: c.motd || null,
      modpack: c.modpack || null,
      diagnosis: this.diagnosis || null,
      bedrock: !!c.bedrock,
      sleep: c.sleep || null,
      sleeping: !!c.sleeping,
      schedules: c.schedules || [],
      timeZone: c.timeZone || null,
      members: (c.members || []).map((m) => ({ id: m.userId, username: this.manager.ownerName(m.userId) || '(deleted)', role: m.role })),
      maxPlayers: live ? this.maxPlayers || null : null,
      subscriptionId: c.subscriptionId || null,
      plan: this.manager.planInfo(this),
      diskUsedMb: this.diskUsedMb || null,
      memUsedMb: live ? this.memUsedMb || null : null,
      cpuPct: live && typeof this.cpuPct === 'number' ? this.cpuPct : null,
      crashes: (this.crashTimes || []).length,
      gatewayDefault: c.gatewayDefault || null,
      gateway: this.manager.gatewayInfo(this),
      owner: c.owner || null,
      createdBy: c.createdBy || null,
      createdByName: c.createdBy ? this.manager.ownerName(c.createdBy) : null,
      ownerName: c.owner ? this.manager.ownerName(c.owner) : null,
      // A verified custom domain (the owner's own address) replaces the address Tree Host gives the server.
      publicAddress: (c.customDomain && c.customDomain.verified && c.customDomain.host) || c.publicAddress || c.autoAddress || '',
      providedAddress: c.publicAddress || c.autoAddress || '',
      customDomain: c.customDomain ? { ...c.customDomain, records: this.manager.domainRecords ? this.manager.domainRecords(this) : [] } : null,
      listing: c.listing || null,
      manualAddress: c.publicAddress || '',
      autoAddress: c.autoAddress || '',
      onlineMode: c.onlineMode !== false,
      client: this.client,
      clientsRunning: this.clientsRunning,
      onPluginChange: c.onPluginChange,
      watches: c.watches.map((w) => ({
        id: w.id,
        path: w.path,
        enabled: w.enabled !== false,
        lastCopied: w.lastCopied || null,
        missing: !!(this.watchState.get(w.id) || {}).missing,
      })),
      pluginDir: this.pluginDirName,
      status: this.status,
      progress: this.progress,
      players: [...this.players],
      pid: this.proc ? this.proc.pid : live ? 'demo' : null,
      startedAt: this.startedAt,
      pluginUpdate: c.pluginUpdate ? { at: c.pluginUpdate.at, items: c.pluginUpdate.items } : null,
      createdAt: c.createdAt,
      isDemo: !!c.isDemo,
    };
  }

  // ----- events / logging -----

  emitStatus() {
    this.manager.emit('status', this);
    if (this.cfg.gateway) {
      for (const other of this.manager.instances.values()) if (other !== this) this.manager.emit('status', other);
    }
  }

  setStatus(s) {
    this.status = s;
    if (s !== 'installing' && s !== 'starting') this.progress = null;
    this.emitStatus();
  }

  appendLog(text) {
    const line = { s: ++this.seq, t: text, at: Date.now() };
    this.logs.push(line);
    if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
    this.manager.emit('log', this.cfg.id, line);
  }

  sysLog(msg) {
    this.appendLog(`[Tree Host] ${msg}`);
    if (this.progress) this.progress = { ...this.progress, label: msg.slice(0, 140), done: 0, total: 0 };
  }

  onProgress(done, total) {
    this.progress = { ...(this.progress || {}), done, total };
    const now = Date.now();
    if (now - this.lastProgressEmit > 250 || (total && done >= total)) {
      this.lastProgressEmit = now;
      this.emitStatus();
    }
  }

  save() {
    this.manager.save();
  }

  // ----- install -----

  needsInstallSync() {
    const i = this.cfg.installed;
    const c = this.cfg;
    return !i || i.type !== c.type || i.version !== c.version || i.build !== c.build || (c.type === 'custom' && i.customJar !== c.customJar);
  }

  async needsInstall() {
    return this.needsInstallSync() || !(await exists(path.join(this.dir, 'server.jar')));
  }

  async install({ force = false, fromStart = false } = {}) {
    if (this.proc) throw new Error('Stop the server before reinstalling.');
    if (!fromStart && this.status !== 'stopped') throw new Error(`Server is busy (${this.status}).`);
    const c = this.cfg;
    this.status = 'installing';
    this.progress = { label: 'Preparing...', done: 0, total: 0 };
    this.emitStatus();
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      await this.clearLinks();
      this.sysLog(`Installing ${this.provider.label} ${c.version || ''}${c.build && c.build !== 'latest' ? ` build ${c.build}` : ''}...`);
      const result = await this.provider.install({
        version: c.version,
        build: c.build,
        dir: this.dir,
        cfg: c,
        force,
        log: (m) => this.sysLog(m),
        progress: (d, t) => this.onProgress(d, t),
      });
      c.installed = {
        type: c.type,
        version: c.version,
        build: c.build,
        customJar: c.customJar || null,
        resolvedBuild: result.build,
        at: Date.now(),
      };
      this.javaMajor = null;
      await this.writeInitialFiles();
      await this.seedPaperclip().catch((e) => this.sysLog(`Could not pre-build the server (it will do it on first start): ${e.message}`));
      this.save();
      this.sysLog('Installation complete.');
    } catch (e) {
      this.sysLog(`Installation failed: ${e.message}`);
      throw e;
    } finally {
      if (!fromStart) this.setStatus('stopped');
    }
  }

  /**
   * Paper, Purpur and Folia build ("patch") their real server jar on first start, which can take minutes.
   * Tree Host does that once per version and build, from the official download only (never from a customer's
   * folder), keeps the result, and copies it into every new server so their first start is quick.
   */
  async seedPaperclip() {
    if (!['paper', 'purpur', 'folia'].includes(this.cfg.type) || !this.cfg.installed) return;
    if (await exists(path.join(this.dir, 'versions'))) return;
    const key = `${this.cfg.type}-${this.cfg.version}-${this.cfg.installed.resolvedBuild}`.replace(/[^\w.-]/g, '_');
    const shared = path.join(CACHE, 'paperclip', key);
    if (!(await exists(path.join(shared, 'versions')))) await this.manager.buildPaperclip(this, shared);
    for (const sub of ['cache', 'libraries', 'versions']) {
      if (await exists(path.join(shared, sub))) await fsp.cp(path.join(shared, sub), path.join(this.dir, sub), { recursive: true, force: false });
    }
  }

  async writeInitialFiles() {
    await fsp.mkdir(this.pluginDir, { recursive: true });
    if (this.kind === 'proxy') return;
    const propsFile = path.join(this.dir, 'server.properties');
    await assertNoLinks(this.dir, propsFile);
    if (!(await exists(propsFile))) {
      await writeInside(
        this.dir,
        propsFile,
        updateProperties('#Minecraft server properties (created by Tree Host)\n', {
          'server-port': this.cfg.port,
          'online-mode': this.cfg.onlineMode === false ? 'false' : 'true',
          motd: `${this.cfg.name} - hosted by Tree Host`,
          'enable-command-block': 'true',
          'spawn-protection': this.isCustomer ? '16' : '0',
          ...(this.manager.teamMode && !this.isCustomer ? { 'white-list': 'true', 'enforce-whitelist': 'true' } : {}),
        }),
      );
    }
  }

  async resolveJavaExe() {
    const c = this.cfg;
    const opts = { log: (m) => this.sysLog(m), progress: (d, t) => this.onProgress(d, t) };
    if (c.java && c.java !== 'auto') {
      if (/^\d+$/.test(c.java)) {
        this.javaMajor = Number(c.java);
        return java.resolveJava(this.javaMajor, opts);
      }
      const st = await fsp.stat(c.java).catch(() => null);
      if (!st) throw new Error(`Custom Java path not found: ${c.java}`);
      const exe = st.isDirectory() ? await java.findJavaExe(c.java) : c.java;
      if (!exe) throw new Error(`No java executable found in ${c.java}`);
      this.javaMajor = await java.probeJavaMajor(exe);
      return exe;
    }
    const major = await this.provider.java(c.version, this.dir);
    this.javaMajor = major;
    if (c.javaMajor !== major) {
      c.javaMajor = major;
      this.save();
    }
    return java.resolveJava(major, opts);
  }

  async prepareConfigFiles() {
    const port = this.cfg.port;
    if (this.kind !== 'proxy') {
      if (!this.cfg.eula) {
        throw new Error('You need to accept the Minecraft EULA first (Settings tab → EULA).');
      }
      await fsp.writeFile(
        path.join(this.dir, 'eula.txt'),
        '# Accepted via Tree Host (https://aka.ms/MinecraftEULA)\neula=true\n',
      );
      const propsFile = path.join(this.dir, 'server.properties');
      const text = (await exists(propsFile)) ? await fsp.readFile(propsFile, 'utf8') : '';
      // The owner's MOTD (classic colors here; Paper/Spigot also get hex colors and animation from the Tree Host plugin).
      const motd = this.cfg.motd && this.cfg.motd.frames && this.cfg.motd.frames[0];
      await fsp.writeFile(propsFile, updateProperties(text, { 'server-port': port, ...(motd ? { motd: MOTD.propertiesValue(MOTD.toClassic(motd)) } : {}) }));
      await this.applyGatewayBackend();
      await this.applyNetworkBackend();
      await this.applyBedrock();
      return;
    }
    // Proxies: keep the configured bind port in sync.
    const velocityToml = path.join(this.dir, 'velocity.toml');
    if (this.provider.family === 'velocity') {
      let text = null;
      if (await exists(velocityToml)) text = await fsp.readFile(velocityToml, 'utf8');
      else {
        try {
          const e = await readZipEntries(path.join(this.dir, 'server.jar'), ['default-velocity.toml']);
          if (e['default-velocity.toml']) text = e['default-velocity.toml'].toString('utf8');
        } catch {
          /* let Velocity generate its own */
        }
      }
      if (text) {
        text = text
          .replace(/^bind\s*=.*$/m, `bind = "0.0.0.0:${port}"`)
          .replace(/^online-mode\s*=.*$/m, `online-mode = ${this.cfg.gateway || this.cfg.onlineMode !== false}`);
        if (this.cfg.gateway) text = this.gatewayToml(text);
        else if (this.cfg.network) text = await this.networkToml(text);
        if (!this.cfg.gateway && this.cfg.motd && this.cfg.motd.frames[0]) {
          const mini = MOTD.toMiniMessage(this.cfg.motd.frames[0]).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          text = text.replace(/^motd\s*=.*$/m, `motd = "${mini}"`);
        }
        await fsp.writeFile(velocityToml, text);
      }
    } else {
      const cfgYml = path.join(this.dir, 'config.yml');
      if (await exists(cfgYml)) {
        let text = await fsp.readFile(cfgYml, 'utf8');
        text = text
          .replace(/^(\s*host:\s*)[^\s#]+/m, `$10.0.0.0:${port}`)
          .replace(/^online_mode:.*$/m, `online_mode: ${this.cfg.onlineMode !== false}`);
        if (this.cfg.network) text = this.networkBungee(text);
        if (this.cfg.motd && this.cfg.motd.frames[0]) {
          const m = this.cfg.motd.frames[0].replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
          text = text.replace(/^  motd:.*$/m, `  motd: "${m}"`);
        }
        await fsp.writeFile(cfgYml, text);
      } else if (this.cfg.network) {
        await fsp.writeFile(cfgYml, this.networkBungee([
          'listeners:',
          `- host: 0.0.0.0:${port}`,
          '  motd: \'&aA Tree Host network\'',
          '  max_players: 100',
          '  force_default_server: true',
          '  priorities: []',
          `online_mode: ${this.cfg.onlineMode !== false}`,
          'ip_forward: true',
          '',
        ].join('\n')));
      }
    }
  }

  /**
   * Removes the level<digits>.dat temp files Minecraft leaves behind when saving level.dat fails
   * (on Windows this usually happens when antivirus is scanning the freshly written file).
   */
  async cleanupFailedSaves() {
    if (this.kind === 'proxy') return;
    let removed = 0;
    for (const e of await fsp.readdir(this.dir, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory()) continue;
      const worldDir = path.join(this.dir, e.name);
      if (!(await exists(path.join(worldDir, 'level.dat')))) continue;
      for (const f of await fsp.readdir(worldDir).catch(() => [])) {
        if (/^level\d+\.dat$/.test(f)) {
          await fsp.rm(path.join(worldDir, f), { force: true }).catch(() => {});
          removed++;
        }
      }
    }
    if (removed) {
      this.sysLog(
        `Removed ${removed} leftover temp file(s) from failed world saves. If you see "Failed to replace level.dat" errors, ` +
          'add an antivirus exclusion for the data folder (see README).',
      );
    }
  }

  // ----- team: claims & activity -----

  /** "Someone is testing on this server" marker; expires by itself. */
  activeClaim() {
    const cl = this.cfg.claim;
    if (!cl) return null;
    if (cl.until && cl.until < Date.now()) {
      this.cfg.claim = null;
      this.save();
      return null;
    }
    return cl;
  }

  logActivity(kind, who, text) {
    if (this.manager.activity) this.manager.activity.log(kind, who, text, this);
  }

  // ----- Bedrock crossplay (Geyser + Floodgate): phones, consoles and Windows players join with the same address -----

  /** Geyser listens for Bedrock players on the server's own port (UDP), and Floodgate lets them in without a Java account. */
  async applyBedrock() {
    if (!this.cfg.bedrock || this.provider.family !== 'bukkit') return;
    const file = path.join(this.dir, this.pluginDirName, 'Geyser-Spigot', 'config.yml');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    let text = (await exists(file)) ? await fsp.readFile(file, 'utf8') : '';
    const bedrock = `  port: ${this.cfg.port}\n  clone-remote-port: false`;
    if (!text) {
      text = `bedrock:\n${bedrock}\n  motd1: "${this.cfg.name.replace(/"/g, '')}"\n  motd2: "Tree Host"\nremote:\n  auth-type: floodgate\n`;
    } else {
      text = replaceYamlChild(text, 'bedrock', 'port', `  port: ${this.cfg.port}`);
      text = replaceYamlChild(text, 'bedrock', 'clone-remote-port', '  clone-remote-port: false');
      text = replaceYamlChild(text, 'remote', 'auth-type', '  auth-type: floodgate');
    }
    await fsp.writeFile(file, text);
  }

  // ----- Network: a customer's proxy in front of their own servers -----

  /** velocity.toml for a proxy's network: its servers, where players start, and player-info forwarding. */
  async networkToml(text) {
    const net = this.manager.networkOf ? this.manager.networkOf(this) : null;
    if (!net) return text;
    const servers = net.backends.map((b) => `"${b.name}" = "${b.address}"`).join('\n');
    const order = net.backends.map((b) => `    "${b.name}"`).join(',\n');
    text = replaceTomlSection(text, 'servers', `[servers]\n${servers ? `${servers}\n` : ''}try = [\n${order}\n]\n`);
    text = replaceTomlSection(text, 'forced-hosts', '[forced-hosts]\n');
    text = text.replace(/^player-info-forwarding-mode\s*=.*$/m, `player-info-forwarding-mode = "${net.mode}"`);
    if (/^forwarding-secret-file\s*=/m.test(text)) {
      text = text.replace(/^forwarding-secret-file\s*=.*$/m, 'forwarding-secret-file = "forwarding.secret"');
      await fsp.writeFile(path.join(this.dir, 'forwarding.secret'), net.secret);
    } else if (/^forwarding-secret\s*=/m.test(text)) {
      text = text.replace(/^forwarding-secret\s*=.*$/m, `forwarding-secret = "${net.secret}"`);
    } else {
      await fsp.writeFile(path.join(this.dir, 'forwarding.secret'), net.secret);
    }
    return text;
  }

  /** BungeeCord / Waterfall config.yml for a proxy's network (legacy forwarding: ip_forward). */
  networkBungee(text) {
    const net = this.manager.networkOf ? this.manager.networkOf(this) : null;
    if (!net) return text;
    const servers = net.backends.length
      ? net.backends.map((b) => `  ${b.name}:\n    motd: '${b.label.replace(/'/g, "''")}'\n    address: ${b.address}\n    restricted: false`).join('\n')
      : '  {}';
    text = replaceYamlBlock(text, 'servers', `servers:\n${servers}`);
    text = /^ip_forward:/m.test(text) ? text.replace(/^ip_forward:.*$/m, 'ip_forward: true') : `${text.replace(/\n*$/, '\n')}ip_forward: true\n`;
    // Where players start: the listener's priorities list.
    const prio = net.backends.map((b) => `  - ${b.name}`).join('\n');
    text = text.replace(/^(\s*)priorities:[^\n]*(\n\1\s*- [^\n]*)*/m, (m0, ind) => `${ind}priorities:${prio ? `\n${prio.replace(/^ {2}/gm, `${ind}  `)}` : ' []'}`);
    return text;
  }

  /**
   * A server in a proxy's network trusts the proxy: online-mode off (the proxy checks accounts) and the proxy's
   * forwarding switched on (Paper: modern, with the shared secret; Spigot/CraftBukkit: BungeeCord legacy).
   * Taken out of a network, it goes back to normal.
   */
  async applyNetworkBackend() {
    if (this.kind === 'proxy' || this.provider.family !== 'bukkit') return;
    const net = this.manager.networkFor ? this.manager.networkFor(this) : null;
    if (!net && !this.cfg.networkApplied) return;
    const propsFile = path.join(this.dir, 'server.properties');
    const props = (await exists(propsFile)) ? await fsp.readFile(propsFile, 'utf8') : '';
    await fsp.writeFile(propsFile, updateProperties(props, { 'online-mode': net ? 'false' : this.cfg.onlineMode === false ? 'false' : 'true' }));
    const modern = !!net && net.mode === 'modern';
    // Paper's own proxy settings (1.19+: config/paper-global.yml, older: paper.yml).
    if (['paper', 'purpur', 'folia'].includes(this.cfg.type)) {
      const velocity = `  velocity:\n    enabled: ${modern}\n    online-mode: true\n    secret: '${modern ? net.secret : ''}'`;
      if (versionAtLeastMc(this.cfg.version, [1, 19])) {
        const file = path.join(this.dir, 'config', 'paper-global.yml');
        await fsp.mkdir(path.dirname(file), { recursive: true });
        const text = (await exists(file)) ? await fsp.readFile(file, 'utf8') : '';
        await fsp.writeFile(file, replaceYamlBlock(text, 'proxies', `proxies:\n  bungee-cord:\n    online-mode: true\n  proxy-protocol: false\n${velocity}`));
      } else {
        const file = path.join(this.dir, 'paper.yml');
        const text = (await exists(file)) ? await fsp.readFile(file, 'utf8') : '';
        await fsp.writeFile(file, replaceYamlChild(text, 'settings', 'velocity-support', `  velocity-support:\n    enabled: ${modern}\n    online-mode: true\n    secret: '${modern ? net.secret : ''}'`));
      }
    }
    // BungeeCord-style (legacy) forwarding lives in spigot.yml.
    const legacy = !!net && net.mode === 'legacy';
    const spigotYml = path.join(this.dir, 'spigot.yml');
    let t = (await exists(spigotYml)) ? await fsp.readFile(spigotYml, 'utf8') : '';
    if (/^\s*bungeecord:/m.test(t)) t = t.replace(/^(\s*bungeecord:\s*)\S+/m, `$1${legacy}`);
    else if (/^settings:\s*$/m.test(t)) t = t.replace(/^settings:\s*$/m, `settings:\n  bungeecord: ${legacy}`);
    else if (legacy || t) t = `${t.replace(/\n*$/, t ? '\n' : '')}settings:\n  bungeecord: ${legacy}\n`;
    if (t) await fsp.writeFile(spigotYml, t);
    const key = net ? `${net.proxyId}:${net.mode}` : null;
    if (key !== (this.cfg.networkApplied || null)) {
      this.cfg.networkApplied = key;
      this.save();
      this.sysLog(net ? `This server is in the network of "${net.proxyName}": players join through the proxy (${net.proxyAddress || 'its address'}).` : 'This server left its proxy network: players join it directly again.');
    }
  }

  // ----- Gateway (one Velocity proxy in front of every server) -----

  /**
   * Only Bukkit-type servers (Paper, Purpur, Folia, Spigot, CraftBukkit) understand the Gateway's player forwarding.
   * Vanilla and Fabric servers stay standalone and are joined directly.
   */
  get canUseGateway() {
    return this.kind !== 'proxy' && !this.cfg.gateway && this.provider.family === 'bukkit' && !this.isCustomer && !this.isolated;
  }

  /** Builds the Gateway's velocity.toml: every server, the join order, legacy forwarding, real-account checks. */
  gatewayToml(text) {
    const backends = this.manager.gatewayBackends();
    const servers = backends.map((b) => `"${b.name}" = "127.0.0.1:${b.port}"`).join('\n');
    const order = backends.map((b) => `    "${b.name}"`).join(',\n');
    text = replaceTomlSection(text, 'servers', `[servers]\n${servers ? `${servers}\n` : ''}try = [\n${order}\n]\n`);
    text = replaceTomlSection(text, 'forced-hosts', '[forced-hosts]\n');
    return text
      .replace(/^player-info-forwarding-mode\s*=.*$/m, 'player-info-forwarding-mode = "LEGACY"')
      .replace(/^motd\s*=.*$/m, 'motd = "<#46c37b>Tree Host"');
  }

  /** Rewrites the Gateway's server list and reloads it live (no restart needed). */
  async refreshGateway() {
    if (!this.cfg.gateway || !(await exists(path.join(this.dir, 'server.jar')))) return;
    await this.prepareConfigFiles();
    const count = this.manager.gatewayBackends().length;
    if (this.proc && this.status === 'running') {
      this.write('velocity reload');
      this.sysLog(`Gateway updated: ${count} server${count === 1 ? '' : 's'} reachable with /server <name>.`);
    }
  }

  /**
   * Servers behind the Gateway only accept connections from it: they listen on this PC only,
   * trust the Gateway's forwarded player info (BungeeCord mode) and let it check accounts.
   */
  async applyGatewayBackend() {
    const on = !!this.manager.gateway() && this.canUseGateway;
    if (!on && !this.cfg.gatewayApplied) return;
    const propsFile = path.join(this.dir, 'server.properties');
    const text = (await exists(propsFile)) ? await fsp.readFile(propsFile, 'utf8') : '';
    const updates = on
      ? { 'online-mode': 'false', 'server-ip': '127.0.0.1' }
      : { 'online-mode': this.cfg.onlineMode === false ? 'false' : 'true', 'server-ip': '' };
    await fsp.writeFile(propsFile, updateProperties(text, updates));
    if (this.provider.family === 'bukkit') {
      const spigotYml = path.join(this.dir, 'spigot.yml');
      if (await exists(spigotYml)) {
        let t = await fsp.readFile(spigotYml, 'utf8');
        if (/^\s*bungeecord:/m.test(t)) t = t.replace(/^(\s*bungeecord:\s*)\S+/m, `$1${on}`);
        else if (/^settings:\s*$/m.test(t)) t = t.replace(/^settings:\s*$/m, `settings:\n  bungeecord: ${on}`);
        else t += `\nsettings:\n  bungeecord: ${on}\n`;
        await fsp.writeFile(spigotYml, t);
      } else if (on) {
        // Spigot fills in the rest of spigot.yml on first start.
        await fsp.writeFile(spigotYml, 'settings:\n  bungeecord: true\n');
      }
    }
    if (on !== !!this.cfg.gatewayApplied) {
      this.cfg.gatewayApplied = on;
      this.save();
      this.sysLog(
        on
          ? `This server is behind the Gateway: players join the Gateway address and type /server ${this.manager.gatewayName(this)}.`
          : this.canUseGateway
            ? 'The Gateway was removed: players join this server directly again.'
            : `${this.provider.label} servers can't go behind the Gateway, so this server is joined directly (see its address box).`,
      );
    }
  }

  // ----- lifecycle -----

  async clearLinks() {
    const n = await removeSymlinks(this.dir);
    if (n) this.sysLog(`Removed ${n} link(s) from the server folder (links are not allowed for security).`);
  }

  async start() {
    if (this.proc || this.status !== 'stopped') return;
    this.diagnosis = null;
    this.startSeq = this.seq;
    const blocked = this.manager.startBlock(this);
    if (blocked) {
      this.sysLog(`Could not start: ${blocked}`);
      return;
    }
    this.status = 'starting';
    this.progress = null;
    this.emitStatus();
    try {
      if (await this.needsInstall()) await this.install({ fromStart: true });
      this.status = 'starting';
      this.progress = { label: 'Preparing Java...', done: 0, total: 0 };
      this.emitStatus();
      await this.clearLinks();
      if (this.manager.beforeStart) await this.manager.beforeStart(this);
      await this.prepareConfigFiles();
      await this.cleanupFailedSaves();
      if (!(await isPortFree(this.cfg.port))) {
        throw new Error(`Port ${this.cfg.port} is already in use (another server running?). Change it in Settings.`);
      }
      await this.syncWatchedPlugins();
      const freeMb = Math.floor(os.freemem() / 1048576);
      const needMb = Math.max(512, Number(this.cfg.memoryMb) || 2048);
      if (freeMb < needMb + 512) {
        this.sysLog(
          `Warning: this PC only has about ${freeMb} MB of free memory and this server can use up to ${needMb} MB. ` +
            'It may run slowly or load the world very slowly. Stop other servers or lower this one\'s memory in Settings.',
        );
      }
      if (!this.isolated && this.isCustomer) await this.manager.recheckIsolation();
      if (this.isolated) {
        const major = /^\d+$/.test(String(this.cfg.java)) ? Number(this.cfg.java) : await this.provider.java(this.cfg.version, this.dir);
        const { major: m, image } = docker.imageFor(major);
        this.javaMajor = m;
        this.progress = { label: `Preparing Java ${m}...`, done: 0, total: 0 };
        this.emitStatus();
        await docker.ensureImage(image, (msg) => this.sysLog(msg));
        await docker.ensureNetwork();
        const memLimitMb = Math.max(512, Number(this.cfg.memoryMb) || 2048) + this.manager.overheadMb;
        const plan = this.manager.planInfo(this);
        this.progress = null;
        this.spawnServer('docker', docker.runArgs({ id: this.cfg.id, dir: this.dir, port: this.cfg.port, memLimitMb, cpus: plan ? plan.cpus : null, image }), 'java');
      } else {
        if (this.isCustomer && !this.manager.allowUnsafe) throw Object.assign(new Error('Customer servers only run isolated in Docker, and Docker is not running. Start Docker (Docker Desktop on Windows/macOS) and press Start again.'), { internal: true });
        if (this.isCustomer) this.sysLog('Docker is not running, so this test server runs directly on this PC. (The real site always isolates servers in Docker.)');
        const javaExe = await this.resolveJavaExe();
        this.progress = null;
        this.spawnServer(javaExe, [], null);
      }
    } catch (e) {
      // Customers never see how the machine works (Docker, images, paths): they get a plain message, the operator gets the details.
      const hide = this.hidesInternals() && (e.internal || /docker|container|image/i.test(e.message));
      if (hide) console.error(`[Tree Host] "${this.cfg.name}" (${this.cfg.id}) could not start: ${e.message}`);
      this.sysLog(`Could not start: ${hide ? "a problem on our side. Please try again in a few minutes, and contact support if it keeps happening." : e.message}`);
      this.setStatus('stopped');
    }
  }

  /** True for customer servers on the real site: their console must not show host internals. */
  hidesInternals() {
    return this.isCustomer && !this.manager.allowUnsafe;
  }

  /** cmd: the program to run (java, or docker); pre: its arguments before the Java ones; javaInside: java's name in the container. */
  spawnServer(cmd, pre, javaInside) {
    const c = this.cfg;
    const mem = Math.max(512, Number(c.memoryMb) || 2048);
    const args = [
      `-Xms${Math.min(mem, Math.max(512, Math.floor(mem / 2)))}M`,
      `-Xmx${mem}M`,
      '-Dfile.encoding=UTF-8',
      '-Dstdout.encoding=UTF-8',
      '-Dstderr.encoding=UTF-8',
      '-Dlog4j2.formatMsgNoLookups=true',
    ];
    if (this.provider.family === 'bukkit' || this.kind === 'proxy') {
      args.push('-Dterminal.jline=false', '-Dterminal.ansi=true');
    }
    args.push(...splitArgs(c.jvmArgs), '-jar', 'server.jar');
    if (this.kind !== 'proxy') args.push('nogui');
    args.push(...splitArgs(c.serverArgs));

    if (c.gateway && mem > 1024) {
      this.sysLog(`Note: the Gateway only needs about 512 MB of memory but is set to ${mem} MB. Lower it in Settings to leave more for your servers.`);
    }
    const full = javaInside ? [...pre, javaInside, ...args] : args;
    this.sysLog(
      javaInside
        ? `Starting ${this.provider.label} ${c.version} with Java ${this.javaMajor} in its own container (${Number(c.memoryMb) >= 1024 ? `${+(Number(c.memoryMb) / 1024).toFixed(1)} GB` : `${Number(c.memoryMb)} MB`} of memory)...`
        : `Starting with Java ${this.javaMajor || '?'}: ${cmd === 'java' ? 'java' : cmd} ${args.join(' ')}`,
    );
    const proc = spawn(cmd, full, { cwd: this.dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    this.startedAt = Date.now();
    this.lastStartAt = this.startedAt; // kept after it stops (startedAt isn't)
    this.players.clear();
    this.status = 'starting';
    this.emitStatus();

    const onLine = (l) => this.handleLine(l);
    readline.createInterface({ input: proc.stdout }).on('line', onLine);
    readline.createInterface({ input: proc.stderr }).on('line', onLine);
    proc.stdin.on('error', () => {});

    proc.on('error', (e) => {
      if (this.hidesInternals()) {
        console.error(`[Tree Host] "${this.cfg.name}" (${this.cfg.id}) failed to launch ${cmd}: ${e.message}`);
        this.sysLog('Failed to launch the server: a problem on our side. Please try again in a few minutes.');
      } else this.sysLog(`Failed to launch ${javaInside ? 'Docker' : 'Java'}: ${e.message}`);
      if (!proc.pid && this.proc === proc) {
        this.proc = null;
        this.startedAt = null;
        this.setStatus('stopped');
      }
    });
    proc.on('spawn', () => {
      c.lastPid = proc.pid;
      this.save();
    });
    proc.on('exit', (code, signal) => {
      clearTimeout(this.stopTimer);
      const expected = this.status === 'stopping';
      this.proc = null;
      this.startedAt = null;
      this.players.clear();
      c.lastPid = null;
      this.save();
      // Exit 143/130 (or SIGTERM/SIGINT/SIGHUP) means something outside Tree Host asked it to stop: the Tree Host window
      // was closed, Docker restarted, or the PC is shutting down. That's a normal stop, not a crash.
      const stoppedOutside = !expected && (code === 143 || code === 130 || ['SIGTERM', 'SIGINT', 'SIGHUP'].includes(signal));
      const crashed = !expected && !stoppedOutside && code !== 0;
      if (stoppedOutside) this.sysLog(`Server was stopped from outside Tree Host (${signal || `exit code ${code}`}): for example the Tree Host window was closed or Docker restarted. This is not a crash.`);
      else if (!crashed) this.sysLog(`Server stopped${code != null ? ` (exit code ${code})` : ''}.`);
      else this.sysLog(`Server exited unexpectedly (${signal || `exit code ${code}`}). Check the log above for errors.`);
      this.memUsedMb = null;
      this.setStatus('stopped');
      if (crashed) {
        this.crashTimes = (this.crashTimes || []).filter((t) => Date.now() - t < 10 * 60 * 1000).concat(Date.now());
        // The likely cause: real error lines near the end, not stack frames or players failing to connect somewhere.
        const lastLines = this.logs.slice(-40).map((l) => stripAnsi(l.t))
          .filter((t) => !t.startsWith('[Tree Host]') && /exception|error|caused by/i.test(t))
          .filter((t) => !/^\s*at |^\s*\.\.\. \d+ more|unable to connect|Connection refused|ConnectException|has disconnected|lost connection/i.test(t))
          .slice(-2);
        if (javaInside && code === 137) this.sysLog(`The server ran out of memory (it may use at most ${Number(c.memoryMb)} MB). Use fewer or lighter plugins/mods, or a bigger plan.`);
        const findings = diagnose(this.logs.slice(-400).map((l) => stripAnsi(l.t)), { memoryExit: javaInside && code === 137 });
        this.diagnosis = findings.length ? { at: Date.now(), crashed: true, findings } : null;
        for (const f of findings) this.sysLog(`Crash doctor: ${f.title}. ${f.fix}`);
        if (this.manager.onCrash) this.manager.onCrash(this); // e.g. undo a plugin update that broke it, before any restart
        this.logActivity('crash', 'Tree Host', `reports a crash (exit code ${code})${findings.length ? `: ${findings[0].title}` : lastLines.length ? `: ${lastLines.join(' / ').slice(0, 300)}` : ''}`);
        if (c.autoRestart && !this.restartPending) {
          if (this.crashTimes.length > 3) {
            this.sysLog('Crashed more than 3 times in 10 minutes, so it won\'t be restarted automatically. Check the log above.');
          } else {
            this.sysLog('Restarting automatically in 5 seconds (Settings → Restart after a crash)...');
            setTimeout(() => {
              if (!this.proc && this.status === 'stopped') this.start();
            }, 5000);
          }
        }
      }
      if (this.restartPending) {
        setTimeout(() => {
          if (!this.restartPending) return;
          this.restartPending = false;
          this.start();
        }, 500);
      }
    });
  }

  handleLine(raw) {
    this.appendLog(raw);
    const line = stripAnsi(raw);
    if (this.manager.onConsoleLine) {
      try {
        this.manager.onConsoleLine(this, line);
      } catch (e) {
        console.error(`[console hook] ${e.message}`);
      }
    }
    this.manager.emit('line', this, line); // for features that read the console (players, lag doctor)
    if (this.status === 'starting' && (/Done \([\d.,]+m?s\)!/.test(line) || /Listening on \//.test(line))) {
      this.setStatus('running');
      const startup = diagnose(this.logs.filter((l) => l.s > (this.startSeq || 0)).map((l) => stripAnsi(l.t))).filter((f) => f.warning);
      if (startup.length) {
        this.diagnosis = { at: Date.now(), crashed: false, findings: startup };
        for (const f of startup) this.sysLog(`Crash doctor: ${f.title}. ${f.fix}`);
      }
      // Remember which version last opened the world: Minecraft can't open it in an older version.
      if (this.kind !== 'proxy' && this.cfg.worldVersion !== this.cfg.version) {
        this.cfg.worldVersion = this.cfg.version;
        this.manager.save();
      }
      this.staffJoined = new Set();
      this.getProperties().then((p) => {
        this.maxPlayers = Number(p['max-players']) || null;
        this.onlineMode = p['online-mode'] !== 'false';
        this.emitStatus();
      }).catch(() => {});
      const addr = this.cfg.port === 25565 ? '127.0.0.1' : `127.0.0.1:${this.cfg.port}`;
      this.sysLog(`Ready! In Minecraft go to Multiplayer → Add Server and use the address: ${this.cfg.publicAddress || this.cfg.autoAddress || addr}`);
      if (this.manager.teamMode && this.kind !== 'proxy' && !this.isCustomer) this.teamAccess({ op: false, quiet: true });
    }
    if (this.kind === 'proxy' && !this.networkHinted && /unable to connect to server|Unable to connect you to|Could not connect to a default or fallback server|Connection refused/i.test(line)) {
      this.networkHinted = true;
      setTimeout(() => (this.networkHinted = false), 300000);
      this.sysLog(this.cfg.network
        ? 'The proxy could not reach one of your servers. Make sure the servers in Settings → Network are running (and were restarted after joining the network).'
        : 'This proxy has no servers to send players to yet. Open Settings → Network, tick your servers and choose where players start.');
    }
    if (!this.downgradeHinted && /No key dimensions in MapLike|saved with a newer version|newer version of Minecraft|Unsupported data version|outdated server/i.test(line) && this.status === 'starting') {
      this.downgradeHinted = true;
      setTimeout(() => (this.downgradeHinted = false), 60000);
      this.sysLog(`This world was saved by a newer Minecraft version, so ${this.cfg.version} can't open it. Switch back to the newer version in Settings → Server software, or restore a backup from before the change (Backups tab), or Reset worlds to start a fresh one.`);
    }
    let m = /: ([A-Za-z0-9_.]{1,16})(?: joined the game|\[[^\]]*\] logged in with entity id)/.exec(line);
    if (m) {
      if (!this.players.has(m[1])) {
        this.players.add(m[1]);
        this.emitStatus();
      }
      return;
    }
    m = /: ([A-Za-z0-9_.]{1,16})(?: left the game| lost connection)/.exec(line);
    if (m && this.players.delete(m[1])) this.emitStatus();
  }

  stopCommand() {
    if (this.provider.family === 'velocity') return 'shutdown';
    if (this.provider.family === 'bungee') return 'end';
    return 'stop';
  }

  stop() {
    if (!this.proc) {
      this.restartPending = false;
      return;
    }
    if (this.status === 'stopping') return;
    this.setStatus('stopping');
    this.sysLog('Stopping server...');
    this.write(this.stopCommand());
    clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => {
      if (this.proc) {
        this.sysLog(`Server did not stop within ${STOP_TIMEOUT_MS / 1000}s, killing it.`);
        this.kill();
      }
    }, STOP_TIMEOUT_MS);
  }

  restart() {
    if (!this.proc) return this.start();
    this.restartPending = true;
    this.stop();
  }

  /** Stops the server and resolves once the process has exited. */
  stopAndWait() {
    const proc = this.proc;
    if (!proc) return Promise.resolve();
    this.restartPending = false;
    return new Promise((resolve) => {
      proc.once('exit', () => setTimeout(resolve, 300));
      this.stop();
    });
  }

  /** Whitelists (and optionally ops) every team member's Minecraft name. */
  teamAccess({ op = false, quiet = false } = {}) {
    if (!this.proc) throw new Error('Start the server first.');
    const names = this.manager.accessNames(this);
    if (!names.length) {
      if (!quiet) {
        throw new Error(
          this.cfg.space === 'solo'
            ? 'Set your Minecraft name first (Account → Minecraft name).'
            : 'No team members have set their Minecraft name yet (Account → Minecraft name).',
        );
      }
      return [];
    }
    for (const n of names) {
      this.write(`whitelist add ${n}`);
      if (op) this.write(`op ${n}`);
    }
    this.sysLog(`${op ? 'Whitelisted and opped' : 'Whitelisted'} ${this.cfg.space === 'solo' ? 'the owner' : 'the team'}: ${names.join(', ')}`);
    return names;
  }

  kill() {
    if (!this.proc) return;
    this.restartPending = false;
    this.status = 'stopping';
    this.sysLog('Killing server process...');
    if (this.isolated) {
      docker.kill(this.cfg.id);
      setTimeout(() => this.proc && this.proc.kill(), 5000);
    } else if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(this.proc.pid), '/T', '/F'], { windowsHide: true });
    } else {
      this.proc.kill('SIGKILL');
    }
  }

  write(cmd) {
    if (!this.proc) throw new Error('Server is not running.');
    // One command at a time: line breaks and control characters would smuggle extra commands into the console.
    const clean = String(cmd).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 2000);
    if (!clean) return;
    this.proc.stdin.write(clean.replace(/^\//, '') + '\n');
  }

  command(cmd) {
    cmd = String(cmd || '').trim();
    if (!cmd) return;
    this.appendLog(`> ${cmd}`);
    this.write(cmd);
  }

  // ----- Minecraft client -----

  async isOnlineMode() {
    if (this.kind === 'proxy') return this.cfg.onlineMode !== false;
    const v = (await this.getProperties())['online-mode'];
    return v === undefined ? this.cfg.onlineMode !== false : v !== 'false';
  }

  async setOfflineMode() {
    this.cfg.onlineMode = false;
    if (this.kind !== 'proxy') await this.setProperties({ 'online-mode': 'false' });
    this.save();
  }

  onClientProgress(done, total) {
    if (!this.client) return;
    this.client = { ...this.client, done, total };
    const now = Date.now();
    if (now - this.lastProgressEmit > 250 || (total && done >= total)) {
      this.lastProgressEmit = now;
      this.emitStatus();
    }
  }

  clientLog(msg) {
    this.appendLog(`[Tree Host] ${msg}`);
    if (this.client) {
      this.client = { ...this.client, label: msg.slice(0, 140), done: 0, total: 0 };
      this.emitStatus();
    }
  }

  async waitUntilRunning(timeoutMs = 15 * 60 * 1000) {
    const end = Date.now() + timeoutMs;
    let stoppedFor = 0;
    while (Date.now() < end) {
      if (this.status === 'running' && !this.restartPending) return;
      stoppedFor = this.status === 'stopped' && !this.restartPending ? stoppedFor + 1 : 0;
      if (stoppedFor >= 3) throw new Error('the server is not running (check the console for why it stopped).');
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('timed out waiting for the server to start.');
  }

  /** Downloads the matching Minecraft client and launches it straight into this server. */
  async launchClient({ username, fixOnlineMode }) {
    username = String(username || '').trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) throw new Error('Username must be 3-16 characters: letters, numbers or _');
    if (this.client) throw new Error('Minecraft is already being prepared for this server.');
    if (await this.isOnlineMode()) {
      if (!fixOnlineMode) {
        throw Object.assign(new Error('This server is in online mode, which only accepts players signed in through the official launcher.'), {
          code: 'ONLINE_MODE',
        });
      }
      await this.setOfflineMode();
      this.sysLog('Switched the server to offline mode so the test client can join.');
      if (this.proc) this.restart();
    }
    const version = await client.versionFor({
      version: this.cfg.version,
      clientVersion: this.cfg.clientVersion,
      kind: this.kind,
      type: this.cfg.type,
    });
    this.client = { state: 'preparing', label: `Preparing Minecraft ${version}...`, done: 0, total: 0 };
    this.emitStatus();

    (async () => {
      try {
        if (this.status === 'stopped' && !this.restartPending) this.start();
        const prep = await client.prepare(version, {
          log: (m) => this.clientLog(m),
          progress: (d, t) => this.onClientProgress(d, t),
        });
        if (this.status !== 'running' || this.restartPending) {
          this.client = { state: 'waiting', label: 'Waiting for the server to finish starting...', done: 0, total: 0 };
          this.emitStatus();
        }
        await this.waitUntilRunning();
        const proc = client.launch(prep, { username, host: '127.0.0.1', port: this.cfg.port });
        this.clientsRunning++;
        this.appendLog(`[Tree Host] Launched Minecraft ${version} (Java ${prep.major}) as ${username}, joining 127.0.0.1:${this.cfg.port}...`);
        proc.on('error', (e) => this.appendLog(`[Tree Host] Minecraft client failed to start: ${e.message}`));
        proc.on('exit', (code) => {
          this.clientsRunning = Math.max(0, this.clientsRunning - 1);
          if (code === 0) this.appendLog(`[Tree Host] Minecraft client (${username}) closed.`);
          else {
            this.appendLog(`[Tree Host] Minecraft client (${username}) crashed with exit code ${code}. Last output:`);
            for (const l of proc.tail.slice(-15)) this.appendLog(`[Tree Host]   ${l}`);
          }
          this.emitStatus();
        });
      } catch (e) {
        this.appendLog(`[Tree Host] Could not launch Minecraft: ${e.message}`);
      } finally {
        this.client = null;
        this.emitStatus();
      }
    })();
    return { version };
  }

  // ----- plugins & auto-deploy -----

  async syncWatchedPlugins() {
    const watches = this.cfg.watches.filter((w) => w.enabled !== false);
    if (!watches.length) return;
    await fsp.mkdir(this.pluginDir, { recursive: true });
    for (const w of watches) {
      const jar = await resolveWatchJar(w.path).catch(() => null);
      if (!jar) {
        this.sysLog(`Auto-deploy: no jar found at ${w.path}`);
        continue;
      }
      const name = path.basename(jar.file);
      const dest = path.join(this.pluginDir, name);
      if (w.lastCopied && w.lastCopied !== name) {
        await fsp.rm(path.join(this.pluginDir, w.lastCopied), { force: true }).catch(() => {});
      }
      let same = false;
      try {
        const ds = await fsp.stat(dest);
        same = ds.size === jar.size && Math.abs(ds.mtimeMs - jar.mtimeMs) < 2000;
      } catch {
        /* not copied yet */
      }
      if (!same) {
        try {
          await fsp.copyFile(jar.file, dest);
          await fsp.utimes(dest, new Date(), new Date(jar.mtimeMs));
          this.sysLog(`Auto-deploy: copied ${name} → ${this.pluginDirName}/`);
        } catch (e) {
          this.sysLog(`Auto-deploy: could not copy ${name}: ${e.message}`);
          continue;
        }
      }
      w.lastCopied = name;
    }
    this.save();
  }

  async pollWatches() {
    if (this.polling || !this.cfg.watches.length) return;
    this.polling = true;
    try {
      let changed = false;
      for (const w of this.cfg.watches) {
        const jar = await resolveWatchJar(w.path).catch(() => null);
        const sig = jar ? `${jar.file}|${jar.mtimeMs}|${jar.size}` : null;
        let st = this.watchState.get(w.id);
        if (!st) {
          st = { last: sig, pending: null, missing: !jar };
          this.watchState.set(w.id, st);
          changed = true;
          continue;
        }
        if (st.missing !== !jar) {
          st.missing = !jar;
          changed = true;
        }
        if (!sig || sig === st.last) {
          st.pending = null;
          continue;
        }
        // Require the same signature on two polls so we never copy a half-written jar.
        if (st.pending === sig) {
          st.last = sig;
          st.pending = null;
          if (w.enabled !== false) this.onWatchedChange(jar);
        } else {
          st.pending = sig;
        }
      }
      if (changed) this.emitStatus();
    } finally {
      this.polling = false;
    }
  }

  onWatchedChange(jar) {
    this.sysLog(`Auto-deploy: new build detected (${path.basename(jar.file)})`);
    clearTimeout(this.watchDebounce);
    this.watchDebounce = setTimeout(() => {
      if (this.proc) {
        if (this.cfg.onPluginChange === 'restart') {
          this.sysLog('Auto-deploy: restarting to load the new build...');
          this.restart();
        } else {
          this.sysLog('Auto-deploy: the new build will be copied on the next start.');
        }
      } else if (this.status === 'stopped') {
        this.syncWatchedPlugins().catch((e) => this.sysLog(`Auto-deploy failed: ${e.message}`));
      }
    }, 800);
  }

  async listPlugins() {
    await assertNoLinks(this.dir, this.pluginDir);
    await fsp.mkdir(this.pluginDir, { recursive: true });
    const out = [];
    for (const file of await fsp.readdir(this.pluginDir)) {
      const lower = file.toLowerCase();
      if (!lower.endsWith('.jar') && !lower.endsWith('.jar.disabled')) continue;
      const full = path.join(this.pluginDir, file);
      const st = await fsp.lstat(full).catch(() => null);
      if (!st || !st.isFile()) continue;
      out.push({
        file,
        enabled: lower.endsWith('.jar'),
        size: st.size,
        mtime: st.mtimeMs,
        watched: this.cfg.watches.some((w) => w.lastCopied === file),
        locked: this.isProtectedPath(full),
        managed: (this.manager.managedPluginInfo && this.manager.managedPluginInfo(this, file)) || null,
        ...(await readPluginMeta(full)),
      });
    }
    return out.sort((a, b) => (a.name || a.file).localeCompare(b.name || b.file));
  }

  /**
   * Deploys a plugin build: replaces older jars of the same plugin and restarts the server if it was running.
   * Used by the deploy API (Gradle/Maven/curl) in team mode.
   */
  async deployPlugin(name, stream, { restart = true, by = 'someone' } = {}) {
    const file = safeFileName(name);
    this.assertNotProtected(path.join(this.pluginDir, file));
    if (!file.toLowerCase().endsWith('.jar')) throw new Error('Only .jar files can be deployed');
    if (!this.proc && this.status !== 'stopped') throw new Error(`The server is busy (${this.status}). Try again in a moment.`);
    await assertNoLinks(this.dir, path.join(this.pluginDir, file));
    await fsp.mkdir(this.pluginDir, { recursive: true });
    const tmp = path.join(this.dir, `.deploy-${crypto.randomBytes(8).toString('hex')}.jar`);
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      stream.pipe(out);
      stream.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
    });
    await this.assertCleanJar(tmp, file);
    const meta = await readPluginMeta(tmp);
    if (meta.name === 'TreeHostStaff') {
      await fsp.rm(tmp, { force: true });
      throw Object.assign(new Error('That name belongs to the Tree Host staff plugin.'), { status: 403 });
    }
    if (meta.invalid) {
      await fsp.rm(tmp, { force: true });
      throw new Error('That file is not a valid jar');
    }
    const wasRunning = !!this.proc;
    if (wasRunning) {
      this.sysLog(`Deploy from ${by}: stopping the server to swap ${file}...`);
      await this.stopAndWait();
    }
    const replaced = [];
    if (meta.name) {
      for (const p of await this.listPlugins()) {
        if (p.name === meta.name && p.file !== file && !p.locked) {
          await fsp.rm(path.join(this.pluginDir, p.file), { force: true });
          replaced.push(p.file);
        }
      }
    }
    const dest = path.join(this.pluginDir, file);
    await fsp.rm(dest, { force: true });
    await fsp.rename(tmp, dest);
    this.sysLog(
      `Deployed ${file}${meta.name ? ` (${meta.name} ${meta.version || ''})` : ''} from ${by}` +
        (replaced.length ? `, replacing ${replaced.join(', ')}` : ''),
    );
    this.logActivity('deploy', by, `deployed ${meta.name ? `${meta.name} ${meta.version || ''}`.trim() : file}`);
    const restarted = wasRunning && restart;
    if (restarted) this.start();
    return { file, plugin: meta.name || null, version: meta.version || null, replaced, restarted };
  }

  /** Refuses (and deletes) an uploaded jar that contains known Minecraft malware (src/jarscan.js). */
  async assertCleanJar(tmp, file) {
    const r = await scanJar(tmp).catch(() => ({ infected: false }));
    if (!r.infected) return;
    await fsp.rm(tmp, { force: true });
    this.sysLog(`Blocked ${file}: it contains ${r.family} malware (${r.entry}). It was not installed.`);
    this.logActivity('security', 'Tree Host', `blocked the jar ${file}: it contains ${r.family} malware`);
    throw Object.assign(new Error(`${file} contains code from known Minecraft malware (${r.family}), so it was not installed. Download plugins only from their official page.`), { status: 400 });
  }

  async savePluginUpload(name, stream) {
    const file = safeFileName(name);
    this.assertNotProtected(path.join(this.pluginDir, file));
    if (!file.toLowerCase().endsWith('.jar')) throw new Error('Only .jar files can be uploaded');
    await assertNoLinks(this.dir, path.join(this.pluginDir, file));
    await fsp.mkdir(this.pluginDir, { recursive: true });
    const dest = path.join(this.pluginDir, file);
    const tmp = path.join(this.dir, `.upload-${crypto.randomBytes(8).toString('hex')}`);
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      stream.pipe(out);
      stream.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
    });
    await this.assertCleanJar(tmp, file);
    try {
      await fsp.rename(tmp, dest);
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      if (e.code === 'EBUSY' || e.code === 'EPERM') throw new Error(`${file} is in use by the running server. Stop the server and try again.`);
      throw e;
    }
    this.sysLog(`Added ${file} to ${this.pluginDirName}/${this.proc ? ' (restart to load it)' : ''}`);
    return file;
  }

  async togglePlugin(file) {
    file = safeFileName(file);
    const full = path.join(this.pluginDir, file);
    this.assertNotProtected(full);
    await assertNoLinks(this.dir, full);
    const target = file.toLowerCase().endsWith('.disabled') ? full.slice(0, -'.disabled'.length) : full + '.disabled';
    await fsp.rename(full, target).catch((e) => {
      if (e.code === 'EBUSY' || e.code === 'EPERM') throw new Error('The plugin is in use. Stop the server first.');
      throw e;
    });
  }

  async deletePlugin(file) {
    file = safeFileName(file);
    this.assertNotProtected(path.join(this.pluginDir, file));
    await fsp.rm(path.join(this.pluginDir, file)).catch((e) => {
      if (e.code === 'EBUSY' || e.code === 'EPERM') throw new Error('The plugin is in use. Stop the server first.');
      throw e;
    });
  }

  // ----- the Tree Host staff plugin (and locked managed plugins) can't be removed, turned off or changed -----

  /** True for plugins/TreeHostStaff.jar (and its folder, or the plugins folder itself) on servers that must have it. */
  isStaffPluginPath(full) {
    if (!this.manager.protectedPlugin || !this.manager.protectedPlugin(this)) return false;
    const rel = path.relative(this.dir, full).replace(/\\/g, '/').toLowerCase();
    const dir = this.pluginDirName.toLowerCase();
    return rel === dir || rel === `${dir}/treehoststaff.jar` || rel === `${dir}/treehoststaff.jar.disabled` || rel === `${dir}/treehoststaff` || rel.startsWith(`${dir}/treehoststaff/`);
  }

  /** True for a plugin staff locked onto this server in the Staff Console (see src/managed-plugins.js). */
  isLockedManagedPath(full) {
    if (!this.manager.lockedPluginFiles) return false;
    const rel = path.relative(this.dir, full).replace(/\\/g, '/').toLowerCase();
    const dir = this.pluginDirName.toLowerCase();
    return this.manager.lockedPluginFiles(this).some((f) => rel === `${dir}/${f}` || rel === `${dir}/${f}.disabled`);
  }

  isProtectedPath(full) {
    return this.isStaffPluginPath(full) || this.isLockedManagedPath(full);
  }

  assertNotProtected(full) {
    if (this.isStaffPluginPath(full)) {
      throw Object.assign(new Error("That's the Tree Host staff plugin. Every server needs it, so it can't be removed, turned off or changed."), { status: 403 });
    }
    if (this.isLockedManagedPath(full)) {
      throw Object.assign(new Error("That plugin is managed by Tree Host and required on this server, so it can't be removed, turned off or changed."), { status: 403 });
    }
  }

  // ----- files -----

  resolvePath(rel) {
    const full = path.resolve(this.dir, rel || '.');
    const r = path.relative(this.dir, full);
    if (r.startsWith('..') || path.isAbsolute(r)) throw new Error('Path is outside the server folder');
    return full;
  }

  async listFiles(rel) {
    const dir = this.resolvePath(rel);
    await fsp.mkdir(this.dir, { recursive: true });
    await assertNoLinks(this.dir, dir);
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      const st = await fsp.lstat(path.join(dir, e.name)).catch(() => null);
      if (!st || st.isSymbolicLink()) continue;
      out.push({ name: e.name, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs });
    }
    return out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  }

  async readFile(rel) {
    const file = this.resolvePath(rel);
    await assertNoLinks(this.dir, file);
    const st = await fsp.lstat(file);
    if (st.isDirectory()) throw new Error('That is a folder');
    if (st.size > 2 * 1024 * 1024) throw new Error('File is too large to edit here (over 2 MB)');
    const buf = await readInside(this.dir, file);
    if (buf.includes(0)) throw new Error('Binary files cannot be edited here');
    return buf.toString('utf8');
  }

  async writeFile(rel, content) {
    const file = this.resolvePath(rel);
    this.assertNotProtected(file);
    await assertNoLinks(this.dir, file);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await writeInside(this.dir, file, String(content));
  }

  async deleteFile(rel) {
    const file = this.resolvePath(rel);
    if (file === path.resolve(this.dir)) throw new Error('Cannot delete the server folder here');
    this.assertNotProtected(file);
    await assertNoLinks(this.dir, path.dirname(file));
    await fsp.rm(file, { recursive: true });
  }

  async getProperties() {
    const f = path.join(this.dir, 'server.properties');
    if (!(await exists(f))) return {};
    try {
      return parseProperties((await readInside(this.dir, f)).toString('utf8'));
    } catch {
      return {};
    }
  }

  async setProperties(updates) {
    const f = path.join(this.dir, 'server.properties');
    const clean = {};
    for (const [k, v] of Object.entries(updates || {})) {
      if (!/^[\w.-]+$/.test(k)) continue;
      clean[k] = String(v).replace(/[\r\n]/g, ' ');
    }
    if (this.isCustomer) {
      // The port is assigned by Tree Host and published by the container.
      delete clean['server-port'];
      delete clean['server-ip'];
    }
    if ('server-port' in clean) {
      const port = Number(clean['server-port']);
      if (port > 0 && port < 65536) this.cfg.port = port;
      this.save();
    }
    if ('online-mode' in clean) this.cfg.onlineMode = clean['online-mode'] !== 'false';
    const text = (await exists(f)) ? (await readInside(this.dir, f)).toString('utf8') : '';
    await fsp.mkdir(this.dir, { recursive: true });
    await writeInside(this.dir, f, updateProperties(text, clean));
  }

  /** True if the server has a saved world (level.dat in its world folder). */
  async hasWorld() {
    const level = (await this.getProperties())['level-name'] || 'world';
    return exists(path.join(this.resolvePath(level), 'level.dat'));
  }

  async resetWorlds() {
    if (this.proc || this.status !== 'stopped') throw new Error('Stop the server first.');
    const level = (await this.getProperties())['level-name'] || 'world';
    const removed = [];
    for (const name of [level, `${level}_nether`, `${level}_the_end`]) {
      const p = this.resolvePath(name);
      if (this.isProtectedPath(p)) continue;
      if (await exists(p)) {
        await fsp.rm(p, { recursive: true, force: true });
        removed.push(name);
      }
    }
    this.sysLog(removed.length ? `Deleted worlds: ${removed.join(', ')}. A fresh world is generated on next start.` : 'No worlds to delete.');
  }
}

// ---------- Manager ----------

class Manager extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
    this.instances = new Map();
    this.teamMode = false;
    this.accessNames = () => [];
    this.ownerName = () => null;
    this.defaultOwner = () => null;
    this.teamMcNames = () => [];
    this.activity = null;
    // Docker isolation: on by default on Linux when Docker is installed; TREEHOST_ISOLATION=docker|off overrides.
    this.docker = false;
    this.allowUnsafe = process.env.TREEHOST_ALLOW_UNSAFE === '1';
    this.overheadMb = 384;
    // Ports handed out to customer servers, e.g. TREEHOST_PORTS=25600-25999 (open these in the firewall).
    const [lo, hi] = String(process.env.TREEHOST_PORTS || '25600-25999').split('-').map(Number);
    this.customerPorts = { lo: lo || 25600, hi: hi || 25999 };
    // The address players use for customer servers (a domain or the server's public IP).
    this.gameHost = process.env.TREEHOST_GAME_HOST || '';
    // Set by server.js (billing): plan limits for a server, and why it may not start.
    this.planInfo = () => null;
    this.startBlock = () => null;
  }

  async setupIsolation() {
    const mode = process.env.TREEHOST_ISOLATION || (process.platform === 'linux' ? 'auto' : 'off');
    if (mode === 'off') return;
    console.log('  Checking Docker...');
    if (await docker.available()) {
      this.docker = true;
      await docker.removeLeftovers((m) => console.log(`  ${m}`));
      await docker.ensureNetwork();
      console.log('  Isolation: every server runs in its own Docker container.');
    } else if (this.allowUnsafe) {
      console.log('  Docker is not running or not answering: test servers run directly on this PC until it is (checked again at every start).');
    } else if (mode === 'docker') {
      console.log('  TREEHOST_ISOLATION=docker but Docker is not running. Customer servers will not start until it is.');
    } else {
      console.log('  Docker was not found: customer servers will not start. Install Docker (see the hosting guide).');
    }
  }

  /** Docker may have started after Tree Host did: check again before refusing or running a server without it. */
  async recheckIsolation() {
    if (this.docker) return true;
    const mode = process.env.TREEHOST_ISOLATION || (process.platform === 'linux' ? 'auto' : 'off');
    if (mode === 'off') return false;
    if (await docker.available(true)) {
      this.docker = true;
      await docker.ensureNetwork();
      console.log('  Docker is running now: servers start isolated in their own containers.');
    }
    return this.docker;
  }

  async init() {
    await fsp.mkdir(SERVERS, { recursive: true });
    await this.setupIsolation();
    let list = [];
    if (await exists(CONFIG_FILE)) {
      try {
        list = JSON.parse(await fsp.readFile(CONFIG_FILE, 'utf8')).servers || [];
      } catch (e) {
        console.error(`Could not read ${CONFIG_FILE}: ${e.message}`);
      }
    }
    for (const cfg of list) {
      try {
        getProvider(cfg.type);
      } catch {
        continue;
      }
      cfg.watches = cfg.watches || [];
      if (this.teamMode && !cfg.space) {
        // Servers from the old personal setup become the host admin's solo servers.
        cfg.space = 'solo';
        cfg.owner = cfg.owner || this.defaultOwner();
      }
      const inst = new Instance(this, cfg);
      this.instances.set(cfg.id, inst);
      if (cfg.lastPid && !this.docker) await this.cleanupOrphan(inst, cfg.lastPid);
      if (this.gameHost && !cfg.gateway) cfg.autoAddress = this.gameAddress(cfg.port);
    }
    await this.fixDuplicatePorts();
    this.memTimer = setInterval(() => this.pollMemory().catch(() => {}), 15000);
    this.backupTimer = setInterval(() => this.autoBackups().catch(() => {}), 10 * 60 * 1000);
    this.diskTimer = setInterval(() => this.pollDisk().catch(() => {}), 30 * 60 * 1000);
    setTimeout(() => this.pollDisk().catch(() => {}), 60000);
    // Bring servers back after a restart: the Gateway first, then servers marked "start automatically".
    const gw = this.gateway();
    if (gw && this.teamMode) setTimeout(() => gw.start(), 2000);
    let delay = 5000;
    for (const inst of this.instances.values()) {
      if (inst.cfg.autoStart && inst !== gw) {
        setTimeout(() => {
          inst.sysLog('Starting automatically (Settings → Start automatically).');
          inst.start();
        }, delay);
        delay += 10000; // stagger starts so they don't all load worlds at once
      }
    }
    this.watchTimer = setInterval(() => {
      for (const inst of this.instances.values()) inst.pollWatches().catch(() => {});
    }, 1500);
  }

  /** After merging setups two servers may share a port; move later ones to a free port. */
  async fixDuplicatePorts() {
    const seen = new Set();
    let changed = false;
    // Team servers keep their ports (their public tunnels point at them); solo servers move.
    const ordered = [...this.instances.values()].sort((a, b) => (a.cfg.space === 'solo') - (b.cfg.space === 'solo'));
    for (const inst of ordered) {
      if (seen.has(inst.cfg.port)) {
        let port = inst.cfg.port + 1;
        while (seen.has(port) || [...this.instances.values()].some((i) => i.cfg.port === port) || !(await isPortFree(port))) port++;
        inst.sysLog(`Port ${inst.cfg.port} was also used by another server, so this server now uses port ${port}.`);
        inst.cfg.port = port;
        inst.cfg.autoAddress = '';
        changed = true;
      }
      seen.add(inst.cfg.port);
    }
    if (changed) await this.saveNow();
  }

  /** Kills a server left running by a previous session that was closed abruptly. */
  async cleanupOrphan(inst, pid) {
    inst.cfg.lastPid = null;
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    try {
      if (process.platform === 'win32') {
        const { stdout } = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
        if (!/java/i.test(stdout)) return;
        await run('taskkill', ['/PID', String(pid), '/T', '/F']).catch(() => {});
      } else {
        process.kill(pid, 'SIGKILL');
      }
      inst.sysLog(`Stopped a leftover server process (PID ${pid}) from a previous session.`);
    } catch {
      /* ignore */
    }
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow().catch((e) => console.error('Save failed:', e.message)), 200);
  }

  async saveNow() {
    await fsp.mkdir(DATA, { recursive: true });
    const data = JSON.stringify({ servers: [...this.instances.values()].map((i) => i.cfg) }, null, 2);
    const tmp = CONFIG_FILE + '.tmp';
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, CONFIG_FILE);
  }

  // ----- Gateway -----

  gateway() {
    for (const inst of this.instances.values()) if (inst.cfg.gateway) return inst;
    return null;
  }

  /** Stable /server names for every server behind the Gateway (team servers first, then solo as owner-name). */
  gatewayNames() {
    const names = new Map();
    const used = new Set(['try']);
    const list = [...this.instances.values()]
      .filter((i) => i.canUseGateway)
      .sort((a, b) => (a.cfg.space === 'solo') - (b.cfg.space === 'solo') || a.cfg.createdAt - b.cfg.createdAt);
    for (const i of list) {
      let base = slug(i.cfg.name) || 'server';
      if (i.cfg.space === 'solo') base = `${slug(this.ownerName(i.cfg.owner)) || 'solo'}-${base}`;
      let name = base;
      for (let k = 2; used.has(name); k++) name = `${base}-${k}`;
      used.add(name);
      names.set(i, name);
    }
    return names;
  }

  gatewayName(inst) {
    return this.gatewayNames().get(inst) || null;
  }

  /** Servers for the Gateway's list, the chosen default server first. */
  gatewayBackends() {
    const gw = this.gateway();
    const def = gw && gw.cfg.gatewayDefault;
    return [...this.gatewayNames()]
      .map(([inst, name]) => ({ inst, name, port: inst.cfg.port }))
      .sort((a, b) => (b.inst.cfg.id === def) - (a.inst.cfg.id === def));
  }

  /** What a server's page shows about joining through the Gateway. */
  gatewayInfo(inst) {
    const gw = this.gateway();
    if (!gw || !inst.canUseGateway) return null;
    return {
      name: this.gatewayName(inst),
      address: gw.cfg.publicAddress || gw.cfg.autoAddress || null,
      port: gw.cfg.port,
      running: gw.status === 'running',
      applied: !!inst.cfg.gatewayApplied,
    };
  }

  /** Called whenever servers are added, changed or removed: keep the Gateway's list current. */
  serversChanged() {
    clearTimeout(this.gatewayTimer);
    this.gatewayTimer = setTimeout(() => {
      const gw = this.gateway();
      if (gw) gw.refreshGateway().catch((e) => gw.sysLog(`Could not update the Gateway: ${e.message}`));
      for (const inst of this.instances.values()) {
        if (inst.proc && inst.kind !== 'proxy' && !!(gw && inst.canUseGateway) !== !!inst.cfg.gatewayApplied && !inst.gatewayRestartNoted) {
          inst.gatewayRestartNoted = true;
          inst.sysLog(gw ? 'Restart this server once to put it behind the Gateway.' : 'Restart this server so players can join it directly again.');
        }
        inst.emitStatus();
      }
    }, 500);
  }

  get(id) {
    const inst = this.instances.get(id);
    if (!inst) throw Object.assign(new Error('Server not found'), { status: 404 });
    return inst;
  }

  list() {
    return [...this.instances.values()].map((i) => i.toJSON());
  }

  usedPorts(exceptId) {
    return new Set([...this.instances.values()].filter((i) => i.cfg.id !== exceptId).map((i) => i.cfg.port));
  }

  gameAddress(port) {
    return this.gameHost ? (port === 25565 ? this.gameHost : `${this.gameHost}:${port}`) : '';
  }

  async nextCustomerPort() {
    // A random free port in the range, so server addresses can't be guessed one after another.
    const used = this.usedPorts();
    const ports = [];
    for (let p = this.customerPorts.lo; p <= this.customerPorts.hi; p++) if (!used.has(p)) ports.push(p);
    for (let i = ports.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [ports[i], ports[j]] = [ports[j], ports[i]];
    }
    for (const p of ports) if (await isPortFree(p)) return p;
    throw Object.assign(new Error('No free ports left on this host. Contact support.'), { status: 503 });
  }

  /** Disk use of customer servers; servers over their plan's disk limit can't start until cleaned up. */
  async pollDisk() {
    for (const inst of this.instances.values()) {
      if (!inst.isCustomer) continue;
      inst.diskUsedMb = Math.round((await dirSize(inst.dir)) / 1048576);
      const plan = this.planInfo(inst);
      if (plan && plan.diskGb && inst.diskUsedMb > plan.diskGb * 1024 * 1.1 && inst.proc) {
        inst.sysLog(`This server uses ${(inst.diskUsedMb / 1024).toFixed(1)} GB, more than the ${plan.diskGb} GB in its plan. Stopping it. Delete old worlds, backups or logs in Files, then start it again.`);
        inst.stop();
      }
      inst.emitStatus();
    }
  }

  async nextFreePort(kind) {
    const used = this.usedPorts();
    for (let p = kind === 'proxy' ? 25577 : 25565; p < 26000; p++) {
      if (!used.has(p) && (await isPortFree(p))) return p;
    }
    return 25565;
  }

  validate(cfg) {
    const p = getProvider(cfg.type);
    if (!cfg.name || !String(cfg.name).trim()) throw new Error('Name is required');
    if (p.id !== 'custom' && !cfg.version) throw new Error('Pick a version');
    const port = Number(cfg.port);
    if (!(port > 0 && port < 65536)) throw new Error('Port must be between 1 and 65535');
    const mem = Number(cfg.memoryMb);
    if (!(mem >= 512 && mem <= 262144)) throw new Error('Memory must be at least 512 MB');
  }

  async create(body, { space, owner, createdBy, extra } = {}) {
    const type = String(body.type || '');
    const provider = getProvider(type);
    const name = String(body.name || `${provider.label} ${body.version || ''}`).trim();
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'server';
    const id = `${slug}-${crypto.randomBytes(2).toString('hex')}`;
    const cfg = {
      id,
      name,
      type,
      version: String(body.version || (type === 'bungeecord' ? 'latest' : '')),
      build: String(body.build || 'latest'),
      memoryMb: Number(body.memoryMb) || 2048,
      port: Number(body.port) || (await this.nextFreePort(provider.kind)),
      java: 'auto',
      jvmArgs: '',
      serverArgs: '',
      eula: !!body.eula,
      onlineMode: body.onlineMode !== false,
      customJar: body.customJar ? String(body.customJar).trim().replace(/^"|"$/g, '') : '',
      onPluginChange: 'restart',
      watches: [],
      createdAt: Date.now(),
      ...(space ? { space, owner: owner || null } : {}),
      ...(createdBy ? { createdBy } : {}),
      ...(body.gateway ? { gateway: true } : {}),
      ...(extra || {}),
    };
    if (space === 'customer') cfg.port = await this.nextCustomerPort();
    if (provider.kind === 'proxy' && !body.port && space !== 'customer') cfg.port = await this.nextFreePort('proxy');
    this.validate(cfg);
    if (this.gameHost) cfg.autoAddress = this.gameAddress(cfg.port);
    if (this.usedPorts().has(cfg.port)) throw new Error(`Port ${cfg.port} is already used by another server here`);
    const inst = new Instance(this, cfg);
    this.instances.set(id, inst);
    await this.saveNow();
    this.emit('status', inst);
    this.serversChanged();
    if (!cfg.isDemo) {
      inst
        .install()
        .then(() => (body.startAfterInstall ? inst.start() : null))
        .catch(() => {});
    }
    return inst;
  }

  async update(id, body) {
    const inst = this.get(id);
    const c = { ...inst.cfg };
    const fields = ['name', 'type', 'version', 'build', 'memoryMb', 'port', 'java', 'jvmArgs', 'serverArgs', 'eula', 'customJar', 'onPluginChange', 'clientVersion', 'publicAddress', 'autoStart', 'autoRestart', 'autoBackup', 'notes'];
    for (const f of fields) if (body[f] !== undefined) c[f] = body[f];
    c.memoryMb = Number(c.memoryMb);
    c.port = Number(c.port);
    c.eula = !!c.eula;
    c.build = String(c.build || 'latest');
    c.customJar = String(c.customJar || '').trim().replace(/^"|"$/g, '');
    c.java = String(c.java || 'auto').trim().replace(/^"|"$/g, '') || 'auto';
    if (!['restart', 'copy'].includes(c.onPluginChange)) c.onPluginChange = 'restart';
    c.clientVersion = String(c.clientVersion || 'auto').trim() || 'auto';
    c.publicAddress = String(c.publicAddress || '').trim().slice(0, 200);
    c.autoStart = !!c.autoStart;
    c.autoRestart = !!c.autoRestart;
    c.autoBackup = ['off', '6h', '12h', 'daily'].includes(c.autoBackup) ? c.autoBackup : 'off';
    c.notes = String(c.notes || '').slice(0, 2000);
    this.validate(c);
    if (c.port !== inst.cfg.port && this.usedPorts(id).has(c.port)) throw new Error(`Port ${c.port} is used by another server here`);
    if (c.type !== inst.cfg.type || c.version !== inst.cfg.version) c.javaMajor = null;
    Object.assign(inst.cfg, c);
    if (c.javaMajor === null) inst.javaMajor = null;
    this.save();
    inst.emitStatus();
    this.serversChanged();
    return inst;
  }

  async remove(id) {
    const inst = this.get(id);
    if (inst.proc || inst.status !== 'stopped') throw new Error('Stop the server before deleting it.');
    this.instances.delete(id);
    await this.saveNow();
    await fsp.rm(inst.dir, { recursive: true, force: true }).catch(() => {});
    await backups.removeAll(id);
    this.emit('removed', id);
    this.serversChanged();
  }

  addWatch(id, p) {
    const inst = this.get(id);
    const clean = String(p || '').trim().replace(/^"|"$/g, '');
    if (!clean || !path.isAbsolute(clean)) throw new Error('Enter the full path to your plugin jar or build folder');
    const w = { id: crypto.randomBytes(4).toString('hex'), path: path.normalize(clean), enabled: true };
    inst.cfg.watches.push(w);
    this.save();
    inst.emitStatus();
    if (inst.status === 'stopped') inst.syncWatchedPlugins().catch(() => {});
    return w;
  }

  updateWatch(id, wid, body) {
    const inst = this.get(id);
    const w = inst.cfg.watches.find((x) => x.id === wid);
    if (!w) throw new Error('Watch not found');
    if (body.enabled !== undefined) w.enabled = !!body.enabled;
    this.save();
    inst.emitStatus();
  }

  removeWatch(id, wid) {
    const inst = this.get(id);
    inst.cfg.watches = inst.cfg.watches.filter((w) => w.id !== wid);
    inst.watchState.delete(wid);
    this.save();
    inst.emitStatus();
  }

  // ----- Paper pre-build (shared per version) -----

  buildPaperclip(inst, shared) {
    this.paperclipJobs = this.paperclipJobs || new Map();
    if (!this.paperclipJobs.has(shared)) {
      const job = (async () => {
        const tmp = `${shared}.tmp-${crypto.randomBytes(3).toString('hex')}`;
        await fsp.mkdir(tmp, { recursive: true });
        try {
          await fsp.copyFile(path.join(inst.dir, 'server.jar'), path.join(tmp, 'server.jar'));
          inst.sysLog(`Preparing ${inst.provider.label} ${inst.cfg.version} (one time for this version, it can take a few minutes)...`);
          const major = await inst.provider.java(inst.cfg.version, inst.dir);
          const javaArgs = ['-Dpaperclip.patchonly=true', '-jar', 'server.jar'];
          if (this.docker) {
            const { image } = docker.imageFor(major);
            await docker.ensureImage(image, (m) => inst.sysLog(m));
            await docker.ensureNetwork();
            const args = docker.runArgs({ id: `prep-${crypto.randomBytes(3).toString('hex')}`, dir: tmp, port: 0, memLimitMb: 2048, cpus: null, image })
              .filter((a, i, all) => !(a === '-p' || all[i - 1] === '-p'))
              .filter((a) => a !== '-i');
            await run('docker', [...args, 'java', ...javaArgs], { timeout: 20 * 60 * 1000 });
          } else {
            const exe = await java.resolveJava(major, { log: (m) => inst.sysLog(m) });
            await run(exe, javaArgs, { cwd: tmp, timeout: 20 * 60 * 1000 });
          }
          if (!(await exists(path.join(tmp, 'versions')))) throw new Error('the server jar did not produce its files');
          await fsp.rm(path.join(tmp, 'server.jar'), { force: true });
          await fsp.rm(shared, { recursive: true, force: true });
          await fsp.rename(tmp, shared);
          inst.sysLog(`${inst.provider.label} ${inst.cfg.version} is prepared. New servers on this version start quickly.`);
        } finally {
          await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
          this.paperclipJobs.delete(shared);
        }
      })();
      this.paperclipJobs.set(shared, job);
    }
    return this.paperclipJobs.get(shared);
  }

  // ----- claims -----

  claim(id, user, { note, minutes }) {
    const inst = this.get(id);
    const mins = Math.min(Math.max(Number(minutes) || 60, 5), 24 * 60);
    inst.cfg.claim = {
      userId: user.id,
      username: user.username,
      note: String(note || '').trim().slice(0, 120),
      since: Date.now(),
      until: Date.now() + mins * 60000,
    };
    this.save();
    inst.emitStatus();
    return inst.cfg.claim;
  }

  release(id) {
    const inst = this.get(id);
    const had = inst.cfg.claim;
    inst.cfg.claim = null;
    this.save();
    inst.emitStatus();
    return had;
  }

  // ----- memory monitor -----

  /** Reads how much memory each running server's Java process really uses. */
  async pollMemory() {
    const running = [...this.instances.values()].filter((i) => i.proc && i.proc.pid);
    if (!running.length) return;
    const byPid = new Map();
    if (this.docker) {
      const byId = await docker.memoryByServer().catch(() => null);
      if (!byId) return;
      for (const i of running) {
        const mb = byId.get(i.cfg.id);
        if (byId.cpu && byId.cpu.has(i.cfg.id)) i.cpuPct = byId.cpu.get(i.cfg.id);
        if (mb && mb !== i.memUsedMb) {
          i.memUsedMb = mb;
          i.emitStatus();
        }
      }
      return;
    }
    try {
      if (process.platform === 'win32') {
        const { stdout } = await run('tasklist', ['/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq java.exe']);
        for (const line of stdout.split(/\r?\n/)) {
          const cols = line.split('","').map((x) => x.replace(/"/g, ''));
          if (cols.length >= 5) byPid.set(Number(cols[1]), Math.round(Number(cols[4].replace(/[^\d]/g, '')) / 1024));
        }
      } else {
        for (const i of running) {
          const st = await fsp.readFile(`/proc/${i.proc.pid}/status`, 'utf8').catch(() => '');
          const m = /VmRSS:\s+(\d+)/.exec(st);
          if (m) byPid.set(i.proc.pid, Math.round(Number(m[1]) / 1024));
        }
      }
    } catch {
      return;
    }
    for (const i of running) {
      const mb = byPid.get(i.proc.pid);
      if (mb && mb !== i.memUsedMb) {
        i.memUsedMb = mb;
        i.emitStatus();
      }
    }
  }

  // ----- automatic backups -----

  async autoBackups() {
    const every = { '6h': 6, '12h': 12, daily: 24 };
    for (const inst of this.instances.values()) {
      const hours = every[inst.cfg.autoBackup];
      if (!hours || inst.backingUp) continue;
      if (Date.now() - (inst.cfg.lastAutoBackup || 0) < hours * 3600 * 1000) continue;
      // Only back up servers that have been used since the last backup (or have never been backed up).
      inst.cfg.lastAutoBackup = Date.now();
      this.save();
      try {
        const b = await backups.create(inst, { automatic: true });
        inst.sysLog(`Automatic backup made (${(b.size / 1048576).toFixed(1)} MB).`);
      } catch (e) {
        if (!/Nothing to back up/.test(e.message)) inst.sysLog(`Automatic backup failed: ${e.message}`);
      }
    }
  }

  /** Graceful shutdown of every running server (used when the app exits). */
  async shutdownAll(timeoutMs = 9000) {
    const running = [...this.instances.values()].filter((i) => i.proc);
    if (!running.length) return;
    for (const i of running) i.stop();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && running.some((i) => i.proc)) await new Promise((r) => setTimeout(r, 200));
    for (const i of running) if (i.proc) i.kill();
    await new Promise((r) => setTimeout(r, 300));
    await this.saveNow().catch(() => {});
  }
}

module.exports = { Manager, readPluginMeta, _safety: { assertNoLinks, removeSymlinks, readInside } };
