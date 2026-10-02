#!/usr/bin/env bash
# Remove everything deploy/pi/install.sh put on this Pi. The reverse of the
# installer, in reverse order: services → config → data → user → Caddy site.
#
#   sudo /opt/vlabs/deploy/pi/uninstall.sh                # interactive
#   sudo /opt/vlabs/deploy/pi/uninstall.sh --yes          # no prompts, keeps a DB backup
#   sudo /opt/vlabs/deploy/pi/uninstall.sh --yes --purge  # also apt-purge Caddy + Node
#
# What is removed
#   vlabs.service, vlabs-backup.{service,timer}   (disabled, files deleted)
#   /etc/vlabs            configuration + generated secrets
#   /var/lib/vlabs        SQLite database, uploaded images, backups  ← your data
#   /srv/vlabs-public     published root certificate
#   /etc/caddy/Caddyfile  replaced by Caddy's stock default; Caddy's internal CA
#                         is deleted so a reinstall issues a fresh root certificate
#   the 'vlabs' system user
#   the checkout itself (the directory this script lives in), last
#
# Before deleting /var/lib/vlabs a final database snapshot is copied to
# /root/vlabs-final-<timestamp>.sqlite unless --no-backup is given, so a
# "remove and reinstall" never silently throws away a class's results.
#
# Not removed unless --purge: Node.js, Caddy and their apt repositories, Avahi.
# A fresh install.sh reuses them. The hostname is left as it is.
set -euo pipefail
[[ $EUID -eq 0 ]] || exec sudo "$0" "$@"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE=/etc/vlabs/vlabs.env
DATA_DIR=/var/lib/vlabs
PUBLIC_DIR=/srv/vlabs-public
SERVICE_USER=vlabs
YES=no; PURGE=no; BACKUP=yes
for arg in "$@"; do
  case "$arg" in
    --yes|-y) YES=yes ;;
    --purge) PURGE=yes ;;
    --no-backup) BACKUP=no ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
confirm() {
  [[ "$YES" == yes ]] && return 0
  read -r -p "$1 [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

# Prefer the DB path the running config points at; fall back to the default.
DB_PATH=$DATA_DIR/vlabs.sqlite
if [[ -f "$ENV_FILE" ]]; then
  DB_PATH="$(grep -E '^DB_PATH=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
  DB_PATH="${DB_PATH:-$DATA_DIR/vlabs.sqlite}"
fi

cat <<EOF
This will remove vLabs from this machine:
  services   vlabs, vlabs-backup.timer
  config     /etc/vlabs  (secrets, instructor bootstrap password)
  data       $DATA_DIR  (database, images, backups)$( [[ "$BACKUP" == yes ]] && echo "  → final snapshot kept in /root" )
  web        $PUBLIC_DIR, /etc/caddy/Caddyfile (reset to stock), Caddy internal CA
  user       $SERVICE_USER
  checkout   $REPO_DIR
  packages   $( [[ "$PURGE" == yes ]] && echo "Caddy, Node.js and their apt repos (--purge)" || echo "kept (pass --purge to remove Caddy + Node)" )
EOF
confirm "Continue?" || { echo "aborted"; exit 1; }

# ---------------------------------------------------------------------------
bold "1/6  Final database snapshot"
if [[ "$BACKUP" == yes && -f "$DB_PATH" ]]; then
  stamp=$(date +%Y%m%d-%H%M%S)
  dest="/root/vlabs-final-$stamp.sqlite"
  if command -v sqlite3 >/dev/null; then
    # Online, consistent copy (works even if the service is still running).
    sqlite3 "$DB_PATH" ".backup '$dest'"
  else
    systemctl stop vlabs 2>/dev/null || true
    cp -p "$DB_PATH" "$dest"
  fi
  chmod 0600 "$dest"
  echo "  saved $dest ($(du -h "$dest" | cut -f1)) — delete it yourself when you no longer need it"
else
  echo "  skipped"
fi

# ---------------------------------------------------------------------------
bold "2/6  Services"
systemctl disable --now vlabs.service vlabs-backup.timer 2>/dev/null || true
systemctl stop vlabs-backup.service 2>/dev/null || true
rm -f /etc/systemd/system/vlabs.service \
      /etc/systemd/system/vlabs-backup.service \
      /etc/systemd/system/vlabs-backup.timer
systemctl daemon-reload
systemctl reset-failed vlabs.service vlabs-backup.service 2>/dev/null || true
echo "  vlabs units removed"

# ---------------------------------------------------------------------------
bold "3/6  Caddy site"
if command -v caddy >/dev/null; then
  systemctl stop caddy 2>/dev/null || true
  # Put back the package's default Caddyfile (a static "Caddy works" page) so
  # Caddy itself stays healthy if it is kept; drop our access log and the
  # internal CA so a reinstall mints a fresh root certificate.
  if [[ -f /usr/share/caddy/Caddyfile ]]; then
    cp /usr/share/caddy/Caddyfile /etc/caddy/Caddyfile
  else
    printf ':80 {\n\trespond "Caddy is installed but no site is configured." 200\n}\n' > /etc/caddy/Caddyfile
  fi
  rm -f /var/log/caddy/vlabs-access.log*
  rm -rf /var/lib/caddy/.local/share/caddy/pki /var/lib/caddy/.local/share/caddy/certificates
  if [[ "$PURGE" != yes ]]; then
    systemctl start caddy 2>/dev/null || true
  fi
  echo "  Caddyfile reset, vLabs certificates and CA removed"
fi
rm -rf "$PUBLIC_DIR"

# ---------------------------------------------------------------------------
bold "4/6  Config, data, user"
rm -rf /etc/vlabs "$DATA_DIR"
if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  userdel "$SERVICE_USER" 2>/dev/null || true
  echo "  user $SERVICE_USER removed"
fi
echo "  /etc/vlabs and $DATA_DIR removed"

# ---------------------------------------------------------------------------
bold "5/6  Packages"
if [[ "$PURGE" == yes ]]; then
  export DEBIAN_FRONTEND=noninteractive
  systemctl disable --now caddy 2>/dev/null || true
  apt-get purge -y -qq caddy nodejs >/dev/null 2>&1 || true
  rm -f /etc/apt/sources.list.d/caddy-stable.list /etc/apt/sources.list.d/nodesource.list \
        /usr/share/keyrings/caddy-stable-archive-keyring.gpg /usr/share/keyrings/nodesource.gpg \
        /etc/apt/keyrings/nodesource.gpg
  rm -rf /var/lib/caddy /var/log/caddy /etc/caddy
  apt-get autoremove -y -qq >/dev/null 2>&1 || true
  echo "  Caddy and Node.js purged"
else
  echo "  kept Caddy and Node.js (use --purge to remove)"
fi

# ---------------------------------------------------------------------------
bold "6/6  Checkout"
# Only remove the checkout if it looks like ours, and do it last — this script
# is running from inside it (bash has the file open, so deleting it is safe).
if [[ -f "$REPO_DIR/deploy/pi/install.sh" && -f "$REPO_DIR/server/src/index.js" ]]; then
  if confirm "Delete the checkout at $REPO_DIR?"; then
    cd /
    rm -rf "$REPO_DIR"
    echo "  $REPO_DIR removed"
  else
    echo "  kept $REPO_DIR"
  fi
else
  echo "  $REPO_DIR does not look like a vLabs checkout — left alone"
fi

echo
echo "vLabs has been removed. Reinstall with:"
echo "  sudo git clone https://github.com/not-mehul/vLabs.git /opt/vlabs && sudo /opt/vlabs/deploy/pi/install.sh"
