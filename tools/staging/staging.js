// Staging preview only (added by tools/build-staging.js, never part of the real site).
// Shows a banner on every page, and explains that accounts, the dashboard and servers open at launch.
(() => {
  const DISCORD = window.TH_STAGING_DISCORD || '';
  const css = `
    .stg-bar { position: relative; z-index: 60; background: #f5b50a; color: #1d1600; font: 600 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      padding: 9px 16px; text-align: center; }
    .stg-bar b { font-weight: 800; }
    .stg-bar button { margin-left: 10px; background: #1d1600; color: #f5b50a; border: 0; border-radius: 7px; padding: 4px 10px; font: inherit; font-size: 13px; cursor: pointer; }
    .stg-modal { position: fixed; inset: 0; z-index: 200; background: rgba(3, 6, 4, .82); backdrop-filter: blur(6px); display: grid; place-items: center; padding: 16px; }
    .stg-card { max-width: 480px; width: 100%; background: #142019; border: 1px solid #23342a; border-radius: 16px; padding: 26px 24px; color: #e8efe9;
      font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; box-shadow: 0 30px 80px rgba(0, 0, 0, .5); }
    .stg-card h2 { margin: 0 0 10px; font-size: 22px; }
    .stg-card p { margin: 0 0 12px; color: #c9d4cc; }
    .stg-tag { display: inline-block; background: #f5b50a; color: #1d1600; font-weight: 800; font-size: 12px; letter-spacing: 1px; text-transform: uppercase; border-radius: 6px; padding: 3px 8px; margin-bottom: 12px; }
    .stg-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
    .stg-actions a, .stg-actions button { display: inline-flex; align-items: center; padding: 10px 16px; border-radius: 10px; font: 700 15px system-ui, sans-serif; text-decoration: none; cursor: pointer; border: 1px solid #23342a; background: #18261d; color: #e8efe9; }
    .stg-actions .stg-main { background: linear-gradient(180deg, #7beaa6, #46c37b); color: #05200f; border: 0; }
    @media (max-width: 600px) { .stg-bar { font-size: 13px; } }`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const open = (title) => {
    const m = document.createElement('div');
    m.className = 'stg-modal';
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.innerHTML = `<div class="stg-card">
      <span class="stg-tag">Staging site</span>
      <h2>${title || 'Tree Host isn\'t open yet'}</h2>
      <p>You're looking at a <b>preview</b> of the Tree Host website. It isn't the full site yet.</p>
      <p>Accounts, the dashboard and Minecraft servers open when we <b>launch our servers</b>. Until then you can't sign up or buy a plan here.</p>
      <p>Want to know the moment we go live? ${DISCORD ? 'Join our Discord.' : 'Check back soon.'} You can also help us get there with a donation.</p>
      <div class="stg-actions">
        ${DISCORD ? `<a class="stg-main" href="${DISCORD}" target="_blank" rel="noopener">Join the Discord</a>` : ''}
        <a href="/donate">Donate</a>
        <button type="button" data-stg-close>Keep looking around</button>
      </div></div>`;
    const close = () => m.remove();
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-stg-close]')) close();
    });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') {
        close();
        document.removeEventListener('keydown', esc);
      }
    });
    document.body.appendChild(m);
    const btn = m.querySelector('a, button');
    if (btn) btn.focus();
  };

  const bar = document.createElement('div');
  bar.className = 'stg-bar';
  bar.innerHTML = '<b>Staging site:</b> this is a preview, not the full Tree Host. Sign-ups, the dashboard and servers open when we launch. <button type="button">What does that mean?</button>';
  bar.querySelector('button').addEventListener('click', () => open('This is a preview'));
  document.body.prepend(bar);

  // Anything that needs an account goes to the "not open yet" message instead.
  const closed = /^\/(dashboard|app|admin|staff-docs)(\/|\?|#|$)/;
  document.addEventListener(
    'click',
    (e) => {
      const a = e.target.closest('a[href]');
      if (!a) return;
      const url = new URL(a.getAttribute('href'), location.href);
      if (url.origin !== location.origin || !closed.test(url.pathname + url.search)) return;
      e.preventDefault();
      e.stopPropagation();
      open(/signup/.test(url.search) ? 'Sign-ups open at launch' : 'The dashboard opens at launch');
    },
    true,
  );
})();
