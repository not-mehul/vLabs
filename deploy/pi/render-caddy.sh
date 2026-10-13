#!/usr/bin/env bash
# (Re)render /etc/caddy/Caddyfile from deploy/pi/Caddyfile.template with the
# names participants may type: <name>.local, every IPv4 address the Pi
# currently holds, and any extra names/IPs. Reloads Caddy.
#
#   sudo /opt/vlabs/deploy/pi/render-caddy.sh                 # refresh IPs, keep saved names
#   sudo /opt/vlabs/deploy/pi/render-caddy.sh vlabs 10.0.0.5  # set name (+ extras) and save them
#
# The .local name and extras are saved to /etc/vlabs/caddy-sites.conf the first
# time they are given, so later argument-less runs (including the boot-time
# vlabs-caddy-refresh.service) keep them and only refresh the IP list. That is
# what makes moving the Pi to a new network work without any manual step.
# Certificates for new addresses come from Caddy's internal CA on reload;
# devices that already trust the root cert need nothing else.
set -euo pipefail
[[ $EUID -eq 0 ]] || exec sudo "$0" "$@"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SAVED=/etc/vlabs/caddy-sites.conf

if [[ $# -gt 0 ]]; then
  host="$1"; shift
  extras=("$@")
  install -d -m 0750 /etc/vlabs
  { printf 'SITE_NAME=%q\n' "$host"; printf 'EXTRA_ADDRESSES=%q\n' "${extras[*]:-}"; } > "$SAVED"
elif [[ -f "$SAVED" ]]; then
  # shellcheck disable=SC1090
  . "$SAVED"
  host="${SITE_NAME:-$(hostname)}"
  read -r -a extras <<< "${EXTRA_ADDRESSES:-}"
else
  host="$(hostname)"
  extras=()
fi

addrs=("$host.local")
# All non-loopback IPv4s (Ethernet + Wi-Fi + hotspot), in interface order.
for ip in $(hostname -I 2>/dev/null); do
  [[ "$ip" == *.* && "$ip" != 127.* ]] && addrs+=("$ip")
done
for a in "${extras[@]:-}"; do [[ -n "$a" ]] && addrs+=("$a"); done
# De-duplicate, keep order.
declare -A seen; uniq=()
for a in "${addrs[@]}"; do [[ -n "${seen[$a]:-}" ]] || { seen[$a]=1; uniq+=("$a"); }; done

https_sites=""; http_sites=""
for a in "${uniq[@]}"; do
  https_sites+="${https_sites:+, }https://$a"; http_sites+="${http_sites:+, }http://$a"
done

new="$(mktemp)"
sed -e "s|__HTTPS_SITES__|$https_sites|" -e "s|__HTTP_SITES__|$http_sites|" \
  "$REPO_DIR/deploy/pi/Caddyfile.template" > "$new"
caddy fmt --overwrite "$new"
caddy validate --config "$new" --adapter caddyfile >/dev/null
# Only touch Caddy when something actually changed (the boot unit runs this
# every boot; an unchanged reload is harmless but noisy in the journal).
if ! cmp -s "$new" /etc/caddy/Caddyfile; then
  install -m 0644 "$new" /etc/caddy/Caddyfile
  if systemctl is-active --quiet caddy; then systemctl reload caddy; fi
  echo "  Caddy sites updated: $https_sites"
else
  echo "  Caddy sites unchanged: $https_sites"
fi
rm -f "$new"
