'use strict';
// playit.gg integration: creates a Minecraft tunnel per server through the installed playit agent
// and reads back its permanent public address. Uses playit's agent API (https://api.playit.gg).
const fsp = require('fs').promises;
const path = require('path');
const { DATA } = require('./paths');

const API = 'https://api.playit.gg';
const CONFIG_FILE = path.join(DATA, 'playit.json');

/** Where the official playit app stores its secret key (v1.0 service, then the older per-user app). */
function secretCandidates() {
  const list = [];
  if (process.env.ProgramData) list.push(path.join(process.env.ProgramData, 'playit_gg', 'playit.toml'));
  if (process.env.LOCALAPPDATA) list.push(path.join(process.env.LOCALAPPDATA, 'playit_gg', 'playit.toml'));
  list.push('/etc/playit/playit.toml', path.join(process.env.HOME || '', '.config', 'playit_gg', 'playit.toml'));
  return list;
}

class Playit {
  constructor() {
    this.secret = null;
    this.agentId = null;
    this.accountStatus = null;
    this.error = null;
    this.inflight = new Map();
  }

  async init() {
    try {
      this.secret = JSON.parse(await fsp.readFile(CONFIG_FILE, 'utf8')).secret || null;
    } catch {
      /* not configured yet */
    }
    if (this.secret) this.check().catch(() => {});
  }

  get configured() {
    return !!this.secret;
  }

  /** The secret key of the playit app installed on this PC, if it can be read. */
  async localSecret() {
    for (const file of secretCandidates()) {
      try {
        const m = /secret_key\s*=\s*"([^"]+)"/.exec(await fsp.readFile(file, 'utf8'));
        if (m) return m[1].trim();
      } catch {
        /* try the next location */
      }
    }
    return null;
  }

  async status() {
    const local = await this.localSecret();
    return {
      configured: this.configured,
      agentId: this.agentId,
      accountStatus: this.accountStatus,
      error: this.error,
      // Linked to a playit agent other than the one installed on this PC (e.g. after moving to a new PC).
      otherAgent: !!(this.secret && local && local !== this.secret),
      localInstalled: !!local,
    };
  }

  async call(pathname, body, secret = this.secret) {
    const res = await fetch(API + pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Agent-Key ${secret}` },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`playit.gg answered HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    if (json.status === 'success') return json.data;
    if (json.data && json.data.message === 'InvalidAgentKey') {
      throw new Error('playit.gg rejected the key. Make sure the playit app is set up and linked to your account, then try again.');
    }
    const detail = typeof json.data === 'string' ? json.data : JSON.stringify(json.data);
    throw new Error(`playit.gg ${pathname} failed: ${detail}`);
  }

  async check(secret = this.secret) {
    try {
      const rd = await this.call('/agents/rundata', {}, secret);
      this.agentId = rd.agent_id;
      this.accountStatus = rd.account_status;
      this.error = null;
      return rd;
    } catch (e) {
      this.error = e.message;
      throw e;
    }
  }

  async save() {
    await fsp.mkdir(DATA, { recursive: true });
    await fsp.writeFile(CONFIG_FILE, JSON.stringify({ secret: this.secret }, null, 2));
  }

  /** Validates and stores a secret key (pasted by an admin). */
  async setSecret(secret) {
    secret = String(secret || '').trim().replace(/^secret_key\s*=\s*/, '').replace(/^"|"$/g, '');
    if (!/^[A-Za-z0-9_-]{16,}$/.test(secret)) throw new Error('That does not look like a playit secret key');
    await this.check(secret);
    this.secret = secret;
    await this.save();
    return await this.status();
  }

  /** Looks for the installed playit app's secret key on this PC. */
  async detect() {
    const tried = [];
    for (const file of secretCandidates()) {
      let text;
      try {
        text = await fsp.readFile(file, 'utf8');
      } catch (e) {
        tried.push(`${file} (${e.code === 'EPERM' || e.code === 'EACCES' ? 'no permission' : 'not found'})`);
        continue;
      }
      const m = /secret_key\s*=\s*"([^"]+)"/.exec(text);
      if (!m) {
        tried.push(`${file} (no secret_key yet: finish the playit setup link first)`);
        continue;
      }
      return this.setSecret(m[1]);
    }
    throw new Error(`Could not find the playit secret key automatically. Checked: ${tried.join('; ')}. Paste it instead.`);
  }

  async disconnect() {
    this.secret = null;
    this.agentId = null;
    this.accountStatus = null;
    this.error = null;
    await fsp.rm(CONFIG_FILE, { force: true });
  }

  static addressOf(t) {
    const host = t.custom_domain || t.assigned_domain;
    // Minecraft Java tunnels get an SRV record, so the bare domain works in the Multiplayer screen.
    return t.tunnel_type === 'minecraft-java' ? host : `${host}:${t.port.from}`;
  }

  /** Returns the public address for a local port, creating a Minecraft tunnel for it if needed. */
  ensureTunnel(localPort, name) {
    if (!this.inflight.has(localPort)) {
      this.inflight.set(
        localPort,
        this.ensureTunnelNow(localPort, name).finally(() => this.inflight.delete(localPort)),
      );
    }
    return this.inflight.get(localPort);
  }

  async ensureTunnelNow(localPort, name) {
    if (!this.secret) throw new Error('playit.gg is not connected');
    const find = (rd) =>
      rd.tunnels.find((t) => t.local_port === localPort && (t.proto === 'tcp' || t.proto === 'both') && !t.disabled);
    let rd = await this.check();
    let tunnel = find(rd);
    if (!tunnel) {
      const pending = rd.pending.some((p) => p.name === name);
      if (!pending) {
        await this.call('/tunnels/create', {
          name,
          tunnel_type: 'minecraft-java',
          port_type: 'tcp',
          port_count: 1,
          origin: { type: 'agent', data: { agent_id: rd.agent_id, local_ip: '127.0.0.1', local_port: localPort } },
          enabled: true,
          alloc: null,
          firewall_id: null,
          proxy_protocol: null,
        }).catch((e) => {
          // Keys from the playit app's normal setup can read tunnels but not create them.
          if (/NotAllowedWithReadOnly/.test(e.message)) {
            throw Object.assign(
              new Error(
                `Create this server's tunnel on playit.gg (Tunnels → Add Tunnel): type Minecraft Java, ` +
                  `Local IP 127.0.0.1, Local Port ${localPort}, Proxy Protocol none. Honey Host picks it up automatically.`,
              ),
              { code: 'CREATE_ON_WEBSITE', port: localPort },
            );
          }
          throw e;
        });
      }
      // New tunnels take a few seconds to be allocated.
      for (let i = 0; i < 20 && !tunnel; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        rd = await this.check();
        tunnel = find(rd);
      }
      if (!tunnel) throw new Error('playit.gg did not finish creating the tunnel in time. It will be retried on the next start.');
    }
    return { address: Playit.addressOf(tunnel), proxyProtocol: tunnel.proxy_protocol || null };
  }
}

module.exports = { Playit };
