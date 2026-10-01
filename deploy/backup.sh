#!/usr/bin/env bash
# Backs up worlds, server files and settings into one archive. Runs every night (tree-host-backup.timer),
# or by hand:   sudo bash /opt/tree-host/deploy/backup.sh
#
# Copies on this machine only protect against mistakes. Set TREEHOST_BACKUP_RSYNC in /etc/tree-host.env
# (e.g. u123456@u123456.your-storagebox.de:tree-host) to also copy each archive to another machine.
set -euo pipefail

setting() { grep -E "^$1=" /etc/tree-host.env 2>/dev/null | tail -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true; }
DATA=$(setting TREEHOST_DATA); DATA=${DATA:-/var/lib/tree-host}
DEST=$(setting TREEHOST_BACKUP_DIR); DEST=${DEST:-/var/backups/tree-host}
KEEP=$(setting TREEHOST_BACKUP_KEEP); KEEP=${KEEP:-3}
REMOTE=$(setting TREEHOST_BACKUP_RSYNC)

mkdir -p "$DEST"
chmod 700 "$DEST"

# Downloaded server jars and Java runtimes come back by themselves, so they are skipped.
EXCLUDES=(--exclude="${DATA#/}/cache" --exclude="${DATA#/}/java" --exclude="${DATA#/}/client")
NEED=$(du -sm --exclude="$DATA/cache" --exclude="$DATA/java" --exclude="$DATA/client" "$DATA" 2>/dev/null | cut -f1)
FREE=$(df -Pm "$DEST" | awk 'NR==2 {print $4}')
if [ "${NEED:-0}" -gt "${FREE:-0}" ]; then
  echo "Not enough free disk for a backup (${NEED} MB needed, ${FREE} MB free). Lower TREEHOST_BACKUP_KEEP or free space." >&2
  exit 1
fi

FILES=("${DATA#/}" etc/tree-host.env)
[ -f /etc/tree-host-firebase.json ] && FILES+=(etc/tree-host-firebase.json)
OUT="$DEST/tree-host-$(date +%Y-%m-%d_%H%M).tar.gz"
# Running servers keep writing their worlds; tar exits with 1 for "file changed while reading", which is fine.
tar -czf "$OUT.part" -C / --warning=no-file-changed --warning=no-file-removed "${EXCLUDES[@]}" "${FILES[@]}" || [ $? -eq 1 ]
mv "$OUT.part" "$OUT"
chmod 600 "$OUT"
echo "Backup: $OUT ($(du -h "$OUT" | cut -f1))"

# Keep only the newest $KEEP archives here.
ls -1t "$DEST"/tree-host-*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f --

if [ -n "$REMOTE" ]; then
  rsync -a --delete -e "ssh -o BatchMode=yes" "$DEST/" "$REMOTE/"
  echo "Copied to $REMOTE"
fi
