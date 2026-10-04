// Staging site notice (TREEHOST_STAGING=1): a pill at the bottom of every page, with a short explanation on click.
(() => {
  fetch('/api/site')
    .then((r) => r.json())
    .then((site) => {
      if (!site.staging || document.getElementById('stg-pill')) return;
      const style = document.createElement('style');
      style.textContent = `
        #stg-pill { position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%); z-index: 9999; background: #f5b50a; color: #1d1600;
          font: 700 14px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; padding: 9px 16px; border-radius: 999px; border: 0;
          box-shadow: 0 8px 26px rgba(0,0,0,.45); cursor: pointer; max-width: calc(100vw - 24px); text-align: center; }
        #stg-pill b { font-weight: 900; }
        #stg-box { position: fixed; inset: 0; z-index: 10000; background: rgba(3,6,4,.8); display: grid; place-items: center; padding: 16px; }
        #stg-box > div { max-width: 460px; background: #142019; color: #e8efe9; border: 1px solid #23342a; border-radius: 16px; padding: 24px;
          font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
        #stg-box h2 { margin: 0 0 10px; font-size: 22px; }
        #stg-box p { margin: 0 0 12px; color: #c9d4cc; }
        #stg-box button { background: linear-gradient(180deg,#7beaa6,#46c37b); color: #05200f; border: 0; border-radius: 10px; padding: 10px 18px; font: 700 15px system-ui, sans-serif; cursor: pointer; }`;
      document.head.appendChild(style);
      const pill = document.createElement('button');
      pill.id = 'stg-pill';
      pill.type = 'button';
      pill.innerHTML = '<b>Staging site</b> · servers and plans open at launch';
      pill.addEventListener('click', () => {
        const box = document.createElement('div');
        box.id = 'stg-box';
        box.innerHTML = `<div role="dialog" aria-modal="true"><h2>This is the staging site</h2>
          <p>You can explore everything: make an account, sign in, and look around the dashboard.</p>
          <p>Creating servers and buying plans are switched off until Tree Host launches. Accounts made here are for testing and may be reset.</p>
          <button type="button">Got it</button></div>`;
        box.addEventListener('click', (e) => { if (e.target === box || e.target.tagName === 'BUTTON') box.remove(); });
        document.body.appendChild(box);
      });
      document.body.appendChild(pill);
    })
    .catch(() => {});
})();
