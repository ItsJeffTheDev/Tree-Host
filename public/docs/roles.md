# Roles & permissions

Everyone on Honey Host has one of three roles. An admin picks it when inviting or approving someone, and can change
it at any time under **Team → Members**.

| Role | Who it's for | In one sentence |
|---|---|---|
| 🧪 **Tester** | QA, playtesters, friends helping test | Can play on and start/stop Team servers, but can't change anything. |
| 🛠 **Developer** | Plugin developers | Can do everything needed to build and test plugins. |
| 👑 **Admin** | Whoever runs Honey Host | Can do everything, including managing people and the host PC. |

> **Tip:** When in doubt, invite people as **Developer**. Use **Tester** for people who only need to join and play.

---

## Everything, side by side

### Servers

| | Tester | Developer | Admin |
|---|:---:|:---:|:---:|
| See Team servers and their console log | ✓ | ✓ | ✓ |
| Join Team servers in Minecraft (whitelisted automatically) | ✓ | ✓ | ✓ |
| Start, stop and restart Team servers | ✓ | ✓ | ✓ |
| Create Team servers | | ✓ | ✓ |
| Have private **Solo** servers | | ✓ | ✓ |
| Change settings, game settings and memory | | ✓ | ✓ |
| Delete a Team server, reset its world, change its type or version | | only servers **they created** | ✓ |
| See and stop other people's Solo servers | | | ✓ |

### Plugins, console and files

| | Tester | Developer | Admin |
|---|:---:|:---:|:---:|
| See which plugins are installed | ✓ | ✓ | ✓ |
| Type console commands, use Whitelist/OP buttons | | ✓ | ✓ |
| Upload, enable, disable and delete plugins | | ✓ | ✓ |
| Deploy from their build (API tokens) | | ✓ | ✓ |
| Browse and edit server files | | ✓ | ✓ |

### People and the host PC

| | Tester | Developer | Admin |
|---|:---:|:---:|:---:|
| Invite people, approve or reject access requests | | | ✓ |
| Change roles, remove people, turn access requests on or off | | | ✓ |
| Connect playit.gg, set up and configure the Gateway | | | ✓ |
| Custom Java paths and Custom JAR servers | | | ✓ |
| 🎮 Play on host, 📁 open folders, auto-deploy from a folder on the host PC | | | ✓ |

---

## Why these rules?

**"Only servers they created."** Deleting a server, resetting its world or switching its version can wipe out
work that other people rely on. So on **Team** servers, only the person who created the server (shown on the
server's Settings tab) or an admin can do it. Everything else, such as restarting, deploying plugins or changing game
settings, is open to every developer.

**Testers can't run commands or edit files.** A console command like `op` or `stop` affects everyone on the server,
and plugins and files can run code on the host PC. Testers get exactly what they need to play-test.

**Host-PC features are admin-only.** Custom Java paths, custom jars and folder watching point at files and programs on
the host PC itself, so they're limited to the people who run it.

> **Important:** Anyone who can upload or deploy a plugin (developers and admins) can run code on the host PC,
> because that's what plugins are. Only give those roles to people you trust.

---

## Changing someone's role

1. Click **Team** (bottom left of the dashboard).
2. Under **Members**, pick the new role in that person's dropdown. It applies immediately; they may need to refresh
   the page.

You can't change your own role, and the last admin can't be demoted, so there's always someone who can manage the
team.

## Removing someone

**Team → Members → Remove.** Their account, logins and API tokens stop working straight away. Servers they created
stay; admins can delete them if needed.
