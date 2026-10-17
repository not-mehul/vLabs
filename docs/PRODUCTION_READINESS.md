# vLabs production readiness audit

Scope: the whole system as of **1.5.1** — architecture, server, data layer,
authentication and authorisation, the lab and exam participant flows, the
instructor portal, the SPA, deployment on the Raspberry Pi (systemd, Caddy,
backups, updates) and CI. Audit date: 2026-10-16.

## Verdict

**Ready for classroom production on the Raspberry Pi**, with the operational
steps in [Go-live checklist](#go-live-checklist) done once. Every defect found
in this audit that affected correctness, data safety, security or operations
has been fixed and covered by tests (below). What remains are
[known limitations and recommendations](#residual-risks-and-recommendations):
design trade-offs and features to plan for, not blockers for a LAN classroom
deployment. A public/internet deployment needs the extra items marked
**(hosted)**.

## Re-check at 1.13.0

Date: 2026-10-17. 1.13.0 adds exam seats from a lab session and **Change
seat** on the exam monitor. No dependencies changed.

| Check                                                              | Result                                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Server test suite                                                  | 92 / 92 pass (new: lab seats, fallbacks, Change seat, unlinking)          |
| Client test suite and production build                             | 32 / 32 pass; build clean                                                 |
| Lint and format check (as CI)                                      | Clean                                                                     |
| Migration 8 on a 1.12.0 database                                   | Column added; deleting the linked lab sets it to NULL                     |
| Seat source and Change seat access                                 | Only the instructor's own lab sessions and own exam sessions are accepted |
| Browser (Chromium): launch with Seats from, join, Change seat      | Pass; taken seat refused, participant's page shows the new seat on poll  |

## Re-check at 1.12.0

Date: 2026-10-17. 1.12.0 changes the exam model (sections of mixed steps and
questions, short answers by exact match or pattern), so the exam paths were
checked again end to end:

| Check                                                                       | Result                                                                                                     |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Server test suite                                                           | 91 / 91 pass                                                                                               |
| Client test suite (incl. Studio ↔ vLabs parity) and production build        | 32 / 32 pass; build clean                                                                                  |
| Lint and format check (as CI)                                               | Clean                                                                                                      |
| `npm audit` (root, server, client)                                          | 0 high/critical; the moderate react-router advisory below is unchanged                                     |
| Browser (Chromium): sample exam taken page by page, ticks, pattern answer   | Pass; graded 7 / 12 with the long answer pending, as expected                                              |
| Browser: exam editor (every item type, retyping, pattern + placeholder)     | Pass; saved shape verified through the API                                                                 |
| Browser: Template Studio builder, preview self-check, exports, old workspace | Pass; no page errors                                                                                       |
| Exams and sessions stored before 1.12.0                                     | Read with the same answer keys (server and client tests)                                                   |
| Worst-case pattern matching (author mask with three `*`, long answers)      | Found 350 ms per grade on 500 characters, run on every monitor refresh; fixed: answers over 200 never fit |

Also fixed: the instructor sign-in page now only returns to a portal path
after login (hardening for the react-router advisory, item 11), and unused
code was removed.

## How this was audited

Not just a read-through — each claim below was exercised:

| Check                                                                  | Result                                                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Full code review of server, shared modules, client and deploy scripts  | Findings below                                                                                    |
| Server test suite (`npm test --prefix server`)                         | 81 / 81 pass                                                                                      |
| Client test suite and production build                                 | 18 / 18 pass; build clean                                                                         |
| Lint and format check (as CI)                                          | Clean                                                                                             |
| Production-mode boot (as CI): weak secrets / default password refused | Both refused with FATAL; healthy boot with real secrets; CSP, HSTS, nosniff present               |
| Load: 100 concurrent exam seats autosaving + instructor monitor polling | ~600 req/s sustained, p50 143 ms, p95 228 ms, p99 379 ms, 0 errors (container; Pi ≈ 3–5× slower) |
| Real classroom load estimate                                           | 100 seats ≈ 7–20 req/s — roughly 30× headroom                                                     |
| Browser end-to-end (Chromium): exam taken by clicking/typing, submit   | Pass                                                                                              |
| Browser end-to-end: exam seat device binding, release, exit flush      | Pass                                                                                              |
| Migration 5 → 6 against a real 1.5.0 database                          | History copied, old column cleared, `user_version` 6                                              |
| Backup taken from a running server → restore → boot                    | `integrity_check` ok, all rows present, healthy                                                   |
| `npm audit --omit=dev` (server, client)                                | 0 high/critical after fixes (one moderate, see below)                                             |

## Architecture in one paragraph

One Node 22 process (Express) serves the API and the built React SPA, bound to
loopback behind Caddy, which terminates HTTPS with its internal CA on the Pi.
State is one SQLite file in WAL mode (`/var/lib/vlabs`), including uploaded
images. Instructors and participants authenticate with separate JWT audiences;
every participant request is re-validated against the live session, so ending
a session revokes access instantly. Lab content is delivered progressively
(locked sections never leave the server); exam answers and checkpoint answers
never leave the server. systemd runs the service hardened (read-only system,
no capabilities), a nightly timer takes online backups, and `update.sh` does
backup → pull → build → restart → health check with code rollback.

This is the right shape for a single classroom box: no external services, one
file to back up, nothing to keep in sync. Its natural ceiling is one machine —
see [scale](#scale-and-capacity).

## Defects found and fixed in this audit

| #   | Severity | Area           | Finding                                                                                                                                                                                                                                                                                                                                                                      | Fix                                                                                                                                                                                       |
| --- | -------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | High     | Dependencies   | `npm audit` (server, production deps): **critical** proxy-addr IP spoofing, **high** compression DoS, moderate qs. CI's `--audit-level=high` step would fail.                                                                                                                                                                                                              | Non-breaking `npm audit fix` in server, client and root; 0 high/critical remain.                                                                                                          |
| 2   | High     | Exam integrity | Rejoining by name resumed the seat. In an exam, anyone who knew a classmate's name and the room code could open their exam, change their answers or submit it.                                                                                                                                                                                                              | Exam seats are bound to the joining device by a random resume key (stored hashed); rejoining without it → `SEAT_TAKEN`. Instructor **Move to another device** releases a seat and signs the old device out (seat `token_version`). Labs unchanged. |
| 3   | High     | Performance / SD wear | Every exam autosave re-serialised the participant's whole answer history (up to ~0.5 MB) and, with `synchronous=FULL`, fsynced it. A class typing long answers would write tens of MB/s to the SD card.                                                                                                                                                             | History moved to an append-only `exam_answer_events` table (one small row per change, capped per question). Migration 6 copies existing history.                                         |
| 4   | Medium   | Exam operations | No way to undo an accidental submission, move a student whose device died, or remove a mistaken registration (labs or exams).                                                                                                                                                                                                                                            | Instructor actions: **Reopen exam**, **Move to another device**, **Remove participant**, with API routes and tests.                                                                       |
| 5   | Medium   | Data loss      | Templates are shared, but saving was last-write-wins: two instructors editing the same lab/exam silently discarded one's changes.                                                                                                                                                                                                                                         | Editors send `expected_version`; a stale save gets `409 VERSION_CONFLICT`.                                                                                                                |
| 6   | Medium   | Operations     | `render-caddy.sh` relied on a boot unit `vlabs-caddy-refresh.service` that did not exist: a Pi that came up with a new DHCP address served a certificate without its new IP.                                                                                                                                                                                              | Unit added; installed and enabled by `install.sh`/`update.sh`, removed by `uninstall.sh`, verified in CI.                                                                                 |
| 7   | Medium   | Resilience     | No React error boundary: any rendering error blanked the whole page (mid-exam included), including the stale-chunk error after an update.                                                                                                                                                                                                                                  | Top-level error boundary with Reload (progress is server-side).                                                                                                                           |
| 8   | Medium   | Correctness    | Countdowns used the device clock; a device (or instructor laptop) with a wrong clock showed the wrong time remaining or "expired".                                                                                                                                                                                                                                        | Server time returned by `/status`, `/content`, `/exam` and session detail; countdowns correct for the offset.                                                                            |
| 9   | Medium   | Exam data      | A typed answer still waiting for its 0.8 s autosave debounce was lost if the tab was closed or the iPad locked.                                                                                                                                                                                                                                                           | Pending answers are flushed on `pagehide` / hidden with `fetch(keepalive)`; verified by closing the tab mid-debounce.                                                                     |
| 10  | Low      | Security config | `CORS_ORIGINS=` (empty, as the installer writes it) fell back to allowing `http://localhost:5173` in production.                                                                                                                                                                                                                                                        | Empty means none; production default is none.                                                                                                                                             |
| 11  | Low      | Robustness     | Handlers that read-modify-write a participant's JSON columns used the row loaded before the async rate limiter. Not exploitable today (verified with concurrent requests), but any future async step would have caused lost updates.                                                                                                                                      | Mutating handlers re-read the row before writing; exam answer writes are a transaction.                                                                                                  |
| 12  | Low      | SD wear        | Every status poll wrote `last_seen_at` (an fsync per seat every 15 s).                                                                                                                                                                                                                                                                                                    | Presence written at most every 10 s per seat (presence threshold is 90 s).                                                                                                                |
| 13  | Low      | CI             | CI only ran on pushes to `main` and `claude/**`.                                                                                                                                                                                                                                                                                                                          | `smarty/**` added.                                                                                                                                                                        |

Fixed earlier in 1.5.0 and re-verified here: SQLite `synchronous=NORMAL` in
WAL mode losing recent writes on power loss (now `FULL` + checkpoint after
account writes); misaligned seat numbers; unstyled checkpoint input; a
variable-shadowing crash in the exam statistics code.

## What is already done well (verified)

- **Secrets and boot guard rails**: weak/placeholder/identical JWT secrets and
  creating the bootstrap account with the public default password are fatal in
  production.
- **Authentication**: bcrypt; constant-work login for unknown users; failed
  login throttling; instructor tokens revoked by password change or reset;
  separate participant/instructor token audiences; HS256 pinned.
- **Session kill switch**: every participant request re-checks the session is
  live and the seat still exists.
- **IP protection**: progressive lab delivery; checkpoint answers, masks and
  exam answers never sent; `no-store` on content; no file downloads.
- **Browser hardening**: strict CSP without `unsafe-inline`, `frame-ancestors
'none'`, HSTS, `nosniff`, no referrer; Markdown sanitised with DOMPurify;
  images type-sniffed server-side (no SVG/HTML); CSV exports neutralise
  spreadsheet formulas.
- **Sandboxed formulas**: a hand-written evaluator, no `eval`, whitelisted
  functions, length and depth caps.
- **Rate limiting** keyed on verified identity (seat / instructor), per-IP for
  anonymous routes; join brute-force and flood limits.
- **Data safety**: durable writes; append-only template audit (DB triggers);
  sessions keep their own template copy; archive-by-default; online backups;
  ordered, idempotent migrations.
- **Operations**: hardened systemd unit, graceful shutdown with WAL
  checkpoint, health endpoint used by Caddy and `update.sh`, code rollback on a
  failed update, structured logs without bodies or tokens.

## Residual risks and recommendations

None of these block a LAN classroom deployment. Ordered by priority.

### Before go-live (operational, no code)

1. **Get backups off the SD card.** Nightly snapshots land on the same card as
   the database; a dead card loses both. Set `BACKUP_DIR` to a USB stick or
   network share in `/etc/vlabs/vlabs.env` and test one restore (DEPLOYMENT
   §1.7).
2. **Clock.** The Pi has no RTC. Without NTP at boot, its clock starts from the
   last shutdown; a later NTP jump can expire live sessions early (countdowns
   now follow server time, but expiry itself is server time). Give the Pi
   network time at boot, or add an RTC module (≈ €5).
3. **Change the bootstrap password and create named accounts** (the portal
   nags until you do).
4. **DHCP reservation** for the Pi, so the certificate's IP list stays stable
   (now also refreshed at every boot).

### Known limitations (design trade-offs)

5. **Flat instructor permissions.** Every instructor can add, reset or remove
   any instructor, and therefore take over another's account and sessions.
   Fine for a small trusted team; add an admin role before accounts go to
   people you don't trust equally (DEPLOYMENT §2.5).
6. **Lab seats resume by name only** (documented trade-off; exam seats are now
   device-bound). Someone could open a classmate's lab seat by typing their
   name. Low impact for labs; the same device-binding could be extended to labs
   if needed.
7. **Instructor sign-out is client-side.** A copied instructor token stays
   valid for up to 12 h unless the password is changed. Acceptable on a LAN;
   for a hosted deployment add server-side "sign out everywhere" (bump
   `token_version`) or shorten `JWT_INSTRUCTOR_TTL`. **(hosted)**
8. **No data retention.** Sessions, participants and answers are kept until
   deleted by hand. Decide a retention period (especially for exam results)
   and either delete sessions after exporting or add a retention job. Note that
   deleting is irreversible.
9. **Pushing a new exam version mid-exam** keys saved answers by question
   position within its section (and ticks by checklist position); the
   monitor warns, but only push typo fixes, never reordering.
10. **Exam anti-cheating features** are not in scope today: no question or
    option shuffling, no per-student time limit (the session expiry is the
    limit), no lockdown or tab-switch detection. Use managed devices / Guided
    Access for high-stakes exams.
11. **react-router advisory (moderate)**: open redirect via backslash paths in
    `<Link>`/`navigate`, and an SSR issue. Not reachable here (the only
    dynamic navigation target is router state set by the app, now limited to
    portal paths; no SSR). Fixing it requires the breaking react-router v7
    upgrade — plan it, don't force it.

### Scale and capacity

12. **One machine, one process.** Rate limits live in memory and the database
    is a local SQLite file, so the app cannot be load-balanced across
    processes as is. Measured headroom is ~30× a full 100-seat class; a
    session is capped at 100 participants. Several concurrent classes on one
    Pi are fine. Beyond one box (the partner hosting in DEPLOYMENT Part 2)
    stay on a single VM — horizontal scaling would need a shared rate-limit
    store and a server database.
13. **Room codes** are 6 digits with per-IP failed-join throttling — adequate
    on a LAN. On the internet a distributed guesser could find live codes;
    **(hosted)** consider longer codes or join-by-link.

### Monitoring

14. Only `/api/health` and the journal exist. For a single classroom box
    that is enough (the instructor sees problems immediately). For hosted
    use, add uptime monitoring on `/api/health`, disk-space alerting, and log
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
