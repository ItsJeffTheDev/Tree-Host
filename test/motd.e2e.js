// Real-server test of the MOTD (animated frames, hex colors, live changes) via Minecraft's server-list ping. Not run in CI.
// Start a fresh demo site with TREEHOST_PORTS=27600-27700, then: node test/motd.e2e.js <its data folder>
const net = require('net');
const fs = require('fs');
const path = require('path');
const B = 'http://localhost:8799';
const DATA = process.argv[2];
let ck = '';
const call = async (m, p, b) => {
  const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json', Origin: B, Cookie: ck }, body: b && JSON.stringify(b) });
  const s = r.headers.getSetCookie().find((c) => c.startsWith('th_session=')); if (s) ck = s.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => null) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (label, ok, extra = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`);
const varint = (n) => { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n); return Buffer.from(b); };
const packet = (id, body) => { const d = Buffer.concat([varint(id), body]); return Buffer.concat([varint(d.length), d]); };
function ping(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      const host = Buffer.from('localhost');
      const port2 = Buffer.alloc(2); port2.writeUInt16BE(port);
      sock.write(packet(0, Buffer.concat([varint(767), varint(host.length), host, port2, varint(1)])));
      sock.write(packet(0, Buffer.alloc(0)));
    });
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      try {
        let i = 0; const rd = () => { let n = 0, s = 0, b; do { b = buf[i++]; n |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return n; };
        const len = rd(); if (buf.length < i + len) return;
        rd(); const sl = rd(); const json = buf.slice(i, i + sl).toString('utf8');
        sock.destroy(); resolve(JSON.parse(json));
      } catch {}
    });
    sock.on('error', reject);
    setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, 8000);
  });
}
const flat = (c) => (typeof c === 'string' ? c : `${c.text || ''}${(c.extra || []).map(flat).join('')}`);
const colors = (c, out = []) => { if (c && typeof c === 'object') { if (c.color) out.push(c.color); (c.extra || []).forEach((x) => colors(x, out)); } return out; };
(async () => {
  await call('POST', '/api/auth/signup', { username: 'motdowner', email: 'motd@example.com', password: 'TreeHost-test-123', acceptTerms: true, birthYear: 1995 });
  await call('POST', '/api/billing/checkout', { planId: 'sapling', consent: { renewal: true, adult: true, withdrawal: true } });
  const sub = (await call('GET', '/api/billing')).data.subscriptions[0];
  const s = (await call('POST', '/api/servers', { name: 'MOTD Test', type: 'paper', version: '1.21.1', eula: true, subscriptionId: sub.id })).data;
  check('too-long lines are refused', (await call('PUT', `/api/servers/${s.id}/motd`, { frames: ['x'.repeat(200)] })).status === 400);
  const r = await call('PUT', `/api/servers/${s.id}/motd`, { frames: ['&#ff8800&lFrame One\n&aSecond line', '&b&lFrame Two\n&7still here'], interval: 2 });
  check('animated MOTD saved', r.status === 200 && r.data.motd.frames.length === 2);
  check('plugin gets the frames', /#interval=2\n§x§f§f§8§8§0§0§lFrame One\n§aSecond line\n---\n§b§lFrame Two/.test(fs.readFileSync(path.join(DATA, 'servers', s.id, 'plugins', 'TreeHostStaff', 'motd.txt'), 'utf8')));
  check('server.properties gets the first frame (classic colors)', /^motd=(\u00a76\u00a7l|§6§l)Frame One/m.test(fs.readFileSync(path.join(DATA, 'servers', s.id, 'server.properties'), 'utf8')));
  for (let i = 0; i < 150; i++) {
    const st = (await call('GET', `/api/servers/${s.id}`)).data;
    if (st.status === 'stopped' && (await call('GET', `/api/servers/${s.id}/log`)).data.lines.some((x) => /Installation complete/.test(x.t))) break;
    await sleep(2000);
  }
  await call('POST', `/api/servers/${s.id}/start`);
  let running = false;
  for (let i = 0; i < 150 && !running; i++) { await sleep(2000); running = (await call('GET', `/api/servers/${s.id}`)).data.status === 'running'; }
  check('Paper server running', running);
  const seen = new Set();
  let hex = false;
  for (let i = 0; i < 6; i++) {
    const st = await ping(s.port).catch((e) => ({ error: e.message }));
    const text = st.description ? flat(st.description) : st.error;
    seen.add(text.split('\n')[0]);
    if (colors(st.description).some((c) => /^#ff8800$/i.test(c))) hex = true;
    await sleep(1200);
  }
  check('the MOTD animates between pings', seen.has('Frame One') && seen.has('Frame Two'), [...seen].join(' | '));
  check('hex color comes through', hex);
  const live = await call('PUT', `/api/servers/${s.id}/motd`, { frames: ['&cChanged live'] });
  check('a change while running applies live (no restart)', live.data.motdLive === true);
  await sleep(7000);
  const after = await ping(s.port).catch((e) => ({ error: e.message }));
  check('...and players see it', after.description && flat(after.description) === 'Changed live', after.description ? flat(after.description) : after.error);
  await call('POST', `/api/servers/${s.id}/kill`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
