'use strict';
// Tree Host stress test: lightweight simulated Minecraft clients against a TEST server you own, in stages, with live
// metrics for a recording. No npm installs.
//
//   node tools/stress/stress.js --server <tree host server id> --port <its port> [options]
//
// What a simulated client does (say this in the video): it joins like a real 1.21.4 client (handshake, login,
// configuration), stays connected, answers keep-alives and pings, confirms teleports and acknowledges chunk batches,
// so the server does its full work of sending chunks and tracking a player. It does NOT render, move, chat, break
// blocks or decode the chunks. So this measures how many connected players the server can hold, not full gameplay.
//
// Options:
//   --host 127.0.0.1          server address (your own test server only)
//   --stages 100,250,500,1000,2500,5000,10000
//   --rate 25                 joins per second while ramping
//   --hold 60                 seconds to hold each stage before the next
//   --api http://localhost:8770   Tree Host site, for TPS/tick time (log in with STRESS_USER / STRESS_PASS env vars)
//   --stop-tps 5              stop when TPS stays below this for 20 s
//   --overlay 8796            port for the OBS overlay (http://localhost:8796/)
// Server prep (the script checks): online-mode=false, network-compression-threshold=-1, max-players high enough,
// bukkit.yml connection-throttle: 0 (all clients come from one address).
const net = require('net');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const zlib = require('zlib');

// ---------------------------------------------------------------- options
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const OPT = {
  host: arg('host', '127.0.0.1'),
  port: Number(arg('port', 25565)),
  server: arg('server', ''),
  stages: arg('stages', '100,250,500,1000,2500,5000,10000').split(',').map(Number),
  rate: Number(arg('rate', 25)),
  hold: Number(arg('hold', 60)),
  api: arg('api', 'http://localhost:8770'),
  stopTps: Number(arg('stop-tps', 5)),
  overlay: Number(arg('overlay', 8796)),
  name: arg('name', 'Bot'),
  dir: arg('dir', ''), // server folder, if it isn't a Tree Host server (TPS then comes over RCON from its server.properties)
};
const PROTOCOL = 769; // Minecraft 1.21.4
const ID = {
  login: { success: 2, compress: 3, disconnect: 0, pluginRequest: 4, cookieRequest: 5 },
  loginOut: { start: 0, acknowledged: 3, pluginResponse: 2 },
  config: { knownPacks: 14, finish: 3, keepAlive: 4, ping: 5, disconnect: 2 },
  configOut: { knownPacks: 7, finish: 3, keepAlive: 4, pong: 5 },
  play: { keepAlive: 39, ping: 55, chunkBatchFinished: 12, position: 66, disconnect: 29, startConfig: 112 },
  playOut: { keepAlive: 26, pong: 43, chunkBatchReceived: 9, teleportConfirm: 0, configAck: 14, playerLoaded: 42 },
};

// ---------------------------------------------------------------- protocol helpers
function varint(n) {
  const b = [];
  n >>>= 0;
  do {
    let t = n & 0x7f;
    n >>>= 7;
    if (n) t |= 0x80;
    b.push(t);
  } while (n);
  return Buffer.from(b);
}
function readVarint(buf, off) {
  let n = 0, shift = 0, b;
  do {
    if (off >= buf.length) return null;
    b = buf[off++];
    n |= (b & 0x7f) << shift;
    shift += 7;
    if (shift > 35) throw new Error('varint too long');
  } while (b & 0x80);
  return [n >>> 0, off];
}
const str = (s) => Buffer.concat([varint(Buffer.byteLength(s)), Buffer.from(s)]);
function offlineUuid(name) {
  const h = require('crypto').createHash('md5').update(`OfflinePlayer:${name}`).digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  return h;
}

// ---------------------------------------------------------------- state
const S = {
  startedAt: Date.now(),
  stage: 0,
  target: 0,
  attempted: 0,
  connected: 0, // in play state right now
  joinedTotal: 0,
  failed: 0, // never reached play
  dropped: 0, // reached play, then lost
  reasons: {},
  bots: new Set(),
  tps: null, // live, from the 5 s tick time
  tps1m: null,
  mspt: null,
  container: null, // { cpuPct, memMb, memLimitMb, cpus }
  host: null, // { cpuPct, memUsedMb, memTotalMb }
  samples: [],
  stageResults: [],
  stopped: null,
  phase: 'starting',
};
const reason = (r) => (S.reasons[r] = (S.reasons[r] || 0) + 1);

// ---------------------------------------------------------------- one simulated client
function bot(i) {
  const name = `${OPT.name}${String(i).padStart(5, '0')}`.slice(0, 16);
  const sock = net.connect({ host: OPT.host, port: OPT.port });
  sock.setNoDelay(true);
  let buf = Buffer.alloc(0), state = 'login', compression = -1, inPlay = false, done = false;
  S.attempted++;
  const b = { name, sock, close: () => { done = true; if (inPlay) S.connected--; S.bots.delete(b); sock.destroy(); } }; // end of test: not a drop
  S.bots.add(b);
  const send = (id, data = Buffer.alloc(0)) => {
    const body = Buffer.concat([varint(id), data]);
    if (compression >= 0) {
      const inner = body.length >= compression ? Buffer.concat([varint(body.length), zlib.deflateSync(body)]) : Buffer.concat([varint(0), body]);
      sock.write(Buffer.concat([varint(inner.length), inner]));
    } else sock.write(Buffer.concat([varint(body.length), body]));
  };
  const finish = (why) => {
    if (done) return;
    done = true;
    S.bots.delete(b);
    if (inPlay) {
      S.connected--;
      S.dropped++;
    } else S.failed++;
    reason(why);
    sock.destroy();
  };
  sock.on('connect', () => {
    const port = Buffer.alloc(2);
    port.writeUInt16BE(OPT.port);
    send(0, Buffer.concat([varint(PROTOCOL), str(OPT.host), port, varint(2)])); // handshake -> login
    send(ID.loginOut.start, Buffer.concat([str(name), offlineUuid(name)]));
  });
  sock.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      const L = readVarint(buf, 0);
      if (!L) return;
      const [len, off] = L;
      if (buf.length < off + len) return;
      let pkt = buf.subarray(off, off + len);
      buf = buf.subarray(off + len);
      if (compression >= 0) {
        const [dlen, o2] = readVarint(pkt, 0);
        pkt = dlen ? zlib.inflateSync(pkt.subarray(o2)) : pkt.subarray(o2);
      }
      const [id, p] = readVarint(pkt, 0);
      const data = pkt.subarray(p);
      try {
        handle(id, data);
      } catch (e) {
        finish(`protocol error: ${e.message.slice(0, 40)}`);
        return;
      }
    }
  });
  const text = (data) => {
    const s = data.toString('utf8').replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim();
    const m = /"text"\s*:\s*"([^"]{1,60})/.exec(s) || /translate.{0,4}([a-z.]{4,60})/.exec(s);
    return (m ? m[1] : s).slice(0, 60) || 'no reason';
  };
  function handle(id, data) {
    if (state === 'login') {
      if (id === ID.login.compress) compression = readVarint(data, 0)[0];
      else if (id === ID.login.success) {
        send(ID.loginOut.acknowledged);
        state = 'config';
      } else if (id === ID.login.disconnect) finish(`login refused: ${text(data)}`);
      else if (id === ID.login.pluginRequest) send(ID.loginOut.pluginResponse, Buffer.concat([varint(readVarint(data, 0)[0]), Buffer.from([0])]));
    } else if (state === 'config') {
      if (id === ID.config.knownPacks) send(ID.configOut.knownPacks, varint(0));
      else if (id === ID.config.keepAlive) send(ID.configOut.keepAlive, data.subarray(0, 8));
      else if (id === ID.config.ping) send(ID.configOut.pong, data.subarray(0, 4));
      else if (id === ID.config.finish) {
        send(ID.configOut.finish);
        state = 'play';
        inPlay = true;
        S.connected++;
        S.joinedTotal++;
      } else if (id === ID.config.disconnect) finish(`kicked in config: ${text(data)}`);
    } else if (state === 'play') {
      if (id === ID.play.keepAlive) send(ID.playOut.keepAlive, data.subarray(0, 8));
      else if (id === ID.play.ping) send(ID.playOut.pong, data.subarray(0, 4));
      else if (id === ID.play.chunkBatchFinished) {
        const f = Buffer.alloc(4);
        f.writeFloatBE(25);
        send(ID.playOut.chunkBatchReceived, f);
      } else if (id === ID.play.position) {
        send(ID.playOut.teleportConfirm, varint(readVarint(data, 0)[0]));
        if (!b.loaded) {
          b.loaded = true;
          send(ID.playOut.playerLoaded);
        }
      } else if (id === ID.play.disconnect) finish(`kicked: ${text(data)}`);
      else if (id === ID.play.startConfig) {
        send(ID.playOut.configAck);
        state = 'config';
      }
    }
  }
  sock.on('error', (e) => finish(e.code === 'ECONNREFUSED' ? 'connection refused' : e.code || 'socket error'));
  sock.on('close', () => finish(inPlay ? 'connection closed' : 'closed before joining'));
  sock.setTimeout(60000, () => !inPlay && finish('join timed out'));
}

// ---------------------------------------------------------------- metrics
let api = null;
let RCON = null;
async function apiLogin() {
  const u = process.env.STRESS_USER, p = process.env.STRESS_PASS;
  if (!u || !p || !OPT.server) return null;
  const r = await fetch(`${OPT.api}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: OPT.api }, body: JSON.stringify({ username: u, password: p }) });
  const c = (r.headers.getSetCookie().find((x) => x.startsWith('th_session=')) || '').split(';')[0];
  if (!c) return null;
  return { cookie: c, lastSeq: 0 };
}
async function apiCall(method, p, body) {
  const r = await fetch(`${OPT.api}${p}`, { method, headers: { 'Content-Type': 'application/json', Origin: OPT.api, Cookie: api.cookie }, body: body && JSON.stringify(body) });
  return r.json().catch(() => null);
}
// Minimal RCON client (Source RCON protocol, as Minecraft speaks it).
function rcon(port, password, commands) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: OPT.host, port });
    const out = [];
    let buf = Buffer.alloc(0), id = 1;
    const send = (type, body) => {
      const b = Buffer.from(body, 'utf8');
      const p = Buffer.alloc(14 + b.length);
      p.writeInt32LE(10 + b.length, 0);
      p.writeInt32LE(id++, 4);
      p.writeInt32LE(type, 8);
      b.copy(p, 12);
      sock.write(p);
    };
    const timer = setTimeout(() => (sock.destroy(), reject(new Error('rcon timeout'))), 5000);
    sock.on('connect', () => send(3, password));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readInt32LE(0)) {
        const len = buf.readInt32LE(0), rid = buf.readInt32LE(4), body = buf.subarray(12, 4 + len - 2).toString('utf8');
        buf = buf.subarray(4 + len);
        if (rid === -1) return clearTimeout(timer), sock.destroy(), reject(new Error('rcon password refused'));
        if (rid === 1) commands.forEach((c) => send(2, c));
        else {
          out.push(body);
          if (out.length === commands.length) clearTimeout(timer), sock.end(), resolve(out);
        }
      }
    });
    sock.on('error', (e) => (clearTimeout(timer), reject(e)));
  });
}
function parseTps(plain) {
  for (let i = 0; i < plain.length; i++) {
    const t = /TPS from last 1m, 5m, 15m: \*?([\d.]+)/.exec(plain[i]);
    if (t) S.tps1m = Number(t[1]); // Paper's own figure is a 1-minute average: too slow to show a stage changing
    if (/Server tick times/.test(plain[i])) {
      const m = /([\d.]+)\/([\d.]+)\/([\d.]+)/.exec(plain.slice(i, i + 3).join(' ').replace(/.*Server tick times[^\d]*/, ''));
      if (m) {
        S.mspt = { avg: Number(m[1]), max: Number(m[3]) }; // last 5 seconds
        S.tps = Math.round(Math.min(20, 1000 / Math.max(S.mspt.avg, 0.01)) * 10) / 10; // live TPS from the 5 s tick time
      }
    }
  }
}
async function pollTps() {
  if (RCON) {
    try {
      const r = await rcon(RCON.port, RCON.password, ['tps', 'mspt']);
      parseTps(r.join('\n').replace(/§./g, '').split('\n'));
    } catch (e) {
      S.rconError = e.message;
    }
    return;
  }
  if (!api) return;
  try {
    await apiCall('POST', `/api/servers/${OPT.server}/command`, { command: 'tps' });
    await apiCall('POST', `/api/servers/${OPT.server}/command`, { command: 'mspt' });
    await new Promise((r) => setTimeout(r, 1500));
    const log = await apiCall('GET', `/api/servers/${OPT.server}/log?since=${api.lastSeq}`);
    const lines = (log && log.lines) || [];
    if (lines.length) api.lastSeq = Math.max(api.lastSeq, ...lines.map((l) => l.s || 0));
    const plain = lines.map((l) => String(l.t).replace(/\x1b\[[0-9;]*m/g, '').replace(/§./g, ''));
    parseTps(plain);
  } catch {}
}
// A server that isn't in Docker: find the process listening on the game port and measure it directly.
let proc = null;
function processStats() {
  return new Promise((resolve) => {
    const ps = `$c = Get-NetTCPConnection -LocalPort ${OPT.port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $p = Get-Process -Id $c.OwningProcess; "$($p.Id)|$($p.TotalProcessorTime.TotalSeconds)|$($p.WorkingSet64)" }`;
    execFile('powershell', ['-NoProfile', '-Command', ps], { timeout: 8000 }, (err, out) => {
      const [pid, cpuS, ws] = String(out || '').trim().split('|').map(Number);
      if (err || !pid) return resolve(null);
      const now = Date.now();
      let cpuPct = null;
      if (proc && proc.pid === pid) cpuPct = Math.round(((cpuS - proc.cpuS) / ((now - proc.at) / 1000)) * 1000) / 10; // 100% = one core, like docker stats
      proc = { pid, cpuS, at: now };
      resolve({ cpuPct, memMb: Math.round(ws / 1048576), memLimitMb: null });
    });
  });
}
function dockerStats() {
  return new Promise((resolve) => {
    if (!OPT.server) return resolve(processStats());
    execFile('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}}|{{.MemUsage}}', `th-${OPT.server}`], { timeout: 8000 }, (err, out) => {
      if (err || !out.trim()) return resolve(null);
      const [cpu, mem] = out.trim().split('|');
      const toMb = (s) => {
        const m = /([\d.]+)\s*([KMG]i?B)/.exec(s || '');
        if (!m) return null;
        return Number(m[1]) * ({ KiB: 1 / 1024, KB: 1 / 1000, MiB: 1, MB: 1, GiB: 1024, GB: 1000 }[m[2]] || 1);
      };
      const [used, limit] = (mem || '').split('/');
      resolve({ cpuPct: parseFloat(cpu), memMb: Math.round(toMb(used)), memLimitMb: Math.round(toMb(limit)) });
    });
  });
}
let lastCpu = os.cpus();
function hostStats() {
  const now = os.cpus();
  let idle = 0, total = 0;
  now.forEach((c, i) => {
    const a = lastCpu[i].times, b = c.times;
    const t = Object.keys(b).reduce((n, k) => n + (b[k] - a[k]), 0);
    total += t;
    idle += b.idle - a.idle;
  });
  lastCpu = now;
  return { cpuPct: total ? Math.round((1 - idle / total) * 1000) / 10 : null, memUsedMb: Math.round((os.totalmem() - os.freemem()) / 1048576), memTotalMb: Math.round(os.totalmem() / 1048576) };
}
const elapsed = () => Math.round((Date.now() - S.startedAt) / 1000);
async function sample() {
  S.container = await dockerStats();
  S.host = hostStats();
  const s = { t: elapsed(), stage: S.target, connected: S.connected, attempted: S.attempted, failed: S.failed, dropped: S.dropped, tps: S.tps, tps1m: S.tps1m, mspt: S.mspt, container: S.container, host: S.host, toolMemMb: Math.round(process.memoryUsage().rss / 1048576) };
  S.samples.push(s);
  return s;
}

// ---------------------------------------------------------------- specs + server prep checks
function serverDir() {
  if (OPT.dir) return OPT.dir;
  const d = path.join('D:\\tree-host-testers\\servers', OPT.server);
  return fs.existsSync(d) ? d : null;
}
function readProps(dir) {
  const out = {};
  try {
    for (const l of fs.readFileSync(path.join(dir, 'server.properties'), 'utf8').split(/\r?\n/)) {
      const m = /^([^#=]+)=(.*)$/.exec(l);
      if (m) out[m[1].trim()] = m[2].trim();
    }
  } catch {}
  return out;
}
function specs() {
  const dir = serverDir();
  const props = dir ? readProps(dir) : {};
  let throttle = null;
  try {
    const m = /connection-throttle:\s*(-?\d+)/.exec(fs.readFileSync(path.join(dir, 'bukkit.yml'), 'utf8'));
    throttle = m ? Number(m[1]) : null;
  } catch {}
  return {
    date: new Date().toISOString(),
    pcCpu: os.cpus()[0].model.trim(),
    pcCores: os.cpus().length,
    pcRamMb: Math.round(os.totalmem() / 1048576),
    server: OPT.server,
    minecraft: '1.21.4',
    viewDistance: props['view-distance'] || null,
    simulationDistance: props['simulation-distance'] || null,
    maxPlayers: props['max-players'] || null,
    onlineMode: props['online-mode'] || null,
    compression: props['network-compression-threshold'] || null,
    connectionThrottle: throttle,
    tool: 'Tree Host stress.js: protocol-level clients (join, stay connected, keep-alives, chunk acks); no movement, chat or rendering',
    stages: OPT.stages,
    ratePerSecond: OPT.rate,
    holdSeconds: OPT.hold,
  };
}

// ---------------------------------------------------------------- overlay server
let SPEC = null;
const OVERLAY = fs.readFileSync(path.join(__dirname, 'overlay.html'));
http.createServer((req, res) => {
  if (req.url.startsWith('/stats')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ spec: SPEC, now: S.samples[S.samples.length - 1] || null, history: S.samples.slice(-240), stages: S.stageResults, reasons: S.reasons, phase: S.phase, stopped: S.stopped, elapsed: elapsed(), target: S.target }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(OVERLAY);
  }
}).on('error', (e) => { console.error(`Overlay port ${OPT.overlay} is busy (${e.code}). Use --overlay <another port>.`); process.exit(1); }).listen(OPT.overlay, '127.0.0.1');

// ---------------------------------------------------------------- the run
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const resultsDir = path.join(__dirname, 'results');
fs.mkdirSync(resultsDir, { recursive: true });
const resultFile = path.join(resultsDir, `stress-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
const save = () => fs.writeFileSync(resultFile, JSON.stringify({ spec: SPEC, stages: S.stageResults, reasons: S.reasons, stopped: S.stopped, samples: S.samples }, null, 1));
const log = (m) => console.log(`[${String(elapsed()).padStart(4)}s] ${m}`);

(async () => {
  SPEC = specs();
  const props = serverDir() ? readProps(serverDir()) : {};
  if (OPT.dir && props['enable-rcon'] === 'true' && props['rcon.password']) RCON = { port: Number(props['rcon.port'] || 25575), password: props['rcon.password'] };
  const problems = [];
  if (SPEC.onlineMode !== 'false') problems.push('online-mode must be false (simulated clients have no Minecraft accounts)');
  if (SPEC.compression !== '-1') problems.push('network-compression-threshold should be -1 (otherwise the tool spends its CPU unzipping)');
  if (SPEC.connectionThrottle !== 0) problems.push('bukkit.yml connection-throttle should be 0 (every client comes from 127.0.0.1)');
  if (problems.length) log(`WARNING:\n  - ${problems.join('\n  - ')}`);
  log(`Specs: ${SPEC.pcCpu}, ${SPEC.pcCores} threads, ${SPEC.pcRamMb} MB RAM. Server ${OPT.server} view ${SPEC.viewDistance}, sim ${SPEC.simulationDistance}, max players ${SPEC.maxPlayers}`);
  api = await apiLogin().catch(() => null);
  if (RCON) log('Reading TPS over RCON.');
  else log(api ? 'Tree Host API connected: TPS and tick times will be recorded.' : 'No Tree Host login (STRESS_USER/STRESS_PASS): TPS will not be recorded.');
  log(`Overlay: http://localhost:${OPT.overlay}/`);

  let lowSince = null;
  let busy = false;
  const ticker = setInterval(async () => {
    if (busy) return; // a slow sample (stalled PC) must not overlap the next one
    busy = true;
    await pollTps();
    const s = await sample();
    save();
    if (S.tps != null && S.tps < OPT.stopTps) lowSince = lowSince || Date.now();
    else lowSince = null;
    if (lowSince && Date.now() - lowSince > 20000 && !S.stopped) S.stopped = `TPS stayed below ${OPT.stopTps} for 20 s`;
    busy = false;
    if (s.host && s.host.memTotalMb - s.host.memUsedMb < 1024 && !S.stopped) S.stopped = 'PC has less than 1 GB of free memory';
  }, 5000);

  S.phase = 'baseline';
  log('Baseline (no clients) for 20 s...');
  await sleep(20000);
  S.stageResults.push({ stage: 0, label: 'baseline', ...summary() });

  let next = 0;
  for (const target of OPT.stages) {
    if (S.stopped) break;
    S.target = target;
    S.phase = 'ramping';
    log(`Stage ${target}: ramping at ${OPT.rate}/s...`);
    const failBefore = S.failed;
    while (S.attempted - S.failed - S.dropped < target && !S.stopped) {
      for (let k = 0; k < OPT.rate && S.attempted - S.failed - S.dropped < target; k++) bot(++next);
      await sleep(1000);
      const failedNow = S.failed - failBefore;
      if (failedNow > 50 && failedNow > (target - (S.stageResults.at(-1)?.connected || 0)) * 0.5) S.stopped = `more than half of the new clients failed to join in stage ${target}`;
    }
    const settleEnd = Date.now() + 60000; // let pending joins finish so the hold measures the full stage
    while (S.attempted - S.failed - S.dropped > S.connected && Date.now() < settleEnd && !S.stopped) await sleep(500);
    S.phase = 'holding';
    log(`Stage ${target}: ${S.connected} connected. Holding ${OPT.hold} s...`);
    const holdEnd = Date.now() + OPT.hold * 1000;
    while (Date.now() < holdEnd && !S.stopped) await sleep(1000);
    const sum = summary(target);
    S.stageResults.push({ stage: target, ...sum });
    log(`Stage ${target} done: ${sum.connected} connected, TPS ${sum.tpsMin ?? '?'}-${sum.tpsAvg ?? '?'}, server CPU peak ${sum.cpuPeak ?? '?'}%, RAM peak ${sum.memPeakMb ?? '?'} MB`);
    if (sum.connected < target * 0.9 && !S.stopped) S.stopped = `only ${sum.connected} of ${target} clients stayed connected`;
  }
  S.phase = 'done';
  if (S.stopped) log(`Stopped: ${S.stopped}`);
  const best = S.stageResults.filter((r) => r.stage && r.connected >= r.stage * 0.9 && (r.tpsMin == null || r.tpsMin >= 18)).at(-1);
  log(`Highest stage that held with TPS >= 18: ${best ? best.stage : 'none'}. Results: ${resultFile}`);
  save();
  log('Disconnecting clients in 10 s, gradually (overlay keeps the final numbers)...');
  await sleep(10000);
  // Gradually: a server saves each leaving player's file on its main thread, and 750 at once froze one long enough
  // for the watchdog to stop it (first trial, 2026-10-09).
  S.phase = 'leaving';
  for (const b of [...S.bots]) {
    b.close();
    await sleep(1000 / (OPT.rate * 2));
  }
  clearInterval(ticker);
  await sleep(3000);
  save();
  log('Done. Ctrl+C to close the overlay.');
  if (process.argv.includes('--quit')) process.exit(0); // for off-camera runs
})();

function summary(stage) {
  const since = S.stageResults.length ? S.samples.findIndex((s) => s.stage === stage) : 0;
  const sm = S.samples.slice(Math.max(0, since)).filter((s) => s.stage === (stage || 0));
  const num = (a) => a.filter((v) => v != null && !Number.isNaN(v));
  const tps = num(sm.map((s) => s.tps));
  const cpu = num(sm.map((s) => s.container && s.container.cpuPct));
  const mem = num(sm.map((s) => s.container && s.container.memMb));
  const hcpu = num(sm.map((s) => s.host && s.host.cpuPct));
  return {
    connected: S.connected,
    attempted: S.attempted,
    failed: S.failed,
    dropped: S.dropped,
    tpsMin: tps.length ? Math.min(...tps) : null,
    tpsAvg: tps.length ? Math.round((tps.reduce((a, b) => a + b, 0) / tps.length) * 10) / 10 : null,
    msptAvg: S.mspt ? S.mspt.avg : null,
    msptMax: S.mspt ? S.mspt.max : null,
    cpuPeak: cpu.length ? Math.max(...cpu) : null,
    memPeakMb: mem.length ? Math.max(...mem) : null,
    hostCpuPeak: hcpu.length ? Math.max(...hcpu) : null,
    at: elapsed(),
  };
}
