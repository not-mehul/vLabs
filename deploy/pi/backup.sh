#!/usr/bin/env bash
# Consistent online backup of the vLabs database (SQLite backup API — safe
# while the service is running). Run nightly by vlabs-backup.timer; also fine
# to run by hand:  sudo /opt/vlabs/deploy/pi/backup.sh
#
# Snapshots land in /var/lib/vlabs/backups (pruned to BACKUP_KEEP, default 14).
# To ALSO copy the newest snapshot off the SD card, set BACKUP_DIR in
# /etc/vlabs/vlabs.env, e.g.  BACKUP_DIR=/media/usb/vlabs
set -euo pipefail
[[ $EUID -eq 0 ]] || exec sudo "$0" "$@"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE=/etc/vlabs/vlabs.env
# shellcheck disable=SC1090
[[ -f "$ENV_FILE" ]] && { set -a; . "$ENV_FILE"; set +a; }
SNAP_DIR="$(dirname "${DB_PATH:-/var/lib/vlabs/vlabs.sqlite}")/backups"
KEEP="${BACKUP_KEEP:-14}"

# 1. Snapshot as the service user (writes <SNAP_DIR>/vlabs-YYYYMMDD-HHMMSS.sqlite, prunes).
BACKUP_KEEP="$KEEP" "$REPO_DIR/deploy/pi/vlabs-cli.sh" backup "$SNAP_DIR"

# 2. Optional off-device copy.
if [[ -n "${BACKUP_DIR:-}" ]]; then
  mkdir -p "$BACKUP_DIR"
  latest=$(ls -1 "$SNAP_DIR"/vlabs-*.sqlite | sort | tail -n 1)
  cp -p "$latest" "$BACKUP_DIR/"
  echo "$(date -Is) copied $(basename "$latest") to $BACKUP_DIR"
  ls -1t "$BACKUP_DIR"/vlabs-*.sqlite 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
fi
