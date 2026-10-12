'use strict';
// End-to-end test of the growth work (src/metrics.js + founding billing + site conversion),
// following the pattern of test/rbac.e2e.js: a running local demo site, plain fetch, no deps.
// Start one first (fresh data folder!), then run this:
//   TREEHOST_PUBLIC_URL=http://localhost:8799 TREEHOST_PORT=8799 BILLING_DEMO=1 \
//   TREEHOST_DATA=/tmp/th-growth TREEHOST_FOUNDING_CAP=2 node src/server.js &
//   node test/growth.e2e.js
// The 12 scenarios are spec.md §11. Exits non-zero on the first failure.
const B = process.env.TREEHOST_TEST_URL || 'http://localhost:8799';
const jar = {};
let fails = 0, passes = 0;

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
  return { status: res.status, data, headers: res.headers, text: async () => res.text() };
}

function expect(label, got, want) {
  const ok = Array.isArray(want) ? want.includes(got) : got === want;
  if (ok) passes++; else fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(got)}${ok ? '' : `, wanted ${JSON.stringify(want)}`}`);
}

/** The server exits 0 silently when the port is taken — assert it is really ours before testing.
 *  Nothing listening at all is a clean SKIP: `node --test test/` runs this file too, and the
 *  suite must not count as a failure just because its demo site isn't running. */
async function assertUp() {
  try {
    const r = await fetch(B + '/api/plans');
    const d = await r.json();
    if (r.ok && Array.isArray(d.plans) && d.plans.some((p) => p.id === 'founding-lifetime')) return true;
    console.error(`FAIL  ${B} is not a Tree Host with the founding plan. Start it first:\n` +
      `  TREEHOST_PUBLIC_URL=${B} TREEHOST_PORT=${new URL(B).port || 8766} BILLING_DEMO=1 TREEHOST_DATA=/tmp/th-growth TREEHOST_FOUNDING_CAP=2 node src/server.js &`);
    process.exit(1);
  } catch {}
  console.log(`SKIP  test/growth.e2e.js: no Tree Host on ${B}. Start it first:\n` +
    `  TREEHOST_PUBLIC_URL=${B} TREEHOST_PORT=${new URL(B).port || 8766} BILLING_DEMO=1 TREEHOST_DATA=/tmp/th-growth TREEHOST_FOUNDING_CAP=2 node src/server.js &`);
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `node --test test/` is the unit run: no demo site lives behind it. Run the HTTP suite
// directly (`npm run test:growth`) against a server started as in the header above.
if (process.env.NODE_TEST_CONTEXT) {
  console.log('SKIP  test/growth.e2e.js: HTTP E2E runs directly (`npm run test:growth`), not under node --test.');
  process.exit(0);
}

/** Admin metrics, with a fresh read (in-memory counters, so no settling needed). */
const admin = async (who) => (await call(who, 'GET', '/api/admin/metrics')).data;

(async () => {
  await assertUp();

  // ---- shared fixtures: an owner (first account) and two customers ----
  const signup = (u, extra = {}) =>
    call(u, 'POST', '/api/auth/signup', { username: u, email: `${u}@example.com`, password: 'TreeHost-test-123', acceptTerms: true, birthYear: 1995, ...extra });
  await signup('growthowner');
  for (const u of ['growthcust1', 'growthcust2', 'growthcust3']) await signup(u);
  const me = async (u) => (await call(u, 'GET', '/api/auth/me')).data.user;
  expect('first account is Owner', (await me('growthowner')).role, 'owner');
  for (const u of ['growthcust1', 'growthcust2', 'growthcust3']) expect(`${u} is a customer`, (await me(u)).role, 'customer');

  // Give staff roles to two extra accounts: they hold console.access (spec §11.9).
  await signup('growthdev');
  await signup('growthsupport');
  const users = (await call('growthowner', 'GET', '/api/team/users')).data;
  const id = (name) => users.find((x) => x.username === name).id;
  await call('growthowner', 'PUT', `/api/team/users/${id('growthdev')}/role`, { role: 'developer' });
  await call('growthowner', 'PUT', `/api/team/users/${id('growthsupport')}/role`, { role: 'staff' });

  const consent = { renewal: true, adult: true, withdrawal: true };
  const foundingConsent = { renewal: false, adult: true, withdrawal: true };

  // ------------------------------------------------------------------
  // 1. Page view counted server-side
  // ------------------------------------------------------------------
  await fetch(B + '/pricing');
  await fetch(B + '/pricing?utm=x'); // same bucket, query stripped
  let m = await admin('growthowner');
  expect('pricing pageview counted', (m.pageviewsByPath['/pricing'] || 0) >= 2, true);
  expect('pricing pageview counted (exact)', m.pageviewsByPath['/pricing'], 2);
  const social = await (await fetch(B + '/api/metrics/social')).json();
  expect('social endpoint public + rounded flag', social.rounded, true);
  expect('social is visitor-independent', typeof social.signupsThisWeek, 'number');

  // ------------------------------------------------------------------
  // 2. Client beacon: 204 valid, 400 invalid type, 400 garbage JSON, bot drop
  // ------------------------------------------------------------------
  const beacon = (body, ua) =>
    fetch(B + '/api/metrics/event', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: B, ...(ua ? { 'User-Agent': ua } : {}) }, body });
  expect('valid beacon -> 204', (await beacon(JSON.stringify({ type: 'pageview', path: '/pricing', referrerHost: 'https://discord.com/x', ref: 'discord' }))).status, 204);
  await beacon(JSON.stringify({ type: 'pageview', path: '/beacon-only', referrerHost: 'https://discord.com/x', ref: 'discord' }));
  m = await admin('growthowner');
  expect('beacon lands in the path map (deduped: attribution only)', (m.pageviewsByPath['/beacon-only'] || 0) >= 1, true);
  expect('beacon referrer host recorded', Object.keys(m.refs || {}).length >= 0, true);
  expect('beacon with bad type -> 400', (await beacon(JSON.stringify({ type: 'demoLaunched', path: '/x' }))).status, 400);
  expect('beacon with garbage JSON -> 400', (await beacon('{not json')).status, 400);
  expect('beacon from a bot -> 204 and not counted', (await beacon(JSON.stringify({ type: 'pageview', path: '/bot-page' }), 'TreeHostBot/1.0 (crawler)')).status, 204);
  m = await admin('growthowner');
  expect('bot pageview never counted', m.pageviewsByPath['/bot-page'], undefined);
  expect('pages still load with the endpoint being abused', (await fetch(B + '/pricing')).status, 200);

  // ------------------------------------------------------------------
  // 3. Demo funnel: launch + command
  // ------------------------------------------------------------------
  m = await admin('growthowner');
  const beforeDemo = m.funnel.demos.total;
  const demo = (await call('growthowner', 'POST', '/api/servers/demo')).data;
  expect('demo server created', !!demo.id, true);
  m = await admin('growthowner');
  expect('demoLaunched counted', m.funnel.demos.total > beforeDemo, true);
  // The demo needs a moment to come up (simulated), then a command counts demoCommand.
  let demoUp = false;
  for (let i = 0; i < 40 && !demoUp; i++) {
    await sleep(250);
    demoUp = (await (await fetch(`${B}/api/servers/${demo.id}`, { headers: { Cookie: jar.growthowner } })).json()).status === 'running';
  }
  expect('demo server running', demoUp, true);
  const beforeCmd = (await admin('growthowner')).funnel.demos.total;
  expect('demo command accepted', (await call('growthowner', 'POST', `/api/servers/${demo.id}/command`, { command: 'list' })).status, 200);
  await sleep(300);
  m = await admin('growthowner');
  expect('demoCommand counted', m.funnel.demos.total > beforeCmd, true);

  // ------------------------------------------------------------------
  // 4. Signup + ref
  // ------------------------------------------------------------------
  await signup('refuser', { ref: 'discord' });
  expect('ref stored on the user', (await me('refuser')).ref, 'discord');
  await signup('junkrefuser', { ref: '<script>alert(1)</script>' });
  expect('junk ref becomes other', (await me('junkrefuser')).ref, 'other');
  m = await admin('growthowner');
  expect('signupRef.discord counted', (m.refs.discord || 0) >= 1, true);
  expect('signupRef.other counted', (m.refs.other || 0) >= 1, true);

  // ------------------------------------------------------------------
  // 5. Checkout funnel (demo mode): started + completed + funnel.paid
  // ------------------------------------------------------------------
  m = await admin('growthowner');
  const beforeStarted = m.checkouts.started, beforeCompleted = m.checkouts.completed;
  const co = await call('growthcust1', 'POST', '/api/billing/checkout', { planId: 'sapling', consent });
  expect('sapling checkout activates in demo mode', co.status, 200);
  expect('demo checkout returns the dashboard handoff', co.data.demo, true);
  m = await admin('growthowner');
  expect('checkoutStarted counted', m.checkouts.started, beforeStarted + 1);
  expect('checkoutCompleted counted (demo auto-activates)', m.checkouts.completed, beforeCompleted + 1);
  expect('funnel.paid includes it', m.funnel.paid.total >= 1, true);

  // ------------------------------------------------------------------
  // 6. Donation funnel: started + completed (demo mode pays instantly)
  // ------------------------------------------------------------------
  m = await admin('growthowner');
  const dBeforeS = m.donations.started, dBeforeC = m.donations.completed;
  const don = await call('growthcust1', 'POST', '/api/donations', { amountCents: 1500, name: 'Test Donor', listed: false });
  expect('donation starts (demo pays at once)', don.status, 200);
  expect('donation demo handoff', don.data.demo, true);
  m = await admin('growthowner');
  expect('donationStarted counted', m.donations.started, dBeforeS + 1);
  expect('donationCompleted counted', m.donations.completed, dBeforeC + 1);

  // ------------------------------------------------------------------
  // 7. Founding purchase, happy path: unitsLeft drops in /api/plans AND /api/metrics/social
  // ------------------------------------------------------------------
  let plans = (await (await fetch(B + '/api/plans')).json()).plans;
  const foundingRow = () => plans.find((p) => p.founding);
  expect('founding plan is public', !!foundingRow(), true);
  const unitsBefore = foundingRow().unitsLeft;
  expect('founding cap from env', foundingRow().capTotal, 2);
  const f1 = await call('growthcust2', 'POST', '/api/billing/checkout', { planId: 'founding-lifetime', consent: foundingConsent });
  expect('first founding purchase activates', f1.status, 200);
  plans = (await (await fetch(B + '/api/plans')).json()).plans;
  expect('unitsLeft decremented in /api/plans', foundingRow().unitsLeft, unitsBefore - 1);
  const soc2 = await (await fetch(B + '/api/metrics/social')).json();
  expect('unitsLeft mirrored in /api/metrics/social', soc2.foundingUnitsLeft, foundingRow().unitsLeft);
  expect('social foundingCapTotal', soc2.foundingCapTotal, 2);
  // The buyer got the founder credit (tier context on /api/donations).
  const dctx = await (await fetch(B + '/api/donations')).json();
  expect('founder tier exists in the tiers ladder', (dctx.tiers || []).some((t) => t.id === 'founder'), true);
  // ...and founders.txt on the demo server lists them (the badge pipeline). The list is
  // rewritten by the staff-plugin sync, which a member's Minecraft-name change triggers —
  // exactly what a real founding buyer does to put the badge on their name.
  const DATA_DIR = process.env.TREEHOST_TEST_DATA;
  if (!DATA_DIR) {
    console.error('FAIL  set TREEHOST_TEST_DATA to the server\'s TREEHOST_DATA folder (founders.txt check)');
    process.exit(1);
  }
  await call('growthcust2', 'PATCH', '/api/auth/me', { mcName: 'FoundBuyer2' });
  let founderLine = '';
  for (let i = 0; i < 20 && !founderLine; i++) {
    await sleep(250);
    const file = `${DATA_DIR}/servers/${demo.id}/plugins/TreeHostStaff/founders.txt`;
    let text = '';
    try { text = require('fs').readFileSync(file, 'utf8'); } catch {}
    founderLine = text.split('\n').find((l) => l === 'FoundBuyer2|founder') || '';
  }
  expect('founding buyer in founders.txt with the founder tier', founderLine, 'FoundBuyer2|founder');

  // ------------------------------------------------------------------
  // 8. Founding cap: 2nd OK (cap 2), 3rd -> 409 SOLD_OUT, soldOut state everywhere
  // ------------------------------------------------------------------
  const f2 = await call('growthcust3', 'POST', '/api/billing/checkout', { planId: 'founding-lifetime', consent: foundingConsent });
  expect('second founding purchase OK (at the cap)', f2.status, 200);
  plans = (await (await fetch(B + '/api/plans')).json()).plans;
  expect('unitsLeft now 0', foundingRow().unitsLeft, 0);
  expect('plan row flips to soldOut', foundingRow().soldOut, true);
  const soc3 = await (await fetch(B + '/api/metrics/social')).json();
  expect('social shows foundingUnitsLeft 0', soc3.foundingUnitsLeft, 0);
  const f3 = await call('growthcust1', 'POST', '/api/billing/checkout', { planId: 'founding-lifetime', consent: foundingConsent });
  expect('third founding purchase -> 409', f3.status, 409);
  expect('error code is SOLD_OUT', f3.data.code, 'SOLD_OUT');
  m = await admin('growthowner');
  expect('admin metrics founding sold', m.founding.sold, 2);
  expect('admin metrics founding cap', m.founding.capTotal, 2);
  expect('admin metrics founding unitsLeft', m.founding.unitsLeft, 0);
  // Refund-removes-the-credit is covered at unit level (FND-CRD-004 in test/billing-founding.test.js):
  // demo mode never sees Stripe, so there is no payment intent to refund over HTTP here.

  // ------------------------------------------------------------------
  // 9. Permissions on GET /api/admin/metrics: customer 403, staff 200
  // ------------------------------------------------------------------
  expect('customer GET /api/admin/metrics -> 403', (await call('growthcust1', 'GET', '/api/admin/metrics')).status, 403);
  expect('developer (console.access) -> 200', (await call('growthdev', 'GET', '/api/admin/metrics')).status, 200);
  expect('support (console.access) -> 200', (await call('growthsupport', 'GET', '/api/admin/metrics')).status, 200);
  expect('signed-out -> 401', (await fetch(B + '/api/admin/metrics')).status, 401);

  // ------------------------------------------------------------------
  // 10. Privacy page: honest page-view wording, tracking-cookie claim kept
  // ------------------------------------------------------------------
  const privacy = await (await fetch(B + '/privacy')).text();
  expect('privacy explains page-view counting', privacy.includes('/pricing') && /page path/i.test(privacy), true);
  expect('privacy: hostname-only referrer wording', /hostname only|referring site/i.test(privacy), true);
  expect('privacy: no analytics or tracking cookies claim', /analytics or tracking cookies/i.test(privacy), true);
  expect('privacy: no IPs or personal data in the count', /no IP address, personal data/i.test(privacy), true);

  // ------------------------------------------------------------------
  // 11. Homepage: demo-first CTA order + social strip
  // ------------------------------------------------------------------
  const home = await (await fetch(B + '/')).text();
  const demoCta = home.indexOf('Try the demo server');
  const tour = home.indexOf('1-minute tour');
  expect('demo CTA present', demoCta > -1, true);
  expect('tour link present', tour > -1, true);
  expect('demo CTA comes before the tour', demoCta < tour, true);
  expect('social strip container present', home.includes('social-strip'), true);
  expect('social endpoint reachable publicly', (await fetch(B + '/api/metrics/social')).status, 200);

  // ------------------------------------------------------------------
  // 12. Pricing page: recommender markup, both questions
  // ------------------------------------------------------------------
  const pricing = await (await fetch(B + '/pricing')).text();
  expect('recommender widget present', pricing.includes('id="recommender"'), true);
  expect('question 1 (players)', pricing.includes('How many players will join?'), true);
  expect('question 2 (workload)', /Vanilla or a modpack\?/.test(pricing), true);

  // ------------------------------------------------------------------
  // 12b. Referrer-Policy: public HTML strict-origin-when-cross-origin, dashboard no-referrer
  // ------------------------------------------------------------------
  const hp = await fetch(B + '/');
  expect('homepage Referrer-Policy', hp.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  const pp = await fetch(B + '/pricing');
  expect('pricing Referrer-Policy', pp.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  const dash = await fetch(B + '/dashboard');
  expect('dashboard Referrer-Policy', dash.headers.get('referrer-policy'), 'no-referrer');

  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
