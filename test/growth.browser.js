'use strict';
// Browser E2E for the growth work (optional layer): Playwright + the system Chromium.
// Zero npm dependencies: playwright-core is bundled with the Python Playwright install
// (nothing is added to package.json); Chromium comes from /usr/local/bin/chromium.
// Run: node test/growth.browser.js  (against a running demo site, like test/growth.e2e.js —
// it can share that server: TREEHOST_TEST_URL + TREEHOST_TEST_DATA, BILLING_DEMO=1).
//
// Skipped with a message (exit 0) when no Chromium binary is found, so CI without a
// browser still passes.

const CHROMIUM = process.env.TREEHOST_CHROMIUM || '/usr/local/bin/chromium';
const PW_PATH = process.env.TREEHOST_PLAYWRIGHT_PATH || '/usr/local/lib/python3.10/dist-packages/playwright/driver/package';

const fs = require('fs');
// `node --test test/` is the unit run: it has no demo site (and shouldn't spend a minute
// launching a browser). Run this suite directly: `npm run test:browser`.
if (process.env.NODE_TEST_CONTEXT) {
  console.log('SKIP  test/growth.browser.js: browser E2E runs directly (`npm run test:browser`), not under node --test.');
  process.exit(0);
}
if (!fs.existsSync(CHROMIUM)) {
  console.log(`SKIP  test/growth.browser.js: no Chromium at ${CHROMIUM} (set TREEHOST_CHROMIUM)`);
  process.exit(0);
}
let pw;
try {
  pw = require(PW_PATH);
} catch {
  console.log(`SKIP  test/growth.browser.js: playwright-core not found at ${PW_PATH} (set TREEHOST_PLAYWRIGHT_PATH)`);
  process.exit(0);
}

const B = process.env.TREEHOST_TEST_URL || 'http://localhost:8799';
let fails = 0, passes = 0;
const check = (label, ok, extra = '') => {
  ok ? passes++ : fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (${extra})`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // The server must be up (it exits 0 silently on an occupied port).
  let plans;
  try {
    plans = (await (await fetch(B + '/api/plans')).json()).plans;
    if (!plans || !plans.some((p) => p.founding)) throw new Error('no founding plan');
  } catch {
    console.error(`FAIL  no Tree Host with the founding plan on ${B}. Start it first (see test/growth.e2e.js header).`);
    process.exit(1);
  }

  const browser = await pw.chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  // ------------------------------------------------------------------
  // Homepage: CTA order + social strip
  // ------------------------------------------------------------------
  await page.goto(B + '/', { waitUntil: 'networkidle' });
  const ctaOrder = await page.evaluate(() => {
    const demo = [...document.querySelectorAll('a')].findIndex((a) => /Try the demo server/.test(a.textContent));
    const tour = [...document.querySelectorAll('a')].findIndex((a) => /1-minute tour/.test(a.textContent));
    return { demo, tour, strip: !!document.getElementById('social-strip'), stripHidden: document.getElementById('social-strip')?.hidden };
  });
  check('homepage: demo CTA before the tour link', ctaOrder.demo > -1 && ctaOrder.tour > -1 && ctaOrder.demo < ctaOrder.tour, JSON.stringify(ctaOrder));
  // Signed-out the CTA points at the signup handoff (?signup&demo=1); signed in, site.js
  // swaps it to the ?demo=1 href. Either way the primary CTA is the demo, never the tour.
  const ctaHref = await page.evaluate(() => {
    const a = document.querySelector('.hero-cta a.btn-cta');
    return a ? a.href + '|' + a.textContent.trim() : '';
  });
  check('homepage: hero CTA is the demo (href or label)', /demo|Try the demo server/.test(ctaHref), ctaHref);
  // The strip fills from the live API (a local site has real numbers: signups etc.).
  await page.waitForFunction(() => {
    const s = document.getElementById('social-strip');
    return s && !s.hidden && [...s.querySelectorAll('.social-num')].some((el) => el.textContent !== '—');
  }, { timeout: 8000 }).then(
    () => check('homepage: social strip renders numbers from the API', true),
    () => check('homepage: social strip renders numbers from the API', false, 'strip stayed hidden/empty'),
  );
  // Strip survives an API failure: mock it to 500 and reload.
  await page.route('**/api/metrics/social', (r) => r.fulfill({ status: 500, body: 'no' }));
  await page.goto(B + '/', { waitUntil: 'networkidle' });
  const stripOnFail = await page.evaluate(() => {
    const s = document.getElementById('social-strip');
    return { hidden: !s || s.hidden, pageOk: !!document.querySelector('.hero-cta') };
  });
  check('homepage: strip absent (not broken) when the API 500s', stripOnFail.hidden && stripOnFail.pageOk, JSON.stringify(stripOnFail));
  await page.unroute('**/api/metrics/social');

  // ------------------------------------------------------------------
  // Recommender: 5–20 players + modpack -> Oak; 2 friends + vanilla -> Sapling
  // ------------------------------------------------------------------
  await page.goto(B + '/pricing', { waitUntil: 'networkidle' });
  const reco = async (playersBtn, workloadBtn, wantName) => {
    await page.click(`.reco-opt[data-q="players"][data-v="${playersBtn}"]`);
    await page.click(`.reco-opt[data-q="workload"][data-v="${workloadBtn}"]`);
    await page.waitForFunction(
      () => document.querySelectorAll('#plans .plan.recommended').length === 1,
      { timeout: 5000 },
    ).catch(() => {});
    return page.evaluate(() => {
      const hit = document.querySelector('#plans .plan.recommended');
      return { name: hit ? hit.querySelector('h3').textContent.trim() : null, tag: hit ? !!hit.querySelector('.reco-tag') : false };
    });
  };
  let r = await reco('mid', 'modpack');
  check('recommender: 5–20 players + modpack -> Oak', r.name === 'Oak' && r.tag, JSON.stringify(r));
  await page.goto(B + '/pricing', { waitUntil: 'networkidle' });
  r = await reco('friends', 'vanilla');
  check('recommender: a few friends + vanilla -> Sapling', r.name === 'Sapling' && r.tag, JSON.stringify(r));
  const hint = await page.textContent('#reco-hint').catch(() => '');
  check('recommender: hint names the plan', /Recommended: Sapling/.test(hint || ''), hint);

  // ------------------------------------------------------------------
  // Donate page: founding card states (live numbers from the plans row)
  // ------------------------------------------------------------------
  await page.goto(B + '/donate', { waitUntil: 'networkidle' });
  const foundingState = await page.evaluate(() => {
    const card = document.getElementById('founding-card');
    return {
      visible: card && !card.hidden,
      price: document.querySelector('[data-founding-price]')?.textContent || '',
      count: document.getElementById('founding-count')?.textContent || '',
      cta: document.getElementById('founding-cta')?.textContent || '',
      soldOut: card?.classList.contains('sold-out'),
    };
  });
  check('donate: founding card visible', foundingState.visible, JSON.stringify(foundingState));
  check('donate: founding card shows $199', foundingState.price.includes('199'), foundingState.price);
  check('donate: founding count reads the live unitsLeft', /of 2 left|2 of 2/.test(foundingState.count), foundingState.count);
  // Sold-out state: mock the plans row the card renders from.
  await page.route('**/api/plans', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        currency: 'usd', mode: 'demo',
        plans: plans.map((p) => (p.founding ? { ...p, unitsLeft: 0, soldOut: true } : p)),
      }),
    }));
  await page.goto(B + '/donate', { waitUntil: 'networkidle' });
  const sold = await page.evaluate(() => {
    const card = document.getElementById('founding-card');
    const go = document.getElementById('founding-cta');
    return {
      soldOut: card?.classList.contains('sold-out'),
      tag: document.getElementById('founding-tag')?.textContent || '',
      cta: go?.textContent || '',
      disabled: go?.disabled,
      count: document.getElementById('founding-count')?.textContent || '',
    };
  });
  check('donate: sold-out card class', sold.soldOut === true, JSON.stringify(sold));
  check('donate: sold-out tag', sold.tag === 'SOLD OUT', sold.tag);
  check('donate: sold-out CTA disabled', sold.disabled === true, sold.cta);
  check('donate: sold-out count "2 of 2 claimed"', sold.count === '2 of 2 claimed', sold.count);
  await page.unroute('**/api/plans');

  // ------------------------------------------------------------------
  // Founding signup handoff, happy path (donate CTA -> signup -> dashboard banner)
  // Needs one free founding spot: run against a server whose cap still has room.
  // ------------------------------------------------------------------
  const unitsLeftNow = plans.find((p) => p.founding).unitsLeft;
  if (unitsLeftNow < 1) {
    console.log(`SKIP  founding signup handoff: no founding spots left on ${B} (restart with a fresh TREEHOST_DATA). The rest of the browser suite already ran.`);
    await browser.close();
    console.log(`\n${passes} passed, ${fails} failed`);
    process.exit(fails ? 1 : 0);
  }
  await page.goto(B + '/donate', { waitUntil: 'networkidle' });
  await page.click('#founding-cta');
  await page.waitForURL(/dashboard\?signup&plan=founding-lifetime/, { timeout: 8000 }).catch(() => {});
  check('handoff: donate CTA goes to the founding signup', /dashboard\?signup&plan=founding-lifetime/.test(page.url()), page.url());
  await page.waitForFunction(() => /Founding Lifetime spot is waiting/.test(document.getElementById('auth-sub')?.textContent || ''), { timeout: 8000 })
    .then(() => check('handoff: signup screen shows the founding wording with the live count', true))
    .catch(() => check('handoff: signup screen shows the founding wording with the live count', false, document.getElementById('auth-sub')?.textContent || ''));
  const note = await page.textContent('#auth-founding-note').catch(() => '');
  check('handoff: $199 confirm note present', /199/.test(note || ''), note);
  check('handoff: button reads Create account & finish purchase', (await page.textContent('#auth-form button.btn.primary') || '').includes('finish purchase'), '');
  // Complete the signup (a unique name; the founding unit is then bought from the banner).
  const username = `fndbrwsr${Math.floor(Math.random() * 100000)}`;
  await page.fill('#auth-form input[name="username"]', username);
  await page.fill('#auth-form input[name="email"]', `${username}@example.com`);
  await page.fill('#auth-form input[name="password"]', 'TreeHost-test-123');
  await page.selectOption('#auth-form select[name="birthYear"]', '1995');
  await page.check('#auth-form input[name="acceptTerms"]');
  await page.click('#auth-form button.btn.primary');
  await page.waitForURL(/dashboard\?welcome&plan=founding-lifetime/, { timeout: 15000 }).catch(() => {});
  check('handoff: signup redirects to the dashboard banner', /dashboard\?welcome&plan=founding-lifetime/.test(page.url()), page.url());
  await page.waitForSelector('#founding-banner', { timeout: 10000 }).catch(() => {});
  const banner = await page.evaluate(() => {
    const b = document.getElementById('founding-banner');
    return b ? { text: b.textContent, checkout: document.getElementById('founding-checkout')?.textContent || '' } : null;
  });
  const capNow = plans.find((p) => p.founding).capTotal;
  check('handoff: banner renders with a live count', !!banner && /Finish your Founding Lifetime purchase/.test(banner.text) && new RegExp(`[0-9]+ of ${capNow} left`).test(banner.text), JSON.stringify(banner));
  check('handoff: banner has the Complete checkout button', !!banner && /Complete checkout/.test(banner.checkout), banner && banner.checkout);
  // Open the checkout modal and confirm — demo mode activates the purchase instantly.
  await page.click('#founding-checkout');
  await page.waitForSelector('#co-form', { timeout: 8000 }).catch(() => {});
  const modal = await page.evaluate(() => ({
    open: !!document.getElementById('co-form'),
    plan: document.querySelector('#modal-root h2')?.textContent || '',
    adult: !!document.querySelector('#co-form input[name="adult"]'),
  }));
  check('handoff: checkout modal opens from the banner', modal.open && /Founding Lifetime/.test(modal.plan) && modal.adult, JSON.stringify(modal));
  await page.check('#co-form input[name="adult"]');
  await page.check('#co-form input[name="withdrawal"]');
  await page.click('#co-go');
  await page.waitForFunction(() => !document.getElementById('co-form'), { timeout: 10000 }).catch(() => {});
  const bought = await page.evaluate(async () => {
    const d = await (await fetch('/api/billing', { headers: { 'Content-Type': 'application/json' } })).json();
    return (d.subscriptions || []).find((s) => s.planId === 'founding-lifetime')?.status || null;
  });
  check('handoff: founding purchase activated in demo mode', bought === 'active', String(bought));
  const unitsLeft = (await (await fetch(B + '/api/plans')).json()).plans.find((p) => p.founding).unitsLeft;
  check('handoff: unitsLeft decremented after the browser purchase', unitsLeft === unitsLeftNow - 1, `${unitsLeft} (was ${unitsLeftNow})`);

  check('no page errors during the whole run', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
