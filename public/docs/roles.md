# Roles & permissions

Every Tree Host account has one of three roles.

| Role | Who | In short |
|---|---|---|
| **Customer** | Everyone who signs up on the website | Buys plans and fully manages **their own** servers. Can't see anyone else's. |
| **Support** | Helpers you invite | Can see and help with every server, but can't delete servers or touch billing. |
| **Admin** | You (the first account) and anyone you promote | Everything: plans and prices, billing, people, settings. |

Support staff and admins can have their own servers too: give yourself a free plan in **Admin → People**.

---

## Everything, side by side

### Servers

| | Customer | Support | Admin |
|---|:---:|:---:|:---:|
| Create servers on their own plans | ✓ | ✓ | ✓ |
| Start, stop, console, plugins, files and settings of **their own** servers | ✓ | ✓ | ✓ |
| Delete their own server, reset its world, change its version | ✓ | ✓ | ✓ |
| See and help with **everyone's** servers (console, files, plugins, settings) | | ✓ | ✓ |
| Delete someone else's server, reset its world or change its version | | | ✓ |
| See the Activity feed | own servers | ✓ | ✓ |

### People, plans and money

| | Customer | Support | Admin |
|---|:---:|:---:|:---:|
| Buy plans, manage their card, cancel | ✓ | ✓ | ✓ |
| See all customers and their plans | | | ✓ |
| Give free plans, cancel anyone's plan | | | ✓ |
| Change prices and plans, set capacity | | | ✓ |
| Change roles, suspend or delete accounts, set temporary passwords | | | ✓ |
| Invite support staff, Discord alerts, open or close sign-ups | | | ✓ |

---

## Why these rules?

- **Customers are fully separated.** Each customer only sees their own servers, and each server runs in its own
  isolated container, so one customer's plugins can't touch another customer's files.
- **Support can help, but not destroy.** Helping often means reading a console or fixing a config, so support can do
  that on any server. Deleting a world can't be undone, so only the owner or an admin can do it.
- **Money is admin-only.** Prices, free plans and cancellations affect revenue and customers' bills.

---

## Changing someone's role

**Admin → People**, then use the role dropdown next to their name. Making someone Support or Admin asks you to confirm,
because they can see every customer's server.

Add support staff with **Admin → People → Invite support staff**: it creates a one-time link valid for 7 days.

---

## Suspending or removing someone

**Admin → People → More** next to their name:

- **Suspend**: signs them out, stops their servers and blocks sign-in. Their data is kept. Use **Unsuspend** to undo.
- **Temporary password**: for people locked out without email access. Send it privately.
- **Delete account**: removes the account and its servers. Cancel any active plan first (Admin → Billing).
