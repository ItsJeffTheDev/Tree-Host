'use strict';
// The shared demo server: a Paper server that only exists on screen. No Java runs and nothing is downloaded.
// Anyone exploring Tree Host can start, stop and restart it, and type commands; it answers like Paper would,
// with a realistic boot log, players who come and go, chat, and believable memory/CPU numbers for the charts.
// It sits on a real Instance (cfg.isDemo), replacing the methods that would touch a process or the disk.

const PLAYERS = ['Steve_Builds', 'AlexMines', 'CraftyFox', 'PixelPanda', 'RedstoneRay', 'BlockyBella', 'NetherNate', 'EnderEmma', 'MossyMarco', 'TorchTina'];
const CHAT = [
  'anyone want to go to the nether?', 'found diamonds!!', 'this server runs so smooth', 'brb', 'gg',
  'who built the castle at spawn?', 'can someone trade me some iron', 'the sunset here is great', 'lol', 'back',
  'is there a shop?', 'my farm finally works', 'watch out, creepers near spawn', 'nice tps today',
];
const ADVANCEMENTS = ['Stone Age', 'Acquire Hardware', 'Diamonds!', 'We Need to Go Deeper', 'Hot Stuff', 'Getting an Upgrade', 'Sweet Dreams'];
const ITEM = (id) => id.replace(/^minecraft:/, '').split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const MODES = { survival: 'Survival', creative: 'Creative', adventure: 'Adventure', spectator: 'Spectator', s: 'Survival', c: 'Creative', a: 'Adventure', sp: 'Spectator', 0: 'Survival', 1: 'Creative', 2: 'Adventure', 3: 'Spectator' };
const RESTART_AFTER = 2 * 60 * 1000; // stopped by a visitor: running again for the next one after this long
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const between = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class DemoSim {
  constructor(inst) {
    this.inst = inst;
    this.alive = false; // "the process is running" (starting, running or stopping)
    this.run = 0; // bumps on every start/stop so old timers know they're stale
    this.timers = new Set();
    this.ops = new Set(['TreeHostAdmin']);
    this.time = 6000;
    this.weather = 'clear';
    this.difficulty = 'easy';
    // What would need a process or touches files does nothing on the demo.
    inst.start = () => this.start();
    inst.stop = () => this.stop();
    inst.restart = () => this.restart();
    inst.kill = () => this.stop({ kill: true });
    inst.command = (cmd) => this.command(cmd);
    inst.install = async () => inst.sysLog('The demo server has nothing to install.');
    inst.resetWorlds = async () => {
      throw new Error("The demo server's world can't be reset.");
    };
    inst.maxPlayers = 20;
    inst.diskUsedMb = 184;
    this.seedStats();
    this.later(() => this.start({ quiet: true }), 1500); // running when the first visitor arrives
  }

  later(fn, ms, run = this.run) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (run === this.run) fn();
    }, ms);
    this.timers.add(t);
  }

  clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  log(text, level = 'INFO') {
    const d = new Date();
    const ts = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
    this.inst.appendLog(`[${ts} ${level}]: ${text}`);
  }

  // ---------- start / stop ----------

  async start({ quiet = false } = {}) {
    if (this.alive) return;
    const run = ++this.run;
    this.clearTimers();
    this.alive = true;
    const inst = this.inst;
    inst.players.clear();
    inst.startedAt = Date.now();
    inst.memUsedMb = 180;
    inst.cpuPct = 60;
    inst.setStatus('starting');
    if (!quiet) inst.sysLog('Starting the demo server (simulated: no real Minecraft runs here).');
    const plugins = (await inst.listPlugins().catch(() => [])).filter((p) => p.enabled && p.name);
    const t0 = Date.now();
    const steps = [
      [250, `Starting minecraft server version ${inst.cfg.version}`],
      [120, 'Loading properties'],
      [120, `This server is running Paper version ${inst.cfg.version}-130-main@b48403b (MC: ${inst.cfg.version})`],
      [150, `Server Ping Player Sample Count: 12`],
      [200, 'Using 4 threads for Netty based IO'],
      [300, `[bootstrap] Running Java 21 (OpenJDK 64-Bit Server VM 21.0.4+7-LTS; Eclipse Adoptium Temurin-21.0.4+7) on Linux 6.1.0 (amd64)`],
      [250, `[bootstrap] Loading Paper ${inst.cfg.version}-130-main@b48403b for Minecraft ${inst.cfg.version}`],
      ...plugins.map((p) => [120, `[${p.name}] Loading server plugin ${p.name} v${p.version || '1.0'}`]),
      [200, 'Default game type: SURVIVAL'],
      [150, 'Generating keypair'],
      [150, `Starting Minecraft server on *:${inst.cfg.port}`],
      [150, 'Using epoll channel type'],
      [200, 'Paper: Using libdeflate (Linux x86_64) compression from Velocity.'],
      [200, 'Paper: Using OpenSSL 3.x.x (Linux x86_64) cipher from Velocity.'],
      ...plugins.map((p) => [140, `[${p.name}] Enabling ${p.name} v${p.version || '1.0'}`]),
      [250, 'Preparing level "world"'],
      [400, 'Preparing start region for dimension minecraft:overworld'],
      [350, 'Time elapsed: 1214 ms'],
      [300, 'Preparing start region for dimension minecraft:the_nether'],
      [250, 'Time elapsed: 402 ms'],
      [250, 'Preparing start region for dimension minecraft:the_end'],
      [200, 'Time elapsed: 158 ms'],
      [150, 'Running delayed init tasks'],
    ];
    for (const [ms, line] of steps) {
      await sleep(ms);
      if (run !== this.run) return;
      this.log(line);
      inst.memUsedMb = Math.min(620, inst.memUsedMb + 18);
    }
    if (run !== this.run) return;
    this.log(`Done (${((Date.now() - t0) / 1000).toFixed(3)}s)! For help, type "help"`);
    inst.cpuPct = 9;
    inst.setStatus('running');
    this.tick();
    this.later(() => this.visitor(), between(4000, 9000));
  }

  async stop({ kill = false } = {}) {
    if (!this.alive || this.inst.status === 'stopping') return;
    const run = ++this.run;
    this.clearTimers();
    const inst = this.inst;
    inst.setStatus('stopping');
    if (kill) inst.sysLog('Force-stopped the demo server.');
    else {
      this.log('Stopping the server');
      this.log('Stopping server');
      for (const n of [...inst.players]) this.log(`${n} lost connection: Server closed`);
      inst.players.clear();
      await sleep(300);
      for (const w of ['world', 'world_nether', 'world_the_end']) {
        if (run !== this.run) return;
        this.log(`Saving chunks for level 'ServerLevel[${w}]'/minecraft:${w === 'world' ? 'overworld' : w.replace('world_', '')}`);
        await sleep(250);
      }
      this.log('ThreadedAnvilChunkStorage: All dimensions are saved');
      await sleep(250);
    }
    if (run !== this.run) return;
    inst.players.clear();
    this.alive = false;
    inst.startedAt = null;
    inst.memUsedMb = null;
    inst.cpuPct = null;
    inst.setStatus('stopped');
    inst.sysLog(`The demo server stopped. It starts again by itself in ${RESTART_AFTER / 60000} minutes, so the next visitor finds it running.`);
    this.later(() => this.start({ quiet: true }), RESTART_AFTER, run);
  }

  async restart() {
    await this.stop();
    await sleep(500);
    await this.start();
  }

  // ---------- life on the server ----------

  /** Memory and CPU drift a little every few seconds, like a real JVM. */
  tick() {
    const inst = this.inst;
    if (inst.status === 'running') {
      const target = 520 + inst.players.size * 45;
      inst.memUsedMb = Math.round(Math.max(420, Math.min(900, inst.memUsedMb + (target - inst.memUsedMb) * 0.2 + between(-25, 25))));
      inst.cpuPct = Math.round(Math.max(2, 6 + inst.players.size * 4 + between(-3, 5)) * 10) / 10;
      this.time = (this.time + 100) % 24000;
      inst.emitStatus();
    }
    this.later(() => this.tick(), 5000);
  }

  /** Someone joins, leaves, chats or earns an advancement every so often. */
  visitor() {
    const inst = this.inst;
    if (inst.status !== 'running') return;
    const online = [...inst.players];
    const offline = PLAYERS.filter((n) => !inst.players.has(n));
    const r = Math.random();
    if ((online.length < 2 || r < 0.3) && online.length < 5 && offline.length) {
      const n = pick(offline);
      inst.players.add(n);
      this.log(`${n}[/203.0.113.${Math.floor(between(2, 250))}:${Math.floor(between(40000, 60000))}] logged in with entity id ${Math.floor(between(100, 9000))} at ([world]${between(-200, 200).toFixed(1)}, 64.0, ${between(-200, 200).toFixed(1)})`);
      this.log(`${n} joined the game`);
      inst.emitStatus();
    } else if (r < 0.45 && online.length > 1) {
      const n = pick(online);
      inst.players.delete(n);
      this.log(`${n} lost connection: Disconnected`);
      this.log(`${n} left the game`);
      inst.emitStatus();
    } else if (r < 0.85 && online.length) {
      this.log(`<${pick(online)}> ${pick(CHAT)}`);
    } else if (online.length) {
      this.log(`${pick(online)} has made the advancement [${pick(ADVANCEMENTS)}]`);
    }
    this.later(() => this.visitor(), between(12000, 35000));
  }

  /** An hour of history, so the Performance tab has something to show straight away. */
  seedStats() {
    const now = Date.now();
    let mem = 560;
    this.inst.stats = [];
    for (let i = 60; i >= 1; i--) {
      const players = Math.max(0, Math.round(2 + Math.sin(i / 9) * 2 + between(-0.6, 0.6)));
      mem = Math.max(450, Math.min(820, mem + (520 + players * 45 - mem) * 0.3 + between(-20, 20)));
      this.inst.stats.push({ t: now - i * 60000, mem: Math.round(mem), cpu: Math.round((6 + players * 4 + between(-2, 4)) * 10) / 10, players });
    }
  }

  // ---------- commands ----------

  command(raw) {
    const cmd = String(raw || '').trim().replace(/^\//, '').slice(0, 120);
    if (!cmd) return;
    if (!this.alive || this.inst.status !== 'running') throw new Error('Server is not running.');
    this.inst.appendLog(`> ${cmd}`);
    const run = this.run;
    this.later(() => this.answer(cmd), between(60, 220), run);
  }

  player(name) {
    if (!name) return null;
    return [...this.inst.players].find((p) => p.toLowerCase() === name.toLowerCase()) || null;
  }

  async answer(cmd) {
    const inst = this.inst;
    const [name, ...args] = cmd.split(/\s+/);
    const c = name.toLowerCase().replace(/^(minecraft|bukkit|paper):/, '');
    const online = [...inst.players];
    const noPlayer = () => this.log('No player was found');
    switch (c) {
      case 'help':
      case '?':
        this.log('--------- Help: Demo server ---------');
        this.log('Try: list, tps, mspt, version, plugins, say <message>, time set <day|night>, weather <clear|rain|thunder>,');
        this.log('difficulty <level>, gamemode <mode> <player>, give <player> <item> [amount], kick <player>, op <player>,');
        this.log('whitelist <on|off|list|add>, seed, save-all, stop');
        return;
      case 'list':
        return this.log(`There are ${online.length} of a max of ${inst.maxPlayers} players online: ${online.join(', ')}`);
      case 'tps': {
        const t = () => Math.min(20, 19.9 + Math.random() * 0.15).toFixed(2);
        return this.log(`TPS from last 1m, 5m, 15m: 20.0, ${t()}, ${t()}`);
      }
      case 'mspt': {
        const m = () => `${between(2, 6).toFixed(1)}/${between(0.4, 1.5).toFixed(1)}/${between(8, 24).toFixed(1)}`;
        this.log('Server tick times (avg/min/max) from last 5s, 10s, 1m:');
        return this.log(`◴ ${m()}, ${m()}, ${m()}`);
      }
      case 'version':
      case 'ver':
      case 'about':
        this.log(`This server is running Paper version ${inst.cfg.version}-130-main@b48403b (MC: ${inst.cfg.version}) (Implementing API version ${inst.cfg.version}-R0.1-SNAPSHOT)`);
        return this.log('You are running the latest version');
      case 'plugins':
      case 'pl': {
        const ps = (await inst.listPlugins().catch(() => [])).filter((p) => p.enabled && p.name);
        this.log(`Server Plugins (${ps.length}):`);
        this.log('Bukkit Plugins:');
        return this.log(` - ${ps.map((p) => p.name).join(', ')}`);
      }
      case 'say':
        return args.length ? this.log(`[Server] ${args.join(' ')}`) : this.log('Usage: /say <message>');
      case 'time': {
        const named = { day: 1000, noon: 6000, night: 13000, midnight: 18000 };
        if (args[0] === 'set' && args[1] !== undefined) {
          const v = named[args[1]] ?? Number(args[1]);
          if (!Number.isFinite(v)) return this.log(`Invalid time: ${args[1]}`, 'WARN');
          this.time = Math.round(v) % 24000;
          return this.log(`Set the time to ${this.time}`);
        }
        if (args[0] === 'query') return this.log(`The time is ${this.time}`);
        return this.log('Usage: /time <set|query> <value>');
      }
      case 'weather':
        if (!['clear', 'rain', 'thunder'].includes(args[0])) return this.log('Usage: /weather <clear|rain|thunder>');
        this.weather = args[0];
        return this.log(`Set the weather to ${{ clear: 'clear', rain: 'rain', thunder: 'rain & thunder' }[args[0]]}`);
      case 'difficulty':
        if (!args[0]) return this.log(`The difficulty is ${this.difficulty[0].toUpperCase()}${this.difficulty.slice(1)}`);
        if (!['peaceful', 'easy', 'normal', 'hard'].includes(args[0])) return this.log(`Invalid difficulty: ${args[0]}`, 'WARN');
        this.difficulty = args[0];
        return this.log(`The difficulty has been set to ${args[0][0].toUpperCase()}${args[0].slice(1)}`);
      case 'gamemode': {
        const mode = MODES[String(args[0] || '').toLowerCase()];
        if (!mode) return this.log('Usage: /gamemode <survival|creative|adventure|spectator> <player>');
        const p = this.player(args[1]);
        return p ? this.log(`Set ${p}'s game mode to ${mode} Mode`) : noPlayer();
      }
      case 'give': {
        const p = this.player(args[0]);
        if (!p) return args[0] ? noPlayer() : this.log('Usage: /give <player> <item> [amount]');
        if (!args[1] || !/^[a-z0-9_:]+$/i.test(args[1])) return this.log(`Unknown item '${args[1] || ''}'`);
        const n = Math.max(1, Math.min(6400, Number(args[2]) || 1));
        return this.log(`Gave ${n} [${ITEM(args[1].toLowerCase())}] to ${p}`);
      }
      case 'kick': {
        const p = this.player(args[0]);
        if (!p) return args[0] ? noPlayer() : this.log('Usage: /kick <player> [reason]');
        inst.players.delete(p);
        this.log(`Kicked ${p}: ${args.slice(1).join(' ') || 'Kicked by an operator'}`);
        this.log(`${p} left the game`);
        return inst.emitStatus();
      }
      case 'op':
      case 'deop': {
        if (!args[0] || !/^[A-Za-z0-9_]{3,16}$/.test(args[0])) return this.log(`Usage: /${c} <player>`);
        const has = this.ops.has(args[0]);
        if (c === 'op') return has ? this.log('Nothing changed. The player already is an operator') : (this.ops.add(args[0]), this.log(`Made ${args[0]} a server operator`));
        return !has ? this.log('Nothing changed. The player is not an operator') : (this.ops.delete(args[0]), this.log(`Made ${args[0]} no longer a server operator`));
      }
      case 'whitelist':
        if (args[0] === 'on') return this.log('Whitelist is now turned on');
        if (args[0] === 'off') return this.log('Whitelist is now turned off');
        if (args[0] === 'list') return this.log('There are no whitelisted players');
        if (args[0] === 'add' && args[1]) return this.log(`Added ${args[1]} to the whitelist`);
        return this.log('Usage: /whitelist <on|off|list|add <player>>');
      case 'seed':
        return this.log('Seed: [-4172144997902289642]');
      case 'save-all':
        this.log('Saving the game (this may take a moment!)');
        await sleep(400);
        return this.log('Saved the game');
      case 'stop':
        return this.stop();
      case 'restart':
        return this.restart();
      case 'reload':
      case 'rl':
        return this.log('Reloading is turned off on the demo server. Use Restart instead.', 'WARN');
      default:
        this.log('Unknown or incomplete command, see below for error');
        return this.log(`${cmd.slice(0, 40)}<--[HERE]  (type "help" for the commands the demo knows)`);
    }
  }
}

module.exports = { DemoSim };
