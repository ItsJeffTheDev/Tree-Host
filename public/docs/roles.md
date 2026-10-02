# Roles & permissions

Every Tree Host account has a **role**, and every role is a list of **permissions**. Staff work in the
**Staff Console** (`/admin`, or **🛠️ Staff Console** under your name in the dashboard); each part of it only appears if
your role has the permission it needs, and the server checks the same permissions on every request.

| Role | Who | In short |
|---|---|---|
| **Owner** | You (the emails in `TREEHOST_ADMIN_EMAILS`) | Every permission, always. Only Owners can edit roles. |
| **Admin** | People who run the business with you | People, billing, plans, promo codes, settings, every server. |
| **Developer** | People who build and fix Tree Host | Every server (including deleting and host settings), system info, audit log. No money, no people management. |
| **Support** | Helpers | Sees and fixes any server, sees accounts and plans. Can't delete anything or change billing. |
| **Customer** | Everyone who signs up | Buys plans and fully manages **their own** servers. Can't see anyone else's. |

Staff can have their own servers too: give yourself a free plan in **Staff Console → People → More**.

---

## What each role can do (defaults)

The Owner can change the Admin, Developer and Support columns in **Staff Console → Roles & permissions**.

| Permission | Owner | Admin | Developer | Support |
|---|:---:|:---:|:---:|:---:|
| Open the Staff Console | ✓ | ✓ | ✓ | ✓ |
| See every customer's server | ✓ | ✓ | ✓ | ✓ |
| Start, stop and run commands on any server | ✓ | ✓ | ✓ | ✓ |
| Change files, plugins and settings on any server | ✓ | ✓ | ✓ | ✓ |
| Delete servers, reset worlds, change versions (anyone's) | ✓ | ✓ | ✓ | |
| Host-level settings (custom Java, custom jars, ports) | ✓ | ✓ | ✓ | |
| See accounts | ✓ | ✓ | ✓ | ✓ |
| Manage accounts (suspend, password help, delete) | ✓ | ✓ | | |
| Change roles and invite staff | ✓ | ✓ | | |
| See billing | ✓ | ✓ | | ✓ |
| Manage billing (cancel plans, free plans, prices, capacity) | ✓ | ✓ | | |
| Manage promo codes | ✓ | ✓ | | |
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

Accounts (with their role) and the role permissions are saved with the rest of Tree Host's business data: in the
**Firebase Realtime Database** when Firebase is set up (with a local copy on the server), otherwise in local files.
Changes in **Roles & permissions** apply instantly to everyone with that role, without a restart.

---

## Adding staff

- **Invite:** Staff Console → People → **Invite staff**, pick the role, and send the one-time link (valid 7 days).
- **Promote an existing account:** Staff Console → People → the role dropdown next to their name.

## Suspending or removing someone

Staff Console → People → **More** next to their name:

- **Suspend**: signs them out, stops their servers and blocks sign-in. Their data is kept. Use **Unsuspend** to undo.
- **Temporary password**: for people locked out without email access. Send it privately.
- **Delete account**: removes the account and its servers. Cancel any active plan first (Staff Console → Billing).
