'use strict';
// The Players tab: who's online and since when, everyone who has played (first and last seen, total playtime), a
// searchable chat log, and the server's own whitelist, ops and ban list (read from its files). Join, leave and chat
// lines come from the console (Instance#handleLine emits 'line'); playtime is kept per server in DATA/players/.

const fsp = require('fs').promises;
const path = require('path');
const { DATA } = require('./paths');

const DIR = path.join(DATA, 'players');
const MAX_CHAT = 500;
const NAME = /^[A-Za-z0-9_.]{1,16}$/; // Java names, plus Bedrock (Geyser/Floodgate) names that start with a dot

const JOIN = /: ([A-Za-z0-9_.]{1,16}) joined the game/;
const LEAVE = /: ([A-Za-z0-9_.]{1,16}) left the game/;
// Vanilla/Paper chat: "<Steve> hi", with "[Not Secure] " in front when chat signing is off
const CHAT = /: (?:\[Not Secure\] )?<([A-Za-z0-9_.]{1,16})> (.+)$/;

class Players {
  constructor() {
    this.cache = new Map(); // server id -> { players: { name: {...} }, chat: [] }
    this.timers = new Map();
  }

  async load(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    let d = { players: {}, chat: [] };
    try {
      d = { players: {}, chat: [], ...JSON.parse(await fsp.readFile(path.join(DIR, `${id}.json`), 'utf8')) };
    } catch {}
    this.cache.set(id, d);
    return d;
  }

  save(id) {
    clearTimeout(this.timers.get(id));
    this.timers.set(id, setTimeout(async () => {
      await fsp.mkdir(DIR, { recursive: true });
      await fsp.writeFile(path.join(DIR, `${id}.json`), JSON.stringify(this.cache.get(id))).catch(() => {});
    }, 2000));
  }

  /** Called for every console line of every server. */
  async onLine(inst, line) {
    if (inst.kind === 'proxy') return;
    let m = JOIN.exec(line);
    const now = Date.now();
    if (m) {
      const d = await this.load(inst.cfg.id);
      const p = (d.players[m[1]] = d.players[m[1]] || { first: now, playMs: 0, sessions: 0 });
      p.joinAt = now;
      p.last = now;
      p.sessions += 1;
      this.save(inst.cfg.id);
      return;
    }
    m = LEAVE.exec(line);
    if (m) {
      const d = await this.load(inst.cfg.id);
      const p = d.players[m[1]];
      if (p && p.joinAt) {
        p.playMs += now - p.joinAt;
        p.joinAt = null;
        p.last = now;
        this.save(inst.cfg.id);
      }
      return;
    }
    m = CHAT.exec(line);
    if (m) {
      const d = await this.load(inst.cfg.id);
      d.chat.push({ t: now, name: m[1], text: m[2].slice(0, 400) });
      if (d.chat.length > MAX_CHAT) d.chat.splice(0, d.chat.length - MAX_CHAT);
      this.save(inst.cfg.id);
    }
  }

  /** A server stopped: close everyone's session so playtime doesn't keep counting. */
  async onStopped(inst) {
    const d = await this.load(inst.cfg.id);
    const now = Date.now();
    let changed = false;
    for (const p of Object.values(d.players)) {
      if (p.joinAt) {
        p.playMs += now - p.joinAt;
        p.joinAt = null;
        p.last = now;
        changed = true;
      }
    }
    if (changed) this.save(inst.cfg.id);
  }

  async readList(inst, file) {
    try {
      const list = JSON.parse(await fsp.readFile(path.join(inst.dir, file), 'utf8'));
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  /** Everything the Players tab shows. */
  async summary(inst) {
    const d = await this.load(inst.cfg.id);
    const now = Date.now();
    const known = Object.entries(d.players)
      .map(([name, p]) => ({ name, first: p.first, last: p.last, sessions: p.sessions, playMs: p.playMs + (p.joinAt ? now - p.joinAt : 0), online: inst.players.has(name) }))
      .sort((a, b) => (b.online - a.online) || (b.last || 0) - (a.last || 0));
    const [whitelist, ops, bans] = await Promise.all(['whitelist.json', 'ops.json', 'banned-players.json'].map((f) => this.readList(inst, f)));
    const props = await inst.getProperties();
    return {
      running: !!inst.proc && inst.status === 'running',
      online: [...inst.players].map((name) => ({ name, since: (d.players[name] && d.players[name].joinAt) || null })),
      known,
      chat: d.chat.slice(-200),
      whitelistOn: props['white-list'] === 'true' || props['enforce-whitelist'] === 'true',
      whitelist: whitelist.map((x) => x.name).filter(Boolean),
      ops: ops.map((x) => x.name).filter(Boolean),
      bans: bans.map((x) => ({ name: x.name, reason: x.reason || '', since: x.created || '' })).filter((x) => x.name),
    };
  }

  /** One action from the panel, as the server's own console command. Returns the command that was run. */
  action(inst, { action, name, reason }) {
    if (!inst.proc || inst.status !== 'running') throw Object.assign(new Error('Start the server first: these actions run on the live server.'), { status: 400 });
    const n = String(name || '').trim();
    const needsName = !['whitelist-on', 'whitelist-off'].includes(action);
    if (needsName && !NAME.test(n)) throw Object.assign(new Error('That is not a Minecraft name (letters, numbers and _, up to 16).'), { status: 400 });
    const why = String(reason || '').replace(/[\r\n]/g, ' ').trim().slice(0, 120);
    const cmd = {
      kick: `kick ${n}${why ? ` ${why}` : ''}`,
      ban: `ban ${n}${why ? ` ${why}` : ''}`,
      pardon: `pardon ${n}`,
      op: `op ${n}`,
      deop: `deop ${n}`,
      'whitelist-add': `whitelist add ${n}`,
      'whitelist-remove': `whitelist remove ${n}`,
      'whitelist-on': 'whitelist on',
      'whitelist-off': 'whitelist off',
    }[action];
    if (!cmd) throw Object.assign(new Error('Unknown action'), { status: 400 });
    inst.command(cmd);
    return cmd;
  }

  forget(id) {
    this.cache.delete(id);
    return fsp.rm(path.join(DIR, `${id}.json`), { force: true }).catch(() => {});
  }
}

module.exports = { Players, NAME };
