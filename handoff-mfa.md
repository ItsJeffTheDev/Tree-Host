# Handoff — TASK-014-020: multi-method 2FA (authenticator app / email codes / passkeys)

Repo: `/root/projects/Tree-Host` (branch `main`). One commit on top of `62023cf`.

## What shipped

### Email codes as a second factor (the new method)
- `src/auth.js`:
  - `mfaMethods(user)` / `hasMfa(user)` — the account's methods, `['totp', ...'email']` in offer order.
  - `checkSecondFactor(user, code, keys, method)` — method-aware; a missing code throws `MFA_REQUIRED`
    carrying `methods` (the browser renders the picker from it). A wrong code still counts like a wrong
    password (same rate-limit keys).
  - `useSecondFactor(user, code, method)` — checks the asked method first, falls back to the other one,
    then recovery codes (recovery codes are accepted under either method, never gated).
  - `startEmailCode(user, send)` / `enableEmailCode(user, code)` / `disableEmailCode(user, code)` —
    6-digit code, 10 min, single use, 5 wrong tries kills the pending code. Turning email codes off
    needs a working second factor, so a stolen session can't weaken the account.
  - `sendLoginEmailCode(loginOrUser, send)` / `checkLoginEmailCode(user, code)` — sign-in codes at
    login time. The API answer is *identical* whether or not the address has an account
    (`{ sent: true, handle: <random> }`), so the endpoint can't be used to enumerate accounts.
  - `publicUser` now also returns `mfaEmail` (and `mfaPasskey: false` — see stub below).
  - `startTwoFactor` refuses when ANY method is on (was: only TOTP).
- `src/server.js` routes:
  - `POST /api/auth/2fa/email/start` — emails the setup code (`mfaEmailSend` in the same branded
    layout, community box off).
  - `POST /api/auth/2fa/email/enable` / `disable`.
  - `POST /api/auth/2fa/email/login-code` (public) — issues a sign-in code for `body.login`.
  - The route error handler now forwards `e.methods` on the JSON error (MFA_REQUIRED picker data).
  - `login` body passes `method` through to `auth.login` (the route hands the parsed body straight in).
  - Firebase login (`auth.firebaseLogin`) forwards `body.method` the same way.

### Passkeys — an honest stub
- `src/passkeys.js`: real random challenges (`newChallenge`/`useChallenge`), single-use, 5-min expiry,
  kind-bound, size-capped. That's everything Node's crypto can do honestly without a WebAuthn stack.
- Routes: `GET /api/auth/passkeys/challenge` (real), `POST /api/auth/passkeys/register` and
  `.../verify` answer **501 `PASSKEYS_UNAVAILABLE`** with a message that says what to use instead.
  Nothing is ever stored on the account. `mfaPasskey: false` in `publicUser` is the only exposure.

### Frontend (`public/team.js`, `public/app.js`)
- `askSecondFactor(message, methods, method)` — the modal now shows method-switch buttons when
  `methods` has both: **Authenticator app** / **Email me a code** (only shown when email is on).
- `withSecondFactor(send, login)` — picks up `methods` from the MFA_REQUIRED error; "Email me a code"
  calls `/api/auth/2fa/email/login-code` then asks for the emailed code and submits
  `{ code, method: 'email' }`. A 503 from the mail stack surfaces as a message, not a dead end.
- `app.js` `api()` now forwards `data.methods` onto thrown errors (that's how the modal learns).
- Security card: "Add email codes" / "Turn off email codes" (off needs a current code), plus a static
  passkeys line that says honestly it's not finished yet. `state.me.user.mfaEmail` drives it.
- Both sign-in paths (password login and Firebase login) pass `{ code, method }` and the typed login.

## Tests
- `test/mfa.test.js` (unit, `node --test`): 13 tests — method list, setup guards, enable/wrong-code/
  five-tries, MFA_REQUIRED methods payload, each sign-in method + cross-method fallback + recovery,
  disable, the no-enumeration shape, the passkey stub honesty.
- `test/mfa.e2e.js` (direct, not under `node --test`): 26 checks against a live server with a mail
  stub — full setup → enable → sign-in-with-emailed-code → single-use → fallback → recovery →
  disable → passkey 501s. Header comment has the exact server + stub command lines; the stub's port
  and log are overridable (`TREEHOST_MAIL_PORT`, `TREEHOST_MAIL_LOG`) so it can share a server with
  the creators suite (fake Resend on 8796) if the server is pointed at 8798.

## Evidence
- Unit: 109 passed / 0 failed across mfa + auth-ref + sessions + creators + billing(3) + seo + metrics.
- E2E on fresh data folders, one suite per fresh server (these suites all assume they own the folder):
  mfa 26/0, creators 244/0, rbac 299/0, broadcast 37/0.
- Headless-browser (Playwright) round-trip: modal shows both method buttons, "Email me a code" sends
  and switches the prompt, typing the emailed code lands signed-in (`state.me.user.username` set).
  Note for anyone driving the modal in tests: the active-method button also carries class `primary`,
  so click by text (`Sign in`), not `.primary`.

## Deviations from a naive read of the task
- Login-code handle: the browser gets a random opaque handle, but the pending code itself lives on the
  account (`user.mfa.loginCode`, hashed) rather than in a server-side map — same no-enumeration
  property, and it survives like the rest of the account record.
- `checkLoginEmailCode(user, code)` takes the user, not the handle (follows from the storage choice).
- The five-tries rule: the pending code dies on the 5th wrong try; before that the right code still works.

## Risks / open questions
- The emailed sign-in code is stored on the account, so an attacker with a write to `team-users`
  could read its hash — same exposure class as every other code here (TOTP secret, recovery codes).
- Passkeys: the 501s are permanent until someone either adds a WebAuthn dependency (repo is
  zero-deps by convention) or hand-rolls CBOR/COSE. `src/passkeys.js` has the notes for that.
- The creators/growth/rbac/broadcast/sessions e2e suites each assume a fresh data folder and (for the
  first two) their own Resend stub; they cannot share one server run. Not a regression — pre-existing
  contract of those suites — but worth knowing when wiring CI.
- No `JACKHAMR.md`/`CLAUDE.md` exists in this repo; conventions were taken from the existing suites
  and code style (zero deps, plain fetch e2e, node --test units, house email layout).
