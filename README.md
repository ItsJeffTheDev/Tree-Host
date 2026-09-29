# Honey Host

Minecraft test servers for **Honey Pixel Studios**. Create a server of any type and version in a few clicks, deploy
your plugin straight from your build, and test it with the team from anywhere.

## Guides

The guides are also in the dashboard under **📖 Help & guides**.

| Guide | For |
|---|---|
| [Getting started](public/docs/getting-started.md) | Everyone: get an account, Team vs Solo, join a server |
| [Servers and plugins](public/docs/servers.md) | Developers: create servers, add plugins, deploy from Gradle/Maven, debug |
| [Admin guide](public/docs/admin-guide.md) | The admin: host PC, playit.gg, the Gateway, inviting and approving people, backups |
| [Troubleshooting](public/docs/troubleshooting.md) | Common problems and fixes |

## Quick start (host PC)

1. Double-click **`Start.bat`**. It installs Node.js if needed, offers to install playit.gg, and starts Honey Host.
   Java for each Minecraft version downloads automatically.
2. Open the dashboard link shown in the window, enter the **setup code**, and create the admin account.
3. **Team → Gateway → Set up the Gateway**, then create **one** playit.gg tunnel for its port.
4. Invite your developers: **Team → Invite a developer**, or let them **Request access** and approve them.

Full steps: [Admin guide](public/docs/admin-guide.md).

## Features

- **Every server type and version:** Paper, Purpur, Folia, Spigot, CraftBukkit, Vanilla, Fabric, Velocity,
  Waterfall, BungeeCord, or any custom jar. The right Java (8 to 25) is picked and downloaded automatically.
- **Team and Solo servers:** shared servers for everyone, plus private servers per person.
- **Accounts:** sign-in required, invite links, access requests with admin approval, Developer and Admin roles.
- **One address for everything:** the Gateway (Velocity) sits in front of all servers. Players join once and use
  `/server <name>`. New servers are added automatically.
- **Deploy from your build:** a Gradle task or curl command with a personal API token replaces the old jar and
  restarts the server.
- **Live console,** plugin manager (drag and drop), config file editor, `server.properties` editor, world reset,
  debugger support.
- **Automatic whitelisting** of everyone's Minecraft name.
- **Reach it from anywhere:** a permanent public dashboard link (Tailscale Funnel, or Cloudflare automatically),
  home-network links, and public game addresses (playit.gg).
- **Stays up:** keeps the host PC awake while running, and starts chosen servers automatically after a restart.

## Files and scripts

| | |
|---|---|
| `Start.bat` | Starts Honey Host (and installs what's missing) |
| `Start-Local.bat` | A no-login copy only this PC can open, e.g. on a developer's own machine (uses `local-data/`) |
| `Setup-Permanent-Link.bat` | One-time setup of a permanent, free dashboard link (Tailscale Funnel) |
| `Remove-Playit.bat` | Removes the playit.gg app from a PC completely |
| `data/` | Everything Honey Host stores: accounts, servers, worlds, settings. Back this up. |

Advanced: `MCPT_PORT` changes the dashboard port and `MCPT_DATA` the data folder.

## Security

Anyone who can deploy a plugin can run code on the host PC. Only approve people you trust, keep private files off
the host PC, and keep servers behind the Gateway (it checks real Minecraft accounts) with whitelists on.
