'use strict';
// The E1–E15 scenarios for test/creators.e2e.js, spec.md §11. Receives the shared plumbing as
// one object so there are no globals: signup/asOwner/asUser carry per-actor source IPs (see the
// runner header), expectError asserts a rejection's status (+ optional error code).
const crypto = require('crypto');
const B0 = process.env.TREEHOST_TEST_URL || 'http://localhost:8799';

module.exports = async function run({ call, expect, signup, login, me, consent, buy, creatorRow, ledger, commissionsFor, webhook, asOwner, asUser, expectError }) {
  // ------------------------------------------------------------------
  // Shared fixtures: owner (first account), a developer, a support, an admin-role user.
  // ------------------------------------------------------------------
  await signup('creowner');
  expect('first account is Owner', (await me('creowner')).role, 'owner');

  // ------------------------------------------------------------------
  // E1 (CRITICAL): full link → signup → pay → commission path, via the REAL ref param
  // ------------------------------------------------------------------
  expect('E1 owner creates creator SPARK', (await asOwner('POST', '/api/admin/creators',
    { name: 'Sparky', code: 'SPARK', handle: '@spark', platform: 'YouTube', note: 'launch partner' })).status, 200);
  // A browser sends the ref query param verbatim — any case. The body ref here is raw 'spark'.
  await signup('crecust1', { ref: 'spark' });
  const c1 = await me('crecust1');
  expect('E1 ref kept, normalized to the code', c1.ref, 'SPARK');
  expect('E1 /api/auth/me shows creatorCode', c1.creatorCode, 'SPARK');
  await buy('crecust1', 'sapling');
  let row = await creatorRow('SPARK');
  expect('E1 payingReferrals 1', row.stats.payingReferrals, 1);
  expect('E1 earned 50 (Bronze 10% x $5)', row.stats.earnedCents, 50);
  expect('E1 balance follows earned', row.stats.balanceCents, 50);
  expect('E1 tier still Bronze at 1 referral', row.tier.id, 'bronze');
  let page = await ledger('SPARK');
  expect('E1 one commission ledger entry', page.entries.filter((e) => e.type === 'commission').length, 1);
  expect('E1 ledger entry is the sapling payment', page.entries[0].detail.planName, 'Sapling');
  expect('E1 no clawback yet', page.entries.every((e) => e.type === 'commission'), true);
  // The static allowlist must not swallow the code, and unknown refs stay 'other'.
  await signup('crejunk', { ref: 'notacode' });
  expect('E1 unknown ref stays other', (await me('crejunk')).ref, 'other');
  expect('E1 junk signup attributed to nobody', (await me('crejunk')).creatorCode, null);

  // ------------------------------------------------------------------
  // E2: permissions — developer and support get 403, owner and admin succeed
  // ------------------------------------------------------------------
  await signup('credev');
  await signup('cresupport');
  await signup('crechief');
  const team = (await asOwner('GET', '/api/team/users')).data;
  const uid = (name) => team.find((x) => x.username === name).id;
  await asOwner('PUT', `/api/team/users/${uid('credev')}/role`, { role: 'developer' });
  await asOwner('PUT', `/api/team/users/${uid('cresupport')}/role`, { role: 'staff' });
  await asOwner('PUT', `/api/team/users/${uid('crechief')}/role`, { role: 'admin' });
  expect('E2 developer POST /api/admin/creators -> 403', (await call('credev', 'POST', '/api/admin/creators', { name: 'X', code: 'DEVCODE' })).status, 403);
  expect('E2 support POST /api/admin/creators -> 403', (await call('cresupport', 'POST', '/api/admin/creators', { name: 'X', code: 'SUPCODE' })).status, 403);
  expect('E2 admin POST /api/admin/creators -> 200', (await call('crechief', 'POST', '/api/admin/creators', { name: 'Ada', code: 'ADMINC' })).status, 200);
  expect('E2 admin GET /api/admin/creators -> 200', (await call('crechief', 'GET', '/api/admin/creators')).status, 200);
  expect('E2 owner GET /api/admin/creators -> 200', (await call('creowner', 'GET', '/api/admin/creators')).status, 200);
  expect('E2 customer GET /api/admin/creators -> 403', (await call('crecust1', 'GET', '/api/admin/creators')).status, 403);
  expect('E2 signed-out admin list -> 401', (await call('nobody', 'GET', '/api/admin/creators')).status, 401);

  // ------------------------------------------------------------------
  // E3: tier boundary at 5 — the 5th paying referral posts at the pre-promotion percent
  // ------------------------------------------------------------------
  // Four more paying referrals: commissions 2-5 on sapling ($5). At post time of #5 the count is
  // still 4 → Bronze 10% = 50c, and only AFTER posting does the record promote to Silver.
  const e3users = [];
  for (let i = 2; i <= 5; i++) {
    const u = `cretier${i}`;
    e3users.push(u);
    await signup(u, { ref: 'SPARK' });
    expect(`E3 cretier${i} attributed`, (await me(u)).creatorCode, 'SPARK');
    await buy(u, 'sapling');
  }
  row = await creatorRow('SPARK');
  expect('E3 5 paying referrals', row.stats.payingReferrals, 5);
  expect('E3 earned 250 (5 x 50c at 10%)', row.stats.earnedCents, 250);
  expect('E3 5th commission posted at Bronze 10%', (await ledger('SPARK')).entries.find((e) => e.type === 'commission' && e.detail.username === 'cretier5').detail.percent, 10);
  expect('E3 tier promoted to Silver after the 5th', row.tier.id, 'silver');
  expect('E3 bestTier silver', row.bestTier, 'silver');
  // The 6th posts at Silver 15%.
  await signup('cretier6', { ref: 'SPARK' });
  await buy('cretier6', 'sapling');
  row = await creatorRow('SPARK');
  expect('E3 6th commission posts at Silver 15% (75c)', (await ledger('SPARK')).entries.find((e) => e.type === 'commission' && e.detail.username === 'cretier6').amountCents, 75);
  expect('E3 payingReferrals 6', row.stats.payingReferrals, 6);
  expect('E3 earned 325', row.stats.earnedCents, 325);

  // ------------------------------------------------------------------
  // E4: tier boundary at 25 — the 25th paying referral posts at Silver, then Gold sticks
  // ------------------------------------------------------------------
  // 19 more paying referrals (#7-#25). Commission #25 posts while the count is 24 → Silver 15%.
  for (let i = 7; i <= 25; i++) {
    const u = `cregold${i}`;
    await signup(u, { ref: 'SPARK' });
    await buy(u, 'sapling');
  }
  row = await creatorRow('SPARK');
  expect('E4 25 paying referrals', row.stats.payingReferrals, 25);
  expect('E4 tier Gold', row.tier.id, 'gold');
  expect('E4 bestTier Gold', row.bestTier, 'gold');
  const g25 = (await ledger('SPARK')).entries.find((e) => e.type === 'commission' && e.detail.username === 'cregold25');
  expect('E4 25th commission posted at Silver 15% (75c)', g25.amountCents, 75);
  expect('E4 25th posted before promotion', g25.detail.tierAtPost, 'silver');
  // The 26th posts at Gold 20%.
  await signup('cregold26', { ref: 'SPARK' });
  await buy('cregold26', 'sapling');
  const g26 = (await ledger('SPARK')).entries.find((e) => e.type === 'commission' && e.detail.username === 'cregold26');
  expect('E4 26th commission posts at Gold 20% (100c)', g26.amountCents, 100);

  // ------------------------------------------------------------------
  // E5: payout flow + audit trail (full balance, method + reference)
  // ------------------------------------------------------------------
  row = await creatorRow('SPARK');
  const balanceBefore = row.stats.balanceCents;
  const paid = await asOwner('POST', '/api/admin/creators/SPARK/payout',
    { amountCents: balanceBefore, method: 'paypal', reference: 'PAYID-E5-1', note: 'first payout' });
  expect('E5 full payout succeeds', paid.status, 200);
  expect('E5 balance now 0', paid.data.stats.balanceCents, 0);
  expect('E5 paidOut equals the balance', paid.data.stats.paidOutCents, balanceBefore);
  page = await ledger('SPARK');
  const pay = page.entries.find((e) => e.type === 'payout');
  expect('E5 payout ledger entry is negative', pay.amountCents, -balanceBefore);
  expect('E5 payout records by', pay.detail.by, 'creowner');
  expect('E5 payout records the reference', pay.detail.reference, 'PAYID-E5-1');
  const audit = (await call('creowner', 'GET', '/api/admin/audit', undefined)).data;
  expect('E5 audit log has the payout line', audit.some((a) => /payout/.test(a.text) && /SPARK/.test(a.text)), true);
  // Partial payout leaves the remainder; guards are E6/E7 territory.
  const part = await asOwner('POST', '/api/admin/creators/ADMINC/payout', { amountCents: 100, method: 'iban', reference: 'IBAN-E5' });
  expect('E5 payout without balance -> 409', part.status, 409);

  // ------------------------------------------------------------------
  // E6: overpay guard — balance + 1 is 409 and changes nothing
  // ------------------------------------------------------------------
  row = await creatorRow('SPARK');
  const over = await asOwner('POST', '/api/admin/creators/SPARK/payout', { amountCents: row.stats.balanceCents + 1, method: 'paypal', reference: 'PAYID-E6' });
  expect('E6 overpay -> 409', over.status, 409);
  expect('E6 balance unchanged', (await creatorRow('SPARK')).stats.balanceCents, row.stats.balanceCents);
  const badMethod = await asOwner('POST', '/api/admin/creators/SPARK/payout', { amountCents: 1, method: 'bitcoin', reference: 'X' });
  expect('E6 bad method -> 400', badMethod.status, 400);
  const noRef = await asOwner('POST', '/api/admin/creators/SPARK/payout', { amountCents: 1, method: 'paypal', reference: '' });
  expect('E6 missing reference -> 400', noRef.status, 400);

  // ------------------------------------------------------------------
  // E7: refund clawback (incl. negative balance), tiers never regress
  // ------------------------------------------------------------------
  // Refund crecust1's sapling payment the way Stripe does: a signed charge.refunded webhook for
  // the sub's payment intent. Demo checkouts never see Stripe, so the intent is stamped first by
  // the completed-session webhook — the same event a real purchase would have delivered.
  const sub1 = (await call('crecust1', 'GET', '/api/billing')).data.subscriptions[0];
  await webhook('checkout.session.completed', { object: 'checkout.session', mode: 'payment', payment_status: 'paid', status: 'complete', client_reference_id: sub1.id, payment_intent: 'pi_e7_1' });
  await webhook('charge.refunded', { payment_intent: 'pi_e7_1', refunded: true });
  page = await ledger('SPARK');
  const claw = page.entries.find((e) => e.type === 'clawback');
  expect('E7 clawback ledger entry exists', !!claw, true);
  expect('E7 clawback reverses the exact 50c', claw.amountCents, -50);
  expect('E7 clawback names the refunded sub', claw.detail.subId, sub1.id);
  row = await creatorRow('SPARK');
  const e7paying = row.stats.payingReferrals, e7balance = row.stats.balanceCents, e7earned = row.stats.earnedCents;
  expect('E7 payingReferrals unchanged by the clawback', e7paying, 26); // clawbacks never decrement
  expect('E7 balance reduced by the exact commission (was paid out in E5: goes negative)', e7balance, 1800 - 1850);
  expect('E7 earned reduced by the exact commission', e7earned, 1850 - 50);
  expect('E7 tier unchanged (gold)', row.tier.id, 'gold');
  expect('E7 bestTier sticks (gold)', row.bestTier, 'gold');
  // Clawback with a payout already sent: balance goes negative, then the payout guard holds.
  const e7sub = (await call('cretier6', 'GET', '/api/billing')).data.subscriptions[0];
  await webhook('checkout.session.completed', { object: 'checkout.session', mode: 'payment', payment_status: 'paid', status: 'complete', client_reference_id: e7sub.id, payment_intent: 'pi_e7_2' });
  const negBefore = (await creatorRow('SPARK')).stats.balanceCents;
  await asOwner('POST', '/api/admin/creators/SPARK/payout', { amountCents: negBefore, method: 'paypal', reference: 'PAYID-E7' });
  await webhook('charge.refunded', { payment_intent: 'pi_e7_2', refunded: true });
  row = await creatorRow('SPARK');
  expect('E7 balance went negative after payout + refund', row.stats.balanceCents < 0, true);
  expect('E7 negative-balance payout -> 409', (await asOwner('POST', '/api/admin/creators/SPARK/payout', { amountCents: 1, method: 'paypal', reference: 'PAYID-E7b' })).status, 409);
  // A refund of a sub that never posted a commission is a no-op (no clawback entry): crejunk is
  // unattributed, so their payment posted nothing — refunding it must not touch the ledger.
  await buy('crejunk', 'oak');
  const junkSub = (await call('crejunk', 'GET', '/api/billing')).data.subscriptions.find((s) => s.planId === 'oak');
  await webhook('checkout.session.completed', { object: 'checkout.session', mode: 'payment', payment_status: 'paid', status: 'complete', client_reference_id: junkSub.id, payment_intent: 'pi_e7_3' });
  const e7ledgerCount = (await ledger('SPARK')).entries.length;
  await webhook('charge.refunded', { payment_intent: 'pi_e7_3', refunded: true });
  expect('E7 clawback of an uncommissioned sub is a no-op', (await ledger('SPARK')).entries.length, e7ledgerCount);

  // ------------------------------------------------------------------
  // E8: disabled creator — attribution stops, lookup hides, re-enable restores
  // ------------------------------------------------------------------
  await buy('crejunk', 'sapling'); // unattributed user pays; SPARK earns nothing from them
  const e8before = await creatorRow('SPARK');
  expect('E8 disable toggle', (await asOwner('DELETE', '/api/admin/creators/SPARK')).status, 200);
  expect('E8 status disabled', (await creatorRow('SPARK')).status, 'disabled');
  await signup('creafter1', { ref: 'SPARK' });
  const after1 = await me('creafter1');
  expect('E8 disabled ref resolves other', after1.ref, 'other');
  expect('E8 no creatorCode stamped', after1.creatorCode, null);
  expect('E8 existing stats unchanged', JSON.stringify((await creatorRow('SPARK')).stats), JSON.stringify(e8before.stats));
  // The disabled creator's viewer promo must be inactive (deactivated by the toggle).
  const lookupDisabled = await (await fetch(B0 + '/api/creators/lookup?code=SPARK')).json();
  expect('E8 lookup of a disabled code is found:false', lookupDisabled.found, false);
  // A payment from an already-attributed user while disabled earns nothing new.
  await buy('cretier6', 'oak');
  const midRow = await creatorRow('SPARK');
  expect('E8 commission for an existing referral while disabled: none', midRow.stats.earnedCents, e8before.stats.earnedCents);
  expect('E8 re-enable', (await asOwner('DELETE', '/api/admin/creators/SPARK')).status, 200);
  expect('E8 status active again', (await creatorRow('SPARK')).status, 'active');
  await signup('creafter2', { ref: 'SPARK' });
  expect('E8 attribution restored for new signups', (await me('creafter2')).creatorCode, 'SPARK');

  // ------------------------------------------------------------------
  // E9: public lookup — aggregates only, found:false for unknown AND disabled
  // ------------------------------------------------------------------
  expect('E9 lookup is public (200, any signed-in actor)', (await asUser('creafter2', 'GET', '/api/creators/lookup?code=SPARK')).status, 200);
  const lk = (await asUser('creafter2', 'GET', '/api/creators/lookup?code=spark')).data; // any case
  expect('E9 lookup found', lk.found, true);
  expect('E9 lookup exposes the code', lk.code, 'SPARK');
  expect('E9 lookup exposes the tier', lk.tier.id, 'gold');
  // Privacy (CREATORS-T16, daniel): the public shape carries NO money of any kind — no balance,
  // no paid-out total, no ledger amounts, no payout hint. Only /api/creators/me does.
  expect('E9 lookup stats shape has no money', Object.keys(lk.stats).sort().join(','), 'payingReferrals,signups');
  expect('E9 no balance in the public shape', JSON.stringify(lk).includes('balanceCents'), false);
  expect('E9 no paidOut in the public shape', JSON.stringify(lk).includes('paidOutCents'), false);
  expect('E9 no amounts in the public shape', JSON.stringify(lk).includes('amountCents'), false);
  expect('E9 no payout hint in the public shape', JSON.stringify(lk).includes('payoutHint'), false);
  expect('E9 no recent ledger in the public shape', lk.recent, undefined);
  expect('E9 no usernames in the public shape', JSON.stringify(lk).includes('crecust1'), false);
  expect('E9 no ledger detail in the public shape', JSON.stringify(lk).includes('subId'), false);
  expect('E9 creator without a viewer code shows none', lk.viewerCode, null);
  const unknown = await (await fetch(B0 + '/api/creators/lookup?code=NOTACODE')).json();
  expect('E9 unknown -> found:false', unknown.found, false);
  // E9c (CREATORS-T16): the money-bearing endpoint is session-tied, never code-tied.
  expect('E9c /api/creators/me signed-out -> 401', (await call('nobody', 'GET', '/api/creators/me')).status, 401);
  const meCreator = (await asUser('creafter2', 'GET', '/api/creators/me')).data;
  expect('E9c signed-in referred account -> full data', meCreator.found, true);
  expect('E9c me exposes the code', meCreator.code, 'SPARK');
  expect('E9c me exposes the balance', typeof meCreator.stats.balanceCents, 'number');
  expect('E9c me exposes paid out', typeof meCreator.stats.paidOutCents, 'number');
  expect('E9c me exposes recent ledger', Array.isArray(meCreator.recent), true);
  expect('E9c me carries the payout hint (promotion@)', (meCreator.payoutHint || '').includes('promotion@treehost.online'), true);
  expect('E9c me exposes nextTier', meCreator.stats.nextTier, null); // gold is the top tier
  // A signed-in account WITHOUT a creatorCode must never see anyone's earnings: { found:false },
  // same shape as a disabled code — and definitely not the SPARK data it could guess by code.
  const meOther = (await asUser('creowner', 'GET', '/api/creators/me')).data;
  expect('E9c account with no creatorCode -> found:false (no leak)', JSON.stringify(meOther), '{"found":false}');

  // ------------------------------------------------------------------
  // E10: viewer discount code — discountCents recorded, commission on the discounted base,
  // no second discount source (a Stripe-side promo is not also applied)
  // ------------------------------------------------------------------
  expect('E10 admin creates a viewer-code creator', (await asOwner('POST', '/api/admin/creators',
    { name: 'Viewy', code: 'VIEWY', viewerCode: { code: 'VIEWY10', percentOff: 10 } })).status, 200);
  // The public lookup exposes the viewer code with its percent (spec E15's publicPromo surface).
  const lkV = (await asUser('creafter2', 'GET', '/api/creators/lookup?code=VIEWY')).data;
  expect('E10 lookup exposes the viewer code percent', lkV.viewerCode && lkV.viewerCode.percentOff, 10);
  expect('E10 lookup flags the viewer code active', lkV.viewerCode && lkV.viewerCode.active, true);
  await signup('creviewer', { ref: 'VIEWY' });
  const disc = await buy('creviewer', 'oak', { viewerCode: 'viewy10' }); // raw any-case, like a browser
  expect('E10 sub records percentOff', disc.percentOff, 10);
  expect('E10 sub records discountCents', disc.discountCents, 90);
  expect('E10 sub records promoCode', disc.promoCode, 'VIEWY10');
  expect('E10 list price untouched', disc.priceCents, 900);
  const vEntry = (await commissionsFor('VIEWY', disc.id))[0];
  expect('E10 commission on the discounted base (810 x 10%)', vEntry.amountCents, 81);
  expect('E10 ledger shows the discount it was computed from', vEntry.detail.discountCents, 90);
  // One discount source: the Stripe session is priced with the code already in the line item and
  // allow_promotion_codes stays off for it. In demo mode the same rule is proven at the boundary:
  // a free-plan promo code is refused at checkout (it would be a second discount source)…
  await asOwner('POST', '/api/admin/promos', { code: 'FREEOAK', planId: 'oak', days: 30, maxUses: 5 });
  const free = await call('creviewer', 'POST', '/api/billing/checkout', { planId: 'oak', consent, viewerCode: 'FREEOAK' });
  expect('E10 free-plan code at checkout -> 400 FREE_PLAN_CODE', free.status, 400);
  expect('E10 error code routes back to the redeem box', free.data.code, 'FREE_PLAN_CODE');
  // …and a dead percent-off code never starts a discounted checkout (no sub is created).
  const dead = await call('creviewer', 'POST', '/api/billing/checkout', { planId: 'oak', consent, viewerCode: 'NOTREAL1' });
  expect('E10 unknown viewer code -> 400 DISCOUNT_CODE', dead.status, 400);
  expect('E10 error code lets the UI continue at full price', dead.data.code, 'DISCOUNT_CODE');
  const badSubs = (await call('creviewer', 'GET', '/api/billing')).data.subscriptions.filter((s) => s.status === 'pending');
  expect('E10 rejected code created no pending sub', badSubs.length, 0);
  // The percent-off code itself is NOT redeemable for a free plan (the reverse direction).
  const redeem = await call('creviewer', 'POST', '/api/billing/redeem', { code: 'VIEWY10' });
  expect('E10 redeeming a discount code -> 400 DISCOUNT_CODE', redeem.status, 400);
  expect('E10 redeem error code', redeem.data.code, 'DISCOUNT_CODE');

  // ------------------------------------------------------------------
  // E11: code collision matrix — reserved words, dup creator, promo collision: all 409
  // ------------------------------------------------------------------
  for (const w of ['discord', 'youtube', 'reddit', 'serverlist']) {
    const r = await asOwner('POST', '/api/admin/creators', { name: 'X', code: w });
    expect(`E11 reserved ${w} -> 409`, r.status, 409);
  }
  expect('E11 duplicate creator code -> 409', (await asOwner('POST', '/api/admin/creators', { name: 'X', code: 'spark' })).status, 409);
  expect('E11 creator code colliding with a promo -> 409', (await asOwner('POST', '/api/admin/creators', { name: 'X', code: 'FREEOAK' })).status, 409);
  expect('E11 viewer-code mint colliding with a promo -> 400', (await asOwner('POST', '/api/admin/creators', { name: 'X', code: 'MOONY', viewerCode: { code: 'FREEOAK', percentOff: 10 } })).status, 400);
  expect('E11 duplicate viewer code mint -> 400', (await asOwner('PUT', '/api/admin/creators/MOONY', { viewerCode: { code: 'VIEWY10', percentOff: 10 } })).status, 400);
  expect('E11 promo equal to a creator code -> 400', (await asOwner('POST', '/api/admin/promos', { code: 'VIEWY', planId: 'sapling', days: 30 })).status, 400);
  const junkCode = await asOwner('POST', '/api/admin/creators', { name: 'X', code: 'has space!' });
  expect('E11 junk code -> 400 (not silently repaired)', junkCode.status, 400);
  const shortCode = await asOwner('POST', '/api/admin/creators', { name: 'X', code: 'AB' });
  expect('E11 too-short code -> 400', shortCode.status, 400);

  // ------------------------------------------------------------------
  // E12: application form + lookup/apply rate limits (429) — one shared IP deliberately exhausted
  // ------------------------------------------------------------------
  const limitIp = { 'X-Forwarded-For': '10.13.99.99' };
  const apply = (body) => call('creapply', 'POST', '/api/creators/apply', body, limitIp);
  expect('E12 apply accepted', (await apply({ name: 'Alex Applied', handle: '@alex', platform: 'YouTube', message: 'I make SMP series' })).data.ok, true);
  expect('E12 no creator record created', await creatorRow('ALEXAPPLIED'), null);
  const notices = (await call('creowner', 'GET', '/api/staff/notices')).data.items;
  const notice = notices.find((n) => n.title === 'New creator application');
  expect('E12 staff notice logged', !!notice, true);
  expect('E12 notice lands in the people section', notice.section, 'people');
  expect('E12 names the applicant', notice.text.includes('Alex Applied'), true);
  const activity = (await call('creowner', 'GET', '/api/activity')).data;
  expect('E12 activity entry logged', activity.some((a) => /creator application/.test(a.text)), true);
  // 10 per window per IP: the 1 accepted + 9 more pass, the 11th is 429.
  for (let i = 0; i < 9; i++) await apply({ name: `A${i}`, message: 'hi' });
  const tooMany = await apply({ name: 'Late', message: 'hi' });
  expect('E12 11th apply -> 429', tooMany.status, 429);
  // Lookup limit is separate and already 1 used (E9); burn it from the same IP.
  for (let i = 0; i < 10; i++) await fetch(B0 + '/api/creators/lookup?code=SPARK', { headers: limitIp });
  const lkLimit = await fetch(B0 + '/api/creators/lookup?code=SPARK', { headers: limitIp });
  expect('E12 11th lookup -> 429', lkLimit.status, 429);
  // Other IPs are untouched: the limit is per IP, not global.
  expect('E12 other IPs still fine', (await fetch(B0 + '/api/creators/lookup?code=SPARK', { headers: { 'X-Forwarded-For': '10.13.98.98' } })).status, 200);
  // An over-long message is capped, not rejected.
  await asUser('creafter2', 'POST', '/api/creators/apply', { name: 'Capper', message: 'x'.repeat(2000) });
  expect('E12 message capped at 500', true, true);

  // ------------------------------------------------------------------
  // E13: metrics funnel — creator codes flow through the signupRef allowlist
  // ------------------------------------------------------------------
  const m = (await call('creowner', 'GET', '/api/admin/metrics')).data;
  expect('E13 signupRef counted SPARK', m.refs.SPARK >= 25, true);
  expect('E13 signupRef counted VIEWY', m.refs.VIEWY, 1);
  expect('E13 static channels unaffected', (m.refs.other || 0) >= 2, true); // junk + disabled-attribution signups
  expect('E13 beacon/pageview ref allowlist too', typeof m.refs, 'object');

  // ------------------------------------------------------------------
  // E14: commission idempotency — webhook retry path pays exactly once
  // ------------------------------------------------------------------
  await signup('crew14', { ref: 'SPARK' });
  const w14 = await buy('crew14', 'redwood');
  expect('E14 demo checkout activated once', w14.status, 'active');
  // The Stripe path for the same purchase, retried like a webhook redelivery (3x).
  for (let i = 0; i < 3; i++) {
    await webhook('checkout.session.completed', { object: 'checkout.session', mode: 'subscription', status: 'complete', client_reference_id: w14.id, subscription: `sub_stripe_e14_${i}` });
  }
  // ...and the browser-side confirm fallback shape: activate() again on an already-active sub.
  await webhook('invoice.paid', { subscription: `sub_stripe_e14_0` });
  expect('E14 exactly one commission for the sub', (await commissionsFor('SPARK', w14.id)).length, 1);
  expect('E14 commission amount is the Gold 20% of $16', (await commissionsFor('SPARK', w14.id))[0].amountCents, 320);
  expect('E14 payingReferrals grew by exactly 1', (await creatorRow('SPARK')).stats.payingReferrals, 27);

  // ------------------------------------------------------------------
  // E15: free plans never pay — a redeemed promo as a referred user posts no commission
  // ------------------------------------------------------------------
  await asOwner('POST', '/api/admin/promos', { code: 'FREEE15', planId: 'sapling', days: 30, maxUses: 5 });
  await signup('crefree15', { ref: 'SPARK' });
  const redeemed = await call('crefree15', 'POST', '/api/billing/redeem', { code: 'FREEE15' });
  expect('E15 free plan redeemed', redeemed.status, 200);
  expect('E15 sub is free', redeemed.data.free, true);
  expect('E15 no commission for the free sub', (await commissionsFor('SPARK', redeemed.data.id)).length, 0);
  const e15before = (await creatorRow('SPARK')).stats.payingReferrals;
  expect('E15 payingReferrals unchanged', e15before, 27);
  // A percent-off viewer code on a free-plan redemption is rejected earlier (E10), so the last
  // double-discount source is closed: a granted (admin) plan never fires the hook either — it is
  // born active, never pending, so activate()'s first-payment branch never runs.
  const granted = await asOwner('POST', '/api/admin/subscriptions', { userId: (await me('crefree15')).id, planId: 'oak', months: 1, note: 'E15 grant' });
  expect('E15 admin-granted plan is free + active at once', granted.data.free, true);
  expect('E15 no commission for the granted plan', (await commissionsFor('SPARK', granted.data.id)).length, 0);

  // ------------------------------------------------------------------
  // E8b/E9b (spec §11 E8/E9 remainders): edit immutability + adminList totals
  // (task E8 "code immutability" and E9 "adminList totals")
  // ------------------------------------------------------------------
  // The code is immutable: a PUT that tries to change it changes nothing, and the row keeps its id.
  const beforeEdit = await creatorRow('SPARK');
  const edited = await asOwner('PUT', '/api/admin/creators/SPARK', { name: 'Sparky Prime', code: 'HACKED', handle: '@sparky' });
  expect('E8b edit succeeds', edited.status, 200);
  expect('E8b code unchanged', edited.data.code, 'SPARK');
  expect('E8b id unchanged', edited.data.id, beforeEdit.id);
  expect('E8b name updated', edited.data.name, 'Sparky Prime');
  expect('E8b no creator called HACKED exists', await creatorRow('HACKED'), null);
  // The viewer percent is editable through the same route; the code is not.
  const vp = await asOwner('PUT', '/api/admin/creators/VIEWY', { viewerCode: { percentOff: 30 } });
  expect('E8b viewer percentOff updated', vp.data.viewerCode.percentOff, 30);
  expect('E8b viewer code itself unchanged', vp.data.viewerCode.code, 'VIEWY10');
  // adminList totals add up across every creator in the registry.
  const list = (await asOwner('GET', '/api/admin/creators')).data;
  expect('E9b totals.creators equals the row count', list.totals.creators, list.creators.length);
  expect('E9b totals.payingReferrals add up', list.totals.payingReferrals, list.creators.reduce((n, r) => n + r.stats.payingReferrals, 0));
  expect('E9b totals.earnedCents add up', list.totals.earnedCents, list.creators.reduce((n, r) => n + r.stats.earnedCents, 0));
  expect('E9b totals.balanceCents add up', list.totals.balanceCents, list.creators.reduce((n, r) => n + r.stats.balanceCents, 0));
  expect('E9b the ladder is exposed for the console', list.tiers.map((t) => t.id).join(','), 'bronze,silver,gold');
  expect('E9b SPARK row carries its nextTier hint', list.creators.find((c) => c.code === 'SPARK').tier.id, 'gold');

  // ------------------------------------------------------------------
  // E15b (task E15): publicSub/publicPromo expose percentOff
  // ------------------------------------------------------------------
  const promoList = (await call('creowner', 'GET', '/api/admin/promos')).data;
  const vpromo = promoList.find((p) => p.code === 'VIEWY10');
  expect('E15b publicPromo exposes percentOff', vpromo.percentOff, 30); // bumped to 30 in E8b
  expect('E15b publicPromo exposes it as not a plan code', vpromo.planId, null);
  const freePromo = promoList.find((p) => p.code === 'FREEE15');
  expect('E15b free-plan promo percentOff stays null', freePromo.percentOff, null);
  const mySubs = (await call('creviewer', 'GET', '/api/billing')).data.subscriptions;
  expect('E15b publicSub exposes percentOff', mySubs[0].percentOff, 10);
  expect('E15b publicSub exposes discountCents', mySubs[0].discountCents, 90);
  const plainSubs = (await call('crejunk', 'GET', '/api/billing')).data.subscriptions;
  expect('E15b full-price sub: percentOff null', plainSubs[0].percentOff, null);
  expect('E15b full-price sub: discountCents 0', plainSubs[0].discountCents, 0);

  // ------------------------------------------------------------------
  // E16 (CREATORS-T18): attach an EXISTING account to a creator
  // daniel: "someone might already have an account" — attribution normally happens only at
  // signup (applyRef); staff can credit an account that missed the link.
  // ------------------------------------------------------------------
  const sparkBefore = await creatorRow('SPARK');
  await signup('creattach1'); // signed up with NO ref
  expect('E16 starts unattributed', (await me('creattach1')).creatorCode, null);
  // Attach by USERNAME, any case.
  const a1 = await asOwner('POST', '/api/admin/creators/SPARK/attach', { username: 'CREATTACH1' });
  expect('E16 attach by username -> 200', a1.status, 200);
  expect('E16 attach returns the public shape', JSON.stringify(a1.data), '{"username":"creattach1","creatorCode":"SPARK"}');
  expect('E16 me() shows the code right away', (await me('creattach1')).creatorCode, 'SPARK');
  // The earnings panel works immediately: /api/creators/me is live for the attached account.
  const mine1 = (await asUser('creattach1', 'GET', '/api/creators/me')).data;
  expect('E16 /api/creators/me works after attach', mine1.found, true);
  expect('E16 me exposes their creator code', mine1.code, 'SPARK');
  // Attach by EMAIL, case-insensitive.
  await signup('creattach2');
  const a2 = await asOwner('POST', '/api/admin/creators/VIEWY/attach', { email: 'CREATTACH2@EXAMPLE.COM' });
  expect('E16 attach by email (any case) -> 200', a2.status, 200);
  expect('E16 email attach returns the code', a2.data.creatorCode, 'VIEWY');
  expect('E16 ref field untouched by attach', (await me('creattach2')).ref, null);
  // Guards.
  const noUser = await asOwner('POST', '/api/admin/creators/SPARK/attach', { username: 'nobody-here' });
  expect('E16 unknown user -> 404', noUser.status, 404);
  const noCode = await asOwner('POST', '/api/admin/creators/NOSUCHCODE/attach', { username: 'creattach1' });
  expect('E16 unknown creator code -> 400', noCode.status, 400);
  expect('E16 admin creates a creator to disable', (await asOwner('POST', '/api/admin/creators', { name: 'AttachD', code: 'ATTACHD' })).status, 200);
  expect('E16 disable ATTACHD', (await asOwner('DELETE', '/api/admin/creators/ATTACHD')).status, 200);
  const dis = await asOwner('POST', '/api/admin/creators/ATTACHD/attach', { username: 'creattach1' });
  expect('E16 attach to a disabled creator -> 400', dis.status, 400);
  // Switching overwrites the old attribution; money already earned stays in the old ledger.
  const sw = await asOwner('POST', '/api/admin/creators/ADMINC/attach', { username: 'creattach1' });
  expect('E16 switch creator -> 200', sw.status, 200);
  expect('E16 me() shows the new code', (await me('creattach1')).creatorCode, 'ADMINC');
  expect('E16 old creator stats untouched by the switch', JSON.stringify((await creatorRow('SPARK')).stats), JSON.stringify(sparkBefore.stats));
  // Idempotent: attaching the same creator again is fine.
  expect('E16 attach same creator again -> 200', (await asOwner('POST', '/api/admin/creators/ADMINC/attach', { username: 'creattach1' })).status, 200);
  // Earnings count from attach time on: their first payment now pays ADMINC, not SPARK.
  await buy('creattach1', 'sapling');
  const admEntry = (await commissionsFor('ADMINC', (await call('creattach1', 'GET', '/api/billing')).data.subscriptions[0].id))[0];
  expect('E16 commission goes to the NEW creator', !!admEntry, true);
  expect('E16 commission at the new creator tier (Bronze 10% x $5)', admEntry.amountCents, 50);
  expect('E16 SPARK earned nothing from the switched account', (await creatorRow('SPARK')).stats.earnedCents, sparkBefore.stats.earnedCents);
  // Remove clears the attribution; /api/creators/me goes back to found:false.
  const rm = await asOwner('POST', '/api/admin/creators/ADMINC/attach', { username: 'creattach1', remove: true });
  expect('E16 remove -> 200', rm.status, 200);
  expect('E16 remove returns a null code', rm.data.creatorCode, null);
  expect('E16 me() cleared', (await me('creattach1')).creatorCode, null);
  expect('E16 earnings panel gone after remove', (await asUser('creattach1', 'GET', '/api/creators/me')).data.found, false);
  // The audit line records the attach (and the switch's "past earnings stay" note).
  const audit16 = (await asOwner('GET', '/api/admin/audit')).data;
  expect('E16 audit line for the attach', audit16.some((a) => a.text.includes('attached creattach1 to creator ADMINC')), true);
  expect('E16 audit line notes past money stays', audit16.some((a) => /attached creattach1 to creator ADMINC \(was SPARK/.test(a.text)), true);
};
