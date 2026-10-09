// Staging site notice (TREEHOST_STAGING=1): a pill at the bottom of every page, with a short explanation on click.
(() => {
  fetch('/api/site')
    .then((r) => r.json())
    .then((site) => {
      if (site.testSite) return testSitePill(site.testSite);
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

// Test site notice (TREEHOST_TEST_SITE=1): not dedicated hardware, and testers' servers reset on a schedule.
function testSitePill(t) {
  if (document.getElementById('stg-pill')) return;
  const style = document.createElement('style');
  style.textContent = `
    #stg-pill { position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%); z-index: 9999; background: #f5b50a; color: #1d1600;
      font: 700 14px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; padding: 9px 16px; border-radius: 999px; border: 0;
      box-shadow: 0 8px 26px rgba(0,0,0,.45); cursor: pointer; max-width: calc(100vw - 24px); text-align: center; }
    #stg-box { position: fixed; inset: 0; z-index: 10000; background: rgba(3,6,4,.8); display: grid; place-items: center; padding: 16px; }
    #stg-box > div { max-width: 480px; background: #142019; color: #e8efe9; border: 1px solid #23342a; border-radius: 16px; padding: 24px;
      font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    #stg-box h2 { margin: 0 0 10px; font-size: 22px; }
    #stg-box p { margin: 0 0 12px; color: #c9d4cc; }
    #stg-box button { background: linear-gradient(180deg,#7beaa6,#46c37b); color: #05200f; border: 0; border-radius: 10px; padding: 10px 18px; font: 700 15px system-ui, sans-serif; cursor: pointer; }`;
  document.head.appendChild(style);
  const left = () => {
    const ms = Math.max(0, t.nextResetAt - Date.now());
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h ? `${h}h ${m}m` : `${m} min`;
  };
  const pill = document.createElement('button');
  pill.id = 'stg-pill';
  pill.type = 'button';
  const draw = () => (pill.innerHTML = `<b>Test site</b> · may be slow · servers reset in ${left()}`);
  draw();
  setInterval(draw, 30000);
  pill.addEventListener('click', () => {
    const box = document.createElement('div');
    box.id = 'stg-box';
    box.innerHTML = `<div role="dialog" aria-modal="true"><h2>This is a Tree Host test site</h2>
      <p>Make an account and a server, and try everything. It's free.</p>
      <p><b>Servers may be slow:</b> this test site runs on a home PC, not on dedicated hosting hardware like the real Tree Host.</p>
      <p><b>Everything resets:</b> testers' servers are deleted every ${t.resetHours} hours. The next reset is in ${left()} (${new Date(t.nextResetAt).toLocaleString()}).</p>
      <button type="button">Got it</button></div>`;
    box.addEventListener('click', (e) => { if (e.target === box || e.target.tagName === 'BUTTON') box.remove(); });
    document.body.appendChild(box);
  });
  document.body.appendChild(pill);
}
