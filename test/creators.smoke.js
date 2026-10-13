'use strict';
// Smoke test for src/creators.js — invokes the Creators class directly against a quiet store.
// NOT part of the test suite yet: T9 (Group F) builds the real test/creators.test.js.
// Run: node test/creators.smoke.js  (prints PASS lines, exits non-zero on any failure)

const assert = require('node:assert/strict');
const store = require('../src/store');
const { Creators, tierFor, TIER_LADDER } = require('../src/creators');

store.save = () => Promise.resolve();
store.load = () => Promise.resolve(undefined);

const steps = [];
const step = (name, fn) => steps.push([name, fn]);

const newCreators = () => {
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
  return m;
};

step('C-CODE-001 normalization + validation', async () => {
  const m = newCreators();
  await m.create({ name: 'A', code: ' spark ' }, 'owner');
  assert.equal(m.byCode('SPARK').code, 'SPARK');
  await assert.rejects(() => m.create({ name: 'B', code: 'AB' }, 'owner'), (e) => e.status === 400);
  await assert.rejects(() => m.create({ name: 'B', code: 'has space!' }, 'owner'), (e) => e.status === 400);
});

step('C-CODE-002/003 reserved words + collisions', async () => {
  const m = newCreators();
  for (const w of ['discord', 'youtube', 'reddit', 'serverlist']) {
    await assert.rejects(() => m.create({ name: 'X', code: w }, 'owner'), (e) => e.status === 409, w);
  }
  await m.create({ name: 'A', code: 'SPARK' }, 'owner');
  await assert.rejects(() => m.create({ name: 'B', code: 'spark' }, 'owner'), (e) => e.status === 409);
  m.hooks.promoExists = () => true; // any code collides with an existing promo
  await assert.rejects(() => m.create({ name: 'B', code: 'TREE10' }, 'owner'), (e) => e.status === 409);
});

step('C-TIER-001 ladder math', () => {
  assert.deepEqual(TIER_LADDER.map((t) => t.percent), [10, 15, 20]);
  assert.equal(tierFor(0).percent, 10);
  assert.equal(tierFor(4).percent, 10);
  assert.equal(tierFor(5).percent, 15);
  assert.equal(tierFor(24).percent, 15);
  assert.equal(tierFor(25).percent, 20);
  assert.equal(tierFor(500).id, 'gold');
});

step('C-COM-001..004 commission math, idempotency, first-payment, discounted base', async () => {
  const m = newCreators();
  const users = new Map();
  m.hooks.userById = (id) => users.get(id) || null;
  await m.create({ name: 'A', code: 'SPARK' }, 'owner');
  const c = m.byCode('SPARK');
  const sub = (price, discount = 0) => ({ id: `sub_${Math.random().toString(16).slice(2, 8)}`, userId: 'u1', priceCents: price, discountCents: discount, planName: 'Sapling' });
  // bronze on $10 -> $1.00
  users.set('u1', { id: 'u1', username: 'ender', creatorCode: 'SPARK' });
  await m.postCommission(sub(1000));
  assert.equal(c.stats.earnedCents, 100);
  assert.equal(c.stats.payingReferrals, 1);
  assert.equal(m.commissionEntry(m.ledger[0].subId).tierAtPost, 'bronze');
  // idempotency (GAP-3): same subId twice -> one entry only
  const before = m.ledger.length;
  await m.postCommission({ ...sub(1000), id: m.ledger[0].subId });
  assert.equal(m.ledger.length, before);
  assert.equal(c.stats.earnedCents, 100);
  // 5th referral posts at bronze (10%) and THEN promotes: tier = tierFor(paying at post time)
  for (let i = 0; i < 3; i++) await m.postCommission(sub(1000));
  await m.postCommission(sub(1500));
  assert.equal(c.stats.payingReferrals, 5);
  assert.equal(m.ledger.at(-1).amountCents, 150);
  assert.equal(m.ledger.at(-1).tierAtPost, 'bronze');
  assert.equal(c.bestTier, 'silver'); // promoted by the 5th, but it posted at 10%
  // 6th posts at silver (15%): $15 -> $2.25
  await m.postCommission(sub(1500));
  assert.equal(m.ledger.at(-1).amountCents, 225);
  assert.equal(m.ledger.at(-1).tierAtPost, 'silver');
  // discounted base: $199 with $100 off at silver (15%) -> 9900 * .15 = 1485
  await m.postCommission(sub(19900, 10000));
  assert.equal(m.ledger.at(-1).amountCents, 1485);
  // no creatorCode -> nothing posted
  users.set('u2', { id: 'u2', username: 'plain' });
  const r = await m.postCommission({ id: 'sub_x2', userId: 'u2', priceCents: 1000 });
  assert.equal(r, null);
});

step('C-CLAW-001/002 clawback: exact reversal, negative balance, no-op without commission', async () => {
  const m = newCreators();
  const users = new Map();
  m.hooks.userById = (id) => users.get(id) || null;
  await m.create({ name: 'A', code: 'SPARK' }, 'owner');
  const c = m.byCode('SPARK');
  users.set('u1', { id: 'u1', creatorCode: 'SPARK' });
  await m.postCommission({ id: 'sub_r1', userId: 'u1', priceCents: 19900, planName: 'Founding' }); // 1990 @ bronze
  assert.equal(c.stats.balanceCents, 1990);
  // payout everything, then refund -> balance goes negative
  await m.markPayout('SPARK', { amountCents: 1990, method: 'paypal', reference: 'PAYID-1' }, 'owner');
  assert.equal(c.stats.balanceCents, 0);
  const undo = await m.clawback({ id: 'sub_r1' });
  assert.equal(undo.amountCents, -1990);
  assert.equal(c.stats.balanceCents, -1990);
  assert.equal(c.stats.payingReferrals, 1); // never decremented
  assert.equal(c.stats.earnedCents, 0);
  // second clawback for the same sub = no-op
  assert.equal(await m.clawback({ id: 'sub_r1' }), null);
  // a sub that never posted a commission -> no-op, no entry
  const n = m.ledger.length;
  assert.equal(await m.clawback({ id: 'sub_never' }), null);
  assert.equal(m.ledger.length, n);
});

step('C-PAY-001/002 payout guards', async () => {
  const m = newCreators();
  const users = new Map();
  m.hooks.userById = (id) => users.get(id) || null;
  await m.create({ name: 'A', code: 'SPARK' }, 'owner');
  const c = m.byCode('SPARK');
  users.set('u1', { id: 'u1', creatorCode: 'SPARK' });
  await m.postCommission({ id: 'sub_p1', userId: 'u1', priceCents: 10000 }); // 1000
  await assert.rejects(() => m.markPayout('SPARK', { amountCents: 1001, method: 'paypal', reference: 'X' }, 'owner'), (e) => e.status === 409);
  await assert.rejects(() => m.markPayout('SPARK', { amountCents: -5, method: 'paypal', reference: 'X' }, 'owner'), (e) => e.status === 400);
  await assert.rejects(() => m.markPayout('SPARK', { amountCents: 100, method: 'bitcoin', reference: 'X' }, 'owner'), (e) => e.status === 400);
  await assert.rejects(() => m.markPayout('SPARK', { amountCents: 100, method: 'paypal', reference: '' }, 'owner'), (e) => e.status === 400);
  await m.markPayout('SPARK', { amountCents: 400, method: 'iban', reference: 'IBAN-4', note: 'part one' }, 'owner');
  assert.equal(c.stats.balanceCents, 600);
  assert.equal(c.stats.paidOutCents, 400);
  assert.equal(m.ledger.at(-1).amountCents, -400);
  assert.equal(m.ledger.at(-1).by, 'owner');
});

step('C-TIER-002 promote-only + C-DIS-001 disabled + C-LOOK-001 lookup shape', async () => {
  const m = newCreators();
  const users = new Map();
  m.hooks.userById = (id) => users.get(id) || null;
  await m.create({ name: 'A', code: 'SPARK', viewerCode: { code: 'SPARK10', percentOff: 10 } }, 'owner');
  const c = m.byCode('SPARK');
  users.set('u1', { id: 'u1', creatorCode: 'SPARK' });
  for (let i = 0; i < 25; i++) await m.postCommission({ id: `sub_g${i}`, userId: 'u1', priceCents: 1000 });
  assert.equal(c.bestTier, 'gold');
  assert.equal(c.stats.balanceCents, 3500); // 5@10% (500) + 19@15% (2850) + 1@20% (200) - clawback (150)
  // refund one gold commission -> tier sticks
  await m.clawback({ id: 'sub_g24' });
  assert.equal(c.bestTier, 'gold');
  assert.equal(m.byCode('SPARK').stats.payingReferrals, 25);
  // next commission posts at gold (20%)
  await m.postCommission({ id: 'sub_g25', userId: 'u1', priceCents: 1000 });
  assert.equal(m.ledger.at(-1).amountCents, 200);
  // lookup: aggregates only
  const lk = m.lookup('spark'); // case-insensitive
  assert.equal(lk.found, true);
  assert.equal(lk.code, 'SPARK');
  assert.equal(lk.tier.id, 'gold');
  assert.ok(!('recent' in lk) || lk.recent.every((r) => !r.username));
  assert.ok(!JSON.stringify(lk).includes('u1'));
  // disabled: identical { found:false } for disabled and unknown
  await m.setStatus('SPARK', true, 'owner');
  assert.deepEqual(m.lookup('SPARK'), { found: false });
  assert.deepEqual(m.lookup('NOPE'), { found: false });
  assert.equal(m.activeCodes().length, 0);
  // viewer promo deactivated on disable, reactivated on re-enable
  assert.equal(m.hooks.viewerPromo('SPARK10').active, false);
  await m.setStatus('SPARK', false, 'owner');
  assert.equal(m.hooks.viewerPromo('SPARK10').active, true);
  assert.equal(m.activeCodes()[0], 'SPARK');
});

step('C-RECON-001 reconciliation repairs stats from the ledger with a warning', async () => {
  const m = newCreators();
  const users = new Map();
  m.hooks.userById = (id) => users.get(id) || null;
  await m.create({ name: 'A', code: 'SPARK' }, 'owner');
  users.set('u1', { id: 'u1', creatorCode: 'SPARK' });
  await m.postCommission({ id: 'sub_w1', userId: 'u1', priceCents: 10000 });
  const c = m.byCode('SPARK');
  c.stats.balanceCents = 999999; // simulate drift (e.g. hand-edited or crashed write)
  const saved = m.creators;
  const m2 = newCreators();
  m2.creators = saved; m2.ledger = m.ledger;
  m2.normalize(c);
  m2.reconcile();
  assert.equal(c.stats.balanceCents, 1000);
  assert.equal(c.stats.earnedCents, 1000);
  assert.equal(c.stats.paidOutCents, 0);
});

step('C-EDIT: code immutability + viewer promo edits', async () => {
  const m = newCreators();
  await m.create({ name: 'A', code: 'SPARK', viewerCode: { code: 'SPARK10', percentOff: 10 } }, 'owner');
  const row = await m.edit('SPARK', { name: 'Alex', handle: '@sp', platform: 'YouTube', note: 'hey', viewerCode: { percentOff: 20 } }, 'owner');
  assert.equal(row.name, 'Alex');
  assert.equal(row.viewerCode.percentOff, 20);
  assert.equal(row.code, 'SPARK'); // no code field in the patch, no change
  await m.edit('SPARK', { viewerCode: { active: false } }, 'owner');
  assert.equal(m.hooks.viewerPromo('SPARK10').active, false);
  await assert.rejects(() => m.edit('NOPE', { name: 'x' }, 'owner'), (e) => e.status === 404);
});

step('C-APPLY + rate limits', async () => {
  const m = newCreators();
  const notices = [];
  m.hooks.notice = (n) => notices.push(n);
  let emailed = 0;
  m.hooks.email = async () => { emailed++; };
  const r = await m.apply({ name: 'Alex', handle: '@sp', platform: 'YouTube', message: 'I make SMP series' }, '1.2.3.4');
  assert.deepEqual(r, { ok: true });
  assert.equal(m.applications.length, 1);
  assert.equal(m.creators.length, 0); // never creates a creator record
  assert.equal(notices.length, 1);
  assert.equal(notices[0].section, 'people');
  assert.equal(emailed, 1);
  await assert.rejects(() => m.apply({ name: 'B' }, '1.2.3.4'), (e) => e.status === 400); // no message
  // rate limit: APPLY_MAX per window
  for (let i = 0; i < 10; i++) await m.apply({ name: 'X', message: 'hi' }, '5.6.7.8');
  await assert.rejects(() => m.apply({ name: 'X', message: 'hi' }, '5.6.7.8'), (e) => e.status === 429);
  // long message capped at 500
  await m.apply({ name: 'C', message: 'x'.repeat(2000) }, '9.9.9.9');
  assert.ok(m.applications.at(-1).message.length <= 500);
  m.checkLookupRate('1.1.1.1'); // does not throw under the limit
  for (let i = 0; i < 10; i++) m.checkLookupRate('2.2.2.2');
  assert.throws(() => m.checkLookupRate('2.2.2.2'), (e) => e.status === 429);
});

step('C-ADMIN adminList rows + totals + tiers', async () => {
  const m = newCreators();
  await m.create({ name: 'A', code: 'SPARK' }, 'owner');
  await m.create({ name: 'B', code: 'MOON' }, 'owner');
  const list = m.adminList();
  assert.equal(list.creators.length, 2);
  assert.equal(list.totals.creators, 2);
  assert.deepEqual(list.tiers, TIER_LADDER);
  assert.equal(list.creators[0].tier.id, 'bronze');
  assert.equal(list.creators[0].stats.nextTier, 'silver');
  assert.equal(list.creators[0].stats.nextTierAt, 5);
});

step('ledgerFor pagination (newest-first, cursor)', async () => {
  const m = newCreators();
  const users = new Map();
  m.hooks.userById = (id) => users.get(id) || null;
  await m.create({ name: 'A', code: 'SPARK' }, 'owner');
  users.set('u1', { id: 'u1', creatorCode: 'SPARK' });
  for (let i = 0; i < 7; i++) await m.postCommission({ id: `sub_l${i}`, userId: 'u1', priceCents: 1000 });
  const p1 = m.ledgerFor('SPARK', { limit: 3 });
  assert.equal(p1.entries.length, 3);
  assert.equal(p1.hasMore, true);
  assert.ok(p1.entries[0].at >= p1.entries[1].at);
  const p2 = m.ledgerFor('SPARK', { before: p1.cursor, limit: 3 });
  assert.equal(p2.entries.length, 3);
  assert.ok(p2.entries.every((e) => e.at <= p1.entries[2].at));
  assert.equal(m.ledgerFor('NOPE'), null);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of steps) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (e) {
      failed++;
      console.error(`FAIL  ${name}`);
      console.error(e && e.stack ? e.stack : e);
    }
  }
  if (failed) {
    console.error(`\n${failed} smoke step(s) failed`);
    process.exit(1);
  }
  console.log('\nAll creator smoke steps passed.');
})();
