'use strict';
// Unit tests for src/metrics.js (node --test, zero deps).
// Run: node --test test/metrics.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('../src/store');
const { Metrics, enc, dec, roundPublic, referrerHostValue, refValue, normPath } = require('../src/metrics');

// every test runs with a quiet store (no local-file writes / warnings)
store.save = () => Promise.resolve();
store.load = () => Promise.resolve(undefined);

const day = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

test('enc/dec round-trip RTDB-unsafe keys', () => {
  for (const k of ['/pricing', '/pricing?x=1', 'discord.com', '/a.b$c#d[e]/f', 'demo.treehost.online', 'a-b_c', '%2f']) {
    assert.equal(dec(enc(k)), k, `round-trip ${k}`);
  }
  // every RTDB-forbidden char is gone after encoding
  assert.equal(/[$#[\]/]/.test(enc('/a.b$c#d[e]')), false);
  // '%' encodes itself, so dec() can never mis-parse
  assert.equal(enc('%'), '%25');
  assert.equal(dec('%25xy'), '%xy');
});

test('normPath strips query strings and fragments', () => {
  assert.equal(normPath('/pricing?x=1&y=2'), '/pricing');
  assert.equal(normPath('/donate#thanks'), '/donate');
  assert.equal(normPath('/a?x=1#frag'), '/a');
  assert.equal(normPath('pricing'), null); // must start with '/'
  assert.equal(normPath(''), null);
  assert.equal(normPath(null), null);
});

test('query-string stripping lands in one path bucket', () => {
  const m = new Metrics();
  m.count('pageview', { path: '/pricing?utm=discord' });
  m.count('pageview', { path: '/pricing' });
  assert.equal(m.totals.pv[enc('/pricing')], 2);
  assert.equal(Object.keys(m.totals.pv).length, 1);
});

test('day bucketing: same UTC day shares a bucket, different day gets a new one', () => {
  const m = new Metrics();
  m.count('pageview', { path: '/a' });
  m.count('pageview', { path: '/b' });
  const d1 = day();
  assert.equal(Object.keys(m.days).length, 1);
  assert.equal(m.days[d1].pv[enc('/a')], 1);
  assert.equal(m.days[d1].pv[enc('/b')], 1);
  const realNow = Date.now;
  Date.now = () => realNow() + 2 * 86400000; // mocked date, two days later
  try {
    m.count('pageview', { path: '/c' });
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(Object.keys(m.days).sort(), [d1, day(2)].sort()); // mocked now = today + 2d
  assert.equal(m.totals.pv[enc('/a')], 1);
});

test('referrerHost validation', () => {
  assert.equal(referrerHostValue('https://discord.com/xyz', 'treehost.online'), 'discord.com');
  assert.equal(referrerHostValue('http://google.com/search?q=x'), 'google.com');
  assert.equal(referrerHostValue('javascript:alert(1)'), null); // dropped
  assert.equal(referrerHostValue('ftp://files.example.com'), null);
  assert.equal(referrerHostValue('https://treehost.online/x', 'treehost.online'), 'direct'); // same-site
  assert.equal(referrerHostValue('https://treehost.online:8443/x', 'treehost.online'), 'direct');
  assert.equal(referrerHostValue('discord.com', 'treehost.online'), 'discord.com'); // bare host ok
  assert.equal(referrerHostValue('not a host', 'treehost.online'), null);
  assert.equal(referrerHostValue('', 'treehost.online'), 'direct'); // absent -> direct
  assert.equal(referrerHostValue(undefined, 'treehost.online'), 'direct');
});

test('ref allowlist: verbatim / other / absent not recorded', () => {
  const m = new Metrics();
  for (const r of ['discord', 'youtube', 'reddit', 'serverlist']) m.count('pageview', { path: '/p', ref: r, beacon: true });
  m.count('pageview', { path: '/p', ref: 'hackers', beacon: true });
  m.count('pageview', { path: '/p', beacon: true }); // absent -> not recorded
  const refs = m.totals.signupRef;
  for (const r of ['discord', 'youtube', 'reddit', 'serverlist', 'other']) assert.equal(refs[enc(r)], 1, r);
  assert.equal(Object.keys(refs).length, 5);
  assert.equal(refValue('DISCORD'), 'discord'); // normalized
  assert.equal(refValue(''), null);
  assert.equal(refValue(undefined), null);
  assert.equal(refValue('hackers'), 'other');
});

test('roundPublic table', () => {
  assert.deepEqual([0, 3, 7, 12, 97, 123].map(roundPublic), [0, 3, 7, 10, 95, 120]);
  assert.deepEqual([9, 10, 99, 100, 1004].map(roundPublic), [9, 10, 100, 100, 1000]);
  assert.deepEqual([undefined, null, 'x', -5].map(roundPublic), [0, 0, 0, 0]);
});

test('social(): rounded fields, week vs total, founding passthrough', () => {
  const m = new Metrics();
  m.count('signup', {});
  m.count('signup', {});
  m.count('demoLaunched', {});
  m.count('serverCreated', {});
  m.count('donationCompleted', {});
  const s = m.social({ foundingUnitsLeft: 23, foundingCapTotal: 25 });
  assert.deepEqual(s, {
    signupsThisWeek: 2, signupsTotal: 2, serversLaunched: 2, supporters: 1,
    foundingUnitsLeft: 25, foundingCapTotal: 25, rounded: true, // 23 rounds to the nearest 5 (n < 100)
  });
  assert.equal(m.social({ foundingUnitsLeft: 3 }).foundingUnitsLeft, 3); // n < 10 stays exact (sold-out critical range)
  assert.equal(m.social().foundingCapTotal, undefined); // not passed -> not present
  assert.equal(m.social({ foundingUnitsLeft: 0 }).foundingUnitsLeft, 0); // 0 stays 0
});

test('adminSummary(): week vs total, last-8-weeks series, refs, donations, checkouts, pageviews', () => {
  const m = new Metrics();
  const realNow = Date.now;
  // today: 1 pv, 2 signups, 1 checkout completed
  m.count('pageview', { path: '/pricing' });
  m.count('signup', { ref: 'discord' });
  m.count('signup', { ref: 'youtube' });
  m.count('checkoutCompleted', {});
  m.count('donationStarted', {});
  // 10 days ago: 1 pv, 1 signup, 1 donation completed
  Date.now = () => realNow() - 10 * 86400000;
  try {
    m.count('pageview', { path: '/donate' });
    m.count('signup', { ref: 'other' });
    m.count('donationCompleted', {});
  } finally {
    Date.now = realNow;
  }
  const a = m.adminSummary();
  assert.equal(a.funnel.visitors.total, 2);
  assert.equal(a.funnel.visitors.week, 1); // only today's pv is inside 7 days
  assert.equal(a.funnel.signups.total, 3);
  assert.equal(a.funnel.signups.week, 2);
  assert.equal(a.funnel.paid.total, 2); // checkout_completed + donation_completed
  assert.equal(a.funnel.paid.week, 1);
  assert.equal(a.donations.started, 1);
  assert.equal(a.donations.completed, 1);
  assert.equal(a.checkouts.started, 0);
  assert.equal(a.checkouts.completed, 1);
  assert.deepEqual(a.refs, { discord: 1, youtube: 1, other: 1 });
  assert.deepEqual(a.pageviewsByPath, { '/pricing': 1, '/donate': 1 });
  assert.equal(a.weeks.length, 8); // last 8 weeks
  const withData = a.weeks.filter((w) => w.signups > 0);
  assert.deepEqual(withData.map((w) => w.signups).sort(), [1, 2]);
  assert.deepEqual(withData.map((w) => w.visitors).sort(), [1, 1]);
  // totals survive: all-time counters do not come from pruned day buckets
  assert.equal(m.totals.signup, 3);
  assert.equal(m.totals.pageview === undefined || typeof m.totals.pageview === 'undefined', true); // pv lives in the pv map
});

test('per-host pageview split (pvHost)', () => {
  const m = new Metrics();
  m.count('pageview', { path: '/', host: 'treehost.online:443' });
  m.count('pageview', { path: '/', host: 'treehost.online' });
  m.count('pageview', { path: '/', host: 'demo.treehost.online' });
  assert.equal(m.totals.pvHost[enc('treehost.online')], 2);
  assert.equal(m.totals.pvHost[enc('demo.treehost.online')], 1);
  // split is per day bucket too
  const b = Object.values(m.days)[0];
  assert.equal(b.pvHost[enc('demo.treehost.online')], 1);
});

test('ring buffer capped at 200', () => {
  const m = new Metrics();
  for (let i = 0; i < 260; i++) m.count('signup', {});
  assert.equal(m.recent.length, 200);
  assert.equal(m.recent[199].type, 'signup'); // newest kept
  assert.equal(m.totals.signup, 260); // counts unaffected
});

test('throwing store.save never propagates out of count()', () => {
  const m = new Metrics();
  const realSave = store.save;
  store.save = () => Promise.reject(new Error('firebase down'));
  // save() is fire-and-forget with .catch(), so nothing escapes; also prove a synchronous throw is swallowed
  store.save = () => { throw new Error('sync boom'); };
  assert.doesNotThrow(() => m.count('pageview', { path: '/x' }));
  assert.doesNotThrow(() => m.count('signup', {}));
  store.save = realSave;
  // counters were still applied in memory
  assert.equal(m.totals.signup, 1);
});

test('dedup window: beacon within 60s of a server count is attribution-only', () => {
  const m = new Metrics();
  const realNow = Date.now;
  m.count('pageview', { path: '/pricing', host: 'treehost.online' }); // server-side count (serveStatic)
  m.count('pageview', { path: '/pricing', referrerHost: 'https://discord.com/xyz', ref: 'discord', host: 'treehost.online', beacon: true });
  assert.equal(m.totals.pv[enc('/pricing')], 1, 'beacon did not double-count');
  const b = Object.values(m.days)[0];
  assert.equal(b.pvRef[enc('discord.com')], 1, 'referrer still attributed');
  assert.equal(b.pvRef[enc('direct')], 1, 'server count attributed as direct');
  assert.equal(b.signupRef[enc('discord')], 1, 'ref still attributed');
  // a later load (outside the window) counts as a real pageview
  Date.now = () => realNow() + 61000;
  try {
    m.count('pageview', { path: '/pricing', beacon: true, host: 'treehost.online' });
  } finally {
    Date.now = realNow;
  }
  assert.equal(m.totals.pv[enc('/pricing')], 2, 'beacon outside the window counts');
});

test('dedup window is per (day, path): different path is not deduped', () => {
  const m = new Metrics();
  m.count('pageview', { path: '/a' });
  m.count('pageview', { path: '/b', beacon: true, host: 'treehost.online' });
  assert.equal(m.totals.pv[enc('/a')], 1);
  assert.equal(m.totals.pv[enc('/b')], 1);
});

test('totals survive the 180-day prune', () => {
  const m = new Metrics();
  const realNow = Date.now;
  // 200 days ago: 5 signups, 3 pageviews on /old
  Date.now = () => realNow() - 200 * 86400000;
  try {
    for (let i = 0; i < 5; i++) m.count('signup', { ref: 'discord' });
    for (let i = 0; i < 3; i++) m.count('pageview', { path: '/old' });
  } finally {
    Date.now = realNow;
  }
  // today: 1 signup, 1 pageview on /new
  m.count('signup', {});
  m.count('pageview', { path: '/new' });
  // saving prunes day buckets older than 180 days
  m.save();
  const days = Object.keys(m.days);
  assert.equal(days.length, 1, 'old day bucket pruned');
  assert.equal(days[0], day());
  // but all-time totals are untouched
  assert.equal(m.totals.signup, 6);
  assert.equal(m.totals.pv[enc('/old')], 3);
  assert.equal(m.totals.pv[enc('/new')], 1);
  assert.equal(m.totals.signupRef[enc('discord')], 5);
  assert.equal(m.adminSummary().funnel.signups.total, 6);
  assert.equal(m.adminSummary().funnel.signups.week, 1);
});

test('load() normalizes a saved document (missing fields, raw keys, junk)', async () => {
  const saved = JSON.stringify({
    v: 1,
    totals: { signup: '4', pv: { '/pricing': 2 }, junk: 5, donationCompleted: 1 },
    days: { '2026-01-01': { pv: { '/x': 1 }, signup: 2 }, 'bad-day': { signup: 9 } },
    recent: [{ t: 1, type: 'signup' }, null, { t: 2 }],
  });
  const realLoad = store.load;
  store.load = () => Promise.resolve(JSON.parse(saved));
  try {
    const m = await new Metrics().init();
    assert.equal(m.totals.signup, 4);
    assert.equal(m.totals.pv[enc('/pricing')], 2);
    assert.equal(m.totals.pv['/pricing'], undefined); // raw key re-encoded on load
    assert.equal(m.totals.junk, undefined);
    assert.equal(m.days['2026-01-01'].signup, 2);
    assert.equal(m.days['2026-01-01'].pv[enc('/x')], 1);
    assert.equal(m.days['bad-day'], undefined);
    assert.equal(m.recent.length, 2);
  } finally {
    store.load = realLoad;
  }
});

test('save() snapshot shape: fire-and-forget, never awaits, prunes before saving', async () => {
  const seen = [];
  const realSave = store.save;
  store.save = (name, data) => { seen.push({ name, data }); return new Promise(() => {}); }; // never settles
  try {
    const m = new Metrics();
    m.count('pageview', { path: '/p' });
    assert.equal(seen.length, 1, 'save attempted');
    assert.equal(seen[0].name, 'metrics');
    assert.deepEqual(Object.keys(seen[0].data).sort(), ['days', 'recent', 'totals', 'v']);
    assert.ok(Array.isArray(seen[0].data.recent));
    // no RTDB-unsafe key anywhere in the saved document
    const flat = JSON.stringify(seen[0].data);
    const doc = seen[0].data;
    const checkKeys = (obj, path = '') => {
      for (const [k, v] of Object.entries(obj)) {
        assert.equal(/[$#[\]/]/.test(k), false, `unsafe key ${k} at ${path}`);
        if (v && typeof v === 'object') checkKeys(v, path + '.' + k);
      }
    };
    checkKeys(doc);
  } finally {
    store.save = realSave;
  }
});

test('count() ignores unknown types and invalid pageviews', () => {
  const m = new Metrics();
  m.count('pageview', { path: 'no-slash' });
  m.count('pageview', {});
  m.count('madeUpType', {});
  m.count('signup'); // works with no options
  assert.equal(Object.keys(m.totals.pv).length, 0);
  assert.equal(m.totals.signup, 1);
  assert.equal(m.recent.length, 1);
});

test('recent entries carry t, type, path, ref only (no identifiers)', () => {
  const m = new Metrics();
  m.count('pageview', { path: '/pricing?x=1', referrerHost: 'https://discord.com', ref: 'discord', host: 'treehost.online' });
  const e = m.recent[m.recent.length - 1];
  assert.deepEqual(Object.keys(e).sort(), ['path', 'ref', 't', 'type']);
  assert.equal(e.path, '/pricing');
  assert.equal(e.ref, 'discord');
  assert.ok(Number.isFinite(e.t));
});
