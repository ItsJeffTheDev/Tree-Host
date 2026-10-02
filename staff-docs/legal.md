# Legal: providers and DPA

Staff only. The public Privacy page describes these providers by what they do; this page names them. Send the list or the
DPA below when a customer asks (support@ or billing@). **Have a lawyer check the DPA before you first sign one.**

---

## Subprocessors (the providers that handle customer data)

| Provider | What for | Data it gets | Where |
|---|---|---|---|
| Google Firebase (Authentication, Realtime Database) | Sign-in, account and server records | Email, username, sign-in details, account data | USA |
| Stripe | Payments, invoices, the billing portal | Name, email, card (Stripe holds the card, we never see it), billing address, IP | USA / EU |
| Resend | Service emails (welcome, receipts, resets, moderation) | Email address, email content | USA |
| The server host (OVH, or netcup) | Runs the website and every Minecraft server | Everything stored on the machine, including worlds and logs | The machine's region |
| Cloudflare (once the website is behind it) | DNS, DDoS protection for the website | IP addresses, request details | Global |
| Discord (only if staff alerts are on) | Staff notifications | Usernames and event text in alerts | USA |

Rules:

- Before adding a provider that handles customer data, add it here, update the date below, and email customers who have
  signed the DPA **30 days before** it starts.
- Each provider's own DPA must be accepted in its dashboard (Firebase/Google Cloud, Stripe, Resend and OVH offer them online).
  Keep a note of the date you accepted each one:

| Provider | DPA accepted on | By |
|---|---|---|
| Google Cloud / Firebase | | |
| Stripe | | |
| Resend | | |
| Server host | | |
| Cloudflare | | |

List last changed: October 2, 2026.

---

## Customer DPA (template)

For customers who are businesses or organizations and run servers with their players' data (for example a community with
an EU audience). Fill in the brackets and send as a PDF; both sides sign.

**Data Processing Agreement** between [Customer name, address] ("Controller") and [TREEHOST_COMPANY, address] ("Processor"),
under the Tree Host Terms of Service.

1. **Subject.** The Processor hosts the Controller's Minecraft servers. In doing so it processes personal data of the
   Controller's players (Minecraft usernames and UUIDs, IP addresses in server logs, chat logs, and anything the
   Controller's plugins store) only to provide the hosting, for the length of the Controller's plan, plus 14 days.
2. **Instructions.** The Processor processes the data only on the Controller's documented instructions (the Terms, this
   agreement and the Controller's use of the dashboard), unless the law requires otherwise, in which case it tells the
   Controller first where allowed.
3. **Confidentiality.** Everyone at the Processor who can access the data is bound to confidentiality.
4. **Security.** Each server runs in its own isolated container; access to the dashboard is authenticated and staff access is
   role-based and logged; data in transit uses TLS; backups are taken regularly.
5. **Subprocessors.** The Controller agrees to the subprocessors listed above. The Processor gives 30 days' notice of
   new ones; the Controller may object, and if no solution is found may end its plan with a pro-rata refund of prepaid fees.
   The Processor imposes the same data protection duties on each subprocessor.
6. **Help with requests.** The Processor helps the Controller answer data subject requests (access, deletion and so on),
   with the tools in the dashboard (file access, deletion) or on request.
7. **Breaches.** The Processor tells the Controller without undue delay, and within 48 hours, after becoming aware of a
   personal data breach affecting the Controller's data, with what is known.
8. **Deletion.** When the plan ends the data is deleted after 14 days, unless the Controller downloads it first or the law
   requires keeping it.
9. **Audits.** The Processor makes available the information needed to show compliance, and answers reasonable written
   questions once a year.
10. **International transfers.** Where data goes outside the EEA/UK, the parties rely on the European Commission's Standard
    Contractual Clauses (module 2 or 3, as applicable) and the UK Addendum, which are part of this agreement by reference.
11. **Liability** follows the Terms of Service.

Signed for the Controller: ______________ Date: ________

Signed for the Processor: ______________ Date: ________
