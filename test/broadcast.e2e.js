'use strict';
// Live probe of the broadcast-email feature against a real Tree Host server with a fake Resend.
// The fake Resend is a tiny HTTP server this script starts; Tree Host is pointed at it with
// TREEHOST_RESEND_API, so sends run the real mail.send() code path and land here, where we count them.
// Start Tree Host first, then:
//   TREEHOST_TEST_URL=http://localhost:8799 node test/broadcast.e2e.js
// Tree Host itself was started like (fresh data folder):
//   TREEHOST_PUBLIC_URL=http://localhost:8799 TREEHOST_PORT=8799 BILLING_DEMO=1 \
//   TREEHOST_RESEND_API=http://127.0.0.1:8797/emails RESEND_API_KEY=re_test_stub \
//   TREEHOST_DATA=/tmp/th-bcast TREEHOST_TEST_SITE=1 node src/server.js &
// With RESEND_API_KEY unset instead, the probe checks the clean "emails are off" errors (run it a second
// time with TREEHOST_BCAST_OFF=1 against a key-less server). Exits non-zero on any failure.
const http = require('http');
const B = process.env.TREEHOST_TEST_URL || 'http://localhost:8799';
const FAKE_PORT = Number(process.env.TREEHOST_FAKE_RESEND_PORT) || 8797;
const OFF = !!process.env.TREEHOST_BCAST_OFF;
const received = []; // every email the fake Resend accepted
let fails = 0, passes = 0;
const ok = (label, got, want) => {
  const good = Array.isArray(got) && Array.isArray(want) ? JSON.stringify(got) === JSON.stringify(want) : Array.isArray(want) ? want.includes(got) : got === want;
  good ? passes++ : fails++;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(got)}${good ? '' : `, wanted ${JSON.stringify(want)}`}`);
  return good;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jar = {};
async function call(who, method, path, body) {
  const res = await fetch(B + path, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: B, ...(jar[who] ? { Cookie: jar[who] } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const session = res.headers.getSetCookie().find((c) => c.startsWith('th_session='));
  if (session) jar[who] = session.split(';')[0];
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

/** The fake Resend: records every accepted send, fails addresses containing 'bounce'. */
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try {
      const mail = JSON.parse(body);
      const to = (mail.to || [])[0] || '';
      if (/bounce/.test(to)) { res.writeHead(422, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: 'mailbox not found' })); return; }
      received.push({ from: mail.from, to, subject: mail.subject });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'fake-' + received.length }));
    } catch (e) { res.writeHead(400).end('bad json'); }
  });
});

(async () => {
  if (!OFF) {
    await new Promise((r) => fake.listen(FAKE_PORT, '127.0.0.1', r));
    console.log(`(fake Resend on :${FAKE_PORT})`);
  }

  // Sign in as the owner (first account made on a local test site is the Owner).
  const owner = await call('owner', 'POST', '/api/auth/login', { username: 'bcowner', password: 'TreeHost-test-123' });
  ok('owner signs in', owner.status, 200);

  // Not signed in: every broadcast route wants a login.
  const saved = jar.owner; delete jar.owner;
  ok('GET broadcast without login is 401', (await call('anon', 'GET', '/api/admin/broadcast')).status, 401);
  ok('send without login is 401', (await call('anon', 'POST', '/api/admin/broadcast/send', { confirm: true })).status, 401);
  jar.owner = saved;

  if (OFF) {
    // Emails are off (no RESEND_API_KEY): every path answers with a clean, non-crashing error.
    const meta = await call('owner', 'GET', '/api/admin/broadcast');
    ok('meta answers with enabled:false', meta.status === 200 && meta.data.enabled === false, true);
    const pv = await call('owner', 'POST', '/api/admin/broadcast/preview', { from: 'support@treehost.online', subject: 'Hi', body: 'Hello' });
    ok('preview still renders with mail off (200 html)', pv.status === 200, true);
    const noConfirm = await call('owner', 'POST', '/api/admin/broadcast/send', { from: 'support@treehost.online', subject: 'Hi', body: 'Hello', audience: 'manual', emails: 'a@b.co' });
    ok('no confirm → 400 before the mail check', noConfirm.status === 400 && /confirm/i.test(noConfirm.data.error || ''), true);
    const send = await call('owner', 'POST', '/api/admin/broadcast/send', { from: 'support@treehost.online', subject: 'Hi', body: 'Hello', audience: 'manual', emails: 'a@b.co', confirm: true });
    ok('send with mail off → 400, clean message', send.status === 400 && /RESEND_API_KEY/.test(String((send.data || {}).error || "")), true);
    console.log(`\n${passes} passed, ${fails} failed (mail-disabled run)`);
    process.exit(fails ? 1 : 0);
  }

  const meta = await call('owner', 'GET', '/api/admin/broadcast');
  ok('meta: enabled', meta.status === 200 && meta.data.enabled === true, true);
  ok('meta: allowlist has the five Tree Host senders', meta.data.fromOptions.length === 5 &&
    meta.data.fromOptions.some((o) => o.address === 'promotion@treehost.online'), true);
  ok('meta: count is a number', typeof meta.data.count === 'number', true);
  const countAtStart = meta.data.count;

  // Preview renders the real branded email (over HTTP, like the email console does).
  const pv = await fetch(B + '/api/admin/broadcast/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: B, Cookie: jar.owner },
    body: JSON.stringify({ from: 'promotion@treehost.online', subject: 'Summer sale', body: 'First **bold** line\n\nSecond <script>alert(1)</script> line', button: { text: 'See plans', url: 'https://treehost.online/pricing' } }),
  });
  const pvHtml = await pv.text();
  ok('preview is html', pv.status === 200 && /<!doctype html/i.test(pvHtml), true);
  ok('preview subject in the title', pvHtml.includes('Summer sale'), true);
  ok('preview bold rendered', pvHtml.includes('<strong>bold</strong>'), true);
  ok('preview escapes html in the body', !pvHtml.includes('<script>alert(1)</script>') && pvHtml.includes('&lt;script&gt;'), true);
  ok('preview has the button', pvHtml.includes('See plans') && pvHtml.includes('https://treehost.online/pricing'), true);

  // Validation on send: bad from, no confirm, junk emails, oversize, bad button, bad audience.
  const good = { from: 'support@treehost.online', subject: 'Test', body: 'Hello everyone', audience: 'manual', emails: '' };
  const trySend = async (over) => call('owner', 'POST', '/api/admin/broadcast/send', { ...good, ...over });
  ok('bad from → 400', (await trySend({ from: 'evil@attacker.com', emails: 'a@b.co', confirm: true })).status, 400);
  ok('no confirm → 400', (await trySend({ emails: 'a@b.co' })).status, 400);
  ok('bad email → 400', (await trySend({ emails: 'a@b.co\nnot-an-email', confirm: true })).status, 400);
  ok('empty email list → 400', (await trySend({ emails: '   ', confirm: true })).status, 400);
  ok('over cap → 400', (await trySend({ emails: Array.from({ length: 2001 }, (_, i) => `u${i}@x.co`).join('\n'), confirm: true })).status, 400);
  ok('oversize subject → 400', (await trySend({ subject: 'x'.repeat(121), emails: 'a@b.co', confirm: true })).status, 400);
  ok('oversize body → 400', (await trySend({ body: 'x'.repeat(5001), emails: 'a@b.co', confirm: true })).status, 400);
  ok('button without http → 400', (await trySend({ button: { text: 'Go', url: 'javascript:alert(1)' }, emails: 'a@b.co', confirm: true })).status, 400);
  ok('unknown audience → 400', (await trySend({ audience: 'everyone', confirm: true })).status, 400);
  ok('nothing was sent by any of those', received.length, 0);

  // Manual audience: dedupe, mixed separators, one deliberately failing address.
  const before = received.length;
  const manual = await trySend({
    audience: 'manual',
    emails: 'Manual1@Example.com, manual1@example.com\nsecond@example.com ; bounce@example.com, third@example.com',
    subject: 'Manual hello',
    confirm: true,
  });
  ok('manual send accepted', manual.status, 200);
  ok('manual send deduped + counted', [manual.data.total, manual.data.sent, manual.data.failed.length], [4, 3, 1]);
  ok('the failure is the address the fake Resend rejects', [manual.data.failed[0].email, /mailbox/.test(manual.data.failed[0].error)], ['bounce@example.com', true]);
  await sleep(300);
  const got = received.slice(before);
  ok('fake Resend got 3 sends (4 recipients, 1 rejected, dedupe collapsed one)', got.length, 3);
  ok('sent from the chosen allowlisted address', got.map((m) => m.from).every((f) => f === 'Tree Host <support@treehost.online>'), true);
  ok('subject travels', got.map((m) => m.subject).every((x) => x === 'Manual hello'), true);

  // Signed-up audience: every account with an email (owner + the 3 we sign up below), plus junk skipped.
  const emails = ['alice@example.com', 'bob@example.com', 'carol@example.com'];
  for (const [i, email] of emails.entries()) {
    const r = await call(`c${i}`, 'POST', '/api/auth/signup', { username: `bccust${i}`, email, password: 'TreeHost-test-123', acceptTerms: true, birthYear: 1995 });
    if (r.status !== 200) { ok(`signup ${email}`, false, JSON.stringify(r.data)); continue; }
    jar[`c${i}`] = ''; // sign out: drop the cookie so the next signup doesn't switch account
  }
  const meta2 = await call('owner', 'GET', '/api/admin/broadcast');
  ok('count grew by the 3 signups', meta2.data.count, countAtStart + 3);
  const before2 = received.length;
  const blast = await trySend({ audience: 'signedup', from: 'billing@treehost.online', subject: 'Everyone hello', confirm: true });
  ok('signedup send accepted', blast.status, 200);
  ok('signedup sent to every account with an email (owner + 3)', blast.data.sent, countAtStart + 3);
  ok('nobody failed or was skipped', [blast.data.failed.length, blast.data.skipped], [0, 0]);
  await sleep(300);
  const got2 = received.slice(before2);
  ok('fake Resend got them all', got2.length, countAtStart + 3);
  ok('signedup blast used the billing address', got2.map((m) => m.from).every((f) => f === 'Tree Host <billing@treehost.online>'), true);
  ok('new customers were among the recipients', got2.map((m) => m.to).includes('carol@example.com'), true);

  // A non-owner staff account is refused (settings.manage is owner/admin only; default Support lacks it).
  const staff = await call('staff', 'POST', '/api/auth/signup', { username: 'bcstaff', email: 'staff@example.com', password: 'TreeHost-test-123', acceptTerms: true, birthYear: 1995 });
  ok('staff signup', staff.status === 200, true);
  const staffId = (await call('owner', 'GET', '/api/team/users')).data.find((u) => u.username === 'bcstaff').id;
  const promote = await call('owner', 'PUT', `/api/team/users/${staffId}/role`, { role: 'staff' });
  if (promote.status === 200) {
    ok('broadcast blocked for plain staff', (await call('staff', 'POST', '/api/admin/broadcast/send', { ...good, emails: 'a@b.co', confirm: true })).status, 403);
    ok('broadcast meta blocked for plain staff', (await call('staff', 'GET', '/api/admin/broadcast')).status, 403);
  } else console.log(`NOTE  could not promote a staff account (${promote.status}: ${promote.data && promote.data.error}), skipped the 403 checks`);

  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
