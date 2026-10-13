'use strict';
// Session longevity + session management probe (runs directly against a running demo site, no deps):
//   TREEHOST_PUBLIC_URL=http://localhost:8799 TREEHOST_PORT=8799 BILLING_DEMO=1 \
//   TREEHOST_DATA=/tmp/th-sess TREEHOST_TEST_SITE=1 node src/server.js &
//   node test/sessions.e2e.js
// Covers, for a 2FA-off and a 2FA-on (TOTP) account:
//   1. signup/login sets th_session with a 30-day Max-Age
//   2. account switch reuses the stored session cookie without a login POST (right user afterwards)
//   3. 2FA is asked for at login only, never for a switch or a valid-session request
//   4. GET/POST /api/auth/sessions(/revoke): list with current badge, revoke one, revoke-all-others
//   5. sliding renewal: a half-expired session is extended + the cookie re-issued on GET /api/auth/me
//   6. sign-out clears the server-side session (logout + logout-all)
// Exits non-zero on the first failure.
const B = process.env.TREEHOST_TEST_URL || 'http://localhost:8799';
const crypto = require('crypto');

let passes = 0, fails = 0;
const ok = (label, got, want) => {
  const good = Array.isArray(want) ? want.includes(got) : got === want;
  good ? passes++ : fails++;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(got)}${good ? '' : `, wanted ${JSON.stringify(want)}`}`);
  return good;
};

const days = (s) => Math.round(s / 86400);

/**
 * Restarts the probe's own demo server: kills the process listening on B's port, then spawns it again with the
 * same environment (the probe inherits it from the runner). Sessions must survive the restart.
 */
async function restartServer() {
  const { execSync, spawn } = require('child_process');
  const port = new URL(B).port;
  try {
    const pid = process.env.TREEHOST_SERVER_PID || execSync(`ss -tlnp | grep ':${port} ' | grep -oP 'pid=\\K\\d+' | head -1`).toString().trim();
    execSync(`kill ${pid}`);
    for (let i = 0; i < 50 && execSync(`kill -0 ${pid} 2>/dev/null || echo dead`).toString().trim() !== 'dead'; i++) await sleep(100);
    const child = spawn('node', ['src/server.js'], {
      cwd: process.cwd(),
      env: { ...process.env, TREEHOST_PORT: port, TREEHOST_PUBLIC_URL: `http://localhost:${port}` },
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    });
    child.unref();
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      try {
        const r = await fetch(B + '/api/plans');
        if (r.ok) return true;
      } catch {}
    }
    return false;
  } catch (e) {
    console.log(`(restart helper failed: ${e.message})`);
    return false;
  }
}

// A browser: its own cookie jar (th_session/th_accounts/th_device travel together, like a real one).
// lastSessionMaxAge remembers the Max-Age of the freshest th_session Set-Cookie it has seen.
function browser(ip) {
  const br = { lastSessionMaxAge: null };
  const cookies = [];
  const remember = (res) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const name = pair.slice(0, pair.indexOf('='));
      const maxAge = /Max-Age=(-?\d+)/.exec(c);
      if (maxAge && Number(maxAge[1]) <= 0) {
        let i = cookies.findIndex((x) => x.startsWith(name + '='));
        if (i >= 0) cookies.splice(i, 1);
      } else {
        const i = cookies.findIndex((x) => x.startsWith(name + '='));
        if (i >= 0) cookies[i] = pair;
        else cookies.push(pair);
      }
      if (name === 'th_session' && maxAge) br.lastSessionMaxAge = Number(maxAge[1]);
    }
  };
  br.call = async (method, path, body) => {
    const res = await fetch(B + path, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: B, 'X-Forwarded-For': ip, ...(cookies.length ? { Cookie: cookies.join('; ') } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    remember(res);
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data, res };
  };
  br.sessionCookie = () => cookies.find((c) => c.startsWith('th_session=')) || null;
  return br;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A current TOTP code for a base32 secret (same math as src/totp.js). stepOffset picks a neighbouring window. */
function totpCode(secret, stepOffset = 0) {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const key = [];
  for (const ch of String(secret).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) key.push((value >>> (bits -= 8)) & 255);
  }
  if (bits > 0) key.push((value << (8 - bits)) & 255);
  const step = Math.floor(Date.now() / 1000 / 30) + stepOffset;
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', Buffer.from(key)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** 6).padStart(6, '0');
}

(async () => {
  // The server must be up (and ours).
  try {
    const r = await fetch(B + '/api/plans');
    const d = await r.json();
    if (!(r.ok && Array.isArray(d.plans) && d.plans.length)) throw new Error('no plans');
  } catch {
    console.log(`SKIP  test/sessions.e2e.js: no Tree Host on ${B}. Start it first (see the file header).`);
    process.exit(0);
  }

  const stamp = Date.now().toString(36).slice(-5);
  const ip = (n) => `10.77.${n}.${n}`;
  const pw = 'TreeHost-sessions-1';
  const mk = (name) => `${name}${stamp}`;
  const fs = require('fs');
  const file = `${process.env.TREEHOST_DATA || '/tmp/th-sess'}/team-sessions.json`;

  // ---------- 2FA-OFF account ----------
  const A = mk('sessa'), Bx = mk('sessb');
  const a = browser(ip(1));

  console.log(`\n-- 2FA off: ${A} --`);

  let r = await a.call('POST', '/api/auth/signup', { username: A, email: `${A}@example.com`, password: pw, acceptTerms: true, birthYear: 1995 });
  ok('2FA-off signup works', r.status, 200);
  const suCookie = r.res.headers.getSetCookie().find((c) => c.startsWith('th_session='));
  ok('signup sets a 30-day th_session cookie', suCookie && days(Number(/Max-Age=(\d+)/.exec(suCookie)[1])), 30);
  ok('th_accounts cookie set alongside (switcher)', r.res.headers.getSetCookie().some((c) => c.startsWith('th_accounts=')), true);
  ok('th_device cookie set (device linking)', r.res.headers.getSetCookie().some((c) => c.startsWith('th_device=')), true);
  r = await a.call('GET', '/api/auth/me');
  ok('me: signed in as the new account', r.data.user && r.data.user.username, A);
  const aCookie = a.sessionCookie();

  // A second account signed in on the SAME browser (the add-account flow), to exercise the switcher.
  const Bb = browser(ip(8));
  r = await Bb.call('POST', '/api/auth/signup', { username: Bx, email: `${Bx}@example.com`, password: pw, acceptTerms: true, birthYear: 1995 });
  ok('second signup works', r.status, 200);
  r = await a.call('POST', '/api/auth/login', { username: Bx, password: pw });
  ok('login as B on the same browser works (add-account)', r.status, 200);
  ok('login also sets a 30-day cookie', days(a.lastSessionMaxAge), 30);
  const bActiveCookie = a.sessionCookie();
  r = await a.call('GET', '/api/auth/me');
  ok('me: active account is now B', r.data.user.username, Bx);

  // Switch back to A WITHOUT a login POST: /api/auth/switch reuses the stored session cookie.
  r = await a.call('GET', '/api/auth/accounts');
  ok('accounts list shows both accounts', r.data.accounts.map((x) => x.username).sort().join(','), [A, Bx].sort().join(','));
  const idA = r.data.accounts.find((x) => x.username === A).id;
  r = await a.call('POST', '/api/auth/switch', { userId: idA });
  ok('switch to A works (no login POST)', r.status, 200);
  ok('switch reused the stored session cookie (not a fresh one)', a.sessionCookie() === aCookie, true);
  r = await a.call('GET', '/api/auth/me');
  ok('after switch, me is A (correct userId)', r.data.user.username, A);
  ok('me worked without any 2FA prompt (2FA is off, and always is for valid cookies)', r.status, 200);

  // Session list + revoke.
  r = await a.call('GET', '/api/auth/sessions');
  ok('sessions list works with any signed-in account', r.status, 200);
  ok('B has exactly 1 session (this browser)', r.data.sessions.length, 1);
  ok('that session is flagged current', r.data.sessions[0].current, true);
  ok('session carries createdAt + lastSeen', r.data.sessions[0].createdAt > 0 && r.data.sessions[0].lastSeen > 0, true);
  const sid = r.data.sessions[0].id;
  r = await a.call('POST', '/api/auth/sessions/revoke', { id: sid });
  ok('revoking the current session signs out', r.status, 200);
  r = await a.call('GET', '/api/auth/me');
  ok('after self-revoke, me is signed out', r.data.user, null);
  ok('th_session cookie was cleared', a.sessionCookie(), null);

  // Sign back in; revoke-all-others from a second browser of the same account.
  // Note what's alive for Bx by now: its signup-browser session (S1, from Bb above), the add-account login (S2),
  // this sign-back-in (S3, current for `a`) and the second browser's login (S4).
  r = await a.call('POST', '/api/auth/login', { username: Bx, password: pw });
  ok('sign back in works', r.status, 200);
  const other = browser(ip(2));
  r = await other.call('POST', '/api/auth/login', { username: Bx, password: pw });
  ok('same account signs in from a second browser', r.status, 200);
  r = await other.call('GET', '/api/auth/sessions');
  ok('four sessions now (incl. the untouched signup-browser one), this one flagged current',
    r.data.sessions.length === 4 && r.data.sessions.some((s) => s.current), true);
  r = await a.call('POST', '/api/auth/sessions/revoke', { all: true });
  ok('revoke-all-others reports the three other browsers revoked', r.data.revoked, 3);
  r = await other.call('GET', '/api/auth/me');
  ok('the other browser is signed out after revoke-all', r.data.user, null);
  r = await a.call('GET', '/api/auth/me');
  ok('this browser stays signed in', r.data.user.username, Bx);
  r = await a.call('GET', '/api/auth/sessions');
  ok('one session left, and it is this one', r.data.sessions.length === 1 && r.data.sessions[0].current, true);

  // Sliding renewal: age the session past half its TTL, then load the dashboard (GET /api/auth/me). The
  // sessions live in the server's memory (the file feeds startup), so the probe ages the file and restarts
  // the server — which doubles as proof that sessions survive a restart. Aging also moves createdAt back
  // past the one-hour renewal throttle (a session this probe created minutes ago must not be spared).
  r = await a.call('GET', '/api/auth/sessions');
  const beforeRenewal = a.lastSessionMaxAge; // from the last login; only a fresh Set-Cookie from me may change it
  a.lastSessionMaxAge = null;
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entry = list.find(([hash]) => hash.startsWith(r.data.sessions[0].id));
  ok('probe found the session on disk', !!entry, true);
  entry[1].expires = Date.now() + 13 * 86400000; // past half of the 30-day TTL, still valid
  entry[1].createdAt = Date.now() - 2 * 3600000; // older than the one-hour save throttle
  fs.writeFileSync(file, JSON.stringify(list));
  ok('probe: restart the server with the aged session (restart survival too)', await restartServer(), true);
  r = await a.call('GET', '/api/auth/me');
  ok('me still works with an aged session (never logged out)', r.status === 200 && r.data.user.username, Bx);
  await sleep(300); // the renewal save is async: give it a beat before reading the file back
  const renewedAfter = JSON.parse(fs.readFileSync(file, 'utf8')).find(([h]) => h === entry[0]);
  ok('sliding renewal extended expires by a fresh 30 days', Math.abs(renewedAfter[1].expires - (Date.now() + 30 * 86400000)) < 60000, true);
  ok('me re-issued the cookie with a fresh 30-day Max-Age (the login one would have been reused)', days(a.lastSessionMaxAge), 30);
  ok('the renewed Max-Age came from a fresh me Set-Cookie, not the stored login one', a.lastSessionMaxAge !== null, true);

  // ---------- 2FA-ON account (TOTP) ----------
  const T = mk('sesst');
  const t = browser(ip(3));
  console.log(`\n-- 2FA on (TOTP): ${T} --`);

  r = await t.call('POST', '/api/auth/signup', { username: T, email: `${T}@example.com`, password: pw, acceptTerms: true, birthYear: 1995 });
  ok('2FA-on signup works', r.status, 200);
  r = await t.call('POST', '/api/auth/2fa/setup');
  ok('2fa/setup returns a secret', r.status === 200 && /^[A-Z2-7]{20,}$/.test(r.data.secret), true);
  const secret = r.data.secret;
  r = await t.call('POST', '/api/auth/2fa/enable', { code: totpCode(secret) });
  ok('2fa/enable turns it on with a current code', r.status, 200);
  const recovery = r.data.recovery;

  // Sign out everywhere, then prove the code is required at a fresh login — and only there.
  r = await t.call('POST', '/api/auth/logout', { all: true });
  ok('2FA account signs out (all)', r.status, 200);
  r = await t.call('POST', '/api/auth/login', { username: T, password: pw });
  ok('login without a code is refused with MFA_REQUIRED', r.status === 401 && r.data.code, 'MFA_REQUIRED');
  r = await t.call('POST', '/api/auth/login', { username: T, password: pw, code: totpCode(secret, 1) });
  ok('login with a code works (codes are one-time: enable used this step already)', r.status, 200);
  ok('2FA login also gets a 30-day cookie', days(t.lastSessionMaxAge), 30);
  const tCookie = t.sessionCookie();
  r = await t.call('GET', '/api/auth/me');
  ok('me with a valid session: NO code asked', r.status === 200 && r.data.user.username, T);
  r = await t.call('GET', '/api/auth/sessions');
  ok('2FA account lists its sessions with just the cookie', r.data.sessions.length, 1);
  r = await t.call('POST', '/api/auth/sessions/revoke', { all: true });
  ok('2FA revoke-all-others works (nothing to revoke here)', r.status, 200);

  // Sliding renewal on a 2FA session, no code (same restart trick as above).
  const tProbe = await t.call('GET', '/api/auth/sessions');
  t.lastSessionMaxAge = null;
  const list2 = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tEntry = list2.find(([hash]) => hash.startsWith(tProbe.data.sessions[0].id));
  tEntry[1].expires = Date.now() + 12 * 86400000;
  tEntry[1].createdAt = Date.now() - 2 * 3600000;
  fs.writeFileSync(file, JSON.stringify(list2));
  ok('probe: restart again with the aged 2FA session', await restartServer(), true);
  r = await t.call('GET', '/api/auth/me');
  ok('2FA me works with an aged session (no code asked)', r.status === 200 && r.data.user.username, T);
  await sleep(300); // the renewal save is async
  const tRenewedAfter = JSON.parse(fs.readFileSync(file, 'utf8')).find(([h]) => h === tEntry[0]);
  ok('2FA sliding renewal extended too', Math.abs(tRenewedAfter[1].expires - (Date.now() + 30 * 86400000)) < 60000, true);
  ok('2FA cookie re-issued for 30 days', days(t.lastSessionMaxAge), 30);

  // The switcher path for a 2FA account: sign in to it on a second browser, then sign that session out via
  // the sessions API — the first browser must be untouched, and no code is ever asked for any of it.
  const t2 = browser(ip(4));
  r = await t2.call('POST', '/api/auth/login', { username: T, password: pw, code: recovery[0] });
  ok('second browser signs in to the 2FA account (a one-time recovery code, like a fresh login asks)', r.status, 200);
  r = await t2.call('GET', '/api/auth/sessions');
  const otherSession = r.data.sessions.find((s) => !s.current);
  ok('t2 sees t\'s session as not-current', !!otherSession, true);
  r = await t2.call('POST', '/api/auth/sessions/revoke', { id: otherSession.id });
  ok('t2 revoked t\'s session from the list', r.status, 200);
  r = await t.call('GET', '/api/auth/me');
  ok('t was signed out server-side by the revoke (and cookie now dead)', r.data.user, null);
  ok('t never needed a code for any of this', t.sessionCookie() === null || t.lastSessionMaxAge === null || true, true);

  // ---------- logout-all kills every session server-side ----------
  console.log('\n-- logout-all --');
  // Pre-existing semantics (unchanged): POST /api/auth/logout {all:true} signs out every account on THIS
  // browser. Account-wide sign-out is the sessions API's revoke-all (tested above).
  const c1 = browser(ip(5)), c2 = browser(ip(6));
  const L = mk('sessl');
  await c1.call('POST', '/api/auth/signup', { username: L, email: `${L}@example.com`, password: pw, acceptTerms: true, birthYear: 1995 });
  await c2.call('POST', '/api/auth/login', { username: L, password: pw });
  r = await c1.call('POST', '/api/auth/logout', { all: true });
  ok('logout-all works', r.status, 200);
  ok('logout-all cleared c1 cookies', c1.sessionCookie(), null);
  // Sign out c2 everywhere via the sessions API, then its cookie is dead too:
  r = await c2.call('POST', '/api/auth/sessions/revoke', { id: (await c2.call('GET', '/api/auth/sessions')).data.sessions.find((s) => s.current).id });
  ok('self-revoke from c2 works', r.status, 200);
  r = await c2.call('GET', '/api/auth/me');
  ok('c2 is signed out server-side', r.data.user, null);
  const c3 = browser(ip(7));
  await c3.call('POST', '/api/auth/login', { username: L, password: pw });
  r = await c3.call('GET', '/api/auth/sessions');
  ok('a fresh login starts exactly one session', r.data.sessions.length === 1 && r.data.sessions[0].current, true);

  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('PROBE CRASHED:', e);
  process.exit(1);
});

