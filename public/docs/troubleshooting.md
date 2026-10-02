# Troubleshooting

Common problems and how to fix them. Still stuck? Email [support@treehost.online](mailto:support@treehost.online) with your server's name and what you see in the console.

---

## Joining in Minecraft

**"Can't connect to server" / "Connection timed out"**
- Is the server **Running**? Start it and wait until the status says Running.
- Copy the address again from the top of the server page, including the **port** (the number after `:`).
- Make sure you're on **Minecraft Java Edition** and the same version as the server (or use a server version your game supports).

**"You are not white-listed on this server"**
Set your Minecraft name in **Account**, then click **Whitelist me** on the Console tab. Or turn the whitelist off in
**Settings → Game settings**.

**"Failed to verify username" / "Invalid session"**
The server checks real Minecraft accounts. Restart your Minecraft launcher and sign in again.

**"Outdated client" / "Outdated server"**
Your game and the server are on different versions. Change the server version in **Settings → Server software**, or
pick the matching version in the Minecraft launcher's **Installations**.

---

## Your server

**It stops with "ran out of memory"**
The server needed more memory than your plan has. Remove heavy plugins or mods, lower **view distance** in Settings, or
move to a bigger plan.

**It crashes when it starts**
Read the red lines in the console: they usually name the plugin or mod at fault. Disable that plugin on the **Plugins**
tab, or check it supports your server's version. Turn on **Settings → Restart after a crash** to recover from occasional crashes.

**"Can't start: the payment for this server failed"**
Open **💳 Billing → Payment method & invoices** and update your card. The server can start as soon as the payment goes through.

**"Can't start: the server uses more disk than its plan"**
Delete old worlds, logs (`logs/` folder) or files in the **Files** tab, or remove old backups.

**The world loads slowly / the server lags**
Lower **view distance** and **simulation distance** in Settings. Pre-generate the world with the Chunky plugin
(Plugins → Browse). Check the **TPS** button in the console: 20 is perfect.

**A plugin doesn't load**
Check the console for its error. Most plugins need **Paper** or **Purpur** (not Vanilla or Fabric), and the right
Minecraft version. Plugins from **🔎 Browse plugins** are already filtered for your server.

---

## Account and billing

**I forgot my password**
Click **Forgot your password?** on the sign-in page and follow the email. No email? Check spam, then email [support@treehost.online](mailto:support@treehost.online).

**I paid but my plan isn't active**
It usually takes a few seconds. Refresh the page. If it still says nothing after a few minutes, contact support with
the email on your receipt.

**How do I cancel?**
**💳 Billing → Payment method & invoices → Cancel**. See [Billing](billing.md).

---

## For admins

**The website doesn't load / no padlock**
Check the DNS records point at the server (`ping treehost.online`), then `sudo systemctl status caddy tree-host` and
`journalctl -u caddy -n 50`. Caddy can only get a certificate when the domain already points at the server and ports
80 and 443 are open.

**Players can't reach any server**
Check the `play` DNS record (and that it's **DNS only** if you use Cloudflare), and that the port range from
`TREEHOST_PORTS` is open in the firewall (`sudo ufw status`) and in your provider's firewall, if it has one.

**Payments don't activate plans**
Stripe → Developers → Webhooks → your endpoint → look for failed deliveries. Usually `STRIPE_WEBHOOK_SECRET` is wrong
or missing. Fix it in `/etc/tree-host.env`, restart, and click **Resend** on the failed events.

**"Docker was not found: customer servers will not start"**
Docker isn't running: `sudo systemctl start docker`, then `sudo systemctl restart tree-host`.

**Plans show "Sold out"**
All memory is sold. Raise **capacity** (Staff Console → Plans) only if the machine really has the memory, or rent a bigger server.
