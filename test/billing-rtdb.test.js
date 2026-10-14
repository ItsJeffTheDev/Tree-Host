'use strict';
// Billing records loaded the way the Realtime Database returns them (empty arrays/objects dropped).
// Run: node --test test/billing-rtdb.test.js

process.env.BILLING_DEMO = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const { Billing } = require('../src/billing');

let db = {};
store.save = () => Promise.resolve();
store.load = (name) => Promise.resolve(db[name]);

test('BILL-RTDB-001: a flat-price comparison host saved with prices {} loads back with prices', async () => {
  db = { plans: { settings: { competitors: { checkedAt: '2026-10-01', hosts: [{ name: 'Realms', flatCents: 799 }, { name: 'X', prices: { 4096: 900 } }] } } } };
  const b = new Billing();
  await b.init();
  const c = b.competitors();
  assert.deepEqual(c.hosts.map((h) => h.prices), [{}, { 4096: 900 }]);
  assert.equal(c.checkedAt, '2026-10-01');
});

test('BILL-RTDB-002: a comparison emptied by staff (hosts dropped) is an empty list, not undefined', async () => {
  db = { plans: { settings: { competitors: { checkedAt: '2026-10-01' } } } };
  const b = new Billing();
  await b.init();
  assert.deepEqual(b.competitors().hosts, []);
});
