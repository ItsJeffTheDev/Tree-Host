# Troubleshooting

Find your problem below. If none of this helps, send an admin the last lines of the server's **Console**.

---

## Dashboard

**The link doesn't open / "This site can't be reached"**
The dashboard is at **<https://honey-host.tail6a10e2.ts.net>**. If it doesn't load, the host PC is probably off, asleep or restarting, or Tailscale
on it isn't connected. Admins: check the Tailscale icon on the host PC says *Connected*, and that
`tailscale funnel status` shows the link; if not, run `Setup-Permanent-Link.bat` again.

**Red bar: "Lost connection to the manager"**
Honey Host was closed or the host PC restarted. It reconnects by itself once Honey Host is running again.

**"Too many attempts. Try again in 15 minutes."**
Ten wrong passwords in a row lock sign-in for 15 minutes. Wait, then try again (or ask an admin to check your
username).

**Stuck on "Waiting for approval"**
An admin hasn't approved your request yet. The page continues by itself once they do.

**"Testers can't …"**
Your account has the Tester role, which can play on and start/stop servers but not change them. Ask an admin if you
need Developer access. See [Roles & permissions](roles.md).

**"Only the person who created this team server … or an admin can …"**
Deleting a Team server, resetting its world or changing its version is limited to whoever created it (named in the
message) and admins, so shared worlds don't get wiped by accident. Ask them, or make your own server.

**The Files or Settings tab is missing**
Testers don't have those tabs. See [Roles & permissions](roles.md).

**I can't see a server someone told me about**
It's probably a **Solo** server (private to its owner), or it's in the other space: check the **Team / Solo** switch.

---

## Joining in Minecraft

**"You are not whitelisted on this server"**
1. Check your Minecraft name under **Account** (it must match your in-game name exactly).
2. In the server's Console click **Whitelist team** (or **Whitelist me** on Solo servers).

**Connection timed out / can't connect to the Gateway address**
- The Gateway must be running (it has a green dot in the Team list).
- The playit app must be running on the host PC (admins: the playit window should say **Verified**).
- The playit tunnel must point to the Gateway's port with Proxy Protocol **none** (admins: see the
  [Admin guide](admin-guide.md#3-set-up-the-gateway-one-address-for-all-servers)).

**I join but land on the wrong server**
Type `/server <name>`. The server's page shows the exact command. Admins can change where people land under
**Team → Gateway → Players land on**.

**"Unable to connect to <server>" after /server**
That server is stopped, or still starting. Start it in Honey Host and wait for **Running**.

**"Failed to verify username" / "Invalid session"**
Restart your Minecraft launcher and log in again. The Gateway checks real Minecraft accounts.

**"If you wish to use IP forwarding, please enable it in your BungeeCord config"**
The server was running before the Gateway was set up. **Restart** it once.

**"The connection to the remote server was unexpectedly closed … BungeeCord IP forwarding"**
That server can't understand the Gateway's player forwarding. Vanilla and Fabric servers are kept out of the
Gateway automatically; restart the server once after updating Honey Host and join it with its own address instead.
For Paper/Spigot servers, a **Restart** fixes it (it was running before the Gateway was set up).

**Direct join to a server's own port doesn't work anymore**
Expected: behind the Gateway, servers only accept players through it. Use the Gateway address.

---

## Deploying plugins

**`Set the MCPT_TOKEN environment variable`**
Create a token (**Account → API tokens**), then `setx MCPT_TOKEN "mcpt_…"` (Windows) or add `export MCPT_TOKEN=…`
to your shell profile (macOS/Linux). **Restart your IDE** afterwards: it only reads environment variables when it
starts.

**`Please sign in` (401)**
The token is wrong or was deleted. Create a new one.

**Connection error / unknown host**
The dashboard link changed. Set `MCPT_URL` to the current link and restart your IDE.

**`Server not found` (404)**
The server ID in your task is wrong, or it's someone else's Solo server. Copy the snippet again from that server's
**Plugins** tab.

**Deployed, but the plugin didn't load**
Look at the Console for red errors right after `Enabling YourPlugin`. Common causes: the wrong `api-version` in
`plugin.yml` for this Minecraft version, or a missing dependency plugin.

---

## Servers

**"Port 25565 is already in use"**
Another program or server uses that port. Change the port in **Settings → General**.

**"You need to accept the Minecraft EULA"**
**Settings → EULA**: tick the box, **Save settings**.

**Spigot/CraftBukkit is "Installing" for a long time**
The first build of each version compiles Spigot with BuildTools and takes 5-15 minutes. Later servers of the same
version start instantly.

**Server exits right away with a Java error**
Leave **Settings → Java** on **Automatic**. Honey Host chooses the right Java (8 for old versions, up to 25 for the
newest).

**"Failed to replace level.dat … used by another process"**
Antivirus on the host PC is scanning the world while it saves. The world isn't damaged. Admins: exclude the `data`
folder from Windows Defender (in an admin PowerShell):

```powershell
Add-MpPreference -ExclusionPath "C:\path\to\Honey Host\data"
```

**The server is frozen and Stop does nothing**
Wait a minute (a big world can take a while to save), then click **Kill**.

---

## Permanent link (admins)

**`Setup-Permanent-Link.bat` says Funnel isn't allowed / HTTPS isn't enabled**
Open the link it prints, click **Enable**, and run it again. On the Tailscale website this is under
**Settings → Feature previews / DNS → HTTPS certificates** and **Access controls → Funnel**.

**Honey Host still shows the Cloudflare link**
It checks every 5 minutes; restart Honey Host to switch right away. In a terminal, `tailscale funnel status` should
show your `…ts.net` link pointing to `http://127.0.0.1:8766`.

**The PC still went to sleep**
Honey Host blocks automatic sleep only while it's running. Closing a laptop lid or choosing Sleep manually still
sleeps. Set the lid action to *Do nothing* in Windows power settings.

## playit.gg (admins)

**`needs a tunnel` / `NotAllowedWithReadOnly`**
playit only lets its website create tunnels. With the Gateway you need exactly one: see the
[Admin guide](admin-guide.md#3-set-up-the-gateway-one-address-for-all-servers).

**The playit window says "timed out connecting to local TCP server"**
Nothing is listening on that tunnel's local port on this PC. Either the Gateway isn't running, the tunnel points at
the wrong port, or playit is installed on a different PC than Honey Host.

**The playit window keeps saying `timeout waiting for register response` or `timeout waiting for pong`**
The playit app can't reach playit.gg's servers, so no tunnel works (players time out). In order:

1. Check [status.playit.gg](https://status.playit.gg) for an outage.
2. Restart the agent: close the playit window, or run `net stop playit` then `net start playit` in an admin
   Command Prompt.
3. Make sure the same agent isn't running on two PCs, or in the cloud too. One agent = one PC.
4. Allow playit through the firewall: **Windows Security → Firewall → Allow an app** → tick playit for
   **Private** and **Public**. playit uses **UDP**; some routers, school/work networks and VPNs block it.
5. If Tailscale is set to use an **exit node** on that PC, turn the exit node off.
6. Still stuck? Try another network (e.g. a phone hotspot) to confirm it's the network.

**Honey Host is linked to a different playit agent**
Happens after moving to another PC. **Team → Public game addresses → Use this PC's playit.**

**Start over with playit**
Run `Remove-Playit.bat` (type YES), delete old agents on playit.gg → Agents, then run `Start.bat` and press **Y**
to install playit again.
