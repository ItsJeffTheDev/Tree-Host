'use strict';
// One-time merge of the old separate team setup (team-data/) into the single data/ folder.
// Team servers keep being team servers; the old personal servers become the host admin's solo servers.
const fsp = require('fs').promises;
const path = require('path');
const { ROOT, DATA } = require('./paths');
const { exists } = require('./util');

async function readServers(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')).servers || [];
  } catch {
    return [];
  }
}

async function migrateTeamData() {
  const old = path.join(ROOT, 'team-data');
  // Only merge into the normal data folder (never into a custom MCPT_DATA location).
  if (path.resolve(DATA) !== path.resolve(ROOT, 'data')) return;
  const hasOld = (await exists(path.join(old, 'instances.json'))) || (await exists(path.join(old, 'team-users.json')));
  const marker = path.join(DATA, '.team-data-merged');
  if (!hasOld || (await exists(marker))) return;

  console.log('  Merging the separate team setup (team-data) into data ...');
  await fsp.mkdir(path.join(DATA, 'servers'), { recursive: true });

  // Accounts, logins and the playit.gg link move over unless data/ already has its own.
  for (const f of ['team-users.json', 'team-sessions.json', 'playit.json']) {
    const src = path.join(old, f);
    const dst = path.join(DATA, f);
    if ((await exists(src)) && !(await exists(dst))) await fsp.rename(src, dst);
  }

  const current = await readServers(path.join(DATA, 'instances.json'));
  const ids = new Set(current.map((c) => c.id));
  for (const cfg of await readServers(path.join(old, 'instances.json'))) {
    let id = cfg.id;
    while (ids.has(id)) id = `${id}-team`;
    const src = path.join(old, 'servers', cfg.id);
    if (await exists(src)) await fsp.rename(src, path.join(DATA, 'servers', id));
    current.push({ ...cfg, id, space: 'team', owner: null, lastPid: null });
    ids.add(id);
    console.log(`    moved team server "${cfg.name}"`);
  }
  await fsp.writeFile(path.join(DATA, 'instances.json'), JSON.stringify({ servers: current }, null, 2));
  await fsp.writeFile(marker, new Date().toISOString());

  // Keep what's left (downloaded Java, tunnel program) instead of deleting it, but out of the way.
  const stamp = new Date().toISOString().slice(0, 10);
  await fsp.rename(old, path.join(ROOT, `team-data-merged-${stamp}`)).catch(() => {});
  console.log('  Merge complete.');
}

module.exports = { migrateTeamData };
