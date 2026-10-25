#!/usr/bin/env bash
# Update a running Pi to the latest main: backup → git pull → install → build →
# restart → health check. Rolls the code back if the new version fails to boot,
# and restores the backup too when the new version had already migrated the
# database (an older vLabs refuses to start on a newer schema).
#
#   sudo /opt/vlabs/deploy/pi/update.sh            # pull origin/<current branch>
#   sudo /opt/vlabs/deploy/pi/update.sh v1.3.0     # or any ref/tag/branch
#
# Do this between classes: the restart signs nobody out (tokens are stateless
# and the session table persists) but the app is unavailable for ~5 seconds.
set -euo pipefail
[[ $EUID -eq 0 ]] || exec sudo "$0" "$@"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ADMIN_USER="$(stat -c %U "$REPO_DIR")"
TARGET_REF="${1:-}"

as_admin() { sudo -u "$ADMIN_USER" -H env NODE_OPTIONS=--max-old-space-size=1024 bash -c "set -e; cd '$REPO_DIR'; $*"; }
bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
healthy() {
  for _ in $(seq 1 30); do
    curl -fsS http://127.0.0.1:4000/api/health >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

DB_FILE="$( (set -a; [[ -f /etc/vlabs/vlabs.env ]] && . /etc/vlabs/vlabs.env; echo "${DB_PATH:-/var/lib/vlabs/vlabs.sqlite}") )"
schema_version() { sqlite3 -readonly "$DB_FILE" 'PRAGMA user_version;' 2>/dev/null || echo unknown; }

cd "$REPO_DIR"
before=$(git rev-parse HEAD)

bold "1/5  Backup"
"$REPO_DIR/deploy/pi/backup.sh"
BACKUP_FILE="$(ls -1 "$(dirname "$DB_FILE")"/backups/vlabs-*.sqlite 2>/dev/null | sort | tail -n 1 || true)"
SCHEMA_BEFORE="$(schema_version)"
echo "  database schema $SCHEMA_BEFORE, backup ${BACKUP_FILE:-missing}"

bold "2/5  Fetch"
as_admin "git fetch --tags --prune origin"
if [[ -n "$TARGET_REF" ]]; then
  as_admin "git checkout --quiet '$TARGET_REF'"
  as_admin "git merge --ff-only 'origin/$TARGET_REF' 2>/dev/null || true"
else
  if ! git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
    echo "  HEAD has no upstream (pinned to a tag?). Pass a branch or tag: update.sh main" >&2
    exit 1
  fi
  as_admin "git merge --ff-only '@{u}'"
fi
after=$(git rev-parse HEAD)
if [[ "$before" == "$after" ]]; then
  echo "  already at $(git describe --tags --always) — nothing to update"
  exit 0
fi
echo "  $(git log --oneline "$before".."$after" | wc -l) new commit(s): ${before:0:7} → ${after:0:7}"

bold "3/5  Install + build"
as_admin "(cd server && npm ci --omit=dev --no-audit --no-fund)"
as_admin "(cd client && npm ci --no-audit --no-fund && npm run build)"
chmod -R o+rX "$REPO_DIR"
runuser -u vlabs -- test -r "$REPO_DIR/server/node_modules/express/package.json" \
  || { echo "server dependencies missing/unreadable after install — aborting before restart" >&2; exit 1; }

bold "4/5  Refresh systemd units (in case they changed)"
install -m 0644 deploy/pi/vlabs.service /etc/systemd/system/vlabs.service
install -m 0644 deploy/pi/vlabs-backup.service /etc/systemd/system/vlabs-backup.service
install -m 0644 deploy/pi/vlabs-backup.timer /etc/systemd/system/vlabs-backup.timer
install -m 0644 deploy/pi/vlabs-caddy-refresh.service /etc/systemd/system/vlabs-caddy-refresh.service
sed -i "s|/opt/vlabs|$REPO_DIR|g" /etc/systemd/system/vlabs.service /etc/systemd/system/vlabs-backup.service \
  /etc/systemd/system/vlabs-caddy-refresh.service
systemctl daemon-reload
systemctl enable vlabs-caddy-refresh.service >/dev/null 2>&1 || true
# Long-running since 1.8.0 (follows network changes); restart picks up a new version.
systemctl restart vlabs-caddy-refresh.service 2>/dev/null || true

bold "5/5  Restart + health check"
systemctl restart vlabs
if ! healthy; then
  echo "  new version failed to start — rolling code back to ${before:0:7}" >&2
  journalctl -u vlabs -n 40 --no-pager >&2
  schema_after="$(schema_version)"
  as_admin "git checkout --quiet '$before'"
  as_admin "(cd server && npm ci --omit=dev --no-audit --no-fund)"
  as_admin "(cd client && npm ci --no-audit --no-fund && npm run build)"
  # Migrations are one-way, and the old code will not run on a newer schema:
  # put the step-1 backup back. The migrated file is kept next to it.
  if [[ "$schema_after" != "$SCHEMA_BEFORE" ]]; then
    if [[ -z "$BACKUP_FILE" ]]; then
      echo "  the database was migrated (schema $SCHEMA_BEFORE → $schema_after) and no backup was found;" >&2
      echo "  restore one from $(dirname "$DB_FILE")/backups by hand." >&2
      exit 1
    fi
    echo "  the database was migrated (schema $SCHEMA_BEFORE → $schema_after); restoring $BACKUP_FILE" >&2
    systemctl stop vlabs
    stamp="$(date +%Y%m%d-%H%M%S)"
    for sfx in '' -wal -shm; do
      if [[ -e "$DB_FILE$sfx" ]]; then mv -f "$DB_FILE$sfx" "$DB_FILE.failed-$stamp$sfx"; fi
    done
    install -m 0640 -o vlabs -g vlabs "$BACKUP_FILE" "$DB_FILE"
    echo "  (the migrated database is kept as $DB_FILE.failed-$stamp)" >&2
  fi
  systemctl restart vlabs
  if healthy; then
    echo "  rolled back to ${before:0:7}; vLabs is up." >&2
  else
    echo "  rolled back to ${before:0:7}, but vLabs is still not healthy: sudo journalctl -u vlabs -n 50" >&2
  fi
  exit 1
fi
systemctl reload caddy 2>/dev/null || true
echo "  vlabs $(git describe --tags --always) is up"
