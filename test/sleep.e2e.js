// Real-server test of sleep when empty + wake on join (Paper; takes ~8 minutes; not run in CI).
// Start a fresh demo site with TREEHOST_PORTS=27600-27700, then: node test/sleep.e2e.js
const net = require('net');
const B = 'http://localhost:8799';
let ck = '';
const call = async (m, p, b) => {
  const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json', Origin: B, Cookie: ck }, body: b && JSON.stringify(b) });
  const s = r.headers.getSetCookie().find((c) => c.startsWith('th_session=')); if (s) ck = s.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => null) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (label, ok, extra = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`);
const varint = (n) => { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n); return Buffer.from(b); };
const pkt = (id, body) => { const d = Buffer.concat([varint(id), body]); return Buffer.concat([varint(d.length), d]); };
const str = (s) => { const b = Buffer.from(s); return Buffer.concat([varint(b.length), b]); };
const talk = (port, next, extra) => new Promise((res) => {
  const s = net.connect(port, '127.0.0.1', () => { const p = Buffer.alloc(2); p.writeUInt16BE(port); s.write(pkt(0, Buffer.concat([varint(767), str('localhost'), p, varint(next)]))); s.write(extra); });
  let b = Buffer.alloc(0); s.on('data', (d) => (b = Buffer.concat([b, d]))); s.on('close', () => res(b.toString('utf8'))); s.on('error', () => res('')); setTimeout(() => s.destroy(), 4000);
});
const status = (port) => talk(port, 1, pkt(0, Buffer.alloc(0)));
(async () => {
  await call('POST', '/api/auth/signup', { username: 'sleeper', email: 'sleeper@example.com', password: 'TreeHost-test-123', acceptTerms: true, birthYear: 1995 });
  await call('POST', '/api/auth/login', { username: 'sleeper', password: 'TreeHost-test-123' });
  if (!(await call('GET', '/api/billing')).data.subscriptions.length) await call('POST', '/api/billing/checkout', { planId: 'sapling', consent: { renewal: true, adult: true, withdrawal: true } });
  const sub = (await call('GET', '/api/billing')).data.subscriptions[0];
  const s = (await call('POST', '/api/servers', { name: 'Sleepy SMP', type: 'paper', version: '1.21.1', eula: true, subscriptionId: sub.id })).data;
  await call('PUT', `/api/servers/${s.id}/sleep`, { enabled: true, minutes: 5 });
  for (let i = 0; i < 150; i++) {
    const st = (await call('GET', `/api/servers/${s.id}`)).data;
    if (st.status === 'stopped' && (await call('GET', `/api/servers/${s.id}/log`)).data.lines.some((x) => /Installation complete/.test(x.t))) break;
    await sleep(2000);
  }
  await call('POST', `/api/servers/${s.id}/start`);
  let st;
  for (let i = 0; i < 150; i++) { await sleep(2000); st = (await call('GET', `/api/servers/${s.id}`)).data; if (st.status === 'running') break; }
  check('Paper running', st.status === 'running');
  const t0 = Date.now();
  for (let i = 0; i < 80; i++) { await sleep(5000); st = (await call('GET', `/api/servers/${s.id}`)).data; if (st.sleeping && st.status === 'stopped') break; }
  check('fell asleep after ~5 empty minutes', st.sleeping && st.status === 'stopped', `${Math.round((Date.now() - t0) / 1000)} s`);
  await sleep(2000);
  const zz = await status(s.port);
  check('server list shows it sleeping', /Sleeping/.test(zz) && /Join to wake it up/.test(zz));
  const join = await talk(s.port, 2, pkt(0, Buffer.concat([str('Steve'), Buffer.alloc(16)])));
  check('joining says it is waking up', /Waking the server up/.test(join));
  let woke = false;
  for (let i = 0; i < 120 && !woke; i++) { await sleep(2000); st = (await call('GET', `/api/servers/${s.id}`)).data; woke = st.status === 'running'; }
  check('the server woke up and is running', woke);
  const normal = await status(s.port);
  check('the server list shows the real server again', normal && !/Sleeping/.test(normal), normal.slice(0, 80).replace(/[^\x20-\x7e]/g, ''));
  await call('POST', `/api/servers/${s.id}/kill`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
