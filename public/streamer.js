'use strict';
// Streamer mode: hides email addresses and public IP addresses everywhere on the dashboard while you're live.
// Turn it on or off with Ctrl+Shift+S, the "Streamer mode" button in your account menu, or ?streamer=1 in the address.
// Masking happens as text is drawn (a MutationObserver), so lists and popups that appear later are covered too.
(() => {
  const KEY = 'th.streamer';
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  // IPv4 addresses, but not local ones (127.x, 192.168.x, 10.x) which say nothing about where you are.
  const IP = /\b(?!127\.|10\.|192\.168\.|0\.0\.0\.0)(?:\d{1,3}\.){3}\d{1,3}\b/g;
  const MASK = '••••••';
  let on = false;
  let observer = null;

  const read = () => {
    try {
      return localStorage.getItem(KEY) === '1';
    } catch {
      return false;
    }
  };
  const write = (v) => {
    try {
      localStorage.setItem(KEY, v ? '1' : '0');
    } catch {}
  };

  function maskText(node) {
    const t = node.nodeValue;
    if (!t || (t.indexOf('@') < 0 && !/\d+\.\d+\.\d+\.\d+/.test(t))) return;
    const next = t.replace(EMAIL, MASK).replace(IP, MASK);
    if (next !== t) node.nodeValue = next;
  }

  function maskTree(root) {
    if (root.nodeType === 3) return maskText(root);
    if (root.nodeType !== 1 || root.closest?.('script,style')) return;
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) maskText(n);
    // Copy buttons and tooltips carry the address too (the element itself and everything inside it).
    const els = [...(root.matches && root.matches('[data-copy],[title]') ? [root] : []), ...root.querySelectorAll('[data-copy],[title]')];
    for (const el of els) {
      for (const a of ['data-copy', 'title']) {
        const v = el.getAttribute(a);
        if (!v) continue;
        const next = v.replace(EMAIL, MASK).replace(IP, MASK);
        if (next !== v) el.setAttribute(a, next);
      }
    }
  }

  function badge(show) {
    let b = document.getElementById('streamer-badge');
    if (!show) return b && b.remove();
    if (b) return;
    b = document.createElement('button');
    b.id = 'streamer-badge';
    b.type = 'button';
    b.title = 'Emails and IP addresses are hidden. Click (or Ctrl+Shift+S) to turn streamer mode off.';
    b.textContent = '● Streamer mode';
    b.style.cssText = 'position:fixed;top:10px;right:10px;z-index:10001;background:#c62828;color:#fff;border:0;border-radius:999px;padding:6px 12px;font:700 12px system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.4)';
    b.addEventListener('click', () => set(false));
    document.body.appendChild(b);
  }

  function set(v) {
    write(v);
    if (!v && on) return location.reload(); // put the real text back
    on = v;
    document.documentElement.classList.toggle('streamer', v);
    badge(v);
    if (v) {
      maskTree(document.body);
      observer = new MutationObserver((list) => {
        for (const m of list) {
          if (m.type === 'characterData') maskText(m.target);
          else m.addedNodes.forEach(maskTree);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
  }

  window.streamerMode = { get: () => on, toggle: () => set(!on) };
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'S' || e.key === 's')) {
      e.preventDefault();
      set(!on);
    }
  });
  const start = () => {
    if (new URLSearchParams(location.search).get('streamer') === '1') write(true);
    if (read()) set(true);
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
