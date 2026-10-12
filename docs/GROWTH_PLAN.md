# Tree Host — Growth & Funding Plan
Companion to docs/ROADMAP.md. Ranked by leverage; Phase 1 is the foundation everything else measures against.

## Phase 1 — Measurement foundation (do first, ~1 day)
You cannot improve what you don't count. No analytics exists today.

1. Add a privacy-friendly analytics page-load counter to `src/seo.js` / `public/site.js` (Plausible-style: page URL only, no cookies, no personal data — keeps the "no tracking cookies" privacy promise true). Track: page views per page, referrer.
2. Add anonymous funnel events server-side in `src/server.js` / `src/billing.js` (counters in Firebase, already the pattern for donations): demo server launched, demo → command run, signup completed, plan checkout started, checkout completed, donation started/completed.
3. A `/admin` metrics card (Staff Console overview) showing the funnel: visitors → demos → signups → paid. This is the investor slide.
4. UTM-ish capture: store `?ref=` on signup (discord / youtube / reddit / serverlist) so you know which channel works.

## Phase 2 — Site conversion changes (~2–3 days)
5. Homepage hero: swap the second button from "Watch the 1-minute tour" order — make **"Try the demo server"** the primary CTA (links to demo.treehost.online), video second. Trying beats watching.
6. Add a live social-proof strip under the hero: servers launched, players hosted, uptime % — fed by the Phase 1 counters (even "0 servers" becomes honest once real).
7. Pricing page: add a "Which plan do I need?" interactive — answer 2 questions (how many players, vanilla or modpack) → recommended plan with a highlighted CTA. Copy already half-exists in the FAQ.
8. Donate page (funding engine):
   - Add a **Founding Lifetime pre-sale** tier at the top: one payment, full Lifetime plan, launch price, limited to the first 50. Needs a capped one-time SKU in `src/billing.js` (pattern exists in `LIFETIME_PLAN`).
   - Make the goal bar concrete: named line items from `this.receipt` (machine model, RAM, monthly cost) + stretch goals ("$1,000 → second node").
   - Lead with the tour video, not text: "Back something real."
   - Perks ladder per tier: Supporter = wall + Discord role; Founder = Founding Lifetime + in-game badge (founders.txt already exists); Legend = + name in MOTD.
9. Speed pass: compress hero media, lazy-load below-the-fold cards, verify Lighthouse > 90 mobile. Minecraft buyers are on school Wi-Fi.

## Phase 3 — Distribution (~ongoing, cheap)
10. YouTube: the 1-minute tour is the ad. Cut 3 Shorts from it (demo launch in 15s, crash doctor explaining a crash, sleep/wake on join). Each ends on demo.treehost.online. Post 2–3 devlog shorts/week — the build-in-public audience is the donor pool.
11. Discord: `/goal` bot command exists — pin the fund progress in #announcements; add the donate link to the bot's `/help` and rotating status (config already supports `{goal}`).
12. Reddit/communities: r/admincraft "I built a host where servers sleep when empty" style posts; Minecraft server-list ads once revenue exists. The built-in server list is the flywheel — every customer's server advertises Tree Host to its players; make sure it links back to treehost.online.
13. Launch-day kit: status page (roadmap item), "first 50 founding members" counter on donate page, YouTube premiere for the first real server going live.

## Phase 4 — Investor/funder one-pager (~1 day, after Phase 1 data)
14. One page: what it is → demo link → traction numbers (from Phase 1) → the unit-economics story (sleep/wake = higher hardware utilization = structurally cheaper than 24/7 hosts) → roadmap (multi-node, templates) → the ask ($2,000 launch fund → how many customers that buys → revenue plan).
15. Update `docs/ROADMAP.md` launch section to match the $2,000 goal and the pre-sale plan.

## Success metrics
- Demo launches / week (leading indicator)
- Demo → signup conversion (target: >25%)
- Signup → paid conversion (target: >8%)
- Fund progress vs $2,000; Founding Lifetime units sold
- Signups by source (which channel deserves effort)

## Build order
Phase 1 → Phase 2.5 (donate page) → Phase 2 rest → Phase 3 starts in parallel → Phase 4 when demo data exists (~2 weeks post-launch).
