#!/usr/bin/env bash
# Lets this server pull updates from the private GitHub repo without typing a token every time.
# Run once:   sudo bash /opt/tree-host/deploy/deploy-key.sh
# It makes a read-only key for the treehost user and switches the repo to SSH.
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo: sudo bash $0"; exit 1; fi

APP=/opt/tree-host
KEY=/home/treehost/.ssh/id_ed25519
sudo -u treehost mkdir -p -m 700 /home/treehost/.ssh
[ -f "$KEY" ] || sudo -u treehost ssh-keygen -q -t ed25519 -N "" -C "tree-host@$(hostname)" -f "$KEY"
sudo -u treehost sh -c 'ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null; sort -u -o ~/.ssh/known_hosts ~/.ssh/known_hosts'

# https://github.com/owner/repo(.git) -> git@github.com:owner/repo.git
URL=$(sudo -u treehost git -C "$APP" remote get-url origin)
SSH_URL=$(echo "$URL" | sed -E 's#^https://github\.com/([^/]+)/([^/.]+)(\.git)?/?$#git@github.com:\1/\2.git#')
sudo -u treehost git -C "$APP" remote set-url origin "$SSH_URL"

echo ""
echo "1. On GitHub open the repo → Settings → Deploy keys → Add deploy key."
echo "   Title: $(hostname). Leave \"Allow write access\" OFF. Paste this key:"
echo ""
cat "$KEY.pub"
echo ""
echo "2. Then test it:   sudo -u treehost git -C $APP fetch && echo works"
