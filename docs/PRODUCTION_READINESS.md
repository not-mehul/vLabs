# vLabs production readiness

Scope: the whole system as of **1.18.1** — server, data layer,
authentication and authorisation, the lab and exam participant flows, the
instructor portal and Template Studio, deployment on the Raspberry Pi
(systemd, Caddy, backups, updates) and CI. Checked 2026-10-17.

The full audit was done at 1.5.1 and re-checked at each release that changed
the exam model; what each release fixed is in [CHANGES.md](../CHANGES.md).
This page is the current state.

## Verdict

**Ready for classroom production on the Raspberry Pi**, once the
[go-live checklist](#go-live-checklist) is done. What remains below are
design trade-offs and features to plan for, not blockers for a LAN classroom.
A public/internet deployment needs the extra items marked **(hosted)**.

## Verification at 1.18.1

| Check                                                                   | Result                                                                                            |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Server test suite (`npm test --prefix server`)                          | 106 / 106 pass                                                                                    |
| Client test suite (`npm test --prefix client`)                          | 31 / 31 pass                                                                                      |
| Lint and format check (as CI), Studio scripts linted together           | Clean                                                                                             |
| Client production build; offline Studio matches its sources             | Clean; `check:studio` up to date                                                                  |
| Production boot with real secrets (as CI's smoke test)                  | `/api/health` ok, SPA and both Studio builds served; CSP, HSTS and `nosniff` present              |
| Production boot with weak secrets                                       | Refused with FATAL, exit 1                                                                        |
| Upgrade: a database created by 1.14.1 (schema 8) booted on 1.18.1       | Migrations 9–12 ran; schema 12; sample exam rewritten with items and stable ids                   |
| `npm audit --omit=dev` (server, client)                                 | Server: 0. Client: 2 moderate in react-router (item 9 below)                                      |
| `npm audit` including dev tooling (client)                              | Also flags build-time packages (`braces` via Tailwind's file watcher); never shipped to the Pi app |

## Architecture in one paragraph

One Node 22 process (Express) serves the API, the built React SPA and the
Template Studio, bound to loopback behind Caddy, which terminates HTTPS with
its internal CA on the Pi. State is one SQLite file in WAL mode
(`/var/lib/vlabs`), including uploaded images. Instructors and participants
authenticate with separate JWT audiences; every participant request is
re-validated against the live session, so ending a session revokes access
instantly. Lab content is delivered progressively (locked sections never
leave the server); exam answers and checkpoint answers never leave the
server. systemd runs the service hardened (read-only system, no
capabilities), a nightly timer takes online backups, and `update.sh` does
backup → pull → build → restart → health check with code rollback.

This is the right shape for a single classroom box: no external services, one
file to back up, nothing to keep in sync. Its natural ceiling is one machine
(see [scale](#scale-and-capacity)).

## What is in place (verified)

- **Secrets and boot guard rails**: weak/placeholder/identical JWT secrets and
  creating the bootstrap account with the public default password are fatal in
  production.
- **Authentication**: bcrypt; constant-work login for unknown users; failed
  login throttling; instructor tokens revoked by password change or reset;
  separate participant/instructor token audiences; HS256 pinned. Adding an
  instructor needs a signed-in instructor; only the admin account resets or
  removes accounts.
- **Session ownership**: any instructor can watch any session read-only; only
  its owner ends, extends, marks or changes it (`403 NOT_SESSION_OWNER`).
- **Session kill switch**: every participant request re-checks the session is
  live and the seat still exists.
- **Exam integrity**: exam seats are bound to the joining device; answers
  autosave (and flush on tab close); ending the session hands in every open
  exam; answer history is append-only.
- **IP protection**: progressive lab delivery; checkpoint answers, masks and
  exam answers never sent; `no-store` on content; no file downloads.
- **Browser hardening**: strict CSP without `unsafe-inline` or `unsafe-eval`
  (the Studio's buttons run through a small interpreter instead),
  `frame-ancestors 'self'` (only the template editor frames the Studio, same
  origin), HSTS, `nosniff`, no referrer; Markdown sanitised with DOMPurify;
  images type-sniffed server-side (no SVG/HTML); CSV exports neutralise
  spreadsheet formulas.
- **Sandboxed formulas**: a hand-written evaluator, no `eval`, whitelisted
  functions, length and depth caps; the Studio uses the same module.
- **Rate limiting** keyed on verified identity (seat / instructor), per-IP for
  anonymous routes; join brute-force and flood limits.
- **Data safety**: durable writes (`synchronous=FULL`); append-only template
  audit (DB triggers); sessions keep their own template copy, and pushing a
  new version moves work by stable id; archive-by-default; online backups;
  ordered, one-way migrations run on start.
- **Operations**: hardened systemd unit, graceful shutdown with WAL
  checkpoint, health endpoint used by Caddy and `update.sh`, code rollback on a
  failed update, structured logs without bodies or tokens, the Pi follows
  network changes (certificate and join addresses).

## Residual risks and recommendations

None of these block a LAN classroom deployment. Ordered by priority.

### Before go-live (operational, no code)

1. **Get backups off the SD card.** Nightly snapshots land on the same card as
   the database; a dead card loses both. Set `BACKUP_DIR` to a USB stick or
   network share in `/etc/vlabs/vlabs.env` and test one restore (DEPLOYMENT
   §1.7).
2. **Clock.** The Pi has no RTC. Without NTP at boot, its clock starts from the
   last shutdown; a later NTP jump can expire live sessions early (countdowns
   follow server time, but expiry itself is server time). Give the Pi network
   time at boot, or add an RTC module.
3. **Change the bootstrap password and create named accounts** (the portal
   nags until you do). Keep the admin account's password safe: it is the only
   one that resets others in the portal.
4. **DHCP reservation** for the Pi, so the certificate's IP list stays stable
   (it is also refreshed at every boot and network change).

### Known limitations (design trade-offs)

5. **One admin, everyone else equal.** Any signed-in instructor can add
   accounts and edit any template (templates are a shared workspace); only
   the admin account resets or removes accounts. Fine for a small trusted
   team; finer roles are listed in DEPLOYMENT §2.5.
6. **Lab seats resume by name only** (documented trade-off; exam seats are
   device-bound). Someone could open a classmate's lab seat by typing their
   name. Low impact for labs.
7. **Instructor sign-out is client-side.** A copied instructor token stays
   valid for up to 12 h unless the password is changed or reset. Acceptable
   on a LAN; for a hosted deployment add server-side "sign out everywhere"
   (bump `token_version`) or shorten `JWT_INSTRUCTOR_TTL`. **(hosted)**
8. **No data retention.** Sessions, participants and answers are kept until
   deleted by hand. Decide a retention period (especially for exam results)
   and either delete sessions after exporting or add a retention job.
   Deleting is irreversible.
9. **react-router advisories (moderate)**: an open redirect via backslash
   paths in `<Link>`/`navigate`, and an SSR hydration issue. Not reachable
   here: the only dynamic navigation target is router state set by the app,
   limited to portal paths, and there is no SSR. The fix is the breaking
   react-router v7 upgrade; plan it, don't force it.
10. **Exam anti-cheating features** are not in scope: no question or option
    shuffling, no per-student time limit (the session expiry is the limit),
    no lockdown or tab-switch detection. Use managed devices / Guided Access
    for high-stakes exams.
11. **Push after a Markdown re-import.** Stable ids are not written to
    Markdown, so a template re-imported from `.md` gets new ids and the next
    push into a live session matches work by position. Re-import from the
    Studio's `.zip` or `.json` to keep ids.

### Scale and capacity

12. **One machine, one process.** Rate limits live in memory and the database
    is a local SQLite file, so the app cannot be load-balanced across
    processes as is. Measured at 1.5.1: 100 concurrent exam seats autosaving
    plus monitor polling sustained ~600 req/s (p95 228 ms) in a container,
    roughly 30× a real class (Pi ≈ 3–5× slower). A session is capped at 100
    participants; several concurrent classes on one Pi are fine. Beyond one
    box (DEPLOYMENT Part 2) stay on a single VM.
13. **Room codes** are 6 digits with per-IP failed-join throttling, adequate
    on a LAN. On the internet a distributed guesser could find live codes;
    consider longer codes or join-by-link. **(hosted)**

### Monitoring

14. Only `/api/health` and the journal exist. For a single classroom box that
    is enough (the instructor sees problems immediately). For hosted use, add
    uptime monitoring on `/api/health`, disk-space alerting, and log
    shipping. **(hosted)**

## Go-live checklist

- [ ] `install.sh` run; `systemctl status vlabs caddy` both active
- [ ] Root certificate installed and fully trusted on every participant device
- [ ] Bootstrap password changed; named instructor accounts created
- [ ] `BACKUP_DIR` set to off-card storage; one restore rehearsed
- [ ] Pi has network time at boot (or an RTC); DHCP reservation set
- [ ] A dry run with two devices: join, complete a lab, take the sample exam,
      submit, mark, export
- [ ] `sudo apt install unattended-upgrades`; journald capped (DEPLOYMENT §1.7)
