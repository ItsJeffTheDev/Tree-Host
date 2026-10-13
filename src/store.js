'use strict';
// Where Tree Host keeps its business data (accounts, plans, subscriptions, activity).
// With Firebase set up, each collection lives in the Realtime Database (so it survives losing the machine) and a
// local copy is kept in the data folder as a backup. Without Firebase, only the local JSON files are used.
const fsp = require('fs').promises;
const crypto = require('crypto');
const path = require('path');
const { DATA } = require('./paths');
const firebase = require('./firebase');

const writers = new Map(); // name -> { pending, running }

/** Without Firebase everything lives in local files: say so once per start, not on every load and save. */
let warnedLocal = false;
function warnLocalOnly() {
  if (warnedLocal) return;
  warnedLocal = true;
  console.warn('  ⚠️  Firebase not enabled: accounts, plans, activity and the rest are kept in local files only (lost on redeploy).');
  console.warn('  ⚠️  Set FIREBASE_SERVICE_ACCOUNT and TREEHOST_TEAM=1 to enable Firebase sync.');
}

function localFile(name) {
  return path.join(DATA, `${name}.json`);
}

async function readLocal(name) {
  try {
    return JSON.parse(await fsp.readFile(localFile(name), 'utf8'));
  } catch {
    return undefined;
  }
}

async function writeLocal(name, data) {
  await fsp.mkdir(DATA, { recursive: true });
  const file = localFile(name);
  // A unique tmp name per write: two flushes of the same collection (e.g. one racing
  // shutdown, or two module inits saving in the same millisecond) can never rename over
  // each other's tmp file — pid + timestamp alone collided when two writes landed in
  // the same ms, which killed Render starts with ENOENT. Counter + random suffix makes
  // collisions impossible; the rename retry below is the belt-and-braces.
  for (let attempt = 0; ; attempt++) {
    const tmp = `${file}.${process.pid}.${Date.now()}.${(writeLocal.n = (writeLocal.n || 0) + 1).toString(36)}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      await fsp.rename(tmp, file);
      return;
    } catch (e) {
      await fsp.unlink(tmp).catch(() => {});
      if (attempt >= 2) throw e;
    }
  }
}

/**
 * The Realtime Database can't store empty arrays/objects or undefined, and it rejects keys with . $ # [ ] /.
 * Values go through JSON (drops undefined); callers normalize what they read back (missing arrays -> []).
 */
const clean = (data) => JSON.parse(JSON.stringify(data ?? null));

/** Loads a collection. With Firebase: the database copy wins; a local-only copy is uploaded once (migration). */
async function load(name) {
  const local = await readLocal(name);
  if (!firebase.dbEnabled()) {
    warnLocalOnly();
    return local;
  }
  const remote = await firebase.dbGet(name);
  if (remote !== null && remote !== undefined) {
    writeLocal(name, remote).catch(() => {});
    return remote;
  }
  if (local !== undefined) {
    console.log(`  Uploading ${name} to the Firebase Realtime Database...`);
    try {
      await firebase.dbSet(name, clean(local));
    } catch (e) {
      console.error(`  ⚠️  Failed to upload ${name} to Firebase: ${e.message}`);
      console.error(`  ⚠️  Data exists locally but not in Firebase. Check FIREBASE_SERVICE_ACCOUNT.`);
    }
  }
  return local;
}

/**
 * Saves a collection. Writes happen in order and only the newest pending version is sent,
 * so many quick saves become one database write.
 */
function save(name, data) {
  const snapshot = clean(data);
  let w = writers.get(name);
  if (!w) writers.set(name, (w = { pending: null, running: null }));
  w.pending = snapshot;
  if (!w.running) w.running = flush(name, w);
  return w.running;
}

async function flush(name, w) {
  try {
    while (w.pending !== null) {
      const data = w.pending;
      w.pending = null;
      // Another flush may have taken this snapshot while we awaited: leave the writing to it.
      if (data === null) break;
      await writeLocal(name, data);
      if (firebase.dbEnabled()) {
        for (let attempt = 1; ; attempt++) {
          try {
            await firebase.dbSet(name, data);
            break;
          } catch (e) {
            if (attempt >= 3 || w.pending !== null) {
              console.error(`  ⚠️  Could not save ${name} to Firebase: ${e.message}${w.pending !== null ? ' (a newer version follows)' : ''}`);
              console.error(`  ⚠️  Data saved locally only. Check FIREBASE_SERVICE_ACCOUNT configuration.`);
              console.error(`  ⚠️  See FIREBASE_DEBUGGING.md for troubleshooting.`);
              break;
            }
            console.error(`  Firebase save failed (attempt ${attempt}/3), retrying...`);
            await new Promise((r) => setTimeout(r, attempt * 2000));
          }
        }
      } else {
        warnLocalOnly();
      }
    }
  } finally {
    w.running = null;
  }
}

/** Waits for every pending write (used when Tree Host shuts down). */
async function flushAll() {
  // A failing writer (e.g. a tmp file already renamed away by a racing flush) must not
  // reject shutdown — the Firebase copy is the source of truth and the next start re-reads it.
  await Promise.allSettled([...writers.values()].map((w) => w.running).filter(Boolean));
}

module.exports = { load, save, flushAll };
