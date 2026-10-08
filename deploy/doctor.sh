#!/usr/bin/env bash
# Checks that everything Tree Host needs is in place, and says what to fix.
# Run on the server any time:   sudo bash /opt/tree-host/deploy/doctor.sh
set -uo pipefail

ENV_FILE=/etc/tree-host.env
ok=0; warn=0; bad=0
pass() { echo "  [ OK ] $*"; ok=$((ok + 1)); }
note() { echo "  [WARN] $*"; warn=$((warn + 1)); }
fail() { echo "  [FAIL] $*"; bad=$((bad + 1)); }
setting() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo: sudo bash $0"; exit 1; fi

echo "Services"
for s in docker tree-host caddy; do
  if systemctl is-active --quiet "$s"; then pass "$s is running"; else fail "$s is not running (see: journalctl -u $s -n 50)"; fi
done

echo "Settings ($ENV_FILE)"
if [ ! -f "$ENV_FILE" ]; then fail "$ENV_FILE is missing: run deploy/install.sh"; fi
PUBLIC_URL=$(setting TREEHOST_PUBLIC_URL)
DOMAIN=$(echo "$PUBLIC_URL" | sed -E 's#^https?://##; s#[/:].*$##')
GAME_HOST=$(setting TREEHOST_GAME_HOST)
PORT=$(setting TREEHOST_PORT); PORT=${PORT:-8766}
[ -n "$PUBLIC_URL" ] && pass "website address: $PUBLIC_URL" || fail "TREEHOST_PUBLIC_URL is empty"
[ -n "$(setting TREEHOST_ADMIN_EMAILS)" ] && pass "admin email set" || fail "TREEHOST_ADMIN_EMAILS is empty: nobody can become admin"
[ -n "$GAME_HOST" ] && pass "players join at: $GAME_HOST" || fail "TREEHOST_GAME_HOST is empty"
[ "$(setting BILLING_DEMO)" = "1" ] && note "BILLING_DEMO=1: plans are free. Set it to 0 before launch."
case "$(setting STRIPE_SECRET_KEY)" in
  sk_live_*) pass "Stripe: live mode" ;;
  sk_test_*) note "Stripe: test mode (switch to live keys at launch)" ;;
  rk_*) pass "Stripe: restricted key" ;;
  "") note "STRIPE_SECRET_KEY is empty: plans can't be bought yet" ;;
  *) fail "STRIPE_SECRET_KEY doesn't look like a Stripe key" ;;
esac
if [ -n "$(setting STRIPE_SECRET_KEY)" ] && [ -z "$(setting STRIPE_WEBHOOK_SECRET)" ]; then
  fail "STRIPE_WEBHOOK_SECRET is empty: paid plans will never activate"
fi
FB=$(setting FIREBASE_SERVICE_ACCOUNT_FILE)
if [ -n "$FB" ] && [ -f "$FB" ]; then
  [ "$(stat -c %a "$FB")" = "640" ] && pass "Firebase key file present and locked down" || note "fix permissions: chown root:treehost $FB && chmod 640 $FB"
else
  note "no Firebase service account key at ${FB:-(not set)}: accounts are only stored on this machine"
fi
[ -n "$(setting RESEND_API_KEY)" ] || note "RESEND_API_KEY is empty: no failed-payment emails"

echo "Tree Host"
if curl -fsS -m 5 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then pass "answers on 127.0.0.1:$PORT"; else fail "not answering on 127.0.0.1:$PORT (see: journalctl -u tree-host -n 50)"; fi
if docker network inspect treehost-net >/dev/null 2>&1; then pass "Docker network treehost-net exists"; else note "Docker network treehost-net not created yet (made when the first server starts)"; fi
for v in 21 17; do docker image inspect "eclipse-temurin:$v-jre" >/dev/null 2>&1 || note "Java $v image not pulled yet (first server start will be slow)"; done

echo "DNS and HTTPS"
IP=$(curl -4 -fsS -m 5 https://api.ipify.org 2>/dev/null || true)
[ -n "$IP" ] && pass "this server's public IPv4: $IP" || note "couldn't find this server's public IP (no internet?)"
for name in "$DOMAIN" "${DOMAIN:+www.$DOMAIN}" "$GAME_HOST"; do
  [ -z "$name" ] && continue
  if [[ "$name" =~ ^[0-9.]+$ ]]; then continue; fi
  got=$(getent ahostsv4 "$name" | awk '{print $1; exit}')
  if [ -z "$got" ]; then fail "$name has no A record yet (add it at your domain's DNS settings)"
  elif [ -n "$IP" ] && [ "$got" != "$IP" ]; then
    if [ "$name" = "$GAME_HOST" ]; then fail "$name points at $got, not this server ($IP). If you use Cloudflare, set it to DNS only (grey cloud)."
    else note "$name points at $got, not $IP (fine only if it's Cloudflare's proxy and TREEHOST_TRUST_CLOUDFLARE=1)"; fi
  else pass "$name -> $got"; fi
done
if [ -n "$DOMAIN" ]; then
  if curl -fsS -m 10 "https://$DOMAIN/api/health" >/dev/null 2>&1; then pass "https://$DOMAIN works (certificate OK)"
  else fail "https://$DOMAIN doesn't load yet. Check DNS above, ports 80/443, and: journalctl -u caddy -n 50"; fi
fi

echo "Firewall"
PORTS=$(setting TREEHOST_PORTS); PORTS=${PORTS:-25600-25999}
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  for p in 80/tcp 443/tcp "${PORTS/-/:}/tcp"; do ufw status | grep -q "^$p" && pass "ufw allows $p" || fail "ufw doesn't allow $p (sudo ufw allow $p)"; done
elif [ -f /etc/iptables/rules.v4 ]; then
  pass "iptables rules file found (Oracle-style); also check the cloud provider's security list allows 80, 443 and $PORTS"
  # Oracle images reject forwarded traffic; Docker's own rules must come first or players can't connect.
  first=$(iptables -S FORWARD 2>/dev/null | grep -nE 'DOCKER|REJECT' | head -n1)
  case "$first" in *REJECT*) fail "a REJECT rule comes before Docker's rules in the FORWARD chain: restart Docker (sudo systemctl restart docker)";; esac
else
  note "no firewall found: make sure your provider only allows 22, 80, 443 and $PORTS"
fi
echo "  Remember: the cloud provider's firewall (Oracle security list, Hetzner firewall...) must allow the same ports."

echo "Machine"
MEM=$(awk '/MemTotal/ {printf "%d", $2/1048576}' /proc/meminfo)
DATA=$(setting TREEHOST_DATA); DATA=${DATA:-/var/lib/tree-host}
FREE=$( { df -BG --output=avail "$DATA" 2>/dev/null || df -BG --output=avail /; } | tail -n1 | tr -dc 0-9)
pass "memory: ${MEM} GB"
if [ -n "$FREE" ] && [ "$FREE" -lt 10 ]; then fail "only ${FREE} GB free on the disk with $DATA"; else pass "free disk: ${FREE:-?} GB"; fi
systemctl is-active --quiet tree-host-backup.timer && pass "nightly backups on" || note "nightly backups are off (sudo systemctl enable --now tree-host-backup.timer)"
grep -qE '^\s*PasswordAuthentication\s+no' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null \
  && pass "SSH password login is off" || note "SSH password login may be on: use SSH keys and set PasswordAuthentication no"

echo "Security"
if [ -n "$(setting TREEHOST_BACKUP_RSYNC)" ]; then pass "Backups are copied off this machine (TREEHOST_BACKUP_RSYNC)"
else note "Backups only stay on this machine. Set TREEHOST_BACKUP_RSYNC in $ENV_FILE to copy them to another one (e.g. a Hetzner Storage Box)"; fi
if grep -qs 'Unattended-Upgrade "1"' /etc/apt/apt.conf.d/20auto-upgrades; then pass "Security updates install automatically"
else note "Automatic security updates are off: run  sudo dpkg-reconfigure -plow unattended-upgrades"; fi
if grep -qsE '^\s*-Server' /etc/caddy/Caddyfile; then pass "The web server doesn't announce its name"
else note "Caddy announces itself in every response: add  header -Server  (see deploy/Caddyfile)"; fi

echo ""
echo "$ok OK, $warn warnings, $bad problems."
[ "$bad" -eq 0 ]

