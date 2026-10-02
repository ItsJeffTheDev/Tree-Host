// Real-server test of the Tree Host staff plugin (downloads Paper, takes a few minutes; not run in CI).
// Start a fresh demo site first, then:  node test/staff-plugin.e2e.js <its data folder>
//   TREEHOST_PUBLIC_URL=http://localhost:8799 TREEHOST_PORT=8799 TREEHOST_PORTS=27600-27700 BILLING_DEMO=1 TREEHOST_DATA=/tmp/th-plug node src/server.js
const fs = require('fs');
const path = require('path');
const B = 'http://localhost:8799';
const DATA = process.argv[2];
const jars = {};
const mk = (who) => async (m, p, b) => {
  const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json', Origin: B, Cookie: jars[who] || '' }, body: b && JSON.stringify(b) });
  const s = r.headers.getSetCookie().find((c) => c.startsWith('th_session=')); if (s) jars[who] = s.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => null) };
};
const owner = mk('owner');
const cust = mk('cust');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = async (id) => (await cust('GET', `/api/servers/${id}/log`)).data.lines.map((l) => l.t);
const check = (label, ok) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
(async () => {
  await owner('POST', '/api/auth/signup', { username: 'boss', email: 'boss@example.com', password: 'TreeHost-test-123', acceptTerms: true });
  await owner('PATCH', '/api/auth/me', { mcName: 'TreeHostJeb' });
  await cust('POST', '/api/auth/signup', { username: 'player1', email: 'player1@example.com', password: 'TreeHost-test-123', acceptTerms: true });
  await cust('POST', '/api/billing/checkout', { planId: 'sapling' });
  const sub = (await cust('GET', '/api/billing')).data.subscriptions[0];
  const s = (await cust('POST', '/api/servers', { name: 'Paper Test', type: 'paper', version: '1.21.1', eula: true, subscriptionId: sub.id })).data;
  const jar = path.join(DATA, 'servers', s.id, 'plugins', 'TreeHostStaff.jar');
  check('plugin is on the server right after creating it', fs.existsSync(jar));
  check('staff list lists the staff member', /TreeHostJeb\|Owner/.test(fs.readFileSync(path.join(DATA, 'servers', s.id, 'plugins', 'TreeHostStaff', 'staff.txt'), 'utf8')));
  for (let i = 0; i < 120; i++) {
    const st = (await cust('GET', `/api/servers/${s.id}`)).data;
    if (st.status === 'stopped' && (await log(s.id)).some((t) => /Installation complete/.test(t))) break;
    await sleep(2000);
  }
  await cust('POST', `/api/servers/${s.id}/start`);
  let running = false;
  for (let i = 0; i < 120 && !running; i++) {
    await sleep(2000);
    running = (await cust('GET', `/api/servers/${s.id}`)).data.status === 'running';
  }
  check('Paper server started', running);
  const lines = await log(s.id);
  const active = lines.find((t) => /Tree Host staff protection is active/.test(t));
  check(`plugin loaded: ${active ? active.replace(/^.*\]: /, '') : 'not found'}`, !!active);
  const before = lines.length;
  for (const c of ['ban TreeHostJeb griefing', 'kick TreeHostJeb bye', 'ban-ip TreeHostJeb', 'kick SomeoneElse for annoying TreeHostJeb']) await cust('POST', `/api/servers/${s.id}/command`, { command: c });
  await sleep(2500);
  const after = (await log(s.id)).slice(before).filter((t) => !t.startsWith('> '));
  check('ban on staff refused', after.filter((t) => /TreeHostJeb is official Tree Host staff/.test(t)).length >= 3);
  check("kicking someone else isn't blocked by a staff name in the reason", !after.some((t) => /SomeoneElse is official/.test(t)));
  console.log('   console:', after.slice(0, 5).map((t) => t.replace(/^.*\]: /, '')).join(' || '));
  check('customer cannot delete the plugin', (await cust('DELETE', `/api/servers/${s.id}/plugins/TreeHostStaff.jar`)).status === 403);
  check('customer cannot turn it off', (await cust('POST', `/api/servers/${s.id}/plugins/TreeHostStaff.jar/toggle`)).status === 403);
  check('customer cannot delete it in Files', (await cust('DELETE', `/api/servers/${s.id}/file?path=${encodeURIComponent('plugins/TreeHostStaff.jar')}`)).status === 403);
  check('customer cannot delete the plugins folder', (await cust('DELETE', `/api/servers/${s.id}/file?path=plugins`)).status === 403);
  check('customer cannot edit the staff list', (await cust('PUT', `/api/servers/${s.id}/file?path=${encodeURIComponent('plugins/TreeHostStaff/staff.txt')}`, { content: 'player1|Owner' })).status === 403);
  const listed = (await cust('GET', `/api/servers/${s.id}/plugins`)).data.find((p) => p.file === 'TreeHostStaff.jar');
  check('plugin list shows it as locked', listed && listed.locked === true);
  await cust('POST', `/api/servers/${s.id}/kill`);
  await sleep(3000);
  fs.rmSync(jar, { force: true });
  fs.writeFileSync(path.join(DATA, 'servers', s.id, 'plugins', 'TreeHostStaff', 'staff.txt'), 'player1|Owner\n');
  let back = false;
  for (let i = 0; i < 20 && !back; i++) {
    await sleep(2500);
    back = fs.existsSync(jar);
  }
  check('removed from disk -> put back within 30 seconds', back);
  check('tampered staff list -> fixed', /TreeHostJeb\|Owner/.test(fs.readFileSync(path.join(DATA, 'servers', s.id, 'plugins', 'TreeHostStaff', 'staff.txt'), 'utf8')));
  const ev = (await owner('GET', '/api/activity?limit=50')).data.find((e) => /put the Tree Host staff plugin back/.test(e.text));
  check('staff were told it was put back', !!ev);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
