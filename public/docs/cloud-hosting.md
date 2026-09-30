# Hosting on Render

Honey Host can run on [Render](https://render.com) as a **Web Service** instead of a spare PC. Render gives you a
permanent HTTPS link (like `https://honey-host.onrender.com`), so you don't need Tailscale or Cloudflare.

> **Important:** read **What's different in the cloud** before you pay for anything. Minecraft servers need a lot of
> memory, and Render only opens the dashboard's web port to the internet.

---

## What's different in the cloud

| | Spare PC | Render |
|---|---|---|
| Dashboard link | Tailscale Funnel / Cloudflare | Render's own `onrender.com` link (or your domain) |
| Players join through | playit.gg app on the PC | the playit.gg agent **built into Honey Host** (`PLAYIT_SECRET`) |
| Memory | whatever the PC has | the plan you pay for (see below) |
| Keeping worlds and accounts | the `data/` folder | a Render **Disk** (paid plans only) |
| 🎮 Play on host, 📁 Open folder, auto-deploy from a folder | ✓ | not available (no desktop). Use the deploy API from your build instead |

**Memory is the big one.** Each Paper server wants 1–2 GB, and the Gateway about 512 MB.

| Render plan | RAM | What fits |
|---|---|---|
| Free | 512 MB | The dashboard only. It also **sleeps after 15 minutes** and has **no disk**, so accounts and worlds are wiped on every restart. Not usable. |
| Starter ($7/mo) | 512 MB | The dashboard only. Minecraft servers will run out of memory. |
| Standard ($25/mo) | 2 GB | The Gateway + one small Paper server (1 GB). |
| Pro ($85/mo) | 4 GB | The Gateway + two or three small servers. |

Set each server's memory in **Settings** so they add up to less than the plan's RAM (leave ~300 MB for Honey Host).

> **Tip:** if that's more than you want to spend, keep running servers on the spare PC. It's free and has far more
> memory. Render works best when you need the dashboard to stay up while the PC is off.

---

## 1. Create the service

**The easy way (Blueprint):** the repo includes `render.yaml`, which sets everything below for you.
Render → **New → Blueprint** → pick **ItsJeffTheDev/Honey-Host** → **Apply**. Then go to step 2.

**Or by hand:** Render → **New → Web Service** → pick the repo, then:

| Field | Value |
|---|---|
| Language | **Node** |
| Branch | `main` |
| Root Directory | *(leave empty)* |
| Build Command | `npm install` *(Honey Host has no dependencies, so this is instant; `yarn install` works too)* |
| Start Command | `node src/server.js` |
| Instance type | **Standard** or bigger (see the table above) |

Under **Advanced**:

1. **Add Disk:** name `honey-host-data`, mount path **`/var/data`**, size **10 GB** (more if you keep lots of worlds
   and backups).
2. **Health Check Path:** `/api/health`
3. **Environment Variables:**

| Key | Value |
|---|---|
| `MCPT_DATA` | `/var/data/honey-host` |
| `PLAYIT_SECRET` | the playit secret key from step 3 (you can add it later) |

You don't need to set `PORT`, `MCPT_TEAM` or a public URL: Honey Host notices it's on Render (Render sets
`RENDER=true`) and turns on team mode, uses Render's port, and uses the `onrender.com` link automatically.

Click **Create Web Service** and wait for **Live**.

---

## 2. Create the first admin

1. Open the service's **Logs** tab in Render. Near the top is a box:

   ```
   FIRST-TIME SETUP
   Open the dashboard and enter this setup code: 12345678
   ```

2. Open your `https://….onrender.com` link, enter the code and create your admin account.

> **Note:** moving from the spare PC? Instead of starting fresh you can copy the PC's `data` folder onto the disk
> (Render → **Shell** tab, paid plans), but the easiest way is a fresh start: re-invite people with invite links.

---

## 3. Let players join (playit.gg)

Render only lets web traffic in, so Minecraft goes through playit.gg. Honey Host downloads and runs the playit agent
itself when `PLAYIT_SECRET` is set.

1. On [playit.gg](https://playit.gg) → **Agents → Add agent** → choose **Linux / Docker** and copy the
   **secret key** it shows. Make a **new** agent for Render. Don't reuse the spare PC's key: one agent can only
   run in one place.
2. In Render → **Environment**, set `PLAYIT_SECRET` to that key and save. The service restarts; in **Logs** you'll
   see lines starting with `[playit]`.
3. In Honey Host create the **Gateway** (Team → Gateway), then on playit.gg add a **Minecraft Java** tunnel for the
   new agent pointing at **local port 25577**. Paste its address into **Team → Gateway**.

Players then join the Gateway address and switch with `/server <name>`, the same as on the spare PC.

---

## Updating

Push to `main` on GitHub and Render redeploys automatically. Running Minecraft servers are stopped cleanly during
the deploy and servers with **Start automatically** come back by themselves. Everything on the disk is kept.

---

## Troubleshooting

**Accounts and servers disappeared after a deploy**
There's no disk, or `MCPT_DATA` doesn't point inside it. Check **Disks** (mount path `/var/data`) and that
`MCPT_DATA` is `/var/data/honey-host`.

**A server stops with no error, or the whole service restarts**
Out of memory. Render shows *"Ran out of memory"* in **Events**. Lower the servers' memory, run fewer at once,
or pick a bigger plan.

**`[playit]` lines say `timeout waiting for register response`**
The key is wrong, or the same agent also runs somewhere else (for example the spare PC). Make a separate agent for
Render and use its key.

**Players time out joining**
Check that the playit tunnel points at the **Render** agent and local port **25577**, and that the Gateway is
running.
