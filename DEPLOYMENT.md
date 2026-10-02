# vLabs deployment guide

Two ways to run the same tree:

|         | Mac — developing / testing               | Raspberry Pi — hosting a class                                |
| ------- | ---------------------------------------- | ------------------------------------------------------------- |
| Command | `npm run setup` once, then `npm run dev` | `sudo deploy/pi/install.sh` once, then it's a systemd service |
| Address | `http://localhost:5173` (loopback only)  | `https://vlabs.local` on the classroom LAN                    |
| SPA     | Vite dev server with HMR, proxies `/api` | Built once (`client/dist`), served by Node                    |
| TLS     | none                                     | Caddy, internal CA (devices trust one root cert)              |
| Config  | `.env` at the repo root, optional        | `/etc/vlabs/vlabs.env`, generated                             |
| Data    | `server/data/vlabs.sqlite`               | `/var/lib/vlabs/vlabs.sqlite`, nightly backups                |

Part 1 is the Pi runbook. Part 2 sketches the later hosted deployment for a
partner, which reuses the same scripts on a small VPS.

---

## Part 1 — Raspberry Pi on the local network

### 1.1 Hardware & OS

- **Pi 4 (2 GB+) or Pi 5**, 64-bit **Raspberry Pi OS Lite (Bookworm)**. The
  install script refuses 32-bit (`better-sqlite3` and Node 22 ship arm64
  binaries; on armv7 you would be compiling). A Pi 3 is not worth the fight.
- **Boot from a USB SSD** if you can, or at least a high-endurance (A2) SD
  card. SQLite in WAL mode is robust, but an SD card and a power cut are the
  most likely way to lose a session's data. Use a decent PSU.
- **Wire it to the switch** (Ethernet). Give it a **DHCP reservation** so its
  IP never changes. The installer sets the hostname to `vlabs` so Avahi
  advertises `vlabs.local`.
- **Clock.** The Pi has no RTC (Pi 5: optional battery). Session expiry, the
  participant countdown _and certificate validity_ depend on the clock, so make
  sure it can reach NTP (the facility router usually serves it; or
  `timedatectl set-ntp true` and allow UDP 123 out). On a fully offline LAN add
  an RTC module or set the clock after each boot (`sudo date -s "2026-10-01 09:00"`).

### 1.2 Decide how participants reach it

Two questions decide the day:

1. **Does the facility Wi-Fi isolate clients from the LAN?** Guest networks
   often do. Test from a phone: can it reach the Pi's IP? If not, either
   (a) get the Pi and the devices on the same VLAN, or (b) turn the Pi into
   its own access point (`nmcli device wifi hotspot ssid vLabs password <pw>`;
   fine for ~25 devices, use the facility APs for 100).
2. **Can `.local` be resolved by the devices?** iOS/macOS/most Androids and
   Windows 10+ do mDNS; locked-down corporate laptops sometimes don't. The
   fallback is the Pi's IP — pass it to the installer as an extra address so
   the certificate covers it too (`VLABS_EXTRA_ADDRESSES="192.168.1.50"`).

HTTPS is always on: Caddy issues certificates from its own root CA, and each
device trusts that root **once** (1.4). There is no plain-HTTP mode on the Pi
path; the only `http://` endpoint is the root-certificate download.

### 1.3 Install

```bash
# On the Pi, as the normal admin user (pi / whatever you created)
sudo apt update && sudo apt install -y git
sudo git clone https://github.com/not-mehul/vLabs.git /opt/vlabs
sudo /opt/vlabs/deploy/pi/install.sh
```

The script asks for the hostname (`vlabs` → `https://vlabs.local`), optional
extra names/IPs for the certificate, and whether to rename the Pi. It then:

1. installs Node 22 (NodeSource), Caddy (official apt repo), Avahi and sqlite3;
2. creates the `vlabs` system user, `/var/lib/vlabs` (data), `/srv/vlabs-public`
   (root certificate download), `/etc/vlabs/vlabs.env` with **generated**
   secrets and a generated first-login password (printed once, kept in the
   file);
3. runs `npm ci --omit=dev` in `server/` and `npm ci && vite build` in
   `client/` as your admin user (5–10 min on a Pi 4 — it is a one-off);
4. renders `deploy/pi/Caddyfile.template` → `/etc/caddy/Caddyfile` and
   validates it;
5. installs and starts `vlabs.service`, `caddy.service` and
   `vlabs-backup.timer`, waits for `/api/health`;
6. publishes the Caddy root certificate (`export-root-cert.sh`).

Re-running it is safe; it keeps an existing `vlabs.env`. Set the variables
listed at the top of the script to run it unattended.

What lands where:

| Path                               | Owner             | Purpose                                                                  |
| ---------------------------------- | ----------------- | ------------------------------------------------------------------------ |
| `/opt/vlabs`                       | your admin user   | git checkout, read-only to the service                                   |
| `/etc/vlabs/vlabs.env`             | `root:vlabs` 0640 | all configuration + secrets (`sudo systemctl restart vlabs` after edits) |
| `/var/lib/vlabs/vlabs.sqlite`      | `vlabs`           | the database (+ WAL files)                                               |
| `/var/lib/vlabs/backups/`          | `vlabs`           | nightly snapshots, 14 kept                                               |
| `/etc/caddy/Caddyfile`             | root              | HTTPS front; `sudo systemctl reload caddy` after edits                   |
| `/srv/vlabs-public/vlabs-root.crt` | root              | root certificate for devices                                             |
| `/var/log/caddy/vlabs-access.log`  | caddy             | access log (rotated)                                                     |

### 1.4 Trust the root certificate on devices

Every device does this **once** (the root lasts 10 years; leaf certificates
rotate on their own):

1. Open **`http://vlabs.local/vlabs-root.crt`** (plain HTTP, on purpose).
2. Install it as a trusted root:
   - **iPhone / iPad:** Safari → Allow → Settings → _Profile Downloaded_ →
     Install; then Settings → General → About → _Certificate Trust Settings_ →
     enable full trust for _Caddy Local Authority_. (Managed iPads: push the
     same file via MDM/Apple Configurator and skip all of this.)
   - **Android:** Settings → Security → _Encryption & credentials_ → _Install a
     certificate_ → CA certificate → pick the download.
   - **macOS:** double-click → Keychain Access → open it → Trust → _Always Trust_.
   - **Windows:** double-click → Install Certificate → Local Machine → _Trusted
     Root Certification Authorities_.
   - **Chromebook:** `chrome://settings/certificates` → Authorities → Import.
3. Open **`https://vlabs.local`** — no warning.

`sudo /opt/vlabs/deploy/pi/export-root-cert.sh` prints the SHA-256 fingerprint
(put it on the projector if people want to check) and drops a copy of the file
in the current directory for AirDrop/MDM.

If you ever reinstall Caddy from scratch it generates a _new_ root and every
device must trust it again — back up `/var/lib/caddy` with the rest if that
matters to you.

### 1.5 First login & accounts

1. Open the address on your laptop → _Instructor sign in_ → `instructor` +
   the password printed by the installer (also in `/etc/vlabs/vlabs.env`).
2. **Account → Change password** (the banner nags until you do).
3. Extra instructors (there is no UI for this yet):
   ```bash
   sudo /opt/vlabs/deploy/pi/vlabs-cli.sh instructors create alice
   sudo /opt/vlabs/deploy/pi/vlabs-cli.sh instructors reset-password alice
   sudo /opt/vlabs/deploy/pi/vlabs-cli.sh instructors list
   ```
   `vlabs-cli.sh` runs the script as the service user with the production
   configuration, so it edits the real database. Templates are shared by all
   instructors on an instance; sessions belong to whoever launched them.

### 1.6 Day-of-class runbook

- **Before:** `systemctl status vlabs caddy` both active; open the address
  from a participant device on the classroom Wi-Fi; put the URL on the
  projector or print a QR code (`sudo apt install qrencode && qrencode -t
ansiutf8 https://vlabs.local`). Have the root-cert URL on the same slide for
  anyone on a new device.
- **Shared iPads:** after trusting the root certificate, open
  `https://vlabs.local` in Safari → Share → **Add to Home Screen**. The vLabs
  icon then opens full-screen without the Safari chrome (the app ships a web
  manifest and touch icons), which is the closest thing to kiosk mode without
  Guided Access; pair it with Guided Access if the devices are managed.
- **Start:** Dashboard → _Launch a session_ (duration = class length + slack;
  you can always _+30 min_). Show the 6-digit room code.
- **During:** the monitor refreshes every 5 s. "Stuck" rows (8/15 min on a
  section) are your cue to walk over. Edits to the template don't reach the
  class until you press **Push latest version**.
- **End:** _End session_ revokes every participant token instantly. Export CSV
  or JSON if you want the analytics; sessions stay on the dashboard regardless.
- **Shared devices:** have participants use _Exit_ (or reset the kiosk) so the
  next cohort doesn't see a _Resume_ banner for someone else's seat.

### 1.7 Backups, updates, housekeeping

- **Backups** run nightly at 02:30 (`vlabs-backup.timer`, catches up after
  boot if the Pi was off) using SQLite's online backup API — safe while a
  class is running. `sudo systemctl start vlabs-backup` for one now. To copy
  the newest snapshot off the SD card, add `BACKUP_DIR=/media/usb/vlabs` to
  `/etc/vlabs/vlabs.env`.
- **Restore:** `sudo systemctl stop vlabs`, copy the snapshot over
  `/var/lib/vlabs/vlabs.sqlite` (remove `vlabs.sqlite-wal`/`-shm` if present,
  `chown vlabs:vlabs`), `sudo systemctl start vlabs`.
- **Updates:** `sudo /opt/vlabs/deploy/pi/update.sh` — backup → `git pull`
  (fast-forward only) → `npm ci` → `vite build` → refresh units → restart →
  health check. If the new version doesn't come up it checks the previous
  commit back out and restarts. Migrations are one-way, so if the schema moved
  restore the backup it took first. `update.sh v1.3.0` pins a tag.
- **Logs:** `sudo journalctl -u vlabs -f` (one line per request plus
  lifecycle/audit events), `sudo journalctl -u caddy -f`,
  `/var/log/caddy/vlabs-access.log`.
- **Pi hygiene:** `sudo apt install unattended-upgrades`; cap the journal
  (`SystemMaxUse=200M` in `/etc/systemd/journald.conf`) or use `log2ram` to
  spare the SD card.

### 1.8 Troubleshooting

| Symptom                                                                        | Likely cause → fix                                                                                                                                                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Certificate warning on a device                                                | Root cert not installed or not _fully trusted_ (iOS needs the extra step) → 1.4. Or the device uses the IP and the IP isn't in the cert → re-run `install.sh` with `VLABS_EXTRA_ADDRESSES` |
| `vlabs.local` doesn't resolve on some devices | No mDNS on that device/network → use `https://<pi-ip>` (already in the cert), or set a DNS entry on the router |
| Pi got a new IP and `https://<ip>` warns or fails | `sudo /opt/vlabs/deploy/pi/render-caddy.sh`, then set a DHCP reservation |
| Phones can't reach the Pi but the laptop can                                   | Guest Wi-Fi client isolation → same VLAN, or the Pi hotspot                                                                                                                                |
| Countdown says "expired" immediately / wrong by hours; or cert "not yet valid" | Pi clock wrong (no NTP) → `timedatectl`, fix NTP or add an RTC                                                                                                                             |
| "Too many join attempts" for the whole class                                   | Wrong code typed en masse counts as failures (20 per IP / 5 min). Wait 5 min; double-check the code on the projector. (Caddy forwards real client IPs, so this is per device, not per NAT) |
| `systemctl status vlabs` restarts in a loop with FATAL about secrets/password  | `/etc/vlabs/vlabs.env` edited with a short/placeholder secret → generate real ones (`openssl rand -hex 32`)                                                                                |
| 502 from Caddy                                                                 | Node not up → `journalctl -u vlabs -n 50`; `curl http://127.0.0.1:4000/api/health`                                                                                                         |
| `update.sh` says "not a fast-forward"                                          | Local edits on the Pi → `git stash` or commit them, re-run                                                                                                                                 |

---

## Part 2 — Hosted deployment for the partner (later)

### 2.1 Target architecture

```
partner devices ──HTTPS──▶ labs.partner.example (A/AAAA → VPS)
                             │  Caddy (Let's Encrypt, HTTP→HTTPS, HTTP/3)
                             ▼
                           vlabs.service (Node, 127.0.0.1:4000) ──▶ SQLite in /var/lib/vlabs
                             │                                          └─ nightly backup → object storage
                             └─ journald → log shipper (optional)
```

- **One small VPS** (2 vCPU / 2–4 GB, ~€5–12/month, Ubuntu 24.04 or Debian 12,
  amd64) comfortably runs several hundred concurrent participants; the app is
  a handful of requests per second even with 100 seats polling every 15 s.
  SQLite is the right call at this scale.
- **Same scripts.** `deploy/pi/install.sh` is plain Debian/systemd; it runs
  unchanged on the VPS except for the architecture check (relax it) and the
  Caddyfile: replace `tls internal` / `local_certs` with a public site block
  (`labs.partner.example { reverse_proxy 127.0.0.1:4000 }` + `email …` in the
  global options) and Caddy obtains Let's Encrypt certificates automatically.
  Drop the `http://` side door — nobody needs the internal root cert.
- **One instance per partner.** Templates are a shared workspace inside an
  instance, so isolation between partners is best done as separate instances
  (separate unit, env file, data dir, hostname) behind one Caddy.
- **Served at the domain root.** The SPA and API assume `/`; use a subdomain,
  not a path.

### 2.2 Phases

**Phase 0 — decisions:** hostname and who controls DNS; who operates it (SSH
access, on-call, backup custody); data handling (participant names are
personal data — agree retention and backup region); account model (how many
partner instructors, who resets passwords — CLI today, see 2.5).

**Phase 1 — provision (½ day):** VPS with fixed IPv4 (+IPv6). Harden: SSH keys
only, `ufw allow 22,80,443`, `unattended-upgrades`, fail2ban. Clone to
`/opt/vlabs`, run the install script, swap the Caddyfile to the public block.

**Phase 2 — DNS & TLS (1 hour, mostly waiting):** `A`/`AAAA` → VPS, low TTL
during cutover. Caddy issues the certificate on first request; verify with
`curl -I https://labs.partner.example/api/health`. HSTS is already sent.

**Phase 3 — deploy pipeline:** tag releases (`v1.3.0`); upgrade with
`update.sh v1.3.0` so a deploy is deliberate and pinned. Optional: a GitHub
Actions job that SSHes in and runs it on tag push.

**Phase 4 — operations:** backups off-box (`BACKUP_DIR` on a mounted volume +
`rclone copy` to S3/B2, 30-day retention, test a restore quarterly); an
external uptime check on `/api/health`; disk alerts; OS unattended upgrades;
Dependabot PRs with CI's production smoke test.

**Phase 5 — handover:** create the partner's instructor accounts
(`vlabs-cli.sh instructors create …`), hand over temporary passwords out of
band, confirm they changed them; give them section 1.6 and the README's
authoring section; agree a support path and change window.

### 2.3 Security checklist for internet exposure

Already in place: strong-secret enforcement, identity-keyed rate limits,
failed-login throttling, bcrypt, token revocation on password change, strict
CSP without `unsafe-inline`, HSTS, `no-store` content, progressive delivery,
sandboxed formulas, request logging without bodies, Node bound to loopback
behind Caddy, a hardened systemd unit (read-only filesystem except
`/var/lib/vlabs`, no capabilities, `NoNewPrivileges`).

Still your responsibility at the edge: `TRUST_PROXY=1` (never `true`); only
Caddy publishes ports; SSH keys only, consider restricting 22 to your IPs;
secrets only in `/etc/vlabs/vlabs.env` (0640); rotate `JWT_*` secrets if a box
is ever compromised (everyone logs in again; participants re-join by name and
get their seats back); keep the Pi pilot's database out of the public instance
unless you mean to migrate it (2.6).

### 2.4 Capacity & cost sanity check

| Load                              | Requests                                              | Notes                                                            |
| --------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------- |
| 100 seats, one session            | ~7 req/s steady (status polls) + bursts on navigation | Trivial for 1 vCPU                                               |
| 5 concurrent sessions × 100 seats | ~35 req/s                                             | Still fine; SQLite WAL handles concurrent reads; writes are tiny |
| Monitor open on 5 screens         | +1 req/s                                              | —                                                                |

Bandwidth is negligible (JSON + one ~300 kB SPA bundle per device, cached).
Budget ≈ VPS €5–12 + domain + ~€1 object storage per month.

### 2.5 Code work worth doing before the partner go-live

Prioritised; none block the Pi pilot.

1. **Instructor management UI (admin role).** Today new instructors and
   password resets go through the CLI. An `is_admin` flag, `POST/DELETE
/api/auth/instructors`, and a small Admin page would let the partner
   self-serve. Estimate: a day.
2. **Data retention job.** Auto-delete sessions (and participants) older than
   N days; keep template audit. A `sessionLifecycle` addition plus a config
   knob. Half a day.
3. **Server time in `/status`.** Lets the client correct for device-clock
   skew in the countdown (matters on the Pi more than the cloud). An hour.
4. **Password reset without the CLI.** Either email-based (adds SMTP) or an
   admin-issued one-time reset code. Depends on (1).
5. **Partner branding knobs** (name, logo, accent colour) via env/config if
   the partner wants their identity on the participant page.
6. **Per-partner isolation inside one instance** (organisations) — only if
   you end up with many partners and separate instances become tedious.

### 2.6 Moving data from the Pi to the cloud

- **Templates only (recommended):** export each template as JSON from the
  editor on the Pi, import on the hosted instance. Session analytics from the
  pilot stay on the Pi (export CSV/JSON for records). No schema concerns.
- **Whole database:** `sudo systemctl start vlabs-backup` on the Pi, copy the
  newest `/var/lib/vlabs/backups/vlabs-*.sqlite` to the VPS as
  `/var/lib/vlabs/vlabs.sqlite` (owner `vlabs:vlabs`) **before** the first
  start. Secrets may differ (tokens just become invalid; passwords carry over
  because they're bcrypt hashes). The file is architecture-independent.

### 2.7 Decision checklist

- [ ] Facility Wi-Fi: same LAN as the Pi, or isolated? (decides whether the
      Pi needs to be an AP, and whether to put the IP in the certificate)
- [ ] Participant devices: managed (push the root cert) or BYOD (self-install)?
- [ ] Domain: final hostname, DNS provider
- [ ] Hosting: your VPS or the partner's? Region?
- [ ] Retention period for session data; backup custody
- [ ] Number of partner instructors; who resets passwords
- [ ] Go-live date → work backwards for Phase 0–5 and the 2.5 items you want
