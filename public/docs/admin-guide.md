# Admin guide

For the person who runs Honey Host: setting up the host PC, making the servers reachable from anywhere, and managing
the team.

---

## How it fits together

```
 Developers anywhere                        Host PC (the spare PC)
 ───────────────────                        ──────────────────────────────────────────────
 Browser ──── dashboard link ─────────────▶ Honey Host (Start.bat)
                                              ├─ Gateway (Velocity)  ◀── one playit tunnel
 Minecraft ── Gateway address ── playit ───▶  │    /server lobby-test ──▶ Paper "Lobby Test"
                                              │    /server minigames  ──▶ Paper "Minigames"
                                              └─ every other test server
```

- **Honey Host** runs on one PC (the **host PC**) and serves the dashboard.
- **Tailscale Funnel** (recommended) gives the dashboard a free, **permanent** `https://…ts.net` link. Without it,
  **Cloudflare** gives a free `https://…trycloudflare.com` link automatically, but it changes on every restart.
- **playit.gg** gives Minecraft players a public address, so nobody needs port forwarding and your home IP stays
  hidden.
- The **Gateway** is one Velocity proxy in front of all servers, so you only ever need **one** playit tunnel.

---

## 1. Set up the host PC

Use a PC that can stay on while people are testing. 16 GB+ of RAM is recommended; each running server needs 1-2 GB.

1. Copy the Honey Host folder onto the host PC.
2. Double-click **`Start.bat`**. The first time it:
   - installs **Node.js** if it's missing (Windows asks for permission);
   - asks **"Install playit.gg now"**: press **Y** (see section 2).
3. When Windows Firewall asks about **Node.js**, tick **Private networks** and click **Allow**. Otherwise other PCs
   at home can't open the dashboard.
4. The window now shows:
   - a **setup code** in a box (first start only)
   - **Dashboard from other PCs on your network**, e.g. `http://SPAREPC:8766`
   - **Your team can open the dashboard at** `https://….trycloudflare.com`

   Keep this window open. Closing it stops every server.
5. Open the dashboard, enter the **setup code**, and create your admin account (use your real Minecraft name).

---

## 1b. Keep it running

A PC that is **asleep or off** can't run servers; nothing can change that. These make sure it stays up and comes
back by itself:

1. **No sleep while Honey Host runs:** Honey Host does this automatically (the screen can still turn off). It
   doesn't stop *manual* sleep, closing a laptop lid, or shutting down.
2. **Start Honey Host with Windows:** press `Win + R`, type `shell:startup`, press Enter. Right-click in that folder
   → **New → Shortcut** → browse to `Start.bat` → Finish.
3. **Sign in automatically after a restart** (optional, so Windows Update restarts don't leave it waiting at the
   login screen): press `Win + R`, run `netplwiz`, untick *Users must enter a user name and password*. Only do this if
   the PC is somewhere private.
4. **Start servers automatically:** on each server, **Settings → Start automatically when Honey Host starts**. The
   Gateway always starts by itself.
5. **After a power cut:** many PCs can turn themselves back on. In the BIOS/UEFI setup look for *Restore on AC
   Power Loss* (or *After Power Failure*) and set it to **Power On**.

---

## 1c. Permanent dashboard link (free)

The Cloudflare link changes every time Honey Host restarts, which means re-sharing it and updating `MCPT_URL` for
deploys. **Tailscale Funnel** gives you a fixed `https://<pc-name>.<your-name>.ts.net` link instead. It's free (no
card, no domain) and needs setting up once:

1. On the host PC, double-click **`Setup-Permanent-Link.bat`**.
2. It installs **Tailscale** if needed (Windows asks for permission).
3. A sign-in link appears: open it and sign in (a free Tailscale account; Google, Microsoft or GitHub works).
4. The first time, it shows a link to **enable HTTPS / Funnel** for your account: open it and click **Enable**. The
   window continues by itself and prints your permanent link.
5. Within 5 minutes Honey Host switches to it (or restart Honey Host). The window shows
   *Your team can open the dashboard at (permanent link)*, and the sidebar shows it under **Internet:**.

Share this link once; it keeps working after restarts and reboots. Tailscale starts with Windows on its own.

Honey Pixel Studios' permanent link is **<https://honey-host.tail6a10e2.ts.net>**.

> **Tip:** nothing else on the PC is exposed: Funnel only forwards this one link to Honey Host, which still requires
> signing in. To turn it off: `tailscale funnel reset` in a terminal.

---

## 2. playit.gg (public game addresses)

**Install** (if you skipped it in `Start.bat`): run `Start.bat` again and press **Y**, or install it from
<https://playit.gg/download>.

**Link it:** a window opens with a `https://playit.gg/claim/…` link. Open it, sign in or create a free playit
account, and **approve**. The playit window then shows **Verified**.

**Connect Honey Host:** in the dashboard click **Team** (bottom left) → **Public game addresses → Connect**. It
should say **Connected**.

> **Important:** playit has to run on the **host PC**, next to the servers. If it runs anywhere else, players time out.
> `Remove-Playit.bat` removes playit completely from a PC (for example your old one).

---

## 3. Set up the Gateway (one address for all servers)

1. **Team → Gateway → Set up the Gateway.** Honey Host downloads Velocity, starts it, and shows its port (usually
   **25577**).
2. Create **one** tunnel on playit.gg → **Tunnels → Add Tunnel**:
   - Tunnel type: **Minecraft Java**
   - Agent: the one on your host PC
   - Local IP: **127.0.0.1**
   - Local Port: the Gateway's port (e.g. **25577**)
   - Proxy Protocol: **none**
3. Back in Honey Host: **Team → Public game addresses → Check again**. The Gateway now shows its public address
   (e.g. `something.tun.ply.gg`). Every server page shows it as **Join through the Gateway**.
4. **Restart any servers that were already running**, once, so they move behind the Gateway. The Team panel lists
   which ones still need it.
5. Optional: **Players land on** picks the server people arrive on when they join.

> **Note:** only Bukkit-type servers (Paper, Purpur, Folia, Spigot, CraftBukkit) can go behind the Gateway. **Vanilla**
> and **Fabric** servers stay standalone: players join them with their own address (Tailscale, home network, or
> their own playit tunnel). The Gateway itself only needs **512 MB** of memory.

From now on, every new server is added to the Gateway automatically (no new tunnel, no restart of the Gateway). Players
switch with `/server <name>`; each server's page shows its name.

> **Tip:** the Gateway checks every player's real Minecraft account, and the servers behind it only accept
> connections from the Gateway. Each server's whitelist still decides who can play on it.

---

## 4. Add people to the team

**Option A: invite links (best for specific people)**

1. **Team → Invite a developer.** Choose **Developer**, **Tester** or **Admin** → **Create invite link**.
2. Send the link privately (DM, not a public channel). It works **once** and expires after **7 days**.

**Option B: access requests**

1. Share the dashboard link. New people click **Request access** on the sign-in page.
2. The **Team** button shows a red number when requests are waiting.
3. **Team → Access requests**: pick **Developer**, **Tester** or **Admin** → **Approve**, or **Reject**.
4. Untick **Let people request access from the sign-in page** to turn requests off (invites still work).

**Roles:** **Tester** (plays and starts/stops servers), **Developer** (builds and tests plugins) or **Admin**
(everything). Change a role any time with the dropdown under **Team → Members**. The full table is in
[Roles & permissions](roles.md).

**Remove someone:** **Team → Members → Remove.** Their logins and API tokens stop working immediately.

> **Note:** everyone on one Honey Host shares the same team. For a completely separate group, run a second copy of
> Honey Host in another folder, or on another PC.

---

## 5. Share with developers

Send new developers:

1. The dashboard link, **<https://honey-host.tail6a10e2.ts.net>** (or their invite link)
2. The [Getting started](getting-started.md) guide. It's also under **📖 Help** in the dashboard.

---

## 6. Day-to-day

- **The dashboard link:** with Tailscale Funnel (section 1c) it never changes. Without it, the Cloudflare link changes
  whenever Honey Host restarts; the new one is shown in the Honey Host window and in the sidebar (**Internet:**).
  Game addresses from playit don't change either way.
- **Memory:** check the host PC isn't running out. Stop servers nobody uses; admins can see and stop anyone's.
- **Updating Honey Host:** close the window, replace the `src`, `public` and `tools` folders and the `.bat` files
  with the new version, and start `Start.bat` again. Everything in `data/` is kept.

---

## 7. Backups and moving to another PC

Everything lives in the **`data/`** folder: accounts, servers, worlds, plugins, settings.

- **Back up:** stop the servers (or close Honey Host), then copy `data/` somewhere safe.
- **Move to a new PC:** copy the whole Honey Host folder **including `data/`**, run `Start.bat` there, then in the
  dashboard: **Team → Public game addresses → Disconnect → Connect** so it uses the new PC's playit. Recreate the
  Gateway tunnel for the new PC's agent on playit.gg, and run `Remove-Playit.bat` on the old PC.

---

## 8. Security checklist

- Anyone who can deploy a plugin can run code on the host PC. Only approve people you trust.
- Keep personal files and passwords off the host PC.
- Keep servers behind the Gateway (it checks real accounts) with whitelists on.
- Turn off access requests when you're not expecting anyone.
- Remove people who leave the team straight away.
