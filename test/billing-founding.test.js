'use strict';
// Unit tests for the Founding Lifetime billing (node --test, zero deps).
// Run: node --test test/billing-founding.test.js

process.env.BILLING_DEMO = '1'; // demo mode: checkout() activates instantly, no Stripe calls
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test'; // so billing.webhook() can verify the signed test events
delete process.env.TREEHOST_FOUNDING_CAP;

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const store = require('../src/store');
const { Billing } = require('../src/billing');

store.save = () => Promise.resolve();
store.load = () => Promise.resolve(undefined);

const user = (id, mcName) => ({ id, username: `u${id}`, email: `${id}@t.dev`, mcName: mcName || `mc${id}` });
const consent = { renewal: true, adult: true, withdrawal: true };

function newBilling() {
  const b = new Billing();
  b.hooks.userById = (id) => user(id);
  // A test site sells without memory limits (the real cap under test here is the founding one); tests that need
  // the lifetime cap set settings.lifetimePerNode explicitly.
  b.testSite = true;
  return b;
}

/** Adds a sub of `planId` left in `status` (the way a real purchase sits there). */
function addSub(b, planId, status, when = Date.now()) {
  const s = b.newSub(user('u1'), b.plan(planId));
  s.status = status;
  s.createdAt = when;
  if (status === 'active') b.activate(s);
  return s;
}

/** A signed Stripe event, the way billing.webhook() receives it. */
function stripeEvent(type, object) {
  const t = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ id: `evt_${crypto.randomBytes(4).toString('hex')}`, type, data: { object } });
  const sig = `t=${t},v1=${crypto.createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex')}`;
  return [body, sig];
}

const FOUNDING = 'founding-lifetime';

test('FND-PLN-001: the founding plan row is well-formed', () => {
  const p = new Billing().plan(FOUNDING);
  assert.equal(p.id, FOUNDING);
  assert.equal(p.name, 'Founding Lifetime');
  assert.equal(p.oneTime, true);
  assert.equal(p.priceCents, 19900);
  assert.deepEqual(p.slots, { servers: 4, proxies: 2 });
  assert.equal(p.prioritySupport, true);
  assert.equal(p.capTotal, 25);
  assert.equal(p.founding, true);
  assert.equal(p.active, true);
  assert.ok(p.description.endsWith('First 25 only.'));
});

test('FND-CAP-001: foundingSold counts active, past_due and pending (< 35 min), not canceled or stale pending', () => {
  const b = newBilling();
  addSub(b, FOUNDING, 'active');
  addSub(b, FOUNDING, 'past_due');
  addSub(b, FOUNDING, 'pending');
  assert.equal(b.foundingSold(), 3);
  addSub(b, FOUNDING, 'pending', Date.now() - 36 * 60 * 1000); // stale hold: Stripe expired it
  addSub(b, FOUNDING, 'canceled');
  assert.equal(b.foundingSold(), 3);
});

test('FND-CAP-002: a pending hold older than 35 min releases its unit', () => {
  const b = newBilling();
  addSub(b, FOUNDING, 'pending', Date.now() - 36 * 60 * 1000);
  assert.equal(b.foundingUnitsLeft(), 25);
  addSub(b, FOUNDING, 'pending'); // a fresh hold takes it again
  assert.equal(b.foundingUnitsLeft(), 24);
});

test('FND-CAP-003: the 25th founding checkout is OK, the 26th is 409 SOLD_OUT with the founding message', async () => {
  const b = newBilling();
  for (let i = 0; i < 25; i++) await b.checkout(user(`buyer${i}`), FOUNDING, 'http://t', consent);
  assert.equal(b.foundingSold(), 25);
  assert.equal(b.foundingUnitsLeft(), 0);
  assert.equal(b.publicPlans().plans.find((p) => p.founding).soldOut, true);
  await assert.rejects(() => b.checkout(user('late'), FOUNDING, 'http://t', consent), (e) => {
    assert.equal(e.status, 409);
    assert.equal(e.code, 'SOLD_OUT');
    assert.match(e.message, /Every Founding Lifetime spot is taken/);
    return true;
  });
  // the oversell never created a pending sub
  assert.equal(b.pendingFor('late').length, 0);
  assert.equal(b.foundingSold(), 25);
});

test('FND-CAP-004: TREEHOST_FOUNDING_CAP overrides the cap for tests; unset means 25', async () => {
  process.env.TREEHOST_FOUNDING_CAP = '2';
  try {
    const b = newBilling();
    assert.equal(b.foundingCap(), 2);
    await b.checkout(user('a'), FOUNDING, 'http://t', consent);
    await b.checkout(user('b'), FOUNDING, 'http://t', consent);
    assert.equal(b.foundingUnitsLeft(), 0);
    await assert.rejects(() => b.checkout(user('c'), FOUNDING, 'http://t', consent), (e) => e.status === 409 && e.code === 'SOLD_OUT');
  } finally {
    delete process.env.TREEHOST_FOUNDING_CAP;
  }
  assert.equal(newBilling().foundingCap(), 25);
});

test('FND-IND-001 (GAP-2, direction A): 25 founding sales never make lifetimeFull() true', () => {
  const b = newBilling();
  b.settings.lifetimePerNode = 2; // the default lifetime cap
  for (let i = 0; i < 25; i++) addSub(b, FOUNDING, 'active');
  assert.equal(b.lifetimeFull(), false);
  assert.equal(b.adminSummary().lifetimeCount, 0); // founding stays out of the lifetime numbers too
});

test('FND-IND-002 (GAP-2, direction B): lifetime purchases never consume founding units', () => {
  const b = newBilling();
  b.settings.lifetimePerNode = 2;
  addSub(b, 'lifetime', 'active');
  addSub(b, 'lifetime', 'active');
  addSub(b, 'lifetime', 'pending');
  assert.equal(b.lifetimeFull(), true); // 3 lifetime holds fill the lifetime cap
  assert.equal(b.foundingSold(), 0); // ...but founding still has all 25
  assert.equal(b.publicPlans().plans.find((p) => p.founding).unitsLeft, 25);
});

test('FND-IND-003: both caps full -> each plan gets its own 409 message, never a cross-fire', async () => {
  const b = newBilling();
  b.settings.lifetimePerNode = 2;
  addSub(b, 'lifetime', 'active');
  addSub(b, 'lifetime', 'active');
  process.env.TREEHOST_FOUNDING_CAP = '1';
  try {
    addSub(b, FOUNDING, 'active');
    await assert.rejects(() => b.checkout(user('lf'), 'lifetime', 'http://t', consent), (e) => {
      assert.equal(e.status, 409);
      assert.equal(e.code, 'SOLD_OUT');
      assert.match(e.message, /Lifetime spot on this machine/); // the lifetime message
      return true;
    });
    await assert.rejects(() => b.checkout(user('fd'), FOUNDING, 'http://t', consent), (e) => {
      assert.equal(e.status, 409);
      assert.equal(e.code, 'SOLD_OUT');
      assert.match(e.message, /Founding Lifetime spot/); // the founding message
      return true;
    });
  } finally {
    delete process.env.TREEHOST_FOUNDING_CAP;
  }
});

test('FND-PLN-002: publicPlans founding row exposes founding/unitsLeft/capTotal and its own soldOut', () => {
  const b = newBilling();
  const f = b.publicPlans().plans.find((p) => p.founding);
  assert.equal(f.id, FOUNDING);
  assert.equal(f.founding, true);
  assert.equal(f.unitsLeft, 25);
  assert.equal(f.capTotal, 25);
  assert.equal(f.soldOut, false);
  assert.deepEqual(f.slots, { servers: 4, proxies: 2 });
  // non-founding rows keep the memory/lifetimeFull soldOut and no founding fields
  const life = b.publicPlans().plans.find((p) => p.id === 'lifetime');
  assert.equal(life.founding, undefined);
  assert.equal(life.unitsLeft, undefined);
  // a pending hold consumes a unit on the founding row only
  addSub(b, FOUNDING, 'pending');
  assert.equal(b.publicPlans().plans.find((p) => p.founding).unitsLeft, 24);
  assert.equal(b.publicPlans().plans.find((p) => p.founding).soldOut, false);
});

test('FND-PLN-002b: soldOut on the founding row comes from unitsLeft, not lifetimeFull()', () => {
  const b = newBilling();
  b.settings.lifetimePerNode = 0; // lifetime cap "no limit" -> lifetimeFull() false
  process.env.TREEHOST_FOUNDING_CAP = '1';
  try {
    addSub(b, FOUNDING, 'active');
    const f = b.publicPlans().plans.find((p) => p.founding);
    assert.equal(f.unitsLeft, 0);
    assert.equal(f.soldOut, true);
  } finally {
    delete process.env.TREEHOST_FOUNDING_CAP;
  }
});

test('FND-CHK-003: the cap check runs before newSub() and the pending sub is created before activation', async () => {
  const b = newBilling();
  // at cap: checkout throws before any sub is pushed
  process.env.TREEHOST_FOUNDING_CAP = '1';
  try {
    addSub(b, FOUNDING, 'active');
    const before = b.subs.length;
    await assert.rejects(() => b.checkout(user('x'), FOUNDING, 'http://t', consent), (e) => e.status === 409);
    assert.equal(b.subs.length, before);
  } finally {
    delete process.env.TREEHOST_FOUNDING_CAP;
  }
  // not at cap: a pending sub exists after checkout (unit reserved during the Stripe window)
  const b2 = newBilling();
  const s = await b2.checkout(user('y'), FOUNDING, 'http://t', consent);
  assert.equal(s.demo, true); // demo mode activated it right away
  assert.equal(b2.foundingSold(), 1);
});

test('FND-CRD-001: founding activation records a credit (idempotent by subId) and saves the plans', async () => {
  const b = newBilling();
  let saves = 0;
  b.savePlans = () => { saves++; return Promise.resolve(); };
  const s = addSub(b, FOUNDING, 'active');
  const credits = b.settings.foundingCredits;
  assert.equal(credits.length, 1);
  assert.deepEqual({ userId: credits[0].userId, amountCents: credits[0].amountCents, planId: credits[0].planId, subId: credits[0].subId }, { userId: 'u1', amountCents: 19900, planId: FOUNDING, subId: s.id });
  assert.ok(credits[0].at > 0);
  assert.ok(saves >= 1);
  b.activate(s); // webhook retry / browser confirm re-run: no second credit
  assert.equal(b.settings.foundingCredits.length, 1);
  // a lifetime activation records nothing
  const life = addSub(b, 'lifetime', 'active');
  assert.equal(b.settings.foundingCredits.length, 1);
  assert.equal(life.status, 'active');
});

test('FND-CRD-002: the credit merges into founders() -> founder tier; founderListText shape has mcName|founder', () => {
  const b = newBilling();
  addSub(b, FOUNDING, 'active');
  const founders = b.founders((id) => user(id));
  assert.equal(founders.length, 1);
  assert.equal(founders[0].totalCents, 19900);
  assert.equal(founders[0].tier.id, 'founder');
  assert.equal(founders[0].tier.label, 'Founder');
  // the founders.txt machinery in server.js maps exactly this shape to "mcName|tierId" lines
  const line = founders.filter((f) => /^[A-Za-z0-9_]{3,16}$/.test(f.mcName)).map((f) => `${f.mcName}|${f.tier.id}`).sort().join('\n');
  assert.equal(line, 'mcu1|founder');
});

test('FND-CRD-003: a buyer whose account has no mcName still gets the founder tier', () => {
  const b = newBilling();
  const s = addSub(b, FOUNDING, 'active');
  const founders = b.founders((id) => ({ id, username: 'noMC', mcName: '' }));
  assert.equal(founders.length, 1);
  assert.equal(founders[0].tier.id, 'founder');
  assert.equal(founders[0].mcName, '');
  assert.ok(s.userId);
});

test('FND-CNT-001: the credit and the sold count survive the webhook-then-confirm double activation', async () => {
  const b = newBilling();
  const s = await b.checkout(user('dw'), FOUNDING, 'http://t', consent); // demo: activate ran once
  b.activate(s); // the webhook path fires again
  b.activate(s);
  assert.equal(b.settings.foundingCredits.length, 1);
  assert.equal(b.foundingSold(), 1);
});

test('FND-CRD-004: charge.refunded removes the credit, drops the tier and frees the unit', async () => {
  const b = newBilling();
  const s = addSub(b, FOUNDING, 'active');
  s.paymentIntent = 'pi_refund_me';
  assert.equal(b.founders((id) => user(id))[0].tier.id, 'founder');
  const [body, sig] = stripeEvent('charge.refunded', { payment_intent: 'pi_refund_me', refunded: true });
  await b.webhook(body, sig, { userById: (id) => user(id) });
  assert.equal(s.status, 'canceled');
  assert.equal(b.settings.foundingCredits.length, 0);
  assert.equal(b.founders((id) => user(id)).length, 0); // no founder tier anymore
  assert.equal(b.foundingSold(), 0);
  assert.equal(b.foundingUnitsLeft(), 25);
  assert.equal(b.publicPlans().plans.find((p) => p.founding).soldOut, false);
});
