'use strict';
// Search and install plugins/mods from Modrinth (https://modrinth.com), matched to the server's type and version.
const fsp = require('fs').promises;
const path = require('path');
const { download } = require('./util');

const API = 'https://api.modrinth.com/v2';
const UA = 'HoneyPixelStudios/HoneyHost/1.0 (Minecraft test server manager)';

/** Which Modrinth loaders fit a server, most specific first. */
function loadersFor(inst) {
  const type = inst.cfg.type;
  if (type === 'folia') return ['folia'];
  if (type === 'purpur') return ['purpur', 'paper', 'spigot', 'bukkit'];
  if (type === 'paper' || type === 'custom') return ['paper', 'spigot', 'bukkit'];
  if (type === 'spigot' || type === 'craftbukkit') return ['spigot', 'bukkit'];
  if (inst.provider.family === 'velocity') return ['velocity'];
  if (inst.provider.family === 'bungee') return ['bungeecord', 'waterfall'];
  if (inst.provider.family === 'fabric') return ['fabric'];
  return [];
}

/** Proxies have their own version numbers; everything else filters by Minecraft version. */
function gameVersion(inst) {
  return inst.kind === 'proxy' ? null : String(inst.cfg.version).split('-')[0];
}

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw Object.assign(new Error(`Modrinth answered ${res.status}`), { status: 502 });
  return res.json();
}

async function search(inst, query) {
  const loaders = loadersFor(inst);
  if (!loaders.length) throw Object.assign(new Error('Vanilla servers can\'t use plugins or mods.'), { status: 400 });
  const facets = [loaders.map((l) => `categories:${l}`)];
  const gv = gameVersion(inst);
  if (gv) facets.push([`versions:${gv}`]);
  if (inst.provider.family === 'fabric') facets.push(['server_side:required', 'server_side:optional']);
  const q = new URLSearchParams({ query: String(query || ''), limit: '20', index: query ? 'relevance' : 'downloads', facets: JSON.stringify(facets) });
  const data = await get(`${API}/search?${q}`);
  return data.hits.map((h) => ({
    id: h.project_id,
    slug: h.slug,
    title: h.title,
    description: h.description,
    icon: h.icon_url || null,
    downloads: h.downloads,
    author: h.author,
    url: `https://modrinth.com/project/${h.slug}`,
  }));
}

/** Downloads the newest version of a project that fits the server into its plugins/mods folder. */
async function install(inst, projectId) {
  if (!/^[\w-]{3,64}$/.test(String(projectId))) throw Object.assign(new Error('Unknown project'), { status: 400 });
  const loaders = loadersFor(inst);
  const q = new URLSearchParams({ loaders: JSON.stringify(loaders) });
  const gv = gameVersion(inst);
  if (gv) q.set('game_versions', JSON.stringify([gv]));
  const versions = await get(`${API}/project/${projectId}/version?${q}`);
  const v = versions.find((x) => x.version_type === 'release') || versions[0];
  if (!v) throw Object.assign(new Error(`No version of this ${inst.pluginDirName === 'mods' ? 'mod' : 'plugin'} fits ${inst.provider.label} ${inst.cfg.version}.`), { status: 400 });
  const file = v.files.find((f) => f.primary) || v.files[0];
  const name = path.basename(file.filename);
  if (!/\.jar$/i.test(name)) throw Object.assign(new Error('That download is not a .jar file.'), { status: 400 });
  await fsp.mkdir(inst.pluginDir, { recursive: true });
  await download(file.url, path.join(inst.pluginDir, name), file.hashes && file.hashes.sha1 ? { checksum: { algo: 'sha1', value: file.hashes.sha1 } } : {});
  return { file: name, version: v.version_number };
}

module.exports = { search, install };
