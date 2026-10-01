# Tree Host

Minecraft server hosting at **[treehost.online](https://treehost.online)**: customers sign up, pick a monthly plan,
and get their own Minecraft server, on any type and version, in about a minute.

Node.js with no npm dependencies. Each customer server runs in its own locked-down Docker container.

## Guides

The guides are also on the website under **Help**.

| Guide | For |
|---|---|
| [Getting started](public/docs/getting-started.md) | Customers: sign up, pick a plan, create and join a server |
| [Your server](public/docs/servers.md) | Customers: console, plugins, backups, files, settings |
| [Billing](public/docs/billing.md) | Customers: plans, cards, canceling, failed payments |
| [Troubleshooting](public/docs/troubleshooting.md) | Common problems and fixes |
| [Roles & permissions](public/docs/roles.md) | Admins: what customers, support staff and admins can do |
| [Running Tree Host](public/docs/hosting-guide.md) | Admins: rent a server, DNS for treehost.online, install, Stripe, email, go-live checklist |

## Deploy (production)

On a fresh Ubuntu 22.04/24.04 server, with `treehost.online`, `www` and `play` pointing at its IP:

```bash
git clone https://github.com/ItsJeffTheDev/Honey-Host.git /opt/tree-host
sudo bash /opt/tree-host/deploy/install.sh
```

Settings live in `/etc/tree-host.env` (template: [deploy/tree-host.env.example](deploy/tree-host.env.example)).
Updates: `sudo bash /opt/tree-host/deploy/update.sh`. Full steps: [Running Tree Host](public/docs/hosting-guide.md).

## Run locally (development)

```bash
node src/server.js                                   # personal mode: http://localhost:8765, no accounts
TREEHOST_PUBLIC_URL=http://localhost:8766 BILLING_DEMO=1 node src/server.js   # the full hosted site, fake payments
```

On Windows, `Start.bat` installs Node.js if needed and runs the whole site locally with fake payments (its own
`test-site-data` folder). Docker isolation is on by default on Linux;
on Windows/macOS set `TREEHOST_ISOLATION=docker` (with Docker Desktop running) to test it.

## Features

- **Every server type and version:** Paper, Purpur, Folia, Spigot, CraftBukkit, Vanilla, Fabric, Velocity, Waterfall,
  BungeeCord. The right Java version is picked automatically.
- **Accounts:** Firebase Authentication (email/password and Google, verification and reset emails), Customer / Support /
  Admin roles. Accounts, plans, subscriptions and activity are stored in the Firebase Realtime Database.
- **Billing:** monthly plans by memory/CPU/disk through Stripe Checkout and the Stripe customer portal, a 3-day grace period
  for failed payments, automatic suspension and cleanup, free plans for giveaways, capacity limits ("sold out").
- **Isolation:** one Docker container per server with memory, CPU and process limits, a read-only system, no Linux
  capabilities, a private network, and protection against symlink tricks.
- **Dashboard:** live console, plugin manager and Modrinth plugin browser, file editor, game settings, backups (manual and
  scheduled) with restore, auto-restart after crashes, memory and disk usage.
- **Developers:** upload plugins straight from Gradle/Maven with personal API tokens.
- **Admin tools:** admin panel (people, billing, plans, capacity), an "All servers" view for support, activity feed and
  Discord alerts.
- **Website:** landing page with live pricing, Terms of Service and Privacy Policy templates.

## Files

| Path | What it is |
|---|---|
| `src/server.js` | HTTP server, API routes, permissions |
| `src/instances.js` | Starting, stopping and managing Minecraft servers |
| `src/docker.js` | Container isolation |
| `src/billing.js` | Plans, subscriptions, Stripe |
| `src/auth.js` | Accounts, sessions, invites, Firebase sign-in, API tokens |
| `src/firebase.js`, `src/store.js` | Firebase token checks, Realtime Database storage (local files as backup) |
| `public/` | Website, dashboard and docs |
| `deploy/` | Installer, systemd service, Caddy config, settings template |

## Security

- Never commit `data/` or `/etc/tree-host.env`: they hold accounts, worlds and payment keys.
- Keep Docker isolation on for any server open to the public.
- The Terms of Service and Privacy Policy are templates: have them reviewed for your country before launch.
