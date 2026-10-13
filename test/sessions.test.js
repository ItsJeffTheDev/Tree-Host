'use strict';
// Unit tests for the session-management work (src/auth.js): listSessions / revokeSession /
// revokeOtherSessions / sliding renewal in userFromSession. No server, no disk.
//   node --test test/sessions.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Auth } = require('../src/auth');
const totp = require('../src/totp');

const DAY = 86400000;
const HOUR = 3600000;
const hashOf = (t) => crypto.createHash('sha256').update(t).digest('hex');

// A quiet Auth: no disk writes, no rate limiting in the way.
function freshAuth() {
  const auth = new Auth();
  auth.users = [];
  auth.save = () => Promise.resolve();
  auth.saveSessions = () => Promise.resolve();
  auth.settings.allowSignup = true;
  return auth;
}

const signup = async (auth, username) =>
  (await auth.signup({ username, email: `${username}@example.com`, password: 'correct horse battery', acceptTerms: true, birthYear: 2000 }, '203.0.113.7')).user;

/** signup mints a session of its own; these tests mint theirs, so drop the signup one. */
const signupBare = async (auth, username) => {
  const user = await signup(auth, username);
  for (const [hash, s] of auth.sessions) if (s.userId === user.id) auth.sessions.delete(hash);
  return user;
};

/** The stored session record for a cookie token (signup also mints a session, so never use values()[0]). */
const sessOf = (auth, token) => auth.sessions.get(hashOf(token));

test('createSession stamps createdAt and lastSeen alongside expires', async () => {
  const auth = freshAuth();
  const user = await signup(auth, 'alice');
  const token = await auth.createSession(user);
  const s = sessOf(auth, token);
  assert.ok(s.createdAt > 0 && s.lastSeen > 0);
  assert.equal(s.expires - s.createdAt, 30 * DAY);
  assert.ok(s.expires > Date.now() + 29 * DAY);
});

test('userFromSession updates lastSeen (in memory, cheap)', async () => {
  const auth = freshAuth();
  const user = await signup(auth, 'alice');
  const token = await auth.createSession(user);
  const s = sessOf(auth, token);
  s.lastSeen = Date.now() - 5000;
  assert.equal(auth.userFromSession(token).username, 'alice');
  assert.ok(s.lastSeen >= Date.now() - 1000);
});

test('sliding renewal: a session past half its TTL is extended by a fresh 30 days', async () => {
  const auth = freshAuth();
  const user = await signup(auth, 'alice');
  const token = await auth.createSession(user);
  const s = sessOf(auth, token);
  s.createdAt = Date.now() - 2 * HOUR; // older than the one-hour save throttle
  s.expires = Date.now() + 13 * DAY; // past half of the 30-day TTL, still valid
  const before = Date.now();
  assert.equal(auth.userFromSession(token).username, 'alice'); // never logged out
  assert.ok(s.expires >= before + 30 * DAY - 1000, 'expires renewed to a fresh 30 days');
  assert.equal(auth.renewedSession(token).token, token); // the cookie gets re-issued on GET /api/auth/me
});

test('sliding renewal: a young session (well inside its TTL) is not touched', async () => {
  const auth = freshAuth();
  const user = await signup(auth, 'alice');
  const token = await auth.createSession(user);
  const s = sessOf(auth, token);
  s.createdAt = Date.now() - 2 * HOUR;
  const before = s.expires;
  auth.userFromSession(token);
  assert.equal(s.expires, before);
  assert.equal(auth.renewedSession(token), null);
});

test('sliding renewal: throttled to once an hour', async () => {
  const auth = freshAuth();
  const user = await signup(auth, 'alice');
  const token = await auth.createSession(user);
  const s = sessOf(auth, token);
  s.createdAt = Date.now() - 2 * HOUR;
  s.expires = Date.now() + 13 * DAY;
  auth.userFromSession(token);
  assert.ok(auth.renewedSession(token));
  const afterFirst = s.expires;
  s.expires = Date.now() + 10 * DAY; // ages past half TTL again right away
  s.lastSavedAt = Date.now(); // but we just saved: within the hour
  const before = s.expires;
  auth.userFromSession(token);
  assert.equal(s.expires, before, 'no second renewal inside the throttle window');
  assert.ok(afterFirst > Date.now() + 29 * DAY);
});

test('sliding renewal: a failed save never logs the user out', async () => {
  const auth = freshAuth();
  const user = await signup(auth, 'alice');
  const token = await auth.createSession(user); // while saving still works
  auth.saveSessions = () => Promise.reject(new Error('disk full')); // then the disk dies
  const s = sessOf(auth, token);
  s.createdAt = Date.now() - 2 * HOUR;
  s.expires = Date.now() + 13 * DAY;
  assert.equal(auth.userFromSession(token).username, 'alice');
  assert.ok(s.expires > Date.now() + 29 * DAY, 'renewal still applied in memory');
});

test('2FA plays no part in session validity or renewal', async () => {
  const auth = freshAuth();
  const user = await signup(auth, 'alice');
  await auth.startTwoFactor(user);
  await auth.enableTwoFactor(user, totp.codeAt(user.mfaPending.secret, Math.floor(Date.now() / 30000)));
  assert.equal(user.mfa.on, true);
  const token = await auth.createSession(user);
  const s = sessOf(auth, token);
  s.createdAt = Date.now() - 2 * HOUR;
  s.expires = Date.now() + 13 * DAY;
  // No code passed anywhere: a valid session cookie is enough, renewal included.
  assert.equal(auth.userFromSession(token).username, 'alice');
  assert.ok(s.expires > Date.now() + 29 * DAY);
  assert.ok(auth.renewedSession(token));
});

test('listSessions: only this account, valid ones, current flagged, ids are short hashes', async () => {
  const auth = freshAuth();
  const alice = await signupBare(auth, 'alice');
  const bob = await signupBare(auth, 'bob');
  const t1 = await auth.createSession(alice);
  const t2 = await auth.createSession(alice);
  await auth.createSession(bob);
  const t3 = await auth.createSession(alice);
  sessOf(auth, t3).expires = Date.now() - 1000; // expired
  const list = auth.listSessions(alice, hashOf(t2));
  assert.equal(list.length, 2);
  assert.ok(list.find((s) => s.current).id && hashOf(t2).startsWith(list.find((s) => s.current).id));
  assert.ok(list.every((s) => s.createdAt > 0 && s.lastSeen > 0 && /^[0-9a-f]{12}$/.test(s.id)));
  assert.equal(auth.listSessions(bob).length, 1);
  assert.equal(auth.listSessions(bob).find((s) => s.current), undefined, 'no current without a current hash');
});

test('revokeSession: by short id, only this account, unknown id returns false', async () => {
  const auth = freshAuth();
  const alice = await signupBare(auth, 'alice');
  const bob = await signupBare(auth, 'bob');
  const ta = await auth.createSession(alice);
  const tb = await auth.createSession(bob);
  assert.equal(await auth.revokeSession(alice, 'zzzz'), false);
  assert.equal(await auth.revokeSession(alice, hashOf(ta).slice(0, 12)), true);
  assert.equal(auth.userFromSession(ta), null, 'alice session dead');
  assert.notEqual(auth.userFromSession(tb), null, 'bob session untouched');
  // A short id that matches another account's session is still refused.
  assert.equal(await auth.revokeSession(alice, hashOf(tb).slice(0, 12)), false);
});

test('revokeOtherSessions: keeps the current one, kills the rest, returns the count', async () => {
  const auth = freshAuth();
  const alice = await signupBare(auth, 'alice');
  const t1 = await auth.createSession(alice);
  const t2 = await auth.createSession(alice);
  const t3 = await auth.createSession(alice);
  const tb = await auth.createSession(await signupBare(auth, 'bob'));
  assert.equal(await auth.revokeOtherSessions(alice, hashOf(t2)), 2);
  assert.notEqual(auth.userFromSession(t2), null, 'current kept');
  assert.equal(auth.userFromSession(t1), null);
  assert.equal(auth.userFromSession(t3), null);
  assert.notEqual(auth.userFromSession(tb), null, "bob's session untouched");
});

test('sessions survive a restart-shaped reload (expiry filter keeps valid ones)', async () => {
  const auth = freshAuth();
  const alice = await signup(auth, 'alice');
  const t1 = await auth.createSession(alice);
  const t2 = await auth.createSession(alice);
  sessOf(auth, t2).expires = Date.now() - 1000;
  const auth2 = freshAuth();
  auth2.users = auth.users; // same accounts, fresh process
  for (const [hash, s] of auth.sessions) if (s.expires > Date.now()) auth2.sessions.set(hash, s);
  assert.notEqual(auth2.userFromSession(t1), null, 'valid session survives');
  assert.equal(auth2.userFromSession(t2), null, 'expired session dropped');
});
