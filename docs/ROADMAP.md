# Roadmap

## 🚀 Launch (now)

- [ ] Raise the $50 launch fund
- [ ] Rent the first server and run `deploy/install.sh` ([hosting guide](../staff-docs/hosting-guide.md))
- [ ] Point `treehost.online`, `www` and `play` at it; `deploy/doctor.sh` all green
- [ ] Firebase service account key, Stripe live keys + webhook, Resend email
- [ ] Have the Terms and Privacy pages reviewed
- [ ] First paying customer 🎉

## 🌱 Good first tasks

Small, self-contained, and a nice way to learn the codebase.

- **Tests:** add a `node --test` suite for the security-critical helpers, and run it in
  `.github/workflows/check.yml`: `assertNoLinks`/`openInside` (`src/instances.js`), `verifyWebhook`
  (`src/billing.js`) and the permission helpers in `src/server.js`.
- **Website:** an accessibility pass (contrast, focus outlines, alt text) and mobile polish on the dashboard.
- **Help center:** a guide for popular setups (e.g. "Fabric + mods", "Velocity network").
- **Discord bot:** `/stats` command showing member count, open tickets and the launch fund.

## 🧱 Bigger features

- **Split `src/instances.js`** (1,800 lines) into smaller modules: files, plugins, process/container, ports.
- **Live status page:** the server reports its health to the Discord `#status` channel and a public status page.
- **Link Discord ↔ Tree Host accounts:** customers get the Customer role automatically.
- **Bedrock players:** one-click Geyser + Floodgate on Java servers.
- **Server templates:** start from a ready-made setup (SMP with essential plugins, minigames, modpacks).
- **Multi-node:** run customer servers on more than one machine as we grow.

Want one of these? Say so in the Discord (or open an issue) so we can avoid double work.
