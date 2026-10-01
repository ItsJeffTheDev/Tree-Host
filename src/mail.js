'use strict';
// Sends emails (password resets, payment problems) through Resend's HTTP API (https://resend.com, free tier).
// Without RESEND_API_KEY, emails are not sent; admins can still give people a temporary password.
const KEY = process.env.RESEND_API_KEY || '';
const FROM = process.env.MAIL_FROM || 'Tree Host <no-reply@example.com>';

const enabled = () => !!KEY;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** paragraphs: plain-text strings; button: { text, url } (optional). */
async function send(to, subject, paragraphs, button) {
  if (!KEY || !to) return false;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;color:#1c2420">
    <h2 style="color:#2c9a5c;margin-bottom:8px">🌳 Tree Host</h2>
    ${paragraphs.map((p) => `<p style="line-height:1.5">${esc(p)}</p>`).join('')}
    ${button ? `<p><a href="${esc(button.url)}" style="display:inline-block;background:#46c37b;color:#05200f;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">${esc(button.text)}</a></p>` : ''}
    <p style="color:#7a857f;font-size:12px;margin-top:24px">You get this email because you have a Tree Host account.</p></div>`;
  const text = [...paragraphs, button ? `${button.text}: ${button.url}` : ''].join('\n\n');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [to], subject, html, text }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Email failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return true;
}

module.exports = { enabled, send };
