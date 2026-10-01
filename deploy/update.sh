#!/usr/bin/env bash
# Updates Tree Host to the newest code. Run on the server:  sudo bash /opt/tree-host/deploy/update.sh
# Running Minecraft servers are stopped cleanly and servers set to "Start automatically" come back.
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo: sudo bash $0"; exit 1; fi
cd /opt/tree-host

if ! sudo -u treehost git pull --ff-only; then
  echo ""
  echo "Couldn't download the update. If GitHub asked for a password, set up a deploy key once:"
  echo "  sudo bash /opt/tree-host/deploy/deploy-key.sh"
  exit 1
fi

cp deploy/tree-host.service deploy/tree-host-backup.service deploy/tree-host-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --quiet tree-host-backup.timer
if ! cmp -s deploy/Caddyfile /etc/caddy/Caddyfile; then
  cp deploy/Caddyfile /etc/caddy/Caddyfile
  systemctl reload caddy
fi
systemctl restart tree-host
echo "Updated to $(git log -1 --format='%h %s')"
