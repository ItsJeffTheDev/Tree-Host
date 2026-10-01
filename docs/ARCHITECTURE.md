# Architecture

Tree Host is one Node.js process (no npm dependencies) that serves the website and dashboard, exposes a JSON API, and
starts each customer's Minecraft server as a child process: in production, inside its own Docker container.

```
 Browser ──HTTPS──► Caddy (TLS) ──► src/server.js ─┬─► src/auth.js ── src/firebase.js ─┐
                                    (router, API,  ├─► src/billing.js ── Stripe API     ├─► src/store.js
                                     permissions,  ├─► src/activity.js ── Discord        │   (Firebase RTDB +
                                     live events)  └─► src/instances.js (Manager)        │    local JSON copy)
                                                         │                                │
 Players ──TCP 25600+──────────────────────────────►  Minecraft servers  ◄── src/docker.js (one container each)
                                                       (jar from providers.js, Java from java.js)
```

## Three modes, one codebase

| Mode | How it starts | What it is |
|---|---|---|
| **Personal** | `node src/server.js` | One person's PC: no accounts, localhost only, port 8765 |
| **Team** | `TREEHOST_TEAM=1` | A private team on a LAN: accounts and roles, no billing |
| **Hosted** | `TREEHOST_PUBLIC_URL=https://…` | The public business: website, sign-up, billing, isolation |

Most "if hosted / if team" checks are at the top of `src/server.js` (`HOSTED`, `TEAM`).

## Backend (`src/`)

| File | Job |
|---|---|
| `server.js` | HTTP server, a tiny router (`route(method, pattern, handler, opts)`), auth on every request, the permission helpers (`canView`, `permissionError`, `getFor`), static files, and server-sent events (`/api/events`: `snapshot`, `status`, `log`, `activity`). Also wires billing to servers (suspend/unsuspend/delete hooks). |
| `instances.js` | `Manager` holds every Minecraft server (`Instance`): create/update/remove, start/stop/kill, console, logs, properties, files, plugins, crash restarts, disk/memory usage, ports. Its top section is the **safe file access** layer (no following symlinks out of a server folder). |
| `providers.js` | Where each server type's jar comes from (PaperMC API, Mojang, Fabric meta, BuildTools for Spigot/CraftBukkit…) and which versions/builds exist. |
| `java.js` | Picks and downloads the right Java for a Minecraft version. |
| `docker.js` | `docker run` arguments for an isolated server: memory/CPU/process limits, read-only system, dropped capabilities, private network. |
| `auth.js` | Users, roles (customer/support/admin), sessions, invites, password resets, API tokens, Firebase sign-in. |
| `firebase.js` | Firebase without the SDK: verifies ID tokens, talks to the Realtime Database and Auth admin API. |
| `store.js` | Saves collections (users, plans, subscriptions, activity) to Firebase with a local JSON copy, or local files only. |
| `billing.js` | Plans, subscriptions, Stripe Checkout/portal/webhooks, grace periods, suspension, capacity. |
| `activity.js` | The activity feed and Discord webhook alerts. |
| `backups.js`, `modrinth.js` | Folder backups with restore; plugin/mod search and install from Modrinth. |
| `client.js`, `keepawake.js`, `migrate.js` | Personal-mode extras: launch a local Minecraft client, keep Windows awake, migrate old data. |
| `paths.js`, `util.js`, `mail.js` | Data paths, download/extract/process helpers, emails via Resend. |

**Data folder** (`data/`, or `TREEHOST_DATA`): `servers/<id>/` (each server's files), `backups/`, `cache/` (jars),
`java/`, `instances.json` (server configs) and one JSON file per stored collection.

## Frontend (`public/`)

Plain HTML/CSS/JS, no build step.

| File | Job |
|---|---|
| `index.html`, `features.html`, `pricing.html`, … + `site.js`, `site.css` | The public website |
| `dashboard.html` + `app.js` | Dashboard core: server list, console, settings, files, plugins |
| `team.js` | Sign-in screens, account, billing and the admin panel (loaded before `app.js`) |
| `extras.js` | Activity feed, backups UI, Modrinth browser, Discord notification settings |
| `help.js` + `docs/*.md` | The Help center, rendered from Markdown |

## Deploy (`deploy/`)

`install.sh` sets up Ubuntu (Docker, Node, Caddy, firewall, systemd units, nightly backups) and ends with
`doctor.sh`, the health check. `update.sh` pulls and restarts. Details: [hosting guide](../public/docs/hosting-guide.md).

## Discord bot (`discord-bot/`)

Separate package (uses discord.js). `npm run setup` builds the Discord server from `src/config.js`; `npm start` runs
verification, ping roles, tickets, YouTube posts, bump reminders and slash commands. See its README.
