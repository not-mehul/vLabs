#!/usr/bin/env bash
# Publish Caddy's internal root certificate so participant devices can trust
# https://vlabs.local without warnings. Copies it to /srv/vlabs-public, from
# where Caddy serves it at  http://<name>/vlabs-root.crt  (plain HTTP on purpose:
# the device cannot trust HTTPS yet). Also drops a copy in the current directory
# for MDM / Apple Configurator / AirDrop.
#
#   sudo /opt/vlabs/deploy/pi/export-root-cert.sh
#
# Installing on devices
#   iPhone/iPad : open the URL in Safari → Allow → Settings → Profile Downloaded
#                 → Install, then Settings → General → About → Certificate Trust
#                 Settings → enable full trust for "Caddy Local Authority".
#   Android     : download → Settings → Security → Encryption & credentials →
#                 Install a certificate → CA certificate.
#   macOS       : double-click → Keychain Access → set "Always Trust".
#   Windows     : double-click → Install → Local Machine → "Trusted Root
#                 Certification Authorities".
#   Chromebook  : chrome://settings/certificates → Authorities → Import.
set -euo pipefail
[[ $EUID -eq 0 ]] || exec sudo "$0" "$@"

PUBLIC_DIR=/srv/vlabs-public
OUT_NAME=vlabs-root.crt
# Data dir of the apt-packaged caddy service (XDG_DATA_HOME=/var/lib/caddy).
CANDIDATES=(
  /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt
  /var/lib/caddy/pki/authorities/local/root.crt
)

src=""
for c in "${CANDIDATES[@]}"; do [[ -f "$c" ]] && { src=$c; break; }; done
if [[ -z "$src" ]]; then
  # Caddy creates the CA lazily on first HTTPS start; poke it and retry once.
  systemctl is-active --quiet caddy || systemctl start caddy
  curl -ks --max-time 5 https://127.0.0.1/ >/dev/null 2>&1 || true
  sleep 2
  for c in "${CANDIDATES[@]}"; do [[ -f "$c" ]] && { src=$c; break; }; done
fi
[[ -n "$src" ]] || { echo "Caddy root certificate not found yet (is caddy running? journalctl -u caddy)"; exit 1; }

install -d -m 0755 "$PUBLIC_DIR"
install -m 0644 "$src" "$PUBLIC_DIR/$OUT_NAME"
cp -f "$src" "./$OUT_NAME" 2>/dev/null && chown "${SUDO_USER:-root}" "./$OUT_NAME" || true

fp=$(openssl x509 -in "$src" -noout -fingerprint -sha256 | cut -d= -f2)
exp=$(openssl x509 -in "$src" -noout -enddate | cut -d= -f2)
name=$(hostname)
cat <<EOF
Root certificate published.
  Download URL : http://$name.local/$OUT_NAME
  Local copy   : $(pwd)/$OUT_NAME
  SHA-256      : $fp
  Valid until  : $exp   (Caddy's root lasts 10 years; leaf certs rotate automatically)
Participants install it once per device, then use https://$name.local
EOF
