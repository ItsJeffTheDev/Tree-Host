'use strict';
// Creator (affiliate) program: staff-managed creator codes, tiered commission on a referred
// account's first payment, manual payouts, and an append-only ledger. The ledger is the source
// of truth — in-memory stats are caches, reconciled from the ledger on every load.
const crypto = require('crypto');
const store = require('./store');

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

// Static ?ref= channels (src/metrics.js REFS): a creator code can never take one of these.
const RESERVED_CODES = ['discord', 'youtube', 'reddit', 'serverlist'];
const PAYOUT_METHODS = ['paypal', 'iban', 'giftcard'];
const PAYOUT_METHOD_LABELS = { paypal: 'PayPal', iban: 'bank transfer', giftcard: 'gift card' };
const TIER_LADDER = [
  { id: 'bronze', label: 'Bronze', percent: 10, minPaying: 0 },
  { id: 'silver', label: 'Silver', percent: 15, minPaying: 5 },
  { id: 'gold', label: 'Gold', percent: 20, minPaying: 25 },
];
const RATE_WINDOW = 15 * 60 * 1000;
const APPLY_MAX = 10; // applications per IP per window, like signup
const LOOKUP_MAX = 10;
const LEDGER_PAGE = 500;
const PAYOUT_HINT = 'Email creators@treehost.online to request your payout.';

const cleanCode = (c) => String(c || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 32);
const newId = (p) => `${p}_${crypto.randomBytes(6).toString('hex')}`;
const stripControls = (s) => String(s ?? '').replace(/[\x00-\x1f\x7f]/g, '');
const rank = (ladder, tierId) => ladder.findIndex((t) => t.id === tierId);

/** Highest tier whose threshold the paying-referral count has reached. */
function tierFor(paying, ladder = TIER_LADDER) {
  const p = Math.max(0, Math.round(Number(paying) || 0));
  let out = ladder[0];
  for (const t of ladder) if (p >= t.minPaying) out = t;
  return out;
}

class Creators {
  constructor() {
    this.creators = [];
    this.ledger = [];
    this.applications = [];
    this.settings = { creatorTiers: null };
    this.attempts = new Map(); // 'apply:<ip>' / 'lookup:<ip>' -> recent attempt timestamps
    // Wired by server.js. Everything is fire-and-forget-safe: a missing or throwing hook
    // must never take a creator call down with it.
    this.hooks = {
      userById: () => null, // userId -> user record (commission attribution)
      promoExists: () => false, // code -> bool, so creator codes can't collide with promos
      createPromo: async () => null, // ({ code, percentOff, note, maxUses }, by) -> promo
      updateViewerPromo: async () => null, // (promoCode, { percentOff?, active? }) -> promo
      viewerPromo: () => null, // promoCode -> { percentOff, active } | null
      metricsMaps: () => ({}), // () -> { pvRef, signupRef } decoded maps (funnelFor)
      notice: () => {}, // staff notice { section, perm, title, text, link }
      activity: () => {}, // activity log (kind, who, text)
      email: async () => {}, // (kind, payload)
    };
  }

  /** Tier ladder, overridable per deployment via settings.creatorTiers (like billing.founderTiers). */
  ladder() {
    return Array.isArray(this.settings.creatorTiers) && this.settings.creatorTiers.length ? this.settings.creatorTiers : TIER_LADDER;
  }

  async init() {
    const d = (await store.load('creators')) || {};
    this.creators = Object.values(d.creators || {});
    this.ledger = Object.values(d.ledger || {});
    this.applications = Object.values(d.applications || {});
    this.settings = { ...this.settings, ...(d.settings || {}) };
    for (const c of this.creators) this.normalize(c);
    this.reconcile();
  }

  save() {
    // Fire-and-forget: a failed write must never fail the request that triggered it.
    return store.save('creators', {
      v: 1, creators: this.creators, ledger: this.ledger, applications: this.applications, settings: this.settings,
    }).catch(() => {});
  }

  // ----- normalization + reconciliation (ledger is the source of truth) -----

  normalize(c) {
    c.id = c.id || newId('cr');
    c.code = cleanCode(c.code);
    c.name = stripControls(c.name).slice(0, 40);
    c.handle = stripControls(c.handle).slice(0, 40);
    c.platform = stripControls(c.platform).slice(0, 20);
    c.note = stripControls(c.note).slice(0, 200);
    c.status = c.status === 'disabled' ? 'disabled' : 'active';
    c.viewerCode = c.viewerCode || null;
    c.bestTier = c.bestTier || null;
    c.createdBy = c.createdBy || null;
    c.createdAt = c.createdAt || Date.now();
    c.disabledAt = c.disabledAt || null;
    c.stats = {
      signups: Math.max(0, Math.round(Number(c.stats && c.stats.signups) || 0)),
      payingReferrals: Math.max(0, Math.round(Number(c.stats && c.stats.payingReferrals) || 0)),
      earnedCents: Math.round(Number(c.stats && c.stats.earnedCents) || 0),
      balanceCents: Math.round(Number(c.stats && c.stats.balanceCents) || 0),
      paidOutCents: Math.round(Number(c.stats && c.stats.paidOutCents) || 0),
    };
  }

  /** Recomputes every creator's cached stats from the ledger; warns (C-RECON-001) when they disagreed. */
  reconcile(quiet) {
    for (const c of this.creators) {
      const rows = this.ledger.filter((e) => e.creatorId === c.id);
      let earned = 0, paidOut = 0, paying = 0, best = null, bestRank = -1;
      for (const e of rows) {
        if (e.type === 'commission') {
          earned += e.amountCents;
          if (!e.clawedBack) paying += 1;
        } else if (e.type === 'clawback') {
          earned += e.amountCents; // negative
        } else if (e.type === 'payout') {
          paidOut += -e.amountCents;
        }
        if (e.type === 'commission' && e.tierAtPost) {
          const r = rank(this.ladder(), e.tierAtPost);
          if (r > bestRank) { bestRank = r; best = e.tierAtPost; }
        }
      }
      const balance = earned - paidOut;
      const drifted = c.stats.earnedCents !== earned || c.stats.balanceCents !== balance || c.stats.paidOutCents !== paidOut;
      if (drifted && !quiet) {
        console.warn(`  ⚠️  Creator ${c.code}: cached stats disagreed with the ledger (C-RECON-001) — repaired from the ledger (earned ${c.stats.earnedCents}→${earned}, balance ${c.stats.balanceCents}→${balance}, paidOut ${c.stats.paidOutCents}→${paidOut}).`);
      }
      c.stats.earnedCents = earned;
      c.stats.balanceCents = balance;
      c.stats.paidOutCents = paidOut;
      // bestTier never demotes: it is the max tier any commission ever posted at.
      if (best && (!c.bestTier || rank(this.ladder(), best) > rank(this.ladder(), c.bestTier))) c.bestTier = best;
      if (paying > c.stats.payingReferrals) c.stats.payingReferrals = paying;
    }
  }

  // ----- lookups -----

  byCode(code) {
    const c = cleanCode(code);
    return this.creators.find((x) => x.code === c) || null;
  }

  byId(id) {
    return this.creators.find((x) => x.id === id) || null;
  }

  /** Active creator codes, for the metrics refValue allowlist. */
  activeCodes() {
    return this.creators.filter((c) => c.status === 'active').map((c) => c.code);
  }

  commissionEntry(subId) {
    return this.ledger.find((e) => e.type === 'commission' && e.subId === subId) || null;
  }

  // ----- create / edit / status -----

  async create({ name, handle, platform, code, note, viewerCode }, by) {
    const raw = cleanCode(code);
    if (!raw) throw httpError(400, 'Enter a creator code.');
    if (raw.length < 3) throw httpError(400, 'Creator codes need 3-32 letters, numbers or dashes.');
    // Junk that cleanCode would silently strip (spaces, symbols) is rejected, not silently repaired:
    // the stored code must be exactly what the staff member typed (uppercased).
    if (String(code).trim().toUpperCase() !== raw) throw httpError(400, 'Creator codes can only use letters, numbers and dashes.');
    if (RESERVED_CODES.includes(raw.toLowerCase())) throw httpError(409, `The code ${raw} is a reserved channel name. Pick another.`);
    if (this.byCode(raw)) throw httpError(409, `The code ${raw} is already in use by another creator.`);
    if (this.hooks.promoExists(raw)) throw httpError(409, `The code ${raw} is already a promo code. Pick another.`);
    const nm = stripControls(name).trim().slice(0, 40);
    if (!nm) throw httpError(400, 'Enter a name for this creator.');
    const c = {
      id: newId('cr'),
      name: nm,
      handle: stripControls(handle).trim().slice(0, 40),
      platform: stripControls(platform).trim().slice(0, 20),
      code: raw,
      status: 'active',
      note: stripControls(note).trim().slice(0, 200),
      viewerCode: null,
      bestTier: null,
      stats: { signups: 0, payingReferrals: 0, earnedCents: 0, balanceCents: 0, paidOutCents: 0 },
      createdBy: by || null,
      createdAt: Date.now(),
      disabledAt: null,
    };
    this.creators.push(c);
    // Optional viewer discount: minted through the billing promo machinery (note 'creator:<CODE>').
    if (viewerCode) c.viewerCode = await this.mintViewerPromo(c, viewerCode, by);
    await this.save();
    this.hooks.activity('people', by || 'Tree Host', `created creator ${c.code} (${nm})`);
    return this.row(c);
  }

  /** Mints (or re-points) the percent-off viewer promo for a creator via the injected hook. */
  async mintViewerPromo(c, { code, percentOff }, by) {
    const vc = cleanCode(code);
    if (!vc || vc.length < 4) throw httpError(400, 'Viewer codes need at least 4 letters or numbers.');
    const pct = Math.round(Number(percentOff));
    if (!(pct >= 1 && pct <= 99)) throw httpError(400, 'The viewer discount must be between 1 and 99 percent.');
    const promo = await this.hooks.createPromo({ code: vc, percentOff: pct, note: `creator:${c.code}`, maxUses: 10000 }, by);
    if (!promo) throw httpError(400, `The viewer code ${vc} could not be created (it may already exist as a promo).`);
    return promo.code;
  }

  /** Editable: name, handle, platform, note, and the viewer promo's percentOff + active flag. The code is IMMUTABLE. */
  async edit(code, patch = {}, by) {
    const c = this.byCode(code);
    if (!c) throw httpError(404, 'Creator not found');
    if (patch.name !== undefined) {
      const nm = stripControls(patch.name).trim().slice(0, 40);
      if (!nm) throw httpError(400, 'Enter a name for this creator.');
      c.name = nm;
    }
    if (patch.handle !== undefined) c.handle = stripControls(patch.handle).trim().slice(0, 40);
    if (patch.platform !== undefined) c.platform = stripControls(patch.platform).trim().slice(0, 20);
    if (patch.note !== undefined) c.note = stripControls(patch.note).trim().slice(0, 200);
    if (patch.viewerCode !== undefined) {
      const vc = patch.viewerCode || {};
      if (c.viewerCode && (vc.percentOff !== undefined || vc.active !== undefined)) {
        await this.hooks.updateViewerPromo(c.viewerCode, {
          percentOff: vc.percentOff !== undefined ? Math.round(Number(vc.percentOff)) : undefined,
          active: vc.active !== undefined ? !!vc.active : undefined,
        });
      } else if (!c.viewerCode && vc.code) {
        c.viewerCode = await this.mintViewerPromo(c, vc, by);
      }
    }
    await this.save();
    this.hooks.activity('people', by || 'Tree Host', `updated creator ${c.code}`);
    return this.row(c);
  }

  /** Disable / re-enable toggle. A disabled code resolves to 'other' and its viewer promo deactivates. */
  async setStatus(code, disabled, by) {
    const c = this.byCode(code);
    if (!c) throw httpError(404, 'Creator not found');
    const want = disabled ? 'disabled' : 'active';
    if (c.status !== want) {
      c.status = want;
      c.disabledAt = disabled ? Date.now() : null;
      if (c.viewerCode) await this.hooks.updateViewerPromo(c.viewerCode, { active: !disabled });
      await this.save();
      this.hooks.activity('people', by || 'Tree Host', `${disabled ? 'disabled' : 're-enabled'} creator ${c.code}`);
    }
    return this.row(c);
  }

  // ----- commission / clawback -----

  /**
   * Posts the first-payment commission for a sub (called from billing's was==='pending' branch).
   * Idempotent twice over (GAP-3): the sub's marker AND a ledger lookup by subId.
   */
  async postCommission(s) {
    try {
      if (!s || s.commissionPosted) return null;
      const user = this.hooks.userById(s.userId);
      const code = user && user.creatorCode;
      const c = code && this.byCode(code);
      if (!c || c.status !== 'active') return null; // disabled creators earn nothing new
      if (this.commissionEntry(s.id)) { s.commissionPosted = true; return null; }
      const paying = c.stats.payingReferrals + 1;
      const tier = tierFor(c.stats.payingReferrals, this.ladder()); // percent = tier at post time
      // The 5th paying referral posts at 10% and simultaneously promotes to Silver: bestTier
      // reads the count AFTER this payment (promote-only, never demoted by clawbacks).
      const newTier = tierFor(paying, this.ladder());
      const baseCents = Math.max(0, Math.round(Number(s.priceCents) || 0) - Math.max(0, Math.round(Number(s.discountCents) || 0)));
      const amount = Math.round((baseCents * tier.percent) / 100);
      const entry = {
        id: newId('le'),
        creatorId: c.id,
        at: Date.now(),
        type: 'commission',
        amountCents: amount,
        balanceAfterCents: c.stats.balanceCents + amount,
        subId: s.id,
        userId: s.userId || null,
        username: user ? (user.username || null) : null,
        planName: s.planName || null,
        priceCents: Math.round(Number(s.priceCents) || 0),
        discountCents: Math.max(0, Math.round(Number(s.discountCents) || 0)),
        percent: tier.percent,
        tierAtPost: tier.id,
      };
      this.ledger.push(entry);
      s.commissionPosted = true;
      c.stats.payingReferrals = paying;
      c.stats.earnedCents += amount;
      c.stats.balanceCents += amount;
      // Promote-only: bestTier is the highest tier ever reached, never demoted by clawbacks.
      if (!c.bestTier || rank(this.ladder(), newTier.id) > rank(this.ladder(), c.bestTier)) c.bestTier = newTier.id;
      await this.save();
      this.hooks.activity('billing', 'Tree Host', `commission of ${(amount / 100).toFixed(2)} USD posted to creator ${c.code} (${(paying)} paying referrals, ${tier.label})`);
      return entry;
    } catch (e) {
      console.error(`  ⚠️  Commission posting failed: ${e.message}`); // never throw into billing
      return null;
    }
  }

  /**
   * Reverses the exact original commission (charge.refunded). Balance may go negative; the
   * payingReferrals count and tiers are never touched. No commission entry → no-op.
   */
  async clawback(s) {
    try {
      if (!s) return null;
      const entry = this.commissionEntry(s.id);
      if (!entry || entry.clawedBack) return null;
      const c = this.byId(entry.creatorId);
      if (!c) return null;
      entry.clawedBack = true;
      const undo = {
        id: newId('le'),
        creatorId: c.id,
        at: Date.now(),
        type: 'clawback',
        amountCents: -entry.amountCents,
        balanceAfterCents: c.stats.balanceCents - entry.amountCents,
        subId: entry.subId,
        ofEntry: entry.id,
        percent: entry.percent,
        tierAtPost: entry.tierAtPost,
      };
      this.ledger.push(undo);
      c.stats.earnedCents -= entry.amountCents;
      c.stats.balanceCents -= entry.amountCents; // may go negative (payout already sent)
      await this.save();
      this.hooks.activity('billing', 'Tree Host', `clawed back ${(entry.amountCents / 100).toFixed(2)} USD from creator ${c.code} (refund of ${entry.planName || 'a payment'})`);
      return undo;
    } catch (e) {
      console.error(`  ⚠️  Clawback failed: ${e.message}`); // never throw into billing
      return null;
    }
  }

  // ----- payouts -----

  /**
   * Records a manual payout (staff sends the money outside the system; this documents it).
   * Guards (GAP-4): 400 on validation, 409 when the amount exceeds the balance or is negative.
   */
  async markPayout(code, { amountCents, method, reference, note } = {}, by) {
    const c = this.byCode(code);
    if (!c) throw httpError(404, 'Creator not found');
    const amount = Math.round(Number(amountCents));
    if (!Number.isInteger(amount) || amount <= 0) throw httpError(400, 'Enter a payout amount greater than zero.');
    if (!PAYOUT_METHODS.includes(method)) throw httpError(400, 'Choose a payout method: PayPal, bank transfer or gift card.');
    const ref = stripControls(reference).trim().slice(0, 100);
    if (!ref) throw httpError(400, 'Enter a payment reference (transaction id, IBAN last 4, or card code).');
    if (amount > c.stats.balanceCents) throw httpError(409, `That is more than the creator's balance of ${(c.stats.balanceCents / 100).toFixed(2)}. Payouts are capped at the balance.`);
    const text = stripControls(note).trim().slice(0, 200);
    const entry = {
      id: newId('le'),
      creatorId: c.id,
      at: Date.now(),
      type: 'payout',
      amountCents: -amount,
      balanceAfterCents: c.stats.balanceCents - amount,
      method,
      reference: ref,
      by: by || null,
      note: text || undefined,
    };
    this.ledger.push(entry);
    c.stats.balanceCents -= amount;
    c.stats.paidOutCents += amount;
    await this.save();
    this.hooks.activity('billing', by || 'Tree Host', `marked a ${(amount / 100).toFixed(2)} USD ${PAYOUT_METHOD_LABELS[method]} payout to creator ${c.code} (ref ${ref})`);
    return entry;
  }

  /** Newest-first ledger page for one creator, capped at 500, with a ?before=<entryId> cursor. */
  ledgerFor(code, { before, limit = LEDGER_PAGE } = {}) {
    const c = this.byCode(code);
    if (!c) return null;
    let rows = this.ledger.filter((e) => e.creatorId === c.id).sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
    if (before) {
      const cut = rows.findIndex((e) => e.id === before);
      if (cut >= 0) rows = rows.slice(cut + 1);
    }
    const max = Math.max(1, Math.min(LEDGER_PAGE, Math.round(Number(limit) || LEDGER_PAGE)));
    const page = rows.slice(0, max);
    return {
      creator: { code: c.code, tier: tierFor(c.stats.payingReferrals, this.ladder()).id, balanceCents: c.stats.balanceCents },
      entries: page.map((e) => ({
        id: e.id, at: e.at, type: e.type, amountCents: e.amountCents, balanceAfterCents: e.balanceAfterCents,
        detail: e.type === 'commission' ? {
          subId: e.subId, username: e.username, planName: e.planName,
          priceCents: e.priceCents, discountCents: e.discountCents, percent: e.percent, tierAtPost: e.tierAtPost,
        } : { method: e.method, reference: e.reference, by: e.by, note: e.note || undefined, subId: e.subId || undefined },
      })),
      hasMore: rows.length > page.length,
      cursor: page.length ? page[page.length - 1].id : null,
    };
  }

  /** Per-creator funnel: link pageviews + signups from the metrics maps, payments/earned from own stats. */
  funnelFor(c) {
    const maps = this.hooks.metricsMaps() || {};
    const pvRef = maps.pvRef || {};
    const signupRef = maps.signupRef || {};
    const code = (c.code || '').toUpperCase();
    return {
      linkPageviews: Math.round(Number(pvRef[code]) || 0),
      signups: Math.round(Number(signupRef[code]) || 0) || Math.round(Number(c.stats.signups) || 0),
      firstPayments: c.stats.payingReferrals,
      earnedCents: c.stats.earnedCents,
    };
  }

  // ----- public / staff views -----

  /** Public lookup: aggregates only. Unknown AND disabled codes both get the same { found: false } (GAP-1). */
  lookup(code) {
    const c = this.byCode(code);
    if (!c || c.status !== 'active') return { found: false };
    const tier = tierFor(c.stats.payingReferrals, this.ladder());
    const vp = c.viewerCode ? this.hooks.viewerPromo(c.viewerCode) : null;
    const maps = this.hooks.metricsMaps() || {};
    const signupRef = maps.signupRef || {};
    const recent = this.ledger
      .filter((e) => e.creatorId === c.id)
      .sort((a, b) => b.at - a.at)
      .slice(0, 5)
      .map((e) => ({
        at: e.at,
        amountCents: e.amountCents,
        label: e.type === 'commission' ? `First payment · ${e.planName || 'a plan'}`
          : e.type === 'payout' ? `Payout sent (${PAYOUT_METHOD_LABELS[e.method] || e.method})` : 'Commission refunded',
      }));
    return {
      found: true,
      code: c.code,
      tier: { id: tier.id, label: tier.label, percent: tier.percent },
      stats: {
        signups: Math.round(Number(signupRef[c.code]) || 0) || c.stats.signups,
        payingReferrals: c.stats.payingReferrals,
        balanceCents: c.stats.balanceCents,
        paidOutCents: c.stats.paidOutCents,
      },
      recent,
      viewerCode: vp ? { code: c.viewerCode, percentOff: vp.percentOff, active: !!vp.active } : null,
      payoutHint: PAYOUT_HINT,
    };
  }

  /** Staff list: rows + totals + the ladder (spec §4). */
  adminList() {
    const ladder = this.ladder();
    const rows = this.creators.map((c) => this.row(c));
    const totals = {
      creators: rows.length,
      signups: rows.reduce((n, r) => n + r.stats.signups, 0),
      payingReferrals: rows.reduce((n, r) => n + r.stats.payingReferrals, 0),
      earnedCents: rows.reduce((n, r) => n + r.stats.earnedCents, 0),
      balanceCents: rows.reduce((n, r) => n + r.stats.balanceCents, 0),
    };
    return { creators: rows, totals, tiers: ladder };
  }

  /** One staff row (console table + detail view). */
  row(c) {
    const ladder = this.ladder();
    const tier = tierFor(c.stats.payingReferrals, ladder);
    const next = ladder.filter((t) => t.minPaying > c.stats.payingReferrals).sort((a, b) => a.minPaying - b.minPaying)[0] || null;
    const vp = c.viewerCode ? this.hooks.viewerPromo(c.viewerCode) : null;
    return {
      id: c.id,
      name: c.name,
      handle: c.handle,
      platform: c.platform,
      code: c.code,
      viewerCode: vp ? { code: c.viewerCode, percentOff: vp.percentOff, active: !!vp.active } : null,
      tier: { id: tier.id, label: tier.label, percent: tier.percent },
      bestTier: c.bestTier || tier.id,
      status: c.status,
      note: c.note,
      stats: {
        ...c.stats,
        nextTier: next ? next.id : null,
        nextTierAt: next ? next.minPaying : null,
      },
      funnel: this.funnelFor(c),
      ledgerCount: this.ledger.filter((e) => e.creatorId === c.id).length,
      createdBy: c.createdBy,
      createdAt: c.createdAt,
      disabledAt: c.disabledAt,
    };
  }

  // ----- public application + rate limits -----

  checkRate(keys, max) {
    const now = Date.now();
    for (const key of keys) {
      const recent = (this.attempts.get(key) || []).filter((t) => now - t < RATE_WINDOW);
      this.attempts.set(key, recent);
      if (recent.length >= max) throw httpError(429, 'Too many attempts. Try again in 15 minutes.');
    }
  }

  /** Records a rate-limit attempt (called after checkRate passed, like auth.recordFailure). */
  recordRate(key) {
    const now = Date.now();
    const recent = (this.attempts.get(key) || []).filter((t) => now - t < RATE_WINDOW);
    recent.push(now);
    this.attempts.set(key, recent);
  }

  checkLookupRate(ip) {
    this.checkRate([`lookup:${ip}`], LOOKUP_MAX);
    this.recordRate(`lookup:${ip}`);
  }

  /**
   * Public application. Never creates a creator record — a staff notice + activity entry
   * (and an email when mail is on) are the whole outcome. Message capped at 500 chars (GAP-6).
   */
  async apply({ name, handle, platform, message } = {}, ip) {
    this.checkRate([`apply:${ip}`], APPLY_MAX);
    this.recordRate(`apply:${ip}`);
    const nm = stripControls(name).trim().slice(0, 40);
    if (!nm) throw httpError(400, 'Enter your name.');
    const msg = stripControls(message).trim().slice(0, 500);
    if (!msg) throw httpError(400, 'Tell us a bit about your channel and audience.');
    const app = {
      at: Date.now(),
      name: nm,
      handle: stripControls(handle).trim().slice(0, 40),
      platform: stripControls(platform).trim().slice(0, 20),
      message: msg,
      reviewed: false,
    };
    this.applications.push(app);
    await this.save();
    this.hooks.notice({
      section: 'people', perm: 'users.view', title: 'New creator application',
      text: `${nm} (${app.platform || 'unknown platform'}, ${app.handle || 'no handle'}) applied to the creator program.`,
      link: 'creators',
    });
    this.hooks.activity('people', 'Tree Host', `new creator application from ${app.handle || nm} (${app.platform || 'unknown platform'})`);
    this.hooks.email('creatorApplication', app).catch(() => {});
    return { ok: true };
  }
}

module.exports = { Creators, TIER_LADDER, tierFor, RESERVED_CODES, PAYOUT_METHODS, PAYOUT_HINT };
