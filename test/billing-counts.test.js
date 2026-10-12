'use strict';
// Unit tests for the funnel counters in billing (node --test, zero deps).
// Run: node --test test/billing-counts.test.js
//
// These tests run in Stripe test mode (STRIPE_SECRET_KEY set) with global fetch stubbed, so the
// webhook / confirmCheckout / checkout-session paths run for real without the network. Demo-mode
// counting is covered too (the mode getter is overridden per instance).

process.env.STRIPE_SECRET_KEY = 'sk_test_stub'; // test mode: real code paths, no live money
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test'; // so billing.webhook() can verify the signed test events
delete process.env.TREEHOST_FOUNDING_CAP;
delete process.env.BILLING_DEMO;

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const store = require('../src/store');
const { Billing } = require('../src/billing');

store.save = () => Promise.resolve();
store.load = () => Promise.resolve(undefined);

const user = (id) => ({ id, username: `u${id}`, email: `${id}@t.dev`, mcName: `mc${id}` });
const consent = { renewal: true, adult: true, withdrawal: true };

/** A billing instance with its metric hook recording every counter call in order. */
function newBilling() {
  const b = new Billing();
  b.hooks.userById = (id) => user(id);
  b.testSite = true;
  b.metrics = [];
  b.hooks.metric = (type, extra) => b.metrics.push({ type, extra });
  return b;
}

/** Overrides the env-derived mode getter for one instance (e.g. 'demo' or 'off'). */
function forceMode(b, mode) {
  Object.defineProperty(b, 'mode', { get: () => mode });
  return b;
}

const count = (b, type) => b.metrics.filter((m) => m.type === type).length;

/** A signed Stripe event, the way billing.webhook() receives it. */
function stripeEvent(type, object) {
  const t = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ id: `evt_${crypto.randomBytes(4).toString('hex')}`, type, data: { object } });
  const sig = `t=${t},v1=${crypto.createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex')}`;
  return [body, sig];
}

const users = { userById: (id) => user(id), save: () => Promise.resolve() };

/** Stub global fetch the way billing.stripe() expects it: { ok, json() }, keyed by Stripe pathname. */
function stubFetch(responses) {
  const calls = [];
  global.fetch = async (url) => {
    const path = String(url).replace('https://api.stripe.com/v1', '').split('?')[0];
    calls.push(path);
    const r = responses[path];
    const json = typeof r === 'function' ? r() : r || {};
    return { ok: true, json: async () => json };
  };
  return calls;
}

test.afterEach(() => { delete global.fetch; });

test('CNT-ACT-001: activate() on a pending sub counts checkoutCompleted exactly once', () => {
  const b = newBilling();
  const s = b.newSub(user('u1'), b.plan('lifetime'));
  b.activate(s);
  assert.equal(s.status, 'active');
  assert.equal(count(b, 'checkoutCompleted'), 1);
  // activate() again on the same sub (webhook retry, invoice.paid, subscription.updated): still one.
  b.activate(s);
  b.activate(s, { periodEnd: Date.now() + 86400000 });
  assert.equal(count(b, 'checkoutCompleted'), 1);
});

test('CNT-ACT-002: past_due → active (recovery) does not count, pending → active does', () => {
  const b = newBilling();
  const s = b.newSub(user('u1'), b.plan('lifetime'));
  s.status = 'past_due';
  b.activate(s);
  assert.equal(count(b, 'checkoutCompleted'), 0);
  const p = b.newSub(user('u2'), b.plan('lifetime'));
  b.activate(p);
  assert.equal(count(b, 'checkoutCompleted'), 1);
});

test('CNT-WEB-003: webhook checkout.session.completed then browser confirmCheckout counts once', async () => {
  const b = newBilling();
  stubFetch({ '/checkout/sessions': { id: 'cs_1', url: 'https://stripe.test/cs_1' } });
  await b.checkout(user('u1'), 'lifetime', 'http://t', consent);
  const s = b.subs[0];
  assert.equal(s.status, 'pending');
  assert.equal(count(b, 'checkoutCompleted'), 0);
  const session = {
    id: 'cs_1',
    object: 'checkout.session',
    mode: 'payment',
    payment_status: 'paid',
    status: 'complete',
    client_reference_id: s.id,
    customer: 'cus_test',
    payment_intent: 'pi_test',
  };
  // The webhook fires first.
  const [body, sig] = stripeEvent('checkout.session.completed', session);
  await b.webhook(body, sig, users);
  assert.equal(s.status, 'active');
  assert.equal(count(b, 'checkoutCompleted'), 1);
  // The customer returns and the browser-side confirm fallback fires too (and again — retries).
  stubFetch({ [`/checkout/sessions/cs_1`]: session });
  await b.confirmCheckout(user('u1'), 'cs_1', users);
  await b.confirmCheckout(user('u1'), 'cs_1', users);
  assert.equal(count(b, 'checkoutCompleted'), 1);
});

test('CNT-WEB-004: a paid one-time webhook session counts; a non-paid one does not', async () => {
  const b = newBilling();
  stubFetch({ '/checkout/sessions': { id: 'cs_2', url: 'https://stripe.test/cs_2' } });
  await b.checkout(user('u1'), 'lifetime', 'http://t', consent);
  const s = b.subs[0];
  const [body, sig] = stripeEvent('checkout.session.completed', {
    object: 'checkout.session', mode: 'payment', payment_status: 'unpaid', status: 'complete',
    client_reference_id: s.id, customer: 'cus_test', payment_intent: 'pi_test',
  });
  await b.webhook(body, sig, users);
  assert.equal(s.status, 'pending'); // unpaid: not activated, not counted
  assert.equal(count(b, 'checkoutCompleted'), 0);
});

test('CNT-DON-005: markDonationPaid counts donationCompleted once, the paid guard blocks re-counts', () => {
  const b = newBilling();
  const d = { id: 'd1', amountCents: 500, status: 'pending', userId: 'u1', name: 'Ann', createdAt: Date.now() };
  b.donations.push(d);
  b.markDonationPaid(d, { payment_intent: 'pi_1' });
  assert.equal(count(b, 'donationCompleted'), 1);
  b.markDonationPaid(d, { payment_intent: 'pi_1' }); // webhook retry / double confirm
  assert.equal(d.status, 'paid');
  assert.equal(count(b, 'donationCompleted'), 1);
});

test('CNT-DON-006: the donation webhook counts once; confirmDonation afterwards does not add', async () => {
  const b = newBilling();
  stubFetch({ '/checkout/sessions': { id: 'cs_don', url: 'https://stripe.test/cs_don' } });
  await b.donate({ amountCents: 500, name: 'Ann' }, 'http://t');
  const d = b.donations[0];
  assert.equal(d.status, 'pending');
  const session = {
    id: 'cs_don',
    object: 'checkout.session', mode: 'payment', payment_status: 'paid', status: 'complete',
    metadata: { kind: 'donation', donationId: d.id }, payment_intent: 'pi_don',
  };
  const [body, sig] = stripeEvent('checkout.session.completed', session);
  await b.webhook(body, sig, users);
  assert.equal(d.status, 'paid');
  assert.equal(count(b, 'donationCompleted'), 1);
  stubFetch({ '/checkout/sessions/cs_don': session });
  await b.confirmDonation('cs_don'); // the browser fallback asks Stripe again
  assert.equal(count(b, 'donationCompleted'), 1);
});

test('CNT-CKO-007: checkoutStarted fires once past the gates, before the session is created', async () => {
  const b = newBilling();
  const order = [];
  b.hooks.metric = (type) => order.push(type);
  stubFetch({
    '/checkout/sessions': () => { order.push('sessionCreated'); return { id: 'cs_3', url: 'https://stripe.test/cs_3' }; },
  });
  const before = b.subs.length;
  await b.checkout(user('u1'), 'lifetime', 'http://t', consent);
  assert.deepEqual(order, ['checkoutStarted', 'sessionCreated']);
  assert.equal(b.subs.length, before + 1);
  assert.equal(count(b, 'checkoutCompleted'), 0); // abandoned until Stripe confirms
});

test('CNT-CKO-008: gated checkouts (no consent, mode off) never count as started', async () => {
  const b = newBilling();
  await assert.rejects(() => b.checkout(user('u1'), 'lifetime', 'http://t', { adult: true }));
  assert.equal(count(b, 'checkoutStarted'), 0);
  const off = forceMode(newBilling(), 'off');
  await assert.rejects(() => off.checkout(user('u1'), 'lifetime', 'http://t', consent));
  assert.equal(count(off, 'checkoutStarted'), 0);
});

test('CNT-CKO-009: demo-mode checkout counts started then completed (auto-activation)', async () => {
  const b = forceMode(newBilling(), 'demo');
  const out = await b.checkout(user('u1'), 'lifetime', 'http://t', consent);
  assert.equal(out.demo, true);
  assert.equal(count(b, 'checkoutStarted'), 1);
  assert.equal(count(b, 'checkoutCompleted'), 1);
});
