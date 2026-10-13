'use strict';
// Cookie-free analytics counters for Tree Host. Everything counted here is a number or a
// page path / hostname / ref label — never an IP, user agent, cookie or account identifier.
//
// Shapes saved to the `metrics` collection via store.save('metrics', ...):
//   { v: 1, totals: <bucket>, days: { 'YYYY-MM-DD': <bucket> }, recent: [...] }
// `totals` is never pruned (all-time numbers would silently decay if they came from pruned
// day buckets); day buckets are pruned at 180 days on save.
//
// Firebase RTDB rejects keys containing . $ # [ ] / — raw page paths ('/pricing') would make
// every save fail on a Firebase deployment while local JSON kept working. Every dynamic key
// (paths, referrer hosts, request hosts) goes through enc() and is decoded with dec() for
// display. enc/dec round-trip exactly.
//
// Page views: the server-side count in serveStatic() is authoritative. The client beacon
// (POST /api/metrics/event, beacon: true) is attribution + dedup only — if the same
// (day, path) was server-counted in the last 60 s (one page load = one GET + at most one
// beacon), the beacon adds referrer/ref data but never a second view. The server never sees
// a referrer (Referrer-Policy), so pvRef attribution comes from beacons only.

const store = require('./store');

const DAY_MS = 86400000;
const RECENT_CAP = 200;   // ring buffer of last events (debugging only)
const PRUNE_DAYS = 180;   // day buckets older than this are dropped on save
const DEDUP_MS = 60000;   // client beacon within this window of a server count = attribution only
const PATH_MAX = 120;     // longest path stored
const REFS = ['discord', 'youtube', 'reddit', 'serverlist'];
const COUNTERS = ['demoLaunched', 'demoCommand', 'signup', 'checkoutStarted', 'checkoutCompleted', 'donationStarted', 'donationCompleted', 'serverCreated'];
const EVENT_TYPES = ['pageview', ...COUNTERS];

// Reversible key transform: anything outside [A-Za-z0-9_-] becomes %xx, so '/' -> '%2f',
// '.' -> '%2e'. '%' itself encodes, so dec() can never mis-parse an encoded key.
function enc(key) {
  return String(key).replace(/[^A-Za-z0-9_-]/g, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

function dec(key) {
  return String(key).replace(/%([0-9a-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// n < 10 stays exact (honest near zero); n < 100 rounds to the nearest 5; >= 100 to the nearest 10.
function roundPublic(n) {
  n = Math.max(0, Math.round(Number(n) || 0));
  if (n < 10) return n;
  if (n < 100) return Math.round(n / 5) * 5;
  return Math.round(n / 10) * 10;
}

const normHost = (h) => String(h || '').toLowerCase().split(':')[0].trim();

// A plausible hostname: letters/digits/hyphens with at least one dot. Anything else (raw URLs
// with exotic schemes, garbage) is dropped — returns null.
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

// 'https://discord.com/xyz' -> 'discord.com'; 'javascript:alert(1)' -> null (dropped);
// same-site (referrer host equals the request host) -> 'direct'; absent -> 'direct'.
function referrerHostValue(raw, requestHost) {
  if (!raw) return 'direct';
  let h = String(raw).trim().toLowerCase();
  const m = h.match(/^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)/);
  if (m) {
    if (m[1] !== 'http' && m[1] !== 'https') return null;
    h = m[2].split('@').pop().split(':')[0];
  }
  if (!HOST_RE.test(h)) return null;
  if (requestHost && h === normHost(requestHost)) return 'direct';
  return h;
}

// '/pricing?x=1' -> '/pricing'. Must start with '/'; query string and fragment stripped;
// capped at PATH_MAX. Invalid -> null.
function normPath(p) {
  if (typeof p !== 'string') return null;
  const s = p.split('?')[0].split('#')[0].slice(0, PATH_MAX);
  return s.startsWith('/') ? s : null;
}

// Ref allowlist: discord/youtube/reddit/serverlist kept verbatim (lowercase); any other
// non-empty value is 'other' UNLESS creatorCodes is supplied and the uppercase-normalized
// input matches one case-insensitively — then the creator code itself (verbatim, uppercase).
// Absent/empty -> null (not recorded). Single-arg calls behave exactly as before.
function refValue(ref, { creatorCodes } = {}) {
  if (ref === undefined || ref === null) return null;
  const s = String(ref).trim().toLowerCase();
  if (!s) return null;
  if (REFS.includes(s)) return s;
  if (Array.isArray(creatorCodes) && creatorCodes.length) {
    const up = s.toUpperCase();
    const code = creatorCodes.find((c) => String(c || '').trim().toUpperCase() === up);
    if (code) return String(code).trim().toUpperCase();
  }
  return 'other';
}

function newBucket() {
  const b = { pv: {}, pvRef: {}, pvHost: {}, signupRef: {} };
  for (const c of COUNTERS) b[c] = 0;
  return b;
}

// Normalize whatever was loaded (missing fields, raw unencoded keys from older data, junk
// counters) into a clean bucket — mirrors the billing.js constructor pattern.
function normalizeBucket(raw) {
  const b = newBucket();
  raw = raw && typeof raw === 'object' ? raw : {};
  for (const c of COUNTERS) b[c] = Math.max(0, Math.round(Number(raw[c]) || 0));
  for (const mapName of ['pv', 'pvRef', 'pvHost', 'signupRef']) {
    const src = raw[mapName] && typeof raw[mapName] === 'object' ? raw[mapName] : {};
    for (const [k, v] of Object.entries(src)) {
      if (!k) continue;
      const n = Math.max(0, Math.round(Number(v) || 0));
      if (n > 0) b[mapName][enc(dec(k))] = n; // re-encode raw keys so every stored key is enc()-shaped
    }
  }
  return b;
}

function dayKey(t) {
  return new Date(t).toISOString().slice(0, 10);
}

const bump = (map, key, by = 1) => { map[enc(key)] = (map[enc(key)] || 0) + by; };

class Metrics {
  constructor() {
    this.v = 1;
    this.totals = newBucket();
    this.days = {};
    this.recent = [];
    this.serverCounts = new Map(); // 'day|enc(path)' -> last server-count ms (beacon dedup window)
  }

  async init() {
    const d = (await store.load('metrics')) || {};
    this.v = Number(d.v) || 1;
    this.totals = normalizeBucket(d.totals);
    this.days = {};
    for (const [day, bucket] of Object.entries(d.days && typeof d.days === 'object' ? d.days : {})) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(day)) this.days[day] = normalizeBucket(bucket);
    }
    this.recent = Array.isArray(d.recent) ? d.recent.slice(0, RECENT_CAP).filter((r) => r && typeof r === 'object') : [];
    return this;
  }

  save() {
    // Fire-and-forget: analytics must never block or break anything (a throwing store is
    // swallowed here, not by every caller). Day buckets are pruned on save; totals never.
    try {
      const cutoff = dayKey(Date.now() - PRUNE_DAYS * DAY_MS);
      const days = {};
      for (const day of Object.keys(this.days).sort()) {
        if (day >= cutoff) days[day] = this.days[day];
      }
      this.days = days;
      const snapshot = { v: this.v, totals: this.totals, days: this.days, recent: this.recent };
      Promise.resolve(store.save('metrics', snapshot)).catch(() => {});
    } catch {
      /* never propagate */
    }
  }

  bucket(day) {
    if (!this.days[day]) this.days[day] = newBucket();
    return this.days[day];
  }

  /** Count one event. Returns nothing, never throws, never awaits a save. */
  count(type, { path, ref, referrerHost, host, beacon } = {}) {
    try {
      if (!EVENT_TYPES.includes(type)) return;
      const now = Date.now();
      const day = dayKey(now);
      const rv = refValue(ref);
      let rh = null;
      let p = null;
      if (type === 'pageview') {
        p = normPath(path);
        if (!p) return;
        rh = referrerHostValue(referrerHost, host); // null for implausible referrers (dropped)
      }
      this.apply(day, type, p, rh, rv, host, beacon, now);
    } catch {
      /* never propagate */
    }
  }

  /** One counted event applied to its day bucket and the all-time totals. */
  apply(day, type, p, rh, rv, host, beacon, now) {
    const b = this.bucket(day);
    const t = this.totals;
    const key = p ? day + '|' + enc(p) : null;
    const last = key ? this.serverCounts.get(key) || 0 : 0;
    const deduped = type === 'pageview' && beacon && key && now - last < DEDUP_MS;
    if (type === 'pageview') {
      if (!deduped) {
        bump(b.pv, p);
        bump(t.pv, p);
        if (host) { bump(b.pvHost, normHost(host)); bump(t.pvHost, normHost(host)); }
        if (!beacon && key) this.serverCounts.set(key, now);
        this.pruneServerCounts(now);
      }
      if (rh) { bump(b.pvRef, rh); bump(t.pvRef, rh); }
      if (rv) { bump(b.signupRef, rv); bump(t.signupRef, rv); }
    } else {
      b[type] += 1;
      t[type] += 1;
      if (type === 'signup' && rv) { bump(b.signupRef, rv); bump(t.signupRef, rv); }
    }
    this.pushRecent({ t: now, type, path: p || undefined, ref: rv || undefined });
    this.save();
  }

  pushRecent(entry) {
    this.recent.push(entry);
    if (this.recent.length > RECENT_CAP) this.recent.splice(0, this.recent.length - RECENT_CAP);
  }

  pruneServerCounts(now) {
    if (this.serverCounts.size < 1000) return;
    for (const [k, t] of this.serverCounts) if (now - t > DEDUP_MS) this.serverCounts.delete(k);
  }

  /** Sum a counter across the last-7-days day buckets (week) or read the all-time total. */
  sum(counter, { week = false } = {}) {
    if (!week) return this.totals[counter] || 0;
    const cutoff = dayKey(Date.now() - 7 * DAY_MS);
    let n = 0;
    for (const [day, b] of Object.entries(this.days)) {
      if (day >= cutoff) n += b[counter] || 0;
    }
    return n;
  }

  /** Sum the pageview map over day buckets (week) or all-time totals. */
  pvSum({ week = false } = {}) {
    const total = (map) => Object.values(map).reduce((n, v) => n + v, 0);
    if (!week) return total(this.totals.pv);
    const cutoff = dayKey(Date.now() - 7 * DAY_MS);
    let n = 0;
    for (const [day, b] of Object.entries(this.days)) {
      if (day >= cutoff) n += total(b.pv);
    }
    return n;
  }

  decodeMap(m) {
    const out = {};
    for (const [k, v] of Object.entries(m || {})) out[dec(k)] = v;
    return out;
  }

  social({ foundingUnitsLeft = null, foundingCapTotal = null } = {}) {
    const out = {
      signupsThisWeek: roundPublic(this.sum('signup', { week: true })),
      signupsTotal: roundPublic(this.totals.signup || 0),
      serversLaunched: roundPublic((this.totals.demoLaunched || 0) + (this.totals.serverCreated || 0)),
      supporters: roundPublic(this.totals.donationCompleted || 0),
      rounded: true,
    };
    if (foundingUnitsLeft !== null && foundingUnitsLeft !== undefined) out.foundingUnitsLeft = roundPublic(foundingUnitsLeft);
    if (foundingCapTotal !== null && foundingCapTotal !== undefined) out.foundingCapTotal = foundingCapTotal;
    return out;
  }

  /** Staff console shape (spec §4): funnel week/total, last-8-weeks series, refs, pageviews. */
  adminSummary({ founding = null } = {}) {
    const funnel = {};
    for (const [key, counters] of Object.entries({
      demos: ['demoLaunched'], signups: ['signup'],
      paid: ['checkoutCompleted', 'donationCompleted'],
    })) {
      funnel[key] = {
        week: counters.reduce((n, c) => n + this.sum(c, { week: true }), 0),
        total: counters.reduce((n, c) => n + (this.totals[c] || 0), 0),
      };
    }
    // Visitors = page views, which live in the pv path maps rather than a scalar counter.
    funnel.visitors = { week: this.pvSum({ week: true }), total: this.pvSum() };
    // Demo command runs count toward the demos stage (spec: demo launched/command funnel).
    funnel.demos.week += this.sum('demoCommand', { week: true });
    funnel.demos.total += this.totals.demoCommand || 0;

    const weeks = [];
    const now = Date.now();
    for (let i = 7; i >= 0; i--) {
      const end = now - i * 7 * DAY_MS;
      const start = end - 7 * DAY_MS;
      const row = { start: dayKey(start), visitors: 0, demos: 0, signups: 0, paid: 0 };
      for (const [day, b] of Object.entries(this.days)) {
        if (day < dayKey(start) || day > dayKey(end - 1)) continue;
        row.visitors += Object.values(b.pv).reduce((n, v) => n + v, 0);
        row.demos += (b.demoLaunched || 0) + (b.demoCommand || 0);
        row.signups += b.signup || 0;
        row.paid += (b.checkoutCompleted || 0) + (b.donationCompleted || 0);
      }
      weeks.push(row);
    }

    const refs = this.decodeMap(this.totals.signupRef);
    const out = {
      funnel,
      weeks,
      refs,
      donations: { started: this.totals.donationStarted || 0, completed: this.totals.donationCompleted || 0 },
      checkouts: { started: this.totals.checkoutStarted || 0, completed: this.totals.checkoutCompleted || 0 },
      founding: founding || { sold: 0, capTotal: 25, unitsLeft: 25 },
      pageviewsByPath: this.decodeMap(this.totals.pv),
      recent: this.recent.slice(-50),
    };
    return out;
  }
}

module.exports = { Metrics, enc, dec, roundPublic, referrerHostValue, refValue, normPath, normHost, dayKey, REFS };
