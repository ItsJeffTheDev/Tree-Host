// Real test of one-click modpacks (Modrinth, Fabric). Downloads a pack and Minecraft; not run in CI.
// Start a fresh demo site with TREEHOST_PORTS=27600-27700, then: node test/modpack.e2e.js <its data folder> "<search>"
// Real test: search Modrinth, install a Fabric modpack server, start it.
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
const check = (l, ok, x = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${x ? `  (${x})` : ''}`);
(async () => {
  await call('POST', '/api/auth/signup', { username: 'packer', email: 'packer@example.com', password: 'TreeHost-test-123', acceptTerms: true });
  await call('POST', '/api/billing/checkout', { planId: 'oak' });
  const sub = (await call('GET', '/api/billing')).data.subscriptions[0];
  const hits = (await call('GET', '/api/modpacks/search?q=' + encodeURIComponent(process.argv[3] || ''))).data;
  check('modpack search works', Array.isArray(hits) && hits.length > 0, hits && hits.slice(0, 3).map((h) => h.title).join(', '));
  const pick = hits[0];
  const versions = (await call('GET', `/api/modpacks/${pick.id}/versions`)).data;
  const v = versions.find((x) => x.type === 'release') || versions[0];
  check(`versions of ${pick.title}`, versions.length > 0, `${v.number} for ${v.gameVersions.join(', ')}`);
  const r = await call('POST', '/api/servers', { modpack: { versionId: v.id }, name: pick.title.slice(0, 40), subscriptionId: sub.id, eula: true });
  check('server created from the modpack', r.status === 200, r.data && (r.data.error || `${r.data.typeLabel} ${r.data.version}, loader ${r.data.build}`));
  if (r.status !== 200) process.exit(1);
  const s = r.data;
  let lines = [];
  for (let i = 0; i < 180; i++) {
    lines = (await call('GET', `/api/servers/${s.id}/log`)).data.lines.map((x) => x.t);
    if (lines.some((t) => /Modpack .* installed|Modpack install failed/.test(t))) break;
    await sleep(2000);
  }
  const done = lines.find((t) => /Modpack .* installed|Modpack install failed/.test(t));
  check('mods downloaded', done && /installed/.test(done), done);
  const mods = fs.readdirSync(path.join(DATA, 'servers', s.id, 'mods')).filter((f) => f.endsWith('.jar'));
  check('mods folder filled', mods.length > 0, `${mods.length} jars`);
  for (let i = 0; i < 90; i++) {
    const st = (await call('GET', `/api/servers/${s.id}`)).data;
    if (st.status === 'stopped' && (await call('GET', `/api/servers/${s.id}/log`)).data.lines.some((x) => /Installation complete/.test(x.t))) break;
    await sleep(2000);
  }
  await call('POST', `/api/servers/${s.id}/start`);
  let st;
  for (let i = 0; i < 200; i++) {
    await sleep(3000);
    st = (await call('GET', `/api/servers/${s.id}`)).data;
    if (st.status === 'running' || (st.status === 'stopped' && i > 5)) break;
  }
  check('modpack server runs', st.status === 'running', st.status === 'running' ? '' : JSON.stringify(st.diagnosis && st.diagnosis.findings.map((f) => f.title)));
  await call('POST', `/api/servers/${s.id}/kill`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
