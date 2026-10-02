// End-to-end test of role-based access control (src/rbac.js) against a running demo site.
// Start one first (fresh data folder!), then run this:
//   TREEHOST_PUBLIC_URL=http://localhost:8799 TREEHOST_PORT=8799 BILLING_DEMO=1 TREEHOST_DATA=/tmp/th-test node src/server.js &
//   node test/rbac.e2e.js
// It signs up an owner, admin, developer, support and two customers, then checks who may do what.
const B = process.env.TREEHOST_TEST_URL || 'http://localhost:8799';
const jar = {};
let fails = 0, passes = 0;

async function call(who, method, path, body) {
  const res = await fetch(B + path, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: B, ...(jar[who] ? { Cookie: jar[who] } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const session = res.headers.getSetCookie().find((c) => c.startsWith('th_session='));
  if (session) jar[who] = session.split(';')[0];
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

/** A plain w x h PNG (for the server icon tests). */
function makePng(w, h) {
  const zlib = require('zlib');
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x55);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const putIcon = (who, sid, body) => fetch(`${B}/api/servers/${sid}/icon`, { method: 'PUT', headers: { Origin: B, Cookie: jar[who] || '' }, body }).then(async (r) => (r.status >= 500 || process.env.DEBUG_ICON ? console.log('   icon said:', r.status, await r.text()) : null, r.status));

function expect(label, got, want) {
  const ok = Array.isArray(want) ? want.includes(got) : got === want;
  if (ok) passes++; else fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${got}${ok ? '' : `, wanted ${want}`}`);
}

(async () => {
  const signup = (u) => call(u, 'POST', '/api/auth/signup', { username: u, email: `${u}@example.com`, password: 'TreeHost-test-123', acceptTerms: true, birthYear: 1995 });
  for (const u of ['owner1', 'admin1', 'dev1', 'support1', 'cust1', 'cust2']) await signup(u);
  const me = async (u) => (await call(u, 'GET', '/api/auth/me')).data.user;
  expect('first account is Owner', (await me('owner1')).role, 'owner');
  const users = (await call('owner1', 'GET', '/api/team/users')).data;
  const id = (name) => users.find((x) => x.username === name).id;
  for (const [u, r] of [['admin1', 'admin'], ['dev1', 'developer'], ['support1', 'staff']]) {
    expect(`owner makes ${u} ${r}`, (await call('owner1', 'PUT', `/api/team/users/${id(u)}/role`, { role: r })).status, 200);
  }
  const perms = async (u) => (await me(u)).permissions;
  expect('admin has billing.manage', (await perms('admin1')).includes('billing.manage'), true);
  expect('admin lacks roles.manage', (await perms('admin1')).includes('roles.manage'), false);
  expect('developer lacks billing.view', (await perms('dev1')).includes('billing.view'), false);
  expect('support has servers.viewAll', (await perms('support1')).includes('servers.viewAll'), true);
  expect('customer has no permissions', (await perms('cust1')).length, 0);

  const R = ['owner1', 'admin1', 'dev1', 'support1', 'cust1'];
  const matrix = async (label, method, path, body, want) => {
    for (let i = 0; i < R.length; i++) expect(`${label} as ${R[i]}`, (await call(R[i], method, path, body)).status, want[i]);
  };
  //                                                                       owner admin dev  support cust
  await matrix('GET people', 'GET', '/api/team/users', undefined, [200, 200, 200, 200, 403]);
  await matrix('GET billing', 'GET', '/api/admin/billing', undefined, [200, 200, 403, 200, 403]);
  await matrix('GET audit log', 'GET', '/api/admin/audit', undefined, [200, 200, 200, 403, 403]);
  await matrix('GET all servers', 'GET', '/api/admin/servers', undefined, [200, 200, 200, 200, 403]);
  await matrix('GET overview', 'GET', '/api/admin/overview', undefined, [200, 200, 200, 200, 403]);
  await matrix('GET promo codes', 'GET', '/api/admin/promos', undefined, [200, 200, 403, 403, 403]);
  await matrix('GET site settings', 'GET', '/api/team/settings', undefined, [200, 200, 403, 403, 403]);
  const plans = (await call('owner1', 'GET', '/api/admin/billing')).data.plans;
  await matrix('PUT plans', 'PUT', '/api/admin/plans', { plans }, [200, 200, 403, 403, 403]);
  const roles = (await call('owner1', 'GET', '/api/admin/roles')).data;
  const staffPerms = roles.roles.find((r) => r.id === 'staff').permissions;
  await matrix('PUT role permissions', 'PUT', '/api/admin/roles/staff', { permissions: staffPerms }, [200, 403, 403, 403, 403]);
  expect('owner cannot edit the Owner role', (await call('owner1', 'PUT', '/api/admin/roles/owner', { permissions: [] })).status, 400);
  expect('system info hidden from support', !!(await call('support1', 'GET', '/api/system')).data.customer, true);
  expect('system info shown to developer', typeof (await call('dev1', 'GET', '/api/system')).data.totalMemMb, 'number');

  // role-change rules: only below your own level
  expect('admin: support -> developer', (await call('admin1', 'PUT', `/api/team/users/${id('support1')}/role`, { role: 'developer' })).status, 200);
  expect('admin: back to support', (await call('admin1', 'PUT', `/api/team/users/${id('support1')}/role`, { role: 'staff' })).status, 200);
  expect('admin cannot make an admin', (await call('admin1', 'PUT', `/api/team/users/${id('cust2')}/role`, { role: 'admin' })).status, 403);
  expect('admin cannot touch the owner', (await call('admin1', 'PUT', `/api/team/users/${id('owner1')}/role`, { role: 'customer' })).status, 403);
  expect('developer cannot change roles', (await call('dev1', 'PUT', `/api/team/users/${id('cust2')}/role`, { role: 'staff' })).status, 403);
  expect('admin can invite support', (await call('admin1', 'POST', '/api/team/invites', { role: 'staff' })).status, 200);
  expect('admin cannot invite admin', (await call('admin1', 'POST', '/api/team/invites', { role: 'admin' })).status, 403);
  expect('last owner cannot be demoted', (await call('owner1', 'PUT', `/api/team/users/${id('owner1')}/role`, { role: 'admin' })).status, 400);

  // moderation: suspensions, bans, warnings, appeals (only on people below you)
  const act = (who, body) => call(who, 'POST', '/api/admin/actions', { reason: 'abuse', message: 'Test action: please follow the rules.', notes: 'secret staff note', ...body });
  const sus = await act('admin1', { target: 'account', userId: id('cust2'), type: 'suspend', days: 1 });
  expect('admin suspends a customer', sus.status, 200);
  expect('action has a number', /^TH-\d{6}$/.test(sus.data.id), true);
  expect('suspended customer is locked out', (await call('cust2', 'GET', '/api/servers')).status, 403);
  const mine = await call('cust2', 'GET', '/api/moderation/mine');
  expect('...but sees why', mine.data.restriction && mine.data.restriction.action.id, sus.data.id);
  expect('...without staff notes', JSON.stringify(mine.data).includes('secret staff note'), false);
  expect('...and has an inbox message', (await call('cust2', 'GET', '/api/inbox')).data.unread >= 1, true);
  expect('customer appeals', (await call('cust2', 'POST', `/api/moderation/${sus.data.id}/appeal`, { text: 'This was a misunderstanding, I promise.' })).status, 200);
  expect('support cannot decide appeals', (await call('support1', 'POST', `/api/admin/actions/${sus.data.id}/appeal`, { decision: 'accept', response: 'ok then' })).status, 403);
  expect('admin accepts the appeal', (await call('admin1', 'POST', `/api/admin/actions/${sus.data.id}/appeal`, { decision: 'accept', response: 'Thanks, lifted.' })).status, 200);
  expect('customer is back in', (await call('cust2', 'GET', '/api/servers')).status, 200);
  expect('admin cannot suspend the owner', (await act('admin1', { target: 'account', userId: id('owner1'), type: 'suspend' })).status, 403);
  expect('support can warn', (await act('support1', { target: 'account', userId: id('cust2'), type: 'warn' })).status, 200);
  expect('support cannot ban', (await act('support1', { target: 'account', userId: id('cust2'), type: 'ban' })).status, 403);
  expect('support cannot delete accounts', (await act('support1', { target: 'account', userId: id('cust2'), type: 'delete' })).status, 403);
  expect('developer cannot suspend', (await act('dev1', { target: 'account', userId: id('cust2'), type: 'suspend' })).status, 403);
  expect('a reason message is required', (await act('admin1', { target: 'account', userId: id('cust2'), type: 'warn', message: 'no' })).status, 400);
  await matrix('GET actions taken', 'GET', '/api/admin/actions', undefined, [200, 200, 200, 200, 403]);
  await matrix('GET a PDF report', 'GET', `/api/admin/actions/${sus.data.id}/report.pdf`, undefined, [200, 200, 200, 200, 403]);
  // action logs: filters by type, number, username, email, staff member and date
  const logs = async (qs) => (await call('owner1', 'GET', `/api/admin/actions?${new URLSearchParams(qs)}`)).data.actions;
  const today = new Date().toISOString().slice(0, 10);
  expect('logs: by type', (await logs({ types: 'warn' })).every((a) => a.type === 'warn') && (await logs({ types: 'warn' })).length >= 1, true);
  expect('logs: several types', (await logs({ types: 'warn,suspend' })).length, (await logs({})).length);
  expect('logs: by action number digits', (await logs({ id: String(Number(sus.data.id.slice(3))) }))[0].id, sus.data.id);
  expect('logs: by username', (await logs({ username: 'cust2' })).every((a) => a.customer.username === 'cust2'), true);
  expect('logs: by email', (await logs({ email: 'cust2@example.com' })).length >= 2, true);
  expect('logs: by staff member', (await logs({ by: 'support1' })).every((a) => a.by === 'support1'), true);
  expect('logs: today', (await logs({ from: today, to: today })).length, (await logs({})).length);
  expect('logs: a past date range is empty', (await logs({ from: '2020-01-01', to: '2020-01-31' })).length, 0);
  expect('logs: oldest first', (await logs({ sort: 'oldest' }))[0].id, 'TH-000001');
  expect('logs: CSV respects filters', (await (await fetch(`${B}/api/admin/actions.csv?types=warn`, { headers: { Cookie: jar.owner1 } })).text()).includes('Suspension'), false);
  expect('PDF is a PDF', (await (await fetch(`${B}/api/admin/actions/${sus.data.id}/report.pdf`, { headers: { Cookie: jar.owner1 } })).text()).startsWith('%PDF-'), true);

  // a customer's server: who can see / operate / destroy it
  await call('cust1', 'POST', '/api/billing/checkout', { planId: 'sapling', consent: { renewal: true, adult: true, withdrawal: true } });
  const sub = (await call('cust1', 'GET', '/api/billing')).data.subscriptions[0];
  const created = await call('cust1', 'POST', '/api/servers', { name: 'Cust Server', type: 'vanilla', version: '1.21.1', eula: true, subscriptionId: sub.id });
  expect('customer creates a server', created.status, 200);
  const sid = created.data && created.data.id;
  if (sid) {
    expect('owner of server sees it', (await call('cust1', 'GET', `/api/servers/${sid}`)).status, 200);
    expect('other customer gets 404', (await call('cust2', 'GET', `/api/servers/${sid}`)).status, 404);
    expect('support sees it', (await call('support1', 'GET', `/api/servers/${sid}`)).status, 200);
    expect("support can't change settings", (await call('support1', 'PUT', `/api/servers/${sid}/properties`, {})).status, 403);
    expect("support can't read the settings", (await call('support1', 'GET', `/api/servers/${sid}/properties`)).status, 403);
    expect("support can't open files", (await call('support1', 'GET', `/api/servers/${sid}/files`)).status, 403);
    expect("developer can't open files", (await call('dev1', 'GET', `/api/servers/${sid}/files`)).status, 403);
    expect('admin can open files', (await call('admin1', 'GET', `/api/servers/${sid}/files`)).status, 200);
    expect('support can still see the console', (await call('support1', 'GET', `/api/servers/${sid}/log`)).status, 200);
    expect('support cannot delete', (await call('support1', 'DELETE', `/api/servers/${sid}`)).status, 403);
    expect('support cannot set a custom Java path', (await call('support1', 'PATCH', `/api/servers/${sid}`, { java: '/usr/bin/java' })).status, 403);
    expect("developer can't change settings", (await call('dev1', 'PATCH', `/api/servers/${sid}`, { java: 'auto' })).status, 403);
    expect("admin can't use host-level settings", (await call('admin1', 'PATCH', `/api/servers/${sid}`, { java: '/usr/bin/java' })).status, 403);
    // take servers.edit away from Support and check it bites immediately
    await call('owner1', 'PUT', '/api/admin/roles/staff', { permissions: staffPerms.filter((p) => p !== 'servers.edit') });
    expect('support without servers.edit is blocked', (await call('support1', 'PUT', `/api/servers/${sid}/properties`, {})).status, 403);
    await call('owner1', 'PUT', '/api/admin/roles/staff', { permissions: staffPerms });
    expect('developer can kill it (servers.operate)', (await call('dev1', 'POST', `/api/servers/${sid}/kill`)).status, 200);
    for (let i = 0; i < 20 && (await call('dev1', 'GET', `/api/servers/${sid}`)).data.status !== 'stopped'; i++) await new Promise((r) => setTimeout(r, 500));
    // unlimited servers on a monthly plan
    const second = await call('cust1', 'POST', '/api/servers', { name: 'Second Server', type: 'vanilla', version: '1.21.1', eula: true, subscriptionId: sub.id });
    expect('a second server on the same monthly plan', second.status, 200);
    expect('...with the full plan memory', second.data && second.data.memoryMb, 2048);
    expect('billing lists both servers', (await call('cust1', 'GET', '/api/billing')).data.subscriptions[0].serverCount, 2);
    if (second.data) await call('cust1', 'DELETE', `/api/servers/${second.data.id}`);
    // public server list
    expect('listing the server', (await call('cust1', 'PUT', `/api/servers/${sid}/listing`, { public: true, description: 'Friendly SMP', tags: ['SMP', 'Survival', 'Nope'] })).status, 200);
    const pub = await (await fetch(`${B}/api/public/servers`)).json();
    const mine = pub.servers.find((x) => x.id === sid);
    expect('it shows on the public list (no sign-in needed)', !!mine, true);
    expect('...with only known tags', mine && mine.tags.join(), 'SMP,Survival');
    expect('...and no owner details', mine && 'owner' in mine, false);
    expect('bad Discord links are refused', (await call('cust1', 'PUT', `/api/servers/${sid}/listing`, { public: true, discord: 'https://evil.example/x' })).status, 400);
    // sharing a server with a friend
    expect('owner shares the server (helper)', (await call('cust1', 'POST', `/api/servers/${sid}/members`, { user: 'cust2', role: 'helper' })).status, 200);
    expect('the friend sees it', (await call('cust2', 'GET', `/api/servers/${sid}`)).status, 200);
    expect('...in their server list', ((await call('cust2', 'GET', '/api/servers')).data || []).some((x) => x.id === sid), true);
    expect('a helper can see the console', (await call('cust2', 'GET', `/api/servers/${sid}/log`)).status, 200);
    expect("a helper can't open files", (await call('cust2', 'GET', `/api/servers/${sid}/files`)).status, 403);
    expect("a helper can't share it further", (await call('cust2', 'POST', `/api/servers/${sid}/members`, { user: 'cust1', role: 'viewer' })).status, 403);
    await call('cust1', 'POST', `/api/servers/${sid}/members`, { user: 'cust2', role: 'coowner' });
    expect('a co-owner can open files', (await call('cust2', 'GET', `/api/servers/${sid}/files`)).status, 200);
    expect("a co-owner can't delete the server", (await call('cust2', 'DELETE', `/api/servers/${sid}`)).status, 403);
    await call('cust1', 'POST', `/api/servers/${sid}/members`, { user: 'cust2', role: 'viewer' });
    expect("a viewer can't run commands", (await call('cust2', 'POST', `/api/servers/${sid}/command`, { command: 'say hi' })).status, 403);
    expect('sharing with an unknown name explains', (await call('cust1', 'POST', `/api/servers/${sid}/members`, { user: 'nobody-here', role: 'viewer' })).status, 404);
    expect('owner removes access', (await call('cust1', 'DELETE', `/api/servers/${sid}/members/${id('cust2')}`)).status, 200);
    expect('...and the friend loses it', (await call('cust2', 'GET', `/api/servers/${sid}`)).status, 404);
    // sleep when empty, scheduled tasks
    const sl = await call('cust1', 'PUT', `/api/servers/${sid}/sleep`, { enabled: true, minutes: 10 });
    expect('sleep when empty turned on', sl.data && sl.data.sleep && sl.data.sleep.minutes, 10);
    const sch = await call('cust1', 'PUT', `/api/servers/${sid}/schedules`, { schedules: [{ action: 'restart', when: { type: 'daily', time: '04:30', days: [1, 3] } }, { action: 'broadcast', text: 'Vote for us!', when: { type: 'every', hours: 2 } }], timeZone: 'Europe/London' });
    expect('scheduled tasks saved', sch.data && sch.data.schedules.length, 2);
    expect('...with the time zone', sch.data && sch.data.timeZone, 'Europe/London');
    expect('a command task needs the command', (await call('cust1', 'PUT', `/api/servers/${sid}/schedules`, { schedules: [{ action: 'command', when: { type: 'daily', time: '01:00' } }] })).status, 400);
    expect("support can't change schedules", (await call('support1', 'PUT', `/api/servers/${sid}/schedules`, { schedules: [] })).status, 403);
    // performance history, Bedrock rules, world zip
    const st = await call('cust1', 'GET', `/api/servers/${sid}/stats`);
    expect('performance stats answer', st.status === 200 && Array.isArray(st.data.samples), true);
    expect("Bedrock needs Paper/Spigot (this is Vanilla)", (await call('cust1', 'POST', `/api/servers/${sid}/bedrock`, { enabled: true })).status, 400);
    {
      const fs = require('fs');
      const path = require('path');
      const { writeZip } = require('../src/zip');
      const tmp = path.join(require('os').tmpdir(), `th-e2e-world-${Date.now()}`);
      fs.mkdirSync(path.join(tmp, 'MyWorld', 'region'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'MyWorld', 'level.dat'), 'level');
      fs.writeFileSync(path.join(tmp, 'MyWorld', 'region', 'r.0.0.mca'), Buffer.alloc(4096, 7));
      const out = fs.createWriteStream(path.join(tmp, 'w.zip'));
      await writeZip(out, tmp, ['MyWorld']);
      out.end();
      await new Promise((r) => out.on('finish', r));
      const up = await fetch(`${B}/api/servers/${sid}/world`, { method: 'POST', headers: { Origin: B, Cookie: jar.cust1 }, body: fs.readFileSync(path.join(tmp, 'w.zip')) });
      expect('uploading a world zip', up.status, 200);
      const notZip = await fetch(`${B}/api/servers/${sid}/world`, { method: 'POST', headers: { Origin: B, Cookie: jar.cust1 }, body: Buffer.from('not a zip') });
      expect("a file that isn't a zip is refused", notZip.status, 400);
      const down = await fetch(`${B}/api/servers/${sid}/world.zip`, { headers: { Cookie: jar.cust1 } });
      const buf = Buffer.from(await down.arrayBuffer());
      expect('downloading the world gives a zip', down.status === 200 && buf.readUInt32LE(0) === 0x04034b50, true);
      expect('...with the uploaded world in it', buf.includes(Buffer.from('world/level.dat')), true);
      expect("support can't download a customer's world", (await fetch(`${B}/api/servers/${sid}/world.zip`, { headers: { Cookie: jar.support1 } })).status, 403);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    // MOTD with colors and animation
    const motd = await call('cust1', 'PUT', `/api/servers/${sid}/motd`, { frames: ['&6&lHello\n&7world', '&#ff8800Frame 2'], interval: 2 });
    expect('MOTD with colors and frames saved', motd.status === 200 && motd.data.motd.animated, true);
    expect('an empty MOTD is refused', (await call('cust1', 'PUT', `/api/servers/${sid}/motd`, { frames: ['&6'] })).status, 400);
    expect("support can't change the MOTD", (await call('support1', 'PUT', `/api/servers/${sid}/motd`, { frames: ['hi'] })).status, 403);
    expect('MOTD reset', (await call('cust1', 'PUT', `/api/servers/${sid}/motd`, { clear: true })).data.motd, null);
    // custom address
    expect('a bad domain is refused', (await call('cust1', 'PUT', `/api/servers/${sid}/domain`, { domain: 'not a domain' })).status, 400);
    expect("a Tree Host domain can't be claimed", (await call('cust1', 'PUT', `/api/servers/${sid}/domain`, { domain: 'mc.treehost.online' })).status, 400);
    const dom = await call('cust1', 'PUT', `/api/servers/${sid}/domain`, { domain: 'https://Play.Example.com:25565/' });
    expect('a custom domain is saved (cleaned up)', dom.data && dom.data.customDomain.host, 'play.example.com');
    expect('...with the DNS records to add', dom.data && dom.data.customDomain.records.some((r) => r.type === 'SRV' || r.type === 'CNAME'), true);
    expect('...not verified until DNS points here', dom.data && dom.data.customDomain.verified, false);
    expect("another customer can't set it", (await call('cust2', 'PUT', `/api/servers/${sid}/domain`, { domain: 'x.example.com' })).status, 404);
    expect('removing the domain', (await call('cust1', 'PUT', `/api/servers/${sid}/domain`, { domain: '' })).data.customDomain, null);

    // going back to an older Minecraft version needs a fresh world (Minecraft can't open newer worlds)
    await call('cust1', 'PUT', `/api/servers/${sid}/file?path=${encodeURIComponent('world/level.dat')}`, { content: 'pretend world' });
    const down = await call('cust1', 'PATCH', `/api/servers/${sid}`, { version: '1.20.4' });
    expect('switching to an older version with a world is stopped', down.status, 409);
    expect('...and explains why', down.data && down.data.code, 'DOWNGRADE');
    const fresh = await call('cust1', 'PATCH', `/api/servers/${sid}`, { version: '1.20.4', downgrade: 'fresh-world' });
    expect('...unless they choose a fresh world', fresh.status, 200);
    expect('the old world was backed up first', ((await call('cust1', 'GET', `/api/servers/${sid}/backups`)).data || []).length >= 1, true);
    expect('going to a newer version needs no confirmation', (await call('cust1', 'PATCH', `/api/servers/${sid}`, { version: '1.21.1' })).status, 200);

    // server icon
    expect('customer uploads a 64x64 icon', await putIcon('cust1', sid, makePng(64, 64)), 200);
    expect('the server knows it has an icon', !!(await call('cust1', 'GET', `/api/servers/${sid}`)).data.icon, true);
    expect('wrong size is refused', await putIcon('cust1', sid, makePng(32, 32)), 400);
    expect('non-PNG is refused', await putIcon('cust1', sid, Buffer.from('not a picture at all, sorry')), 400);
    expect("another customer can't change it", await putIcon('cust2', sid, makePng(64, 64)), 404);
    expect('support can see the icon', (await fetch(`${B}/api/servers/${sid}/icon`, { headers: { Cookie: jar.support1 } })).status, 200);
    expect('customer removes the icon', (await call('cust1', 'DELETE', `/api/servers/${sid}/icon`)).status, 200);
    expect('...and it is gone', (await fetch(`${B}/api/servers/${sid}/icon`, { headers: { Cookie: jar.cust1 } })).status, 404);
    expect("staff can't delete a customer's server without a reason", (await call('admin1', 'DELETE', `/api/servers/${sid}`)).status, 400);
    expect("developer can't delete customers' servers", (await call('dev1', 'DELETE', `/api/servers/${sid}`)).status, 403);
    const susSrv = await act('support1', { target: 'server', serverId: sid, type: 'suspend', days: 3 });
    expect('support suspends the server', susSrv.status, 200);
    expect('customer cannot start a suspended server', (await call('cust1', 'POST', `/api/servers/${sid}/start`)).status, [402, 423]);
    expect('support lifts it', (await call('support1', 'POST', `/api/admin/actions/${susSrv.data.id}/lift`, { reason: 'Checked, all fine.' })).status, 200);
    const del = await act('admin1', { target: 'server', serverId: sid, type: 'delete' });
    if (del.status !== 200) console.log('   delete said:', JSON.stringify(del.data));
    expect('admin can delete it with a reason (servers.destroy)', del.status, 200);
    expect('the server is gone', (await call('cust1', 'GET', `/api/servers/${sid}`)).status, 404);
  }

  // one-time codes that only work for one account
  const bound = await call('owner1', 'POST', '/api/admin/promos', { planId: 'sapling', months: 1, forUser: 'cust2' });
  expect('owner creates a code only for cust2', bound.status, 200);
  expect('bound code is single-use', bound.data.maxUses, 1);
  expect('bound code knows its account', bound.data.forUsername, 'cust2');
  expect('code for an unknown account is refused', (await call('owner1', 'POST', '/api/admin/promos', { planId: 'sapling', forUser: 'nobody-here' })).status, 404);
  expect('support cannot create codes', (await call('support1', 'POST', '/api/admin/promos', { planId: 'sapling', forUser: 'cust2' })).status, 403);
  const wrong = await call('cust1', 'POST', '/api/billing/redeem', { code: bound.data.code });
  expect('another customer cannot redeem it', wrong.status, 403);
  expect('...and is told why', /different account/.test(wrong.data.error), true);
  expect('the right customer redeems it', (await call('cust2', 'POST', '/api/billing/redeem', { code: bound.data.code })).status, 200);
  expect('it cannot be used again', (await call('cust2', 'POST', '/api/billing/redeem', { code: bound.data.code })).status, 410);

  // how long a free server lasts: presets, lifetime, custom days, and the older "months"
  const life = await call('owner1', 'POST', '/api/admin/promos', { planId: 'sapling', days: 0, forUser: 'cust1' });
  expect('lifetime code', life.data.length, 'lifetime');
  const lifeSub = await call('cust1', 'POST', '/api/billing/redeem', { code: life.data.code });
  expect('lifetime plan has no end date', lifeSub.data.freeUntil, null);
  expect('lifetime plan is labelled', lifeSub.data.freeLength, 'lifetime');
  const week = await call('owner1', 'POST', '/api/admin/subscriptions', { userId: id('cust1'), planId: 'sapling', days: 7 });
  expect('1-week grant ends in 7 days', Math.round((week.data.freeUntil - Date.now()) / 86400000), 7);
  expect('1-week grant is labelled', week.data.freeLength, '1 week');
  expect('custom 45 days', (await call('owner1', 'POST', '/api/admin/promos', { planId: 'sapling', days: 45 })).data.length, '45 days');
  expect('older "months" still work (3 = 90 days)', (await call('owner1', 'POST', '/api/admin/promos', { planId: 'sapling', months: 3 })).data.days, 90);
  expect('a year', (await call('owner1', 'POST', '/api/admin/promos', { planId: 'sapling', days: 365 })).data.length, '1 year');
  expect('silly values are capped (10 years max)', (await call('owner1', 'POST', '/api/admin/promos', { planId: 'sapling', days: 99999 })).data.days, 3650);

  // emails
  expect('email links fall back without branded emails', (await call('cust1', 'POST', '/api/auth/email-link', { type: 'reset', email: 'cust1@example.com' })).data.fallback, true);
  await matrix('GET email settings', 'GET', '/api/admin/emails', undefined, [200, 200, 403, 403, 403]);
  expect('email preview renders', /<h1[^>]*>Welcome, Steve/.test(await (await fetch(`${B}/api/admin/emails/preview/welcome`, { headers: { Cookie: jar.owner1 } })).text()), true);
  expect('test email needs email set up', (await call('owner1', 'POST', '/api/admin/emails/test', {})).status, 400);

  // staff docs: never public files, only staff, and the technical guide only with system info access
  for (const f of ['hosting-guide', 'roles', 'support-playbook']) expect(`/docs/${f}.md is not public`, (await call('cust1', 'GET', `/docs/${f}.md`)).status, 404);
  expect('public guides still load', (await fetch(`${B}/docs/billing.md`)).status, 200);
  await matrix('GET staff docs list', 'GET', '/api/staff/docs', undefined, [200, 200, 200, 200, 403]);
  await matrix('GET support playbook', 'GET', '/api/staff/docs/support-playbook', undefined, [200, 200, 200, 200, 403]);
  await matrix('GET technical guide', 'GET', '/api/staff/docs/hosting-guide', undefined, [200, 200, 200, 404, 403]);
  expect('signed-out visitors get no staff docs', (await fetch(`${B}/api/staff/docs`)).status, 401);
  expect('support list leaves out the technical guide', (await call('support1', 'GET', '/api/staff/docs')).data.docs.some((d) => d.id === 'hosting-guide'), false);
  expect('staff docs come with their text', /Support playbook/.test((await call('support1', 'GET', '/api/staff/docs/support-playbook')).data.markdown), true);
  expect('no path tricks', (await call('owner1', 'GET', '/api/staff/docs/..%2Fpackage')).status, 404);

  // several accounts in one browser, linked accounts
  const browser = new Map(); // one browser's cookies (session, accounts, device)
  const bcall = async (method, p, body) => {
    const res = await fetch(B + p, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: B, Cookie: [...browser].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      if (/Max-Age=0/.test(c)) browser.delete(kv.slice(0, i));
      else browser.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  for (const u of ['multi1', 'multi2', 'multi3']) await call(u, 'POST', '/api/auth/signup', { username: u, email: `${u}@example.com`, password: 'TreeHost-test-123', acceptTerms: true, birthYear: 1995 });
  await bcall('POST', '/api/auth/login', { username: 'multi1', password: 'TreeHost-test-123' });
  await bcall('POST', '/api/auth/login', { username: 'multi2', password: 'TreeHost-test-123' });
  const accts = (await bcall('GET', '/api/auth/accounts')).data.accounts;
  expect('browser has two accounts', accts.length, 2);
  expect('the newest is active', accts.find((x) => x.active).username, 'multi2');
  const m1 = accts.find((x) => x.username === 'multi1').id;
  expect('switch to the other account', (await bcall('POST', '/api/auth/switch', { userId: m1 })).status, 200);
  expect('...and it is active', (await bcall('GET', '/api/auth/me')).data.user.username, 'multi1');
  expect("can't switch to an account that isn't signed in here", (await bcall('POST', '/api/auth/switch', { userId: id('cust1') })).status, 404);
  const people = (await call('owner1', 'GET', '/api/team/users')).data;
  expect('staff see the accounts are linked', people.find((x) => x.username === 'multi1').linked.map((l) => l.username).join(), 'multi2');
  const susBoth = await act('admin1', { target: 'account', userId: m1, type: 'suspend', days: 2 });
  expect('suspending one account...', susBoth.status, 200);
  expect('...also suspends the linked one', susBoth.data.linked && susBoth.data.linked.length, 1);
  expect('linked account is locked out', (await call('multi2', 'GET', '/api/servers')).status, 403);
  expect('linked action points at the first', (await call('owner1', 'GET', `/api/admin/actions/${susBoth.data.linked[0]}`)).data.parentId, susBoth.data.id);
  expect('lifting the first...', (await call('admin1', 'POST', `/api/admin/actions/${susBoth.data.id}/lift`, { reason: 'Sorted out.' })).status, 200);
  expect('...lifts the linked one too', (await call('multi2', 'GET', '/api/servers')).status, 200);
  const banOne = await act('admin1', { target: 'account', userId: m1, type: 'ban', includeLinked: false });
  expect('ban without linked accounts', banOne.data.linked, undefined);
  expect('multi2 not banned', (await call('multi2', 'GET', '/api/servers')).status, 200);
  await bcall('POST', '/api/auth/login', { username: 'multi3', password: 'TreeHost-test-123' });
  expect('a new account on the banned account\'s browser is banned too', (await call('multi3', 'GET', '/api/servers')).status, 403);
  const auto = (await call('owner1', 'GET', '/api/admin/actions?username=multi3')).data.actions[0];
  expect('...as ban evasion, linked to the ban', auto && auto.reason, 'evasion');
  const out = await bcall('POST', '/api/auth/logout');
  expect('signing out switches to another account on the browser', !!out.data.switchedTo, true);
  await bcall('POST', '/api/auth/logout', { all: true });
  expect('sign out of all', (await bcall('GET', '/api/auth/me')).data.user, null);

  // lifetime plan: paid once, 4 servers + 2 proxies
  const plansNow = (await call('cust2', 'GET', '/api/plans')).data.plans;
  const lifePlan = plansNow.find((p) => p.oneTime);
  expect("the lifetime plan is for sale", lifePlan && lifePlan.priceCents, 75000);
  expect("...with 4 servers and 2 proxies", lifePlan && `${lifePlan.slots.servers}/${lifePlan.slots.proxies}`, "4/2");
  await call('owner1', 'PUT', '/api/admin/billing-settings', { capacityMb: 256 * 1024 }); // this PC may be smaller than a node
  await call('life1', 'POST', '/api/auth/signup', { username: 'life1', email: 'life1@example.com', password: 'TreeHost-test-123', acceptTerms: true, birthYear: 1995 });
  expect('buying lifetime (demo)', (await call('life1', 'POST', '/api/billing/checkout', { planId: lifePlan.id, consent: { renewal: true, adult: true, withdrawal: true } })).status, 200);
  const lsub = (await call('life1', 'GET', '/api/billing')).data.subscriptions.find((x) => x.oneTime);
  expect('lifetime plan is active and never renews', lsub && lsub.status === 'active' && !lsub.renewsAt, true);
  expect('account shows lifetime', (await call('life1', 'GET', '/api/auth/me')).data.user.lifetime, true);
  const made = [];
  for (let i = 1; i <= 4; i++) {
    const r = await call('life1', 'POST', '/api/servers', { name: `Life ${i}`, type: 'vanilla', version: '1.21.1', eula: true, subscriptionId: lsub.id });
    if (r.data && r.data.id) made.push(r.data.id);
  }
  expect('4 servers on lifetime', made.length, 4);
  expect('a 5th server is refused', (await call('life1', 'POST', '/api/servers', { name: 'Life 5', type: 'vanilla', version: '1.21.1', eula: true, subscriptionId: lsub.id })).status, 400);
  expect('staff see the lifetime badge', (await call('owner1', 'GET', '/api/team/users')).data.find((x) => x.username === 'life1').lifetime, true);
  for (const id of made) await call('life1', 'DELETE', `/api/servers/${id}`);

  // going-live plan: age gate, checkout consent, lifetime cap, running capacity
  const yr = new Date().getFullYear();
  expect('under-13 sign-up is refused', (await call('kid1', 'POST', '/api/auth/signup', { username: 'kid1', email: 'kid1@example.com', password: 'TreeHost-test-123', acceptTerms: true, birthYear: yr - 10 })).status, 403);
  expect('sign-up without a birth year is refused', (await call('kid2', 'POST', '/api/auth/signup', { username: 'kid2', email: 'kid2@example.com', password: 'TreeHost-test-123', acceptTerms: true })).status, 400);
  expect('checkout without the renewal box is refused', (await call('cust2', 'POST', '/api/billing/checkout', { planId: 'sapling', consent: { adult: true, withdrawal: true } })).status, 400);
  expect('checkout without the 18+/parent box is refused', (await call('cust2', 'POST', '/api/billing/checkout', { planId: 'sapling', consent: { renewal: true, withdrawal: true } })).status, 400);
  expect('checkout without the withdrawal box is refused', (await call('cust2', 'POST', '/api/billing/checkout', { planId: 'sapling', consent: { renewal: true, adult: true } })).status, 400);
  await call('owner1', 'PUT', '/api/admin/billing-settings', { lifetimePerNode: 1 });
  expect('lifetime shows sold out at the per-machine cap', (await call('cust2', 'GET', '/api/plans')).data.plans.find((p) => p.oneTime).soldOut, true);
  expect('buying lifetime past the cap is refused', (await call('cust2', 'POST', '/api/billing/checkout', { planId: lifePlan.id, consent: { adult: true, withdrawal: true } })).status, 409);
  await call('owner1', 'PUT', '/api/admin/billing-settings', { lifetimePerNode: null });
  expect('default cap is 2 lifetime plans', (await call('owner1', 'GET', '/api/admin/billing')).data.lifetimePerNode, 2);
  expect('a customer buys a monthly plan with every box ticked', (await call('cust2', 'POST', '/api/billing/checkout', { planId: 'sapling', consent: { renewal: true, adult: true, withdrawal: true } })).status, 200);
  const tsub = (await call('cust2', 'GET', '/api/billing')).data.subscriptions.filter((x) => x.usable && !x.slots && !x.serverCount).pop();
  const s1 = (await call('cust2', 'POST', '/api/servers', { name: 'Cap 1', type: 'vanilla', version: '1.21.1', eula: true, subscriptionId: tsub.id })).data;
  const s2 = (await call('cust2', 'POST', '/api/servers', { name: 'Cap 2', type: 'vanilla', version: '1.21.1', eula: true, subscriptionId: tsub.id })).data;
  for (let i = 0; i < 120; i++) {
    const st = (await call('cust2', 'GET', '/api/servers')).data.filter((x) => x.id === s1.id || x.id === s2.id);
    if (st.every((x) => x.status === 'stopped')) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const sold = (await call('owner1', 'GET', '/api/admin/billing')).data.soldMb;
  await call('owner1', 'PUT', '/api/admin/billing-settings', { capacityMb: sold + 600 });
  const r1 = await call('cust2', 'POST', `/api/servers/${s1.id}/start`);
  expect('first server on a plan always starts (its memory is reserved)', r1.status, 200);
  const r2 = await call('cust2', 'POST', `/api/servers/${s2.id}/start`);
  expect('an extra server is refused while the machine is full', r2.status !== 200 && /machine is full/.test(r2.data.error || ''), true);
  await call('owner1', 'PUT', '/api/admin/billing-settings', { capacityMb: null });
  await call('cust2', 'POST', `/api/servers/${s1.id}/kill`).catch(() => {});
  await call('cust2', 'POST', `/api/servers/${s1.id}/stop`).catch(() => {});

  const auditLog = (await call('owner1', 'GET', '/api/admin/audit')).data;
  expect('audit log recorded staff actions', auditLog.length >= 8, true);
  console.log('\nAudit log (newest first):');
  for (const e of auditLog.slice(0, 8)) console.log(`  ${e.who}: ${e.text}`);
  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
