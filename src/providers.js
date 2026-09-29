'use strict';
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { CACHE } = require('./paths');
const java = require('./java');
const {
  fetchJson,
  fetchText,
  getMojangManifest,
  download,
  run,
  exists,
  compareVersions,
  jarJavaVersion,
} = require('./util');

const FILL = 'https://fill.papermc.io/v3/projects';
const PURPUR = 'https://api.purpurmc.org/v2/purpur';
const FABRIC = 'https://meta.fabricmc.net/v2';
const BUILDTOOLS_URL = 'https://hub.spigotmc.org/jenkins/job/BuildTools/lastSuccessfulBuild/artifact/target/BuildTools.jar';
const BUNGEE_URL = 'https://ci.md-5.net/job/BungeeCord/lastSuccessfulBuild/artifact/bootstrap/target/BungeeCord.jar';

const isPre = (v) => /-(pre|rc|beta|alpha)|snapshot/i.test(v);
const jarPath = (dir) => path.join(dir, 'server.jar');

/** Proxies and custom jars: Java from the jar's own bytecode, never below 21 for proxies. */
async function javaFromJar(dir, floor) {
  const detected = await jarJavaVersion(jarPath(dir));
  return java.toLts(Math.max(detected || 0, floor));
}

// ---------- PaperMC family (Fill API v3) ----------

function paperMc(id, label, extra) {
  const buildsUrl = (v) => `${FILL}/${id}/versions/${encodeURIComponent(v)}/builds`;
  return {
    id,
    label,
    hasBuilds: true,
    ...extra,
    async versions() {
      const d = await fetchJson(`${FILL}/${id}`);
      const list = [];
      for (const group of Object.values(d.versions)) for (const v of group) list.push({ id: v, pre: isPre(v) });
      return list;
    },
    async builds(version) {
      const builds = await fetchJson(buildsUrl(version), 5 * 60 * 1000);
      return builds
        .filter((b) => b.downloads && b.downloads['server:default'])
        .sort((a, b) => b.id - a.id)
        .map((b) => ({ id: String(b.id), channel: b.channel, time: b.time }));
    },
    async install({ version, build, dir, log, progress }) {
      const builds = (await fetchJson(buildsUrl(version), 30 * 1000))
        .filter((b) => b.downloads && b.downloads['server:default'])
        .sort((a, b) => b.id - a.id);
      const b =
        build && build !== 'latest'
          ? builds.find((x) => String(x.id) === String(build))
          : builds.find((x) => x.channel === 'STABLE') || builds[0];
      if (!b) throw new Error(`No ${label} build found for ${version}${build && build !== 'latest' ? ` #${build}` : ''}`);
      const dl = b.downloads['server:default'];
      log(`Downloading ${dl.name} (${b.channel.toLowerCase()} build #${b.id})...`);
      const checksum = dl.checksums && dl.checksums.sha256 ? { algo: 'sha256', value: dl.checksums.sha256 } : undefined;
      await download(dl.url, jarPath(dir), { onProgress: progress, checksum });
      return { build: String(b.id) };
    },
  };
}

// ---------- Spigot / CraftBukkit (BuildTools) ----------

// BuildTools refuses paths with spaces or "special characters" (including 8.3 short names like CHICKE~1),
// so build in the first location whose full, expanded path is plain.
function expand(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    const parent = path.dirname(p);
    return parent === p ? p : path.join(expand(parent), path.basename(p));
  }
}

function buildToolsDir() {
  const candidates = [
    path.join(CACHE, 'buildtools'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'MCPluginTest', 'buildtools'),
    path.join(os.homedir(), 'MCPluginTest', 'buildtools'),
    process.platform === 'win32' ? 'C:\\MCPluginTest\\buildtools' : '/tmp/MCPluginTest/buildtools',
  ]
    .filter(Boolean)
    .map(expand);
  return candidates.find((p) => /^[A-Za-z0-9_:\\/.]+$/.test(p)) || candidates[candidates.length - 1];
}

let buildToolsQueue = Promise.resolve();
function serialized(fn) {
  const p = buildToolsQueue.then(fn, fn);
  buildToolsQueue = p.catch(() => {});
  return p;
}

function buildTools(id, label, description) {
  return {
    id,
    label,
    family: 'bukkit',
    kind: 'server',
    description,
    hasBuilds: false,
    async versions() {
      const html = await fetchText('https://hub.spigotmc.org/versions/');
      const ids = [...html.matchAll(/href="(\d+\.\d+(?:\.\d+)?)\.json"/g)].map((m) => m[1]);
      return [...new Set(ids)].sort((a, b) => compareVersions(b, a)).map((v) => ({ id: v, pre: false }));
    },
    java: (version) => java.javaForMinecraft(version),
    async install({ version, dir, log, progress, force }) {
      const btDir = buildToolsDir();
      const outDir = path.join(btDir, 'output');
      const built = path.join(outDir, `${id}-${version}.jar`);
      if (force || !(await exists(built))) {
        await serialized(async () => {
          if (!force && (await exists(built))) return;
          await fsp.mkdir(outDir, { recursive: true });
          const bt = path.join(btDir, 'BuildTools.jar');
          const st = await fsp.stat(bt).catch(() => null);
          if (!st || Date.now() - st.mtimeMs > 3 * 86400000) {
            log('Downloading the latest BuildTools...');
            await download(BUILDTOOLS_URL, bt, { onProgress: progress });
          }
          const major = await java.javaForMinecraft(version);
          const javaExe = await java.resolveJava(major, { log, progress, jdk: true });
          const javaHome = path.dirname(path.dirname(javaExe));
          log(`Compiling ${label} ${version} with BuildTools (Java ${major}). The first build takes 5-15 minutes; later ones are cached.`);
          await run(javaExe, ['-jar', bt, '--rev', version, '--compile', id, '--output-dir', outDir, '--nogui'], {
            cwd: btDir,
            env: { JAVA_HOME: javaHome, PATH: `${path.join(javaHome, 'bin')}${path.delimiter}${process.env.PATH || ''}` },
            onLine: (l) => log(`[BuildTools] ${l}`),
          });
        });
      } else {
        log(`Using cached ${path.basename(built)}.`);
      }
      if (!(await exists(built))) throw new Error(`BuildTools finished but ${path.basename(built)} was not found in ${outDir}`);
      await fsp.copyFile(built, jarPath(dir));
      return { build: 'local' };
    },
  };
}

// ---------- Providers ----------

const providers = [
  paperMc('paper', 'Paper', {
    family: 'bukkit',
    kind: 'server',
    description: 'The most popular plugin server. Best default for testing Bukkit/Paper plugins.',
    java: (v) => java.javaForMinecraft(v),
  }),
  {
    id: 'purpur',
    label: 'Purpur',
    family: 'bukkit',
    kind: 'server',
    description: 'Paper fork with many extra gameplay options.',
    hasBuilds: true,
    async versions() {
      const d = await fetchJson(PURPUR);
      return [...d.versions].reverse().map((v) => ({ id: v, pre: isPre(v) }));
    },
    async builds(version) {
      const d = await fetchJson(`${PURPUR}/${encodeURIComponent(version)}`, 5 * 60 * 1000);
      return [...d.builds.all].reverse().map((b) => ({ id: String(b), channel: 'STABLE' }));
    },
    java: (v) => java.javaForMinecraft(v),
    async install({ version, build, dir, log, progress }) {
      const b = build && build !== 'latest' ? build : 'latest';
      const url = `${PURPUR}/${encodeURIComponent(version)}/${b}/download`;
      log(`Downloading Purpur ${version} (build ${b})...`);
      await download(url, jarPath(dir), { onProgress: progress });
      let resolved = b;
      if (b === 'latest') {
        try {
          resolved = (await fetchJson(`${PURPUR}/${encodeURIComponent(version)}`, 0)).builds.latest;
        } catch {
          /* cosmetic only */
        }
      }
      return { build: String(resolved) };
    },
  },
  paperMc('folia', 'Folia', {
    family: 'bukkit',
    kind: 'server',
    description: 'Paper with regionised multithreading. Use it to test Folia support.',
    java: (v) => java.javaForMinecraft(v),
  }),
  buildTools('spigot', 'Spigot', 'Compiled locally with BuildTools. The first build of each version takes several minutes.'),
  buildTools('craftbukkit', 'CraftBukkit', 'Plain Bukkit implementation, compiled locally with BuildTools.'),
  {
    id: 'vanilla',
    label: 'Vanilla',
    family: 'vanilla',
    kind: 'server',
    description: 'The official Mojang server (no plugins). Includes snapshots.',
    hasBuilds: false,
    async versions() {
      const m = await getMojangManifest();
      return m.versions
        .filter((v) => v.type === 'release' || v.type === 'snapshot')
        .map((v) => ({ id: v.id, pre: v.type !== 'release' }));
    },
    java: (v) => java.javaForMinecraft(v),
    async install({ version, dir, log, progress }) {
      const m = await getMojangManifest();
      const entry = m.versions.find((v) => v.id === version);
      if (!entry) throw new Error(`Unknown Minecraft version ${version}`);
      const meta = await fetchJson(entry.url);
      const server = meta.downloads && meta.downloads.server;
      if (!server) throw new Error(`Mojang does not publish a server jar for ${version}`);
      log(`Downloading Minecraft server ${version}...`);
      await download(server.url, jarPath(dir), { onProgress: progress, checksum: { algo: 'sha1', value: server.sha1 } });
      return { build: 'release' };
    },
  },
  {
    id: 'fabric',
    label: 'Fabric',
    family: 'fabric',
    kind: 'server',
    description: 'Lightweight mod loader. Mods go in the mods/ folder.',
    hasBuilds: true,
    buildLabel: 'Loader',
    async versions() {
      const list = await fetchJson(`${FABRIC}/versions/game`);
      return list.map((v) => ({ id: v.version, pre: !v.stable }));
    },
    async builds(version) {
      const list = await fetchJson(`${FABRIC}/versions/loader/${encodeURIComponent(version)}`, 5 * 60 * 1000);
      return list.map((l) => ({ id: l.loader.version, channel: l.loader.stable ? 'STABLE' : 'BETA' }));
    },
    java: (v) => java.javaForMinecraft(v),
    async install({ version, build, dir, log, progress }) {
      const loaders = await fetchJson(`${FABRIC}/versions/loader/${encodeURIComponent(version)}`, 60 * 1000);
      if (!loaders.length) throw new Error(`Fabric does not support ${version}`);
      const loader =
        build && build !== 'latest' ? build : (loaders.find((l) => l.loader.stable) || loaders[0]).loader.version;
      const installers = await fetchJson(`${FABRIC}/versions/installer`);
      const installer = (installers.find((i) => i.stable) || installers[0]).version;
      log(`Downloading Fabric server launcher (Minecraft ${version}, loader ${loader})...`);
      const url = `${FABRIC}/versions/loader/${encodeURIComponent(version)}/${loader}/${installer}/server/jar`;
      await download(url, jarPath(dir), { onProgress: progress });
      return { build: loader };
    },
  },
  paperMc('velocity', 'Velocity', {
    family: 'velocity',
    kind: 'proxy',
    description: 'Modern proxy. Test Velocity plugins or multi-server setups.',
    java: (v, dir) => javaFromJar(dir, 21),
  }),
  paperMc('waterfall', 'Waterfall', {
    family: 'bungee',
    kind: 'proxy',
    description: 'Paper\'s BungeeCord fork (end-of-life, kept for legacy testing).',
    java: (v, dir) => javaFromJar(dir, 21),
  }),
  {
    id: 'bungeecord',
    label: 'BungeeCord',
    family: 'bungee',
    kind: 'proxy',
    description: 'The original proxy from SpigotMC (latest build).',
    hasBuilds: false,
    async versions() {
      return [{ id: 'latest', pre: false }];
    },
    java: (v, dir) => javaFromJar(dir, 21),
    async install({ dir, log, progress }) {
      log('Downloading the latest BungeeCord...');
      await download(BUNGEE_URL, jarPath(dir), { onProgress: progress });
      return { build: 'latest' };
    },
  },
  {
    id: 'custom',
    label: 'Custom JAR',
    family: 'bukkit',
    kind: 'server',
    description: 'Use any server jar from disk (Pufferfish, Leaf, a fork you are building...).',
    hasBuilds: false,
    async versions() {
      return [];
    },
    java: (v, dir) => javaFromJar(dir, 8),
    async install({ dir, cfg, log }) {
      if (!cfg.customJar) throw new Error('Set the path to your server jar in Settings first.');
      if (!(await exists(cfg.customJar))) throw new Error(`Jar not found: ${cfg.customJar}`);
      log(`Copying ${cfg.customJar}...`);
      await fsp.copyFile(cfg.customJar, jarPath(dir));
      return { build: 'custom' };
    },
  },
];

const byId = new Map(providers.map((p) => [p.id, p]));

function getProvider(id) {
  const p = byId.get(id);
  if (!p) throw new Error(`Unknown server type "${id}"`);
  return p;
}

function describe() {
  return providers.map((p) => ({
    id: p.id,
    label: p.label,
    family: p.family,
    kind: p.kind,
    description: p.description,
    hasBuilds: p.hasBuilds,
    buildLabel: p.buildLabel || 'Build',
  }));
}

module.exports = { getProvider, describe };
