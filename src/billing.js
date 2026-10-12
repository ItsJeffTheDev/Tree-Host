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

const money = (cents) => `${CURRENCY === 'usd' ? '$' : ''}${(cents / 100).toFixed(cents % 100 ? 2 : 0)}${CURRENCY === 'usd' ? '' : ` ${CURRENCY.toUpperCase()}`}`;
const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

const DEFAULT_PLANS = [
  { id: 'sapling', name: 'Sapling', ramMb: 2048, cpus: 1, diskGb: 15, priceCents: 500, description: 'Small survival worlds and plugin testing, about 1-5 players.', active: true },
  { id: 'oak', name: 'Oak', ramMb: 4096, cpus: 2, diskGb: 30, priceCents: 900, description: 'Friends servers and light modpacks, about 5-20 players.', active: true },
  { id: 'redwood', name: 'Redwood', ramMb: 8192, cpus: 3, diskGb: 60, priceCents: 1600, description: 'Communities and bigger modpacks, about 20-60 players.', active: true },
];
// A one-time purchase with a fixed number of servers and proxies (monthly plans have no server limit).
const LIFETIME_PLAN = {
  id: 'lifetime', name: 'Lifetime', oneTime: true, ramMb: 4096, proxyRamMb: 1024, cpus: 2, diskGb: 30,
  slots: { servers: 4, proxies: 2 }, prioritySupport: true, priceCents: 75000,
  description: 'Pay once, keep it forever: 4 servers of any type and version (4 GB each), 2 proxies and priority support.', active: true,
};
DEFAULT_PLANS.push(LIFETIME_PLAN);
// The launch pre-sale: the Lifetime perks at a founding price, hard-capped to the first buyers (the cap is a code
// constant; TREEHOST_FOUNDING_CAP overrides it for tests only).
const FOUNDING_PLAN = {
  id: 'founding-lifetime', name: 'Founding Lifetime', oneTime: true, ramMb: 4096, proxyRamMb: 1024, cpus: 2, diskGb: 30,
  slots: { servers: 4, proxies: 2 }, prioritySupport: true, priceCents: 19900, founding: true, capTotal: 25,
  description: 'Founding price, pay once, keep it forever: 4 servers of any type and version (4 GB each), 2 proxies and priority support. First 25 only.', active: true,
};
DEFAULT_PLANS.push(FOUNDING_PLAN);

/** Memory a plan (or subscription) holds on the machine: one server, or all the servers and proxies of a bundle. */
function reserveMb(p) {
  if (p.slots) return p.slots.servers * (p.ramMb + OVERHEAD_MB) + p.slots.proxies * ((p.proxyRamMb || 1024) + OVERHEAD_MB);
  return p.ramMb + OVERHEAD_MB;
}
const bundleFields = (p) => (p.oneTime || p.slots
  ? {
      oneTime: !!p.oneTime,
      slots: p.slots ? { servers: Math.max(0, Math.round(Number(p.slots.servers) || 0)), proxies: Math.max(0, Math.round(Number(p.slots.proxies) || 0)) } : undefined,
      proxyRamMb: p.slots ? Math.max(512, Math.round(Number(p.proxyRamMb) || 1024)) : undefined,
      prioritySupport: !!p.prioritySupport,
    }
  : {});

// What running Tree Host costs (the donate page's receipt) until staff edit it: the launch machine from the
// going-live plan and the DMCA agent fee. Staff add the rest (domain, email, the LLC) in the Staff Console.
const DEFAULT_COSTS = [
  { id: 'server', name: 'Game server (OVH RISE-S)', detail: 'Ryzen 7 9700X, 64 GB RAM, NVMe, DDoS protection: the machine every Minecraft server runs on', cents: 7700, period: 'month', status: 'unpaid' },
  { id: 'setup', name: 'Server setup fee', detail: "OVH's one-time fee to set up the machine", cents: 7700, period: 'once', status: 'unpaid' },
  { id: 'dmca', name: 'DMCA agent registration', detail: 'U.S. Copyright Office, renewed every 3 years', cents: 600, period: 'once', status: 'unpaid' },
];

// Other hosts' regular monthly prices (no first-month discounts), by memory in MB, checked on the date below.
// Sources: each host's own pricing page (Apex's blocks automated checks, so its prices come from 2026 reviews).
const DEFAULT_COMPETITORS_CHECKED = '2026-10-02';
const DEFAULT_COMPETITORS = [
  { name: 'Shockbyte', url: 'https://shockbyte.com/games/minecraft-server-hosting', note: '', flatCents: 0, prices: { 2048: 799, 4096: 1599, 8192: 3199 } },
  { name: 'Apex Hosting', url: 'https://apexminecrafthosting.com/pricing/', note: '', flatCents: 0, prices: { 2048: 799, 4096: 1499, 8192: 2799 } },
  { name: 'Sparked Host', url: 'https://sparkedhost.com/minecraft-server-hosting', note: '', flatCents: 0, prices: { 1024: 259, 2048: 518, 4096: 1036, 8192: 2072 } },
  { name: 'Realms (Java)', url: 'https://www.minecraft.net/en-us/realms', note: 'Up to 10 players, vanilla only', flatCents: 799, prices: {} },
];

// An unfinished checkout holds its memory this long (Stripe's checkout page expires after 30 minutes to match).
const PENDING_HOLD_MS = 35 * 60 * 1000;
/** Plans that use memory on the machine: paid ones, and checkouts started in the last 35 minutes. */
const holdsMemory = (s) => s.status === 'active' || s.status === 'past_due' || (s.status === 'pending' && Date.now() - s.createdAt < PENDING_HOLD_MS);

// The checkout wording customers agree to; bump it when that text changes (stored with each consent record).
const CONSENT_VERSION = '2026-10';

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
    this.settings = { capacityMb: null, foundingCredits: [] };
    this.promos = [];
    this.donations = [];
    this.hooks = {
      notify: () => {}, email: async () => {}, suspend: () => {}, unsuspend: () => {}, deleteServer: async () => {},
      userById: () => null,
      metric: () => {}, // funnel counters (set by server.js; fire-and-forget)
      serversOf: () => [], // [{ id, name, kind }] of the servers using a subscription (set by server.js)
      borrowedMb: () => 0, // memory used by running extra servers beyond what their plans reserve (set by server.js)
    };
  }

  get mode() {
    return STRIPE_KEY ? (STRIPE_KEY.startsWith('sk_live_') || STRIPE_KEY.startsWith('rk_live_') ? 'live' : 'test') : DEMO ? 'demo' : 'off';
  }

  async init() {
    const d = (await store.load('plans')) || {};
    const plans = Object.values(d.plans || {});
    if (plans.length) this.plans = plans.map((p) => (p.slots ? { ...p, slots: { servers: 0, proxies: 0, ...p.slots } } : p));
    this.settings = { ...this.settings, ...(d.settings || {}) };
    // Plans saved before the lifetime plan existed get it once (if it's removed later, it stays removed).
    if (plans.length && !this.settings.lifetimeAdded && !this.plans.some((p) => p.oneTime)) this.plans.push({ ...LIFETIME_PLAN });
    if (!this.settings.lifetimeAdded) {
      this.settings.lifetimeAdded = true;
      if (plans.length) await this.savePlans();
    }
    // Same for the founding plan: deployments whose saved plans predate it get it exactly once.
    if (plans.length && !this.settings.foundingAdded && !this.plans.some((p) => p.founding)) this.plans.push({ ...FOUNDING_PLAN });
    if (!this.settings.foundingAdded) {
      this.settings.foundingAdded = true;
      if (plans.length) await this.savePlans();
    }
    if (!Array.isArray(this.settings.foundingCredits)) this.settings.foundingCredits = [];
    this.subs = Object.values((await store.load('subscriptions')) || {});
    this.promos = Object.values((await store.load('promos')) || {});
    this.donations = Object.values((await store.load('donations')) || {});
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
        .map((p) => ({
          id: p.id, name: p.name, ramMb: p.ramMb, cpus: p.cpus, diskGb: p.diskGb, priceCents: p.priceCents, description: p.description,
          ...bundleFields(p),
          ...(p.founding ? { founding: true, unitsLeft: this.foundingUnitsLeft(), capTotal: this.foundingCap() } : {}),
          soldOut: p.founding ? this.foundingUnitsLeft() <= 0 : free < reserveMb(p) || (!!p.oneTime && this.lifetimeFull()),
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
        ...bundleFields(p),
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

  /** Memory this machine can sell: the setting, or about 90% of the RAM (the rest is for the system and Tree Host). */
  capacityMb() {
    return this.settings.capacityMb || Math.max(0, Math.floor((os.totalmem() / 1048576) * 0.9));
  }

  /** How many Lifetime plans this machine sells (each holds its memory forever). null = the default of 2, 0 = no limit. */
  lifetimePerNode() {
    const n = this.settings.lifetimePerNode;
    return n === null || n === undefined ? 2 : n;
  }

  /** A test site on localhost sells without limits unless capacity is set by hand (test purchases pile up there). */
  unlimited() {
    return !!this.testSite && !this.settings.capacityMb;
  }

  lifetimeFull() {
    if (this.testSite && (this.settings.lifetimePerNode === null || this.settings.lifetimePerNode === undefined)) return false;
    const cap = this.lifetimePerNode();
    // Founding purchases have their own cap (foundingCap), so they never count toward lifetimePerNode.
    return cap > 0 && this.subs.filter((s) => s.oneTime && s.planId !== 'founding-lifetime' && holdsMemory(s)).length >= cap;
  }

  /** How many Founding Lifetime plans can be sold (the code constant, TREEHOST_FOUNDING_CAP overrides it for tests). */
  foundingCap() {
    const env = Number(process.env.TREEHOST_FOUNDING_CAP);
    return env > 0 ? Math.floor(env) : (this.plan('founding-lifetime') || FOUNDING_PLAN).capTotal;
  }

  /** Founding units taken: active, past-due and pending (a checkout in progress holds its spot) purchases. */
  foundingSold() {
    return this.subs.filter((s) => s.planId === 'founding-lifetime' && holdsMemory(s)).length;
  }

  foundingUnitsLeft() {
    return Math.max(0, this.foundingCap() - this.foundingSold());
  }

  soldMb() {
    return this.subs.filter(holdsMemory).reduce((n, s) => n + reserveMb(s), 0);
  }

  /** Unsold memory, minus what running extra servers borrow from it right now. */
  freeMb() {
    if (this.unlimited()) return Number.MAX_SAFE_INTEGER;
    return this.capacityMb() - this.soldMb() - this.hooks.borrowedMb();
  }

  async setSettings({ capacityMb, lifetimePerNode }) {
    if (capacityMb !== undefined) this.settings.capacityMb = capacityMb ? Math.max(1024, Math.round(Number(capacityMb))) : null;
    if (lifetimePerNode !== undefined) {
      this.settings.lifetimePerNode = lifetimePerNode === null || lifetimePerNode === '' ? null : Math.max(0, Math.min(100, Math.round(Number(lifetimePerNode) || 0)));
    }
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

  /** Checkouts this customer started but Tree Host hasn't seen paid yet. */
  pendingFor(userId) {
    return this.subs.filter((s) => s.userId === userId && s.status === 'pending');
  }

  /** A subscription can run its server while active, and for a few days after a failed payment. */
  usable(s) {
    if (!s) return false;
    if (s.status === 'active') return true;
    if (s.status === 'past_due') return Date.now() - (s.pastDueSince || Date.now()) < GRACE_DAYS * 86400000;
    return false;
  }

  serversOf(s) {
    return this.hooks.serversOf(s) || [];
  }

  /** Can this subscription take one more server of this kind? Monthly plans: always. Bundles: up to their slots. */
  slotError(s, kind, exceptServerId = null) {
    if (!s.slots) return null;
    const used = this.serversOf(s).filter((x) => x.id !== exceptServerId);
    const proxy = kind === 'proxy';
    const have = used.filter((x) => (x.kind === 'proxy') === proxy).length;
    const max = proxy ? s.slots.proxies : s.slots.servers;
    if (have >= max) return `Your ${s.planName} plan includes ${max} ${proxy ? `prox${max === 1 ? 'y' : 'ies'}` : `server${max === 1 ? '' : 's'}`} and ${max === 1 ? 'it is' : 'all are'} in use. Delete one first.`;
    return null;
  }

  publicSub(s) {
    const servers = this.serversOf(s);
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
      servers,
      serverCount: servers.length,
      oneTime: !!s.oneTime,
      slots: s.slots || null,
      slotsUsed: s.slots ? { servers: servers.filter((x) => x.kind !== 'proxy').length, proxies: servers.filter((x) => x.kind === 'proxy').length } : null,
      proxyRamMb: s.proxyRamMb || null,
      prioritySupport: !!s.prioritySupport,
      renewsAt: s.periodEnd || null,
      freeUntil: s.freeUntil || null,
      freeLength: !s.free ? null : s.freeDays !== undefined ? durationText(s.freeDays) : s.freeUntil ? null : 'lifetime',
      promoCode: s.promoCode || null,
      cancelAtPeriodEnd: !!s.cancelAtPeriodEnd,
      pastDueSince: s.pastDueSince || null,
      canceledAt: s.canceledAt || null,
      deleteAt: s.canceledAt && servers.length ? s.canceledAt + DELETE_AFTER_DAYS * 86400000 : null,
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
      createdAt: Date.now(),
      ...bundleFields(plan),
      ...extra,
    };
    this.subs.push(s);
    return s;
  }

  /** Starts a purchase. Returns { url } to send the customer to (Stripe Checkout, or straight back in demo mode). */
  async checkout(user, planId, origin, consent) {
    const plan = this.plan(planId);
    if (!plan || !plan.active) throw httpError(404, 'That plan is not available.');
    if (this.freeMb() < reserveMb(plan)) throw httpError(409, `${plan.name} is sold out right now. Try a smaller plan or check back soon.`, 'SOLD_OUT');
    if (plan.founding && this.foundingSold() >= this.foundingCap()) {
      throw httpError(409, 'Every Founding Lifetime spot is taken. The launch fund and monthly plans are still open.', 'SOLD_OUT');
    }
    if (plan.oneTime && this.lifetimeFull()) throw httpError(409, `Every ${plan.name} spot on this machine is taken. Join the Discord to hear when more open.`, 'SOLD_OUT');
    if (this.mode === 'off') throw httpError(400, 'Payments are not set up yet. Please check back soon.');
    const c = consent || {};
    if (!plan.oneTime && !c.renewal) throw httpError(400, 'Please confirm that the plan renews every month until you cancel.', 'CONSENT');
    if (!c.adult) throw httpError(400, 'Please confirm you are 18 or older, or that a parent or guardian is paying.', 'CONSENT');
    if (!c.withdrawal) throw httpError(400, 'Please confirm the server can start right away.', 'CONSENT');
    // Abandoned checkouts don't hold capacity forever.
    this.subs = this.subs.filter((s) => !(s.status === 'pending' && Date.now() - s.createdAt > 86400000));
    const s = this.newSub(user, plan);
    // Proof of what the customer agreed to (auto-renewal laws ask for this; kept with the subscription).
    s.consent = {
      version: CONSENT_VERSION,
      at: Date.now(),
      ip: c.ip || null,
      userAgent: String(c.userAgent || '').slice(0, 300) || null,
      priceCents: plan.priceCents,
      currency: CURRENCY,
      renews: !plan.oneTime,
      adult: true,
      withdrawalWaived: true,
    };
    if (this.mode === 'demo') {
      this.hooks.metric('checkoutStarted');
      this.activate(s, plan.oneTime ? {} : { periodEnd: Date.now() + 30 * 86400000 });
      await this.save();
      return { url: `${origin}/dashboard?billing=success`, demo: true };
    }
    this.hooks.metric('checkoutStarted');
    if (plan.oneTime) {
      // Paid once: a normal payment, not a subscription.
      const session = await stripe('POST', '/checkout/sessions', {
        mode: 'payment',
        success_url: `${origin}/dashboard?billing=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/dashboard?billing=canceled`,
        client_reference_id: s.id,
        expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
        customer: user.stripeCustomerId || undefined,
        customer_email: user.stripeCustomerId ? undefined : user.email || undefined,
        customer_creation: user.stripeCustomerId ? undefined : 'always',
        metadata: { subId: s.id, userId: user.id, planId: plan.id },
        payment_intent_data: { metadata: { subId: s.id, userId: user.id, planId: plan.id } },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: CURRENCY,
              unit_amount: plan.priceCents,
              product_data: { name: `Tree Host ${plan.name}: ${plan.slots ? `${plan.slots.servers} servers + ${plan.slots.proxies} proxies, ` : ''}paid once` },
            },
          },
        ],
      });
      s.checkoutSession = session.id;
      await this.save();
      return { url: session.url };
    }
    const session = await stripe('POST', '/checkout/sessions', {
      mode: 'subscription',
      success_url: `${origin}/dashboard?billing=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/dashboard?billing=canceled`,
      client_reference_id: s.id,
      expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
      customer: user.stripeCustomerId || undefined,
      customer_email: user.stripeCustomerId ? undefined : user.email || undefined,
      allow_promotion_codes: 'true',
      custom_text: { submit: { message: `Renews automatically every month at the price above until you cancel. Cancel any time in Billing on Tree Host; you keep the plan until the end of the month you paid for.` } },
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
    if (was === 'pending') {
      // Counted only here, on the one transition into active: the Stripe webhook, the browser-side
      // confirm fallback, invoice.paid and demo mode all funnel through activate(), so a webhook
      // retry or a double-confirm can never count twice.
      this.hooks.metric('checkoutCompleted');
      this.hooks.notify('billing', s, `bought a ${s.planName} server`);
      if (this.hooks.sendEmail) this.hooks.sendEmail('planActive', this.hooks.userById(s.userId), s).catch(() => {});
    }
    if (s.planId === 'founding-lifetime' && (was === 'pending' || !this.settings.foundingCredits.some((c) => c.subId === s.id))) {
      // A founder badge for a founding purchase: a credit line the founders() totals read like a donation.
      this.settings.foundingCredits.push({ userId: s.userId, amountCents: s.priceCents, planId: s.planId, subId: s.id, at: Date.now() });
      this.savePlans().catch(() => {});
    }
    if (was === 'past_due' && this.serversOf(s).length) this.hooks.unsuspend(s);
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
    if (this.freeMb() < reserveMb(plan) || (plan.oneTime && this.lifetimeFull())) throw httpError(409, `${plan.name} is full right now. Please try again soon or contact support.`, 'SOLD_OUT');
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
    if (this.hooks.sendEmail) this.hooks.sendEmail('canceled', this.hooks.userById(s.userId), s).catch(() => {});
    return s;
  }

  markCanceled(s) {
    if (s.status === 'canceled') return;
    s.status = 'canceled';
    s.canceledAt = Date.now();
    if (this.serversOf(s).length) this.hooks.suspend(s, 'canceled');
  }

  attachServer(subId, userId, serverId) {
    const s = this.sub(subId);
    if (!s || s.userId !== userId) throw httpError(404, 'Plan not found. Buy a plan first.');
    if (!this.usable(s)) throw httpError(402, 'This plan is not active. Check Billing.');
    void serverId; // servers point at their plan (cfg.subscriptionId); a plan can have any number (bundles: up to their slots)
    return s;
  }

  detachServer(serverId) {
    for (const s of this.subs) if (s.serverId === serverId) s.serverId = null;
    this.save().catch(() => {});
  }

  /** A finished Stripe Checkout: activates its subscription (from the webhook, or when the customer comes back). */
  async completeCheckout(o, users) {
    const s = this.sub(o.client_reference_id || (o.metadata && o.metadata.subId));
    if (!s) return null;
    if (o.mode === 'payment') {
      // A one-time purchase (lifetime): paid in full, never renews.
      s.paymentIntent = o.payment_intent || null;
      s.stripeCustomerId = o.customer || null;
      const buyer = users.userById(s.userId);
      if (buyer && o.customer && !buyer.stripeCustomerId) {
        buyer.stripeCustomerId = o.customer;
        await users.save();
      }
      if (o.payment_status === 'paid') this.activate(s, {});
      return s;
    }
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
    return s;
  }

  /**
   * The customer is back from Stripe Checkout: ask Stripe whether it was paid instead of waiting for the webhook
   * (which can't reach a test site on localhost, and can arrive a few seconds late on the real one).
   */
  async confirmCheckout(user, sessionId, users) {
    if (!/^cs_[A-Za-z0-9_]+$/.test(String(sessionId || ''))) throw httpError(400, 'Unknown checkout.');
    const o = await stripe('GET', `/checkout/sessions/${sessionId}`);
    const s = this.sub(o.client_reference_id || (o.metadata && o.metadata.subId));
    if (!s || s.userId !== user.id) throw httpError(404, 'Unknown checkout.');
    if (s.status === 'pending' && o.status === 'complete' && (o.mode === 'subscription' || o.payment_status === 'paid')) {
      await this.completeCheckout(o, users);
      await this.save();
    }
    return s;
  }

  // ----- donations (the launch fund) -----

  /**
   * Founder tiers: what someone has given in total decides the badge they wear on every Tree Host server and on the
   * supporters wall. Cosmetic only. Staff can change the thresholds (settings.founderTiers).
   */
  founderTiers() {
    const t = this.settings.founderTiers || {};
    return [
      { id: 'legend', label: 'Legend', minCents: t.legend || 5000 },
      { id: 'founder', label: 'Founder', minCents: t.founder || 1000 },
      { id: 'supporter', label: 'Supporter', minCents: t.supporter || 100 },
    ];
  }

  tierFor(totalCents) {
    return this.founderTiers().find((t) => totalCents >= t.minCents) || null;
  }

  /**
   * Everyone who gave, added up per person (their account if they were signed in, else the Minecraft name they typed),
   * with the Minecraft name their badge goes on. userById: (id) => account (for its Minecraft name).
   */
  founders(userById = () => null) {
    const people = new Map();
    for (const d of this.donations) {
      if (d.status !== 'paid') continue;
      const user = d.userId ? userById(d.userId) : null;
      const mcName = (user && user.mcName) || d.mcName || '';
      const key = d.userId ? `u:${d.userId}` : mcName ? `m:${mcName.toLowerCase()}` : `d:${d.id}`;
      const p = people.get(key) || { mcName, name: d.name || '', totalCents: 0, since: d.paidAt, public: false };
      p.totalCents += d.amountCents;
      p.mcName = p.mcName || mcName;
      p.name = p.name || d.name || '';
      p.since = Math.min(p.since || d.paidAt, d.paidAt);
      p.public = p.public || (d.public && !d.hidden);
      people.set(key, p);
    }
    // Founding Lifetime purchases count toward the same totals, so a $199 founding buyer lands in the founder tier
    // (their badge is FOUNDER by definition — a founding buyer is a founder, whatever else they donated).
    for (const c of this.settings.foundingCredits || []) {
      if (!c.userId || !c.amountCents) continue;
      const user = userById(c.userId);
      const p = people.get(`u:${c.userId}`) || { mcName: (user && user.mcName) || '', name: (user && user.username) || '', totalCents: 0, since: c.at, public: false };
      p.totalCents += c.amountCents;
      p.mcName = p.mcName || ((user && user.mcName) || '');
      p.name = p.name || ((user && user.username) || '');
      p.since = Math.min(p.since || c.at, c.at);
      p.founding = true;
      people.set(`u:${c.userId}`, p);
    }
    const founderTier = () => this.founderTiers().find((t) => t.id === 'founder') || null;
    return [...people.values()].map((p) => ({ ...p, tier: p.founding ? founderTier() : this.tierFor(p.totalCents) })).filter((p) => p.tier);
  }

  saveDonations() {
    return store.save('donations', this.donations);
  }

  /** What the public donate page shows: the goal, the total and the supporters who chose to be listed. */
  donationSummary() {
    const g = this.settings.donationGoal || {};
    const paid = this.donations.filter((d) => d.status === 'paid');
    return {
      title: g.title || 'Launch fund',
      targetCents: g.targetCents || 0,
      raisedCents: paid.reduce((n, d) => n + d.amountCents, 0) + (g.extraCents || 0),
      count: paid.length + (g.extraCount || 0),
      siteCents: paid.reduce((n, d) => n + d.amountCents, 0), // through the website, so Stripe took its fee
      siteCount: paid.length,
      currency: CURRENCY,
      costs: this.costs(),
      supporters: paid
        .filter((d) => d.public && !d.hidden)
        .sort((a, b) => b.paidAt - a.paidAt)
        .slice(0, 24)
        .map((d) => {
          const total = paid.filter((x) => (d.userId ? x.userId === d.userId : d.mcName && x.mcName && x.mcName.toLowerCase() === d.mcName.toLowerCase()) || x === d)
            .reduce((n, x) => n + x.amountCents, 0);
          const tier = this.tierFor(total);
          return { name: d.name || 'Someone kind', message: d.hidden ? '' : d.message || '', at: d.paidAt, mcName: d.mcName || '', tier: tier ? tier.id : null };
        }),
      tiers: this.founderTiers().map((t) => ({ id: t.id, label: t.label, minCents: t.minCents })),
    };
  }

  /** Other hosts' regular monthly prices for the "compare your plan" chart. Staff keep them current in the Staff Console. */
  competitors() {
    return this.settings.competitors || { checkedAt: DEFAULT_COMPETITORS_CHECKED, hosts: DEFAULT_COMPETITORS };
  }

  async setCompetitors({ hosts, checkedAt }) {
    if (!Array.isArray(hosts)) throw httpError(400, 'Send a list of hosts.');
    const clean = (v, n) => String(v || '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, n);
    const list = hosts.slice(0, 12).map((h) => {
      const prices = {};
      for (const [mb, cents] of Object.entries(h.prices || {})) {
        const m = Math.round(Number(mb));
        const c = Math.round(Number(cents));
        if (m >= 512 && m <= 65536 && c > 0) prices[m] = c;
      }
      const host = {
        name: clean(h.name, 40),
        url: /^https:\/\/[^\s"'<>]+$/.test(String(h.url || '')) ? String(h.url).slice(0, 300) : '',
        note: clean(h.note, 120),
        flatCents: h.flatCents ? Math.max(0, Math.round(Number(h.flatCents))) : 0,
        prices,
      };
      if (!host.name) throw httpError(400, 'Every host needs a name.');
      return host;
    });
    this.settings.competitors = { checkedAt: /^\d{4}-\d{2}-\d{2}$/.test(String(checkedAt || '')) ? checkedAt : new Date().toISOString().slice(0, 10), hosts: list };
    await this.savePlans();
    return this.settings.competitors;
  }

  /** The costs of running Tree Host, shown as a receipt on the donate page. Staff edit them in the Staff Console. */
  costs() {
    return this.settings.costs || { updatedAt: null, items: DEFAULT_COSTS };
  }

  async setCosts(list) {
    if (!Array.isArray(list)) throw httpError(400, 'Send a list of costs.');
    const clean = (v, n) => String(v || '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, n);
    const items = list.slice(0, 40).map((c) => {
      const item = {
        id: clean(c.id, 20) || crypto.randomBytes(4).toString('hex'),
        name: clean(c.name, 60),
        detail: clean(c.detail, 160),
        cents: Math.max(0, Math.round(Number(c.cents) || 0)),
        period: ['month', 'year', 'once'].includes(c.period) ? c.period : 'month',
        status: ['paid', 'unpaid'].includes(c.status) ? c.status : 'unpaid',
      };
      if (!item.name) throw httpError(400, 'Every cost needs a name.');
      return item;
    });
    this.settings.costs = { updatedAt: Date.now(), items };
    await this.savePlans();
    return this.settings.costs;
  }

  /** Starts a donation: Stripe Checkout (one payment), or straight to "thank you" in demo mode. */
  async donate({ amountCents, name, message, listed, userId, mcName }, origin) {
    const amount = Math.round(Number(amountCents));
    if (!(amount >= 100 && amount <= 100000)) throw httpError(400, `Choose an amount between ${money(100)} and ${money(100000)}.`);
    if (this.mode === 'off') throw httpError(400, 'Donations are not set up yet.', 'NO_PAYMENTS');
    this.donations = this.donations.filter((d) => !(d.status === 'pending' && Date.now() - d.createdAt > 86400000));
    const d = {
      id: crypto.randomBytes(8).toString('hex'),
      amountCents: amount,
      currency: CURRENCY,
      name: String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40),
      message: String(message || '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 140),
      public: !!listed,
      userId: userId || null,
      // the Minecraft name their badge goes on (signed-in donors use their account's)
      mcName: /^[A-Za-z0-9_]{3,16}$/.test(String(mcName || '').trim()) ? String(mcName).trim() : '',
      status: 'pending',
      createdAt: Date.now(),
    };
    this.donations.push(d);
    if (this.mode === 'demo') {
      this.markDonationPaid(d, {});
      await this.saveDonations();
      return { url: `${origin}/donate?thanks=1`, demo: true };
    }
    const meta = { kind: 'donation', donationId: d.id };
    const session = await stripe('POST', '/checkout/sessions', {
      mode: 'payment',
      submit_type: 'donate',
      success_url: `${origin}/donate?thanks=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/donate`,
      client_reference_id: `donation-${d.id}`,
      expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
      metadata: meta,
      payment_intent_data: { metadata: meta, description: 'Donation to Tree Host' },
      line_items: [{ quantity: 1, price_data: { currency: CURRENCY, unit_amount: amount, product_data: { name: 'Donation to Tree Host' } } }],
    });
    d.checkoutSession = session.id;
    await this.saveDonations();
    return { url: session.url };
  }

  markDonationPaid(d, o) {
    if (d.status === 'paid') return;
    d.status = 'paid';
    d.paidAt = Date.now();
    d.paymentIntent = o.payment_intent || null;
    this.hooks.notify('billing', { userId: d.userId, donorName: d.name || 'Someone' }, `donated ${money(d.amountCents)}${d.name ? ` (as ${d.name})` : ''} to the launch fund`);
    if (this.hooks.donated) this.hooks.donated(d); // badges on servers, stream alert
  }

  /** Back from Stripe: ask whether the donation was paid (the webhook can't reach a test site on localhost). */
  async confirmDonation(sessionId) {
    if (!/^cs_[A-Za-z0-9_]+$/.test(String(sessionId || ''))) throw httpError(400, 'Unknown donation.');
    const o = await stripe('GET', `/checkout/sessions/${sessionId}`);
    const d = o.metadata && o.metadata.kind === 'donation' ? this.donations.find((x) => x.id === o.metadata.donationId) : null;
    if (!d) throw httpError(404, 'Unknown donation.');
    if (o.status === 'complete' && o.payment_status === 'paid') {
      this.markDonationPaid(d, o);
      await this.saveDonations();
    }
    return { status: d.status, amountCents: d.amountCents };
  }

  async setDonationGoal({ title, targetCents, extraCents, extraCount }) {
    const n = (v) => Math.max(0, Math.round(Number(v) || 0));
    this.settings.donationGoal = {
      title: String(title || '').trim().slice(0, 60) || 'Launch fund',
      targetCents: n(targetCents),
      extraCents: n(extraCents),
      extraCount: n(extraCount),
    };
    await this.savePlans();
    return this.donationSummary();
  }

  async setDonationHidden(id, hidden) {
    const d = this.donations.find((x) => x.id === id);
    if (!d) throw httpError(404, 'Donation not found');
    d.hidden = !!hidden;
    await this.saveDonations();
    return d;
  }

  // ----- Stripe webhook -----

  findByStripe(subscriptionId, meta) {
    return this.subs.find((s) => s.stripeSubscriptionId && s.stripeSubscriptionId === subscriptionId) || (meta && meta.subId ? this.sub(meta.subId) : null);
  }

  async webhook(rawBody, signature, users) {
    const event = verifyWebhook(rawBody, signature);
    const o = event.data.object;
    switch (event.type) {
      case 'checkout.session.completed':
        if (o.metadata && o.metadata.kind === 'donation') {
          const d = this.donations.find((x) => x.id === o.metadata.donationId);
          if (d && o.payment_status === 'paid') {
            this.markDonationPaid(d, o);
            await this.saveDonations();
          }
          break;
        }
        await this.completeCheckout(o, users);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const s = this.findByStripe(o.id, o.metadata);
        if (!s) break;
        s.stripeSubscriptionId = o.id;
        const wasCanceling = !!s.cancelAtPeriodEnd;
        s.cancelAtPeriodEnd = !!o.cancel_at_period_end;
        s.periodEnd = periodEnd(o) || s.periodEnd;
        const st = event.type === 'customer.subscription.deleted' ? 'canceled' : STATUS[o.status] || 'past_due';
        if (st === 'active') this.activate(s);
        else if (st === 'past_due') this.markPastDue(s, users);
        // Canceled in the Stripe portal: still active until the end of the paid month. Confirm it by email.
        if (s.cancelAtPeriodEnd && !wasCanceling && st !== 'canceled') {
          this.hooks.notify('billing', s, `canceled the ${s.planName} plan (active until the end of the month)`);
          if (this.hooks.sendEmail) this.hooks.sendEmail('canceled', users.userById(s.userId), s).catch(() => {});
        }
        else if (st === 'canceled' && s.status !== 'canceled') {
          this.markCanceled(s);
          this.hooks.notify('billing', s, 'subscription ended');
          if (this.hooks.sendEmail) this.hooks.sendEmail('planEnded', users.userById(s.userId), s).catch(() => {});
        }
        break;
      }
      case 'invoice.paid': {
        const s = this.findByStripe(invoiceSub(o));
        if (s && s.status !== 'canceled') this.activate(s);
        break;
      }
      case 'charge.refunded': {
        // A refunded donation leaves the total; a refunded one-time purchase ends its plan.
        const don = o.payment_intent && o.refunded ? this.donations.find((x) => x.paymentIntent === o.payment_intent) : null;
        if (don && don.status === 'paid') {
          don.status = 'refunded';
          await this.saveDonations();
        }
        const s = o.payment_intent ? this.subs.find((x) => x.paymentIntent === o.payment_intent) : null;
        if (s && o.refunded && s.status !== 'canceled') {
          this.markCanceled(s);
          // A refunded founding purchase takes the buyer's founder credit back with it.
          const before = this.settings.foundingCredits.length;
          this.settings.foundingCredits = this.settings.foundingCredits.filter((c) => c.subId !== s.id);
          if (this.settings.foundingCredits.length !== before) this.savePlans().catch(() => {});
          this.hooks.notify('billing', s, `${s.planName} purchase was refunded, so the plan ended`);
        }
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
      const servers = this.serversOf(s);
      if (!servers.length) continue;
      if (!this.usable(s)) this.hooks.suspend(s, s.status === 'canceled' ? 'canceled' : 'unpaid');
      if (s.status === 'canceled' && s.canceledAt && Date.now() - s.canceledAt > DELETE_AFTER_DAYS * 86400000) {
        for (const x of servers) await this.hooks.deleteServer(x.id, s).catch(() => {});
      }
    }
  }

  adminSummary() {
    const active = this.subs.filter((s) => s.status === 'active' || s.status === 'past_due');
    const mrr = {};
    const oneTime = {};
    for (const s of active) {
      if (s.free) continue;
      if (s.oneTime) oneTime[s.currency] = (oneTime[s.currency] || 0) + s.priceCents;
      else mrr[s.currency] = (mrr[s.currency] || 0) + s.priceCents;
    }
    return {
      mode: this.mode,
      currency: CURRENCY,
      capacityMb: this.capacityMb(),
      capacitySetting: this.settings.capacityMb,
      soldMb: this.soldMb(),
      borrowedMb: this.hooks.borrowedMb(),
      unlimited: this.unlimited(),
      lifetimePerNode: this.lifetimePerNode(),
      lifetimeSetting: this.settings.lifetimePerNode ?? null,
      totalMemMb: Math.floor(os.totalmem() / 1048576),
      activeCount: active.length,
      pastDueCount: active.filter((s) => s.status === 'past_due').length,
      mrr,
      oneTime,
      lifetimeCount: active.filter((s) => s.oneTime && s.planId !== 'founding-lifetime').length,
      graceDays: GRACE_DAYS,
      deleteAfterDays: DELETE_AFTER_DAYS,
      webhookReady: !!WEBHOOK_SECRET,
    };
  }
}

module.exports = { Billing, OVERHEAD_MB, durationText, reserveMb };
