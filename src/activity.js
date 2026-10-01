'use strict';
// Team activity feed ("who did what, when") plus Discord notifications for the events the team cares about.
const crypto = require('crypto');
const store = require('./store');

const MAX_EVENTS = 1000;

// Events a team can choose to get in Discord (keys match the "kind" of logged events).
const NOTIFY_KINDS = {
  crash: 'A server crashes',
  deploy: 'A plugin build is deployed',
  start: 'A server is started',
  stop: 'A server is stopped',
  claim: 'Someone starts or stops testing on a server',
  backup: 'A backup is made or restored',
  server: 'A server is created or deleted',
  people: 'Someone signs up or joins the staff',
  billing: 'A plan is bought, a payment fails or a plan ends',
};

const COLORS = { crash: 0xe5534b, deploy: 0x4a9eff, start: 0x34c77b, stop: 0x8b939e, claim: 0x46c37b, backup: 0xa970ff, server: 0x46c37b, people: 0x34c77b, billing: 0xf5b50a };

class Activity {
  constructor() {
    this.events = [];
    this.settings = { discordWebhook: '', kinds: { crash: true, deploy: true, people: true, claim: true, billing: true } };
    this.listeners = new Set();
  }

  async init() {
    this.events = Object.values((await store.load('activity')) || {});
    const st = (await store.load('notifications')) || {};
    this.settings = { ...this.settings, ...st, kinds: { ...this.settings.kinds, ...(st.kinds || {}) } };
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => store.save('activity', this.events).catch(() => {}), 2000);
  }

  /**
   * Records an event. kind: one of NOTIFY_KINDS (or 'other'); who: username or 'Tree Host';
   * server: an Instance (optional); text: human-readable sentence.
   */
  log(kind, who, text, server) {
    const e = {
      id: crypto.randomBytes(6).toString('hex'),
      t: Date.now(),
      kind,
      who: who || 'Tree Host',
      text,
      serverId: server ? server.cfg.id : null,
      serverName: server ? server.cfg.name : null,
      space: server ? server.cfg.space || 'team' : null,
      owner: server ? server.cfg.owner || null : null,
    };
    this.events.push(e);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.save();
    for (const fn of this.listeners) fn(e);
    // Solo and customer servers are private: never announce them in the staff Discord (crashes excepted for support).
    const privateSpace = e.space === 'solo' || (e.space === 'customer' && kind !== 'crash');
    if (this.settings.discordWebhook && this.settings.kinds[kind] && !privateSpace) this.discord(e).catch(() => {});
    return e;
  }

  async discord(e) {
    await fetch(this.settings.discordWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Tree Host',
        embeds: [
          {
            description: `**${e.who}** ${e.text}${e.serverName ? `\nServer: **${e.serverName}**` : ''}`,
            color: COLORS[e.kind] || 0x46c37b,
            timestamp: new Date(e.t).toISOString(),
          },
        ],
      }),
      signal: AbortSignal.timeout(10000),
    });
  }

  async setSettings({ discordWebhook, kinds }) {
    if (discordWebhook !== undefined) {
      const url = String(discordWebhook || '').trim();
      if (url && !/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(url)) {
        throw Object.assign(new Error('That is not a Discord webhook link (https://discord.com/api/webhooks/...).'), { status: 400 });
      }
      this.settings.discordWebhook = url;
    }
    if (kinds && typeof kinds === 'object') {
      for (const k of Object.keys(NOTIFY_KINDS)) if (kinds[k] !== undefined) this.settings.kinds[k] = !!kinds[k];
    }
    await store.save('notifications', this.settings);
    return this.publicSettings();
  }

  publicSettings() {
    return { discordConnected: !!this.settings.discordWebhook, kinds: this.settings.kinds, available: NOTIFY_KINDS };
  }

  async testDiscord(who) {
    if (!this.settings.discordWebhook) throw Object.assign(new Error('Add a Discord webhook link first.'), { status: 400 });
    const res = await fetch(this.settings.discordWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Tree Host', content: `👋 Test message from Tree Host, sent by **${who}**. Notifications are working!` }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw Object.assign(new Error(`Discord answered ${res.status}. Check the webhook link.`), { status: 400 });
  }
}

module.exports = { Activity, NOTIFY_KINDS };
