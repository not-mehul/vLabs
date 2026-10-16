#!/usr/bin/env bash
# Keep vLabs reachable when the Pi changes networks — no reboot, no manual step.
#
# Run by vlabs-caddy-refresh.service (started at boot, restarted if it dies).
# It renders the Caddy site list once at start, then watches the kernel for
# IPv4 address changes (cable plugged into a new network, Wi-Fi switched, DHCP
# lease renewed with a new address, cable pulled) and re-renders after the
# burst of changes settles. render-caddy.sh adds the new addresses to the
# certificate, drops stale ones, reloads Caddy only when something changed and
# publishes the current join addresses for the portal.
#
# A second pass runs a little later because Avahi can rename itself
# (vlabs.local → vlabs-2.local) a few seconds after joining a network where
# the name is already taken.
#
#   sudo systemctl status vlabs-caddy-refresh     sudo journalctl -u vlabs-caddy-refresh -f
set -uo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RENDER="${VLABS_RENDER:-$REPO_DIR/deploy/pi/render-caddy.sh}"
SETTLE="${VLABS_NET_SETTLE:-3}"    # seconds without changes before re-rendering
RECHECK="${VLABS_NET_RECHECK:-15}" # then once more after this many seconds

render() {
  "$RENDER" || echo "watch-network: render failed; will retry on the next network change" >&2
}

render
echo "watch-network: watching IPv4 address changes"

# `ip monitor` prints one line per added / removed address. `read -t` returns
# >128 on timeout and 1 at EOF; EOF means the monitor died, so exit non-zero
# and let systemd restart the unit (which renders again on start).
state=idle
ip -4 -o monitor address | while :; do
  case "$state" in
    idle) read -r _ ;;
    *) read -r -t "$([[ $state == settling ]] && echo "$SETTLE" || echo "$RECHECK")" _ ;;
  esac
  rc=$?
  if ((rc == 0)); then
    state=settling
    continue
  fi
  if ((rc <= 128)); then
    echo "watch-network: address monitor stopped" >&2
    exit 1
  fi
  if [[ "$state" == settling ]]; then
    echo "watch-network: addresses changed"
    render
    state=recheck
  else
    render
    state=idle
  fi
done
exit 1
