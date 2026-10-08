'use strict';
// Staff notifications: the things the team should look at (a new support chat, a payment that failed, a new sign-up,
// an appeal, a crash) shown in the Staff Console as a bell with a count, a count on each menu section, and a pop-up
// the moment it happens (server.js pushes each one over /api/events as a "staffnote" event).
// Each notice needs a permission, so people only hear about what their role can open (billing only for billing.view).
// Who has read what is kept per staff member. Stored like the rest of the business data (store.js).

const crypto = require('crypto');
const store = require('./store');

const MAX = 500;

// Which activity events (src/activity.js) become notices, and for whom. Return null to skip an event.
function fromActivity(e) {
  const t = e.text || '';
  if (e.kind === 'billing') {
    const title = /payment failed/.test(t) ? 'Payment failed'
      : /donated/.test(t) ? 'New donation'
        : /refunded/.test(t) ? 'Plan refunded'
          : /bought/.test(t) ? 'New plan bought'
            : /redeemed code/.test(t) ? 'Promo code used'
              : /canceled|ended/.test(t) ? 'Plan ending'
                : /given a free|gave .* free/.test(t) ? 'Free plan given'
                  : /deleted the server/.test(t) ? 'Server removed (plan ended)'
                    : 'Billing';
    return { section: 'billing', perm: 'billing.view', title, urgent: title === 'Payment failed' };
  }
  if (e.kind === 'people') {
    if (/started a support chat/.test(t)) return null; // sent as its own notice, with a link to the chat
    if (/^signed up$/.test(t)) return { section: 'people', perm: 'users.view', title: 'New sign-up' };
    if (/joined as|became a/.test(t)) return { section: 'people', perm: 'users.view', title: 'New team member' };
    return null;
  }
  if (e.kind === 'moderation') {
    if (!/^appealed /.test(t)) return null; // automatic fixes (a removed staff plugin put back) aren't worth a ping
    const num = (t.match(/TH-\d+/) || [])[0];
    return { section: 'actions', perm: 'moderation.view', title: 'New appeal', link: num ? `actions/${num}` : 'actions', urgent: true };
  }
  if (e.kind === 'crash') return { section: 'servers', perm: 'servers.viewAll', title: 'Server crashed' };
  if (e.kind === 'security') return { section: 'servers', perm: 'servers.viewAll', title: 'Malware blocked', urgent: true };
  return null;
}

class StaffNotices {
  constructor() {
    this.items = [];
    this.read = {}; // userId -> { all: time, sections: { billing: time, ... } }
    this.listeners = new Set();
  }

  async init() {
    const d = (await store.load('staff-notices')) || {};
    this.items = (Array.isArray(d.items) ? d.items : Object.values(d.items || {})).sort((a, b) => a.t - b.t);
    this.read = d.read || {};
    return this;
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => store.save('staff-notices', { items: this.items, read: this.read }).catch(() => {}), 1500);
  }

  /** Adds a notice: { section, perm, title, text, who, link?, urgent? }. */
  add(n) {
    const item = {
      id: crypto.randomBytes(6).toString('hex'),
      t: Date.now(),
      section: n.section,
      perm: n.perm,
      title: n.title,
      text: n.text || '',
      who: n.who || '',
      link: n.link || n.section,
      urgent: !!n.urgent,
    };
    this.items.push(item);
    if (this.items.length > MAX) this.items.splice(0, this.items.length - MAX);
    this.save();
    for (const fn of this.listeners) fn(item);
    return item;
  }

  /** Called for every activity event: adds a notice if the team should hear about it. */
  onActivity(e) {
    const m = fromActivity(e);
    if (!m) return null;
    return this.add({ ...m, who: e.who, text: `${e.who} ${e.text}${e.serverName && m.section === 'servers' ? ` (${e.serverName})` : ''}` });
  }

  isUnread(userId, n) {
    const r = this.read[userId] || {};
    return n.t > Math.max(r.all || 0, (r.sections || {})[n.section] || 0);
  }

  /** The notices this person may see (newest first), how many are unread, and the unread count per section. */
  forUser(user, can, limit = 60) {
    const mine = this.items.filter((n) => can(user, n.perm));
    const sections = {};
    let unread = 0;
    for (const n of mine) {
      if (!this.isUnread(user.id, n)) continue;
      unread++;
      sections[n.section] = (sections[n.section] || 0) + 1;
    }
    return { items: mine.slice(-limit).reverse().map((n) => ({ ...n, perm: undefined, unread: this.isUnread(user.id, n) })), unread, sections };
  }

  /** Marks everything read, or only one section (opening Billing clears the billing count). */
  markRead(userId, section) {
    const r = (this.read[userId] = this.read[userId] || { all: 0, sections: {} });
    r.sections = r.sections || {};
    if (section) r.sections[section] = Date.now();
    else r.all = Date.now();
    this.save();
  }
}

module.exports = { StaffNotices, fromActivity };
