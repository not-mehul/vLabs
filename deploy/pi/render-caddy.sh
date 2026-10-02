#!/usr/bin/env bash
# (Re)render /etc/caddy/Caddyfile from deploy/pi/Caddyfile.template with the
# names participants may type: <hostname>.local, every IPv4 address the Pi
# currently holds, and any extra names/IPs given as arguments. Reloads Caddy.
#
#   sudo /opt/vlabs/deploy/pi/render-caddy.sh                 # keep hostname, refresh IPs
#   sudo /opt/vlabs/deploy/pi/render-caddy.sh vlabs 10.0.0.5  # explicit hostname + extra
#
# Run it again whenever the Pi's IP changes (better: give it a DHCP
# reservation so it never does). Certificates for new addresses are issued by
# Caddy's internal CA on reload; devices that already trust the root cert need
# nothing else.
set -euo pipefail
[[ $EUID -eq 0 ]] || exec sudo "$0" "$@"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

host="${1:-$(hostname)}"; shift || true
addrs=("$host.local")
# All non-loopback IPv4s (Ethernet + Wi-Fi + hotspot), in interface order.
for ip in $(hostname -I 2>/dev/null); do
  [[ "$ip" == *.* && "$ip" != 127.* ]] && addrs+=("$ip")
done
for a in "$@"; do addrs+=("$a"); done
# De-duplicate, keep order.
declare -A seen; uniq=()
for a in "${addrs[@]}"; do [[ -n "${seen[$a]:-}" ]] || { seen[$a]=1; uniq+=("$a"); }; done

https_sites=""; http_sites=""
for a in "${uniq[@]}"; do
  https_sites+="${https_sites:+, }https://$a"; http_sites+="${http_sites:+, }http://$a"
done
sed -e "s|__HTTPS_SITES__|$https_sites|" -e "s|__HTTP_SITES__|$http_sites|" \
  "$REPO_DIR/deploy/pi/Caddyfile.template" > /etc/caddy/Caddyfile
caddy fmt --overwrite /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile >/dev/null
if systemctl is-active --quiet caddy; then systemctl reload caddy; fi
echo "  Caddy sites: $https_sites"
