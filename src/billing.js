'use strict';
// Plans and subscriptions. Each subscription pays for one server with a fixed amount of memory, CPU and disk.
// Payments go through Stripe Checkout (monthly subscriptions); customers manage cards and cancel in Stripe's portal.
// Without STRIPE_SECRET_KEY, BILLING_DEMO=1 activates plans instantly so everything can be tested.
const os = require('os');
const crypto = require('crypto');
const store = require('./store');

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const DEMO = !STRIPE_KEY && process.env.BILLING_DEMO === '1';
const CURRENCY = (process.env.BILLING_CURRENCY || 'usd').toLowerCase();
const GRACE_DAYS = Number(process.env.BILLING_GRACE_DAYS) || 3; // a failed payment keeps the server running this long
const DELETE_AFTER_DAYS = Number(process.env.DELETE_AFTER_DAYS) || 14; // canceled servers are deleted after this
// Memory a server's Java process needs on top of its heap (the container limit is heap + this).
const OVERHEAD_MB = 384;

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

const DEFAULT_PLANS = [
  { id: 'sapling', name: 'Sapling', ramMb: 2048, cpus: 1, diskGb: 15, priceCents: 500, description: 'Small survival worlds and plugin testing, about 1-5 players.', active: true },
  { id: 'oak', name: 'Oak', ramMb: 4096, cpus: 2, diskGb: 30, priceCents: 900, description: 'Friends servers and light modpacks, about 5-20 players.', active: true },
  { id: 'redwood', name: 'Redwood', ramMb: 8192, cpus: 3, diskGb: 60, priceCents: 1600, description: 'Communities and bigger modpacks, about 20-60 players.', active: true },
];

// ---------- Stripe (no npm package) ----------

function formEncode(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.join('&');
}

async function stripe(method, pathname, params) {
  if (!STRIPE_KEY) throw httpError(400, 'Payments are not set up yet (STRIPE_SECRET_KEY).');
  const headers = { Authorization: `Bearer ${STRIPE_KEY}` };
  let url = `https://api.stripe.com/v1${pathname}`;
  let body;
  if (params && method === 'GET') url += `?${formEncode(params)}`;
  else if (params) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = formEncode(params);
  }
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(20000) });
  const json = await res.json();
  if (!res.ok) {
    // The details go to the server log; customers get a plain message.
    console.error(`[billing] payment provider error ${res.status} on ${method} ${pathname}: ${json.error ? json.error.message : ''}`);
    throw httpError(502, 'The payment service had a problem. Please try again in a minute, or contact billing if it keeps happening.');
  }
  return json;
}

/** Verifies the Stripe-Signature header (HMAC-SHA256 of "timestamp.body"). */
function verifyWebhook(rawBody, header) {
  if (!WEBHOOK_SECRET) throw httpError(400, 'STRIPE_WEBHOOK_SECRET is not set.');
  const parts = String(header || '').split(',');
  const t = Number((parts.find((p) => p.startsWith('t=')) || '').slice(2));
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) throw httpError(400, 'Webhook timestamp too old.');
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${rawBody}`).digest('hex');
  const ok = parts
    .filter((p) => p.startsWith('v1='))
    .map((p) => p.slice(3))
    .some((g) => g.length === expected.length && crypto.timingSafeEqual(Buffer.from(g), Buffer.from(expected)));
  if (!ok) throw httpError(400, 'Invalid webhook signature.');
  return JSON.parse(rawBody);
}

const STATUS = { active: 'active', trialing: 'active', past_due: 'past_due', unpaid: 'past_due', incomplete: 'pending', paused: 'past_due', canceled: 'canceled', incomplete_expired: 'canceled' };

/** The period end moved from the subscription to its items in newer Stripe API versions. */
const periodEnd = (s) => (s.current_period_end || (s.items && s.items.data && s.items.data[0] && s.items.data[0].current_period_end) || 0) * 1000 || null;
/** Same for an invoice's subscription. */
// ----- free plans & promo codes -----
const MONTH_MS = 30 * 86400000;
const DAY_MS = 86400000;
/**
 * How long a free plan lasts, in days; 0 = lifetime (never ends). Accepts { days } or the older { months }
 * (a month counts as 30 days), so codes made before stay valid.
 */
function toDays({ days, months } = {}) {
  if (days !== undefined && days !== null && days !== '') return Math.max(0, Math.min(3650, Math.round(Number(days) || 0)));
  return Math.max(0, Math.min(120, Math.round(Number(months) || 0))) * 30;
}
/** "lifetime", "1 year", "3 months", "2 weeks", "10 days" */
function durationText(days) {
  if (!days) return 'lifetime';
  const unit = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (days % 365 === 0) return unit(days / 365, 'year');
  if (days % 30 === 0) return unit(days / 30, 'month');
  if (days % 7 === 0) return unit(days / 7, 'week');
  return unit(days, 'day');
}
/** Fields for a free subscription that lasts `days` (0 = lifetime). */
function freeFields(days) {
  const until = days ? Date.now() + days * DAY_MS : null;
  return { free: true, priceCents: 0, freeUntil: until, periodEnd: until, freeDays: days };
}
const lengthText = (days) => (days ? ` for ${durationText(days)}` : ' (lifetime)');
/** Older codes stored months; newer ones store days. */
const promoDays = (p) => (p.days !== undefined ? p.days : (p.months || 0) * 30);
const cleanCode = (c) => String(c || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 32);
function randomCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I mix-ups
  const part = () => Array.from(crypto.randomBytes(4), (b) => abc[b % abc.length]).join('');
  return `TREE-${part()}-${part()}`;
}

const invoiceSub = (inv) => inv.subscription || (inv.parent && inv.parent.subscription_details && inv.parent.subscription_details.subscription) || null;

class Billing {
  constructor() {
    this.plans = DEFAULT_PLANS;
    this.subs = [];
    this.settings = { capacityMb: null };
    this.promos = [];
    this.hooks = {
      notify: () => {}, email: async () => {}, suspend: () => {}, unsuspend: () => {}, deleteServer: async () => {},
      userById: () => null,
    };
  }

  get mode() {
    return STRIPE_KEY ? (STRIPE_KEY.startsWith('sk_live_') || STRIPE_KEY.startsWith('rk_live_') ? 'live' : 'test') : DEMO ? 'demo' : 'off';
  }

  async init() {
    const d = (await store.load('plans')) || {};
    const plans = Object.values(d.plans || {});
    if (plans.length) this.plans = plans;
    this.settings = { ...this.settings, ...(d.settings || {}) };
    this.subs = Object.values((await store.load('subscriptions')) || {});
    this.promos = Object.values((await store.load('promos')) || {});
  }

  savePromos() {
    return store.save('promos', this.promos);
  }

  savePlans() {
    return store.save('plans', { plans: this.plans, settings: this.settings });
  }

  save() {
    return store.save('subscriptions', this.subs);
  }

  // ----- plans & capacity -----

  plan(id) {
    return this.plans.find((p) => p.id === id) || null;
  }

  publicPlans() {
    const free = this.freeMb();
    return {
      currency: CURRENCY,
      mode: this.mode,
      plans: this.plans
        .filter((p) => p.active)
        .map(({ id, name, ramMb, cpus, diskGb, priceCents, description }) => ({
          id, name, ramMb, cpus, diskGb, priceCents, description,
          soldOut: free < ramMb + OVERHEAD_MB,
        })),
    };
  }

  async setPlans(list) {
    if (!Array.isArray(list) || !list.length) throw httpError(400, 'Add at least one plan.');
    const clean = list.map((p) => {
      const id = String(p.id || p.name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
      if (!id) throw httpError(400, 'Every plan needs a name.');
      const plan = {
        id,
        name: String(p.name || id).slice(0, 40),
        ramMb: Math.round(Number(p.ramMb)),
        cpus: Math.max(0.5, Math.min(32, Number(p.cpus) || 1)),
        diskGb: Math.max(1, Math.round(Number(p.diskGb) || 10)),
        priceCents: Math.round(Number(p.priceCents)),
        description: String(p.description || '').slice(0, 200),
        active: p.active !== false,
      };
      if (!(plan.ramMb >= 512 && plan.ramMb <= 131072)) throw httpError(400, `${plan.name}: memory must be between 512 MB and 128 GB.`);
      if (!(plan.priceCents >= 0)) throw httpError(400, `${plan.name}: enter a price.`);
      return plan;
    });
    if (new Set(clean.map((p) => p.id)).size !== clean.length) throw httpError(400, 'Two plans have the same name.');
    this.plans = clean;
    await this.savePlans();
    return this.plans;
  }

  /** Memory this machine can sell: the setting, or everything except 2 GB for the system and Tree Host. */
  capacityMb() {
    return this.settings.capacityMb || Math.max(0, Math.floor(os.totalmem() / 1048576) - 2048);
  }

  soldMb() {
    return this.subs.filter((s) => ['active', 'past_due', 'pending'].includes(s.status)).reduce((n, s) => n + s.ramMb + OVERHEAD_MB, 0);
  }

  freeMb() {
    return this.capacityMb() - this.soldMb();
  }

  async setSettings({ capacityMb }) {
    if (capacityMb !== undefined) this.settings.capacityMb = capacityMb ? Math.max(1024, Math.round(Number(capacityMb))) : null;
    await this.savePlans();
    return this.adminSummary();
  }

  // ----- subscriptions -----

  sub(id) {
    return this.subs.find((s) => s.id === id) || null;
  }

  forUser(userId) {
    return this.subs.filter((s) => s.userId === userId && s.status !== 'pending').sort((a, b) => a.createdAt - b.createdAt);
  }

  /** A subscription can run its server while active, and for a few days after a failed payment. */
  usable(s) {
    if (!s) return false;
    if (s.status === 'active') return true;
    if (s.status === 'past_due') return Date.now() - (s.pastDueSince || Date.now()) < GRACE_DAYS * 86400000;
    return false;
  }

  publicSub(s) {
    return {
      id: s.id,
      planId: s.planId,
      planName: s.planName,
      ramMb: s.ramMb,
      cpus: s.cpus,
      diskGb: s.diskGb,
      priceCents: s.priceCents,
      currency: s.currency,
      status: s.status,
      usable: this.usable(s),
      free: !!s.free,
      serverId: s.serverId || null,
      renewsAt: s.periodEnd || null,
      freeUntil: s.freeUntil || null,
      freeLength: !s.free ? null : s.freeDays !== undefined ? durationText(s.freeDays) : s.freeUntil ? null : 'lifetime',
      promoCode: s.promoCode || null,
      cancelAtPeriodEnd: !!s.cancelAtPeriodEnd,
      pastDueSince: s.pastDueSince || null,
      canceledAt: s.canceledAt || null,
      deleteAt: s.canceledAt && s.serverId ? s.canceledAt + DELETE_AFTER_DAYS * 86400000 : null,
      createdAt: s.createdAt,
    };
  }

  newSub(user, plan, extra = {}) {
    const s = {
      id: `sub_${crypto.randomBytes(6).toString('hex')}`,
      userId: user.id,
      planId: plan.id,
      planName: plan.name,
      ramMb: plan.ramMb,
      cpus: plan.cpus,
      diskGb: plan.diskGb,
      priceCents: plan.priceCents,
      currency: CURRENCY,
      status: 'pending',
      serverId: null,
      createdAt: Date.now(),
      ...extra,
    };
    this.subs.push(s);
    return s;
  }

  /** Starts a purchase. Returns { url } to send the customer to (Stripe Checkout, or straight back in demo mode). */
  async checkout(user, planId, origin) {
    const plan = this.plan(planId);
    if (!plan || !plan.active) throw httpError(404, 'That plan is not available.');
    if (this.freeMb() < plan.ramMb + OVERHEAD_MB) throw httpError(409, `${plan.name} is sold out right now. Try a smaller plan or check back soon.`, 'SOLD_OUT');
    if (this.mode === 'off') throw httpError(400, 'Payments are not set up yet. Please check back soon.');
    // Abandoned checkouts don't hold capacity forever.
    this.subs = this.subs.filter((s) => !(s.status === 'pending' && Date.now() - s.createdAt > 86400000));
    const s = this.newSub(user, plan);
    if (this.mode === 'demo') {
      this.activate(s, { periodEnd: Date.now() + 30 * 86400000 });
      await this.save();
      return { url: `${origin}/dashboard?billing=success`, demo: true };
    }
    const session = await stripe('POST', '/checkout/sessions', {
      mode: 'subscription',
      success_url: `${origin}/dashboard?billing=success`,
      cancel_url: `${origin}/dashboard?billing=canceled`,
      client_reference_id: s.id,
      customer: user.stripeCustomerId || undefined,
      customer_email: user.stripeCustomerId ? undefined : user.email || undefined,
      allow_promotion_codes: 'true',
      metadata: { subId: s.id, userId: user.id },
      subscription_data: { metadata: { subId: s.id, userId: user.id, planId: plan.id } },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: CURRENCY,
            unit_amount: plan.priceCents,
            recurring: { interval: 'month' },
            product_data: { name: `Tree Host ${plan.name}: ${+(plan.ramMb / 1024).toFixed(1)} GB Minecraft server` },
          },
        },
      ],
    });
    s.checkoutSession = session.id;
    await this.save();
    return { url: session.url };
  }

  /** Stripe's customer portal: update card, see invoices, cancel. */
  async portal(user, origin) {
    if (!user.stripeCustomerId) throw httpError(400, 'You have no payments yet.');
    const s = await stripe('POST', '/billing_portal/sessions', { customer: user.stripeCustomerId, return_url: `${origin}/dashboard` });
    return { url: s.url };
  }

  activate(s, { periodEnd: pe } = {}) {
    const was = s.status;
    s.status = 'active';
    s.pastDueSince = null;
    if (pe) s.periodEnd = pe;
    if (was === 'pending') this.hooks.notify('billing', s, `bought a ${s.planName} server`);
    if (was === 'past_due' && s.serverId) this.hooks.unsuspend(s);
  }

  /**
   * Admins can give a plan for free (staff, partners, creators, giveaways).
   * days (or months): how long it lasts; 0 = lifetime. When it runs out, the plan ends like a canceled one.
   */
  async grant(user, planId, by, { months, days, note = '' } = {}) {
    const length = toDays({ days, months });
    const plan = this.plan(planId);
    if (!plan) throw httpError(404, 'Plan not found');
    const s = this.newSub(user, plan, { ...freeFields(length), grantedBy: by, note: String(note || '').slice(0, 100) || undefined });
    s.status = 'active';
    await this.save();
    this.hooks.notify('billing', s, `was given a free ${plan.name} plan by ${by}${lengthText(length)}`);
    return s;
  }

  // ----- promo codes (free plans for creators, partners, giveaways) -----

  promo(code) {
    return this.promos.find((p) => p.code === cleanCode(code)) || null;
  }

  publicPromo(p) {
    const plan = this.plan(p.planId);
    return {
      code: p.code,
      planId: p.planId,
      planName: plan ? plan.name : p.planId,
      days: promoDays(p),
      length: durationText(promoDays(p)),
      months: Math.round(promoDays(p) / 30),
      maxUses: p.maxUses,
      uses: p.uses.length,
      redeemedBy: p.uses.map((u) => ({ userId: u.userId, at: u.at })),
      note: p.note || '',
      forUserId: p.forUserId || null,
      expiresAt: p.expiresAt || null,
      active: p.active && !(p.expiresAt && Date.now() > p.expiresAt) && p.uses.length < p.maxUses,
      disabled: !p.active,
      createdBy: p.createdBy,
      createdAt: p.createdAt,
    };
  }

  /**
   * Creates a code. Leave `code` empty to get a random one like TREE-7K2P-QX9M.
   * forUserId: the code only works for that one account (and only once).
   */
  async createPromo({ code, planId, months, days, maxUses, note, expiresAt, forUserId }, by) {
    if (forUserId && !this.hooks.userById(forUserId)) throw httpError(404, 'That account does not exist.');
    const plan = this.plan(planId);
    if (!plan) throw httpError(400, 'Pick a plan for this code.');
    let c = cleanCode(code);
    if (code && c.length < 4) throw httpError(400, 'Codes need at least 4 letters or numbers.');
    if (!c) do c = randomCode(); while (this.promo(c));
    if (this.promo(c)) throw httpError(400, `The code ${c} already exists.`);
    const p = {
      code: c,
      planId: plan.id,
      days: toDays({ days, months }),
      maxUses: forUserId ? 1 : Math.max(1, Math.min(10000, Math.round(Number(maxUses) || 1))),
      forUserId: forUserId || null,
      note: String(note || '').slice(0, 100),
      expiresAt: expiresAt ? Number(new Date(expiresAt)) || null : null,
      active: true,
      uses: [],
      createdBy: by,
      createdAt: Date.now(),
    };
    this.promos.push(p);
    await this.savePromos();
    return this.publicPromo(p);
  }

  async disablePromo(code) {
    const p = this.promo(code);
    if (!p) throw httpError(404, 'Code not found');
    p.active = false;
    await this.savePromos();
    return this.publicPromo(p);
  }

  /** A customer enters a code in Billing and gets the free plan right away. */
  async redeem(user, code) {
    const p = this.promo(code);
    const nope = "That code doesn't work. Check the spelling, or ask whoever gave it to you.";
    if (!p || !p.active) throw httpError(404, nope);
    if (p.expiresAt && Date.now() > p.expiresAt) throw httpError(410, 'That code has expired.');
    if (p.uses.length >= p.maxUses) throw httpError(410, 'That code has already been used.');
    if (p.forUserId && p.forUserId !== user.id) throw httpError(403, 'This code is for a different account. Sign in with the account it was made for.');
    if (p.uses.some((u) => u.userId === user.id)) throw httpError(400, 'You already used this code.');
    const plan = this.plan(p.planId);
    if (!plan) throw httpError(410, 'The plan for this code no longer exists. Please contact support.');
    if (this.freeMb() < plan.ramMb + OVERHEAD_MB) throw httpError(409, `${plan.name} is full right now. Please try again soon or contact support.`, 'SOLD_OUT');
    const s = this.newSub(user, plan, { ...freeFields(promoDays(p)), promoCode: p.code, note: p.note || undefined });
    s.status = 'active';
    p.uses.push({ userId: user.id, subId: s.id, at: Date.now() });
    await Promise.all([this.save(), this.savePromos()]);
    this.hooks.notify('billing', s, `redeemed code ${p.code}: free ${plan.name}${lengthText(promoDays(p))}`);
    return s;
  }

  /** Cancels a subscription: in Stripe (at once) for paid ones. The server is stopped and later deleted. */
  async cancel(subId, by) {
    const s = this.sub(subId);
    if (!s) throw httpError(404, 'Subscription not found');
    if (s.stripeSubscriptionId && s.status !== 'canceled') await stripe('DELETE', `/subscriptions/${s.stripeSubscriptionId}`);
    this.markCanceled(s);
    await this.save();
    this.hooks.notify('billing', s, `subscription was canceled by ${by}`);
    return s;
  }

  markCanceled(s) {
    if (s.status === 'canceled') return;
    s.status = 'canceled';
    s.canceledAt = Date.now();
    if (s.serverId) this.hooks.suspend(s, 'canceled');
  }

  attachServer(subId, userId, serverId) {
    const s = this.sub(subId);
    if (!s || s.userId !== userId) throw httpError(404, 'Plan not found. Buy a plan first.');
    if (!this.usable(s)) throw httpError(402, 'This plan is not active. Check Billing.');
    if (s.serverId) throw httpError(400, 'This plan already has a server. Delete that server first, or buy another plan.');
    s.serverId = serverId;
    this.save().catch(() => {});
    return s;
  }

  detachServer(serverId) {
    for (const s of this.subs) if (s.serverId === serverId) s.serverId = null;
    this.save().catch(() => {});
  }

  // ----- Stripe webhook -----

  findByStripe(subscriptionId, meta) {
    return this.subs.find((s) => s.stripeSubscriptionId && s.stripeSubscriptionId === subscriptionId) || (meta && meta.subId ? this.sub(meta.subId) : null);
  }

  async webhook(rawBody, signature, users) {
    const event = verifyWebhook(rawBody, signature);
    const o = event.data.object;
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = this.sub(o.client_reference_id || (o.metadata && o.metadata.subId));
        if (!s) break;
        s.stripeSubscriptionId = o.subscription;
        s.stripeCustomerId = o.customer;
        const user = users.userById(s.userId);
        if (user && o.customer && !user.stripeCustomerId) {
          user.stripeCustomerId = o.customer;
          await users.save();
        }
        let pe = null;
        try {
          pe = periodEnd(await stripe('GET', `/subscriptions/${o.subscription}`));
        } catch {
          /* the subscription.updated event fills it in */
        }
        this.activate(s, { periodEnd: pe });
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const s = this.findByStripe(o.id, o.metadata);
        if (!s) break;
        s.stripeSubscriptionId = o.id;
        s.cancelAtPeriodEnd = !!o.cancel_at_period_end;
        s.periodEnd = periodEnd(o) || s.periodEnd;
        const st = event.type === 'customer.subscription.deleted' ? 'canceled' : STATUS[o.status] || 'past_due';
        if (st === 'active') this.activate(s);
        else if (st === 'past_due') this.markPastDue(s, users);
        else if (st === 'canceled') {
          this.markCanceled(s);
          this.hooks.notify('billing', s, 'subscription ended');
        }
        break;
      }
      case 'invoice.paid': {
        const s = this.findByStripe(invoiceSub(o));
        if (s && s.status !== 'canceled') this.activate(s);
        break;
      }
      case 'invoice.payment_failed': {
        const s = this.findByStripe(invoiceSub(o));
        if (s) this.markPastDue(s, users);
        break;
      }
      default:
        break;
    }
    await this.save();
    return { received: true };
  }

  markPastDue(s, users) {
    if (s.status === 'past_due' || s.status === 'canceled') return;
    s.status = 'past_due';
    s.pastDueSince = Date.now();
    this.hooks.notify('billing', s, `payment failed for the ${s.planName} plan`);
    const user = users.userById(s.userId);
    if (user) {
      this.hooks
        .email(user, 'Your Tree Host payment failed', [
          `Hi ${user.username}, we couldn't take the payment for your ${s.planName} server.`,
          `Your server keeps running for ${GRACE_DAYS} days. Please update your card in Billing to keep it online.`,
        ])
        .catch(() => {});
    }
  }

  /** Runs every few minutes: suspends servers whose grace period ran out and deletes long-canceled ones. */
  async tick() {
    // Free plans with an end date (creator codes, time-limited gifts) end like a canceled plan.
    for (const s of this.subs) {
      if (s.free && s.freeUntil && s.status === 'active' && Date.now() > s.freeUntil) {
        this.markCanceled(s);
        s.endedReason = 'free_period_over';
        await this.save();
        this.hooks.notify('billing', s, `free ${s.planName} plan ended`);
        const user = this.hooks.userById(s.userId);
        if (user && user.email) {
          await this.hooks.email(user, 'Your free Tree Host plan has ended', [
            `Hi ${user.username}, your free ${s.planName} plan has ended, so its server was stopped.`,
            `To keep your server and worlds, buy a plan in Billing within ${DELETE_AFTER_DAYS} days. After that the server is deleted.`,
          ]).catch(() => {});
        }
      }
    }
    for (const s of this.subs) {
      if (!s.serverId) continue;
      if (!this.usable(s)) this.hooks.suspend(s, s.status === 'canceled' ? 'canceled' : 'unpaid');
      if (s.status === 'canceled' && s.canceledAt && Date.now() - s.canceledAt > DELETE_AFTER_DAYS * 86400000) {
        const id = s.serverId;
        s.serverId = null;
        await this.save();
        await this.hooks.deleteServer(id, s).catch(() => {});
      }
    }
  }

  adminSummary() {
    const active = this.subs.filter((s) => s.status === 'active' || s.status === 'past_due');
    const mrr = {};
    for (const s of active) if (!s.free) mrr[s.currency] = (mrr[s.currency] || 0) + s.priceCents;
    return {
      mode: this.mode,
      currency: CURRENCY,
      capacityMb: this.capacityMb(),
      capacitySetting: this.settings.capacityMb,
      soldMb: this.soldMb(),
      totalMemMb: Math.floor(os.totalmem() / 1048576),
      activeCount: active.length,
      pastDueCount: active.filter((s) => s.status === 'past_due').length,
      mrr,
      graceDays: GRACE_DAYS,
      deleteAfterDays: DELETE_AFTER_DAYS,
      webhookReady: !!WEBHOOK_SECRET,
    };
  }
}

module.exports = { Billing, OVERHEAD_MB, durationText };
