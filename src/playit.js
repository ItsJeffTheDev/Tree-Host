'use strict';
// Public addresses from playit.gg, for a Tree Host on a PC whose router doesn't forward ports (the tester site that
// tools/Start-Testers.ps1 runs). TREEHOST_PLAYIT_SECRET_PATH points at the key file (playit.toml) of a "self-managed"
// playit agent; that agent has to be running on this PC (Start-Testers starts it).
// Every server gets its own Minecraft Java tunnel to its port, named "Tree Host <server id>". Players see the playit
// address (like name.tun.ply.gg) on the server's page. The tunnel goes when the server is deleted.
// Servers behind a proxy (players come in through the proxy) and demo servers get none: playit's free plan has only a
// few public addresses per account (4 when this was written), so they're kept for servers players join directly.
const fs = require('fs');

const API = 'https://api.playit.gg';
const PREFIX = 'Tree Host ';

class Playit {
  /** @param skip (inst) => true for servers that should have no tunnel */
  constructor(secretPath, { skip = () => false } = {}) {
    this.skip = skip;
    this.limited = new Set(); // servers already told that the free plan is full
    const m = /secret_key\s*=\s*"([0-9a-f]+)"/.exec(fs.readFileSync(secretPath, 'utf8'));
    if (!m) throw new Error(`No playit key (secret_key) in ${secretPath}`);
    this.key = m[1];
    this.agentId = null;
    this.busy = new Map(); // server id -> running ensure(), so one server never gets two tunnels
  }

  async call(path, body) {
    const res = await fetch(API + path, {
      method: 'POST',
      headers: { Authorization: `Agent-Key ${this.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const j = await res.json().catch(() => null);
    if (!j || j.status !== 'success') {
      const d = j && j.data;
      throw new Error(`playit: ${(d && (d.message || (typeof d === 'string' ? d : JSON.stringify(d)))) || `HTTP ${res.status}`}`);
    }
    return j.data;
  }

  async agent() {
    if (!this.agentId) this.agentId = (await this.call('/v1/agents/rundata', {})).agent_id;
    return this.agentId;
  }

  async tunnels() {
    return (await this.call('/v1/tunnels/list', {})).tunnels.filter((t) => (t.name || '').startsWith(PREFIX));
  }

  static portOf(t) {
    const f = t.origin && t.origin.details && t.origin.details.config_data && t.origin.details.config_data.fields;
    const p = f && f.find((x) => x.name === 'local_port');
    return p ? Number(p.value) : null;
  }

  /** The name players type: the short hostname (it has an SRV record, so no port), else host:port. */
  static addressOf(t) {
    const auto = (t.connect_addresses || []).filter((a) => a.type === 'auto').map((a) => a.value.address);
    return auto.find((a) => !a.includes(':')) || auto[0] || null;
  }

  /** Gives a server its tunnel (or fixes it after a port change) and returns the address. */
  ensure(inst) {
    const id = inst.cfg.id;
    if (!this.busy.has(id)) this.busy.set(id, this.ensureNow(inst).finally(() => this.busy.delete(id)));
    return this.busy.get(id);
  }

  async ensureNow(inst) {
    const name = PREFIX + inst.cfg.id;
    let t = (await this.tunnels()).find((x) => x.name === name);
    if (this.skip(inst)) {
      if (t) await this.call('/tunnels/delete', { tunnel_id: t.id });
      if (inst.cfg.playit) {
        delete inst.cfg.playit;
        inst.cfg.autoAddress = inst.manager.gameHost ? inst.manager.gameAddress(inst.cfg.port) : '';
        inst.manager.save();
        inst.emitStatus();
      }
      return null;
    }
    if (t && Playit.portOf(t) !== inst.cfg.port) {
      await this.call('/tunnels/delete', { tunnel_id: t.id });
      t = null;
    }
    if (!t) {
      const { id } = await this.call('/tunnels/create', {
        name,
        tunnel_type: 'minecraft-java',
        port_type: 'tcp',
        port_count: 1,
        origin: { type: 'agent', data: { agent_id: await this.agent(), local_ip: '127.0.0.1', local_port: inst.cfg.port } },
        enabled: true,
        alloc: null,
        firewall_id: null,
        proxy_protocol: null,
      });
      // The address shows up a moment after the tunnel is made (or never, when the account has no addresses left).
      for (let i = 0; i < 20 && !(t && Playit.addressOf(t)); i++) {
        await new Promise((r) => setTimeout(r, 1500));
        t = (await this.tunnels()).find((x) => x.id === id);
        if (t && (t.port_allocation_requests || []).some((a) => a.status === 'AccountPortLimitReached')) {
          await this.call('/tunnels/delete', { tunnel_id: id }).catch(() => {});
          if (!inst.cfg.playitFull) {
            inst.cfg.playitFull = true;
            inst.manager.save();
            inst.emitStatus();
          }
          if (!this.limited.has(inst.cfg.id)) {
            this.limited.add(inst.cfg.id);
            inst.sysLog("No playit address for this server: the playit account's free addresses are all in use. Delete a server you don't need (or put this one behind a proxy) and it gets one within a few minutes.");
          }
          throw new Error('the playit account has no free addresses left');
        }
      }
      if (!t || !Playit.addressOf(t)) throw new Error('playit made the tunnel but gave no address yet. It is tried again in a few minutes.');
    }
    this.limited.delete(inst.cfg.id);
    if (inst.cfg.playitFull) delete inst.cfg.playitFull;
    const address = Playit.addressOf(t);
    const before = inst.cfg.playit && inst.cfg.playit.address;
    inst.cfg.playit = { tunnelId: t.id, address, port: inst.cfg.port };
    if (inst.cfg.autoAddress !== address) {
      inst.cfg.autoAddress = address;
      inst.manager.save();
      inst.emitStatus();
    }
    if (before !== address) inst.sysLog(`Players join this server at ${address} (a free playit.gg address).`);
    return address;
  }

  /** Deletes the tunnel of a server that was deleted. */
  async release(serverId) {
    const t = (await this.tunnels()).find((x) => x.name === PREFIX + serverId);
    if (t) await this.call('/tunnels/delete', { tunnel_id: t.id });
  }

  /** Every server has its tunnel, and tunnels of servers that are gone are deleted. */
  async reconcile(manager) {
    const ids = new Set(manager.instances.keys());
    for (const t of await this.tunnels()) {
      if (!ids.has(t.name.slice(PREFIX.length))) await this.call('/tunnels/delete', { tunnel_id: t.id }).catch(() => {});
    }
    for (const inst of manager.instances.values()) {
      await this.ensure(inst).catch((e) => console.error(`[playit] ${inst.cfg.id}: ${e.message}`));
    }
  }
}

module.exports = { Playit };
