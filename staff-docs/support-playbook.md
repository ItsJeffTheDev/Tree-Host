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

## Joining a customer's server in Minecraft

Set your Minecraft name in **Account** first. Then open the server → **🎮 Join as staff**, and join with the address shown.

- You get in even if the server is **whitelisted** (you're added for your visit and removed when you leave).
- Everyone sees a green-and-gold notice: **🌳 Tree Host » YourName (Support) joined. A Tree Host Support has joined your
  server.**
- You wear a gold **✔ STAFF** badge before your name in chat and in the player list (hover over it in chat: *Official
  Tree Host Staff*).
- **Paper, Spigot, Purpur, Folia and CraftBukkit** servers have the **Tree Host staff plugin** (put on every customer
  server automatically; customers can't remove or turn it off, and it comes back if deleted). It lets you in past the
  whitelist, a ban or a full server, refuses **kick and ban** commands aimed at you (including Essentials, LiteBans and
  AdvancedBan), undoes bans, and shows the badges.
- **Vanilla and Fabric** servers can't run plugins: there, bans on you are undone and everyone is asked not to kick
  staff, but a kick itself can't be stopped. You can join again straight away.
- This only works on **online-mode** servers from Minecraft **1.13** up (not proxies): that's how we know the name is
  really yours.

Be polite: it's the customer's server. Say why you're there, and don't change anything without asking.

> **Note:** Support and Developers can't open customers' **files** or **settings**. Ask an Admin if a fix needs them.

## 4. Free servers and codes (Admins)

- **Give a free plan now** (People → More): it shows up in their Billing right away. Pick how long it lasts, up to
  lifetime, and add a note (e.g. "Creator: @name").
- **Give a free server code** (People → More): a one-time code that only works for **that** account. They enter it in
  **Billing → Have a code?**. Tick "Email the code to …" or copy the message.
- **Promo codes** (Staff Console → Promo codes): codes anyone can use, for giveaways. Set a usage limit and an end date.

Always put the reason in the note: it goes in the audit log.

---

## 5. Rule breakers: taking action

The rules are in the [Terms of Service](/terms) (section 4). Every warning, suspension, ban and deletion goes through
**🛡️ Take action**, so the customer always gets a reason and we always have a numbered report.

**Where:** Staff Console → People → **More → Take action** (accounts), Staff Console → Servers → **🛡️ Action**, or
**🛡️ Take action** on a customer's server page.

| Action | What happens | Who can |
|---|---|---|
| ⚠️ **Warn** | They get the message. Nothing else changes. | Support and up |
| ⏸️ **Suspend** | Server: stopped and can't start. Account: locked out of every server (which stop), but they can sign in to see why and appeal. Plans keep billing. Pick 1 day to 90 days, or until lifted. Ends by itself. | Support and up |
| ⛔ **Ban** | Like a suspension, with no end date. Banning an **account** also cancels its plans (no automatic refund). | Admins |
| 🗑️ **Delete** | Removes the server, or the account with its servers (plans canceled). Can't be undone. | Admins and Developers (servers), Admins (accounts) |

**Filling it in:**

1. **Reason:** pick the closest one.
2. **Message to the customer:** what they did and what happens now. They see this word for word, so keep it calm and factual.
3. **Staff notes:** ticket numbers, who reported it, what you checked. Never shown to the customer.
4. **Evidence:** attach screenshots (they go into the PDF report) and text/log files. Leave **Save the console log** on:
   the last 500 lines of the server console are saved, even if the server is deleted later.
5. **They can appeal:** leave it on unless it's clear-cut (e.g. illegal content).

The customer is told in their **📬 Inbox** and by email, with the **action number** (like `TH-000012`).

**Action logs** (Staff Console) lists everything. Filter by action type (pick one or several), action number, username, email, staff member, server, reason, status, appeal or date range, and click a name to see all of their actions. Open one to see the reason, the evidence, who took
it and when, a snapshot of the customer, the appeal and the timeline. **📄 View PDF report** or **⬇ Download PDF** gives
the full report to keep or send to the Owner. **Export all (CSV)** gives the whole list. Opening or downloading a
report is written to the audit log.

**Appeals:** customers press **Appeal** in their inbox (or on the suspended/banned page). It shows up as "Appeal waiting"
in Action logs, and support@ gets an email. **Admins** accept (this lifts it) or deny, with an answer the customer
sees. Each action can be appealed once.

**Linked accounts:** customers can be signed in to several accounts in one browser, and Tree Host links every
account used in the same browser (People shows **🔗 N linked**). When you act on an account, **Also apply to linked
accounts** (on by default) gives each linked customer account the same action with its own number, pointing at the
first one. Lifting the first action, or accepting its appeal, lifts the linked ones too. Staff accounts are never
included. If someone signs in to a new account in a browser where a suspended or banned account was used, the new
account gets the same action automatically (reason: *Ban evasion*, appealable).

**Lifting early:** open the action → **Lift**, with a reason (the customer sees it).

> **Important:** Never take action on your own account or servers, and don't take action on a friend's. You can't
> act on people with a role equal to or above yours.

To just talk to someone, use **People → More → ✉️ Send message**: it goes to their inbox (and email), signed with
your name.

---

## 5b. Copyright notices, child safety and police

These are the only cases where speed and exact steps matter more than being friendly. Follow them word for word.

### Copyright (DMCA) notices

Notices arrive at dmca@ (the [Copyright page](/dmca) tells people what to send).

1. **Check it's complete:** signature, the work, where it is on Tree Host, contact details, and both statements (good faith,
   and accuracy under penalty of perjury). If something's missing, reply asking for it and do nothing else yet.
2. **Find the server** from the address, listing or file name.
3. **Take action → Suspend** the server (reason: *Copyright notice*, until lifted), or if only one file is affected, ask an
   Admin to remove it. Paste the notice into the evidence. In the customer message, say what was reported and that they can
   send a counter-notice to dmca@ (link the Copyright page).
4. **Reply to the sender** that the material was disabled, with the action number.
5. **Counter-notice?** If complete, forward it to the original sender. Wait 10 business days. If they don't tell us they've
   gone to court, lift the action between 10 and 14 business days after the counter-notice arrived.
6. **Repeat infringers:** 3 valid, uncountered notices on one account within 12 months → pass to an Admin to **ban** the
   account (reason: *Repeat copyright infringement*). The Terms promise this, so we have to do it.

### Child sexual abuse material (CSAM): never look, never share

If a report or anything you see suggests CSAM on a server:

1. **Don't open, download, copy, screenshot or forward the files**, not even to staff. Viewing or sharing it is a crime,
   even "to check".
2. **Take action → Suspend** the server and the account right away (reason: *Illegal content*, appeals off). Don't delete
   anything: the law requires us to **preserve** it.
3. **Tell the Owner immediately** (phone or DM, not the public staff channel), with the action number only.
4. The Owner reports it to **NCMEC's CyberTipline** (report.cybertip.org) as U.S. law requires for providers, preserves the
   data for at least one year, and does not tell the customer why beyond "illegal content".

### Police and legal requests (subpoenas, court orders, emergency requests)

1. **Don't reply, confirm or deny anything**, and don't tell the customer. Forward the request to the Owner.
2. The Owner checks it's genuine (call back on the agency's published number, not one in the email), and that it's the right
   kind of legal process for what's asked. Emergency requests (risk of death or serious injury) can be answered faster.
3. Give only what the request covers, keep a copy of the request and what was given, and log it as a staff note.

---

## 6. When to escalate

| Problem | Pass it to |
|---|---|
| Refunds, disputes, billing errors | Admin (billing@) |
| Many servers down at once, the site is slow or down | Developer / Owner, right away (post in the staff channel) |
| Security worries: hacked account, leaked data, someone probing the site | Owner, right away |
| Legal requests, police | Owner only. Don't reply yourself (see 5b). |
| Copyright notices | Follow 5b; repeat infringers to an Admin |
| Anything that might be CSAM | Owner, immediately. Don't open the files (see 5b). |
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
