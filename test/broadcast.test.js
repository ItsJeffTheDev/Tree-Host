'use strict';
// Unit tests for the broadcast-email feature (node --test, zero deps).
// Run: node --test test/broadcast.test.js
//
// Covers mail.js from-allowlist validation and the broadcast route rules, which are pure helpers
// exercised through a real server (see broadcast.e2e.js for the live probe against HTTP).

process.env.TREEHOST_RESEND_API = 'http://127.0.0.1:1/emails'; // any send attempt fails fast, never hits Resend
process.env.RESEND_API_KEY = 're_test_stub'; // so send() gets as far as the allowlist / the fetch

const test = require('node:test');
const assert = require('node:assert/strict');
const mail = require('../src/mail');

// ---------- mail.senders() / allowedFrom ----------

test('senders() lists the Tree Host allowlist', () => {
  const addresses = mail.senders().map((s) => s.address);
  assert.deepEqual([...addresses].sort(), ['billing@treehost.online', 'dmca@treehost.online', 'no-reply@treehost.online', 'promotion@treehost.online', 'support@treehost.online'].sort());
  for (const s of mail.senders()) assert.ok(s.label, `label for ${s.address}`);
});

test('allowedFrom(): allowlisted addresses pass, everything else is refused', () => {
  assert.equal(mail.allowedFrom('promotion@treehost.online'), 'Tree Host <promotion@treehost.online>');
  assert.equal(mail.allowedFrom('  Support@TreeHost.Online '), 'Tree Host <support@treehost.online>');
  assert.equal(mail.allowedFrom('evil@attacker.com'), null);
  assert.equal(mail.allowedFrom('support@treehost.online.evil.com'), null);
  assert.equal(mail.allowedFrom(''), null);
  assert.equal(mail.allowedFrom(undefined), null);
  assert.equal(mail.allowedFrom('Tree Host <support@treehost.online>'), null); // bare address only
});

// ---------- mail.send() with a from override ----------

test('send() throws for a non-allowlisted from before doing anything', async () => {
  await assert.rejects(() => mail.send('a@b.co', 'Hi', ['x'], null, { from: 'nope@attacker.com' }), /allowed sending address/);
  // Without an override, no validation error (fails later on the fetch, which we point at a dead port).
  await assert.rejects(() => mail.send('a@b.co', 'Hi', ['x']), /fetch failed|ECONNREFUSED|EADDRNOTAVAIL/);
});

test('send() with no key or no recipient is a no-op, override or not', async () => {
  const wasKey = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  delete require.cache[require.resolve('../src/mail')];
  const noKey = require('../src/mail');
  assert.equal(await noKey.send('a@b.co', 'Hi', ['x'], null, { from: 'evil@x.com' }), false);
  assert.equal(await noKey.send('', 'Hi', ['x']), false);
  process.env.RESEND_API_KEY = wasKey || '';
});
