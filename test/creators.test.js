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

test('C-LOOK-001: public lookup — no money fields; unknown and disabled both { found: false }', async () => {
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
  // privacy (T16): the public shape carries NO money — only the authenticated /api/creators/me does
  assert.equal(lk.stats.balanceCents, undefined);
  assert.equal(lk.stats.paidOutCents, undefined);
  assert.equal(lk.recent, undefined);
  assert.equal(lk.payoutHint, undefined);
  assert.equal(lk.viewerCode, null); // presence-only: the viewer code is public, its earnings are not
  // the full money-bearing shape lives behind the authenticated me()
  const mine = m.me('spark');
  assert.equal(mine.found, true);
  assert.equal(mine.code, 'SPARK');
  assert.equal(mine.stats.balanceCents, 100);
  assert.equal(mine.stats.paidOutCents, 0);
  assert.equal(mine.stats.signups, 0); // metricsMaps hook returns empty maps in the unit fixture
  assert.equal(mine.stats.nextTier, 'silver');
  assert.equal(mine.stats.nextTierAt, 5);
  assert.equal(mine.payoutHint.includes('promotion@treehost.online'), true);
  assert.equal(mine.recent.length, 1);
  assert.deepEqual(Object.keys(mine.recent[0]).sort(), ['amountCents', 'at', 'label']);
  // an account with no creatorCode (or a disabled/unknown code) gets the same { found: false }
  assert.deepEqual(m.me(null), { found: false });
  assert.deepEqual(m.me('NOPE'), { found: false });
  await m.setStatus('SPARK', true, 'owner');
  assert.deepEqual(m.me('SPARK'), { found: false });
  await m.setStatus('SPARK', false, 'owner');
  // aggregates only: no usernames, emails or ledger detail leak into the public shape
  const json = JSON.stringify(lk);
  assert.equal(json.includes('ender'), false);
  assert.equal(json.includes('@t.dev'), false);
  assert.equal(json.includes('sub_l1'), false);
  for (const k of ['username', 'email', 'subId', 'balanceCents', 'paidOutCents']) assert.equal(json.includes(k), false);
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

// ---------------------------------------------------------------------
// C-APP-001..004: application review state transitions (CREATORS-T19)
// ---------------------------------------------------------------------

/** An application in the registry, applied as if from the public form. Returns the RAW stored
 *  record (not the list row) so state transitions can be asserted directly. */
async function applied(m, { name = 'Alex', email = 'alex@example.com', handle = '@sparkbuilds', platform = 'YouTube', message = 'I make modpack videos' } = {}) {
  await m.apply({ name, email, handle, platform, message }, '1.2.3.4');
  return m.applications[m.applications.length - 1];
}

test('C-APP-001: apply gets an id; listApplications splits pending/reviewed newest-first', async () => {
  const m = newCreators();
  const a1 = await applied(m);
  assert.match(a1.id, /^app_[0-9a-f]{12}$/); // newId pattern, like cr_/le_ ids
  assert.equal(m.applicationsList().pending[0].suggestedCode, 'SPARKBUILDS'); // sanitized handle
  assert.equal(a1.reviewed, false);
  assert.equal(m.applicationsList().pending.length, 1);
  assert.equal(m.applicationsList().reviewed.length, 0);
  await m.review(a1.id, { accept: false, reason: 'later' }, 'owner');
  const l = m.applicationsList();
  assert.equal(l.pending.length, 0);
  assert.equal(l.reviewed.length, 1);
  assert.equal(l.reviewed[0].accepted, false);
  assert.equal(l.reviewed[0].reason, 'later');
  assert.equal(l.reviewed[0].by, 'owner');
  assert.equal(l.reviewed[0].suggestedCode, undefined); // reviewed rows carry the outcome, not the suggestion
  // newest decision first
  const a2 = await applied(m, { name: 'Bo', handle: 'boplays' });
  await m.review(a2.id, { accept: true }, 'owner');
  assert.equal(m.applicationsList().reviewed[0].name, 'Bo');
  // suggestion: junk handle falls back to the name, nothing usable at all -> CREATOR
  const m3 = newCreators();
  await m3.apply({ name: 'Casey', email: 'casey@example.com', handle: '!!!', platform: '', message: 'm' }, '5.5.5.5');
  assert.equal(m3.applicationsList().pending[0].suggestedCode, 'CASEY');
  const m4 = newCreators();
  await m4.apply({ name: '###', email: 'x@example.com', handle: '', platform: '', message: 'm' }, '5.5.5.6');
  assert.equal(m4.applicationsList().pending[0].suggestedCode, 'CREATOR');
});

test('C-APP-002: accept creates the creator from the application (suggested code, override, collision suffix)', async () => {
  const m = newCreators();
  const a = await applied(m);
  const r = await m.review(a.id, { accept: true }, 'owner');
  assert.equal(r.creator.code, 'SPARKBUILDS'); // suggested, not typed — sanitized handle is fine
  assert.equal(r.creator.name, 'Alex');
  assert.equal(r.creator.handle, '@sparkbuilds');
  assert.equal(r.creator.platform, 'YouTube');
  assert.equal(r.creator.createdBy, 'owner');
  assert.equal(m.byCode('SPARKBUILDS').id, r.creator.id);
  assert.equal(a.reviewed, true);
  assert.equal(a.accepted, true);
  assert.equal(a.creatorCode, 'SPARKBUILDS');
  assert.equal(a.decidedAt > 0, true);
  assert.equal(m.applicationsList().reviewed[0].creatorCode, 'SPARKBUILDS'); // the stored record, not the row copy
  // staff override wins over the suggestion; junk overrides are rejected, not repaired
  const b = await applied(m, { name: 'Bo', handle: 'boplays' });
  const rb = await m.review(b.id, { accept: true, code: 'bo-tv' }, 'owner');
  assert.equal(rb.creator.code, 'BO-TV');
  const c = await applied(m, { name: 'Cy', handle: 'cyplays' });
  await assert.rejects(() => m.review(c.id, { accept: true, code: 'has space!' }, 'owner'), (e) => e.status === 400);
  await assert.rejects(() => m.review(c.id, { accept: true, code: 'AB' }, 'owner'), (e) => e.status === 400);
  // reserved words are never taken as-is — the override gets suffixed out of the reserved word,
  // same as a colliding suggestion would
  const mr = newCreators();
  const d = await applied(mr, { name: 'Di', handle: 'discord' });
  const rd = await mr.review(d.id, { accept: true }, 'owner');
  assert.equal(rd.creator.code, 'DISCORD-2'); // suffixed out of the reserved word
  const rd2 = await mr.review((await applied(mr, { name: 'Ed', handle: 'ed plays' })).id, { accept: true, code: 'DISCORD' }, 'owner');
  assert.equal(rd2.creator.code, 'DISCORD-3'); // override collision: suffix keeps counting
  // collision with an existing creator: numeric suffix, keeping the stem
  await m.create({ name: 'Dup', code: 'BOPLAYS' }, 'owner'); // someone already owns the suggested code
  const e = await applied(m, { name: 'Ed', handle: 'boplays' });
  const re = await m.review(e.id, { accept: true }, 'owner');
  assert.equal(re.creator.code, 'BOPLAYS-2');
});

test('C-APP-003: accept with an account attach sets creatorCode/creatorId via hooks; unknown account 404s and leaves nothing behind', async () => {
  const m = newCreators();
  const users = new Map([['ender', { id: 'u1', username: 'ender', email: 'ender@example.com', creatorCode: null, creatorId: null }]]);
  m.hooks.findAccount = (login) => {
    const l = String(login || '').trim().toLowerCase();
    return [...users.values()].find((u) => u.username.toLowerCase() === l || u.email.toLowerCase() === l) || null;
  };
  m.hooks.saveAccount = async () => { saves++; };
  let saves = 0;
  const a = await applied(m);
  const r = await m.review(a.id, { accept: true, accountEmail: 'ENDER@EXAMPLE.COM' }, 'owner');
  assert.equal(r.account.username, 'ender');
  assert.equal(r.account.email, 'ender@example.com');
  assert.equal(users.get('ender').creatorCode, r.creator.code);
  assert.equal(users.get('ender').creatorId, r.creator.id);
  assert.equal(saves, 1);
  assert.equal(a.accountUsername, 'ender');
  // unknown account: 404, and the application stays unreviewed (nothing was created either)
  const b = await applied(m, { name: 'Bo', handle: 'boplays' });
  await assert.rejects(() => m.review(b.id, { accept: true, accountUsername: 'nobody' }, 'owner'), (e) => e.status === 404);
  assert.equal(b.reviewed, false);
  assert.equal(m.creators.find((c) => c.handle === 'boplays'), undefined);
  // deny records the reason and never creates a creator
  const c2 = await applied(m, { name: 'Cy', handle: 'cyplays' });
  const rd = await m.review(c2.id, { accept: false, reason: 'Not the right fit yet' }, 'chief');
  assert.equal(rd.creator, undefined);
  assert.equal(rd.account, undefined);
  assert.equal(c2.accepted, false);
  assert.equal(c2.reason, 'Not the right fit yet');
  assert.equal(m.creators.length, 1); // only the first accept exists
});

test('C-APP-004: guards — unknown id 404, double review 409, missing decision 400; markNotified records the outcome', async () => {
  const m = newCreators();
  await assert.rejects(() => m.review('app_nope', { accept: true }, 'owner'), (e) => e.status === 404);
  await assert.rejects(() => m.review('app_nope', { accept: false }, 'owner'), (e) => e.status === 404);
  const a = await applied(m);
  await assert.rejects(() => m.review(a.id, {}, 'owner'), (e) => e.status === 400);
  await assert.rejects(() => m.review(a.id, { reason: 'no decision' }, 'owner'), (e) => e.status === 400);
  await m.review(a.id, { accept: true }, 'owner');
  await assert.rejects(() => m.review(a.id, { accept: true }, 'owner'), (e) => e.status === 409);
  await assert.rejects(() => m.review(a.id, { accept: false }, 'owner'), (e) => e.status === 409);
  // markNotified is idempotent and only touches the notify flags
  await m.markNotified(a.id, { email: true, inbox: false });
  const row = m.applicationsList().reviewed[0];
  assert.equal(row.notifiedEmail, true);
  assert.equal(row.notifiedInbox, false);
  assert.equal(row.accepted, true);
  await assert.rejects(() => m.markNotified('app_nope', { email: true }), (e) => e.status === 404);
});

// C-APP-005: the contact email on applications (CREATORS-T23)
test('C-APP-005: apply requires a valid contact email; stored trimmed + lowercased; legacy rows list email null', async () => {
  const m = newCreators();
  const base = { name: 'Eve', platform: 'YouTube', message: 'hi' };
  const bad = async (email, ip) => assert.rejects(() => m.apply({ ...base, email }, ip), (e) => e.status === 400 && /email/i.test(e.message));
  await bad(undefined, '7.0.0.1');
  await bad('   ', '7.0.0.2');
  await bad('nope', '7.0.0.3');
  await bad('a@b', '7.0.0.4');
  await bad('a b@example.com', '7.0.0.5');
  await bad(`${'e'.repeat(250)}@example.com`, '7.0.0.6');
  assert.equal(m.applications.length, 0); // nothing stored on a reject
  await m.apply({ ...base, email: '  Eve.Mail@Example.COM ' }, '7.0.0.7');
  assert.equal(m.applications[0].email, 'eve.mail@example.com');
  assert.equal(m.applicationsList().pending[0].email, 'eve.mail@example.com');
  // A legacy application (stored before the field existed) still lists, with email null.
  m.applications.push({ id: 'app_legacy00000', at: 1, name: 'Old', handle: '', platform: '', message: 'm', reviewed: false });
  assert.equal(m.applicationsList().pending.find((a) => a.id === 'app_legacy00000').email, null);
  await m.review('app_legacy00000', { accept: false }, 'owner');
  assert.equal(m.applicationsList().reviewed[0].email, null);
});

test('C-APP-006: rate limiting still applies before email validation', async () => {
  const m = newCreators();
  for (let i = 0; i < 10; i++) await m.apply({ name: 'X', email: 'bad', message: 'hi' }, '8.8.8.8').catch(() => {});
  await assert.rejects(() => m.apply({ name: 'X', email: 'x@example.com', message: 'hi' }, '8.8.8.8'), (e) => e.status === 429);
});
