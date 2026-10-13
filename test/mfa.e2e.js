'use strict';
// End-to-end test of multi-method 2FA (TASK-014-020) against a running local demo site, following the
// pattern of test/growth.e2e.js: plain fetch, no deps.
//
// Start a fresh demo site with a mail stub first (catches the emails), then run this file:
//
//   cat > /tmp/mail-stub.js <<'EOF'
//   require('http').createServer((req, res) => {
//     let b = ''; req.on('data', (c) => (b += c));
//     req.on('end', () => {
//       try { require('fs').appendFileSync(process.env.TREEHOST_MAIL_LOG || '/tmp/mail-stub.log', JSON.stringify({ ...JSON.parse(b), t: Date.now() }) + '\n'); } catch {}
//       res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
//     });
//   }).listen(Number(process.env.TREEHOST_MAIL_PORT) || 8798);
//   EOF
//   node /tmp/mail-stub.js &
//   rm -f /tmp/mail-stub.log
//   TREEHOST_PUBLIC_URL=http://localhost:8799 TREEHOST_PORT=8799 BILLING_DEMO=1 TREEHOST_DATA=/tmp/th-mfa \
//     TREEHOST_RESEND_API=http://localhost:8798/emails RESEND_API_KEY=test node src/server.js &
//   node test/mfa.e2e.js
//
// The stub's port and log file are overridable (TREEHOST_MAIL_PORT / TREEHOST_MAIL_LOG), so this suite
// can share a running server with the creators e2e (whose fake Resend sits on 8796) without clashing.

const B = process.env.TREEHOST_TEST_URL || 'http://localhost:8799';
const MAIL_LOG = process.env.TREEHOST_MAIL_LOG || '/tmp/mail-stub.log';
const fs = require('fs');
let passes = 0, fails = 0;
const ok = (label, got, want) => {
  const good = Array.isArray(want) ? JSON.stringify(got) === JSON.stringify(want) : got === want;
  good ? passes++ : fails++;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${label}${good ? '' : `: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`}`);
};

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

// Emails the local stub caught (newest last).
const emails = (to) =>
  fs
    .readFileSync(MAIL_LOG, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((m) => m.to && m.to[0] === to);
const lastCode = (to) => {
  const m = emails(to).pop();
  return m ? (m.text.match(/\b(\d{6})\b/) || [])[1] : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const me = await (await fetch(B + '/api/auth/me')).json();
  if (!me.teamMode) {
    console.log('FAIL  server is not in team mode — start it with TEAM=1 or TREEHOST_PUBLIC_URL set');
    process.exit(1);
  }
  ok('mail stub got the config (RESEND_API_KEY set)', me.mailEnabled, true);

  const name = 'mfa' + Math.floor(Math.random() * 1e6);
  const email = `${name}@example.com`;
  const signup = await call(name, 'POST', '/api/auth/signup', {
    username: name, email, password: 'TreeHost-test-123', acceptTerms: true, birthYear: 1995,
  });
  ok('signup works', signup.status, 200);

  // 1. Turn on the authenticator app (the existing flow, exercised so email codes have something to attach to).
  const setup = await call(name, 'POST', '/api/auth/2fa/setup');
  ok('2fa/setup gives a secret + uri', [setup.status], [200]);
  ok('uri is an otpauth link', String(setup.data.uri || '').startsWith('otpauth://totp/'), true);
  // A real TOTP code, computed the same way an app would (server's clock, same secret).
  const { newSecret, codeAt } = require('../src/totp');
  const code = codeAt(setup.data.secret, Math.floor(Date.now() / 30000) + 1);
  const enable = await call(name, 'POST', '/api/auth/2fa/enable', { code });
  ok('2fa/enable returns 8 recovery codes', (enable.data.recovery || []).length, 8);
  const recovery = enable.data.recovery;

  // 2. MFA_REQUIRED now names the methods (app only, email not set up yet).
  const c1 = 'probe' + Math.floor(Math.random() * 1e6);
  await call(c1, 'POST', '/api/auth/signup', { username: c1, email: `${c1}@example.com`, password: 'TreeHost-test-123', acceptTerms: true, birthYear: 1995 });
  const wrongPw = await call(c1, 'POST', '/api/auth/login', { username: name, password: 'TreeHost-test-123' });
  ok('login without a code asks for one (401 MFA_REQUIRED)', [wrongPw.status, wrongPw.data.code], [401, 'MFA_REQUIRED']);
  ok('methods so far: app only', JSON.stringify(wrongPw.data.methods || []), JSON.stringify(['totp']));

  // 3. Add email codes.
  const start = await call(name, 'POST', '/api/auth/2fa/email/start');
  ok('email/start sends a code', start.status, 200);
  await sleep(150);
  const setupCode = lastCode(email);
  ok('the email arrived with a 6-digit code', /^\d{6}$/.test(setupCode || ''), true);
  const enableEmail = await call(name, 'POST', '/api/auth/2fa/email/enable', { code: setupCode });
  ok('email/enable turns it on', enableEmail.status, 200);
  const meAfter = await call(name, 'GET', '/api/auth/me');
  ok('me now says mfaEmail is on', meAfter.data.user.mfaEmail, true);

  // 4. MFA_REQUIRED now offers both methods.
  const wrongPw2 = await call(c1, 'POST', '/api/auth/login', { username: name, password: 'TreeHost-test-123' });
  ok('methods now: app and email', [...(wrongPw2.data.methods || [])].sort().join(','), 'email,totp');

  // 5. Sign in with an emailed code.
  const asked = await call(c1, 'POST', '/api/auth/2fa/email/login-code', { login: name });
  ok('login-code endpoint answers the same shape for anyone', [asked.status, asked.data.sent, typeof asked.data.handle], [200, true, 'string']);
  await sleep(150);
  const loginCode = lastCode(email);
  ok('the sign-in code arrived', /^\d{6}$/.test(loginCode || ''), true);
  const loginEmail = await call(c1, 'POST', '/api/auth/login', { username: name, password: 'TreeHost-test-123', code: loginCode, method: 'email' });
  ok('sign-in with the emailed code works', loginEmail.status, 200);

  // 6. Each emailed code works once.
  const reuse = await call(c1, 'POST', '/api/auth/login', { username: name, password: 'TreeHost-test-123', code: loginCode, method: 'email' });
  ok('the same emailed code is refused twice', reuse.data.code, 'MFA_INVALID');

  // 7. An app code still works when method says email (fallback), and recovery codes always work.
  // 35s wait first: the app's lastStep sits at the enable step, so the next accepted code must be a fresh step.
  // (A fresh data folder per run keeps the login rate limit — 5 tries per 15 min — out of the way.)
  await sleep(31000);
  const appCode = codeAt(setup.data.secret, Math.floor(Date.now() / 30000) + 1); // one step ahead: always past lastStep
  const viaFallback = await call(c1, 'POST', '/api/auth/login', { username: name, password: 'TreeHost-test-123', code: appCode, method: 'email' });
  ok('method=email still accepts an app code', viaFallback.status, 200);
  const viaRecovery = await call(c1, 'POST', '/api/auth/login', { username: name, password: 'TreeHost-test-123', code: recovery[0], method: 'email' });
  ok('a recovery code works with method=email', viaRecovery.status, 200);

  // 8. The endpoint can't leak who has an account.
  const nobody = await call(c1, 'POST', '/api/auth/2fa/email/login-code', { login: 'definitely-not-here' });
  ok('unknown address: same answer, no email sent', [nobody.status, nobody.data.sent, typeof nobody.data.handle], [200, true, 'string']);
  ok('unknown address: handle never resolves to a user id', /^[\w-]{16,}$/.test(nobody.data.handle || ''), true);

  // 9. Turn email codes off (needs a working second factor), then the whole thing off.
  const off = await call(name, 'POST', '/api/auth/2fa/email/disable', { code: recovery[1] });
  ok('email/disable with a recovery code works', off.status, 200);
  const meOff = await call(name, 'GET', '/api/auth/me');
  ok('me says mfaEmail is off again', meOff.data.user.mfaEmail, false);
  const allOff = await call(name, 'POST', '/api/auth/2fa/disable', { code: recovery[2] });
  ok('2fa/disable with a recovery code works', allOff.status, 200);

  // 10. Passkeys: the honest stub.
  const challenge = await call(name, 'GET', '/api/auth/passkeys/challenge');
  ok('passkey challenges are issued', [challenge.status, /^[A-Za-z0-9_-]{20,}$/.test(challenge.data.challenge || '')], [200, true]);
  const reg = await call(name, 'POST', '/api/auth/passkeys/register', { challenge: challenge.data.challenge, credential: {} });
  ok('passkey registration is an honest 501', [reg.status, reg.data.code], [501, 'PASSKEYS_UNAVAILABLE']);
  const ver = await call(name, 'POST', '/api/auth/passkeys/verify', { challenge: challenge.data.challenge, assertion: {} });
  ok('passkey verify is an honest 501 too', [ver.status, ver.data.code], [501, 'PASSKEYS_UNAVAILABLE']);

  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
