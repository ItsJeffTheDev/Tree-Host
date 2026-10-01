#!/usr/bin/env bash
# Updates Tree Host to the newest code. Run on the server:  sudo bash /opt/tree-host/deploy/update.sh
# Running Minecraft servers are stopped cleanly and servers set to "Start automatically" come back.
set -euo pipefail
cd /opt/tree-host
sudo -u treehost git pull --ff-only
cp deploy/tree-host.service /etc/systemd/system/tree-host.service
systemctl daemon-reload
systemctl restart tree-host
echo "Updated to $(git log -1 --format='%h %s')"
