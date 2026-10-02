'use strict';
// Moderation: warnings, suspensions, bans and deletions of accounts and servers. Every action gets a number
// (TH-000001) and a record: the reason, the message the customer saw, staff-only notes, evidence, who took it and
// when, a snapshot of the customer, the appeal and its outcome. The record becomes a PDF report for staff.
// Also the customer inbox: messages from Tree Host (action notices, appeal outcomes, messages from staff).
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const { DATA } = require('./paths');
const { PdfDoc } = require('./pdf');

const EVIDENCE_DIR = path.join(DATA, 'moderation-evidence');
const TYPES = { warn: 'Warning', suspend: 'Suspension', ban: 'Ban', delete: 'Deletion' };
const REASONS = {
  abuse: 'Harassment or abuse',
  cheating: 'Cheats, hacks or exploits',
  mining: 'Crypto mining',
  attack: 'Attacks, DDoS or scanning',
  illegal: 'Illegal or harmful content',
  eula: 'Minecraft EULA violation',
  spam: 'Spam or advertising',
  fraud: 'Fraud or chargeback',
  evasion: 'Ban evasion',
  security: 'Security risk',
  request: 'Requested by the customer',
  other: 'Other',
};
const MAX_IMAGE = 4 * 1024 * 1024;
const MAX_TEXT = 300 * 1024;
const MAX_INBOX = 200; // per person

const httpError = (status, message) => Object.assign(new Error(message), { status });
const newId = () => crypto.randomBytes(6).toString('hex');
const list = (v) => (Array.isArray(v) ? v : Object.values(v || {}));
const fmt = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '');

class Moderation {
  constructor() {
    this.seq = 0;
    this.actions = new Map();
    this.messages = new Map();
  }

  async init() {
    const d = (await store.load('moderation')) || {};
    this.seq = Number(d.seq) || 0;
    for (const a of list(d.actions)) {
      // The Realtime Database drops empty arrays/objects: put them back.
      a.history = list(a.history);
      a.evidence = list(a.evidence);
      a.customer = a.customer || {};
      a.customer.plans = list(a.customer.plans);
      a.customer.servers = list(a.customer.servers);
      this.actions.set(a.id, a);
    }
    for (const m of list(d.messages)) this.messages.set(m.id, m);
  }

  save() {
    return store.save('moderation', {
      seq: this.seq,
      actions: Object.fromEntries(this.actions),
      messages: Object.fromEntries(this.messages),
    });
  }

  // ----- actions -----

  /**
   * Records a new action. data: { type, target, reason, message, notes, until, appealable, by, customer, server }.
   * Evidence is added afterwards with addEvidence().
   */
  async create(data) {
    if (!TYPES[data.type]) throw httpError(400, 'Pick what to do: warning, suspension, ban or deletion.');
    if (!REASONS[data.reason]) throw httpError(400, 'Pick a reason.');
    const message = String(data.message || '').trim().slice(0, 4000);
    if (message.length < 10) throw httpError(400, 'Write the message the customer will see (at least 10 characters): what they did and what happens now.');
    this.seq += 1;
    const id = `TH-${String(this.seq).padStart(6, '0')}`;
    const lasting = data.type === 'suspend' || data.type === 'ban';
    const a = {
      id,
      type: data.type,
      target: data.target,
      reason: data.reason,
      message,
      notes: String(data.notes || '').trim().slice(0, 8000),
      until: data.type === 'suspend' && data.until ? data.until : null,
      status: lasting ? 'active' : 'done',
      appealable: data.appealable !== false,
      appeal: null,
      lifted: null,
      by: data.by,
      createdAt: Date.now(),
      customer: data.customer || {},
      server: data.server || null,
      evidence: [],
      history: [{ at: Date.now(), by: data.by.username, text: `${TYPES[data.type]} of the ${data.target} taken` }],
      notified: { inbox: false, email: false },
    };
    this.actions.set(id, a);
    await this.save();
    return a;
  }

  get(id) {
    const a = this.actions.get(String(id || '').trim().toUpperCase());
    if (!a) throw httpError(404, `No action with the number ${id}.`);
    return a;
  }

  find(id) {
    return this.actions.get(String(id || '').trim().toUpperCase()) || null;
  }

  note(a, by, text) {
    a.history.push({ at: Date.now(), by, text });
  }

  /** Staff search: number, customer name/email, server name; filters by type, status and appeals. */
  search({ q = '', type = '', status = '', appeal = '' } = {}) {
    q = String(q).trim().toLowerCase();
    return [...this.actions.values()]
      .filter((a) => !type || a.type === type)
      .filter((a) => !status || a.status === status)
      .filter((a) => !appeal || (appeal === 'pending' ? a.appeal && a.appeal.status === 'pending' : !!a.appeal))
      .filter((a) => !q || [a.id, a.customer.username, a.customer.email, a.customer.id, a.server && a.server.name, a.server && a.server.id, a.by.username]
        .some((x) => String(x || '').toLowerCase().includes(q)))
      .sort((x, y) => y.createdAt - x.createdAt)
      .map((a) => this.summary(a));
  }

  summary(a) {
    return {
      id: a.id, type: a.type, typeLabel: TYPES[a.type], target: a.target, status: a.status, reason: a.reason, reasonLabel: REASONS[a.reason],
      createdAt: a.createdAt, until: a.until, by: a.by.username,
      customer: { id: a.customer.id, username: a.customer.username, email: a.customer.email },
      server: a.server ? { id: a.server.id, name: a.server.name } : null,
      appeal: a.appeal ? a.appeal.status : null, evidence: a.evidence.length,
    };
  }

  /** Everything, for staff (evidence without file contents; images are fetched one by one). */
  full(a) {
    return { ...a, typeLabel: TYPES[a.type], reasonLabel: REASONS[a.reason] };
  }

  /** What the customer may see: never staff notes, evidence or who took the action. */
  forCustomer(a) {
    return {
      id: a.id, type: a.type, typeLabel: TYPES[a.type], target: a.target, status: a.status, reasonLabel: REASONS[a.reason], message: a.message,
      createdAt: a.createdAt, until: a.until, server: a.server ? { id: a.server.id, name: a.server.name } : null,
      appealable: a.appealable && !a.appeal && a.status !== 'lifted' && a.status !== 'expired',
      appeal: a.appeal ? { status: a.appeal.status, text: a.appeal.text, at: a.appeal.at, response: a.appeal.response || '', decidedAt: a.appeal.decidedAt || null } : null,
      liftedAt: a.lifted ? a.lifted.at : null,
    };
  }

  forUser(userId) {
    return [...this.actions.values()].filter((a) => a.customer.id === userId).sort((x, y) => y.createdAt - x.createdAt);
  }

  /** Ends a suspension or ban (lifted by staff, an accepted appeal, or the end date passing). */
  async lift(a, by, reason, status = 'lifted') {
    if (a.status !== 'active') throw httpError(400, `${a.id} is not active any more.`);
    a.status = status;
    a.lifted = { at: Date.now(), by: by.username, reason: String(reason || '').slice(0, 2000) };
    this.note(a, by.username, status === 'expired' ? 'Ended on its end date' : `Lifted: ${a.lifted.reason || 'no reason given'}`);
    await this.save();
    return a;
  }

  /** Suspensions whose end date has passed. */
  expired() {
    const now = Date.now();
    return [...this.actions.values()].filter((a) => a.status === 'active' && a.until && a.until <= now);
  }

  // ----- evidence -----

  /** item: { kind: 'image'|'text'|'log'|'note', name, data (base64 JPEG for images), text } */
  async addEvidence(a, item, byName) {
    const kind = ['image', 'text', 'log', 'note'].includes(item.kind) ? item.kind : 'note';
    const ev = { id: newId(), kind, name: String(item.name || (kind === 'note' ? 'Note' : 'Evidence')).replace(/[^\w .()[\]-]/g, '_').slice(0, 120), addedBy: byName, addedAt: Date.now() };
    const dir = path.join(EVIDENCE_DIR, a.id);
    if (kind === 'image') {
      const buf = Buffer.from(String(item.data || ''), 'base64');
      if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) throw httpError(400, `"${ev.name}" is not a picture we can read. Use PNG, JPEG or WebP screenshots.`);
      if (buf.length > MAX_IMAGE) throw httpError(400, `"${ev.name}" is too big (4 MB at most).`);
      await fsp.mkdir(dir, { recursive: true });
      ev.file = `${ev.id}.jpg`;
      ev.size = buf.length;
      await fsp.writeFile(path.join(dir, ev.file), buf, { mode: 0o600 });
    } else {
      const text = String(item.text || '').slice(0, MAX_TEXT);
      if (!text.trim()) throw httpError(400, `"${ev.name}" is empty.`);
      if (kind === 'note') {
        ev.text = text.slice(0, 8000);
      } else {
        await fsp.mkdir(dir, { recursive: true });
        ev.file = `${ev.id}.txt`;
        ev.size = Buffer.byteLength(text);
        await fsp.writeFile(path.join(dir, ev.file), text, { mode: 0o600 });
      }
    }
    a.evidence.push(ev);
    await this.save();
    return ev;
  }

  async evidenceFile(a, eid) {
    const ev = a.evidence.find((e) => e.id === eid);
    if (!ev || !ev.file) throw httpError(404, 'No such evidence file.');
    return { ev, data: await fsp.readFile(path.join(EVIDENCE_DIR, a.id, ev.file)) };
  }

  // ----- inbox -----

  async message(userId, { title, body, actionId = null, kind = 'message', from = 'Tree Host' }) {
    const m = { id: newId(), userId, title: String(title).slice(0, 200), body: String(body || '').slice(0, 8000), actionId, kind, from, createdAt: Date.now(), read: false };
    this.messages.set(m.id, m);
    // Keep each inbox to a sensible size.
    const mine = [...this.messages.values()].filter((x) => x.userId === userId).sort((x, y) => y.createdAt - x.createdAt);
    for (const old of mine.slice(MAX_INBOX)) this.messages.delete(old.id);
    await this.save();
    return m;
  }

  inbox(userId) {
    return [...this.messages.values()].filter((m) => m.userId === userId).sort((x, y) => y.createdAt - x.createdAt);
  }

  async markRead(userId, id) {
    for (const m of this.messages.values()) if (m.userId === userId && (!id || m.id === id)) m.read = true;
    await this.save();
  }

  /** Deleting an account removes its inbox (the action records stay). */
  async dropInbox(userId) {
    for (const [id, m] of this.messages) if (m.userId === userId) this.messages.delete(id);
    await this.save();
  }

  // ----- PDF report -----

  async report(a, generatedBy) {
    const statusText = {
      active: a.until ? `Active until ${fmt(a.until)}` : 'Active',
      lifted: `Lifted ${fmt(a.lifted && a.lifted.at)}`,
      expired: `Ended ${fmt(a.lifted && a.lifted.at)}`,
      done: 'Done',
    }[a.status];
    const doc = new PdfDoc({
      kicker: 'TREE HOST · STAFF ACTION REPORT',
      title: `Action ${a.id}`,
      subtitle: `${TYPES[a.type]} of ${a.target === 'server' ? `the server "${(a.server || {}).name || ''}"` : `the account ${a.customer.username || ''}`} · ${fmt(a.createdAt)}`,
      header: `Tree Host · Action ${a.id} · Confidential`,
      footer: `CONFIDENTIAL · Tree Host staff only · Generated ${fmt(Date.now())} by ${generatedBy}`,
      docTitle: `Tree Host action ${a.id}`,
    });

    doc.heading('Summary');
    doc.table([
      ['Action number', a.id],
      ['Action', `${TYPES[a.type]} (${a.target})`],
      ['Status', statusText],
      ['Reason', REASONS[a.reason]],
      ['Taken on', fmt(a.createdAt)],
      ['Ends', a.type === 'suspend' ? (a.until ? fmt(a.until) : 'Not set (until lifted)') : a.type === 'ban' ? 'Permanent (until lifted)' : ''],
      ['Appeal', a.appeal ? `${a.appeal.status[0].toUpperCase()}${a.appeal.status.slice(1)}` : a.appealable ? 'Allowed, none sent' : 'Not allowed'],
      ['Customer told by', [a.notified.inbox && 'Tree Host inbox', a.notified.email && 'email'].filter(Boolean).join(' and ') || 'Not notified'],
    ]);

    doc.heading('Taken by');
    doc.table([
      ['Staff member', a.by.username],
      ['Role', a.by.roleLabel || a.by.role],
      ['Staff account ID', a.by.id],
      ['When', fmt(a.createdAt)],
    ]);

    const c = a.customer;
    doc.heading('Customer');
    doc.table([
      ['Username', c.username],
      ['Email', c.email || 'none'],
      ['Account ID', c.id],
      ['Role', c.roleLabel || c.role],
      ['Signed up', fmt(c.createdAt)],
      ['Last sign-in', fmt(c.lastLogin) || 'never'],
      ['Sign-in method', c.firebase ? 'Website sign-in (email or Google)' : 'Password'],
      ['Minecraft name', c.mcName || ''],
      ['Plans at the time', c.plans.length ? c.plans.join(', ') : 'none'],
      ['Servers at the time', c.servers.length ? c.servers.map((s) => `${s.name} (${s.type} ${s.version})`).join(', ') : 'none'],
      ['Earlier actions', c.previous && c.previous.length ? c.previous.join(', ') : 'none'],
    ]);

    if (a.server) {
      doc.heading('Server');
      doc.table([
        ['Name', a.server.name],
        ['Server ID', a.server.id],
        ['Software', `${a.server.type || ''} ${a.server.version || ''}`.trim()],
        ['Plan', a.server.plan || ''],
        ['Address', a.server.address || ''],
        ['Created', fmt(a.server.createdAt)],
      ]);
    }

    doc.heading('Reason');
    doc.box(a.message, { title: 'MESSAGE SHOWN TO THE CUSTOMER' });
    if (a.notes) doc.box(a.notes, { title: 'STAFF NOTES (NEVER SHOWN TO THE CUSTOMER)', fill: '#fff8e6', border: '#f0d48a' });

    doc.heading(`Evidence (${a.evidence.length})`);
    if (!a.evidence.length) doc.para('No evidence was attached.', { color: '#7a8590' });
    for (const [i, ev] of a.evidence.entries()) {
      doc.subheading(`${i + 1}. ${ev.name}`);
      doc.para(`${{ image: 'Screenshot', text: 'Text file', log: 'Server console log', note: 'Note' }[ev.kind]} · added by ${ev.addedBy} · ${fmt(ev.addedAt)}`, { size: 8.5, color: '#7a8590' });
      doc.space(4);
      if (ev.kind === 'note') doc.box(ev.text);
      else {
        let data = null;
        try {
          data = await fsp.readFile(path.join(EVIDENCE_DIR, a.id, ev.file));
        } catch {}
        if (!data) doc.para('(The file is missing from this machine.)', { color: '#b3261e' });
        else if (ev.kind === 'image') doc.image(data);
        else {
          const lines = data.toString('utf8').split('\n');
          const shown = lines.length > 600 ? lines.slice(-600) : lines;
          if (lines.length > 600) doc.para(`Last 600 of ${lines.length} lines:`, { size: 8.5, color: '#7a8590' });
          doc.mono(shown.join('\n'));
        }
      }
    }

    if (a.appeal) {
      doc.heading('Appeal');
      doc.table([
        ['Sent', fmt(a.appeal.at)],
        ['Outcome', a.appeal.status === 'pending' ? 'Waiting for a decision' : `${a.appeal.status === 'accepted' ? 'Accepted' : 'Denied'} by ${a.appeal.decidedBy} on ${fmt(a.appeal.decidedAt)}`],
      ]);
      doc.box(a.appeal.text, { title: "THE CUSTOMER'S APPEAL" });
      if (a.appeal.response) doc.box(a.appeal.response, { title: 'OUR ANSWER' });
    }

    if (a.lifted) {
      doc.heading(a.status === 'expired' ? 'Ended' : 'Lifted');
      doc.table([
        ['When', fmt(a.lifted.at)],
        ['By', a.lifted.by],
        ['Why', a.lifted.reason || (a.status === 'expired' ? 'The end date passed' : '')],
      ]);
    }

    doc.heading('Timeline');
    doc.table(a.history.map((h) => [fmt(h.at), `${h.text} (${h.by})`]), { labelWidth: 130, size: 9.5 });
    return doc.toBuffer();
  }
}

module.exports = { Moderation, TYPES, REASONS };
