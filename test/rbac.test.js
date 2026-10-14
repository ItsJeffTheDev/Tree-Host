'use strict';
// Unit tests for role permissions surviving a save/load through the store (node --test, zero deps).
// Run: node --test test/rbac.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const { Rbac } = require('../src/rbac');

/** What the Realtime Database hands back: empty arrays and objects are gone. */
function rtdb(v) {
  if (Array.isArray(v)) {
    const a = v.map(rtdb).filter((x) => x !== undefined);
    return a.length ? a : undefined;
  }
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      const y = rtdb(x);
      if (y !== undefined) o[k] = y;
    }
    return Object.keys(o).length ? o : undefined;
  }
  return v;
}

let db = {};
store.save = (name, data) => ((db[name] = rtdb(JSON.parse(JSON.stringify(data)))), Promise.resolve());
store.load = (name) => Promise.resolve(db[name]);

test('RBAC-RTDB-001: a role with every permission removed stays empty after a restart', async () => {
  db = {};
  const a = new Rbac();
  await a.init();
  assert.ok(a.role('staff').permissions.length > 0, 'staff starts with default permissions');
  await a.setPermissions('staff', []);
  const b = new Rbac();
  await b.init();
  assert.deepEqual(b.role('staff').permissions, []);
  assert.equal(b.can({ role: 'staff' }, 'support.chat'), false);
  // Other roles keep what they had.
  assert.deepEqual(b.role('admin').permissions.sort(), a.role('admin').permissions.sort());
});

test('RBAC-RTDB-002: roles saved before _roles existed still load their saved permissions', async () => {
  db = {};
  const a = new Rbac();
  await a.init();
  await a.setPermissions('staff', ['support.chat']);
  delete db.roles._roles;
  const b = new Rbac();
  await b.init();
  assert.deepEqual(b.role('staff').permissions, ['support.chat']);
});
