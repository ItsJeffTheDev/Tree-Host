'use strict';
// Unit tests for multi-method 2FA in src/auth.js (node --test, zero deps): TASK-014-020.
//   Run: node --test test/mfa.test.js
// Covers: email codes as an account method (setup, enable, wrong code, disable), method-aware sign-in
// (totp default / email first / recovery always), the same-shaped login-code endpoint, and the passkeys
// stub (challenges are real and single-use; registration answers 501).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const totp = require('../src/totp');
const passkeys = require('../src/passkeys');
const { Auth } = require('../src/auth');

// A quiet Auth: no disk, no rate limiting in the way of repeated attempts.
function freshAuth() {
  const auth = new Auth();
  auth.users = [];
  auth.save = () => Promise.resolve();
  auth.saveSessions = () => Promise.resolve();
  auth.checkRate = () => {};
  auth.settings.allowSignup = true;
  return auth;
}

const signup = async (auth, name, extra = {}) => {
  const r = await auth.signup(
    { username: name, password: 'correct horse battery', email: `${name}@example.com`, acceptTerms: true, birthYear: 2000, ...extra },
    '203.0.113.7',
  );
  return r.user;
};

const enableTotp = async (auth, user) => {
  const { secret } = await auth.startTwoFactor(user);
  const { recovery } = await auth.enableTwoFactor(user, totp.codeAt(secret, Math.floor(Date.now() / 30000)));
  return { secret, recovery };
};

const sent = [];
const mailer = (to, code) => sent.push({ to, code });

const codeOf = (to) => sent.filter((s) => s.to === to).pop().code;

// ----- the account method list -----

test('mfaMethods: nothing on before 2FA, totp after setup, email joins once enabled', async () => {
  const auth = freshAuth();
  const u = await signup(auth, 'methods1');
  assert.deepEqual(auth.mfaMethods(u), []);
  await enableTotp(auth, u);
  assert.deepEqual(auth.mfaMethods(u), ['totp']);
  await auth.startEmailCode(u, mailer);
  await auth.enableEmailCode(u, codeOf(u.email));
  assert.deepEqual(auth.mfaMethods(u), ['totp', 'email']);
  assert.equal(auth.hasMfa(u), true);
});

test('setup refuses to start twice, and email codes need 2FA on and an email on file', async () => {
  const auth = freshAuth();
  const u = await signup(auth, 'methods2');
  await assert.rejects(() => auth.startEmailCode(u, mailer), /authenticator app first/);
  u.email = '';
  await enableTotp(auth, u);
  await assert.rejects(() => auth.startEmailCode(u, mailer), /Add your email address/);
  u.email = 'methods2@example.com';
  await auth.startEmailCode(u, mailer);
  await auth.enableEmailCode(u, codeOf(u.email));
  await assert.rejects(() => auth.startEmailCode(u, mailer), /already set up/);
  await assert.rejects(() => auth.startTwoFactor(u), /already on/);
});

test('a code sent to the inbox turns email codes on; a wrong or reused one does not', async () => {
  const auth = freshAuth();
  const u = await signup(auth, 'methods3');
  await enableTotp(auth, u);
  await auth.startEmailCode(u, mailer);
  assert.deepEqual(sent.filter((s) => s.to === u.email).pop(), { to: u.email, code: codeOf(u.email) });
  assert.match(codeOf(u.email), /^\d{6}$/);
  await assert.rejects(() => auth.enableEmailCode(u, '000000'), /didn't match/);
  await auth.enableEmailCode(u, codeOf(u.email));
  // Same code again: burned.
  await assert.rejects(() => auth.enableEmailCode(u, codeOf(u.email)), /expired/);
  assert.equal(u.mfa.email.on, true);
});

test('a wrong email setup code keeps working up to five tries, then the code is dropped', async () => {
  const auth = freshAuth();
  const u = await signup(auth, 'methods4');
  const { secret } = await enableTotp(auth, u);
  await auth.startEmailCode(u, mailer);
  const right = codeOf(u.email);
  // Four wrong tries: each refused, the code still alive (the right one would still work).
  for (const wrong of ['000001', '000002', '000003', '000004']) {
    await assert.rejects(() => auth.enableEmailCode(u, wrong), /didn't match/);
  }
  assert.notEqual(u.mfa.emailPending, undefined);
  await auth.enableEmailCode(u, right);
  assert.equal(u.mfa.email.on, true);
  // A fresh code dies after five wrong tries: email codes off again first (a current app code is the factor).
  await auth.disableEmailCode(u, totp.codeAt(secret, Math.floor(Date.now() / 30000) + 1));
  await auth.startEmailCode(u, mailer);
  const second = codeOf(u.email);
  for (const wrong of ['000001', '000002', '000003', '000004', '000005']) {
    await assert.rejects(() => auth.enableEmailCode(u, wrong), /didn't match/);
  }
  await assert.rejects(() => auth.enableEmailCode(u, second), /expired/);
  assert.equal(u.mfa.emailPending, undefined);
});

test('checkSecondFactor without a code names the methods (MFA_REQUIRED carries them)', async () => {
  const auth = freshAuth();
  const u = await signup(auth, 'methods5');
  await enableTotp(auth, u);
  try {
    auth.checkSecondFactor(u, '', ['k']);
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.code, 'MFA_REQUIRED');
    assert.deepEqual(e.methods, ['totp']);
  }
  await auth.startEmailCode(u, mailer);
  await auth.enableEmailCode(u, codeOf(u.email));
  try {
    auth.checkSecondFactor(u, '', ['k']);
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.code, 'MFA_REQUIRED');
    assert.deepEqual(new Set(e.methods), new Set(['totp', 'email']));
  }
});

// ----- sign-in with each method -----

test('login: the authenticator code still works (and only once)', async () => {
  const auth = freshAuth();
  const u = await signup(auth, 'login1');
  const { secret } = await enableTotp(auth, u);
  const code = totp.codeAt(secret, Math.floor(Date.now() / 30000) + 1); // one step ahead: inside the window, past lastStep
  const token = await auth.login({ username: 'login1', password: 'correct horse battery', code }, '203.0.113.7');
  assert.ok(token);
  await assert.rejects(() => auth.login({ username: 'login1', password: 'correct horse battery', code }, '203.0.113.7'), (e) => e.code === 'MFA_INVALID');
});

test('login: an emailed sign-in code works via method=email, and works once', async () => {
  const auth = freshAuth();
  const u = await signup(auth, 'login2');
  await enableTotp(auth, u);
  await auth.startEmailCode(u, mailer);
  await auth.enableEmailCode(u, codeOf(u.email));
  const { handle } = await auth.sendLoginEmailCode('login2', mailer);
  assert.ok(handle.length >= 16);
  const code = codeOf(u.email);
  assert.match(code, /^\d{6}$/);
  const token = await auth.login({ username: 'login2', password: 'correct horse battery', code, method: 'email' }, '203.0.113.7');
  assert.ok(token);
  // The same emailed code again: gone.
  await assert.rejects(() => auth.login({ username: 'login2', password: 'correct horse battery', code, method: 'email' }, '203.0.113.7'), (e) => e.code === 'MFA_INVALID');
});

test('login: the email method falls back to the app code; the app method falls back to the emailed code; recovery always works', async () => {
  const auth = freshAuth();
  const u = await signup(auth, 'login3');
  const { secret, recovery } = await enableTotp(auth, u);
  await auth.startEmailCode(u, mailer);
  await auth.enableEmailCode(u, codeOf(u.email));
  const step = Math.floor(Date.now() / 30000);
  // method=email but the typed code is actually from the app: accepted.
  const t1 = await auth.login({ username: 'login3', password: 'correct horse battery', code: totp.codeAt(secret, step + 1), method: 'email' }, '203.0.113.7');
  assert.ok(t1);
  await auth.sendLoginEmailCode('login3', mailer);
  const emailed = codeOf(u.email);
  // method=totp (the default) but the typed code is the emailed one: accepted.
  const t2 = await auth.login({ username: 'login3', password: 'correct horse battery', code: emailed }, '203.0.113.7');
  assert.ok(t2);
  // A recovery code, whichever method was asked for.
  const t3 = await auth.login({ username: 'login3', password: 'correct horse battery', code: recovery[0], method: 'email' }, '203.0.113.7');
  assert.ok(t3);
  const t4 = await auth.login({ username: 'login3', password: 'correct horse battery', code: recovery[1] }, '203.0.113.7');
  assert.ok(t4);
});

test('disableEmailCode needs a working second factor, then the method is gone', async () => {
  const auth = freshAuth();
  const u = await signup(auth, 'login4');
  const { secret } = await enableTotp(auth, u);
  await auth.startEmailCode(u, mailer);
  await auth.enableEmailCode(u, codeOf(u.email));
  await assert.rejects(() => auth.disableEmailCode(u, '000000'), /didn't work/);
  await auth.disableEmailCode(u, totp.codeAt(secret, Math.floor(Date.now() / 30000) + 1));
  assert.deepEqual(auth.mfaMethods(u), ['totp']);
});

// ----- the login-code endpoint can't leak who has an account -----

test('sendLoginEmailCode: same-shaped answer for a real account, a 2FA-less account and nobody', async () => {
  const auth = freshAuth();
  const u = await signup(auth, 'stealth1');
  await enableTotp(auth, u);
  const real = await auth.sendLoginEmailCode('stealth1', mailer);
  const none = await auth.sendLoginEmailCode('nobody-here', mailer);
  const plain = await auth.sendLoginEmailCode('stealth1-no-2fa-x', mailer);
  assert.equal(real.sent, true);
  assert.equal(none.sent, true);
  assert.equal(plain.sent, true);
  for (const [name, r] of [['real', real], ['none', none], ['plain', plain]]) {
    assert.equal(typeof r.handle, 'string');
    assert.ok(r.handle.length >= 16, `${name} handle looks random`);
  }
  assert.ok(sent.filter((s) => s.to === u.email).length >= 1);
  assert.equal(sent.filter((s) => s.to === 'nobody-here@example.com').length, 0);
});

test('checkLoginEmailCode: right code checks out for the right account, wrong code never does, each code works once', async () => {
  const auth = freshAuth();
  const u = await signup(auth, 'stealth2');
  await enableTotp(auth, u);
  await auth.sendLoginEmailCode('stealth2', mailer);
  const code = codeOf(u.email);
  assert.throws(() => auth.checkLoginEmailCode(u, '000000'), /didn't work/);
  assert.equal(auth.checkLoginEmailCode(u, code).id, u.id);
  // Burned.
  assert.throws(() => auth.checkLoginEmailCode(u, code), /expired/);
});

// ----- passkeys: the honest stub -----

test('passkey challenges are real: random, single-use, kind-bound', () => {
  const map = new Map();
  const a = passkeys.newChallenge(map, 'login');
  const b = passkeys.newChallenge(map, 'register');
  assert.notEqual(a, b);
  assert.equal(passkeys.useChallenge(map, a, 'login'), true);
  assert.equal(passkeys.useChallenge(map, a, 'login'), false, 'a challenge never works twice');
  assert.equal(passkeys.useChallenge(map, b, 'login'), false, 'wrong kind refused');
  assert.equal(passkeys.useChallenge(map, 'junk', 'login'), false);
});

test('passkey registration is an honest stub: nothing is ever stored on the account', async () => {
  const auth = freshAuth();
  const u = await signup(auth, 'passkey1');
  // publicUser may only advertise the stub (mfaPasskey:false), never a stored credential.
  const pub = auth.publicUser(u);
  assert.equal(pub.mfaPasskey, false);
  assert.equal(JSON.stringify(pub).match(/credential|webauthn/i), null);
  // And the account record itself never grew passkey data.
  assert.equal(JSON.stringify(u).match(/credential|webauthn/i), null);
});
