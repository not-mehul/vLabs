# vLabs deployment guide

Two targets, one stack:

| | Short term — Raspberry Pi on the LAN | Long term — hosted for a partner |
| --- | --- | --- |
| Who connects | Participants on the facility network (or the Pi's own Wi-Fi) | Partner's instructors and participants, from anywhere |
| Address | `http://vlabs.local` (or the Pi's IP) — or a real domain, see below | `https://labs.<partner-domain>` |
| TLS | Optional (three modes) | Mandatory, automatic (Let's Encrypt) |
| Runs | `deploy/docker-compose.prod.yml` on the Pi | Same compose on a small VPS |
| Image | Built on the Pi, or pulled from GHCR (arm64) | Pulled from GHCR (amd64) |

Everything below assumes the change set in this archive is applied
(`SERVE_PLAIN_HTTP`, the `deploy/` folder, `server/scripts/`, the release
workflow).

---

## Part 1 — Raspberry Pi on the local network

### 1.1 Hardware & OS

- **Pi 4 (2 GB+) or Pi 5**, 64-bit **Raspberry Pi OS Lite (Bookworm)**. The
  Docker image is `linux/arm64`; `better-sqlite3` ships arm64 prebuilt
  binaries. A Pi 3 / 32-bit OS is not worth the fight.
- **Boot from a USB SSD** if you can, or at least a high-endurance (A2) SD
  card. SQLite in WAL mode is robust, but an SD card and a power cut are the
  most likely way to lose a session's data. Use a decent PSU.
- **Wire it to the switch** (Ethernet). Give it a **DHCP reservation** so its
  IP never changes; set the hostname to `vlabs` so mDNS advertises
  `vlabs.local` (Raspberry Pi OS runs Avahi by default).
- **Clock.** The Pi has no RTC (Pi 5: optional battery). Session expiry and the
  countdown shown to participants depend on the Pi's clock being right, so make
  sure it can reach an NTP server (the facility router usually serves one; or
  `timedatectl set-ntp true` and allow UDP 123 out). If the LAN is fully
  offline, add an RTC module or set the clock manually after each boot
  (`sudo date -s "2026-10-01 09:00"`).

### 1.2 Decide how participants reach it

Three questions decide the TLS mode:

1. **Does the facility Wi-Fi isolate clients from the LAN?** Guest networks
   often do. Test from a phone: can it ping/reach the Pi's IP? If not, either
   (a) get the Pi and the devices on the same VLAN, or (b) turn the Pi into
   its own access point (Raspberry Pi OS: `nmcli device wifi hotspot ssid vLabs
   password <pw>`; fine for ~25 devices, use the facility APs for 100).
2. **Are the participant devices managed (MDM / Apple Configurator)?** Then you
   can push one root certificate and run real HTTPS on the LAN.
3. **Do you control DNS for the partner's domain already?** Then you can get a
   genuine Let's Encrypt certificate for the Pi without exposing it.

| Mode | When | `deploy/.env` | Participants type |
| --- | --- | --- | --- |
| **A. Plain HTTP** | BYOD devices, quick pilot | `CADDYFILE=./caddy/Caddyfile.http`, `SERVE_PLAIN_HTTP=true` | `http://vlabs.local` |
| **B. Internal CA** | Managed iPads | `CADDYFILE=./caddy/Caddyfile.internal`, `SITE_ADDRESS=vlabs.local, 192.168.1.50`, `SERVE_PLAIN_HTTP=false` | `https://vlabs.local` |
| **C. Real cert via DNS-01** | You own `partner.example` DNS (Cloudflare etc.) | `CADDYFILE=./caddy/Caddyfile.dns01`, `SITE_ADDRESS=labs.partner.example`, `CLOUDFLARE_API_TOKEN=…`, plus `-f docker-compose.dns01.yml` | `https://labs.partner.example` |

Mode C is the best bridge to the long term: the same hostname, certificate
flow and compose file move to the cloud later with a one-line DNS change. Note
two things: the DNS `A` record points at a **private** IP (allowed), and some
routers have *DNS rebind protection* that refuses private answers from public
DNS — allow-list the domain on the router or add a local DNS override.

`SERVE_PLAIN_HTTP=true` is essential in mode A and must be **false** in B/C.
Without it, the app's security headers tell browsers to upgrade every request
to HTTPS, which fails on a LAN IP (`ERR_SSL_PROTOCOL_ERROR` on `/api/…`).

### 1.3 Install (Docker path — recommended)

```bash
# On the Pi
sudo apt update && sudo apt full-upgrade -y
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
sudo hostnamectl set-hostname vlabs            # → vlabs.local via mDNS

git clone <your repo> /opt/vlabs && cd /opt/vlabs/deploy
cp .env.example .env
nano .env   # secrets: openssl rand -hex 32 (twice); SEED_INSTRUCTOR_PASSWORD; pick the mode

# Either build on the Pi (5–10 min on a Pi 4) …
docker compose -f docker-compose.prod.yml up -d --build
# … or, once the release workflow has published the image, just pull:
docker compose -f docker-compose.prod.yml pull && docker compose -f docker-compose.prod.yml up -d

docker compose -f docker-compose.prod.yml logs -f vlabs   # look for "server.started"
curl -s http://localhost/api/health
```

Building on the Pi is the simplest first time. Later, set `VLABS_IMAGE` in
`.env` to your GHCR image and use `pull`; the Pi then never compiles anything.

Mode B extra step — export and install the root certificate once:

```bash
docker compose -f docker-compose.prod.yml cp caddy:/data/caddy/pki/authorities/local/root.crt ./vlabs-root.crt
```

Push `vlabs-root.crt` through your MDM as a trusted root. Manually on an iPad:
AirDrop/email the file → install profile → *Settings → General → About →
Certificate Trust Settings* → enable full trust.

### 1.4 Install (bare-metal alternative)

Lighter on RAM and avoids Docker on an SD card. Install Node 22 (arm64) from
NodeSource, then follow the header comments in `deploy/pi/vlabs.service`
(`PORT=80`, `SERVE_PLAIN_HTTP=true`, `TRUST_PROXY=` empty because nothing sits
in front). No TLS in this path unless you add Caddy yourself.

### 1.5 First login & accounts

1. Open the address on your laptop → *Instructor sign in* → `instructor` +
   the `SEED_INSTRUCTOR_PASSWORD` you set.
2. **Account → Change password** (the banner nags until you do).
3. Extra instructors (there is no UI for this yet):
   ```bash
   docker compose -f docker-compose.prod.yml exec vlabs node server/scripts/instructors.js create alice
   docker compose -f docker-compose.prod.yml exec vlabs node server/scripts/instructors.js reset-password alice
   docker compose -f docker-compose.prod.yml exec vlabs node server/scripts/instructors.js list
   ```
   Templates are shared by all instructors on an instance; sessions belong to
   whoever launched them.

### 1.6 Day-of-class runbook

- **Before:** `docker compose … ps` shows both services healthy; open the
  address from a participant device on the classroom Wi-Fi; put the URL on the
  projector or print a QR code (`sudo apt install qrencode && qrencode -t ansiutf8
  http://vlabs.local`).
- **Start:** Dashboard → *Launch a session* (duration = class length + slack;
  you can always *+30 min*). Show the 6-digit room code.
- **During:** the monitor refreshes every 5 s. "Stuck" rows (8/15 min on a
  section) are your cue to walk over. Edits to the template don't reach the
  class until you press **Push latest version**.
- **End:** *End session* revokes every participant token instantly. Export CSV
  or JSON if you want the analytics; sessions stay on the dashboard regardless.
- **Shared devices:** have participants use *Exit* (or reset the kiosk) so the
  next cohort doesn't see a *Resume* banner for someone else's seat.

### 1.7 Backups, updates, housekeeping

```bash
# Nightly consistent backup (safe while running), copied out of the volume
30 2 * * * /opt/vlabs/deploy/backup.sh >> /var/log/vlabs-backup.log 2>&1
# Point BACKUP_DIR at a USB stick to get off the SD card: BACKUP_DIR=/media/usb/vlabs
```

Updates: `git pull` (or bump the image tag) → `docker compose … up -d --build`
(or `pull && up -d`). Migrations run on start; take a backup first.
Restore: stop the stack, replace `vlabs.sqlite` in the `vlabs-data` volume
with a backup file (`docker compose cp backup.sqlite vlabs:/app/server/data/vlabs.sqlite`
while stopped, or via a one-off container), start.

Pi-specific: `sudo apt install unattended-upgrades`; consider
`log2ram`/journald size limits to spare the SD card; Docker log rotation is
already set in the compose file.

### 1.8 Troubleshooting

| Symptom | Likely cause → fix |
| --- | --- |
| Page loads but every API call fails with an SSL error (mode A) | `SERVE_PLAIN_HTTP` not `true` → set it, `up -d` |
| Phones can't reach `vlabs.local` but the laptop can | Guest Wi-Fi client isolation, or no mDNS on that device → use the IP / QR code, or move devices to the LAN VLAN, or use the Pi hotspot |
| Countdown says "expired" immediately / wrong by hours | Pi clock wrong (no NTP) → `timedatectl`, fix NTP or add an RTC |
| "Too many join attempts" for the whole class | Wrong code typed en masse counts as failures (20 per IP / 5 min, and with no proxy hop the whole NAT is one IP). Wait 5 min; double-check the code on the projector |
| Container restarts in a loop with a FATAL about secrets/password | `.env` placeholders not replaced → generate real secrets |
| Caddy mode B shows an untrusted-cert warning | Root CA not (fully) trusted on the device → see 1.3 |

---

## Part 2 — Hosted deployment for the partner

### 2.1 Target architecture

```
partner devices ──HTTPS──▶ labs.partner.example (A/AAAA → VPS)
                             │  Caddy (Let's Encrypt, HTTP→HTTPS, HTTP/3)
                             ▼
                           vlabs container  ──▶ SQLite on a persistent volume
                             │                     └─ nightly backup → object storage
                             └─ JSON logs → docker logs / log shipper
```

- **One small VPS** (2 vCPU / 2–4 GB, e.g. Hetzner CX22, DigitalOcean 2 GB,
  Lightsail 2 GB; ~€5–12/month) comfortably runs several hundred concurrent
  participants: the app is a handful of requests per second even with 100
  seats polling every 15 s. SQLite is the right call at this scale; a
  Postgres migration would only be worth it for multi-node or
  multi-thousand-seat use.
- **Same image, same compose.** The release workflow publishes
  `ghcr.io/<you>/vlabs` for amd64 and arm64, so the VPS runs exactly what you
  piloted on the Pi.
- **One instance per partner.** Templates are a shared workspace inside an
  instance, so isolation between partners is best done by running separate
  stacks (separate data volume, separate hostname) on the same VPS behind one
  Caddy. That is a few lines of compose per partner and keeps data separation
  obvious and auditable.
- **Served at the domain root.** The SPA and API assume `/`; use a subdomain
  (`labs.partner.example`), not `partner.example/labs`.

### 2.2 Phases

**Phase 0 — decisions (now)**
- Hostname (pre-selected domain → `labs.` or `lab.` subdomain) and who
  controls DNS.
- Who operates it (you or the partner's IT): SSH access, on-call, backup
  custody.
- Data handling: participant names are personal data. Agree retention (e.g.
  sessions auto-deleted after 90 days) and where backups live (region).
- Account model: how many partner instructors, who creates them, password
  reset path (CLI today — see 2.5).

**Phase 1 — provision (½ day)**
- VPS with a fixed IPv4 (+ IPv6), Ubuntu 24.04 LTS. Harden: SSH keys only,
  `ufw allow 22,80,443`, `unattended-upgrades`, fail2ban for SSH, Docker from
  the official repo, non-root deploy user in the `docker` group.
- `git clone` the repo (or just the `deploy/` folder) to `/opt/vlabs`, create
  `deploy/.env` with `CADDYFILE=./caddy/Caddyfile.public`,
  `SITE_ADDRESS=labs.partner.example`, `ACME_EMAIL=…`, strong secrets,
  `SERVE_PLAIN_HTTP=false`.

**Phase 2 — DNS & TLS (1 hour, mostly waiting)**
- `A`/`AAAA` records → VPS. Low TTL (300 s) during cutover.
- `docker compose -f docker-compose.prod.yml pull && up -d`. Caddy obtains the
  certificate on first request; verify with `curl -I https://labs.partner.example/api/health`
  and a browser. HSTS is already sent by the app.
- If you ran Mode C on the Pi with the same hostname, this step is literally
  changing one `A` record from the private IP to the VPS and letting Caddy
  re-issue.

**Phase 3 — deploy pipeline**
- Tag releases (`v1.2.0`); the release workflow publishes images tagged
  `latest`, `1.2`, `1.2.0`, `sha-…`. Pin the VPS to a version tag in `.env`
  (`VLABS_IMAGE=ghcr.io/<you>/vlabs:1.2`) so a `pull` is a deliberate upgrade.
- Upgrade procedure: `deploy/backup.sh` → bump tag → `pull && up -d` → check
  `/api/health` and the log line `db.migrate` if a migration ran. Rollback =
  previous tag + restore backup if the schema moved.
- Optional: a tiny GitHub Actions "deploy" job that SSHes in and runs those
  commands on tag push; or Watchtower for automatic patch updates (only if
  you're comfortable with unattended restarts).

**Phase 4 — operations**
- **Backups off-box:** `deploy/backup.sh` nightly + `rclone copy` to S3/B2/
  Hetzner Storage Box (encrypted bucket, 30-day retention, test a restore
  once a quarter).
- **Monitoring:** an external uptime check on `https://…/api/health` (Better
  Uptime, UptimeRobot, Healthchecks.io) with alerts to you *and* the partner
  contact; disk-usage alert on the VPS.
- **Logs:** JSON lines via `docker logs`; ship with Vector/Promtail to Grafana
  Cloud or just keep local rotation (already configured) if nobody will read
  them.
- **Patching:** OS unattended upgrades; Dependabot PRs keep Node deps and the
  base image moving; CI builds and smoke-tests the image on every PR.

**Phase 5 — handover to the partner**
- Create their instructor accounts (`instructors.js create …`), hand over
  temporary passwords out of band, confirm they changed them.
- Give them this guide's day-of-class section plus the README's authoring
  section (Markdown format, formula helpers, push-latest-version).
- Agree a support path and a change window for upgrades.

### 2.3 Security checklist for internet exposure

Already in place after the review: strong-secret enforcement, identity-keyed
rate limits, failed-login throttling, bcrypt, token revocation on password
change, strict CSP without `unsafe-inline`, HSTS, `no-store` content,
progressive delivery, sandboxed formulas, request logging without bodies.

Still your responsibility at the edge:
- `TRUST_PROXY=1` (Caddy) — the prod compose sets it. Never `true`.
- Caddy is the only thing publishing ports; the app's 4000 stays internal.
- SSH: keys only, no root login; consider restricting 22 to your IPs.
- Secrets live only in `deploy/.env` (mode 600) — never in the repo or image.
- Rotate `JWT_*` secrets if a server is ever compromised (invalidates all
  tokens; instructors log in again, participants re-join with their names and
  get their seats back).
- Keep the Pi pilot's database out of the public instance unless you mean to
  migrate it (see 2.6).

### 2.4 Capacity & cost sanity check

| Load | Requests | Notes |
| --- | --- | --- |
| 100 seats, one session | ~7 req/s steady (status polls) + bursts on navigation | Trivial for 1 vCPU |
| 5 concurrent sessions × 100 seats | ~35 req/s | Still fine; SQLite WAL handles concurrent reads; writes are tiny |
| Monitor open on 5 screens | +1 req/s | — |

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
   you end up with many partners and separate stacks become tedious.

### 2.6 Moving data from the Pi to the cloud

Two clean options:

- **Templates only (recommended):** export each template as JSON from the
  editor on the Pi, import on the hosted instance. Session analytics from the
  pilot stay on the Pi (export CSV/JSON for records). No schema concerns.
- **Whole database:** run `deploy/backup.sh` on the Pi, copy the
  `vlabs-*.sqlite` file to the VPS, place it in the `vlabs-data` volume as
  `vlabs.sqlite` **before** the first `up`. Secrets may differ (tokens just
  become invalid; passwords carry over because they're bcrypt hashes). The
  file is architecture-independent.

### 2.7 Decision checklist

- [ ] Facility Wi-Fi: same LAN as the Pi, or isolated? (decides mode A/B/C
      and whether the Pi needs to be an AP)
- [ ] Participant devices: managed or BYOD?
- [ ] Domain: final hostname, DNS provider, who holds the API token
- [ ] Hosting: your VPS or the partner's? Region?
- [ ] Retention period for session data; backup custody
- [ ] Number of partner instructors; who resets passwords
- [ ] Go-live date → work backwards for Phase 0–5 and the 2.5 items you want
