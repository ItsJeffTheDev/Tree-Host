# Running Tree Host

For the people who run Tree Host: renting the server, connecting **treehost.online**, payments, email, and day-to-day work.

---

## How it fits together

```
 Players ──── play.treehost.online:25600 ───┐
                                            ▼
 Customers ── https://treehost.online ──► Rented Linux server
                                            ├─ Caddy (HTTPS certificate, forwards to Tree Host)
                                            ├─ Tree Host (website, dashboard, billing)
                                            └─ Docker: one isolated container per Minecraft server
 Stripe ──── payments + webhook ────────────┘
```

Everything runs on **one rented Linux server**. Each Minecraft server gets its own port (25600, 25601, ...) on
`play.treehost.online`.

---

## 1. Rent a server

Pick a **dedicated server or a large VPS** with Ubuntu 22.04 or 24.04. Minecraft needs memory (RAM) and fast single-core
CPU much more than anything else.

| What to look for | Why |
|---|---|
| **32-64 GB RAM** | RAM is what you sell. 64 GB fits roughly 25 Sapling (2 GB) servers. |
| **Fast CPU** (high clock speed, e.g. Ryzen) | Minecraft runs mostly on one core per server. |
| **NVMe SSD**, 500 GB+ | Worlds, backups and fast chunk loading. |
| **DDoS protection** | Public Minecraft servers get attacked. Many hosts include it. |
| **Unmetered or large traffic** | Players use a steady stream of bandwidth. |

**Our pick for launch (October 2026 plan):** OVH **RISE-S** (Ryzen 7 9700X, 64 GB, NVMe, game DDoS protection), about
$77/month plus $77 setup. It fits about 25 Saplings, and about 17 paying Saplings cover its cost. If cash is short, start on
a netcup **RS 4000 G12** (32 GB, about $33/month) and move up once it fills. Other good choices: Hetzner (dedicated "AX"
servers), Contabo. Pick a location close to your players (we launch in the US and Canada first).

> **Note:** a VPS works too, but "shared" vCPUs get slow under load. For a business, a dedicated server is worth it.

When it's ready you get its **IP address** (e.g. `203.0.113.10`) and a root password or SSH key.

### Free option: Oracle Cloud "Always Free"

Oracle gives one free ARM server forever: up to **2 CPU cores (OCPUs), 12 GB of RAM**, 200 GB of disk and 10 TB of traffic a
month (Oracle halved the free ARM limit; it used to be 4 cores and 24 GB). That's enough for testing and about 3-4 small
customer servers. Move to a paid server before you sell plans.

**1. Create the account**

1. Sign up at [oracle.com/cloud/free](https://www.oracle.com/cloud/free/). It asks for a card to check you're a real person;
   Always Free resources are not charged.
2. **Home region:** choose carefully, it can't be changed. Pick one near your players. Less busy regions (not
   Ashburn, Frankfurt or London) usually have free ARM servers available.

**2. Create the server**

1. **Menu → Compute → Instances → Create instance.**
2. **Image:** click *Change image* → **Canonical Ubuntu 24.04**.
3. **Shape:** click *Change shape* → **Ampere** → **VM.Standard.A1.Flex** → **2 OCPUs** and **12 GB memory**.
4. **Networking:** keep *Create new virtual cloud network* and *public subnet*, and make sure **Assign a public IPv4 address** is on.
5. **SSH keys:** *Generate a key pair for me* → **Download private key**. Keep this file safe: it's how you log in.
6. **Boot volume:** tick *Specify a custom boot volume size* → **150 GB** (the free limit is 200 GB in total).
7. Click **Create**. When it's *Running*, copy the **Public IP address**.

> **Note:** "Out of capacity for shape VM.Standard.A1.Flex" is common. Try another *Availability domain* in the same
> form, try again later (early morning often works), or start with 2 OCPUs and 12 GB and resize later.

**3. Open the ports in Oracle's network**

Oracle has a second firewall in front of the server. On the instance page click the **subnet** → **Default Security List**
→ **Add Ingress Rules**, and add three rules, each with *Source CIDR* `0.0.0.0/0` and *IP Protocol* **TCP**:

| Destination port range | For |
|---|---|
| `80` | the website (HTTPS certificate) |
| `443` | the website |
| `25600-25999` | customers' Minecraft servers |

(The installer opens the same ports in the server's own firewall automatically.)

**4. Log in**

On Windows, in PowerShell (replace the file name and IP):

```powershell
ssh -i "$HOME\Downloads\ssh-key-2026-10-01.key" ubuntu@203.0.113.10
```

If it complains the key's permissions are too open, run this once and try again:
`icacls "$HOME\Downloads\ssh-key-2026-10-01.key" /inheritance:r /grant:r "$($env:USERNAME):R"`

Then continue with section 2 (DNS) and section 3 (install). The user on Oracle is `ubuntu`, so commands use `sudo`.

> **Important:** Oracle may reclaim free servers that look idle (very low CPU, network and memory use for 7 days). Once
> customers' servers run, that isn't a problem. To be safe from day one, upgrade the account to **Pay As You Go** (Billing →
> Upgrade): Always Free resources stay free, and the idle rule no longer applies. Set a **budget alert** of $1
> (Billing → Budgets) so you'd notice if anything ever costs money.

When you outgrow it: rent a bigger server, run the installer there, copy `/var/lib/tree-host` over, and point the DNS at the new IP.
Accounts and billing are already in Firebase.

---

## 2. Point treehost.online at the server

Where you bought **treehost.online**, open its **DNS settings** and add these records (replace `203.0.113.10` with your
server's IP):

| Type | Name | Value | Why |
|---|---|---|---|
| **A** | `@` | `203.0.113.10` | the website: treehost.online |
| **A** | `www` | `203.0.113.10` | www.treehost.online (redirects to treehost.online) |
| **A** | `play` | `203.0.113.10` | the address players join: play.treehost.online |

If the server also has an IPv6 address, add the same three as **AAAA** records.

> **Important:** if your domain uses **Cloudflare**, set the `play` record to **DNS only** (grey cloud). Cloudflare's
> proxy can't carry Minecraft traffic. The `@` and `www` records can also stay DNS only; Caddy handles HTTPS itself.

DNS changes usually work within minutes, sometimes up to a few hours. Check with `ping treehost.online` (it should
show your server's IP).

---

## 3. Install Tree Host

1. Connect to the server (`ssh ubuntu@203.0.113.10` on Oracle, `ssh root@...` elsewhere).
2. Get the code. The repo is private: when git asks, enter your GitHub username, and as the password a **personal access
   token** (GitHub → Settings → Developer settings → Fine-grained tokens → read-only access to this repo):

   ```bash
   sudo git clone https://github.com/ItsJeffTheDev/Honey-Host.git /opt/tree-host
   ```

3. Run the installer. It installs Docker, Node.js, Caddy and a firewall, creates a `treehost` user, turns on nightly
   backups, and starts everything. It asks for **your email** (that account becomes the Owner) and ends with a health
   check:

   ```bash
   sudo bash /opt/tree-host/deploy/install.sh
   ```

4. Fix anything the health check marks **FAIL**, and run it again whenever something seems wrong:

   ```bash
   sudo bash /opt/tree-host/deploy/doctor.sh
   ```

   It checks the services, your settings, that `treehost.online`, `www` and `play` point at this server, HTTPS, the
   firewall, disk space and backups.

5. Sign up at **https://treehost.online/dashboard** with that email,
   click the link in the verification email Firebase sends you, and sign in again: you're the Owner, with access to the **Staff Console** (`/admin`). (Signing in with
   Google using that email works straight away.) Everyone else who signs up is a normal customer. Want your own servers
   too? Give yourself a free plan in **Staff Console → People → More → Give a free plan**.

Your settings live in **`/etc/tree-host.env`**. After changing it: `sudo systemctl restart tree-host`.

---

## 4. Payments (Stripe)

1. Create an account at [stripe.com](https://stripe.com) and fill in your business details.
2. Stay in **Test mode** first. **Developers → API keys** → copy the **Secret key** (`sk_test_...`) into
   `STRIPE_SECRET_KEY` in `/etc/tree-host.env`.
3. **Developers → Webhooks → Add endpoint**:
   - URL: `https://treehost.online/api/billing/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
     `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`
   - Copy the **Signing secret** (`whsec_...`) into `STRIPE_WEBHOOK_SECRET`.
4. **Settings → Billing → Customer portal**: turn it on, allow **canceling subscriptions** and **updating payment methods**,
   and set cancellations to happen **at the end of the billing period**. Save.
5. `sudo systemctl restart tree-host`, then buy a plan on your own site with Stripe's test card `4242 4242 4242 4242`
   (any future date, any CVC). The plan should turn **Active** and you can create a server.

When everything works: switch Stripe to **Live mode**, repeat steps 2-4 with the live keys, and restart.

> **Tip:** set your prices in **Staff Console → Plans**. Changes apply to new purchases; existing customers keep their price.

---

## 5. Firebase (sign-in and database)

Tree Host uses your Firebase project **tree-host** for two things:

- **Firebase Authentication:** customers sign in with email/password or Google. Firebase also sends the verification and
  password-reset emails.
- **Realtime Database:** stores accounts, plans, subscriptions and activity, so they survive even if the rented server dies.
  (Worlds and server files stay on the server; back those up as in section 8.)

**In the [Firebase console](https://console.firebase.google.com/project/tree-host):**

1. **Authentication → Sign-in method:** turn on **Email/Password** and **Google**.
2. **Authentication → Settings → Authorized domains:** add `treehost.online` (and `www.treehost.online`).
3. **Realtime Database → Rules:** paste this and click **Publish**. Browsers never talk to the database directly; only the
   Tree Host server does, with its own key, so everything else is locked:

   ```json
   { "rules": { ".read": false, ".write": false } }
   ```

4. **Project settings → Service accounts → Generate new private key.** This downloads a `.json` file.

   > **Warning:** this file is a master key to your Firebase project. Never commit it, email it or post it anywhere.

5. Upload it to the server and lock it down:

   ```bash
   scp tree-host-firebase-adminsdk-xxxx.json root@203.0.113.10:/etc/tree-host-firebase.json
   ssh root@203.0.113.10 'chown root:treehost /etc/tree-host-firebase.json && chmod 640 /etc/tree-host-firebase.json'
   ```

6. `sudo systemctl restart tree-host`. The log (`journalctl -u tree-host -n 30`) should say
   **Sign-in: Firebase. Database: Firebase Realtime Database.** Existing local data is uploaded automatically the first time.

The public Firebase settings (API key, project ID...) are already in `/etc/tree-host.env`. They are meant to be public.

> **Tip:** Firebase's free Spark plan covers sign-in and a small database comfortably. Under **Authentication → Templates**
> you can change the sender name and text of the emails to "Tree Host".

---

## 6. Email

Tree Host sends its own branded emails (with the logo, a tree watermark and a Discord invite; set `TREEHOST_DISCORD_INVITE` to change the link) through Resend: welcome (with "confirm your email"), password resets, plan
active / ended, failed payments, free server codes, staff actions, appeals and staff messages. Without it, nothing is
sent except Firebase's plain sign-in emails. To turn it on:

1. Create a free account at [resend.com](https://resend.com).
2. **Domains → Add domain** → `treehost.online`. Resend shows a few DNS records (TXT and MX). Add them at your domain's DNS
   settings exactly as shown, then click **Verify**.
3. **API keys → Create** (permission: *Sending access*) and put it in `RESEND_API_KEY` in the settings file
   (`/etc/tree-host.env` on the server, `test-site.env` on your PC). Keep `MAIL_FROM=Tree Host <no-reply@treehost.online>`.
4. Restart Tree Host.
5. Staff Console → **Settings → Emails**: both badges should be green. Open the previews to see every email, and
   use **Send it to me** to get a real one in your inbox.

The password reset and confirm-your-email emails are also ours (same design, from our address) as long as the
Firebase **service account** file is set up (`FIREBASE_SERVICE_ACCOUNT_FILE`); Firebase still makes the one-time
links. Without the service account, Firebase sends its own plain versions.

> **Note:** until the domain is verified in Resend, sending fails. Resend's test address (`onboarding@resend.dev`)
> only delivers to your own Resend login email.

> **Important:** your mailboxes (below) already use the domain's **MX** records. Resend's records go on a
> `send` subdomain, so add them **next to** your existing records; never replace the main MX records, or your
> inboxes stop receiving mail.

### Tree Host's inboxes

| Address | Used for | Setting |
|---|---|---|
| `support@treehost.online` | Website contact, Terms/Privacy, Help, Reply-To on general emails | `TREEHOST_SUPPORT_EMAIL` |
| `billing@treehost.online` | Billing questions on the website, Reply-To on payment emails | `TREEHOST_BILLING_EMAIL` |
| `promotion@treehost.online` | Creators and partnerships, Reply-To on free-server code emails | `TREEHOST_PROMO_EMAIL` |
| `daniel@treehost.online` | The Owner account (sign in with it to get the Owner role) | `TREEHOST_ADMIN_EMAILS` |

These are the defaults, so they work without changing anything. Emails are sent **from** `no-reply@treehost.online`
(`MAIL_FROM`); replies go to the right inbox automatically.

---

## 7. Before you open to the public

- [ ] `https://treehost.online` loads with a padlock, and `play.treehost.online` points at the server.
- [ ] Stripe is in **Live mode**, the webhook shows successful deliveries, `BILLING_DEMO=0`.
- [ ] A real test purchase works, and a refund in Stripe looks right.
- [ ] Sign-up, Google sign-in and **Forgot your password?** work on treehost.online.
- [ ] Realtime Database rules are locked (step 5.3), and the log says **Database: Firebase Realtime Database**.
- [ ] **Terms**, **Privacy** and **Copyright (DMCA)** pages: set `TREEHOST_COMPANY` (the LLC's legal name),
      `TREEHOST_JURISDICTION` (e.g. `the State of Texas, USA`), `TREEHOST_ADDRESS` (a mailing address; a registered-agent
      or virtual mailbox address is fine), `TREEHOST_SUPPORT_EMAIL`, `TREEHOST_DMCA_EMAIL` and `TREEHOST_DMCA_AGENT` (the
      agent's name), and **have them checked by a lawyer**. They are starting templates, not legal advice.
- [ ] **Register the DMCA agent** with the U.S. Copyright Office (dmca.copyright.gov, $6, renew every 3 years) using the
      same name, address and email as the /dmca page. Without it you don't get the DMCA safe harbor.
- [ ] Set up `dmca@`, `support@` and `billing@` inboxes, and SPF, DKIM, **DMARC** and a **CAA** record (`0 issue "letsencrypt.org"`)
      on treehost.online.
- [ ] Plans and prices set (**Staff Console → Plans**). **Capacity** (Staff Console → Plans → Capacity) defaults to about 90%
      of the RAM; keep it there or lower. Each monthly plan is guaranteed one running server; extra servers on the same plan
      only start when there's unsold memory, and are refused (with a message) when the machine is full.
- [ ] **Lifetime plans:** each holds 4 × 4 GB + 2 × 1 GB forever (about 20 GB), so only 2 are sold per machine by default
      (same card). The Terms promise at least 5 years, with a pro-rata refund if Tree Host closes sooner.
- [ ] Checkout shows the renewal terms, the 18+ / parent box and the EU/UK withdrawal waiver, and each subscription stores
      what was agreed (time, IP, wording version). Do a test purchase and check it in the subscription's details.
- [ ] Decide on the EU/UK: until you're registered for VAT (EU OSS / UK), either don't advertise there or turn on Stripe Tax.
- [ ] You can join a test server at `play.treehost.online:25600` from outside your home network.
- [ ] Off-server backups are set up (section 9).

---

## 8. Day-to-day

- **Staff Console → Billing**: monthly revenue, memory sold vs. capacity, every subscription. Unpaid plans keep running for 3
  days, then stop; servers of ended plans are deleted after 14 days.
- **Staff Console → People**: find customers, give free plans (giveaways, partners, your own servers), suspend abusers, reset passwords.
- **🌳 All servers** (top of the sidebar, support and admins): every customer's server, to help with problems.
- **Activity** and **Discord alerts** (Staff Console → Settings): new customers, payments, failed payments and crashes.
- **Logs:** `journalctl -u tree-host -f`
- **Donations** (Staff Console → Billing → Launch fund): set the goal, add money raised outside the website (the old Stripe
  payment link, cash) so the total on /donate is right, and hide a public supporter message that shouldn't be there.
  Donors who want the Discord Supporter role open a ticket; check their donation here, then use `/supporter`.
  The same card holds the **costs receipt** shown on /donate: every bill (name, what it's for, amount, monthly / yearly /
  one-time, paid or not). Keep it true and current: when you pay a bill, mark it **Paid**; when a price changes, change
  it. Donations count toward unpaid one-time costs first, then months of running costs, after Stripe's fee.
- **Price comparison** (Staff Console → Plans → Price comparison): the "compare your plan" chart on the Why page. Every
  month or two, check each host's **regular** monthly price (not the first-month discount) for the same memory as your
  plans, update it, and set **Checked on**: the page shows that date. Never guess a price; remove a host you can't check.
- **Team page** (/team): every Owner, Admin and Developer appears automatically. Each sets a title and a short bio in
  **Account → Team page** (or hides themselves); the picture is their Minecraft head, from the Minecraft name in Account.

### Monthly business check (first Monday of the month)

| Look at | Where | Healthy |
|---|---|---|
| Paying customers and monthly revenue | Staff Console → Billing | Revenue above the machine's cost (about 17 Saplings on a RISE-S) |
| Memory sold, and extra servers running | Staff Console → Plans → Capacity | Sold under 80%: order the next machine at 80% |
| Failed payments and chargebacks | Billing, and the Stripe dashboard | Chargebacks under 0.5% of payments |
| Crashes and support load | Activity, the support inbox | No server crashing every day; replies within 24 h (priority: 4 h) |
| Cancellations and why | Billing, cancellation emails | Ask cancelled customers one question: why? |
| Lifetime plans sold | Staff Console → Plans → Capacity | At or under the per-machine cap |

### Updating Tree Host

Once, so the server can download updates from the private repo without a token, run
`sudo bash /opt/tree-host/deploy/deploy-key.sh` and add the key it prints in GitHub (repo → **Settings → Deploy keys**,
read-only).

Then each time: push the new code to GitHub, and on the server:

```bash
sudo bash /opt/tree-host/deploy/update.sh
```

Running servers are stopped cleanly and the ones set to **Start automatically** come back. Tell customers before big
updates.

---

## 9. Backups of the whole machine

Accounts, plans, subscriptions and moderation records (Action logs, appeals, inboxes) are safe in Firebase. The
**evidence files** attached to actions (screenshots, logs) stay on the machine, in
`/var/lib/tree-host/moderation-evidence`. Worlds and server files live in **`/var/lib/tree-host`** too, and
your settings in **`/etc/tree-host.env`** and **`/etc/tree-host-firebase.json`**.
The installer turns on a **nightly backup** of all three (`deploy/backup.sh`, at about 04:30). Archives go to
`/var/backups/tree-host`, and the newest 3 are kept (`TREEHOST_BACKUP_KEEP`). Run one by hand with
`sudo systemctl start tree-host-backup` and check it with `journalctl -u tree-host-backup -n 20`.

Copies on the same machine don't help if the server dies. To also send them somewhere else, get storage you can reach
over SSH (e.g. a Hetzner Storage Box, or any other Linux machine), give root's SSH key access to it, and set:

```
TREEHOST_BACKUP_RSYNC=u123456@u123456.your-storagebox.de:tree-host
```

**Restoring** on a new server: run the installer, `sudo systemctl stop tree-host`, then
`sudo tar -xzf tree-host-....tar.gz -C /` and `sudo systemctl start tree-host`.

---

## 10. Security checklist

What Tree Host does by itself, and what you set up on the machine. `sudo bash /opt/tree-host/deploy/doctor.sh` checks
most of the setup items for you.

### Sign-in and access (built in)

- **Two-factor sign-in for staff.** On the real site (an `https://` address) every staff account must turn on
  two-factor sign-in (a 6-digit code from an authenticator app) before the Staff Console opens; until then it can only
  do what a customer can. Each account gets 8 one-time recovery codes. Customers can turn it on too (Account).
  `TREEHOST_STAFF_2FA=0` turns the requirement off; don't, on a public site.
- **No look-alike names.** Usernames like `admin`, `Admin_1`, `TreeHostSupport`, `support`, `moderator` or `owner`
  can't be registered, so nobody can pose as the team. There's no built-in "admin" account: the first account made is
  the Owner, under your own name.
- **Login lockout.** 5 wrong passwords or 2FA codes from one address (or for one account) lock it out for 15 minutes.
- **Least privilege.** Give people the lowest role that does the job: **Support** for helpers (no files, settings or
  deleting), **Admin** only for people you trust with money and every customer's data. Roles & permissions in the Staff
  Console shows exactly what each role can do.
- **Session cookies** are HttpOnly, SameSite=Strict and Secure (https only), and expire after 30 days.

### The website (built in, plus Caddy)

- **HTTPS only:** Caddy gets the certificate and redirects http to https; HSTS (with subdomains) is on.
- **Security headers:** a Content Security Policy (scripts only from Tree Host, plus Google's sign-in when Firebase is
  on; each page's own inline scripts are allowed by their exact hash), `X-Frame-Options: DENY` and
  `frame-ancestors 'none'` against clickjacking, `nosniff`, and no referrer.
- **No server banner:** Node sends none, and `deploy/Caddyfile` removes Caddy's (`-Server`). There are no directory
  listings, and paths outside the site's files are refused.
- **Input checks:** every form and API request is size-limited and validated on the server; text shown in pages is
  escaped.
- **Cloud WAF:** put the **website** (treehost.online) behind Cloudflare's proxy (orange cloud) once you launch, then set
  `TREEHOST_TRUST_CLOUDFLARE=1`. Keep `play.` and the game ports DNS-only (grey cloud): Cloudflare's free plan doesn't
  proxy Minecraft. Leave `TREEHOST_TRUST_CLOUDFLARE=0` otherwise, or visitors could fake their IP to dodge sign-in limits.

### Minecraft servers (built in)

- **One container per server:** hard memory and swap limits, a CPU limit and a process limit (stops fork bombs and
  runaway loops), all Linux capabilities dropped, `no-new-privileges`, a read-only system, and it runs as an unprivileged
  user (never root). Only that server's own folder is mounted. Don't turn isolation off on a public host.
- **Tree Host itself runs as the `treehost` user**, not root, with systemd hardening (`NoNewPrivileges`,
  `ProtectSystem`, `ProtectHome`, `PrivateTmp`).
- **Disk:** each plan has a disk limit, checked every few minutes; a server over it is stopped until it's cleaned up.
- **Files stay inside the server folder:** the file manager refuses `../` paths and never follows links; world uploads
  refuse unsafe paths, skip links, never write through a link, and can't unpack to more than they claim.
- **Console commands** go to the Minecraft console only (never a system shell), one line at a time with control
  characters removed, so a command can't smuggle in another.
- **Jar scanning:** uploaded plugin and mod jars (and jars bundled inside them) are checked for known Minecraft malware
  (fractureiser, Skyrage) before they're installed. A match is refused, logged, and the team gets a notification.
- **Random ports:** new servers get a random free port from the range, not the next one in line.

### The machine (you set up)

- Use SSH keys and disable password login (`PasswordAuthentication no` in `/etc/ssh/sshd_config`).
- **Automatic security updates:** `install.sh` turns on Ubuntu's unattended-upgrades (no automatic reboots). Reboot
  for kernel updates during a quiet hour; Tree Host starts every server again afterwards.
- **Off-site backups:** backups run every night, but a copy on the same machine doesn't survive the machine. Set
  `TREEHOST_BACKUP_RSYNC` in `/etc/tree-host.env` (e.g. a Hetzner Storage Box) so each one is also copied elsewhere.
  Customer and billing records are also in Firebase, which is separate from the machine.
- **Game DDoS protection:** OVH's game firewall filters attacks on the Minecraft ports before they reach the machine
  (turn on the game profile for the port range). TCPShield or Cloudflare Spectrum can sit in front later if attacks
  outgrow it.
- Never share `/etc/tree-host.env` or `/etc/tree-host-firebase.json`: they hold your Stripe, email and Firebase keys.
- Keep the Realtime Database rules locked (`.read`/`.write` false). Test-mode rules would let anyone read every account.

### When Tree Host grows past one machine (later)

At launch the website and the Minecraft servers share one machine, with the servers in locked-down containers. When a
second machine is added for game servers, keep the website on its own machine and make the game machines take orders
only from it:

- the game machine's API answers only the website's IP address (firewall allow-list), over mutual TLS (both sides prove
  who they are with certificates);
- requests carry short-lived signed tokens, so a captured one can't be replayed;
- disk I/O limits per container (`--device-read-bps`/`--device-write-bps` for the data disk) once servers share disks
  with other customers' heavy workloads.

---

## 11. Troubleshooting the machine

**The website doesn't load / no padlock**
Check the DNS records point at the server (`ping treehost.online`), then `sudo systemctl status caddy tree-host` and
`journalctl -u caddy -n 50`. Caddy can only get a certificate when the domain already points at the server and ports
80 and 443 are open.

**Players can't reach any server**
Check the `play` DNS record (and that it's **DNS only** if you use Cloudflare), and that the port range from
`TREEHOST_PORTS` is open in the firewall (`sudo ufw status`) and in your provider's firewall, if it has one.

**Payments don't activate plans**
Stripe → Developers → Webhooks → your endpoint → look for failed deliveries. Usually `STRIPE_WEBHOOK_SECRET` is wrong
or missing. Fix it in `/etc/tree-host.env`, restart, and click **Resend** on the failed events.

**"Docker was not found: customer servers will not start"**
Docker isn't running: `sudo systemctl start docker`, then `sudo systemctl restart tree-host`.

**Plans show "Sold out"**
All memory is sold. Raise **capacity** (Staff Console → Plans) only if the machine really has the memory, or rent a bigger server.
