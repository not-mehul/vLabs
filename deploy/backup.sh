#!/usr/bin/env bash
# Consistent online backup of the vLabs database, copied out of the Docker
# volume to ./backups (point BACKUP_DIR at a USB stick / network share on the
# Pi). Add to cron, e.g. nightly at 02:30:
#   30 2 * * * /opt/vlabs/deploy/backup.sh >> /var/log/vlabs-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")"
COMPOSE="docker compose -f docker-compose.prod.yml"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP="${BACKUP_KEEP:-14}"

mkdir -p "$BACKUP_DIR"
# 1. Snapshot inside the container (SQLite backup API; safe while running).
$COMPOSE exec -T -e BACKUP_KEEP="$KEEP" vlabs node server/scripts/backup.js /app/server/data/backups
# 2. Copy the newest snapshot out of the volume.
latest=$($COMPOSE exec -T vlabs sh -c 'ls -1 /app/server/data/backups/vlabs-*.sqlite | sort | tail -n 1')
$COMPOSE cp "vlabs:${latest}" "$BACKUP_DIR/"
echo "$(date -Is) copied $(basename "$latest") to $BACKUP_DIR"
# 3. Prune host copies.
ls -1t "$BACKUP_DIR"/vlabs-*.sqlite 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

# Optional off-site copy (hosted deployment). Configure rclone first:
#   rclone copy "$BACKUP_DIR" remote:vlabs-backups --max-age 2d
