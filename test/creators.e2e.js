'use strict';
// End-to-end test of the creator program (src/creators.js + its server wiring), spec.md §11 E1–E15,
// in the house style of test/growth.e2e.js: a running local demo site, plain fetch, no deps.
// Start one first (fresh data folder!), then run this:
//   TREEHOST_PUBLIC_URL=http://localhost:8799 TREEHOST_PORT=8799 BILLING_DEMO=1 \
//   TREEHOST_DATA=/tmp/th-creators TREEHOST_TEST_SITE=1 STRIPE_WEBHOOK_SECRET=whsec_test \
//   TREEHOST_HOST=127.0.0.1 node src/server.js &
//   node test/creators.e2e.js
// TREEHOST_TEST_URL overrides the base URL for the suite (same contract as growth.e2e.js);
// the server exits silently when the port is taken — assertUp() makes sure it is really ours.
// STRIPE_WEBHOOK_SECRET is needed because E7/E14 fire signed Stripe events at the real webhook
// route (exactly what a Stripe CLI forward or a Stripe retry does).
//
// Signup rate limit: 10 signups / 15 min per IP, and the lookup + apply limits are asserted too,
// so the suite never sends everything from one address: each logical actor gets a distinct
// X-Forwarded-For (clientIp honors the header from a local connection, the same way a local
// reverse proxy presents the real client IP). Rate buckets stay per actor, like real visitors —
// and E12 can still exhaust one deliberately.
//
// The 15 scenarios live in creators-e2e-scenarios.js. Exits non-zero on the first failure.
const B = process.env.TREEHOST_TEST_URL || 'http://localhost:8799';

/** Nothing listening at all is a clean SKIP: `node --test test/` runs this file too, and the
 *  suite must not count as a failure just because its demo site isn't running (growth contract). */
async function assertUp() {
  try {
    const r = await fetch(B + '/api/plans');
    const d = await r.json();
    if (r.ok && Array.isArray(d.plans) && d.plans.some((p) => p.id === 'sapling')) return true;
    console.error(`FAIL  ${B} is not a Tree Host with the demo billing plans. Start it first (see the header).`);
    process.exit(1);
  } catch {}
  console.log(`SKIP  test/creators.e2e.js: no Tree Host on ${B}. Start it first (see the file header).`);
  process.exit(0);
}

// `node --test test/` is the unit run: no demo site lives behind it. Run the HTTP suite directly
// (`npm run test:creators`) against a server started as in the header above.
if (process.env.NODE_TEST_CONTEXT) {
  console.log('SKIP  test/creators.e2e.js: HTTP E2E runs directly (`npm run test:creators`), not under node --test.');
  process.exit(0);
}

const H = require('./creators-e2e-helpers.js');
const run = require('./creators-e2e-scenarios.js');

/** A distinct source IP per actor so auth's 10/15min signup limit (per IP) never trips early —
 *  see the header. Deterministic per username, so reruns land on the same actor. */
const actorIp = (u) => `10.13.${[...u].reduce((n, ch) => n + ch.charCodeAt(0), 0) % 250}.${(u.length * 7) % 250}`;
const sendAs = (u) => ({ 'X-Forwarded-For': actorIp(u) });

(async () => {
  await assertUp();

  const asOwner = (method, path, body) => H.call('creowner', method, path, body);
  const signupAs = (u, extra = {}) => H.signup(u, extra, sendAs(u));
  /** Any signed-in actor (owner by default) with their own source IP. */
  const asUser = (who, method, path, body) => H.call(who, method, path, body, sendAs(who));
  const expectError = async (label, promise, want, code) => {
    try { await promise; return H.expect(`${label} (no error thrown)`, false, true); }
    catch (e) {
      H.expect(label, e.status, want);
      if (code) H.expect(`${label} error code`, e.code, code);
    }
  };
  // Everything a scenario needs, wrapped so the actor-IP plumbing stays in the runner.
  await run({ ...H, signup: signupAs, asOwner, asUser, expectError });

  console.log(`\n${H.passes()} passed, ${H.fails()} failed`);
  process.exit(H.fails() ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
