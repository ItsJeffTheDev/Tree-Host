'use strict';
// Detects a Tailscale Funnel that points at Honey Host, which gives the dashboard a permanent, free HTTPS link.
const path = require('path');
const { run, exists } = require('./util');

async function tailscaleExe() {
  const candidates =
    process.platform === 'win32'
      ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe')]
      : ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  for (const c of candidates) if (await exists(c)) return c;
  return null;
}

/** This PC's current Tailscale name (e.g. marco-work-pc.tail6a10e2.ts.net), or null. */
async function currentName(exe) {
  try {
    const { stdout } = await run(exe, ['status', '--json'], { timeout: 15000 });
    const self = JSON.parse(stdout || '{}').Self;
    return self && self.DNSName ? String(self.DNSName).replace(/\.$/, '').toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Returns https://<machine>.<tailnet>.ts.net if Tailscale Funnel forwards to this port, else null. */
async function detectFunnel(port) {
  const exe = await tailscaleExe();
  if (!exe) return null;
  let cfg;
  try {
    const { stdout } = await run(exe, ['serve', 'status', '--json'], { timeout: 15000 });
    cfg = JSON.parse(stdout || '{}');
  } catch {
    return null;
  }
  // After the PC is renamed, Tailscale keeps the old name's entry too, but only the current name works.
  const current = await currentName(exe);
  const allow = cfg.AllowFunnel || {};
  for (const [hostPort, site] of Object.entries(cfg.Web || {})) {
    if (!allow[hostPort]) continue;
    if (current && hostPort.split(':')[0].toLowerCase() !== current) continue;
    const handlers = Object.values((site && site.Handlers) || {});
    if (handlers.some((h) => h && typeof h.Proxy === 'string' && new RegExp(`:${port}(/|$)`).test(h.Proxy))) {
      const [host, p] = hostPort.split(':');
      return p && p !== '443' ? `https://${host}:${p}` : `https://${host}`;
    }
  }
  return null;
}

module.exports = { detectFunnel, tailscaleExe };
