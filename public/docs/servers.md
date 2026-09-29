# Servers and plugins

Everything you need to create test servers, get your plugin onto them, and debug it.

> **Note:** most of this guide is for **Developers** and **Admins**. **Testers** can start, stop and join servers and
> watch the console. See [Roles & permissions](roles.md).

---

## Create a server

1. Pick **👥 Team** or **👤 Solo** at the top of the sidebar (see [Getting started](getting-started.md#3-team-and-solo-servers)).
2. Click **+ New team server** / **+ New solo server**.
3. Choose the **server software**:

   | Type | Use it for |
   |---|---|
   | **Paper** | The default for Bukkit/Paper plugins. Pick this if unsure. |
   | **Purpur** | Paper plus extra gameplay options. |
   | **Folia** | Testing that your plugin works with Folia's regionised threading. |
   | **Spigot / CraftBukkit** | Testing on plain Spigot/Bukkit. The first build of a version takes 5-15 minutes. |
   | **Vanilla** | Official Mojang server, no plugins. Joined directly, not through the Gateway. |
   | **Fabric** | Fabric mods (put them in the Mods tab). Joined directly, not through the Gateway. |
   | **Velocity / Waterfall / BungeeCord** | Testing proxy plugins. |
   | **Custom JAR** | Admins only: any server jar on the host PC. |

4. Choose the **Minecraft version**. Tick **Show pre-releases and snapshots** to see test versions.
5. **Build**: leave on **Latest stable** unless you need a specific build.
6. Give it a **name**. It also becomes the Gateway name used with `/server`, e.g. "Lobby Test" becomes `lobby-test`.
7. **Memory**: 2 GB is fine for most plugin tests. Don't take more than you need.
8. **Port**: leave the suggested one.
9. Tick **I agree to the Minecraft EULA** and click **Create server**.

Honey Host downloads the server (and the right Java version) and, if ticked, starts it. The progress bar at the top
shows what it's doing. The first start of a new version takes a minute or two.

---

## Start, stop and the console

Buttons at the top of every server page:

- **▶ Start**: starts the server. It's ready when the status says **Running**.
- **⟳ Restart**: stops and starts it again (needed after most config changes).
- **■ Stop**: saves the world and stops cleanly.
- **Kill**: force-stops a frozen server. You may lose unsaved progress.

The **Console** tab shows the live server log, with warnings in yellow and errors in red. Type commands in the box at
the bottom (no `/` needed) and press Enter; use ↑/↓ for command history.

Quick buttons above the command box:

| Button | Does |
|---|---|
| **Whitelist team / Whitelist me** | whitelists everyone allowed on this server (their Minecraft names from **Account**) |
| **OP team / OP me** | whitelists and gives operator (admin) rights in-game |
| **OP player…** | op any player name |
| **Creative / Survival / Day / Clear weather** | the usual test shortcuts |
| **Plugins / TPS / Version** | quick checks |

---

## Add plugins

### Option 1: drag and drop

1. Open the **Plugins** tab (**Mods** on Fabric).
2. Drag your `.jar` onto the drop area, or click **browse**.
3. **Restart** the server to load it.

The list shows each plugin's name, version and `api-version` from its `plugin.yml`. **Disable** keeps the jar but
stops it loading; **Delete** removes it.

### Option 2: deploy straight from your build (recommended)

Build your plugin in your IDE and it lands on the server automatically: the old version is removed, the new jar is
installed, and the server restarts.

**One-time setup**

1. In Honey Host, click **Account → API tokens**, name the token (e.g. "Laptop") and click **Create token**.
2. **Copy the token now.** It starts with `mcpt_` and is only shown once.
3. Save it as the `MCPT_TOKEN` environment variable on your computer:

   **Windows** (PowerShell), then restart your IDE and terminals:

   ```powershell
   setx MCPT_TOKEN "mcpt_your_token_here"
   ```

   **macOS / Linux**: add this line to `~/.zshrc` or `~/.bashrc`, then open a new terminal:

   ```bash
   export MCPT_TOKEN="mcpt_your_token_here"
   ```

4. Also set `MCPT_URL` to the dashboard link (once; it doesn't change):

   ```powershell
   setx MCPT_URL "https://honey-host.tail6a10e2.ts.net"
   ```

**Gradle**

1. Open the server's **Plugins** tab. The **Deploy from your build** card has a ready-made `deployTest` task with
   this server's ID already filled in.
2. Click **Copy** and paste it at the end of your `build.gradle.kts`.
3. Run it from your IDE's Gradle panel, or:

   ```bash
   ./gradlew deployTest
   ```

   It builds your plugin, uploads the newest jar from `build/libs`, and prints `Deployed …`.

> **Tip:** using the Shadow plugin? The task picks the newest jar in `build/libs`. If it picks the wrong one, change the
> `filter { … }` line to match your `-all.jar`.

**Maven or anything else**

Build first (`mvn package`), then use the **curl** (macOS/Linux/Git Bash) or **PowerShell** command from the same
card. Change the jar path and file name to yours.

**Deploying to a different server:** each server has its own ID in the task/command. Copy the snippet from that
server's Plugins tab.

### Option 3: watch a folder on the host PC (admins)

Admins working on the host PC itself can point **Auto-deploy** at a build folder there; new builds are copied in and
the server restarts automatically.

---

## Edit config files

The **Files** tab shows everything in the server's folder. Click a file to edit it, then **Save** (or Ctrl+S). The
buttons at the top open common files (`server.properties`, `bukkit.yml`, `spigot.yml`, Paper configs…). Most files
only exist after the server has started once, and most changes need a **Restart**.

---

## Settings

The **Settings** tab:

- **General**: name, memory, port.
- **Server software**: switch type, version or build. The new jar is downloaded on the next start; worlds and
  plugins are kept. **Re-download jar now** gets the latest build.
- **Java**: leave on **Automatic**. Honey Host picks and downloads the right Java for the version.
- **Extra JVM arguments**: e.g. for the debugger (below).
- **Game settings**: the common `server.properties` options (gamemode, difficulty, view distance, seed…).
- **Danger zone**: **Reset worlds** gives you a fresh world (plugins and configs are kept); **Delete server**
  removes it for good.

> **Note:** on servers behind the Gateway, `online-mode` shows **false**. That's expected: the Gateway checks accounts
> instead.

---

## Debug your plugin with breakpoints

1. In the server's **Settings → Extra JVM arguments**, add:

   ```
   -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005
   ```

2. **Save** and **Restart** the server.
3. In IntelliJ: **Run → Edit Configurations → + → Remote JVM Debug**, host = the host PC, port `5005`.

> **Note:** remote debugging only works from the host PC's network (not over the internet link), and only one server can use
> port 5005 at a time. Use 5006, 5007… for others. Windows may ask to allow Java through the firewall: allow it on
> **Private networks**. For very old servers that run on Java 8, write `address=5005` instead of `address=*:5005`.

---

## Test with more than one player

Everyone on the team can join the same Team server, so the easiest multiplayer test is to ask a teammate to join.
Each player needs their own Minecraft account, because the Gateway checks real accounts.

Admins sitting at the host PC can also use **🎮 Play on host** to open extra offline test players, but only on
servers that are **not** behind the Gateway (for example a server in a Honey Host without a Gateway).
