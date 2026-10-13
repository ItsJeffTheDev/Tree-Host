'use strict';
// Unit tests for src/creators.js (node --test, zero deps) — spec §11 C-* table.
// Run: node --test test/creators.test.js
//
// Quiet in-memory store pattern of the existing suites: save/load are stubbed out and every
// test builds a fresh Creators() with an in-memory promo map behind the injected hooks.

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const { Creators, tierFor, TIER_LADDER, RESERVED_CODES, PAYOUT_METHODS } = require('../src/creators');
const { refValue } = require('../src/metrics');

store.save = () => Promise.resolve();
store.load = () => Promise.resolve(undefined);

/** Fresh Creators with an in-memory promo map behind the promo hooks (like creators.smoke.js). */
function newCreators() {
  const m = new Creators();
  const promos = new Map();
  m.hooks.promoExists = (code) => promos.has(String(code).toUpperCase());
  m.hooks.createPromo = async ({ code, percentOff, note }) => {
    const c = String(code).toUpperCase();
    if (promos.has(c)) throw Object.assign(new Error('exists'), { status: 400 });
    promos.set(c, { code: c, percentOff, note, active: true });
    return promos.get(c);
  };
  m.hooks.updateViewerPromo = async (code, patch) => {
    const p = promos.get(String(code).toUpperCase());
    if (!p) return null;
    if (patch.percentOff !== undefined) p.percentOff = patch.percentOff;
    if (patch.active !== undefined) p.active = patch.active;
    return p;
  };
  m.hooks.viewerPromo = (code) => promos.get(String(code).toUpperCase()) || null;
  m.promos = promos; // exposed so a test can spy on the mint contract
  return m;
}

/** Wires hooks.userById to an in-memory user map with an attributed user u1 (creatorCode SPARK). */
function withUsers(m) {
  const users = new Map();
  m.hooks.userById = (id) => users.get(id) || null;
  users.set('u1', { id: 'u1', username: 'ender', creatorCode: 'SPARK' });
  return users;
}

const sub = (id, priceCents, extra = {}) =>
  ({ id, userId: 'u1', priceCents, discountCents: 0, planName: 'Sapling', ...extra });

test('C-CODE-001: code normalization + validation (valid create, bad chars, bad length)', async () => {
  const m = newCreators();
  const r = await m.create({ name: 'Alex', code: ' spark ' }, 'owner');
  assert.equal(r.code, 'SPARK'); // trimmed + uppercased; stored exactly as typed (uppercased)
  assert.equal(m.byCode('spark').code, 'SPARK'); // lookup normalizes case-insensitively
  // junk that cleanCode would silently strip is rejected, not repaired
  await assert.rejects(() => m.create({ name: 'B', code: 'has space!' }, 'owner'), (e) => e.status === 400);
  await assert.rejects(() => m.create({ name: 'B', code: '!!!' }, 'owner'), (e) => e.status === 400);
  // length 3-32
  await assert.rejects(() => m.create({ name: 'B', code: 'AB' }, 'owner'), (e) => e.status === 400);
  await assert.rejects(() => m.create({ name: 'B', code: 'A'.repeat(33) }, 'owner'), (e) => e.status === 400);
  await assert.rejects(() => m.create({ name: 'B', code: '' }, 'owner'), (e) => e.status === 400);
});

test('C-CODE-002/003: reserved words + promo collisions -> 409', async () => {
  const m = newCreators();
  for (const w of RESERVED_CODES) {
    await assert.rejects(() => m.create({ name: 'X', code: w.toUpperCase() }, 'owner'),
      (e) => e.status === 409, w);
  }
  // duplicate creator code (case-insensitive) -> 409
  await m.create({ name: 'A', code: 'SPARK' }, 'owner');
  await assert.rejects(() => m.create({ name: 'B', code: 'spark' }, 'owner'), (e) => e.status === 409);
  // collision with an existing promo code -> 409
  const promos = new Map([['TREE10', { code: 'TREE10' }]]);
  m.hooks.promoExists = (c) => promos.has(String(c).toUpperCase());
  await assert.rejects(() => m.create({ name: 'B', code: 'tree10' }, 'owner'), (e) => e.status === 409);
  assert.equal(m.creators.length, 1); // failed creates never leave a record behind
});

test('C-TIER-001: tierFor ladder boundaries 0/5/25', () => {
  assert.deepEqual(TIER_LADDER.map((t) => t.percent), [10, 15, 20]);
  for (const p of [0, 1, 4]) assert.equal(tierFor(p).id, 'bronze');
  assert.equal(tierFor(5).id, 'silver');  // boundary exactly at 5
  assert.equal(tierFor(24).id, 'silver');
  assert.equal(tierFor(25).id, 'gold');   // boundary exactly at 25
  assert.equal(tierFor(26).id, 'gold');
  assert.equal(tierFor(-3).percent, 10);  // negative clamps to the bottom
  assert.equal(tierFor('x').percent, 10); // non-numeric clamps to the bottom
});

test('C-TIER-002: promote-only bestTier — clawback never demotes, next commission at 20%', async () => {
  const m = newCreators();
  const users = withUsers(m);
  await m.create({ name: 'A', code: 'SPARK' }, 'owner');
  const c = m.byCode('SPARK');
  for (let i = 0; i < 25; i++) await m.postCommission(sub(`sub_g${i}`, 1000));
  assert.equal(c.bestTier, 'gold');
  const bal = c.stats.balanceCents; // 3500 = 5@10% (500) + 20@15% (3000): the 25th also paid at silver
  assert.equal(bal, 3500);
  // refund one silver commission — bestTier sticks
  await m.clawback({ id: 'sub_g24' });
  assert.equal(c.bestTier, 'gold');
  assert.equal(c.stats.payingReferrals, 25); // never decremented by a clawback
  // next commission still posts at gold 20%
  await m.postCommission(sub('sub_g25', 1000));
  assert.equal(m.ledger.at(-1).amountCents, 200);
  assert.equal(m.ledger.at(-1).tierAtPost, 'gold');
  assert.equal(c.stats.balanceCents, bal - 150 + 200); // refund the silver entry, re-earn at gold 20%
  // reconcile also never demotes: bestTier is the max tier any commission posted at
  m.reconcile();
  assert.equal(c.bestTier, 'gold');
  assert.ok(users.has('u1'));
});

test('C-COM-001..004: commission math, idempotency (GAP-3), first-payment-only, discounted base', async () => {
  const m = newCreators();
  withUsers(m);
  await m.create({ name: 'A', code: 'SPARK' }, 'owner');
  const c = m.byCode('SPARK');
  // C-COM-001: bronze 10% on $10 -> $1.00
  await m.postCommission(sub('sub_1', 1000));
  const e1 = m.ledger[0];
  assert.equal(e1.amountCents, 100);
  assert.equal(e1.percent, 10);
  assert.equal(e1.tierAtPost, 'bronze');
  assert.equal(c.stats.earnedCents, 100);
  assert.equal(c.stats.payingReferrals, 1);
  // C-COM-002: postCommission twice with the same subId -> exactly one ledger entry (double guard GAP-3)
  const before = m.ledger.length;
  await m.postCommission({ ...sub('sub_1', 1000) }); // marker not set on this copy: ledger lookup catches it
  const s1 = { ...sub('sub_1', 1000), commissionPosted: true };
  await m.postCommission(s1); // and the sub marker path
  assert.equal(m.ledger.length, before);
  assert.equal(c.stats.earnedCents, 100);
  // C-COM-003: a renewal (already-posted sub) posts nothing — first payment only
  assert.equal(s1.commissionPosted, true);
  // tier-at-post-time: the 5th pays at pre-promotion percent (bronze 10%) then promotes
  for (let i = 0; i < 3; i++) await m.postCommission(sub(`sub_b${i}`, 1000));
  await m.postCommission(sub('sub_5', 1500));
  assert.equal(c.stats.payingReferrals, 5);
  assert.equal(m.ledger.at(-1).amountCents, 150); // $15 at bronze 10%, not silver 15%
  assert.equal(m.ledger.at(-1).tierAtPost, 'bronze');
  assert.equal(c.bestTier, 'silver'); // promoted by the 5th payment
  await m.postCommission(sub('sub_6', 1500));
  assert.equal(m.ledger.at(-1).amountCents, 225); // silver 15% on $15
  // gold on $199 -> $39.80
  for (let i = 6; i < 25; i++) await m.postCommission(sub(`sub_m${i}`, 1000));
  await m.postCommission(sub('sub_25', 19900));
  assert.equal(m.ledger.at(-1).amountCents, 3980);
  assert.equal(m.ledger.at(-1).percent, 20);
  // C-COM-004: base = priceCents - discountCents (the amount actually charged)
  await m.postCommission(sub('sub_d', 19900, { discountCents: 10000 }));
  assert.equal(m.ledger.at(-1).amountCents, 1980); // (19900-10000) * 20% (gold tier by now)
  // no creatorCode on the user -> nothing posted
  m.hooks.userById = () => ({ id: 'u2', username: 'plain' });
  assert.equal(await m.postCommission({ id: 'sub_x', userId: 'u2', priceCents: 1000 }), null);
});

test('C-COM-004b: hook errors are swallowed — postCommission never throws into billing', async () => {
  const m = newCreators();
  withUsers(m);
  await m.create({ name: 'A', code: 'SPARK' }, 'owner');
  m.hooks.userById = () => { throw new Error('userById blew up'); };
  m.hooks.activity = () => { throw new Error('activity blew up'); };
  assert.equal(await m.postCommission({ id: 'sub_e1', userId: 'u1', priceCents: 1000 }), null);
  assert.equal(m.ledger.length, 0); // nothing half-posted
});

test('C-CLAW-001/002: exact reversal incl. negative balance; no-op when no commission entry', async () => {
  const m = newCreators();
  withUsers(m);
  await m.create({ name: 'A', code: 'SPARK' }, 'owner');
  const c = m.byCode('SPARK');
  await m.postCommission(sub('sub_r1', 19900, { planName: 'Founding' })); // 1990 @ bronze
  assert.equal(c.stats.balanceCents, 1990);
  assert.equal(c.stats.earnedCents, 1990);
  // payout everything, then refund the payment -> balance goes negative
  await m.markPayout('SPARK', { amountCents: 1990, method: 'paypal', reference: 'PAYID-1' }, 'owner');
  assert.equal(c.stats.balanceCents, 0);
  const undo = await m.clawback({ id: 'sub_r1' });
  assert.equal(undo.type, 'clawback');
  assert.equal(undo.amountCents, -1990); // exact original amount reversed
  assert.equal(undo.percent, 10);        // exact original percent recorded
  assert.equal(undo.ofEntry, m.ledger[0].id);
  assert.equal(c.stats.balanceCents, -1990); // may go negative
  assert.equal(c.stats.earnedCents, 0);
  assert.equal(c.stats.payingReferrals, 1); // never decremented
  // double clawback is a no-op
  const n = m.ledger.length;
  assert.equal(await m.clawback({ id: 'sub_r1' }), null);
  assert.equal(m.ledger.length, n);
  // C-CLAW-002: a sub that never posted a commission -> no-op, no entry, no throw
  assert.equal(await m.clawback({ id: 'sub_never' }), null);
  assert.equal(await m.clawback(null), null);
  assert.equal(m.ledger.length, n);
});

test('C-PAY-001: payout marking — negative ledger entry, balance reduced, by/method/reference recorded', async () => {
  const m = newCreators();
  withUsers(m);
  await m.create({ name: 'A', code: 'SPARK' }, 'owner');
  const c = m.byCode('SPARK');
  await m.postCommission(sub('sub_p1', 10000)); // 1000
  const e = await m.markPayout('SPARK', { amountCents: 400, method: 'iban', reference: 'IBAN-4', note: 'part one' }, 'owner');
  assert.equal(e.type, 'payout');
  assert.equal(e.amountCents, -400);
  assert.equal(e.balanceAfterCents, 600);
  assert.equal(e.method, 'iban');
  assert.equal(e.reference, 'IBAN-4');
  assert.equal(e.by, 'owner');
  assert.equal(e.note, 'part one');
  assert.equal(c.stats.balanceCents, 600);   // partial payout leaves the remainder
  assert.equal(c.stats.paidOutCents, 400);
  assert.ok(PAYOUT_METHODS.includes('paypal'));
});

test('C-PAY-002: payout guards — 400 validation, 409 overpay / negative balance', async () => {
  const m = newCreators();
  withUsers(m);
  await m.create({ name: 'A', code: 'SPARK' }, 'owner');
  const c = m.byCode('SPARK');
  await m.postCommission(sub('sub_p2', 10000)); // balance 1000
  await assert.rejects(() => m.markPayout('SPARK', { amountCents: 1001, method: 'paypal', reference: 'X' }, 'o'),
    (e) => e.status === 409); // overpay
  await assert.rejects(() => m.markPayout('SPARK', { amountCents: -5, method: 'paypal', reference: 'X' }, 'o'),
    (e) => e.status === 400); // non-positive
  await assert.rejects(() => m.markPayout('SPARK', { amountCents: 'abc', method: 'paypal', reference: 'X' }, 'o'),
    (e) => e.status === 400); // not a number
  await assert.rejects(() => m.markPayout('SPARK', { amountCents: 100, method: 'bitcoin', reference: 'X' }, 'o'),
    (e) => e.status === 400); // bad method
  await assert.rejects(() => m.markPayout('SPARK', { amountCents: 100, method: 'paypal', reference: '' }, 'o'),
    (e) => e.status === 400); // missing reference
  await assert.rejects(() => m.markPayout('NOPE', { amountCents: 100, method: 'paypal', reference: 'X' }, 'o'),
    (e) => e.status === 404);
  assert.equal(m.ledger.length, 1); // failed payouts leave no ledger entries
  // payout from a negative balance -> 409 (balance 1000 - full payout, then clawback)
  await m.markPayout('SPARK', { amountCents: 1000, method: 'paypal', reference: 'PAY-ALL' }, 'o');
  await m.clawback({ id: 'sub_p2' });
  assert.equal(c.stats.balanceCents, -1000);
  await assert.rejects(() => m.markPayout('SPARK', { amountCents: 1, method: 'paypal', reference: 'X' }, 'o'),
    (e) => e.status === 409);
});

test('C-DIS-001: viewer promo minted via the createPromo hook contract; disabled -> other; re-enable restores attribution only', async () => {
  const m = newCreators();
  withUsers(m);
  const minted = [];
  m.hooks.createPromo = async (p, by) => {
    // record the exact contract args, then register the promo so viewerPromo can see it
    minted.push({ ...p, by });
    const c = String(p.code).toUpperCase();
    m.promos.set(c, { code: c, percentOff: p.percentOff, active: true });
    return m.promos.get(c);
  };
  await m.create({ name: 'A', code: 'SPARK', viewerCode: { code: 'SPARK10', percentOff: 10 } }, 'owner');
  assert.equal(minted.length, 1);
  assert.equal(minted[0].code, 'SPARK10');
  assert.equal(minted[0].percentOff, 10);
  assert.equal(minted[0].note, 'creator:SPARK'); // billing's creator-code tag
  assert.equal(minted[0].maxUses, 10000);
  assert.equal(m.byCode('SPARK').viewerCode, 'SPARK10');
  // viewer code validation (unique codes: a failed mint leaves its code in the table)
  await assert.rejects(() => m.create({ name: 'B', code: 'MOON', viewerCode: { code: 'A', percentOff: 10 } }, 'o'), (e) => e.status === 400);
  await assert.rejects(() => m.create({ name: 'B', code: 'LUNA', viewerCode: { code: 'LUNA10', percentOff: 0 } }, 'o'), (e) => e.status === 400);
  await assert.rejects(() => m.create({ name: 'B', code: 'NOVA', viewerCode: { code: 'NOVA10', percentOff: 100 } }, 'o'), (e) => e.status === 400);
  // a promo hook that refuses the mint -> 400
  m.hooks.createPromo = async () => null;
  await assert.rejects(() => m.create({ name: 'B', code: 'ORBIT', viewerCode: { code: 'ORBIT10', percentOff: 10 } }, 'o'), (e) => e.status === 400);
  // the only creator with a live viewer promo is SPARK; the failed mints left none behind
  assert.equal(m.creators.filter((x) => x.viewerCode).length, 1);
  // disabled code resolves to 'other' in refValue's allowlist (activeCodes drops it)…
  await m.setStatus('SPARK', true, 'owner');
  assert.equal(refValue('SPARK', { creatorCodes: m.activeCodes() }), 'other');
  // …stats/ledger/balance are preserved…
  assert.equal(m.byCode('SPARK').stats.balanceCents >= 0, true);
  assert.equal(m.byCode('SPARK').status, 'disabled');
  assert.ok(m.byCode('SPARK').disabledAt);
  // …and the viewer promo is deactivated, reactivated on re-enable
  assert.equal(m.hooks.viewerPromo('SPARK10').active, false);
  await m.setStatus('SPARK', false, 'owner');
  assert.equal(m.hooks.viewerPromo('SPARK10').active, true);
  assert.equal(refValue('SPARK', { creatorCodes: m.activeCodes() }), 'SPARK');
});

test('C-LOOK-001: public lookup — aggregates only; unknown and disabled both { found: false }', async () => {
  const m = newCreators();
  withUsers(m);
  await m.create({ name: 'Alex', code: 'SPARK' }, 'owner');
  const c = m.byCode('SPARK');
  await m.postCommission(sub('sub_l1', 1000, { planName: 'Oak' }));
  const lk = m.lookup('spark'); // case-insensitive
  assert.equal(lk.found, true);
  assert.equal(lk.code, 'SPARK');
  assert.equal(lk.tier.id, 'bronze');
  assert.equal(lk.stats.payingReferrals, 1);
  assert.equal(lk.stats.balanceCents, 100); // public shape exposes balance/paidOut, not earned
  assert.equal(lk.payoutHint.includes('creators@treehost.online'), true);
  // aggregates only: no usernames, emails or ledger detail leak into the public shape
  const json = JSON.stringify(lk);
  assert.equal(json.includes('ender'), false);
  assert.equal(json.includes('@t.dev'), false);
  assert.equal(json.includes('sub_l1'), false);
  for (const k of ['username', 'email', 'subId']) assert.equal(json.includes(k), false);
  assert.equal(lk.recent.length, 1);
  assert.deepEqual(Object.keys(lk.recent[0]).sort(), ['amountCents', 'at', 'label']);
  // identical { found: false } for unknown AND disabled (GAP-1)
  const unknown = m.lookup('NOPE');
  await m.setStatus('SPARK', true, 'owner');
  const disabled = m.lookup('SPARK');
  assert.deepEqual(unknown, { found: false });
  assert.deepEqual(disabled, { found: false });
  assert.deepEqual(unknown, disabled);
});

test('C-RECON-001: reconcile repairs drifted stats from the ledger and warns', async () => {
  const m = newCreators();
  withUsers(m);
  await m.create({ name: 'A', code: 'SPARK' }, 'owner');
  await m.postCommission(sub('sub_w1', 10000));
  await m.markPayout('SPARK', { amountCents: 400, method: 'paypal', reference: 'R1' }, 'o');
  const c = m.byCode('SPARK');
  c.stats.balanceCents = 999999; // simulate drift (hand-edited store, crashed write)
  c.stats.earnedCents = 12345;
  c.stats.paidOutCents = 7;
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try { m.reconcile(); } finally { console.warn = origWarn; }
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].includes('C-RECON-001'), true);
  assert.equal(c.stats.earnedCents, 1000);
  assert.equal(c.stats.paidOutCents, 400);
  assert.equal(c.stats.balanceCents, 600);
  // a quiet reconcile repairs without warning
  c.stats.balanceCents = 1;
  m.reconcile(true);
  assert.equal(c.stats.balanceCents, 600);
  // init() path: persisted stats disagree with the ledger -> repaired on load
  const persisted = { creators: { [c.id]: c }, ledger: m.ledger, applications: {}, settings: {} };
  store.load = () => Promise.resolve(persisted);
  const m2 = newCreators();
  c.stats.balanceCents = 42;
  await m2.init();
  assert.equal(c.stats.balanceCents, 600);
  assert.equal(c.stats.payingReferrals, 1);
  store.load = () => Promise.resolve(undefined);
});

test('C-MET-001: refValue creator-code extension (case-insensitive, backward compatible)', () => {
  // allowlisted creator code -> the code itself, uppercase
  assert.equal(refValue('SPARK', { creatorCodes: ['SPARK'] }), 'SPARK');
  assert.equal(refValue('spark', { creatorCodes: ['SPARK'] }), 'SPARK');  // case-insensitive
  assert.equal(refValue(' Spark ', { creatorCodes: ['spark'] }), 'SPARK'); // trimmed
  // unknown code, even with the allowlist, stays 'other'
  assert.equal(refValue('nonsense', { creatorCodes: ['SPARK'] }), 'other');
  // second arg absent -> unchanged legacy behavior
  assert.equal(refValue('hackers'), 'other');
  assert.equal(refValue('DISCORD'), 'discord');
  assert.equal(refValue(''), null);
  assert.equal(refValue(undefined), null);
  // allowlist channels still win over the creator list
  assert.equal(refValue('discord', { creatorCodes: ['discord'] }), 'discord');
  // empty allowlist -> 'other' (backward compat, not the code)
  assert.equal(refValue('spark', { creatorCodes: [] }), 'other');
  assert.equal(refValue('spark', { creatorCodes: null }), 'other');
});
