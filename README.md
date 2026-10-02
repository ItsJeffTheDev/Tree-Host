# 🌳 Tree Host

Minecraft server hosting, built from scratch. Customers sign up at **[treehost.online](https://treehost.online)**,
pick a monthly plan, and get their own Minecraft server on any type and version in about a minute.

**Status: pre-launch.** The website, dashboard, billing and server isolation are built and work end to end; we're
getting our first production server. Follow along on [YouTube](https://www.youtube.com/@TreeHost) and
[Discord](https://discord.gg/a37pbwajKd).

## 🤝 Join the team

Tree Host is a small project looking for people who want to build a hosting company with us. Useful skills:

| Role | What you'd work on |
|---|---|
| **Backend (Node.js)** | API, server management, billing, Docker isolation ([`src/`](src)) |
| **Frontend (HTML/CSS/JS)** | Website and dashboard, no framework ([`public/`](public)) |
| **Linux / DevOps** | Install scripts, monitoring, backups, security ([`deploy/`](deploy)) |
| **Discord bot (discord.js)** | Tickets, verification, notifications ([`discord-bot/`](discord-bot)) |
| **Content** | YouTube videos, Shorts, thumbnails, devlogs |
| **Community & support** | Moderating the Discord, helping customers |

**How to join:** hop into the [Discord](https://discord.gg/a37pbwajKd), open a ticket in **#get-help** and tell us what
you'd like to do. Team members get invited to this (private) GitHub repo. Developers: read [CONTRIBUTING.md](CONTRIBUTING.md) and look at the
[roadmap](docs/ROADMAP.md) for good first tasks.

## Quick start (development)

You need [Node.js](https://nodejs.org) 20+. The main app has **no npm dependencies**: nothing to install.

```bash
git clone <this repo> tree-host && cd tree-host
TREEHOST_PUBLIC_URL=http://localhost:8766 BILLING_DEMO=1 node src/server.js
```

Open http://localhost:8766: that's the full hosted site with fake payments. The first account you create becomes the
admin. On Windows, just double-click **`Start.bat`** (installs Node.js if needed, keeps its data in `test-site-data/`,
signs in with Firebase, and works with or without Docker Desktop). For Stripe test payments, copy
[`test-site.env.example`](test-site.env.example) to `test-site.env` (never committed) and add your **test** keys.

- `node src/server.js` without settings runs **personal mode** (http://localhost:8765, no accounts).
- Real Minecraft servers need Java (downloaded automatically) and, for isolation, Docker
  (`TREEHOST_ISOLATION=docker` on Windows/macOS with Docker Desktop running; on Linux it's on by default).
- `npm run check` syntax-checks every JavaScript file.

How the code fits together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What's in this repo

| Path | What it is |
|---|---|
| [`src/`](src) | The Tree Host server: HTTP API, accounts, billing, Minecraft server management |
| [`public/`](public) | Website, customer dashboard, and the Help guides ([`public/docs/`](public/docs)) |
| [`deploy/`](deploy) | Production installer, updater, health check, nightly backups, systemd units, Caddy config |
| [`discord-bot/`](discord-bot) | Bot that builds and runs the Tree Host Discord (its own README) |
| [`docs/`](docs) | Developer docs: architecture and roadmap |
| [`tools/`](tools) | Helper scripts (Node.js installer for Windows) |

## Features

- **Every server type and version:** Paper, Purpur, Folia, Spigot, CraftBukkit, Vanilla, Fabric, Velocity, Waterfall,
  BungeeCord. The right Java version is picked automatically.
- **Accounts:** Firebase Authentication (email/password and Google, verification and reset emails), Customer / Support /
  Admin roles. Accounts, plans, subscriptions and activity are stored in the Firebase Realtime Database.
- **Billing:** monthly plans by memory/CPU/disk through Stripe Checkout and the Stripe customer portal, a 3-day grace
  period for failed payments, automatic suspension and cleanup, free plans for giveaways, capacity limits ("sold out").
- **Isolation:** one Docker container per server with memory, CPU and process limits, a read-only system, no Linux
  capabilities, a private network, and protection against symlink tricks.
- **Dashboard:** live console, plugin manager and Modrinth plugin browser, file editor, game settings, backups (manual
  and scheduled) with restore, auto-restart after crashes, memory and disk usage.
- **Developers:** upload plugins straight from Gradle/Maven with personal API tokens.
- **Staff Console (`/admin`) with role-based access:** Owner, Admin, Developer and Support roles made of permissions
  (editable by the Owner, stored in Firebase), an overview, every server, people, billing, plans, promo codes, an audit
  log of staff actions, and system info. See [Roles & permissions](public/docs/roles.md).

## Deploy (production)

On a fresh Ubuntu 22.04/24.04 server, with `treehost.online`, `www` and `play` pointing at its IP:

```bash
git clone <this repo> /opt/tree-host
sudo bash /opt/tree-host/deploy/install.sh
```

Settings live in `/etc/tree-host.env` (template: [deploy/tree-host.env.example](deploy/tree-host.env.example)).
Full steps: [Running Tree Host](public/docs/hosting-guide.md).

| Command (on the server) | What it does |
|---|---|
| `sudo bash /opt/tree-host/deploy/doctor.sh` | Health check: services, settings, DNS, HTTPS, firewall, disk, backups |
| `sudo bash /opt/tree-host/deploy/update.sh` | Pull the newest code and restart (servers stop cleanly) |
| `sudo bash /opt/tree-host/deploy/deploy-key.sh` | One time: lets the server pull from the private GitHub repo |
| `sudo systemctl start tree-host-backup` | Back up now (also runs every night) |
| `journalctl -u tree-host -f` | Live log |

## Guides

Also on the website under **Help**.

| Guide | For |
|---|---|
| [Getting started](public/docs/getting-started.md) | Customers: sign up, pick a plan, create and join a server |
| [Your server](public/docs/servers.md) | Customers: console, plugins, backups, files, settings |
| [Billing](public/docs/billing.md) | Customers: plans, cards, canceling, failed payments |
| [Troubleshooting](public/docs/troubleshooting.md) | Common problems and fixes |
| [Roles & permissions](public/docs/roles.md) | Admins: what customers, support staff and admins can do |
| [Running Tree Host](public/docs/hosting-guide.md) | Admins: rent a server, DNS, install, Stripe, email, go-live checklist |

## License

This is a **private repository**. The Tree Host code is proprietary (all rights reserved): please don't share or
reuse it outside the team.

## Security

- Never commit `data/`, `.env` files, `/etc/tree-host.env` or Firebase service account keys: they hold accounts,
  worlds and payment keys. They're all in `.gitignore`.
- Keep Docker isolation on for any server open to the public.
- Found a security problem? Please **don't** open a public issue: open a private ticket in the Discord instead.
- The Terms of Service and Privacy Policy are templates: have them reviewed for your country before launch.
