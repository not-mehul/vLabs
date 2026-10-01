#!/usr/bin/env bash
# vLabs — one-shot bare-metal install on a Raspberry Pi (64-bit Raspberry Pi
# OS / Debian 12+). Idempotent: safe to re-run after changing answers.
#
#   sudo apt install -y git
#   sudo git clone https://github.com/not-mehul/vLabs.git /opt/vlabs
#   sudo /opt/vlabs/deploy/pi/install.sh
#
# What it sets up
#   /opt/vlabs            the git checkout (owned by the admin who ran sudo)
#   /etc/vlabs/vlabs.env  production configuration + generated secrets (0640)
#   /var/lib/vlabs        SQLite database and backups (vlabs user)
#   vlabs.service         Node 22 on 127.0.0.1:4000 (systemd, hardened)
#   caddy.service         HTTPS on :443 with Caddy's internal CA, proxying to Node
#   vlabs-backup.timer    nightly consistent SQLite backup
#
# Non-interactive use: pre-set any of these in the environment.
#   VLABS_HOSTNAME=vlabs            mDNS name → https://vlabs.local
#   VLABS_EXTRA_ADDRESSES="192.168.1.50"   extra names/IPs for the certificate
#   VLABS_SET_HOSTNAME=yes          rename the Pi to $VLABS_HOSTNAME
#   SEED_INSTRUCTOR_PASSWORD=…      first-login password (generated if empty)
#   VLABS_SKIP_BUILD=no             set yes to skip npm ci / vite build
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_DIR=/etc/vlabs
ENV_FILE=$ENV_DIR/vlabs.env
DATA_DIR=/var/lib/vlabs
PUBLIC_DIR=/srv/vlabs-public
SERVICE_USER=vlabs

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
ask() { # ask VAR "prompt" "default"
  local var=$1 prompt=$2 default=${3:-}
  if [[ -n "${!var:-}" ]]; then return; fi
  if [[ -t 0 ]]; then
    read -r -p "$prompt [${default}]: " reply
    printf -v "$var" '%s' "${reply:-$default}"
  else
    printf -v "$var" '%s' "$default"
  fi
}

[[ $EUID -eq 0 ]] || die "run with sudo"
[[ "$(uname -m)" == "aarch64" ]] || die "64-bit OS required (uname -m = $(uname -m)). Reflash with Raspberry Pi OS 64-bit."
# vlabs.service uses ProtectHome=true, so a checkout under /home is invisible to it.
[[ "$REPO_DIR" != /home/* && "$REPO_DIR" != /root/* ]] || die "clone outside /home (e.g. /opt/vlabs); the hardened unit cannot see $REPO_DIR"
ADMIN_USER="${SUDO_USER:-root}"

# ---------------------------------------------------------------------------
bold "1/8  Questions"
ask VLABS_HOSTNAME "Hostname participants will type (https://<name>.local)" "vlabs"
ask VLABS_EXTRA_ADDRESSES "Extra names or IPs for the certificate (space separated, optional)" ""
ask VLABS_SET_HOSTNAME "Set this Pi's hostname to '$VLABS_HOSTNAME' so .local resolves? (yes/no)" "yes"
ask VLABS_SKIP_BUILD "Skip npm install + client build? (yes/no)" "no"

# ---------------------------------------------------------------------------
bold "2/8  System packages (Node 22, Caddy, avahi, sqlite3 CLI)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl gnupg git avahi-daemon sqlite3 \
  debian-keyring debian-archive-keyring apt-transport-https >/dev/null

if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]]; then
  echo "  installing Node.js 22 from NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "  node $(node -v), npm $(npm -v)"

if ! command -v caddy >/dev/null; then
  echo "  installing Caddy from the official apt repository"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi
echo "  $(caddy version | head -1)"

# ---------------------------------------------------------------------------
bold "3/8  Users, directories, permissions"
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR" "$DATA_DIR/backups"
install -d -m 0755 "$PUBLIC_DIR"
# The access log in the Caddyfile is written by the caddy user.
install -d -m 0755 -o caddy -g caddy /var/log/caddy
install -d -m 0750 -o root -g "$SERVICE_USER" "$ENV_DIR"
# The checkout belongs to the admin (git pull / npm without root); the service
# only needs to read it.
chown -R "$ADMIN_USER":"$ADMIN_USER" "$REPO_DIR"
chmod -R o+rX "$REPO_DIR"
git config --global --add safe.directory "$REPO_DIR" 2>/dev/null || true

if [[ "$VLABS_SET_HOSTNAME" == "yes" && "$(hostname)" != "$VLABS_HOSTNAME" ]]; then
  hostnamectl set-hostname "$VLABS_HOSTNAME"
  sed -i "s/127\.0\.1\.1.*/127.0.1.1\t$VLABS_HOSTNAME/" /etc/hosts
  systemctl restart avahi-daemon
  echo "  hostname set to $VLABS_HOSTNAME (mDNS: $VLABS_HOSTNAME.local)"
fi

# ---------------------------------------------------------------------------
bold "4/8  Configuration → $ENV_FILE"
if [[ -f "$ENV_FILE" ]]; then
  echo "  keeping existing $ENV_FILE (delete it to regenerate secrets)"
else
  seed_pw="${SEED_INSTRUCTOR_PASSWORD:-$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)}"
  umask 027
  cat > "$ENV_FILE" <<EOF
# vLabs production configuration (generated by deploy/pi/install.sh on $(date -I)).
# Loaded by systemd (EnvironmentFile=). After editing: sudo systemctl restart vlabs
NODE_ENV=production
HOST=127.0.0.1
PORT=4000
DB_PATH=$DATA_DIR/vlabs.sqlite

# Caddy is the single reverse-proxy hop; it terminates TLS.
TRUST_PROXY=1
SERVE_PLAIN_HTTP=false
CORS_ORIGINS=

# Distinct random secrets (>= 32 chars). Rotating them signs everyone out.
JWT_INSTRUCTOR_SECRET=$(openssl rand -hex 32)
JWT_PARTICIPANT_SECRET=$(openssl rand -hex 32)

# Used only on the very first start (empty instructors table). Change the
# password in the portal afterwards (Account → Change password).
SEED_INSTRUCTOR_USERNAME=instructor
SEED_INSTRUCTOR_PASSWORD=$seed_pw

LOG_LEVEL=info
LOG_FORMAT=pretty
EXPIRED_SESSION_GRACE_MINUTES=60
EOF
  chown root:"$SERVICE_USER" "$ENV_FILE"; chmod 0640 "$ENV_FILE"
  echo "  generated secrets; first-login password for 'instructor': $seed_pw"
  echo "  (also stored in $ENV_FILE — change it in the portal after first login)"
fi

# ---------------------------------------------------------------------------
bold "5/8  Install dependencies and build the client"
if [[ "$VLABS_SKIP_BUILD" != "yes" ]]; then
  # Vite on a Pi 4 needs a bit of headroom; this also keeps npm's cache out of /root.
  sudo -u "$ADMIN_USER" -H env NODE_OPTIONS=--max-old-space-size=1024 bash -c "
    set -e; cd '$REPO_DIR'
    echo '  server: npm ci --omit=dev'; (cd server && npm ci --omit=dev --no-audit --no-fund)
    echo '  client: npm ci && vite build (a few minutes on a Pi 4)'
    (cd client && npm ci --no-audit --no-fund && npm run build)
  "
fi
[[ -f "$REPO_DIR/client/dist/index.html" ]] || die "client/dist missing — build failed or VLABS_SKIP_BUILD=yes on a fresh install"

# ---------------------------------------------------------------------------
bold "6/8  Caddy → /etc/caddy/Caddyfile"
https_sites="https://$VLABS_HOSTNAME.local"; http_sites="http://$VLABS_HOSTNAME.local"
for a in $VLABS_EXTRA_ADDRESSES; do
  https_sites+=", https://$a"; http_sites+=", http://$a"
done
sed -e "s|__HTTPS_SITES__|$https_sites|" -e "s|__HTTP_SITES__|$http_sites|" \
  "$REPO_DIR/deploy/pi/Caddyfile.template" > /etc/caddy/Caddyfile
caddy fmt --overwrite /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile >/dev/null
echo "  sites: $https_sites"

# ---------------------------------------------------------------------------
bold "7/8  systemd units"
install -m 0644 "$REPO_DIR/deploy/pi/vlabs.service" /etc/systemd/system/vlabs.service
install -m 0644 "$REPO_DIR/deploy/pi/vlabs-backup.service" /etc/systemd/system/vlabs-backup.service
install -m 0644 "$REPO_DIR/deploy/pi/vlabs-backup.timer" /etc/systemd/system/vlabs-backup.timer
# Point the backup unit at the real checkout location (it may not be /opt/vlabs).
sed -i "s|/opt/vlabs|$REPO_DIR|g" /etc/systemd/system/vlabs.service /etc/systemd/system/vlabs-backup.service
systemctl daemon-reload
systemctl enable --now caddy vlabs vlabs-backup.timer >/dev/null
systemctl restart caddy vlabs

echo -n "  waiting for the API"
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4000/api/health >/dev/null 2>&1; then echo " — up"; break; fi
  echo -n "."; sleep 1
done
curl -fsS http://127.0.0.1:4000/api/health >/dev/null || { journalctl -u vlabs -n 30 --no-pager; die "vlabs did not come up"; }

# ---------------------------------------------------------------------------
bold "8/8  Root certificate"
"$REPO_DIR/deploy/pi/export-root-cert.sh" || echo "  (run deploy/pi/export-root-cert.sh again once Caddy has created its CA)"

ip=$(hostname -I 2>/dev/null | awk '{print $1}')
cat <<EOF

Done.
  Participants  : https://$VLABS_HOSTNAME.local  ${ip:+(or https://$ip if you listed it)}
  Root cert     : http://$VLABS_HOSTNAME.local/vlabs-root.crt  (install once per device)
  Instructor    : username 'instructor', password in $ENV_FILE
  Logs          : sudo journalctl -u vlabs -f      sudo journalctl -u caddy -f
  Update        : sudo $REPO_DIR/deploy/pi/update.sh
  Add instructor: sudo -u vlabs node $REPO_DIR/server/scripts/instructors.js create <name>
EOF
