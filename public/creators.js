'use strict';
// Creator earnings: the dashboard panel for accounts that signed up through a creator's
// referral link (user.creatorCode). Data comes from /api/creators/me — the AUTHENTICATED
// endpoint, tied to the signed-in account, which is the only surface that carries money
// amounts (daniel, CREATORS-T16: the public lookup is non-sensitive aggregates only). The
// endpoint has no per-IP rate limit, but the fetch is still once per modal open and only
// re-fetched through the explicit Refresh button — never automatically.
// Loaded before app.js; uses app.js/team.js helpers ($, esc, ic, api, toast, money, openModal, state) at call time.

// The client-side copy of the creator tier ladder (src/creators.js TIER_LADDER). Deployments
// can override the ladder server-side (settings.creatorTiers), in which case the server's
// tier label still wins — this copy is only used to show progress to the next tier.
const CREATOR_TIER_LADDER = [
  { id: 'bronze', label: 'Bronze', percent: 10, minPaying: 0 },
  { id: 'silver', label: 'Silver', percent: 15, minPaying: 5 },
  { id: 'gold', label: 'Gold', percent: 20, minPaying: 25 },
];

// In-memory cache: one fetch per open unless Refresh is pressed. Cleared on sign-out
// indirectly (a fresh page load) — a code that stops resolving is handled per fetch below.
let creatorLookupCache = null; // { at, data } | null

// The public promo inbox, learned once from /api/site (the page already fetches it for the
// footer); the payout-request mailto needs a PUBLIC address — publicUser deliberately has
// no email on it.
let creatorPromoEmail = null;
if (typeof fetch === 'function') {
  fetch('/api/site').then((r) => r.json()).then((site) => { creatorPromoEmail = site.promoEmail || null; }).catch(() => {});
}

async function fetchCreatorMe() {
  const data = await api('GET', '/api/creators/me');
  creatorLookupCache = { at: Date.now(), data };
  return data;
}

function creatorNextTier(tierId) {
  const i = CREATOR_TIER_LADDER.findIndex((t) => t.id === tierId);
  return i >= 0 && i + 1 < CREATOR_TIER_LADDER.length ? CREATOR_TIER_LADDER[i + 1] : null;
}

function creatorActivityItem(e) {
  return `<div class="act-item">
    <span class="act-icon">${ic('sparkle')}</span>
    <div class="act-text">${esc(e.label)}
      <div class="small muted" title="${esc(new Date(e.at).toLocaleString())}">${timeAgo(e.at)} · ${e.amountCents < 0 ? '-' : ''}${money(Math.abs(e.amountCents))}</div>
    </div>
  </div>`;
}

async function openCreatorEarnings() {
  const code = state.me?.user?.creatorCode;
  if (!code) return; // guarded in app.js too; the panel makes no sense without an account-referred creator
  const { root, close } = openModal(`
    <h2>${ic('star')} Creator earnings — ${esc(code)}</h2>
    <div class="row" style="justify-content:flex-end;margin-top:-10px"><button class="btn sm" id="creator-refresh">${ic('refresh')} Refresh</button></div>
    <div id="creator-body" class="muted">Loading...</div>
    <div class="modal-actions"><button class="btn" data-close>Close</button></div>`);
  const body = $('#creator-body', root);
  let data = creatorLookupCache ? creatorLookupCache.data : null;

  const draw = () => {
    if (!data.found) {
      // Disabled (or removed) mid-session. The code is the credential, so unknown and
      // disabled answer the same { found: false } — same wording either way.
      body.classList.remove('muted');
      body.innerHTML = `
      <div class="warn-box">${ic('alert')} This creator code is no longer active.</div>
      <p class="hint" style="margin:0">If you think this is a mistake, write to <a href="mailto:${esc(creatorPromoEmail || 'promotion@treehost.online')}">${esc(creatorPromoEmail || 'promotion@treehost.online')}</a>.</p>`;
      return;
    }
    const next = creatorNextTier(data.tier.id);
    const ladder = CREATOR_TIER_LADDER;
    const cur = ladder.find((t) => t.id === data.tier.id) || ladder[0];
    const pct = next ? Math.min(100, Math.round((data.stats.payingReferrals / next.minPaying) * 100)) : 100;
    const s = data.stats;
    const earned = s.balanceCents + s.paidOutCents;
    const link = `${location.origin}/${data.code}`;
    const vc = data.viewerCode;
    const promo = creatorPromoEmail;
    body.classList.remove('muted');
    body.innerHTML = `
      <div class="stat-row">
        <div class="stat"><div class="stat-num">${s.signups}</div><div class="stat-label">Signups from your link</div></div>
        <div class="stat"><div class="stat-num">${s.payingReferrals}</div><div class="stat-label">Paying referrals</div></div>
        <div class="stat"><div class="stat-num">${money(earned)}</div><div class="stat-label">Total earned</div></div>
        <div class="stat"><div class="stat-num">${money(s.balanceCents)}</div><div class="stat-label">Current balance</div></div>
      </div>
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:baseline">
          <h3 style="margin:0">${esc(data.tier.label)} · ${data.tier.percent}%</h3>
          <span class="small muted">your cut of a referred plan's first payment</span>
        </div>
        ${
          next
            ? `<div class="progress" style="margin-top:10px">
                <div class="progress-label">${next.minPaying - s.payingReferrals} more paying customers to reach ${esc(next.label)} (${next.percent}%)</div>
                <div class="bar"><div style="width:${pct}%"></div></div>
              </div>`
            : '<p class="hint" style="margin:10px 0 0">Top tier reached — nice one.</p>'
        }
      </div>
      <div class="card stack" style="margin-top:12px">
        <h3 style="margin:0">Your links</h3>
        <div class="row" style="align-items:center;gap:8px">
          <span class="copy" data-copy="${esc(link)}" style="font-family:var(--mono)">${esc(link)}</span>
          <button class="btn sm" id="creator-copy-link">${ic('clip')} Copy link</button>
        </div>
        ${
          vc
            ? `<div class="hint">Viewer discount code: <b>${esc(vc.code)}</b> — ${vc.percentOff}% off for your viewers${vc.active ? '' : ' <span class="badge red">paused</span>'}.</div>`
            : ''
        }
      </div>
      <div class="card stack" style="margin-top:12px">
        <h3 style="margin:0">Recent activity</h3>
        ${
          (data.recent || []).length
            ? data.recent.map(creatorActivityItem).join('')
            : '<p class="hint" style="margin:0">Nothing yet. Share your link to get started.</p>'
        }
      </div>
      <div class="card stack" style="margin-top:12px">
        <div class="row" style="justify-content:space-between;align-items:center">
          <h3 style="margin:0">Payouts</h3>
          <span class="small muted">paid out so far: ${money(s.paidOutCents)}</span>
        </div>
        <p class="hint" style="margin:0">${esc(data.payoutHint)} Payouts are sent manually — request one any time.</p>
        <a class="btn sm" id="creator-payout" href="#">${ic('mail')} Request payout</a>
      </div>
      <p class="hint small" style="margin:12px 0 0">Your code is <b>${esc(data.code)}</b> — keep it handy.</p>`;
    $('#creator-copy-link', root).addEventListener('click', () =>
      navigator.clipboard.writeText(link).then(() => toast('Link copied')));
    $('#creator-payout', root).addEventListener('click', () => {
      const addr = creatorPromoEmail || 'promotion@treehost.online';
      location.href = `mailto:${addr}?subject=${encodeURIComponent(`Payout request ${data.code}`)}`;
    });
  };

  const refresh = async (manual) => {
    body.classList.add('muted');
    body.textContent = 'Loading...';
    try {
      data = await fetchCreatorMe();
      draw();
    } catch (e) {
      body.classList.remove('muted');
      // 401 here means the session lapsed: say so plainly instead of the generic error text.
      body.innerHTML = e.status === 401 || e.code === 'AUTH'
        ? '<div class="warn-box">Please sign in again to see your earnings.</div>'
        : `<div class="warn-box">${esc(e.message)}</div>`;
    }
  };

  if (data) draw(); // cached from an earlier open: skip the fetch entirely (rate-limited endpoint)
  else refresh(false);
  $('#creator-refresh', root).addEventListener('click', () => refresh(true));
}
