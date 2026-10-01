#!/usr/bin/env bash
# Run one of the server/scripts/*.js maintenance tools on the Pi with the
# PRODUCTION configuration (/etc/vlabs/vlabs.env) and as the service user, so
# it talks to the real database in /var/lib/vlabs rather than a stray dev file.
#
#   sudo deploy/pi/vlabs-cli.sh instructors list
#   sudo deploy/pi/vlabs-cli.sh instructors create alice
#   sudo deploy/pi/vlabs-cli.sh instructors reset-password alice
#   sudo deploy/pi/vlabs-cli.sh backup            # one-off consistent snapshot
set -euo pipefail
[[ $EUID -eq 0 ]] || exec sudo "$0" "$@"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE=/etc/vlabs/vlabs.env
SERVICE_USER=vlabs

[[ $# -ge 1 ]] || { echo "usage: $0 <instructors|backup> [args…]" >&2; exit 2; }
script="$REPO_DIR/server/scripts/$1.js"; shift
[[ -f "$script" ]] || { echo "no such tool: $script" >&2; exit 2; }
[[ -f "$ENV_FILE" ]] || { echo "$ENV_FILE missing — run deploy/pi/install.sh first" >&2; exit 1; }

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
export NODE_ENV=production
exec runuser -p -u "$SERVICE_USER" -- /usr/bin/node "$script" "$@"
