'use strict';
// Live support chat: customers (and YouTubers) start a conversation from the dashboard's chat bubble, staff with
// "Answer support chats" (support.chat) answer it from the Staff Console. Messages reach both sides instantly through
// the dashboard's live connection (/api/events, see server.js); this file keeps the conversations themselves.
// Stored like the rest of the business data (store.js: Firebase Realtime Database plus a local copy).

const crypto = require('crypto');
const store = require('./store');

const MAX_TEXT = 2000;
const MAX_MESSAGES = 500; // per conversation (the oldest go first)
const MAX_CHATS = 3000; // kept in total (the oldest closed ones go first)
const MAX_OPEN_PER_USER = 3;
const err = (status, message) => Object.assign(new Error(message), { status });
const id = () => crypto.randomBytes(6).toString('hex');
const cleanText = (t, n) => String(t ?? '').replace(/\r/g, '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, n);

class SupportChat {
  constructor() {
    this.chats = [];
    this.rate = new Map(); // userId -> recent message times
  }

  async load() {
    const d = (await store.load('support-chats')) || {};
    this.chats = Array.isArray(d.chats) ? d.chats : Object.values(d.chats || {});
    for (const c of this.chats) c.messages = Array.isArray(c.messages) ? c.messages : Object.values(c.messages || {});
    return this;
  }

  save() {
    return store.save('support-chats', { chats: this.chats });
  }

  get(chatId) {
    const c = this.chats.find((x) => x.id === chatId);
    if (!c) throw err(404, 'That conversation no longer exists.');
    return c;
  }

  forUser(userId) {
    return this.chats.filter((c) => c.userId === userId).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** At most 12 messages a minute per person, so nobody floods the other side. */
  limit(userId) {
    const now = Date.now();
    const recent = (this.rate.get(userId) || []).filter((t) => now - t < 60000);
    if (recent.length >= 12) throw err(429, "You're sending messages very fast. Wait a moment, then try again.");
    recent.push(now);
    this.rate.set(userId, recent);
  }

  // ---------- customers ----------

  async create(user, { text, subject, serverId }) {
    text = cleanText(text, MAX_TEXT);
    if (!text) throw err(400, 'Write a message.');
    if (this.forUser(user.id).filter((c) => c.status !== 'closed').length >= MAX_OPEN_PER_USER) {
      throw err(400, `You already have ${MAX_OPEN_PER_USER} open conversations. Carry on in one of those, or close one first.`);
    }
    this.limit(user.id);
    const now = Date.now();
    const c = {
      id: id(),
      userId: user.id,
      username: user.username,
      subject: cleanText(subject, 80) || text.split('\n')[0].slice(0, 80),
      serverId: serverId ? String(serverId).slice(0, 64) : null,
      status: 'open', // open: waiting for staff · answered: staff replied last · closed
      assignedTo: null,
      assignedName: null,
      createdAt: now,
      updatedAt: now,
      readByCustomer: now,
      readByStaff: 0,
      messages: [{ id: id(), from: 'customer', userId: user.id, name: user.username, text, at: now }],
    };
    this.chats.push(c);
    this.trim();
    await this.save();
    return c;
  }

  // ---------- both sides ----------

  /** A message from the customer or from staff. `staff`: { id, username, roleLabel } or null. */
  async post(c, user, text, staff = null) {
    text = cleanText(text, MAX_TEXT);
    if (!text) throw err(400, 'Write a message.');
    this.limit(user.id);
    const now = Date.now();
    const m = { id: id(), from: staff ? 'staff' : 'customer', userId: user.id, name: user.username, ...(staff ? { roleLabel: staff.roleLabel } : {}), text, at: now };
    c.messages.push(m);
    if (c.messages.length > MAX_MESSAGES) c.messages.splice(0, c.messages.length - MAX_MESSAGES);
    if (staff) {
      c.status = 'answered';
      c.readByStaff = now;
      if (!c.assignedTo) Object.assign(c, { assignedTo: user.id, assignedName: user.username }); // answering claims it
    } else {
      c.status = 'open';
      c.readByCustomer = now;
    }
    c.updatedAt = now;
    await this.save();
    return m;
  }

  /** A line in the conversation from Tree Host itself ("Alex joined", "closed"...). */
  note(c, text) {
    const m = { id: id(), from: 'system', text, at: Date.now() };
    c.messages.push(m);
    c.updatedAt = m.at;
    return m;
  }

  async claim(c, staffUser) {
    if (c.assignedTo === staffUser.id) return null;
    Object.assign(c, { assignedTo: staffUser.id, assignedName: staffUser.username });
    const m = this.note(c, `${staffUser.username} from Tree Host support joined the chat.`);
    await this.save();
    return m;
  }

  async close(c, by) {
    if (c.status === 'closed') return null;
    c.status = 'closed';
    c.closedAt = Date.now();
    const m = this.note(c, `${by} closed the chat.`);
    await this.save();
    return m;
  }

  async reopen(c, by) {
    if (c.status !== 'closed') return null;
    c.status = 'open';
    const m = this.note(c, `${by} reopened the chat.`);
    await this.save();
    return m;
  }

  async read(c, side) {
    c[side === 'staff' ? 'readByStaff' : 'readByCustomer'] = Date.now();
    await this.save();
  }

  /** The oldest closed conversations go once there are too many. */
  trim() {
    if (this.chats.length <= MAX_CHATS) return;
    const closed = this.chats.filter((c) => c.status === 'closed').sort((a, b) => a.updatedAt - b.updatedAt);
    const drop = new Set(closed.slice(0, this.chats.length - MAX_CHATS).map((c) => c.id));
    this.chats = this.chats.filter((c) => !drop.has(c.id));
  }

  /** Everything about an account goes when the account does. */
  async removeUser(userId) {
    const before = this.chats.length;
    this.chats = this.chats.filter((c) => c.userId !== userId);
    if (this.chats.length !== before) await this.save();
  }

  // ---------- what each side sees ----------

  unreadFor(c, side) {
    const since = side === 'staff' ? c.readByStaff : c.readByCustomer;
    const other = side === 'staff' ? 'customer' : 'staff';
    return c.messages.filter((m) => m.from === other && m.at > since).length;
  }

  /** A conversation in a list (no messages). */
  summary(c, side) {
    const last = c.messages[c.messages.length - 1];
    return {
      id: c.id,
      subject: c.subject,
      status: c.status,
      userId: c.userId,
      username: c.username,
      serverId: c.serverId,
      assignedTo: c.assignedTo,
      assignedName: c.assignedName,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      unread: this.unreadFor(c, side),
      last: last ? { from: last.from, name: last.name, text: last.text.slice(0, 140), at: last.at } : null,
    };
  }

  full(c, side) {
    return { ...this.summary(c, side), messages: c.messages, readByCustomer: c.readByCustomer, readByStaff: c.readByStaff };
  }
}

module.exports = { SupportChat, MAX_TEXT };
