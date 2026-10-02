// Real-server test of proxy networks (Velocity + Paper in Docker; downloads both, takes a few minutes; not run in CI).
// Start a fresh demo site with TREEHOST_ISOLATION=auto and TREEHOST_PORTS=27600-27700, then: node test/network.e2e.js <its data folder>
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
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
const read = (id, f) => { try { return fs.readFileSync(path.join(DATA, 'servers', id, f), 'utf8'); } catch { return ''; } };
async function waitInstalled(id) {
  for (let i = 0; i < 150; i++) {
    const st = (await call('GET', `/api/servers/${id}`)).data;
    if (st.status === 'stopped' && (await call('GET', `/api/servers/${id}/log`)).data.lines.some((x) => /Installation complete/.test(x.t))) return;
    await sleep(2000);
  }
}
async function waitRunning(id) {
  for (let i = 0; i < 150; i++) {
    if ((await call('GET', `/api/servers/${id}`)).data.status === 'running') return true;
    await sleep(2000);
  }
  return false;
}
(async () => {
  await call('POST', '/api/auth/signup', { username: 'netowner', email: 'net@example.com', password: 'TreeHost-test-123', acceptTerms: true });
  await call('PATCH', '/api/auth/me', { mcName: 'NetOwner' });
  await call('POST', '/api/billing/checkout', { planId: 'sapling' });
  const sub = (await call('GET', '/api/billing')).data.subscriptions[0];
  const lobby = (await call('POST', '/api/servers', { name: 'Lobby', type: 'paper', version: '1.21.1', eula: true, subscriptionId: sub.id })).data;
  const proxy = (await call('POST', '/api/servers', { name: 'My Network', type: 'velocity', version: (await call('GET', '/api/types/velocity/versions')).data[0].id || (await call('GET', '/api/types/velocity/versions')).data[0], eula: true, subscriptionId: sub.id })).data;
  check('created lobby and proxy', !!(lobby && lobby.id && proxy && proxy.id), proxy && proxy.error);
  await waitInstalled(lobby.id);
  await waitInstalled(proxy.id);
  const net = await call('PUT', `/api/servers/${proxy.id}/network`, { servers: [lobby.id], default: lobby.id });
  check('network saved', net.status === 200, `mode ${net.data && net.data.mode}`);
  const toml = read(proxy.id, 'velocity.toml');
  check('proxy lists the lobby at an address it can reach', new RegExp(`"lobby" = "(host\.docker\.internal|127\.0\.0\.1):${lobby.port}"`).test(toml), (toml.match(/^"lobby".*$/m) || [''])[0]);
  check('proxy uses modern forwarding', /player-info-forwarding-mode = "modern"/.test(toml));
  const secret = read(proxy.id, 'forwarding.secret');
  const paper = read(lobby.id, 'config/paper-global.yml');
  check('lobby trusts the proxy with the same secret', secret.length > 10 && paper.includes(`secret: '${secret}'`) && /velocity:\n\s+enabled: true/.test(paper));
  check('lobby leaves account checks to the proxy', /online-mode=false/.test(read(lobby.id, 'server.properties')));
  check('staff plugin trusts names behind the proxy', /#trust=proxy/.test(read(lobby.id, 'plugins/TreeHostStaff/staff.txt')));
  await call('POST', `/api/servers/${lobby.id}/start`);
  check('lobby running', await waitRunning(lobby.id));
  await call('POST', `/api/servers/${proxy.id}/start`);
  check('proxy running', await waitRunning(proxy.id));
  const inDocker = (await call('GET', `/api/servers/${proxy.id}`)).data.isolated;
  if (inDocker) {
    let out = '';
    try {
      out = execFileSync('docker', ['exec', `th-${proxy.id}`, 'bash', '-c', `timeout 5 bash -c 'echo > /dev/tcp/host.docker.internal/${lobby.port}' && echo OPEN`], { encoding: 'utf8' });
    } catch (e) { out = String(e.stdout || e.message); }
    check("proxy's container reaches the lobby", /OPEN/.test(out), out.trim().slice(0, 120));
  } else console.log('NOTE  not running in Docker, skipped the container check');
  const plog = (await call('GET', `/api/servers/${proxy.id}/log`)).data.lines.map((l) => l.t);
  check('proxy log has no forwarding warning', !plog.some((t) => /forwarding is disabled/i.test(t)));
  const llog = (await call('GET', `/api/servers/${lobby.id}/log`)).data.lines.map((l) => l.t);
  const staffLine = llog.find((t) => /staff protection is active/.test(t));
  check('staff plugin active behind the proxy', !!staffLine && /names verified/.test(staffLine), staffLine && staffLine.replace(/^.*\]: /, ''));
  for (const id of [proxy.id, lobby.id]) await call('POST', `/api/servers/${id}/kill`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
