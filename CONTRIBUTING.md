# Contributing to Tree Host

Thanks for helping build Tree Host! This page covers how to run it, how we work, and the few rules that keep the
code easy to live with.

## Run it

```bash
TREEHOST_PUBLIC_URL=http://localhost:8766 BILLING_DEMO=1 node src/server.js
```

Open http://localhost:8766. That's the whole hosted site with **fake payments**: sign up (the first account becomes the
admin), buy a plan for free, create a server. On Windows, `Start.bat` does the same thing.

Starting real Minecraft servers downloads the server jar and Java the first time, so that step takes a few minutes.
To test Docker isolation on Windows/macOS, run Docker Desktop and set `TREEHOST_ISOLATION=docker`.

The Discord bot is a separate package: see [discord-bot/README.md](discord-bot/README.md).

## How we work

1. **Talk first for bigger changes.** Open an issue or ask in the Discord so nobody builds the same thing twice.
2. **Branch from `main`**, one topic per branch (`fix/backup-restore`, `feature/geyser-support`).
3. **Keep pull requests small** and explain *what* changed and *how you tested it*.
4. **Run the checks** before pushing:
   ```bash
   npm run check                      # syntax-checks every JS file
   cd discord-bot && npm run check    # if you touched the bot
   ```
   Then click through what you changed in the demo site above. There's no automated test suite yet
   ([help wanted](docs/ROADMAP.md)).

## Code rules

- **No npm dependencies in the main app.** Everything in `src/` and `public/` uses only Node.js built-ins and plain
  browser JavaScript. It keeps installs instant and the attack surface small. Ask before adding one.
- **CommonJS, `'use strict'`, 2 spaces, single quotes, semicolons, lines up to ~120 characters.**
  [`.editorconfig`](.editorconfig) sets this up in most editors.
- **Comments explain *why*.** Match the style of the file you're in.
- **Security first:** anything touching files, accounts, billing or containers needs extra care. Read the "Safe file
  access" part of `src/instances.js` and the permission helpers in `src/server.js` before changing them.
- **Never commit secrets:** `.env` files, `data/`, Firebase keys, Stripe keys. They're git-ignored; keep it that way.

## Writing for users

Text customers see (website, dashboard, errors, guides) is written in **plain, friendly English**: short sentences,
no jargon, say what to do next. "Can't start: the payment for this server failed. Update your card in Billing." beats
"Error 402: subscription past_due".

## Where things are

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together, and the
[roadmap](docs/ROADMAP.md) for what to work on.
