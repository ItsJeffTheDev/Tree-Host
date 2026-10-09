'use strict';
// World tools: pick a seed and a world type when a server is created, keep several worlds on one server and switch
// between them, and pre-generate the world with Chunky (installed for you) with live progress.
const fsp = require('fs').promises;
const path = require('path');

const NAME = /^[A-Za-z0-9_-]{1,32}$/;
const VOID_SETTINGS = JSON.stringify({ layers: [{ block: 'minecraft:air', height: 1 }], biome: 'minecraft:the_void' });

const TEMPLATES = {
  normal: { label: 'Normal', note: 'The usual Minecraft world.' },
  flat: { label: 'Flat', note: 'Perfectly flat grass: great for building.' },
  void: { label: 'Void', note: 'Empty sky with a small platform to start on: for skyblock-style or lobby builds.' },
  amplified: { label: 'Amplified', note: 'Huge mountains. Needs more memory and CPU.' },
  large_biomes: { label: 'Large biomes', note: 'Biomes 16 times bigger.' },
};

/** Minecraft 1.19 and newer use namespaced world types ("minecraft:flat"); older ones "FLAT". */
function newTypes(version) {
  const m = /^(\d+)\.(\d+)/.exec(String(version || ''));
  if (!m) return true;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > 1 || min >= 19;
}

/** server.properties for a world type and seed. */
function worldProps(version, { seed = '', template = 'normal' } = {}) {
  const ns = newTypes(version);
  const t = String(template || 'normal');
  if (!TEMPLATES[t]) throw Object.assign(new Error('Unknown world type'), { status: 400 });
  const cleanSeed = String(seed || '').replace(/[\r\n]/g, '').trim().slice(0, 64);
  const props = { 'level-seed': cleanSeed };
  if (t === 'normal') Object.assign(props, { 'level-type': ns ? 'minecraft:normal' : 'DEFAULT', 'generator-settings': '{}', 'generate-structures': 'true' });
  if (t === 'flat') Object.assign(props, { 'level-type': ns ? 'minecraft:flat' : 'FLAT', 'generator-settings': '{}', 'generate-structures': 'true' });
  if (t === 'void') Object.assign(props, { 'level-type': ns ? 'minecraft:flat' : 'FLAT', 'generator-settings': VOID_SETTINGS, 'generate-structures': 'false' });
  if (t === 'amplified') Object.assign(props, { 'level-type': ns ? 'minecraft:amplified' : 'AMPLIFIED', 'generator-settings': '{}', 'generate-structures': 'true' });
  if (t === 'large_biomes') Object.assign(props, { 'level-type': ns ? 'minecraft:large_biomes' : 'LARGEBIOMES', 'generator-settings': '{}', 'generate-structures': 'true' });
  return props;
}

const stoppedOnly = (inst, what) => {
  if (inst.proc || inst.status !== 'stopped') throw Object.assign(new Error(`Stop the server first, then ${what}.`), { status: 400 });
};

/** The worlds on this server (folders with a level.dat), the one in use, and pre-generation progress. */
async function list(inst) {
  const props = await inst.getProperties();
  const current = props['level-name'] || 'world';
  const out = [];
  for (const e of await fsp.readdir(inst.dir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || /_(nether|the_end)$/.test(e.name)) continue;
    const st = await fsp.stat(path.join(inst.dir, e.name, 'level.dat')).catch(() => null);
    if (st) out.push({ name: e.name, current: e.name === current, lastPlayed: st.mtimeMs });
  }
  if (!out.some((w) => w.current)) out.unshift({ name: current, current: true, lastPlayed: null, notCreated: true });
  return {
    current,
    seed: props['level-seed'] || '',
    worlds: out.sort((a, b) => (b.current - a.current) || a.name.localeCompare(b.name)),
    templates: Object.entries(TEMPLATES).map(([id, t]) => ({ id, ...t })),
    pregen: inst.pregen || null,
    chunky: await hasChunky(inst),
  };
}

/** A new world: it's generated the next time the server starts. */
async function create(inst, { name, seed, template }) {
  const n = String(name || '').trim();
  if (!NAME.test(n)) throw Object.assign(new Error('World names can use letters, numbers, - and _ (up to 32).'), { status: 400 });
  if (await fsp.stat(path.join(inst.dir, n)).catch(() => null)) throw Object.assign(new Error('There is already a world with that name. Switch to it instead.'), { status: 400 });
  stoppedOnly(inst, 'make a new world');
  await inst.setProperties({ 'level-name': n, ...worldProps(inst.cfg.version, { seed, template }) });
  inst.cfg.worldInit = template === 'void' ? { world: n } : null;
  inst.save();
  return n;
}

async function switchTo(inst, name) {
  const n = String(name || '');
  if (!NAME.test(n) || !(await fsp.stat(path.join(inst.dir, n, 'level.dat')).catch(() => null))) throw Object.assign(new Error('World not found'), { status: 404 });
  stoppedOnly(inst, 'switch worlds');
  await inst.setProperties({ 'level-name': n });
  return n;
}

async function remove(inst, name) {
  const n = String(name || '');
  if (!NAME.test(n)) throw Object.assign(new Error('World not found'), { status: 404 });
  const current = (await inst.getProperties())['level-name'] || 'world';
  if (n === current) throw Object.assign(new Error("You can't delete the world in use. Switch to another one first."), { status: 400 });
  stoppedOnly(inst, 'delete a world');
  for (const f of [n, `${n}_nether`, `${n}_the_end`]) await fsp.rm(path.join(inst.dir, f), { recursive: true, force: true });
  return n;
}

/** Called when a server finishes starting: builds the starting platform of a new void world. */
function onReady(inst) {
  const w = inst.cfg.worldInit;
  if (!w) return;
  inst.command('execute in minecraft:overworld run fill -3 63 -3 3 63 3 minecraft:grass_block');
  inst.command('setworldspawn 0 64 0');
  inst.sysLog('Built a small starting platform at 0, 64, 0 in the new void world.');
  delete inst.cfg.worldInit;
  inst.save();
}

// ----- pre-generation (Chunky) -----

async function hasChunky(inst) {
  const files = await fsp.readdir(inst.pluginDir).catch(() => []);
  return files.some((f) => /chunky/i.test(f) && /\.jar$/i.test(f));
}

/** Reads Chunky's progress lines from the console. */
function onLine(inst, line) {
  let m = /\[Chunky\] Task (running|finished|paused|cancelled|stopped) for ([\w:]+)\.?(?: Processed: (\d+) chunks \(([\d.]+)%\))?(?:, ETA: ([\d:]+))?/i.exec(line);
  if (m) {
    inst.pregen = {
      state: m[1].toLowerCase(),
      world: m[2],
      chunks: m[3] ? Number(m[3]) : (inst.pregen && inst.pregen.chunks) || 0,
      percent: m[4] ? Number(m[4]) : m[1].toLowerCase() === 'finished' ? 100 : (inst.pregen && inst.pregen.percent) || 0,
      eta: m[5] || null,
      at: Date.now(),
    };
    return;
  }
  m = /\[Chunky\] Task started for ([\w:]+)/i.exec(line);
  if (m) inst.pregen = { state: 'running', world: m[1], chunks: 0, percent: 0, eta: null, at: Date.now() };
}

const RADII = [500, 1000, 2000, 3000, 5000];

/** Starts, pauses, continues or cancels pre-generation. Installs Chunky first if needed (then a restart is needed). */
async function pregen(inst, { action, radius }, installChunky) {
  if (inst.kind === 'proxy') throw Object.assign(new Error('Proxies have no world.'), { status: 400 });
  if (!(await hasChunky(inst))) {
    if (action !== 'start') throw Object.assign(new Error('Chunky is not installed.'), { status: 400 });
    const r = await installChunky();
    return { installed: r.file, needsRestart: true };
  }
  if (!inst.proc || inst.status !== 'running') throw Object.assign(new Error('Start the server first: pre-generation runs while it is up.'), { status: 400 });
  if (action === 'start') {
    const r = Number(radius);
    if (!RADII.includes(r)) throw Object.assign(new Error('Pick a size'), { status: 400 });
    inst.command('chunky world world');
    inst.command(`chunky radius ${r}`);
    inst.command('chunky start');
    inst.pregen = { state: 'running', world: 'world', chunks: 0, percent: 0, eta: null, at: Date.now(), radius: r };
  } else if (action === 'pause') inst.command('chunky pause');
  else if (action === 'continue') inst.command('chunky continue');
  else if (action === 'cancel') {
    inst.command('chunky cancel');
    inst.command('chunky confirm');
    inst.pregen = null;
  } else throw Object.assign(new Error('Unknown action'), { status: 400 });
  return { ok: true };
}

module.exports = { TEMPLATES, worldProps, list, create, switchTo, remove, onReady, onLine, pregen, RADII };
