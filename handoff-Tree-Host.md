# Handoff — CREATORS-T18 (attach existing account to a creator)

Committed cc826a8, pushed to origin/main.

## Files changed
- `src/server.js` — new route `POST /api/admin/creators/:code/attach` (perm `creators.manage`), placed right after the payout route (~line 1800). Body `{ username | email, remove? }`. Lookup is case-insensitive exact match on username OR email over `auth.users`. 404 unknown user, 400 unknown code, 400 disabled creator. Sets/clears `user.creatorCode`/`user.creatorId`, persists with `await auth.save()` (same pattern as the change-email/reset-password routes). Idempotent; switching overwrites the old code — past commission stays in the old creator's ledger (the ledger rows are keyed by creatorId, nothing is rewritten). Returns `{ username, creatorCode }` (null code on remove). Audit line notes the previous code and that past money stays.
- `public/team.js` — `adminCreators`: 'Attach an existing account' input + Attach button in the Share-links card, enabled only when a creator is picked and text is present; toasts `${user} — now earning for ${CODE}` and re-renders. `adminPeople`: new "Creator" column with a green `★ CODE` badge, and an `Attach to creator` action (perm `creators.manage`) opening `openAttachCreator()` — dropdown of active creators from `GET /api/admin/creators`, Attach submits, Remove sends `{ remove: true }` to the same route using the user's current code in the path.
- `test/creators-e2e-scenarios.js` — E16 block (30 assertions).

## API contract
`POST /api/admin/creators/:code/attach` → 200 `{ username, creatorCode }`; errors: 401/403 (auth/perm), 404 unknown user, 400 unknown or disabled creator code. `remove: true` clears attribution (path `:code` is ignored then; the UI passes the user's current code).

## Effect
`/api/creators/me` and the dashboard "Creator earnings" sidebar link key off `user.creatorCode`, so an attached account gets both on its next render/reload — no other wiring. `user.ref` is untouched. Earnings count from attach time on.

## Tests
- `TREEHOST_TEST_URL=http://localhost:8799 node test/creators.e2e.js` (fresh server, see the file header): **192 passed, 0 failed**.
- `node --test test/*.test.js`: **96/96 green**.

## Notes / risks
- `src/auth.js` had a **pre-existing uncommitted change** (sessions moved into the store) that was on the worktree before this task; it is NOT part of commit cc826a8. Whoever owns it should commit it separately.
- No `JACKHAMR.md`/`CLAUDE.md` at the repo root; patterns were taken from the neighboring creator routes and the People page code.
- No new top-level directories.
