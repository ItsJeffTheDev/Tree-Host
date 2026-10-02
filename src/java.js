'use strict';
const fsp = require('fs').promises;
const path = require('path');
const { JAVA, CACHE } = require('./paths');
const { run, download, extractArchive, exists, getMojangManifest, fetchJson } = require('./util');

const MARKER = '.mcpt-complete';
const LTS = [8, 11, 17, 21, 25];

/** Rounds up to an LTS release that Adoptium reliably ships (16 -> 17, 22 -> 25). */
function toLts(major) {
  const n = Number(major) || 21;
  return LTS.find((v) => v >= n) || n;
}

async function probeJavaMajor(javaPath) {
  try {
    const { stdout, stderr } = await run(javaPath, ['-version'], { timeout: 15000 });
    const m = /version "([^"]+)"/.exec(stderr + stdout);
    if (!m) return null;
    const v = m[1];
    return v.startsWith('1.') ? parseInt(v.split('.')[1], 10) : parseInt(v, 10);
  } catch {
    return null;
  }
}

let systemJava;
async function systemJavaMajor() {
  if (systemJava === undefined) systemJava = await probeJavaMajor('java');
  return systemJava;
}

/**
 * The real java executable behind "java" on the PATH. On Windows that is often Oracle's launcher stub (javapath),
 * which starts the real java as a child: stopping the stub would leave the server running, and its memory reads ~7 MB.
 */
let systemExe;
async function systemJavaExe() {
  if (systemExe === undefined) {
    systemExe = 'java';
    try {
      const { stdout, stderr } = await run('java', ['-XshowSettings:properties', '-version'], { timeout: 15000 });
      const m = /java\.home = (.+)/.exec(stderr + stdout);
      const exe = m && path.join(m[1].trim(), 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
      if (exe && (await exists(exe))) systemExe = exe;
    } catch {
      /* keep plain "java" */
    }
  }
  return systemExe;
}

async function findJavaExe(dir) {
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  const queue = [[dir, 0]];
  while (queue.length) {
    const [d, depth] = queue.shift();
    const candidate = path.join(d, 'bin', exe);
    if (await exists(candidate)) return candidate;
    if (depth >= 4) continue;
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory() && !['bin', 'lib', 'legal', 'conf'].includes(e.name)) queue.push([path.join(d, e.name), depth + 1]);
    }
  }
  return null;
}

function guessJavaFromVersion(mcVersion) {
  const n = (String(mcVersion).split('-')[0].match(/\d+/g) || []).map(Number);
  if (n[0] >= 26) return 25;
  if (n[0] !== 1) return 21;
  const minor = n[1] || 0;
  const patch = n[2] || 0;
  if (minor > 20 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 17) return 17;
  return 8;
}

/** Java major a Minecraft version needs, from Mojang's own metadata. */
async function javaForMinecraft(mcVersion) {
  try {
    const manifest = await getMojangManifest();
    for (const id of [mcVersion, String(mcVersion).split('-')[0]]) {
      const entry = manifest.versions.find((v) => v.id === id);
      if (entry) {
        const meta = await fetchJson(entry.url, 24 * 3600 * 1000);
        return toLts(meta.javaVersion ? meta.javaVersion.majorVersion : 8);
      }
    }
  } catch {
    /* offline or unknown version: fall through to heuristic */
  }
  return guessJavaFromVersion(mcVersion);
}

const inflight = new Map();

/**
 * Returns a java executable for the given major version, downloading Temurin if needed.
 * jdk: true guarantees a full JDK (with javac), which BuildTools needs.
 */
async function resolveJava(major, { log = () => {}, progress, jdk = false } = {}) {
  major = Number(major);
  const name = jdk ? `${major}-jdk` : String(major);
  const dir = path.join(JAVA, name);
  if (await exists(path.join(dir, MARKER))) {
    const exe = await findJavaExe(dir);
    if (exe) return exe;
  }
  if (!jdk && (await systemJavaMajor()) === major) return systemJavaExe();
  if (!inflight.has(name)) {
    inflight.set(name, downloadJava(major, log, progress, jdk).finally(() => inflight.delete(name)));
  }
  return inflight.get(name);
}

async function downloadJava(major, log, progress, jdk) {
  const os = { win32: 'windows', darwin: 'mac', linux: 'linux' }[process.platform];
  const arch = { x64: 'x64', arm64: 'aarch64' }[process.arch];
  if (!os || !arch) {
    throw new Error(`Automatic Java download is not supported on ${process.platform}/${process.arch}. Install Java ${major} and set its path in Settings.`);
  }
  const ext = os === 'windows' ? 'zip' : 'tar.gz';
  const archive = path.join(CACHE, `java-${major}${jdk ? '-jdk' : ''}.${ext}`);
  let lastErr = null;
  for (const image of jdk ? ['jdk'] : ['jre', 'jdk']) {
    const url = `https://api.adoptium.net/v3/binary/latest/${major}/ga/${os}/${arch}/${image}/hotspot/normal/eclipse`;
    try {
      log(`Downloading Java ${major} (Eclipse Temurin ${image.toUpperCase()}). This only happens once...`);
      await download(url, archive, { onProgress: progress });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw new Error(`Could not download Java ${major}: ${lastErr.message}`);

  const target = path.join(JAVA, jdk ? `${major}-jdk` : String(major));
  await fsp.rm(target, { recursive: true, force: true });
  log(`Extracting Java ${major}...`);
  await extractArchive(archive, target);
  await fsp.rm(archive, { force: true }).catch(() => {});
  const exe = await findJavaExe(target);
  if (!exe) throw new Error(`The Java ${major} download did not contain a java executable`);
  await fsp.writeFile(path.join(target, MARKER), new Date().toISOString());
  log(`Java ${major} is ready.`);
  return exe;
}

async function listJava() {
  const managed = [];
  try {
    for (const name of await fsp.readdir(JAVA)) {
      if (/^\d+$/.test(name) && (await exists(path.join(JAVA, name, MARKER)))) managed.push(Number(name));
    }
  } catch {
    /* no managed runtimes yet */
  }
  return { system: await systemJavaMajor(), managed: managed.sort((a, b) => a - b) };
}

module.exports = { toLts, probeJavaMajor, findJavaExe, javaForMinecraft, resolveJava, listJava, LTS };
