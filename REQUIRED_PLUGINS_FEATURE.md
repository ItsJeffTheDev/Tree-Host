# Managed Plugins

Staff Console → **Managed Plugins** (`/admin#staff-plugin`) lists every plugin Tree Host installs on servers by itself:

- **Tree Host Staff** (built in, always locked). Staff can upload a newer build (it must be `name: TreeHostStaff` in plugin.yml) or go back to the one bundled in `minecraft-plugin/TreeHostStaff.jar`.
- **Any plugin staff add.** Each has a name, version, description, staff notes, server types (none picked = every Bukkit-family type) and these switches:
  - **Locked**: owners can't delete, turn off or replace it, and it's put back if it goes missing.
  - **Optional** (unlocked): installed once per version. If the owner deletes or turns it off, it stays that way until a new version is uploaded or staff press *Push now*.
  - **Install automatically**: off = only installed when pushed.
  - **Paused**: not installed or enforced anywhere.

Servers that get managed plugins: customer, demo and team servers of the Bukkit family. They're checked when created, before every start and every 30 seconds (or at once with *Check all servers*).

Each card shows how many servers are up to date, on a different version, missing it, or had it removed by the owner; *Details* lists every server, earlier versions, the SHA-256 and a download link. Uploading a new version with a different file name swaps the old file out on every server.

On a customer's Plugins tab, managed plugins show *Required by Tree Host* (locked) or *Provided by Tree Host* (optional); clicking the name explains what it is.

## Permissions
- View: `system.view`
- Add, change, push, remove: `system.manage`

Every change is in the audit log.

## Storage
- `data/managed-plugins.json`: the list (and staff plugin upload info)
- `data/managed-plugins/<id>.jar`, `data/managed-plugins/TreeHostStaff.jar`: the jars (in the data folder, so they survive redeploys)
- Each server's `cfg.managedPlugins` records which version it got.

The old `data/required-plugins.json` / `required-plugins/` and `data/staff-plugin-info.json` are imported once on first start.

## API
| Method | Path | |
|---|---|---|
| GET | `/api/admin/managed-plugins` | all plugins with coverage, plus the server types |
| GET | `/api/admin/managed-plugins/:id` | one plugin with per-server status |
| GET | `/api/admin/managed-plugins/:id/jar` | download the jar |
| POST | `/api/admin/managed-plugins?filename=&name=&version=&description=&notes=&locked=1&autoInstall=1&types=paper,purpur` | add (body: the jar) |
| POST | `/api/admin/managed-plugins/:id/jar?version=&notes=&filename=` | new version (body: the jar); `treehoststaff` for the staff plugin |
| DELETE | `/api/admin/managed-plugins/treehoststaff/jar` | staff plugin back to the bundled build |
| PUT | `/api/admin/managed-plugins/:id` | settings (JSON) |
| DELETE | `/api/admin/managed-plugins/:id?purge=1` | stop managing (purge: also delete from servers) |
| POST | `/api/admin/managed-plugins/:id/push` | install now everywhere it belongs |
| POST | `/api/admin/managed-plugins-sync` | check every server now |

Code: `src/managed-plugins.js` (server), `public/console.js` (console page).
