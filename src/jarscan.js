'use strict';
// Checks uploaded plugin and mod jars for known Minecraft malware before they're installed: class paths and servers
// used by fractureiser (the 2023 backdoor spread through CurseForge and Bukkit uploads) and other known
// plugin-stealers. Jars inside the jar (shaded or bundled ones) are checked too. It looks for known signs only:
// a jar that passes isn't guaranteed safe, but one that matches is certainly not.

const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { forEachEntry } = require('./zip');

// [what it is, the bytes to look for in any file inside the jar]
const SIGNS = [
  ['fractureiser', 'dev/neko/nekoinjector'],
  ['fractureiser', 'dev/neko/nekoclient'],
  ['fractureiser', 'dev/neko/e/'],
  ['fractureiser', '85.217.144.130'],
  ['fractureiser', '107.189.3.101'],
  ['fractureiser', 'files-8ie.pages.dev'],
  ['fractureiser', 'neko.run'],
  ['Skyrage', 'skyrage.de'],
  ['Skyrage', 'files.skyrage'],
].map(([family, s]) => [family, s, Buffer.from(s)]);

/** Returns { infected: false } or { infected: true, family, sign, entry }. */
async function scanJar(file, depth = 0) {
  let hit = null;
  const nested = [];
  await forEachEntry(file, async (name, data) => {
    if (hit) return;
    for (const [family, sign, bytes] of SIGNS) {
      if (name.includes(sign) || data.includes(bytes)) {
        hit = { infected: true, family, sign, entry: name };
        return;
      }
    }
    if (depth < 2 && /\.jar$/i.test(name) && data.length < 64 * 1024 ** 2) nested.push(data);
  });
  if (hit) return hit;
  for (const data of nested) {
    const tmp = path.join(os.tmpdir(), `th-scan-${crypto.randomBytes(6).toString('hex')}.jar`);
    await fsp.writeFile(tmp, data);
    try {
      const r = await scanJar(tmp, depth + 1).catch(() => ({ infected: false }));
      if (r.infected) return r;
    } finally {
      await fsp.rm(tmp, { force: true });
    }
  }
  return { infected: false };
}

module.exports = { scanJar };
