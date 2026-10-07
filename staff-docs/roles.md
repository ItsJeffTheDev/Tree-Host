# Roles & permissions

Every Tree Host account has a **role**, and every role is a list of **permissions**. Staff work in the
**Staff Console** (`/admin`, or **🛠️ Staff Console** under your name in the dashboard); each part of it only appears if
your role has the permission it needs, and the server checks the same permissions on every request.

| Role | Who | In short |
|---|---|---|
| **Owner** | You (the emails in `TREEHOST_ADMIN_EMAILS`) | Every permission, always. Only Owners can edit roles. |
| **Admin** | People who run the business with you | People, billing, plans, promo codes, settings, every server (files and settings too). No machine-level settings, no role editing. |
| **Developer** | People who build and fix Tree Host | Sees every server and its console, starts and stops them, system info, audit log. Can't open customers' files or settings, delete servers, or manage money or people. |
| **Support** | Helpers | Sees any server and its console, starts and stops it, sees accounts and plans, warns and suspends. Can't open customers' files or settings, delete anything or change billing. |
| **YouTuber** | Content creators you work with | A customer account with **creator perks** (below): a red YouTuber badge on their profile, on their listed servers and above their head in-game. No staff powers by default. |
| **Customer** | Everyone who signs up | Buys plans and fully manages **their own** servers. Can't see anyone else's. |

Staff can have their own servers too: give yourself a free plan in **Staff Console → People → More**.

To make someone a YouTuber, send them an **invite link**: **Staff Console → People → Invite people**, pick
**YouTuber**, add who it's for (e.g. their channel), how long the link works (1-30 days) and, if you can manage billing,
a free plan that comes with it. The link works once. New people create their account with it; people who already
have an account sign in and press **Accept**. Unused links are listed under the form, where you can revoke them.
You can also pick **YouTuber** in someone's Role dropdown in **People** (Admins and Owners
can). Pair it with a free plan or a creator promo code if you're sponsoring them. If you want them to have any extra
powers, the Owner can tick permissions for the YouTuber role in **Roles & permissions**.

### Creator perks

Owners turn these on or off for the YouTuber role (or any role) in **Roles & permissions → Creator perks**. The in-game
ones work on every Tree Host Paper, Spigot, Purpur, Folia and CraftBukkit server through the Tree Host staff plugin,
need the creator's **Minecraft name** set in their Account, and only apply on servers that check names (online mode or
behind a proxy). Staff never get them: they wear the STAFF badge instead.

| Perk | What it does | YouTuber by default |
|---|---|:---:|
| YouTuber badge in-game | A red **▶ YOUTUBER** tag above their head, in chat and in the player list | ✓ |
| Join announcement | Everyone on the server is told when they join | ✓ |
| Join full servers | They can still join a full server | ✓ |
| Skip whitelists | They can join whitelisted servers. Bans still apply | |
| Featured on the server list | Their listed servers show first on the public Servers page, with a Featured badge | ✓ |

Creators are never protected from kicks or bans: a server's owner stays in charge of who plays there. Changes reach
every server within a few seconds.

---

## What each role can do (defaults)

The Owner can change the Admin, Developer and Support columns in **Staff Console → Roles & permissions**.

| Permission | Owner | Admin | Developer | Support |
|---|:---:|:---:|:---:|:---:|
| Open the Staff Console | ✓ | ✓ | ✓ | ✓ |
| See every customer's server | ✓ | ✓ | ✓ | ✓ |
| Start, stop and run commands on any server | ✓ | ✓ | ✓ | ✓ |
| Open and change files, plugins and settings on any server | ✓ | ✓ | | |
| Delete servers, reset worlds, change versions (anyone's) | ✓ | ✓ | | |
| Host-level settings (custom Java, custom jars, ports) | ✓ | | | |
| See accounts | ✓ | ✓ | ✓ | ✓ |
| Manage accounts (suspend, password help, delete) | ✓ | ✓ | | |
| Change roles and invite staff | ✓ | ✓ | | |
| See billing | ✓ | ✓ | | ✓ |
| Manage billing (cancel plans, free plans, prices, capacity) | ✓ | ✓ | | |
| Manage promo codes | ✓ | ✓ | | |
| See actions taken (and PDF reports) | ✓ | ✓ | ✓ | ✓ |
| Warn and suspend (accounts and servers) | ✓ | ✓ | | ✓ |
| Ban | ✓ | ✓ | | |
| Decide appeals | ✓ | ✓ | | |
| Message customers | ✓ | ✓ | | ✓ |
| See all activity (sign-ups, payments) | ✓ | ✓ | | |
| See the audit log | ✓ | ✓ | ✓ | |
| See system info | ✓ | ✓ | ✓ | |
| Change site settings (sign-ups, Discord alerts) | ✓ | ✓ | | |
| Edit roles | ✓ | | | |

Customers have none of these: on **their own** servers they can do everything (start, console, plugins, files,
settings, backups, delete).

---

## Rules that always apply

- **Nobody can hand out more access than they have.** You can only give roles *below* your own, and only change,
  suspend or delete people below you. (Owners can do everything.)
- **There's always an Owner.** The last Owner can't be demoted, suspended or deleted.
- **Customers are fully separated.** Each customer only sees their own servers, and each server runs in its own
  isolated container.
- **Everything staff do is logged.** Role changes, suspensions, free plans, promo codes, plan and setting changes go in
  **Staff Console → Audit log** (visible with *See the audit log*).

---

## Where roles are stored

Accounts (with their role) and the role permissions are saved with the rest of Tree Host's business data, with a
copy on the server (details for developers in [Running Tree Host](hosting-guide.md)).
Changes in **Roles & permissions** apply instantly to everyone with that role, without a restart.

---

## Adding staff

- **Invite:** Staff Console → People → **Invite staff**, pick the role, and send the one-time link (valid 7 days).
- **Promote an existing account:** Staff Console → People → the role dropdown next to their name.

## Suspending, banning or removing someone

Staff Console → People → **More → 🛡️ Take action**: warn, suspend, ban or delete, always with a reason, a message to
the customer and evidence. Every action gets a number and a PDF report in **Action logs**. See the
[Support playbook](support-playbook.md#5-rule-breakers-taking-action).

- **Temporary password** (People → More): for people locked out without email access. Send it privately.
