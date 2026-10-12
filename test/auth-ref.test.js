'use strict';
// Tests for ?ref= capture on signup (TASK-004-003). Zero deps.
//   Unit: node --test test/auth-ref.test.js          (refValue sanitization + persistence, no server)
//   E2E:  start a fresh demo site first, then it runs too:
//     TREEHOST_PUBLIC_URL=http://localhost:8799 TREEHOST_PORT=8799 BILLING_DEMO=1 TREEHOST_DATA=/tmp/th-test node src/server.js &
//     node test/auth-ref.test.js
// The e2e half asserts the full flow: signup with ?ref-style body → GET /api/auth/me shows ref.

const test = require('node:test');
const assert = require('node:assert/strict');
const { refValue } = require('../src/metrics');
const { Auth } = require('../src/auth');

// ----- unit: the allowlist (shared with the page-view beacon) -----

test('allowlist: discord/youtube/reddit/serverlist kept verbatim', () => {
  for (const r of ['discord', 'youtube', 'reddit', 'serverlist']) assert.equal(refValue(r), r);
  // case + whitespace tolerated
  assert.equal(refValue(' YouTube '), 'youtube');
  assert.equal(refValue('DISCORD'), 'discord');
});

test('allowlist: any other non-empty value becomes other', () => {
  assert.equal(refValue('<script>'), 'other');
  assert.equal(refValue('tiktok'), 'other');
  assert.equal(refValue('"; DROP TABLE users'), 'other');
  assert.equal(refValue(12345), 'other');
  assert.equal(refValue({ a: 1 }), 'other');
});

test('allowlist: absent or empty ref is null (never recorded)', () => {
  assert.equal(refValue(undefined), null);
  assert.equal(refValue(null), null);
  assert.equal(refValue(''), null);
  assert.equal(refValue('   '), null);
});

// ----- unit: signup persists ref and never fails on a bad one -----

// A quiet Auth: no disk, no rate limiting getting in the way of repeated signups.
function freshAuth() {
  const auth = new Auth();
  auth.users = [];
  auth.save = () => Promise.resolve();
  auth.saveSessions = () => Promise.resolve();
  auth.settings.allowSignup = true;
  return auth;
}
const signupBody = (ref) => ({
  username: 'steve' + Math.floor(Math.random() * 1e9),
  password: 'correct horse battery',
  email: 'steve' + Math.floor(Math.random() * 1e9) + '@example.com',
  acceptTerms: true,
  birthYear: 2000,
  ...(ref === undefined ? {} : { ref }),
});

test('signup: youtube persisted verbatim', async () => {
  const auth = freshAuth();
  const { user } = await auth.signup(signupBody('youtube'), '203.0.113.7');
  assert.equal(user.ref, 'youtube');
});

test('signup: <script> sanitized to other (and nothing throws)', async () => {
  const auth = freshAuth();
  const { user } = await auth.signup(signupBody('<script>alert(1)</script>'), '203.0.113.8');
  assert.equal(user.ref, 'other');
  assert.equal(user.username.includes('<'), false);
});

test('signup: missing ref stored as null', async () => {
  const auth = freshAuth();
  const { user } = await auth.signup(signupBody(), '203.0.113.9');
  assert.equal(user.ref, null);
});

test('signup: empty-string ref stored as null', async () => {
  const auth = freshAuth();
  const { user } = await auth.signup(signupBody('   '), '203.0.113.10');
  assert.equal(user.ref, null);
});

test('signup never fails on any ref value (junk, objects, huge strings)', async () => {
  const auth = freshAuth();
  for (const ref of ['<script>', 'x'.repeat(5000), { evil: true }, ['discord'], 42, true, 'discord; drop']) {
    const { user } = await auth.signup(signupBody(ref), '203.0.113.11');
    assert.ok(['discord', 'youtube', 'reddit', 'serverlist', 'other', null].includes(user.ref), `ref ${JSON.stringify(ref)} → ${user.ref}`);
  }
});

test('publicUser exposes ref (what GET /api/auth/me returns)', async () => {
  const auth = freshAuth();
  const { user } = await auth.signup(signupBody('discord'), '203.0.113.12');
  assert.equal(auth.publicUser(user).ref, 'discord');
  const { user: bare } = await auth.signup(signupBody(), '203.0.113.13');
  assert.equal(auth.publicUser(bare).ref, null);
});

// ----- e2e: the full flow against a running demo site (skipped when none is up) -----

const B = process.env.TREEHOST_TEST_URL;
if (B) {
  let cookie = null;
  const call = async (method, p, body) => {
    const res = await fetch(B + p, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: B, ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const session = res.headers.getSetCookie().find((c) => c.startsWith('th_session='));
    if (session) cookie = session.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
  };

  test('e2e: signup with ref=discord → GET /api/auth/me shows ref: discord', async () => {
    const u = 'e2eref' + Date.now();
    const su = await call('POST', '/api/auth/signup', {
      username: u, password: 'correct horse battery', email: 'e2e' + Date.now() + '@example.com', acceptTerms: true, birthYear: 2000, ref: 'discord',
    });
    assert.equal(su.status, 200);
    const me = await call('GET', '/api/auth/me');
    assert.equal(me.data.user.username, u);
    assert.equal(me.data.user.ref, 'discord');
  });

  test('e2e: signup with a bad ref still succeeds (me shows other)', async () => {
    const u = 'e2ebad' + Date.now();
    const su = await call('POST', '/api/auth/signup', {
      username: u, password: 'correct horse battery', email: 'e2ebad' + Date.now() + '@example.com', acceptTerms: true, birthYear: 2000, ref: '<script>',
    });
    assert.equal(su.status, 200);
    const me = await call('GET', '/api/auth/me');
    assert.equal(me.data.user.ref, 'other');
  });

  test('e2e: page-view beacon accepted (204) and carries a ref', async () => {
    const res = await fetch(B + '/api/metrics/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: B, 'User-Agent': 'Mozilla/5.0 e2e' },
      body: JSON.stringify({ type: 'pageview', path: '/pricing', referrerHost: 'discord.com', ref: 'youtube' }),
    });
    assert.equal(res.status, 204);
  });
} else {
  test('e2e skipped (set TREEHOST_TEST_URL to a running demo site)', () => assert.ok(true));
}
