# Your server

Everything you can do with your server from the dashboard: the console, plugins and mods, backups, files and settings.

---

## Start, stop and the console

Buttons at the top of your server's page:

- **▶ Start**: starts the server. It's ready when the status says **Running**.
- **⟳ Restart**: stops and starts it again (needed after most config and plugin changes).
- **■ Stop**: saves the world and stops cleanly.
- **Kill**: force-stops a frozen server. You may lose unsaved progress.

The **Console** tab shows the live server log, with warnings in yellow and errors in red. Type commands in the box at
the bottom (no `/` needed) and press Enter; use ↑/↓ for command history.

Quick buttons above the command box:

| Button | Does |
|---|---|
| **Whitelist me** | whitelists your Minecraft name (set it in **Account**) |
| **OP me** | whitelists you and gives you operator rights in-game |
| **OP player…** | op any player name |
| **Creative / Survival / Day / Clear weather** | the usual shortcuts |
| **Players / Plugins / TPS / Version** | quick checks |

The header also shows how much **memory** the server is using right now next to its plan limit, and how much **disk** it uses.

---

## Add plugins

### Browse and install (easiest)

1. Open the **Plugins** tab (**Mods** on Fabric) and click **🔎 Browse plugins**.
2. Search for a plugin. Tree Host searches [Modrinth](https://modrinth.com) and **only shows plugins that work on your
   server's type and version**.
3. Click **Install**, then **Restart** your server to load it.

### Upload your own

1. Open the **Plugins** tab.
2. Drag your `.jar` onto the drop area, or click **browse**.
3. **Restart** the server.

The list shows each plugin's name and version. **Disable** keeps the jar but stops it loading; **Delete** removes it.

### Upload straight from your build (plugin developers)

Build your plugin in your IDE and it lands on your server automatically: the old version is replaced and the server restarts.

1. Click **Account → API tokens**, name the token (e.g. "Laptop") and click **Create token**.
2. **Copy the token now.** It starts with `th_` and is only shown once.
3. Save it as the `TREEHOST_TOKEN` environment variable on your computer:

   **Windows** (PowerShell), then restart your IDE:

   ```powershell
   setx TREEHOST_TOKEN "th_your_token_here"
   ```

   **macOS / Linux**: add this to `~/.zshrc` or `~/.bashrc`:

   ```bash
   export TREEHOST_TOKEN="th_your_token_here"
   ```

4. On the server's **Plugins** tab, open **Developers: upload your plugin straight from your build**. Copy the Gradle task
   into your `build.gradle.kts` and run `./gradlew deployServer`, or use the curl / PowerShell command after `mvn package`.

> **Warning:** a token can change your servers. Keep it out of your code and Git. Delete it in Account if it leaks.

---

## Backups

The **Backups** tab keeps copies of your worlds (overworld, nether, end) and your `plugins/` folder, including plugin
configs and data.

- **Back up now:** give it a name like *before the 1.21 update* and click the button. It works while the server is
  running: the world is saved first.
- **Automatic backups:** pick *every 6 hours*, *every 12 hours* or *once a day*. The newest 3 automatic backups are kept.
  You can keep up to 5 backups you made yourself.
- **Restore:** stop the server, then click **Restore** on a backup. Your current world and `plugins/` folder are
  replaced by the backup's copies.

> **Warning:** restoring throws away anything changed since that backup. Make a fresh backup first if you might want the
> current state back.

> **Tip:** backups are a safety net, not a vault. Download anything you can't lose from the **Files** tab now and then.

---

## Edit files

The **Files** tab shows everything in your server's folder. Click a file to edit it, then **Save** (or Ctrl+S). The
buttons at the top open common files (`server.properties`, `bukkit.yml`, `spigot.yml`, Paper configs…). Most files
only exist after the server has started once, and most changes need a **Restart**.

---

## Settings

The **Settings** tab:

- **General**: the server's name, and:
  - **Start automatically** when Tree Host restarts (after maintenance).
  - **Restart after a crash**: waits 5 seconds and starts it again. It gives up after 3 crashes in 10 minutes so a
    broken plugin can't crash-loop forever.
  - **Notes**: a note to yourself shown at the top of the server.
- **Server software**: switch type, version or build. The new jar is downloaded on the next start; your world and
  plugins are kept.
- **Java**: leave on **Automatic**. Tree Host picks the right Java for the version.
- **Game settings**: the common `server.properties` options (game mode, difficulty, whitelist, view distance, seed…).
- **Danger zone**: **Reset worlds** gives you a fresh world (plugins and configs are kept); **Delete server** removes
  the server for good. The plan stays, so you can create a new server with it.

Memory, CPU, disk and the port come from your plan and can't be changed in Settings.

> **Warning:** updating to a newer Minecraft version is usually safe (make a backup first). Going back to an **older**
> version can break your world.

---

## Limits of your plan

- **Memory:** the server can use up to the plan's memory. If it needs more, it stops with *"ran out of memory"* in the
  console. Remove heavy plugins or mods, lower the view distance, or buy a bigger plan.
- **CPU:** the server shares the machine fairly; your plan's cores are reserved for you.
- **Disk:** if your server uses more disk than the plan allows, it is stopped and can't start until you delete old
  worlds, logs or files.
