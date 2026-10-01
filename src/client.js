'use strict';
// Minimal Minecraft client launcher: downloads a version from Mojang and starts it in offline (dev) mode,
// joining a local test server directly.
const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { DATA } = require('./paths');
const { fetchJson, getMojangManifest, download, exists, extractArchive } = require('./util');
const java = require('./java');

const ROOT = path.join(DATA, 'client');
const LIBS = path.join(ROOT, 'libraries');
const ASSETS = path.join(ROOT, 'assets');
const VERSIONS = path.join(ROOT, 'versions');
const OS_NAME = { win32: 'windows', darwin: 'osx', linux: 'linux' }[process.platform];
const CP_SEP = process.platform === 'win32' ? ';' : ':';
const NATIVE_EXT = /\.(dll|so|dylib|jnilib)$/i;

function archMatches(arch) {
  if (arch === 'x86') return process.arch === 'ia32';
  if (arch === 'arm64' || arch === 'aarch64') return process.arch === 'arm64';
  return arch === process.arch;
}

function rulesAllow(rules, features = {}) {
  if (!rules || !rules.length) return true;
  let allowed = false;
  for (const r of rules) {
    let match = true;
    if (r.os) {
      if (r.os.name && r.os.name !== OS_NAME) match = false;
      if (r.os.arch && !archMatches(r.os.arch)) match = false;
      if (r.os.version) {
        try {
          if (!new RegExp(r.os.version).test(os.release())) match = false;
        } catch {
          match = false;
        }
      }
    }
    if (r.features) {
      for (const [k, v] of Object.entries(r.features)) if (!!features[k] !== v) match = false;
    }
    if (match) allowed = r.action === 'allow';
  }
  return allowed;
}

/** The UUID offline-mode servers assign to a username (same as Java's nameUUIDFromBytes). */
function offlineUuid(name) {
  const h = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  return h.toString('hex');
}

/** Downloads every job whose file is missing or the wrong size, 16 at a time, with retries. */
async function downloadAll(jobs, progress) {
  const unique = new Map();
  for (const j of jobs) unique.set(j.dest, j);
  const missing = [];
  for (const j of unique.values()) {
    const st = await fsp.stat(j.dest).catch(() => null);
    if (!st || (j.size && st.size !== j.size)) missing.push(j);
  }
  if (!missing.length) return 0;
  const total = missing.reduce((a, j) => a + (j.size || 0), 0);
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < missing.length) {
      const j = missing[next++];
      let err = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await download(j.url, j.dest, { checksum: j.sha1 ? { algo: 'sha1', value: j.sha1 } : undefined });
          err = null;
          break;
        } catch (e) {
          err = e;
        }
      }
      if (err) throw err;
      done += j.size || 0;
      if (progress) progress(done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.min(16, missing.length) }, worker));
  return missing.length;
}

async function copyNativesFlat(fromDir, toDir) {
  for (const e of await fsp.readdir(fromDir, { withFileTypes: true })) {
    const full = path.join(fromDir, e.name);
    if (e.isDirectory()) await copyNativesFlat(full, toDir);
    else if (NATIVE_EXT.test(e.name)) await fsp.copyFile(full, path.join(toDir, e.name));
  }
}

async function extractNatives(jars, dir) {
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, '_extract');
  for (const jar of jars) {
    await fsp.rm(tmp, { recursive: true, force: true });
    await extractArchive(jar, tmp);
    await copyNativesFlat(tmp, dir);
  }
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.writeFile(path.join(dir, '.done'), '');
}

/** Picks the client version for a server: its own version, or the latest release for proxies/custom jars. */
async function versionFor({ version, clientVersion, kind, type }) {
  const m = await getMojangManifest();
  const ids = new Set(m.versions.map((v) => v.id));
  if (clientVersion && clientVersion !== 'auto') {
    if (!ids.has(clientVersion)) throw new Error(`Unknown Minecraft version "${clientVersion}" in Settings → Client version`);
    return clientVersion;
  }
  if (kind !== 'proxy' && type !== 'custom') {
    if (ids.has(version)) return version;
    const base = String(version).split('-')[0];
    if (ids.has(base)) return base;
  }
  return m.latest.release;
}

/** Downloads everything a version needs. Returns what launch() needs. */
async function prepare(versionId, { log, progress }) {
  const m = await getMojangManifest();
  const entry = m.versions.find((v) => v.id === versionId);
  if (!entry) throw new Error(`Unknown Minecraft version ${versionId}`);

  const verDir = path.join(VERSIONS, versionId);
  const metaFile = path.join(verDir, `${versionId}.json`);
  let meta;
  if (await exists(metaFile)) meta = JSON.parse(await fsp.readFile(metaFile, 'utf8'));
  else {
    meta = await fetchJson(entry.url);
    await fsp.mkdir(verDir, { recursive: true });
    await fsp.writeFile(metaFile, JSON.stringify(meta));
  }

  const clientJar = path.join(verDir, `${versionId}.jar`);
  const c = meta.downloads.client;
  log(`Checking Minecraft ${versionId} game files...`);
  await downloadAll([{ url: c.url, dest: clientJar, sha1: c.sha1, size: c.size }], progress);

  const classpath = [];
  const nativeJars = [];
  const jobs = [];
  for (const lib of meta.libraries || []) {
    if (!rulesAllow(lib.rules)) continue;
    const d = lib.downloads || {};
    if (d.artifact && d.artifact.url) {
      const p = path.join(LIBS, d.artifact.path);
      jobs.push({ url: d.artifact.url, dest: p, sha1: d.artifact.sha1, size: d.artifact.size });
      if (!classpath.includes(p)) classpath.push(p);
      if (/:natives-/.test(lib.name)) nativeJars.push(p);
    }
    if (lib.natives && lib.natives[OS_NAME]) {
      const cls = lib.natives[OS_NAME].replace('${arch}', process.arch === 'ia32' ? '32' : '64');
      const a = d.classifiers && d.classifiers[cls];
      if (a) {
        const p = path.join(LIBS, a.path);
        jobs.push({ url: a.url, dest: p, sha1: a.sha1, size: a.size });
        nativeJars.push(p);
      }
    }
  }
  classpath.push(clientJar);
  const libCount = await downloadAll(jobs, progress);
  if (libCount) log(`Downloaded ${libCount} libraries.`);

  const nativesDir = path.join(ROOT, 'natives', versionId);
  if (!(await exists(path.join(nativesDir, '.done')))) {
    log('Extracting native libraries...');
    await extractNatives(nativeJars, nativesDir);
  }

  const ai = meta.assetIndex;
  const indexFile = path.join(ASSETS, 'indexes', `${ai.id}.json`);
  await downloadAll([{ url: ai.url, dest: indexFile, sha1: ai.sha1, size: ai.size }]);
  const index = JSON.parse(await fsp.readFile(indexFile, 'utf8'));
  const objects = Object.entries(index.objects).map(([name, o]) => ({
    name,
    url: `https://resources.download.minecraft.net/${o.hash.slice(0, 2)}/${o.hash}`,
    dest: path.join(ASSETS, 'objects', o.hash.slice(0, 2), o.hash),
    sha1: o.hash,
    size: o.size,
  }));
  log(`Checking ${objects.length} game assets (the first launch of a version downloads a few hundred MB)...`);
  const assetCount = await downloadAll(objects, progress);
  if (assetCount) log(`Downloaded ${assetCount} assets.`);

  const gameDir = path.join(ROOT, 'game', versionId);
  await fsp.mkdir(gameDir, { recursive: true });
  let gameAssets = ASSETS;
  if (index.virtual || index.map_to_resources) {
    // Pre-1.7 versions read assets from a plain folder tree instead of the hashed object store.
    gameAssets = index.map_to_resources ? path.join(gameDir, 'resources') : path.join(ASSETS, 'virtual', ai.id);
    for (const o of objects) {
      const target = path.join(gameAssets, o.name);
      if (await exists(target)) continue;
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.copyFile(o.dest, target);
    }
  }

  let loggingArg = null;
  const lc = meta.logging && meta.logging.client;
  if (lc && lc.file) {
    const f = path.join(ASSETS, 'log_configs', lc.file.id);
    await downloadAll([{ url: lc.file.url, dest: f, sha1: lc.file.sha1, size: lc.file.size }]);
    loggingArg = lc.argument.replace('${path}', f);
  }

  const major = java.toLts(meta.javaVersion ? meta.javaVersion.majorVersion : 8);
  const javaExe = await java.resolveJava(major, { log, progress });
  return { meta, versionId, classpath, nativesDir, gameDir, gameAssets, loggingArg, javaExe, major };
}

function collectArgs(list, vars, features) {
  const out = [];
  const sub = (s) => s.replace(/\$\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  for (const a of list || []) {
    if (typeof a === 'string') out.push(sub(a));
    else if (rulesAllow(a.rules, features)) out.push(...[].concat(a.value).map(sub));
  }
  return out;
}

// First-run screens (accessibility onboarding, multiplayer warning) would block the auto-join.
const FIRST_RUN_OPTIONS = {
  onboardAccessibility: 'false',
  skipMultiplayerWarning: 'true',
  joinedFirstServer: 'true',
  tutorialStep: 'none',
  pauseOnLostFocus: 'false',
};

function prepareOptions(gameDir) {
  const file = path.join(gameDir, 'options.txt');
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  } catch {
    /* first launch */
  }
  const seen = new Set();
  lines = lines.map((l) => {
    const key = l.slice(0, l.indexOf(':'));
    if (key in FIRST_RUN_OPTIONS && key !== 'pauseOnLostFocus') {
      seen.add(key);
      return `${key}:${FIRST_RUN_OPTIONS[key]}`;
    }
    if (key === 'pauseOnLostFocus') seen.add(key);
    return l;
  });
  for (const [k, v] of Object.entries(FIRST_RUN_OPTIONS)) if (!seen.has(k)) lines.push(`${k}:${v}`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

/** Starts the client and returns the child process. */
function launch(prep, { username, host, port, memoryMb = 2048 }) {
  const { meta } = prep;
  prepareOptions(prep.gameDir);
  const vars = {
    auth_player_name: username,
    version_name: prep.versionId,
    game_directory: prep.gameDir,
    assets_root: ASSETS,
    game_assets: prep.gameAssets,
    assets_index_name: meta.assetIndex.id,
    auth_uuid: offlineUuid(username),
    auth_access_token: '0',
    auth_session: '0',
    clientid: '',
    auth_xuid: '',
    user_type: 'legacy',
    user_properties: '{}',
    version_type: meta.type,
    natives_directory: prep.nativesDir,
    launcher_name: 'TreeHost',
    launcher_version: '1.0',
    classpath: prep.classpath.join(CP_SEP),
    classpath_separator: CP_SEP,
    library_directory: LIBS,
    quickPlayMultiplayer: `${host}:${port}`,
  };
  const supportsQuickPlay = JSON.stringify((meta.arguments && meta.arguments.game) || []).includes('is_quick_play_multiplayer');
  const features = { is_quick_play_multiplayer: supportsQuickPlay };

  let jvm;
  let game;
  if (meta.arguments) {
    jvm = collectArgs(meta.arguments.jvm, vars, features);
    game = collectArgs(meta.arguments.game, vars, features);
  } else {
    jvm = collectArgs(['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'], vars, features);
    game = collectArgs(meta.minecraftArguments.split(' '), vars, features);
  }
  if (!supportsQuickPlay) game.push('--server', host, '--port', String(port));

  const args = [`-Xmx${memoryMb}M`, '-Dlog4j2.formatMsgNoLookups=true'];
  if (prep.loggingArg) args.push(prep.loggingArg);
  args.push(...jvm, meta.mainClass, ...game);

  const logDir = path.join(ROOT, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = fs.createWriteStream(path.join(logDir, `${prep.versionId}-${username}.log`));
  const proc = spawn(prep.javaExe, args, { cwd: prep.gameDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.tail = [];
  const onData = (b) => {
    logFile.write(b);
    proc.tail.push(...b.toString().split(/\r?\n/).filter(Boolean));
    if (proc.tail.length > 40) proc.tail.splice(0, proc.tail.length - 40);
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('exit', () => logFile.end());
  return proc;
}

module.exports = { versionFor, prepare, launch };
