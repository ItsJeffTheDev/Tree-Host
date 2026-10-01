#!/usr/bin/env bash
# Sets up Tree Host on a fresh Ubuntu 22.04 / 24.04 server.
# Run from the Tree Host folder:   sudo bash deploy/install.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo: sudo bash deploy/install.sh"; exit 1; fi
SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/tree-host
DATA=/var/lib/tree-host

echo "==> Installing packages (Docker, Node.js 22, Caddy, firewall)..."
apt-get update -y
apt-get install -y ca-certificates curl gnupg git ufw debian-keyring debian-archive-keyring apt-transport-https
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

echo "==> Creating the treehost user and folders..."
id treehost >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/treehost --shell /usr/sbin/nologin treehost
# Tree Host starts each Minecraft server as a Docker container.
usermod -aG docker treehost
mkdir -p "$APP" "$DATA"
if [ "$SRC" != "$APP" ]; then cp -a "$SRC/." "$APP/"; fi
chown -R treehost:treehost "$APP" "$DATA"
chmod 750 "$DATA"

if [ ! -f /etc/tree-host.env ]; then
  cp "$APP/deploy/tree-host.env.example" /etc/tree-host.env
  echo "    Created /etc/tree-host.env: fill in your Stripe and email keys there."
fi
chown root:treehost /etc/tree-host.env
chmod 640 /etc/tree-host.env
if [ -f /etc/tree-host-firebase.json ]; then
  chown root:treehost /etc/tree-host-firebase.json
  chmod 640 /etc/tree-host-firebase.json
else
  echo "    No /etc/tree-host-firebase.json yet: upload the Firebase service account key there (see the hosting guide)."
fi

echo "==> Firewall: SSH, web, and the Minecraft port range..."
PORTS=$(grep -E '^TREEHOST_PORTS=' /etc/tree-host.env | cut -d= -f2 | tr '-' ':')
PORTS=${PORTS:-25600:25999}
if [ -f /etc/iptables/rules.v4 ] && grep -q -- '-A INPUT -j REJECT' /etc/iptables/rules.v4; then
  # Oracle Cloud images block everything except SSH with iptables (ufw can't open ports past that rule).
  # Open our ports just before the REJECT rule, now and after reboots.
  echo "    Oracle Cloud firewall detected: opening ports with iptables."
  for spec in "80" "443" "$PORTS"; do
    rule="-p tcp -m state --state NEW -m tcp --dport $spec -j ACCEPT"
    if ! grep -q -- "-A INPUT $rule" /etc/iptables/rules.v4; then
      sed -i "0,/^-A INPUT -j REJECT/s//-A INPUT $rule
-A INPUT -j REJECT/" /etc/iptables/rules.v4
    fi
    if ! iptables -C INPUT $rule 2>/dev/null; then
      line=$(iptables -L INPUT --line-numbers | awk '$2=="REJECT"{print $1; exit}')
      iptables -I INPUT "${line:-1}" $rule
    fi
  done
  echo "    Also open the same ports in the Oracle console (Virtual Cloud Network → Security List), see the guide."
else
  ufw allow OpenSSH
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow "$PORTS/tcp"
  ufw --force enable
fi

echo "==> Pulling the Java images Minecraft servers use (a few minutes)..."
for v in 21 17 8 25; do docker pull -q "eclipse-temurin:$v-jre" || true; done

echo "==> Starting Tree Host and HTTPS..."
cp "$APP/deploy/tree-host.service" /etc/systemd/system/tree-host.service
cp "$APP/deploy/Caddyfile" /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable --now tree-host
systemctl reload caddy || systemctl restart caddy

sleep 4
echo ""
echo "Done! Tree Host is running."
echo "  Website:     $(grep -E '^TREEHOST_PUBLIC_URL=' /etc/tree-host.env | cut -d= -f2)"
echo "  Admin:       sign up with the email in TREEHOST_ADMIN_EMAILS (in /etc/tree-host.env) to become the admin."
echo "  Logs:        journalctl -u tree-host -f"
