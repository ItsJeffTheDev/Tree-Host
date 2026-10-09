'use strict';
// Test site mode (TREEHOST_TEST_SITE=1, set by tools/Start-Testers.ps1): a Tree Host on a home PC that anyone with the
// tester link can try, for example live on stream.
//  - Testers' servers are deleted every TREEHOST_RESET_HOURS (48 by default), on a fixed schedule everyone can see.
//    Running servers are warned in-game 60, 10 and 1 minutes before. Staff servers, team servers and demos are kept.
//  - A short feed of what happens (servers made and started) for the stream overlays (public/overlay/).
const fs = require('fs');
const path = require('path');

const WARN_AT = [60, 10, 1]; // minutes before the reset

class TestSite {
  /**
   * @param o.manager   the server manager
   * @param o.keep      (inst) => true for servers the reset leaves alone
   * @param o.onRemoved (inst) => cleanup after a server is deleted (billing)
   */
  constructor({ manager, dataDir, hours = 48, keep, onRemoved }) {
    this.manager = manager;
    this.hours = Math.max(1, Number(hours) || 48);
    this.keep = keep;
    this.onRemoved = onRemoved || (() => {});
    this.file = path.join(dataDir, 'test-site.json');
    this.feed = []; // newest last: { id, at, type, user, server }
    this.seq = 0;
    try {
      this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.state = {};
    }
    if (!this.state.nextResetAt || this.state.nextResetAt < Date.now() - 3600 * 1000) this.state.nextResetAt = Date.now() + this.hours * 3600 * 1000;
    this.state.warned = this.state.warned || [];
    this.save();
  }

  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
    } catch {}
  }

  info() {
    return {
      resetHours: this.hours,
      nextResetAt: this.state.nextResetAt,
      lastResetAt: this.state.lastResetAt || null,
      disclaimer: `This is a test site: servers run on a home PC, not dedicated hardware, so they may be slow. Testers' servers are deleted every ${this.hours} hours.`,
    };
  }

  /** Something worth showing on stream. Only names people chose themselves, never emails or addresses. */
  event(type, { user = '', server = '' } = {}) {
    const clean = (v) => String(v || '').replace(/[^\p{L}\p{N} _.!?'-]/gu, '').trim().slice(0, 32);
    this.feed.push({ id: ++this.seq, at: Date.now(), type, user: clean(user), server: clean(server) });
    if (this.feed.length > 100) this.feed.splice(0, this.feed.length - 100);
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((e) => console.error(`[test site] ${e.message}`)), 15000);
    this.tick().catch(() => {});
  }

  doomed() {
    return [...this.manager.instances.values()].filter((i) => !this.keep(i));
  }

  async tick() {
    const left = this.state.nextResetAt - Date.now();
    for (const min of WARN_AT) {
      if (left <= min * 60000 && left > 0 && !this.state.warned.includes(min)) {
        this.state.warned.push(min);
        this.save();
        const text = `This test server is deleted in ${min} minute${min === 1 ? '' : 's'} (Tree Host test servers reset every ${this.hours} hours).`;
        for (const inst of this.doomed()) {
          inst.sysLog(text);
          if (inst.proc && inst.status === 'running' && inst.kind !== 'proxy') {
            inst.command(`tellraw @a ${JSON.stringify([{ text: 'Tree Host » ', color: 'green', bold: true }, { text, color: 'yellow', bold: false }])}`);
          }
        }
      }
    }
    if (left <= 0) await this.reset();
  }

  /** Deletes every tester's server and schedules the next reset. */
  async reset() {
    const gone = [];
    for (const inst of this.doomed()) {
      try {
        if (inst.proc) {
          await Promise.race([inst.stopAndWait(), new Promise((r) => setTimeout(r, 60000))]);
          if (inst.proc) inst.kill();
          await new Promise((r) => setTimeout(r, 1500));
        }
        await this.manager.remove(inst.cfg.id);
        this.onRemoved(inst);
        gone.push(inst.cfg.name);
      } catch (e) {
        console.error(`[test site] could not delete ${inst.cfg.id}: ${e.message}`);
      }
    }
    this.state.lastResetAt = Date.now();
    this.state.nextResetAt = Date.now() + this.hours * 3600 * 1000;
    this.state.warned = [];
    this.save();
    this.event('reset', { server: `${gone.length} servers` });
    console.log(`[test site] reset: deleted ${gone.length} tester servers. Next reset ${new Date(this.state.nextResetAt).toLocaleString()}.`);
    return gone;
  }
}

module.exports = { TestSite };
