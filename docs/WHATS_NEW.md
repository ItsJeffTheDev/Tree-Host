# What's New — Growth Update (October 2026)

Everything this update added, where to find it, and how to use it. All features are live on the site the moment this code deploys — nothing needs enabling.

---

## For visitors & customers

### Try the demo first — new homepage
**Where:** the homepage hero (`/`)

"Try the demo server" is now the big green button at the top of the homepage (the 1-minute tour video moved to second place). Anyone can explore a real Tree Host dashboard before signing up — no card, no commitment.

### Live numbers on the homepage
**Where:** under the hero on `/`

A live strip shows **signups this week · servers launched · supporters · founding spots left**, with a small note that the numbers are real and unedited. It fills itself in from the site's own counters and stays hidden if the numbers can't load (it never breaks the page).

### "Which plan do I need?" recommender
**Where:** the pricing page (`/pricing`)

Two questions — how many players, and vanilla/plugins or a modpack — and the right plan lights up with a **RECOMMENDED FOR YOU** tag and a direct buy button. The mapping: a few friends → Sapling, 5–20 players or a light modpack → Oak, a big community → Redwood (a modpack never recommends below Oak). If the plans fail to load, the old static guide cards come back automatically.

### Founding Lifetime pre-sale — $199 once, first 25
**Where:** the top of the donate page (`/donate`)

The Lifetime plan (4 servers + 2 proxies + priority support) at a one-time **$199** instead of the regular price, capped at the **first 25 buyers**. The card shows:
- a progress bar and "X of 25 left at this price"
- the **real Lifetime price you set in Staff Console → Billing → Plans** ("The Lifetime plan, at the founding price — $750 later"), so the deal explains itself
- a **sold-out state** that flips automatically when all 25 are gone (gray tag, disabled button, a pointer to the launch fund and Discord)

The cap is enforced server-side — the 26th purchase gets a clean "Every Founding Lifetime spot is taken" error no matter how it's attempted. Founding buyers automatically get the **FOUNDER badge in-game** (via `founders.txt`) and appear on the supporters wall. A refund removes the badge and frees the spot.

### Founding buyers who weren't signed in yet
**Where:** signup screen and dashboard

If someone clicks the founding CTA while signed out, the signup screen says **"Your Founding Lifetime spot is waiting — X of 25 left"** with a "Create account & finish purchase" button. After signup, a gold **"Finish your Founding Lifetime purchase"** banner sits at the top of their dashboard with a one-click checkout. If the spots sell out while they're making the account, they get an honest "the founding spots are gone" message and a normal signup — nobody is stranded mid-purchase.

### Honest privacy page
**Where:** `/privacy`

Updated to describe exactly what the new counting does: page paths and referring sites only, no cookies, no IP addresses, no personal data, nothing linked to accounts, deleted after 180 days. The only browser storage is an optional session-scoped "how did you find us" marker that dies with the tab.

---

## For the team

### Growth funnel in the Staff Console
**Where:** `/admin` → Overview → "Growth funnel" card

The one-glance traction view: **visitors → demo launches → signups → paid**, each with "this week · all-time", plus signups-by-source, founding sales ("X of 25 sold · $Y"), and donation counts. Read-only. Requires `console.access` (Owner/Admin/Developer/Support with the permission).

### Where the numbers come from (and how to trust them)
**Where:** `src/metrics.js` and the new API routes

- Cookie-free counters (`src/metrics.js`): daily buckets in the database, all-time totals, 180-day retention, no IPs/user-agents/identifiers ever stored. Keys are percent-encoded so Firebase Realtime Database accepts them.
- Counted at the action's success point: demo launched, demo command run, server created, signup (+ ref), checkout started, checkout completed, donation started/completed.
- Checkout completion is counted **once** — inside the single activation path that every payment route (Stripe webhook, browser confirm, demo mode) passes through, so webhook retries and double-clicks can't inflate the funnel.
- Public endpoints: `GET /api/metrics/social` (rounded, safe to expose), `GET /api/admin/metrics` (permission-gated).

### Where signups come from
**Where:** signup records + the funnel card

Add `?ref=discord` (or `youtube`, `reddit`, `serverlist`) to any link you share. The source is stored on the account (not a cookie) and shows up in the funnel card's by-source line, so you know which channel actually works. Anything else becomes "other" — a bad ref never breaks a signup.

### Managing the pre-sale
**Where:** Staff Console

- **Change the anchor price:** Billing → Plans → edit the **Lifetime** price. The founding card's "…$X later" line follows it automatically. The $199 founding price is fixed in code.
- **Change the cap:** it's the `capTotal: 25` constant on the founding plan in `src/billing.js` (env `TREEHOST_FOUNDING_CAP` exists for tests only). Edit + redeploy to change it.
- **Founding buyers list:** Staff Console → people/supporters — founding credits appear like donations, pinned to the FOUNDER tier.

---

## For developers

### Test suites (no new dependencies)
**Where:** `test/` + `package.json` scripts

```bash
npm run test:unit     # node --test test/           — all unit tests
npm run test:growth   # node test/growth.e2e.js     — 70 HTTP scenarios (needs a local demo server, see file header)
npm run test:browser  # node test/growth.browser.js — optional browser suite (Playwright + system Chromium)
npm run test:rbac     # existing RBAC suite
```

The growth E2E covers: beacon/validation contract, social + admin metrics, permission gates, every funnel anchor, the founding cap (including sold-out and refund), founding↔lifetime cap independence, privacy page copy, and the Referrer-Policy boundaries.

### New files
| File | What it is |
|---|---|
| `src/metrics.js` | cookie-free counter module (daily buckets, RTDB-safe keys, dedup window, rounding) |
| `test/metrics.test.js` | 19 unit tests for the counter module |
| `test/billing-founding.test.js` | 16 unit tests: cap machinery, sold-out, credits, refunds, GAP-2 independence |
| `test/billing-counts.test.js` | 9 unit tests: idempotent checkout/donation counting |
| `test/auth-ref.test.js` | 12 tests: `?ref=` sanitization + e2e |
| `test/seo.test.js` | founding row in offers/llms.txt, SoldOut schema |
| `test/growth.e2e.js` | 70-scenario HTTP E2E suite |
| `test/growth.browser.js` | optional browser E2E (system Chromium) |
| `docs/GROWTH_PLAN.md` | the full growth & funding plan (phases 1–4) |
| `promo/` | video recording scripts + the walkthrough video |

### Behavior changes worth knowing
- **Public HTML responses** now send `Referrer-Policy: strict-origin-when-cross-origin` (was `no-referrer`) so source tracking works; the dashboard and all non-HTML responses keep `no-referrer`. No page URLs leave the browser.
- **`TREEHOST_TEST_SITE=1`** now also marks billing as a test site (unlimited demo capacity) — previously only `localhost` URLs got that.
- **`store.js` writes are race-proof:** unique tmp files per write, `flushAll()` can't reject — fixes the Render deploy `ENOENT` crash on shutdown.
- **Cross-site protection** now accepts the configured `TREEHOST_PUBLIC_URL` host as same-site (fixes 403s behind preview proxies).

---

## Quick tour for the launch announcement

1. **Visitor lands on the homepage** → sees real numbers → clicks **Try the demo server**
2. **Explores the demo** (launch it, run commands) → counts as a demo launch in your funnel
3. **Pricing** → answers two questions → gets told exactly which plan
4. **Donate page** → sees the Founding Lifetime deal anchored against your real Lifetime price → buys (or signs up first and finishes from the dashboard banner)
5. **You watch it all happen** in Staff Console → Growth funnel, including which channel sent them (`?ref=`)

---

*Update shipped October 12, 2026 · commits `2ecb77a` → `698194f` · all tests green (`npm run test:unit`, `npm run test:growth`)*
