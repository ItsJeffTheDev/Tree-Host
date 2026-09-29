'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const { SERVERS, CONFIG_FILE, DATA } = require('./paths');
const { getProvider } = require('./providers');
const java = require('./java');
const client = require('./client');
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
      gatewayDefault: c.gatewayDefault || null,
      gateway: this.manager.gatewayInfo(this),
      owner: c.owner || null,
      createdBy: c.createdBy || null,
      createdByName: c.createdBy ? this.manager.ownerName(c.createdBy) : null,
      ownerName: c.owner ? this.manager.ownerName(c.owner) : null,
      publicAddress: c.publicAddress || c.autoAddress || '',
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
      dir: this.dir,
      status: this.status,
      progress: this.progress,
      players: [...this.players],
      pid: this.proc ? this.proc.pid : null,
      startedAt: this.startedAt,
      createdAt: c.createdAt,
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
    const line = { s: ++this.seq, t: text };
    this.logs.push(line);
    if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
    this.manager.emit('log', this.cfg.id, line);
  }

  sysLog(msg) {
    this.appendLog(`[Honey Host] ${msg}`);
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
      this.save();
      this.sysLog('Installation complete.');
    } catch (e) {
      this.sysLog(`Installation failed: ${e.message}`);
      throw e;
    } finally {
      if (!fromStart) this.setStatus('stopped');
    }
  }

  async writeInitialFiles() {
    await fsp.mkdir(this.pluginDir, { recursive: true });
    if (this.kind === 'proxy') return;
    const propsFile = path.join(this.dir, 'server.properties');
    if (!(await exists(propsFile))) {
      await fsp.writeFile(
        propsFile,
        updateProperties('#Minecraft server properties (created by Honey Host)\n', {
          'server-port': this.cfg.port,
          'online-mode': this.cfg.onlineMode === false ? 'false' : 'true',
          motd: `${this.cfg.name} - plugin test server`,
          'enable-command-block': 'true',
          'spawn-protection': '0',
          ...(this.manager.teamMode ? { 'white-list': 'true', 'enforce-whitelist': 'true' } : {}),
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
        '# Accepted via Honey Host (https://aka.ms/MinecraftEULA)\neula=true\n',
      );
      const propsFile = path.join(this.dir, 'server.properties');
      const text = (await exists(propsFile)) ? await fsp.readFile(propsFile, 'utf8') : '';
      await fsp.writeFile(propsFile, updateProperties(text, { 'server-port': port }));
      await this.applyGatewayBackend();
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
        await fsp.writeFile(velocityToml, text);
      }
    } else {
      const cfgYml = path.join(this.dir, 'config.yml');
      if (await exists(cfgYml)) {
        const text = await fsp.readFile(cfgYml, 'utf8');
        await fsp.writeFile(
          cfgYml,
          text
            .replace(/^(\s*host:\s*)[^\s#]+/m, `$10.0.0.0:${port}`)
            .replace(/^online_mode:.*$/m, `online_mode: ${this.cfg.onlineMode !== false}`),
        );
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

  // ----- Gateway (one Velocity proxy in front of every server) -----

  /**
   * Only Bukkit-type servers (Paper, Purpur, Folia, Spigot, CraftBukkit) understand the Gateway's player forwarding.
   * Vanilla and Fabric servers stay standalone and are joined directly.
   */
  get canUseGateway() {
    return this.kind !== 'proxy' && !this.cfg.gateway && this.provider.family === 'bukkit';
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
      .replace(/^motd\s*=.*$/m, 'motd = "<#f5b50a>Honey Host <gray>by Honey Pixel Studios"');
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

  async start() {
    if (this.proc || this.status !== 'stopped') return;
    this.status = 'starting';
    this.progress = null;
    this.emitStatus();
    try {
      if (await this.needsInstall()) await this.install({ fromStart: true });
      this.status = 'starting';
      this.progress = { label: 'Preparing Java...', done: 0, total: 0 };
      this.emitStatus();
      await this.prepareConfigFiles();
      await this.cleanupFailedSaves();
      if (!(await isPortFree(this.cfg.port))) {
        throw new Error(`Port ${this.cfg.port} is already in use (another server running?). Change it in Settings.`);
      }
      await this.syncWatchedPlugins();
      const javaExe = await this.resolveJavaExe();
      this.progress = null;
      this.spawnServer(javaExe);
    } catch (e) {
      this.sysLog(`Could not start: ${e.message}`);
      this.setStatus('stopped');
    }
  }

  spawnServer(javaExe) {
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
    this.sysLog(`Starting with Java ${this.javaMajor || '?'}: ${javaExe === 'java' ? 'java' : javaExe} ${args.join(' ')}`);
    const proc = spawn(javaExe, args, { cwd: this.dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    this.startedAt = Date.now();
    this.players.clear();
    this.status = 'starting';
    this.emitStatus();

    const onLine = (l) => this.handleLine(l);
    readline.createInterface({ input: proc.stdout }).on('line', onLine);
    readline.createInterface({ input: proc.stderr }).on('line', onLine);
    proc.stdin.on('error', () => {});

    proc.on('error', (e) => {
      this.sysLog(`Failed to launch Java: ${e.message}`);
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
      if (expected || code === 0) this.sysLog(`Server stopped${code != null ? ` (exit code ${code})` : ''}.`);
      else this.sysLog(`Server exited unexpectedly (${signal || `exit code ${code}`}). Check the log above for errors.`);
      this.setStatus('stopped');
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
    if (this.status === 'starting' && (/Done \([\d.,]+m?s\)!/.test(line) || /Listening on \//.test(line))) {
      this.setStatus('running');
      const addr = this.cfg.port === 25565 ? '127.0.0.1' : `127.0.0.1:${this.cfg.port}`;
      this.sysLog(`Ready! In Minecraft go to Multiplayer → Add Server and use the address: ${this.cfg.publicAddress || addr}`);
      if (this.manager.teamMode && this.kind !== 'proxy') this.teamAccess({ op: false, quiet: true });
      const gw = this.manager.gateway();
      if (this.manager.teamMode && this.manager.playit && this.manager.playit.configured && !this.cfg.publicAddress && (!gw || gw === this || !this.canUseGateway)) {
        this.shareOnline().catch((e) => this.sysLog(`Could not get a public address from playit.gg: ${e.message}`));
      }
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

  /** Creates (or reuses) this server's playit.gg tunnel and remembers its public address. */
  async shareOnline() {
    const playit = this.manager.playit;
    if (!playit || !playit.configured) throw new Error('Connect playit.gg first (Team → Public game addresses).');
    const { address: addr, proxyProtocol } = await playit.ensureTunnel(this.cfg.port, `Honey Host: ${this.cfg.name}`.slice(0, 60));
    if (proxyProtocol) {
      this.sysLog(
        `WARNING: the playit.gg tunnel for port ${this.cfg.port} has Proxy Protocol "${proxyProtocol}" turned on, so players can't join. ` +
          'Set it to none on playit.gg (your tunnel → Origin Config → Proxy Protocol).',
      );
    }
    if (this.cfg.autoAddress !== addr) {
      this.cfg.autoAddress = addr;
      this.save();
    }
    this.sysLog(`Public join address (playit.gg): ${addr}`);
    this.emitStatus();
    return addr;
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
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(this.proc.pid), '/T', '/F'], { windowsHide: true });
    } else {
      this.proc.kill('SIGKILL');
    }
  }

  write(cmd) {
    if (!this.proc) throw new Error('Server is not running.');
    this.proc.stdin.write(cmd.replace(/^\//, '') + '\n');
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
    this.appendLog(`[Honey Host] ${msg}`);
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
        this.appendLog(`[Honey Host] Launched Minecraft ${version} (Java ${prep.major}) as ${username}, joining 127.0.0.1:${this.cfg.port}...`);
        proc.on('error', (e) => this.appendLog(`[Honey Host] Minecraft client failed to start: ${e.message}`));
        proc.on('exit', (code) => {
          this.clientsRunning = Math.max(0, this.clientsRunning - 1);
          if (code === 0) this.appendLog(`[Honey Host] Minecraft client (${username}) closed.`);
          else {
            this.appendLog(`[Honey Host] Minecraft client (${username}) crashed with exit code ${code}. Last output:`);
            for (const l of proc.tail.slice(-15)) this.appendLog(`[Honey Host]   ${l}`);
          }
          this.emitStatus();
        });
      } catch (e) {
        this.appendLog(`[Honey Host] Could not launch Minecraft: ${e.message}`);
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
    await fsp.mkdir(this.pluginDir, { recursive: true });
    const out = [];
    for (const file of await fsp.readdir(this.pluginDir)) {
      const lower = file.toLowerCase();
      if (!lower.endsWith('.jar') && !lower.endsWith('.jar.disabled')) continue;
      const full = path.join(this.pluginDir, file);
      const st = await fsp.stat(full).catch(() => null);
      if (!st || !st.isFile()) continue;
      out.push({
        file,
        enabled: lower.endsWith('.jar'),
        size: st.size,
        mtime: st.mtimeMs,
        watched: this.cfg.watches.some((w) => w.lastCopied === file),
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
    if (!file.toLowerCase().endsWith('.jar')) throw new Error('Only .jar files can be deployed');
    if (!this.proc && this.status !== 'stopped') throw new Error(`The server is busy (${this.status}). Try again in a moment.`);
    await fsp.mkdir(this.pluginDir, { recursive: true });
    const tmp = path.join(this.dir, `.deploy-${Date.now()}.jar`);
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      stream.pipe(out);
      stream.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
    });
    const meta = await readPluginMeta(tmp);
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
        if (p.name === meta.name && p.file !== file) {
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
    const restarted = wasRunning && restart;
    if (restarted) this.start();
    return { file, plugin: meta.name || null, version: meta.version || null, replaced, restarted };
  }

  async savePluginUpload(name, stream) {
    const file = safeFileName(name);
    if (!file.toLowerCase().endsWith('.jar')) throw new Error('Only .jar files can be uploaded');
    await fsp.mkdir(this.pluginDir, { recursive: true });
    const dest = path.join(this.pluginDir, file);
    const tmp = dest + '.upload';
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      stream.pipe(out);
      stream.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
    });
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
    const target = file.toLowerCase().endsWith('.disabled') ? full.slice(0, -'.disabled'.length) : full + '.disabled';
    await fsp.rename(full, target).catch((e) => {
      if (e.code === 'EBUSY' || e.code === 'EPERM') throw new Error('The plugin is in use. Stop the server first.');
      throw e;
    });
  }

  async deletePlugin(file) {
    file = safeFileName(file);
    await fsp.rm(path.join(this.pluginDir, file)).catch((e) => {
      if (e.code === 'EBUSY' || e.code === 'EPERM') throw new Error('The plugin is in use. Stop the server first.');
      throw e;
    });
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
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      const st = await fsp.stat(path.join(dir, e.name)).catch(() => null);
      if (!st) continue;
      out.push({ name: e.name, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs });
    }
    return out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  }

  async readFile(rel) {
    const file = this.resolvePath(rel);
    const st = await fsp.stat(file);
    if (st.isDirectory()) throw new Error('That is a folder');
    if (st.size > 2 * 1024 * 1024) throw new Error('File is too large to edit here (over 2 MB)');
    const buf = await fsp.readFile(file);
    if (buf.includes(0)) throw new Error('Binary files cannot be edited here');
    return buf.toString('utf8');
  }

  async writeFile(rel, content) {
    const file = this.resolvePath(rel);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, String(content));
  }

  async deleteFile(rel) {
    const file = this.resolvePath(rel);
    if (file === path.resolve(this.dir)) throw new Error('Cannot delete the server folder here');
    await fsp.rm(file, { recursive: true });
  }

  async getProperties() {
    const f = path.join(this.dir, 'server.properties');
    return (await exists(f)) ? parseProperties(await fsp.readFile(f, 'utf8')) : {};
  }

  async setProperties(updates) {
    const f = path.join(this.dir, 'server.properties');
    const clean = {};
    for (const [k, v] of Object.entries(updates || {})) {
      if (!/^[\w.-]+$/.test(k)) continue;
      clean[k] = String(v).replace(/[\r\n]/g, ' ');
    }
    if ('server-port' in clean) {
      const port = Number(clean['server-port']);
      if (port > 0 && port < 65536) this.cfg.port = port;
      this.save();
    }
    if ('online-mode' in clean) this.cfg.onlineMode = clean['online-mode'] !== 'false';
    const text = (await exists(f)) ? await fsp.readFile(f, 'utf8') : '';
    await fsp.mkdir(this.dir, { recursive: true });
    await fsp.writeFile(f, updateProperties(text, clean));
  }

  async resetWorlds() {
    if (this.proc || this.status !== 'stopped') throw new Error('Stop the server first.');
    const level = (await this.getProperties())['level-name'] || 'world';
    const removed = [];
    for (const name of [level, `${level}_nether`, `${level}_the_end`]) {
      const p = this.resolvePath(name);
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
    this.playit = null;
    this.accessNames = () => [];
    this.ownerName = () => null;
    this.defaultOwner = () => null;
    this.teamMcNames = () => [];
  }

  async init() {
    await fsp.mkdir(SERVERS, { recursive: true });
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
      if (cfg.lastPid) await this.cleanupOrphan(inst, cfg.lastPid);
    }
    await this.fixDuplicatePorts();
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

  async create(body, { space, owner, createdBy } = {}) {
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
    };
    if (provider.kind === 'proxy' && !body.port) cfg.port = await this.nextFreePort('proxy');
    this.validate(cfg);
    if (this.usedPorts().has(cfg.port)) throw new Error(`Port ${cfg.port} is already used by another server here`);
    const inst = new Instance(this, cfg);
    this.instances.set(id, inst);
    await this.saveNow();
    this.emit('status', inst);
    this.serversChanged();
    inst
      .install()
      .then(() => (body.startAfterInstall ? inst.start() : null))
      .catch(() => {});
    return inst;
  }

  async update(id, body) {
    const inst = this.get(id);
    const c = { ...inst.cfg };
    const fields = ['name', 'type', 'version', 'build', 'memoryMb', 'port', 'java', 'jvmArgs', 'serverArgs', 'eula', 'customJar', 'onPluginChange', 'clientVersion', 'publicAddress', 'autoStart'];
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

module.exports = { Manager };
