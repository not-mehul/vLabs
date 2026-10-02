#!/usr/bin/env bash
# Update a running Pi to the latest main: backup → git pull → install → build →
# restart → health check. Rolls the code back if the new version fails to boot.
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

cd "$REPO_DIR"
before=$(git rev-parse HEAD)

bold "1/5  Backup"
"$REPO_DIR/deploy/pi/backup.sh"

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
sed -i "s|/opt/vlabs|$REPO_DIR|g" /etc/systemd/system/vlabs.service /etc/systemd/system/vlabs-backup.service
systemctl daemon-reload

bold "5/5  Restart + health check"
systemctl restart vlabs
ok=""
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4000/api/health >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [[ -z "$ok" ]]; then
  echo "  new version failed to start — rolling code back to ${before:0:7}" >&2
  journalctl -u vlabs -n 40 --no-pager >&2
  as_admin "git checkout --quiet '$before'"
  as_admin "(cd server && npm ci --omit=dev --no-audit --no-fund)"
  as_admin "(cd client && npm ci --no-audit --no-fund && npm run build)"
  systemctl restart vlabs
  echo "  rolled back. NOTE: database migrations are one-way; if the new version migrated the schema," >&2
  echo "  restore the backup taken in step 1 from /var/lib/vlabs/backups." >&2
  exit 1
fi
systemctl reload caddy 2>/dev/null || true
echo "  vlabs $(git describe --tags --always) is up"
