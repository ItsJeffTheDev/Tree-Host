'use strict';
// Talking to Windows: running programs, seeing what's running, and how busy the PC is.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

/** Runs a program and waits for it. Never throws: check .ok. */
function run(file, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout || '') }));
  });
}
const powershell = (script, timeout) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], timeout);
const kill = (pid, tree = true) => run('taskkill.exe', ['/f', ...(tree ? ['/t'] : []), '/pid', String(pid)]);
const killImage = (image) => run('taskkill.exe', ['/f', '/im', image]);

/** Starts a program on its own: it keeps running when the deck closes. */
function launch(file, args = [], cwd) {
  const builtIn = /^(explorer|cmd)\.exe$/i.test(file);
  if (!builtIn && !fs.existsSync(file)) throw new Error(`${path.basename(file)} isn't installed at ${file} (change it in deck-config.json).`);
  const p = spawn(file, args, { detached: true, stdio: 'ignore', cwd: cwd || (builtIn ? os.homedir() : path.dirname(file)) });
  p.on('error', () => {});
  p.unref();
}
/** Runs a .bat in its own minimized window, like double-clicking it. */
function launchBat(bat, title) {
  if (!fs.existsSync(bat)) throw new Error(`Missing ${bat}`);
  const p = spawn('cmd.exe', ['/d', '/c', `start "${title}" /min "${bat}"`], { detached: true, stdio: 'ignore', cwd: path.dirname(bat), windowsVerbatimArguments: true, windowsHide: true });
  p.unref();
}
const openSettings = (page) => launch('explorer.exe', [`ms-settings:${page}`]);

// ---------- what's running ----------

/** Program names → process ids. Cheap enough to read every few seconds. */
let images = new Map();
async function readImages() {
  const r = await run('tasklist.exe', ['/fo', 'csv', '/nh']);
  if (!r.ok) return;
  const m = new Map();
  for (const line of r.stdout.split(/\r?\n/)) {
    const f = line.match(/^"([^"]+)","(\d+)"/);
    if (!f) continue;
    const k = f[1].toLowerCase();
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(Number(f[2]));
  }
  images = m;
}
const pids = (image) => images.get(image.toLowerCase()) || [];
const isRunning = (...names) => names.some((n) => pids(n).length > 0);

/** Scripts (node/powershell/cmd with their command lines), to tell the Discord bot from Tree Host. Slower, so read less often. */
let scripts = [];
async function readScripts() {
  const r = await powershell(
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe' or Name='powershell.exe' or Name='cmd.exe'\" | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, $_.Name, $_.CommandLine }",
    20000,
  );
  if (!r.ok) return;
  scripts = r.stdout
    .split(/\r?\n/)
    .map((l) => l.match(/^(\d+)\|([^|]*)\|(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), name: m[2].toLowerCase(), cmd: m[3] }));
}
const findScripts = (pattern, image) => scripts.filter((s) => pattern.test(s.cmd) && (!image || s.name === image));

// ---------- health ----------

let cpuBefore = os.cpus();
const health = { cpu: 0, threads: os.cpus().length, ramUsedGb: 0, ramTotalGb: 0, cFreeGb: null, dockerDiskGb: null };
const gb = (bytes) => Math.round((bytes / 1073741824) * 10) / 10;

async function readHealth() {
  const now = os.cpus();
  let idle = 0;
  let total = 0;
  now.forEach((c, i) => {
    const b = (cpuBefore[i] || c).times;
    const a = c.times;
    total += a.user + a.nice + a.sys + a.idle + a.irq - (b.user + b.nice + b.sys + b.idle + b.irq);
    idle += a.idle - b.idle;
  });
  cpuBefore = now;
  if (total) health.cpu = Math.round(100 - (idle / total) * 100);
  health.ramTotalGb = gb(os.totalmem());
  health.ramUsedGb = gb(os.totalmem() - os.freemem());
  try {
    const s = await fs.promises.statfs('C:\\');
    health.cFreeGb = gb(s.bavail * s.bsize);
  } catch {}
}

/** Size of Docker's virtual disks (they live on C: by default and only grow). */
function readDockerDisk() {
  let sum = 0;
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.vhdx$/i.test(e.name)) sum += fs.statSync(p).size;
    }
  };
  walk(path.join(LOCAL, 'Docker', 'wsl'));
  health.dockerDiskGb = sum ? gb(sum) : null;
}

async function httpOk(url, timeout = 3000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: 'manual' });
    return res.status > 0 && res.status < 500;
  } catch {
    return false;
  }
}

/** Sets key=value in one [section] of an .ini file's text, keeping everything else as it was. */
function setIni(text, section, key, value) {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `[${section}]`);
  if (start < 0) return [...lines, `[${section}]`, `${key}=${value}`].join(nl);
  let end = lines.findIndex((l, i) => i > start && /^\[.*\]$/.test(l.trim()));
  if (end < 0) end = lines.length;
  const at = lines.findIndex((l, i) => i > start && i < end && l.split('=')[0] === key);
  if (at >= 0) lines[at] = `${key}=${value}`;
  else lines.splice(start + 1, 0, `${key}=${value}`);
  return lines.join(nl);
}

module.exports = {
  LOCAL,
  run,
  powershell,
  kill,
  killImage,
  launch,
  launchBat,
  openSettings,
  readImages,
  readScripts,
  pids,
  isRunning,
  findScripts,
  health,
  readHealth,
  readDockerDisk,
  httpOk,
  setIni,
};
