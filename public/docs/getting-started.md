# Getting started

Honey Host is Honey Pixel Studios' Minecraft test server platform. You can create test servers of any type and
version, deploy your plugin from your build, and test it with the rest of the team from anywhere.

This guide gets you from "I have a link" to "I'm in the game" in about 10 minutes.

---

## 1. Get an account

Open the Honey Host dashboard:

**<https://honey-host.tail6a10e2.ts.net>**

It works from anywhere and never changes, so bookmark it. (On the host PC's own network, the admin can also give you a
local link like `http://SPAREPC:8766`.)

There are two ways in:

**A. You got an invite link** (it contains `?invite=`)

1. Open the invite link.
2. Choose a **username** (3-32 characters) and a **password** (8+ characters).
3. Enter your **Minecraft username** (your in-game name, exactly as it appears in Minecraft).
4. Click **Create account**. You're in.

**B. You only have the dashboard link**

1. Open the link and click **Request access** under the sign-in button.
2. Fill in username, password and your Minecraft username, then click **Request access**.
3. You'll see **Waiting for approval**. Leave the page open: it opens the dashboard automatically as soon as an
   admin approves you. (You can also close it and sign in later.)

> **Note:** invite links work once and expire after 7 days. If yours doesn't work, ask for a new one.

---

## 2. Set your Minecraft name

Honey Host adds everyone's Minecraft name to the **whitelist** of the servers they're allowed on. If you skipped it
when signing up:

1. Click **Account** at the bottom of the sidebar.
2. Type your Minecraft username under **Minecraft name** and click **Save**.

You're whitelisted the next time a server starts, or right away when someone clicks **Whitelist team** in a server's
console.

---

## 3. Team and Solo servers

At the top of the sidebar there's a switch:

| | Who sees it | Who can join | Use it for |
|---|---|---|---|
| **👥 Team** | everyone on the team | everyone on the team | shared test servers, playtests, testing each other's plugins |
| **👤 Solo** | only you (and admins) | only you (you can whitelist others) | your own experiments, breaking things in peace |

New servers are created in whichever space is selected. Everyone gets their own Solo space.

---

## 4. Join a server in Minecraft

Open a server in the sidebar. The box at the top right tells you how to join.

**Through the Gateway (most servers):**

The box says **Join through the Gateway**, with an address and a command.

1. In Minecraft (Java Edition, your normal launcher and account): **Multiplayer → Add Server**.
2. Paste the **Gateway address** (click it in Honey Host to copy it). You only need to add it once: it's the same
   address for every server.
3. Join. You land on the default server.
4. Type the command shown under the address, e.g. `/server lobby-test`, to switch to the server you want.

**With its own address:** if the box shows a **Join address** instead, just add that address in Minecraft and join.

**On the same network as the host PC:** use the **Same home network** address shown in the box.


> **Tip:** the server must be **running** (green dot in the sidebar). If it's stopped, click **▶ Start** and wait until it
> says **Running**.

---

## 5. What next?

- [Servers and plugins](servers.md): create a server, install plugins, and deploy straight from your build.
- [Troubleshooting](troubleshooting.md): if something doesn't work.
- Admins: see the [Admin guide](admin-guide.md).

**House rules**

- Plugins run code on the host PC. Only deploy plugins you'd trust on your own computer.
- Stop servers you're not using: the host PC's memory is shared by everyone.
- Don't share the dashboard link or invite links outside the team.
