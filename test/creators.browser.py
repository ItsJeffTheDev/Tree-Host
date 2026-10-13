#!/usr/bin/env python3
"""Browser E2E for the creator program (optional layer), in the house style of
test/growth.browser.js: the public /creators page, the creator-code lookup and the
console's Creators tab, against a running demo site.

Python-driven on purpose: this box ships the Python Playwright install (Chromium comes
from the system at /usr/local/bin/chromium) and no node playwright module, so the runner
is `python3 test/creators.browser.py` (`npm run test:creators-browser`). Zero npm deps.

Run (against a FRESH demo server, like test/creators.e2e.js - the owner fixture needs the
first account on the box):
  TREEHOST_PUBLIC_URL=http://localhost:8799 TREEHOST_PORT=8799 BILLING_DEMO=1 \\
  TREEHOST_DATA=/tmp/th-creators-browser TREEHOST_TEST_SITE=1 node src/server.js &
  npm run test:creators-browser
TREEHOST_TEST_URL overrides the base URL. Skipped with a message (exit 0) when no
Chromium binary or Playwright is found, so a box without a browser still passes.
"""
import json
import random
import os
import sys
import urllib.error
import urllib.request

CHROMIUM = os.environ.get('TREEHOST_CHROMIUM', '/usr/local/bin/chromium')
B = os.environ.get('TREEHOST_TEST_URL', 'http://localhost:8799')

if not os.path.exists(CHROMIUM):
    print(f'SKIP  test/creators.browser.py: no Chromium at {CHROMIUM} (set TREEHOST_CHROMIUM)')
    sys.exit(0)
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print('SKIP  test/creators.browser.py: Python Playwright is not installed')
    sys.exit(0)

passes = fails = 0


def check(label, ok, extra=''):
    global passes, fails
    passes, fails = passes + (1 if ok else 0), fails + (0 if ok else 1)
    print(f"{'PASS' if ok else 'FAIL'}  {label}{'' if ok else f'  ({extra})'}")


def http(who, method, path, body=None):
    """Cookie-jar API call, the python twin of test/creators-e2e-helpers.js call()."""
    jar = getattr(http, 'jar', {})
    req = urllib.request.Request(
        B + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={
            'Content-Type': 'application/json',
            'Origin': B,
            **({'Cookie': jar[who]} if who in jar else {}),
            # Distinct source IP per actor (like test/creators.e2e.js): the rate buckets for
            # signup/apply/lookup are per IP. Keep this FIRST in the dict so a caller's own
            # X-Forwarded-For wins over it - the runner tags its fixtures so the browser page
            # (same local address) still has its whole lookup budget left.
            **({'X-Forwarded-For': f'10.14.{(len(who) * 7 + sum(map(ord, who))) % 250}.{len(who) * 13 % 250}'} if who else {}),
        },
    )
    try:
        res = urllib.request.urlopen(req)
    except urllib.error.HTTPError as e:
        res = e
    for c in res.headers.get_all('Set-Cookie') or []:
        if c.startswith('th_session='):
            jar[who] = c.split(';')[0]
    http.jar = jar
    try:
        data = json.loads(res.read().decode() or 'null')
    except Exception:
        data = None
    return res.status, data


def main():
    global passes, fails
    # The server exits 0 silently on an occupied port - assert it is really ours first.
    try:
        status, plans = http(None, 'GET', '/api/plans')
        assert status == 200 and any(p.get('id') == 'sapling' for p in (plans or {}).get('plans', []))
    except Exception:
        print(f'FAIL  no Tree Host with the demo billing plans on {B}. Start it first (see the file header).')
        sys.exit(1)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=CHROMIUM, args=['--no-sandbox'])
        ctx = browser.new_context(viewport={'width': 1280, 'height': 900})
        page = ctx.new_page()
        page_errors = []
        page.on('pageerror', lambda e: page_errors.append(str(e)))
        run(page)
        check('no page errors during the whole run', not page_errors, ' | '.join(page_errors[:3]))
        browser.close()
    print(f'\n{passes} passed, {fails} failed')
    sys.exit(1 if fails else 0)


def run(page):
    # ------------------------------------------------------------------
    # Fixtures over the API: the first signup is the owner (local PUBLIC_URL),
    # a customer, and creator SPARK created by the owner.
    # ------------------------------------------------------------------
    # Owner + customer fixtures. Idempotent across reruns on the same data dir: on a FRESH
    # server the first signup is the owner (local PUBLIC_URL), on a warm one we log back in.
    owner, cust = 'crebrwsr', 'crecust2'
    pw_pass = 'TreeHost-test-123'

    def ensure(u):
        st, _ = http(u, 'POST', '/api/auth/login', {'username': u, 'password': pw_pass})
        if st != 200:
            st, _ = http(u, 'POST', '/api/auth/signup', {
                'username': u, 'email': f'{u}@example.com',
                'password': pw_pass, 'acceptTerms': True, 'birthYear': 1995,
            })
        return st

    status = ensure(owner)
    check('fixture: owner account ready (login or first signup)', status == 200, str(status))
    status, me = http(owner, 'GET', '/api/auth/me')
    check('fixture: account is Owner', (me or {}).get('user', {}).get('role') == 'owner', json.dumps(me)[:160])
    status = ensure(cust)
    check('fixture: customer account ready', status == 200, str(status))
    status, _ = http(owner, 'POST', '/api/admin/creators', {
        'name': 'Sparky', 'code': 'SPARK', 'handle': '@spark', 'platform': 'YouTube',
    })
    check("fixture: owner creates creator SPARK", status in (200, 409), str(status))
    # A referred account (creatorCode SPARK) for the earnings step: the lookup's money comes
    # from /api/creators/me, tied to this account — never from the public lookup.
    status, _ = http('creref', 'POST', '/api/auth/login', {'username': 'creref', 'password': pw_pass})
    if status != 200:
        status, _ = http('creref', 'POST', '/api/auth/signup', {
            'username': 'creref', 'email': 'creref@example.com', 'password': pw_pass,
            'acceptTerms': True, 'birthYear': 1995, 'ref': 'SPARK',
        })
    check('fixture: referred account ready (login or first signup)', status == 200, str(status))
    status, me_ref = http('creref', 'GET', '/api/auth/me')
    check('fixture: referred account carries creatorCode',
          (me_ref or {}).get('user', {}).get('creatorCode') == 'SPARK', json.dumps(me_ref)[:160])
    status, _ = http(owner, 'POST', '/api/admin/creators', {
        'name': 'Old Star', 'code': 'OLSTAR', 'handle': '@oldstar', 'platform': 'Twitch',
    })
    check("fixture: owner creates creator OLSTAR (fresh) or already exists (rerun)", status in (200, 409), str(status))
    status, _ = http(owner, 'POST', '/api/admin/creators', {
        'name': 'Nebula', 'code': 'NEBULA', 'handle': '@nebula', 'platform': 'TikTok',
    })
    check("fixture: owner creates creator NEBULA (fresh) or already exists (rerun)", status in (200, 409), str(status))
    # DELETE toggles status (disable <-> re-enable). A rerun may find it already disabled, so
    # drive it until it reads disabled whatever the starting state (the lookup needs it off).
    for _ in range(2):
        _, row = http(owner, 'GET', '/api/admin/creators')
        codes = {c['code']: c['status'] for c in (row or {}).get('creators', [])}
        if codes.get('OLSTAR') == 'disabled':
            break
        status, _ = http(owner, 'DELETE', '/api/admin/creators/OLSTAR')
    check("fixture: owner disables creator OLSTAR",
          codes.get('OLSTAR') == 'disabled', f"OLSTAR={codes.get('OLSTAR')} last status={status}")

    # ------------------------------------------------------------------
    # 1. Public /creators page renders: hero, tier ladder cards, apply form, lookup widget
    # ------------------------------------------------------------------
    lookup_tag = f'10.14.{random.randint(20, 200)}.{random.randint(20, 200)}'
    page.goto(B + '/creators', wait_until='networkidle')
    # The browser page shares the per-IP lookup AND apply buckets with this local IP, so its
    # calls go out with their own X-Forwarded-For tag (clientIp trusts the header from this
    # PC): the runner's fixtures never eat the page's budget, and each run gets a fresh tag
    # so warm-server reruns inside the 15-minute window stay under both caps.
    page.route('**/api/creators/lookup*', lambda route: route.continue_(
        headers={**route.request.headers, 'x-forwarded-for': lookup_tag}))
    page.route('**/api/creators/apply', lambda route: route.continue_(
        headers={**route.request.headers, 'x-forwarded-for': lookup_tag}))
    hero = page.evaluate("""() => ({
        h1: document.querySelector('.page-hero h1')?.textContent || '',
        tiers: [...document.querySelectorAll('.tier-grid .tier-card')].map((c) => ({
            name: c.querySelector('h3')?.textContent.trim(), pct: c.querySelector('.tier-pct')?.textContent || null,
        })),
        form: !!document.getElementById('apply-form'),
        lookup: !!document.getElementById('l-code') && !!document.getElementById('l-go'),
    })""")
    check('creators page: hero renders', 'recommend' in hero['h1'].lower() or 'paid' in hero['h1'].lower(), hero['h1'])
    check('creators page: three tier ladder cards with 10/15/20%',
          [t['pct'] for t in hero['tiers'][:3]] == ['10%', '15%', '20%'], json.dumps(hero['tiers']))
    check('creators page: apply form renders', hero['form'])
    check('creators page: lookup widget renders (input + button)', hero['lookup'])
    # The apply form actually works (public POST /api/creators/apply).
    page.fill('#a-name', 'Browser Tester')
    page.fill('#a-handle', '@browsertester')
    page.select_option('#a-platform', 'YouTube')
    page.fill('#a-message', 'Browser suite application - I make SMP survival series.')
    page.click('#a-go')
    try:
        page.wait_for_function("() => !document.getElementById('a-ok').hidden", timeout=8000)
        check('creators page: apply form submits and confirms', True)
    except Exception:
        check('creators page: apply form submits and confirms', False,
              (page.text_content('#a-err') or '').strip())

    # ------------------------------------------------------------------
    # 2. Lookup UX: valid code -> tier badge + stats + copy; unknown AND disabled
    #    -> the identical "not available" state (GAP-1).
    # ------------------------------------------------------------------
    page.fill('#l-code', 'spark')
    page.click('#l-go')
    page.wait_for_selector('#lookup-result:not([hidden])', timeout=8000)
    result = page.evaluate("""() => ({
        badge: document.getElementById('r-tier-badge')?.textContent.trim(),
        badgeClass: document.getElementById('r-tier-badge')?.className,
        signups: document.getElementById('r-signups')?.textContent,
        paying: document.getElementById('r-paying')?.textContent,
        tier: document.getElementById('r-tier')?.textContent,
        link: document.getElementById('r-link')?.textContent,
        copy: !!document.getElementById('r-copy'),
        moneyShown: !document.getElementById('r-money')?.hidden,
        loginShown: !document.getElementById('r-login')?.hidden,
    })""")
    check('lookup: valid code shows tier badge "BRONZE · 10%"',
          result['badge'] == 'Bronze · 10%' and 'bronze' in result['badgeClass'], json.dumps(result))
    check('lookup: valid code shows stat boxes (signups, paying, tier — no balance)',
          result['signups'] is not None and result['paying'] is not None
          and result['tier'] == 'Bronze', json.dumps(result))
    check('lookup: public result shows NO money panel (privacy)',
          not result['moneyShown'] and result['loginShown'], json.dumps(result))
    check('lookup: valid code shows the shareable referral link',
          result['link'].endswith('/?ref=SPARK'), result['link'])
    check('lookup: valid code shows a copy button', result['copy'])
    page.click('#r-copy')
    page.wait_for_function("() => document.getElementById('r-copy').textContent === 'Copied!'", timeout=3000)
    check('lookup: copy button flips to Copied!', True)

    # Earnings step, signed out: the log-in nudge, never an amount (CREATORS-T16).
    login_nudge = page.evaluate("""() => ({
        text: document.getElementById('r-login-text')?.textContent || '',
        href: document.getElementById('r-login-link')?.getAttribute('href'),
    })""")
    check('lookup: signed-out earnings step asks to log in with the signup account',
          'Log in with the account you signed up through your link' in login_nudge['text']
          and login_nudge['href'].startswith('/dashboard?signup'), json.dumps(login_nudge))
    page.click('#r-back')
    page.wait_for_selector('#lookup-idle:not([hidden])', timeout=5000)

    # Unknown code and a disabled code must land on the exact same "not available" state.
    page.fill('#l-code', 'NOSUCHCODE')
    page.click('#l-go')
    page.wait_for_selector('#lookup-dead:not([hidden])', timeout=8000)
    unknown = page.evaluate("""() => ({
        dead: !document.getElementById('lookup-dead').hidden,
        result: !document.getElementById('lookup-result').hidden,
        idle: !document.getElementById('lookup-idle').hidden,
        head: document.querySelector('#lookup-dead b')?.textContent || '',
        err: document.getElementById('l-err')?.hidden,
    })""")
    check('lookup: unknown code -> "no longer active" state, not the result panel',
          unknown['dead'] and not unknown['result'] and not unknown['idle'], json.dumps(unknown))
    page.click('#d-back')
    page.wait_for_selector('#lookup-idle:not([hidden])', timeout=5000)
    page.fill('#l-code', 'OLSTAR')
    page.click('#l-go')
    page.wait_for_selector('#lookup-dead:not([hidden])', timeout=8000)
    disabled = page.evaluate("""() => ({
        dead: !document.getElementById('lookup-dead').hidden,
        result: !document.getElementById('lookup-result').hidden,
        head: document.querySelector('#lookup-dead b')?.textContent || '',
    })""")
    check('lookup: disabled code -> the same "not available" state as unknown',
          disabled['dead'] and not disabled['result'] and disabled['head'] == unknown['head'], json.dumps(disabled))

    # ------------------------------------------------------------------
    # 2b. Earnings step signed in (CREATORS-T16): the referred account sees its money inline;
    # a signed-in account whose creatorCode doesn't match gets the "different account" message.
    # ------------------------------------------------------------------
    page.evaluate("() => fetch('/api/auth/logout', { method: 'POST' })")
    page.goto(B + '/dashboard', wait_until='load')
    page.fill('#auth-form input[name="username"]', 'creref')
    page.fill('#auth-form input[name="password"]', pw_pass)
    page.click('#auth-form button.btn.primary')
    page.wait_for_function("() => !document.getElementById('auth-form')", timeout=15000)
    page.goto(B + '/creators', wait_until='networkidle')
    page.fill('#l-code', 'spark')
    page.click('#l-go')
    page.wait_for_selector('#lookup-result:not([hidden])', timeout=8000)
    page.wait_for_function("() => !document.getElementById('r-money').hidden", timeout=8000)
    mine = page.evaluate("""() => ({
        balance: document.getElementById('r-balance')?.textContent,
        paidout: document.getElementById('r-paidout')?.textContent,
        earnings: document.getElementById('r-earnings')?.textContent || '',
        hint: document.getElementById('r-payout-hint')?.textContent || '',
        loginHidden: document.getElementById('r-login')?.hidden,
    })""")
    check('lookup: signed-in referred account sees its earnings inline (balance + paid out)',
          mine['balance'].startswith('$') and mine['paidout'].startswith('$'), json.dumps(mine))
    check('lookup: payout hint names promotion@treehost.online',
          'promotion@treehost.online' in mine['hint'], mine['hint'])
    # The same session, an ACTIVE code that belongs to a DIFFERENT account: the private nudge,
    # no money — and no hint that this account is or isn't the code's owner beyond the nudge.
    page.click('#r-back')
    page.wait_for_selector('#lookup-idle:not([hidden])', timeout=5000)
    page.fill('#l-code', 'NEBULA')
    page.click('#l-go')
    page.wait_for_function("() => !document.getElementById('r-login').hidden", timeout=8000)
    other = page.evaluate("""() => ({
        text: document.getElementById('r-login-text')?.textContent || '',
        moneyHidden: document.getElementById('r-money')?.hidden,
    })""")
    check('lookup: signed-in, code belongs to a different account -> private nudge, no money',
          'different account' in other['text'] and other['moneyHidden'], json.dumps(other))

    # ------------------------------------------------------------------
    # 3. Console Creators tab: renders for an owner, permission-gated for a customer.
    # ------------------------------------------------------------------
    # Owner signs in through the UI, opens /admin#creators.
    page.goto(B + '/dashboard', wait_until='load')
    page.evaluate("""async () => {
        await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    }""")
    page.goto(B + '/dashboard', wait_until='load')
    page.fill('#auth-form input[name="username"]', owner)
    page.fill('#auth-form input[name="password"]', 'TreeHost-test-123')
    page.click('#auth-form button.btn.primary')
    # The auth card already sits on /dashboard, so the URL says nothing: the sign-in is done
    # when the form is replaced by the dashboard.
    page.wait_for_function("() => !document.getElementById('auth-form')", timeout=15000)
    page.goto(B + '/admin#creators', wait_until='load')
    page.wait_for_selector('.console-nav', timeout=15000)
    owner_view = page.evaluate("""() => ({
        tabs: [...document.querySelectorAll('.console-nav a[data-sec]')].map((a) => a.dataset.sec),
        creators: !!document.querySelector('.console-nav a[data-sec="creators"]'),
        body: document.getElementById('console-body')?.textContent || '',
        add: !!document.getElementById('cr-add'),
    })""")
    check('console: owner has a Creators tab', owner_view['creators'], json.dumps(owner_view['tabs']))
    # The section fetches its data: wait until the table (or the empty text) is there.
    page.wait_for_function(
        "() => { const b = document.getElementById('console-body'); return b && !/Loading/.test(b.textContent); }",
        timeout=10000)
    owner_view['body'] = page.text_content('#console-body') or ''
    owner_view['add'] = page.evaluate("() => !!document.getElementById('cr-add')")
    check('console: Creators tab lists SPARK with its stats and actions',
          'SPARK' in owner_view['body'] and owner_view['add'] and 'Ledger' in owner_view['body'],
          owner_view['body'][:150])

    # Permission gate: a customer has no Creators tab, and the API answers 403.
    page.evaluate("() => fetch('/api/auth/logout', { method: 'POST' })")
    page.goto(B + '/dashboard', wait_until='load')
    page.fill('#auth-form input[name="username"]', cust)
    page.fill('#auth-form input[name="password"]', 'TreeHost-test-123')
    page.click('#auth-form button.btn.primary')
    page.wait_for_function("() => !document.getElementById('auth-form')", timeout=15000)
    page.goto(B + '/admin', wait_until='load')
    page.wait_for_function("() => document.getElementById('main')?.textContent.includes('Staff Console')", timeout=10000)
    cust_view = page.evaluate("""() => ({
        tabs: [...document.querySelectorAll('.console-nav a[data-sec]')].map((a) => a.dataset.sec),
        gate: (document.getElementById('main')?.textContent || '').includes("doesn't have access"),
    })""")
    check('console: customer sees no Creators tab (console gated)', not cust_view['tabs'] and cust_view['gate'],
          json.dumps(cust_view))
    status, _ = http(cust, 'GET', '/api/admin/creators')
    check('console: customer GET /api/admin/creators -> 403', status == 403, str(status))
    status, _ = http(owner, 'GET', '/api/admin/creators')
    check('console: owner GET /api/admin/creators -> 200', status == 200, str(status))


if __name__ == '__main__':
    main()
