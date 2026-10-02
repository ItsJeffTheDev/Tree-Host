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
  const set = res.headers.get('set-cookie');
  if (set) jar[who] = set.split(';')[0];
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

function expect(label, got, want) {
  const ok = Array.isArray(want) ? want.includes(got) : got === want;
  if (ok) passes++; else fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${got}${ok ? '' : `, wanted ${want}`}`);
}

(async () => {
  const signup = (u) => call(u, 'POST', '/api/auth/signup', { username: u, email: `${u}@example.com`, password: 'TreeHost-test-123', acceptTerms: true });
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

  // suspensions: only people below you
  expect('admin suspends a customer', (await call('admin1', 'PUT', `/api/team/users/${id('cust2')}/disabled`, { disabled: true })).status, 200);
  expect('admin unsuspends', (await call('admin1', 'PUT', `/api/team/users/${id('cust2')}/disabled`, { disabled: false })).status, 200);
  // suspending signs someone out everywhere: sign cust2 back in
  await call('cust2', 'POST', '/api/auth/login', { username: 'cust2', password: 'TreeHost-test-123' });
  expect('admin cannot suspend the owner', (await call('admin1', 'PUT', `/api/team/users/${id('owner1')}/disabled`, { disabled: true })).status, 403);
  expect('support cannot suspend', (await call('support1', 'PUT', `/api/team/users/${id('cust2')}/disabled`, { disabled: true })).status, 403);

  // a customer's server: who can see / operate / destroy it
  await call('cust1', 'POST', '/api/billing/checkout', { planId: 'sapling' });
  const sub = (await call('cust1', 'GET', '/api/billing')).data.subscriptions[0];
  const created = await call('cust1', 'POST', '/api/servers', { name: 'Cust Server', type: 'vanilla', version: '1.21.1', eula: true, subscriptionId: sub.id });
  expect('customer creates a server', created.status, 200);
  const sid = created.data && created.data.id;
  if (sid) {
    expect('owner of server sees it', (await call('cust1', 'GET', `/api/servers/${sid}`)).status, 200);
    expect('other customer gets 404', (await call('cust2', 'GET', `/api/servers/${sid}`)).status, 404);
    expect('support sees it', (await call('support1', 'GET', `/api/servers/${sid}`)).status, 200);
    expect('support can edit settings', (await call('support1', 'PUT', `/api/servers/${sid}/properties`, {})).status, 200);
    expect('support cannot delete', (await call('support1', 'DELETE', `/api/servers/${sid}`)).status, 403);
    expect('support cannot set a custom Java path', (await call('support1', 'PATCH', `/api/servers/${sid}`, { java: '/usr/bin/java' })).status, 403);
    expect('developer may set host settings', (await call('dev1', 'PATCH', `/api/servers/${sid}`, { java: 'auto' })).status, 200);
    // take servers.edit away from Support and check it bites immediately
    await call('owner1', 'PUT', '/api/admin/roles/staff', { permissions: staffPerms.filter((p) => p !== 'servers.edit') });
    expect('support without servers.edit is blocked', (await call('support1', 'PUT', `/api/servers/${sid}/properties`, {})).status, 403);
    await call('owner1', 'PUT', '/api/admin/roles/staff', { permissions: staffPerms });
    expect('developer can kill it (servers.operate)', (await call('dev1', 'POST', `/api/servers/${sid}/kill`)).status, 200);
    for (let i = 0; i < 20 && (await call('dev1', 'GET', `/api/servers/${sid}`)).data.status !== 'stopped'; i++) await new Promise((r) => setTimeout(r, 500));
    const del = await call('dev1', 'DELETE', `/api/servers/${sid}`);
    if (del.status !== 200) console.log('   delete said:', JSON.stringify(del.data));
    expect('developer can delete (servers.destroy)', del.status, 200);
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

  const auditLog = (await call('owner1', 'GET', '/api/admin/audit')).data;
  expect('audit log recorded staff actions', auditLog.length >= 8, true);
  console.log('\nAudit log (newest first):');
  for (const e of auditLog.slice(0, 8)) console.log(`  ${e.who}: ${e.text}`);
  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
