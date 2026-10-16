#!/usr/bin/env bash
# (Re)render /etc/caddy/Caddyfile from deploy/pi/Caddyfile.template with the
# names participants may type: <name>.local, every IPv4 address the Pi
# currently holds, and any extra names/IPs. Reloads Caddy.
#
#   sudo /opt/vlabs/deploy/pi/render-caddy.sh                 # refresh IPs, keep saved names
#   sudo /opt/vlabs/deploy/pi/render-caddy.sh vlabs 10.0.0.5  # set name (+ extras) and save them
#
# The .local name and extras are saved to /etc/vlabs/caddy-sites.conf the first
# time they are given, so later argument-less runs keep them and only refresh
# the IP list. vlabs-caddy-refresh.service (deploy/pi/watch-network.sh) runs it
# at boot and again whenever the Pi's IPv4 addresses change, which is what makes
# moving the Pi to a new network work without any manual step. Certificates for
# new addresses come from Caddy's internal CA on reload; devices that already
# trust the root cert need nothing else.
#
# It also writes the current join addresses to /run/vlabs-net/addresses.json,
# which the portal shows next to the room code.
set -euo pipefail
[[ $EUID -eq 0 ]] || exec sudo "$0" "$@"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SAVED=/etc/vlabs/caddy-sites.conf
ADDR_DIR=/run/vlabs-net

# One render at a time (boot, network changes and manual runs can overlap).
exec 9>/run/lock/vlabs-render-caddy.lock
flock 9

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
# The name Avahi actually publishes: the hostname, or e.g. vlabs-2.local when
# another device on this network already uses vlabs.local.
mdns="$(busctl --system call org.freedesktop.Avahi / org.freedesktop.Avahi.Server \
  GetHostNameFqdn 2>/dev/null | sed -n 's/^s "\(.*\)"$/\1/p' || true)"
[[ -n "$mdns" ]] && addrs+=("$mdns")
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
# Quiet on success (this runs on every network change); the full log on failure.
if ! out="$(caddy validate --config "$new" --adapter caddyfile 2>&1)"; then
  echo "$out" >&2
  rm -f "$new"
  exit 1
fi
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

# Current join addresses for the portal (read by the vlabs service).
install -d -m 0755 "$ADDR_DIR"
json_urls=""
for a in "${uniq[@]}"; do
  a="${a//[\"\\]/}"
  json_urls+="${json_urls:+,}\"https://$a\""
done
printf '{"updated_at":"%s","urls":[%s]}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$json_urls" \
  > "$ADDR_DIR/addresses.json.tmp"
chmod 0644 "$ADDR_DIR/addresses.json.tmp"
mv -f "$ADDR_DIR/addresses.json.tmp" "$ADDR_DIR/addresses.json"
