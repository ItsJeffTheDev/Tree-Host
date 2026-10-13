'use strict';
// Shared plumbing for test/creators.e2e.js: the cookie-jar fetch of test/growth.e2e.js plus
// fixtures every scenario shares (owner + staff roles, creator SPARK, checkout helper).
// Kept in its own file so the suite itself stays a single readable scenario list.
const B = process.env.TREEHOST_TEST_URL || 'http://localhost:8799';

const jar = {};
let passes = 0, fails = 0;

async function call(who, method, path, body, headers = {}) {
  const res = await fetch(B + path, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: B, ...(jar[who] ? { Cookie: jar[who] } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const session = res.headers.getSetCookie().find((c) => c.startsWith('th_session='));
  if (session) jar[who] = session.split(';')[0];
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data, headers: res.headers };
}

function expect(label, got, want) {
  const ok = Array.isArray(want) ? want.includes(got) : got === want;
  if (ok) passes++; else fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(got)}${ok ? '' : `, wanted ${JSON.stringify(want)}`}`);
}

/** A signed Stripe event the way billing.webhook() receives it (secret must match STRIPE_WEBHOOK_SECRET). */
const crypto = require('crypto');
function stripeEvent(type, object) {
  const t = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ id: `evt_${crypto.randomBytes(4).toString('hex')}`, type, data: { object } });
  const sig = `t=${t},v1=${crypto.createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex')}`;
  return [body, sig];
}

/** Fires a signed webhook at the server and returns the parsed answer. */
async function webhook(type, object) {
  const [body, sig] = stripeEvent(type, object);
  const res = await fetch(B + '/api/billing/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: B, 'stripe-signature': sig },
    body,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

const signup = (u, extra = {}, headers = {}) =>
  call(u, 'POST', '/api/auth/signup', { username: u, email: `${u}@example.com`, password: 'TreeHost-test-123', acceptTerms: true, birthYear: 1995, ...extra }, headers);

const login = (u, password = 'TreeHost-test-123') => call(u, 'POST', '/api/auth/login', { username: u, password });

const me = async (u) => (await call(u, 'GET', '/api/auth/me')).data.user;

const consent = { renewal: true, adult: true, withdrawal: true };

/** Buys a plan in demo mode (activates instantly) and returns the public sub. */
async function buy(who, planId, extra = {}) {
  const r = await call(who, 'POST', '/api/billing/checkout', { planId, consent, ...extra });
  if (r.status !== 200) throw new Error(`checkout ${planId} for ${who} failed: ${r.status} ${JSON.stringify(r.data)}`);
  const view = await call(who, 'GET', '/api/billing');
  return view.data.subscriptions[0];
}

/** The staff row for one creator code (read as the given staff actor, default owner). */
const creatorRow = async (code, who = 'creowner') => {
  const r = await call(who, 'GET', '/api/admin/creators');
  return (r.data.creators || []).find((c) => c.code === code) || null;
};

const ledger = async (code, who = 'creowner') => (await call(who, 'GET', `/api/admin/creators/${code}/ledger`)).data;

/** Commission ledger entries for one subId. */
const commissionsFor = async (code, subId) =>
  (await ledger(code)).entries.filter((e) => e.type === 'commission' && e.detail.subId === subId);

module.exports = { B, jar, call, expect, signup, login, me, consent, buy, creatorRow, ledger, commissionsFor, webhook, stripeEvent, passes: () => passes, fails: () => fails };
