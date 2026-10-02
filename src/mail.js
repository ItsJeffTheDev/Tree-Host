'use strict';
// Sends Tree Host's emails through Resend's HTTP API (https://resend.com): welcome, email verification, password
// resets, plans and payments, staff actions and messages. Every email uses the same branded layout (built from tables
// with inline styles, so it looks right in Gmail, Outlook and phone mail apps) plus a plain-text version.
// Without RESEND_API_KEY nothing is sent; admins can still give people a temporary password.
const KEY = process.env.RESEND_API_KEY || '';
const FROM = process.env.MAIL_FROM || 'Tree Host <no-reply@treehost.online>';
// Where replies go: billing emails to the billing inbox, everything else to support.
const SUPPORT = process.env.TREEHOST_SUPPORT_EMAIL || 'support@treehost.online';
// Links in the footer go to the public site (a local test site's localhost means nothing in someone's inbox).
const SITE = /^https:\/\//.test(process.env.TREEHOST_PUBLIC_URL || '') ? process.env.TREEHOST_PUBLIC_URL.replace(/\/$/, '') : 'https://treehost.online';

const GREEN = '#2fb36d';
const DARK = '#14211a';

const enabled = () => !!KEY;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/** Plain text to HTML: escapes it, keeps line breaks, turns **bold** into bold and links into links. */
const rich = (s) =>
  esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(https?:\/\/[^\s<]+[^\s<.,)])/g, `<a href="$1" style="color:${GREEN};text-decoration:underline">$1</a>`)
    .replace(/\n/g, '<br>');
const plain = (s) => String(s ?? '').replace(/\*\*(.+?)\*\*/g, '$1');

/**
 * The branded email.
 * opts: heading (defaults to the subject), preheader (the preview line in the inbox), details ([[label, value], ...],
 * shown in a box), button ({ text, url }), after (paragraphs after the button), note (small print), replyTo.
 */
function render(subject, paragraphs, button, opts = {}) {
  const heading = opts.heading || subject;
  const replyTo = opts.replyTo || SUPPORT;
  const p = (t) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#2a3530">${rich(t)}</p>`;
  const details = opts.details && opts.details.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 20px;background:#f4f8f5;border:1px solid #dfe9e2;border-radius:10px">
        ${opts.details.map(([k, v], i) => `<tr>
          <td style="padding:10px 16px;font-size:13px;color:#68766e;white-space:nowrap;vertical-align:top;${i ? 'border-top:1px solid #e6eee8;' : ''}">${esc(k)}</td>
          <td style="padding:10px 16px;font-size:14px;color:${DARK};font-weight:600;${i ? 'border-top:1px solid #e6eee8;' : ''}">${rich(v)}</td></tr>`).join('')}
      </table>`
    : '';
  const btn = button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 22px"><tr><td style="border-radius:10px;background:${GREEN}">
        <a href="${esc(button.url)}" style="display:inline-block;padding:14px 26px;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px">${esc(button.text)}</a>
      </td></tr></table>
      <p style="margin:0 0 18px;font-size:12px;line-height:1.5;color:#8a968f">Button not working? Copy this link into your browser:<br><a href="${esc(button.url)}" style="color:#8a968f;word-break:break-all">${esc(button.url)}</a></p>`
    : '';
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#eef3ef;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#eef3ef">${esc(opts.preheader || plain(paragraphs[0] || ''))}&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef3ef"><tr><td align="center" style="padding:28px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
    <tr><td style="background:${GREEN};border-radius:16px 16px 0 0;padding:22px 28px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:middle;width:40px;height:40px;background:#ffffff;border-radius:10px;text-align:center;font-size:24px;line-height:40px">🌳</td>
        <td style="vertical-align:middle;padding-left:12px;font-size:20px;font-weight:800;color:#ffffff;letter-spacing:-.2px">Tree Host</td>
      </tr></table>
    </td></tr>
    <tr><td style="background:#ffffff;padding:30px 28px 14px;border-left:1px solid #dfe9e2;border-right:1px solid #dfe9e2">
      <h1 style="margin:0 0 18px;font-size:24px;line-height:1.3;color:${DARK}">${esc(heading)}</h1>
      ${paragraphs.map(p).join('')}
      ${details}
      ${btn}
      ${(opts.after || []).map(p).join('')}
    </td></tr>
    <tr><td style="background:#ffffff;border:1px solid #dfe9e2;border-top:0;border-radius:0 0 16px 16px;padding:0 28px 26px">
      <p style="margin:0;padding-top:16px;border-top:1px solid #e6eee8;font-size:13px;line-height:1.6;color:#68766e">
        Questions? Just reply to this email or write to <a href="mailto:${esc(replyTo)}" style="color:${GREEN}">${esc(replyTo)}</a>.</p>
    </td></tr>
    <tr><td align="center" style="padding:18px 20px 0;font-size:12px;line-height:1.6;color:#8a968f">
      <a href="${SITE}" style="color:#5f6d65;font-weight:700;text-decoration:none">Tree Host</a> · Minecraft server hosting<br>
      ${esc(opts.note || 'You get this email because you have a Tree Host account.')}
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
  const text = [
    plain(heading),
    '',
    ...paragraphs.map(plain).flatMap((x) => [x, '']),
    ...(opts.details || []).map(([k, v]) => `${k}: ${plain(v)}`),
    opts.details && opts.details.length ? '' : null,
    button ? `${button.text}: ${button.url}\n` : null,
    ...(opts.after || []).map(plain).flatMap((x) => [x, '']),
    `Questions? Reply to this email or write to ${replyTo}.`,
    `-- Tree Host · ${SITE}`,
  ].filter((x) => x !== null).join('\n');
  return { html, text };
}

/** paragraphs: plain-text strings (**bold** allowed); button: { text, url } (optional); opts: see render(). */
async function send(to, subject, paragraphs, button, opts = {}) {
  if (!KEY || !to) return false;
  const { html, text } = render(subject, paragraphs, button, opts);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [to], reply_to: opts.replyTo || SUPPORT, subject, html, text }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Email failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return true;
}

module.exports = { enabled, send, render };
