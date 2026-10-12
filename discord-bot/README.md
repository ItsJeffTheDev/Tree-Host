# Tree Host Discord bot

Builds the whole Tree Host Discord server and keeps its interactive parts running.

- **`npm run setup`** (run once, safe to re-run): server name and icon, 10 roles, 6 categories, 26 text/voice/forum
  channels, every permission, 8 info embeds with buttons, 6 AutoMod rules, safety settings, Community mode.
- **`npm start`** (keep running): the **Verify** button, self-assigned ping roles, private **support tickets** with
  transcripts, welcome messages, new **YouTube** uploads as embeds, **DISBOARD bump reminders**, a rotating
  custom status, and **slash commands**:

  | Command | Who | What it does |
  |---|---|---|
  | `/help` | everyone | Lists commands |
  | `/announce`, `/say` | admins | Post an announcement embed / any message |
  | `/status` | admins | Online · maintenance · problems · outage · pre-launch in #status (with ping) |
  | `/goal` | admins | Launch fund progress bar ("$15 of $2,000") |
  | `/supporter` | admins | Supporter 💚 role + thank-you |
  | `/youtube-check`, `/youtube-post` | admins | Check for / post a video embed now |
  | `/setup` | admins | Re-run the server setup from Discord |
  | `/customer`, `/ticket add·remove·close`, `/purge`, `/slowmode` | staff | Support and moderation |

The layout lives in [`src/config.js`](src/config.js) and the embed text in [`src/embeds.js`](src/embeds.js).
To change the server, edit those and run `npm run setup` again: it updates what exists and creates what's missing.

## 1. Create the bot (once, about 5 minutes)

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application** → name it
   `Tree Host` → Create.
2. **General Information:** copy the **Application ID**. Upload the Tree Host logo as the app icon if you like.
3. **Bot** (left menu): **Reset Token** → copy the token. Turn **Public Bot** off (only you can add it).
   No privileged intents are needed.
4. In this folder, copy `.env.example` to `.env` and fill in:
   - `DISCORD_TOKEN`: the token. **Never share it or paste it anywhere**; anyone with it controls the bot.
   - `DISCORD_CLIENT_ID`: the Application ID.
   - `DISCORD_GUILD_ID`: in Discord, **Settings → Advanced → Developer Mode** on, then right-click your server
     icon → **Copy Server ID**.

## 2. Build the server

```bash
npm install
npm run check     # validates the layout offline
npm run invite    # prints the link to add the bot: open it, pick your server, approve
npm run setup     # builds everything (about a minute)
```

Use a **new, empty server** you own (Discord → **+** → Create My Own). Setup also works on an existing server: it
reuses channels and roles with the same names and leaves everything else alone.

After setup, in **Server Settings → Roles**, make sure the bot's own role (`Tree Host`) is at the **top**, and give
yourself the **Founder** role.

## 3. Keep the bot running

The buttons only work while `npm start` runs.

- **On your PC:** double-click `Start-Bot.bat`. It restarts the bot if it crashes, keeps the PC awake, and won't start
  a second copy. `Install-Autostart.bat` starts it with Windows (`Remove-Autostart.bat` undoes that).
- **24/7 on the Tree Host server** (recommended once it's rented):
  ```bash
  cd /opt/tree-host/discord-bot && sudo -u treehost npm install --omit=dev
  sudo cp tree-host-discord.service /etc/systemd/system/
  sudo systemctl daemon-reload && sudo systemctl enable --now tree-host-discord
  ```
  Copy `.env` and `state.json` from your PC into `/opt/tree-host/discord-bot/` first (`state.json` remembers which
  channels and messages setup created).

## What's in the server

| Category | Channels | Who |
|---|---|---|
| 📌 INFORMATION | welcome (Verify), rules, announcements, youtube, roles (ping buttons), faq | Everyone reads, staff posts |
| 🌳 TREE HOST | plans, launch-fund, status, suggestions (forum with tags) | Everyone reads; members post suggestions |
| 💬 COMMUNITY | general, minecraft, showcase, off-topic, bot-commands | Verified members |
| 🎫 SUPPORT | get-help (Open a ticket), help-chat; tickets appear here | Verified members |
| 🔊 VOICE | Lounge, Minecraft 1, Minecraft 2, Chill (10 max), AFK | Verified members |
| 🛠️ STAFF | staff-chat, mod-log, ticket-log, Staff voice | Staff only |

**Roles:** Founder, Admin (both administrator), Moderator (kick, ban, timeout, manage messages), Support Team
(manage messages, timeout), Supporter 💚 (donors), Customer, Member (from Verify), and the ping roles
📢 Announcements, 🎬 YouTube, 📊 Status Updates.

**AutoMod** (staff and staff channels exempt; alerts go to #mod-log): slurs and sexual content, spam, mention spam
(5+ mentions → 10 min timeout, raid protection on), Discord invite links, scam links and "free Nitro" phrases
(1 hour timeout), and password/token phishing.

**Safety settings:** members need an account older than 5 minutes, images from everyone are scanned, notifications
default to @mentions only, and Discord's join messages go to #mod-log instead of chat.
