'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const net = require('net');
const readline = require('readline');
const { finished } = require('stream/promises');
const { spawn } = require('child_process');

const UA = 'MC-Plugin-Test-Server-Manager/1.0 (local dev tool)';
const MOJANG_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

// ---------- HTTP ----------

const cache = new Map();

async function fetchJson(url, ttlMs = 10 * 60 * 1000) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const v = await res.json();
  cache.set(url, { t: Date.now(), v });
  return v;
}

async function fetchText(url, ttlMs = 10 * 60 * 1000) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const v = await res.text();
  cache.set(url, { t: Date.now(), v });
  return v;
}

function getMojangManifest() {
  return fetchJson(MOJANG_MANIFEST);
}

/**
 * Streams a URL to disk. Optional checksum: { algo: 'sha256' | 'sha1', value }.
 * onProgress(doneBytes, totalBytes) is throttled to ~2/sec.
 */
async function download(url, dest, { onProgress, checksum } = {}) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}): ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = checksum ? crypto.createHash(checksum.algo) : null;
  const out = fs.createWriteStream(tmp);
  let done = 0;
  let lastReport = 0;
  try {
    for await (const chunk of res.body) {
      if (hash) hash.update(chunk);
      done += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      const now = Date.now();
      if (onProgress && now - lastReport > 500) {
        lastReport = now;
        onProgress(done, total);
      }
    }
    out.end();
    await finished(out);
  } catch (e) {
    out.destroy();
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  if (onProgress) onProgress(done, total);
  if (hash) {
    const got = hash.digest('hex');
    if (got.toLowerCase() !== String(checksum.value).toLowerCase()) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw new Error(`Checksum mismatch for ${path.basename(dest)} (expected ${checksum.value}, got ${got})`);
    }
  }
  await fsp.rename(tmp, dest);
}

// ---------- Processes ----------

/** Runs a process to completion. Rejects on non-zero exit. onLine receives each output line. */
function run(cmd, args, { cwd, timeout, onLine, env } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env ? { ...process.env, ...env } : process.env, windowsHide: true });
    } catch (e) {
      reject(e);
      return;
    }
    let stdout = '';
    let stderr = '';
    const keep = (s, add) => (s + add).slice(-20000);
    child.stdout.on('data', (b) => (stdout = keep(stdout, b.toString())));
    child.stderr.on('data', (b) => (stderr = keep(stderr, b.toString())));
    if (onLine) {
      readline.createInterface({ input: child.stdout }).on('line', onLine);
      readline.createInterface({ input: child.stderr }).on('line', onLine);
    }
    const timer = timeout ? setTimeout(() => child.kill(), timeout) : null;
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ code, stdout, stderr });
      const err = new Error(`${path.basename(cmd)} exited with code ${code}`);
      Object.assign(err, { code, stdout, stderr });
      reject(err);
    });
  });
}

/** Splits a command-line string into args, honouring double quotes. */
function splitArgs(str) {
  if (!str) return [];
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(str))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

// ---------- Files ----------

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function extractArchive(file, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  if (process.platform !== 'win32') {
    await run('tar', ['-xf', file, '-C', destDir]);
    return;
  }
  // Windows 10+ ships bsdtar, which handles zip. Fall back to PowerShell if missing.
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  try {
    await run(tar, ['-xf', file, '-C', destDir]);
  } catch {
    const q = (s) => `'${s.replace(/'/g, "''")}'`;
    await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath ${q(file)} -DestinationPath ${q(destDir)} -Force`,
    ]);
  }
}

/** Reads selected entries from a zip/jar without extracting it. Returns { name: Buffer }. */
async function readZipEntries(zipPath, wanted) {
  const fh = await fsp.open(zipPath, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('Not a valid jar/zip file');
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const out = {};
    let p = 0;
    while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const nLen = cd.readUInt16LE(p + 28);
      const xLen = cd.readUInt16LE(p + 30);
      const cLen = cd.readUInt16LE(p + 32);
      const lho = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nLen);
      if (wanted.includes(name) && compSize > 0) {
        const lh = Buffer.alloc(30);
        await fh.read(lh, 0, 30, lho);
        const start = lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
        const data = Buffer.alloc(compSize);
        await fh.read(data, 0, compSize, start);
        if (method === 0) out[name] = data;
        else if (method === 8) out[name] = zlib.inflateRawSync(data);
      }
      p += 46 + nLen + xLen + cLen;
    }
    return out;
  } finally {
    await fh.close();
  }
}

/** Java version a jar's Main-Class was compiled for (e.g. 17), or null. */
async function jarJavaVersion(jarPath) {
  try {
    const { 'META-INF/MANIFEST.MF': mf } = await readZipEntries(jarPath, ['META-INF/MANIFEST.MF']);
    const main = mf && /^Main-Class:\s*(\S+)/m.exec(mf.toString('utf8'));
    if (!main) return null;
    const entry = main[1].replace(/\./g, '/') + '.class';
    const cls = (await readZipEntries(jarPath, [entry]))[entry];
    if (!cls || cls.readUInt32BE(0) !== 0xcafebabe) return null;
    return cls.readUInt16BE(6) - 44;
  } catch {
    return null;
  }
}

// ---------- server.properties ----------

function parseProperties(text) {
  const o = {};
  for (const line of (text || '').split(/\r?\n/)) {
    if (!line.trim() || /^\s*[#!]/.test(line)) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    o[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return o;
}

/** Updates keys in place, keeping comments and order; appends new keys. */
function updateProperties(text, updates) {
  const lines = text ? text.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*[#!]/.test(line)) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      lines[i] = `${key}=${updates[key]}`;
      seen.add(key);
    }
  }
  for (const [k, v] of Object.entries(updates)) if (!seen.has(k)) lines.push(`${k}=${v}`);
  return lines.join('\n') + '\n';
}

// ---------- Misc ----------

/** Resolves true/false, or null when the address family isn't available (no IPv6 on this machine). */
function canListen(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (e) => resolve(['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(e.code) ? null : false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

// Minecraft binds both IPv4 and IPv6 ("*:port"). On Windows those are separate, so a port taken only on IPv6
// (e.g. by Docker Desktop's port proxy) still looks free on 0.0.0.0: check both.
async function isPortFree(port) {
  if (!(await canListen(port, '0.0.0.0'))) return false;
  return (await canListen(port, '::')) !== false;
}

/** Compares "1.21.4", "26.1.2", "1.21.11-rc3". Releases sort above their pre-releases. */
function compareVersions(a, b) {
  const [baseA, ...restA] = String(a).split('-');
  const [baseB, ...restB] = String(b).split('-');
  const na = (baseA.match(/\d+/g) || []).map(Number);
  const nb = (baseB.match(/\d+/g) || []).map(Number);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] || 0) - (nb[i] || 0);
    if (d) return d;
  }
  const sa = restA.join('-');
  const sb = restB.join('-');
  if (!sa && sb) return 1;
  if (sa && !sb) return -1;
  return sa.localeCompare(sb, undefined, { numeric: true });
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[\d;?]*[A-Za-z]/g, '');
}

module.exports = {
  UA,
  fetchJson,
  fetchText,
  getMojangManifest,
  download,
  run,
  splitArgs,
  exists,
  extractArchive,
  readZipEntries,
  jarJavaVersion,
  parseProperties,
  updateProperties,
  isPortFree,
  compareVersions,
  stripAnsi,
};
