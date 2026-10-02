# Support playbook

How we help customers: where requests come in, how to check who you're talking to, and how to fix the common problems
from the **Staff Console**. These guides are for Tree Host staff only. Never share them, or screenshots of the Staff
Console, outside the team.

> **Important:** Never ask anyone for their password, and never share a customer's email, servers or payment details
> with anyone but that customer.

---

## Where requests come in

| Inbox / place | What lands there | Who answers |
|---|---|---|
| **support@treehost.online** | Server problems, account help, anything general. Replies to our system emails come here too. | Support and up |
| **billing@treehost.online** | Payments, failed charges, refunds, plan changes | Admins (Support can read and pass on) |
| **promotion@treehost.online** | Creators, partnerships, sponsorships | Owner / Admins |
| **daniel@treehost.online** | The Owner's own inbox. Not for customers. | Owner |
| **Discord tickets** (#get-help) | Same as support@ | Support and up |

Reply from the inbox the request came to, so the customer's thread stays in one place.

---

## 1. Check who you're talking to

Before you change anything on an account, make sure the person owns it:

- **Email:** they must write from the email on the account (**Staff Console → People**, search their name or email).
- **Discord:** ask them to email support@ from the account's email, or to tell you the name of one of their servers
  **and** the date they bought their plan (shown under **Billing**).
- If you're unsure, don't act: send them to support@ from their account's email.

> **Warning:** Don't change the email on an account, transfer servers or hand out access because someone "lost" their
> email. Pass it to an Admin.

---

## 2. Find the customer and their server

- **People:** every account, its role, plans and number of servers. Search by name or email.
- **Servers:** every customer's server, with its owner, status and plan. Open one to see the same dashboard the
  customer sees: console, files, plugins, settings and backups.

Whatever you do on a customer's server is recorded in the **Audit log** under your name.

---

## 3. Common problems and the fix

**"My server won't start" / crashes**
Open the server → **Console**. The red lines usually name the plugin or mod at fault. Suggest disabling it on the
**Plugins** tab, or do it for them if they ask. Wrong Java or server version? **Settings → Version**. Ask before changing
the version: it can't always be undone.

**"I can't join" / "not white-listed"**
Check the server is **Running**, that they use the address on the server's page, and the whitelist (Console →
**Whitelist me** needs their Minecraft name in **Account**). Point them to the public guide:
[Troubleshooting](/help.html?doc=troubleshooting).

**Lag**
Console → **TPS** (20 is perfect). Usually heavy plugins/mods or too many players for the plan. Suggest a bigger plan.

**Lost world / broken files**
Open the server → **Backups** and restore the latest good one. **Always make a fresh backup first** so the restore can
be undone.

**"I can't sign in" / forgot password**
Check they use the sign-in method they signed up with (Google or email). Otherwise **People → More → Send password
reset email** (Admins and up). Accounts without a reset option get a **Temporary password**: send it privately and ask
them to change it.

**Paid but the plan isn't active**
Usually a few seconds' delay: ask them to refresh. Still nothing after a few minutes? Pass it to an Admin with the
customer's account email and the time they paid. Don't give a free plan as a fix without an Admin's OK.

**Failed payment**
The server keeps running for 3 days. Ask them to update their card in **Billing → Payment method & invoices**.

**Refunds**
Only Admins decide refunds (see the [Terms](/terms)). Collect the account email, the plan and the reason, and pass it on.
Never promise a refund.

---

## 4. Free servers and codes (Admins)

- **Give a free plan now** (People → More): it shows up in their Billing right away. Pick how long it lasts, up to
  lifetime, and add a note (e.g. "Creator: @name").
- **Give a free server code** (People → More): a one-time code that only works for **that** account. They enter it in
  **Billing → Have a code?**. Tick "Email the code to …" or copy the message.
- **Promo codes** (Staff Console → Promo codes): codes anyone can use, for giveaways. Set a usage limit and an end date.

Always put the reason in the note: it goes in the audit log.

---

## 5. Rule breakers

The rules are in the [Terms of Service](/terms) (section 3). For a clear break (crypto mining, attacks, illegal content):

1. **Stop the server** and make a backup (evidence).
2. Tell an Admin, with the server name and what you saw.
3. Admins decide: **Suspend** (People → More) signs them out, stops their servers and keeps the data.

Don't argue with the customer, and don't delete anything yourself.

---

## 6. When to escalate

| Problem | Pass it to |
|---|---|
| Refunds, disputes, billing errors | Admin (billing@) |
| Many servers down at once, the site is slow or down | Developer / Owner, right away (post in the staff channel) |
| Security worries: hacked account, leaked data, someone probing the site | Owner, right away |
| Legal requests, takedowns, police | Owner only. Don't reply yourself. |
| Creators and partners | promotion@ |

---

## Saved replies

**Asking for proof of ownership**
> Thanks for reaching out! To keep your account safe, please email us at support@treehost.online from the email
> address on your Tree Host account and we'll take it from there.

**Server fixed**
> All sorted: your server **NAME** is running again. The problem was **CAUSE**. If anything else comes up, just reply here.

**Passing on to billing**
> Thanks! I've passed this to our billing team (billing@treehost.online). They'll get back to you as soon as they can.
