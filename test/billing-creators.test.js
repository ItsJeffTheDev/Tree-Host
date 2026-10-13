'use strict';
// Unit tests for the creator-program billing wiring (node --test, zero deps).
// Run: node --test test/billing-creators.test.js
//
// Covers the discount checkout path (percent-off viewer codes), the commission hook choke points
// and the percentOff promo plumbing. Uses Stripe test mode with fetch stubbed, like
// test/billing-counts.test.js.

process.env.STRIPE_SECRET_KEY = 'sk_test_stub';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
delete process.env.BILLING_DEMO;
delete process.env.TREEHOST_FOUNDING_CAP;

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const store = require('../src/store');
const { Billing } = require('../src/billing');

store.save = () => Promise.resolve();
store.load = () => Promise.resolve(undefined);

const user = (id) => ({ id, username: `u${id}`, email: `${id}@t.dev`, mcName: `mc${id}` });
const consent = { renewal: true, adult: true, withdrawal: true };

function newBilling() {
  const b = new Billing();
  b.hooks.userById = (id) => user(id);
  b.testSite = true;
  b.metrics = [];
  b.hooks.metric = (type, extra) => b.metrics.push({ type, extra });
  return b;
}

/** Overrides the env-derived mode getter for one instance. */
function forceMode(b, mode) {
  Object.defineProperty(b, 'mode', { get: () => mode });
  return b;
}

/** Stub global fetch, recording the Stripe call bodies so the test can read the session params. */
function stubFetch(responses = {}) {
  const bodies = [];
  global.fetch = async (url, opts) => {
    const path = String(url).replace('https://api.stripe.com/v1', '').split('?')[0];
    if (opts && opts.body) bodies.push({ path, body: Object.fromEntries(new URLSearchParams(opts.body)) });
    const r = responses[path];
    const json = typeof r === 'function' ? r() : r || {};
    return { ok: true, json: async () => json };
  };
  return bodies;
}

test.afterEach(() => { delete global.fetch; });

const OAK = 'oak';
const unitAmount = (bodies) => Number(bodies[0].body['line_items[0][price_data][unit_amount]']);
const allowPromos = (bodies) => bodies[0].body['allow_promotion_codes'];

/** A percent-off viewer promo the way createPromo(percentOff) makes it. */
async function discountPromo(b, { code, percentOff = 20, active = true, uses = [], maxUses = 10000, expiresAt = null } = {}) {
  const p = {
    code: code || 'SPARK',
    planId: null,
    percentOff,
    days: 0,
    maxUses,
    forUserId: null,
    note: 'creator:SPARK',
    expiresAt,
    active,
    uses,
    createdBy: 'staff',
    createdAt: Date.now(),
  };
  b.promos.push(p);
  return p;
}

test('CRE-CHK-001: a percent-off viewer code discounts the Stripe session and keeps the list price on the sub', async () => {
  const b = forceMode(newBilling(), 'test');
  await discountPromo(b, { code: 'SPARK', percentOff: 20 });
  const bodies = stubFetch({ '/checkout/sessions': { id: 'cs_1', url: 'https://stripe.test/cs_1' } });
  const { url } = await b.checkout(user('u1'), OAK, 'http://t', consent, 'spark'); // case-insensitive like promo()
  assert.equal(url, 'https://stripe.test/cs_1');
  const s = b.subs[0];
  // Oak is $9.00; 20% off → the session charges $7.20.
  assert.equal(unitAmount(bodies), 720);
  // GAP-2: the discount is priced into the line item, so Stripe-side promo entry is closed for the session.
  assert.equal(allowPromos(bodies), undefined);
  // The sub keeps the list price for refunds/MRR; the discount is recorded separately.
  assert.equal(s.priceCents, 900);
  assert.equal(s.promoCode, 'SPARK');
  assert.equal(s.percentOff, 20);
  assert.equal(s.discountCents, 180);
});

test('CRE-CHK-002: the discount also applies to one-time (payment mode) sessions', async () => {
  const b = forceMode(newBilling(), 'test');
  await discountPromo(b, { code: 'SPARK', percentOff: 50 });
  const bodies = stubFetch({ '/checkout/sessions': { id: 'cs_2', url: 'https://stripe.test/cs_2' } });
  await b.checkout(user('u1'), 'lifetime', 'http://t', consent, 'SPARK');
  assert.equal(unitAmount(bodies), 37500); // $750 Lifetime at 50% off
  assert.equal(allowPromos(bodies), undefined);
  const s = b.subs[0];
  assert.equal(s.priceCents, 75000);
  assert.equal(s.discountCents, 37500);
});

test('CRE-CHK-003: no viewer code → list price, Stripe-side promo entry stays open', async () => {
  const b = forceMode(newBilling(), 'test');
  const bodies = stubFetch({ '/checkout/sessions': { id: 'cs_3', url: 'https://stripe.test/cs_3' } });
  await b.checkout(user('u1'), OAK, 'http://t', consent);
  assert.equal(unitAmount(bodies), 900);
  assert.equal(allowPromos(bodies), 'true');
  const s = b.subs[0];
  assert.equal(s.promoCode, undefined);
  assert.equal(s.percentOff, undefined);
  assert.equal(s.discountCents, undefined);
});

test('CRE-CHK-004: unknown, disabled, expired and maxed-out codes all 400 with the same message', async () => {
  const b = forceMode(newBilling(), 'test');
  stubFetch();
  await discountPromo(b, { code: 'GONE', active: false });
  await discountPromo(b, { code: 'OLD', expiresAt: Date.now() - 1000 });
  await discountPromo(b, { code: 'FULL', uses: [{ userId: 'x', subId: 's1', at: Date.now() }], maxUses: 1 });
  const bad = "That code doesn't work any more.";
  await assert.rejects(() => b.checkout(user('u1'), OAK, 'http://t', consent, 'NOPE'), (e) => e.status === 400 && e.message === bad);
  await assert.rejects(() => b.checkout(user('u1'), OAK, 'http://t', consent, 'GONE'), (e) => e.status === 400 && e.message === bad);
  await assert.rejects(() => b.checkout(user('u1'), OAK, 'http://t', consent, 'OLD'), (e) => e.status === 400 && e.message === bad);
  await assert.rejects(() => b.checkout(user('u1'), OAK, 'http://t', consent, 'FULL'), (e) => e.status === 400 && e.message === bad);
  // A free-plan code (planId set) gets the redeem hint instead.
  await b.createPromo({ code: 'FREETREE', planId: OAK, days: 30 }, 'staff');
  await assert.rejects(
    () => b.checkout(user('u1'), OAK, 'http://t', consent, 'FREETREE'),
    (e) => e.status === 400 && /redeem it in Billing/.test(e.message),
  );
  // A bad code never starts a checkout: no sub was created by the failing calls (asserted below).
  assert.equal(b.subs.length, 0);
});

test('CRE-CHK-005: a bad code creates no pending sub (no capacity held by a rejected checkout)', async () => {
  const b = forceMode(newBilling(), 'test');
  stubFetch();
  await assert.rejects(() => b.checkout(user('u1'), OAK, 'http://t', consent, 'NOPE'), () => true);
  assert.equal(b.subs.length, 0);
});

test('CRE-HOOK-006: commission fires once on pending→active and swallows hook errors', async () => {
  const b = forceMode(newBilling(), 'demo');
  let calls = 0;
  b.hooks.commission = () => { calls += 1; throw new Error('creators module blew up'); };
  await b.checkout(user('u1'), OAK, 'http://t', consent);
  assert.equal(calls, 1); // one call even though it threw; billing itself didn't fail
  assert.equal(b.subs[0].status, 'active');
  assert.equal(count(b, 'checkoutCompleted'), 1);
});

test('CRE-HOOK-007: past_due→active recovery does not commission; a pending sub commissions once', async () => {
  const b = forceMode(newBilling(), 'demo');
  let calls = 0;
  b.hooks.commission = () => { calls += 1; };
  const s = b.newSub(user('u1'), b.plan(OAK));
  s.status = 'past_due';
  b.activate(s);
  assert.equal(calls, 0);
  b.activate(s); // already active — retries of any kind stay silent
  assert.equal(calls, 0);
  const p = b.newSub(user('u2'), b.plan(OAK)); // a fresh pending sub: the one first-payment moment
  b.activate(p);
  b.activate(p, { periodEnd: Date.now() + 86400000 });
  assert.equal(calls, 1);
});

test('CRE-HOOK-008: charge.refunded calls commissionRefund for the refunded sub', async () => {
  const b = forceMode(newBilling(), 'test');
  const refunded = [];
  b.hooks.commissionRefund = (s) => refunded.push(s.id);
  stubFetch({ '/checkout/sessions': { id: 'cs_9', url: 'https://stripe.test/cs_9' } });
  await b.checkout(user('u1'), 'lifetime', 'http://t', consent);
  const s = b.subs[0];
  const [body, sig] = stripeEvent('checkout.session.completed', {
    object: 'checkout.session', mode: 'payment', payment_status: 'paid', status: 'complete',
    client_reference_id: s.id, customer: 'cus_test', payment_intent: 'pi_test',
  });
  await b.webhook(body, sig, users);
  const [rbody, rsig] = stripeEvent('charge.refunded', { payment_intent: 'pi_test', refunded: true });
  await b.webhook(rbody, rsig, users);
  assert.deepEqual(refunded, [s.id]);
  assert.equal(s.status, 'canceled');
});

function count(b, type) {
  return b.metrics.filter((m) => m.type === type).length;
}

function stripeEvent(type, object) {
  const t = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ id: `evt_${crypto.randomBytes(4).toString('hex')}`, type, data: { object } });
  const sig = `t=${t},v1=${crypto.createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex')}`;
  return [body, sig];
}

const users = { userById: (id) => user(id), save: () => Promise.resolve() };

test('CRE-PRM-009: percentOff promos reject planId, default their note and maxUses, and round-trip', async () => {
  const b = newBilling();
  const p = await b.createPromo({ code: 'SPARK', percentOff: 20 }, 'staff');
  assert.equal(p.percentOff, 20);
  assert.equal(p.planId, null);
  assert.equal(p.note, 'creator:SPARK');
  assert.equal(p.maxUses, 10000); // discount codes default to a big pool, not 1
  assert.equal(p.days, 0);
  assert.equal(b.promo('SPARK').percentOff, 20);
  // A plain free-plan promo exposes percentOff: null.
  const free = await b.createPromo({ code: 'FREETREE', planId: OAK, days: 30 }, 'staff');
  assert.equal(free.percentOff, null);
  assert.equal(free.planId, OAK);
  // Validation.
  await assert.rejects(() => b.createPromo({ code: 'BADPCT', percentOff: 0 }, 'staff'), (e) => e.status === 400);
  await assert.rejects(() => b.createPromo({ code: 'BADPCT', percentOff: 100 }, 'staff'), (e) => e.status === 400);
  await assert.rejects(() => b.createPromo({ code: 'WITHPLAN', percentOff: 20, planId: OAK }, 'staff'), (e) => e.status === 400);
});

test('CRE-PRM-010: redeem() rejects percent-off codes with the checkout hint; publicSub carries the discount', async () => {
  const b = forceMode(newBilling(), 'demo');
  await b.createPromo({ code: 'SPARK', percentOff: 25 }, 'staff');
  await assert.rejects(
    () => b.redeem(user('u1'), 'SPARK'),
    (e) => e.status === 400 && /enter it at checkout/.test(e.message) && !/doesn't work/.test(e.message),
  );
  // publicPromo exposes percentOff; publicSub exposes percentOff + discountCents on a discounted sub.
  assert.equal(b.publicPromo(b.promo('SPARK')).percentOff, 25);
  stubFetch();
  await b.checkout(user('u1'), OAK, 'http://t', consent, 'SPARK');
  const pub = b.publicSub(b.subs[0]);
  assert.equal(pub.percentOff, 25);
  assert.equal(pub.discountCents, 225); // 25% off $9.00
  assert.equal(pub.priceCents, 900);
  assert.equal(pub.promoCode, 'SPARK');
  // A full-price sub shows the null/zero defaults.
  await b.checkout(user('u2'), OAK, 'http://t', consent);
  const plain = b.publicSub(b.subs[1]);
  assert.equal(plain.percentOff, null);
  assert.equal(plain.discountCents, 0);
});
