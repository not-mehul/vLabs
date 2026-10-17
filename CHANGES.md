# vLabs — change log

Newest entry at the bottom (1.15.0). The first section is the original code
review change set, kept for the record.

## 1.1.0 — code review change set

**No new npm dependencies were added anywhere**, so `package-lock.json` files
are untouched. Node **22** is now assumed everywhere (CI, Docker, `engines`).

## Decisions taken (from your answers)

| Question                                | Decision                                                                                                                                                                                            | Where                                                                                                          |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Template edited during a live session   | **Frozen at launch.** Session monitor shows "v*N* available" with a **Push latest version** button (with a warning about reordering). Participants pick up a push within ~15 s via the status poll. | `sessions` snapshot columns, `POST /sessions/:id/push-template`, `SessionMonitor.jsx`, `Lab.jsx`               |
| Deleting a template with ended sessions | **Archive (hide) by default; restore possible; permanent delete allowed with a warning + typed confirmation**, refused while sessions are active. Sessions keep their own copy; audit survives.     | `templates.archived_at`, `DELETE /templates/:id[?permanent=1]`, `POST /templates/:id/restore`, `Templates.jsx` |
| Seat rejoin                             | **Name-only, unchanged.** Documented as a known trade-off in the README.                                                                                                                            | —                                                                                                              |
| Default seed password in production     | Refuse to **create** the bootstrap account with the default; existing deployments unaffected. New **Account → Change password** page; changing it revokes older tokens.                             | `index.js`, `PUT /auth/password`, `Account.jsx`                                                                |
| Expired-but-never-terminated sessions   | Swept to _ended_ 60 min after expiry (configurable) so codes recycle.                                                                                                                               | `lib/sessionLifecycle.js`                                                                                      |
| Content deterrents                      | Print-hiding CSS only; README wording corrected.                                                                                                                                                    | `styles.additions.css`                                                                                         |

## What changed, by finding

### High priority

1. **Compose placeholder secrets bypassed the prod guard** → `config.isWeakSecret` judges length (< 32) and placeholder markers; identical secrets also fatal. `docker-compose.yml` uses `${VAR:?required}` so it cannot start without real values.
2. **Default seed password** → fatal in production when the bootstrap account would be created; password-change endpoint + UI; `token_version` on instructors for revocation; portal banner until changed.
3. **Rate limiters keyed on the unverified bearer string** → keyed on the _verified_ identity (`identifyToken`); per-seat limiters mounted after `requireParticipant`; new per-IP join flood cap (300 / 5 min) alongside the failed-join cap (20 / 5 min); IPv6 /64 bucketing.
4. **Hard-coded `trust proxy: 1`** → `TRUST_PROXY` env (default off), warning in production when unset, documented.
5. **Template DELETE cascaded to sessions** → `sessions.template_id` nullable with `ON DELETE SET NULL` (table rebuild migration), archive-by-default.
6. **Sessions rendered from the live template** → per-session snapshot (`template_title/content/variables/template_version`), explicit push.
7. **`Lab.jsx` refetch loop on resume** → `useState(() => location.state || participantSession.get())`.

### Medium

- **Unknown placeholders** rejected at save time (server) with precise locations, and flagged live in the editor (client) via the shared `findUnknownPlaceholders`.
- **`/hint` reachability gate** — all participant actions now go through one `requireReachableStep`.
- **Markdown import/export** — fence-aware parser; multi-line hints; `\::` / `\|` escapes; `> placeholder:` directive; alternative answers; lossless round-trip with tests.
- **Three duplicated normalisers** → one `shared/template-schema.js` used by server validation, client importer and editor `coerce`.
- **Destructive ad-hoc migrations** → `PRAGMA user_version` runner (`MIGRATIONS[]` in `db/index.js`), legacy drop only ever runs once.
- **Expression language** — `pad`, `hex`, `floor`, `ceil`, `round`, `abs`, `mod`, `min`, `max`, `upper`, `lower`, `str`; div/mod-by-zero errors; length/depth caps; multi-answer checkpoints (`checkpoint.answers[]`).
- **Graceful shutdown** — `closeIdleConnections`, 8 s force timeout, `db.close()`; `keepAliveTimeout` 5 s; compose `init: true` + `stop_grace_period`.
- **Logging** — dependency-free structured logger (`lib/logger.js`), per-request lines (no bodies/tokens), lifecycle/audit events.
- **Health check** runs `SELECT 1` (503 on failure).
- **Expired sessions** swept (list/create + 10-min timer).
- **CSP** — `styleSrc 'self'` (no `unsafe-inline`), `baseUri 'none'`, `fontSrc 'self'`, `no-referrer`; DOMPurify strips `style`/form elements.
- **Accessibility** — pinch-zoom re-enabled; stepper is a `<nav>` of buttons with `aria-current="step"`; real `role=tab`/`aria-selected` in the editor; `role=alert` / live regions for errors; progress bars carry ARIA values; skip link.
- **Join** validates a stored session with `/status` instead of `/content`.
- **Prepared statements** hoisted to module scope in every route/middleware.
- **`requireInstructor`** no longer masks DB errors as 401.
- **`express.json` limit** 1 MB with a readable validator cap (900 kB) below it.
- **Prettier** config added; `format:check` in CI; **client tests** (`node:test`, no new deps); CI on Node 22 with `npm audit`, Docker build + smoke test; Dependabot.
- **README** rewritten (API, data model, config, upgrade notes, corrected deterrent wording, formula helpers).

### Not changed on purpose

- Seat rejoin stays name-only (your call).
- `client/src/styles.css` is untouched; new rules live in `styles.additions.css` (imported from `main.jsx`).
- `client/src/components/Icon.jsx`, `StepCard.jsx`, `HintBox.jsx`, `SolutionBox.jsx`, `ThemeToggle.jsx`, `ThemeContext.jsx`, `InstructorLogin.jsx`, `hooks/useInstructorApi.js`, `lib/datetime.js`, `server/src/lib/time.js`, `server/tests/time.test.js`, `server/package.json`, `.gitignore`, `.dockerignore` — unchanged.

## Manual steps after applying

1. `npm run format` once from the repo root (CI now enforces `format:check`; the
   new files follow the `.prettierrc` style but the untouched ones may not).
2. `npm run lint && npm test` from the repo root.
3. **Run `server/tests/api.test.js` locally.** The sandbox this change set was
   produced in has no package registry access, so the HTTP integration suite
   could not be executed there (it is syntax-checked and written against the
   same behaviour the passing unit tests cover). The templating and client
   format suites were run and pass (21/21 and 10/10).
4. Before deploying over an existing database: **back up the SQLite volume**.
   First boot runs migration 2 (sessions table rebuild + back-fill).
5. Set `JWT_INSTRUCTOR_SECRET`, `JWT_PARTICIPANT_SECRET`,
   `SEED_INSTRUCTOR_PASSWORD` and `TRUST_PROXY` in your deployment environment;
   compose will not start without the first three.

## API changes to be aware of

- `DELETE /api/templates/:id` now **archives**. Use `?permanent=1` to delete.
- `GET /api/templates` hides archived templates unless `?include_archived=1`; rows gain `archived_at`, `session_count`, `active_session_count`.
- `POST /api/sessions` returns `409` for an archived template; session objects gain `template_version`, `latest_template_version`, `update_available`; detail gains `template_exists`, `template_archived`.
- New: `POST /api/sessions/:id/push-template`, `POST /api/templates/:id/restore`, `GET /api/templates/functions`, `GET /api/auth/me`, `PUT /api/auth/password`.
- Participant `join`/`content`/`status` include `template_version`.
- Validation errors include `details: string[]`; instructor 401 may carry `code: "TOKEN_REVOKED"`.
- Templates may carry `checkpoint.answers: string[]` (alternatives).

## Deployment add-on (2026-10-01)

Added for the Raspberry Pi pilot and the later hosted deployment (see `DEPLOYMENT.md`):

- `SERVE_PLAIN_HTTP` (config/app/index): drops the CSP `upgrade-insecure-requests` directive and HSTS for TLS-less LAN pilots. Without it the app cannot load from `http://<lan-ip>` — browsers upgrade every `/api` call to HTTPS. Never enable on the internet.
- `deploy/docker-compose.prod.yml` — app + Caddy; TLS mode chosen by `CADDYFILE` (`Caddyfile.http` / `.internal` / `.public` / `.dns01`), `deploy/docker-compose.dns01.yml` + `deploy/caddy/Dockerfile.dns01` for DNS-01 certificates on a LAN, `deploy/.env.example`.
- `deploy/backup.sh` + `server/scripts/backup.js` — consistent online SQLite backups (backup API), pruned, copied out of the volume.
- `server/scripts/instructors.js` — `list` / `create` / `reset-password` (interim admin path; revokes tokens on reset).
- `deploy/pi/vlabs.service` — bare-metal systemd alternative.
- `.github/workflows/release.yml` — multi-arch (amd64 + arm64) image to GHCR so the Pi and the VPS run the same artefact.
- `Dockerfile` now copies `server/scripts/`; root `docker-compose.yml` and `.env.example` pass `SERVE_PLAIN_HTTP` through.

## 1.2.0 — two run modes: Mac dev, Pi bare-metal (2026-10-01)

### Repair first

Commit `375f11c` ("Major code updates") replaced the tree with the review
archive above, which deliberately omitted files it listed as _unchanged_. 26
files the code still imports were therefore missing from the repository:
`server/package.json`, all three `package-lock.json`s, `.gitignore`,
`client/src/styles.css`, `Icon.jsx`, `StepCard.jsx`, `HintBox.jsx`,
`SolutionBox.jsx`, `ThemeToggle.jsx`, `ThemeContext.jsx`, `InstructorLogin.jsx`,
`useInstructorApi.js`, `datetime.js`, `server/src/lib/time.js`,
`server/tests/time.test.js` and the README screenshots. All restored verbatim
from `3167992`. (`.dockerignore` and `.prettierrc.json` were not restored —
Docker is gone and `.prettierrc` supersedes the JSON variant.)

### Removed

Docker is no longer a supported path: `Dockerfile`, `docker-compose.yml`,
`deploy/docker-compose.prod.yml`, `deploy/docker-compose.dns01.yml`,
`deploy/caddy/*`, `deploy/.env.example`, `deploy/backup.sh`,
`.github/workflows/release.yml` (GHCR images) and the Docker job in `ci.yml`.
Migrating an existing Docker database: copy `vlabs.sqlite` out of the
`vlabs-data` volume to `/var/lib/vlabs/vlabs.sqlite` before the first start.

### Mac — development

- Root `package.json`: `npm run setup` (installs root/server/client),
  `npm run dev`, `npm run build`, `npm start`; version 1.2.0; `engines` ≥ 22
  everywhere.
- `scripts/dev.js` — dependency-free launcher running `node --watch` (API) and
  Vite side by side with prefixed output; Ctrl-C stops both, one dying stops
  the other.
- `server/src/config.js` now loads **`<repo>/.env`** explicitly (not the
  cwd's), so the same file works from the root, from `server/`, and is
  irrelevant under systemd (real env wins). New `HOST` (default `127.0.0.1`).
- `server/src/index.js` listens on `config.host`; prints a dev hint to open
  the Vite URL.
- `client/vite.config.js` proxies to `127.0.0.1:4000` (not `localhost`, which
  Node 22 may resolve to `::1`).
- `.env.example` rewritten for the two modes; `eslint.config.js` lints
  `scripts/`.

### Raspberry Pi — bare metal + systemd + Caddy (internal CA)

`deploy/pi/`:

- `install.sh` — idempotent one-shot: Node 22, Caddy, Avahi; `vlabs` system
  user; `/etc/vlabs/vlabs.env` with generated secrets and first-login
  password; `npm ci` + `vite build` as the admin user; renders and validates
  the Caddyfile; installs/enables the units; health-waits; publishes the root
  cert. Prompts or env vars (`VLABS_HOSTNAME`, `VLABS_EXTRA_ADDRESSES`, …).
- `vlabs.service` — Node on `127.0.0.1:4000`, `EnvironmentFile=/etc/vlabs/vlabs.env`,
  `StateDirectory=vlabs`, `ProtectSystem=strict`, empty capability set,
  `TimeoutStopSec=15` (matches the 8 s graceful shutdown), `Wants=caddy.service`.
- `Caddyfile.template` — `https://<name>.local[, https://<ip>…]` with
  `tls internal`, health-checked `reverse_proxy 127.0.0.1:4000`, rotated
  access log; an explicit `http://` site that serves `/vlabs-root.crt` and
  308-redirects everything else to HTTPS.
- `export-root-cert.sh` — copies Caddy's root to `/srv/vlabs-public` and the
  cwd, prints the fingerprint and per-platform install steps.
- `update.sh [ref]` — backup → fast-forward pull → install → build → refresh
  units → restart → health check, with automatic code rollback on failure.
- `backup.sh` + `vlabs-backup.service` / `.timer` — nightly 02:30 consistent
  snapshot (persistent timer), optional `BACKUP_DIR` off-device copy.
- `vlabs-cli.sh` — runs `server/scripts/{instructors,backup}.js` as the
  service user with the production env (so it hits the real DB).

CI gained a `production-smoke` job (prod deps, `NODE_ENV=production`, real
secrets, `/api/health` + served SPA) and a `systemd-analyze verify` of the
units. Docs: README quick start / hosting / configuration / deployment
sections and DEPLOYMENT.md Part 1 rewritten; Part 2 adjusted to reuse the
same scripts on a VPS with a public Caddy site block.

## 1.3.0 — info steps, participant-name variables, pattern checkpoints (2026-10-01)

### Informational steps

- New step type `info` alongside `desk` and `computer`: title + Markdown body
  only. The shared normaliser strips hints, solution and checkpoint, so an
  info step can never block progress; the renderer tags it `type: 'info'`.
- Editor: third **Info** chip; hint/solution/checkpoint panels hide for info
  steps. Participant card: neutral "Read" tile with a dashed accent.
- Markdown: `## [info] Title`.

### Participant names as variables

- Built-in placeholders `{{ FIRST_NAME }}`, `{{ LAST_NAME }}`, `{{ FULL_NAME }}`
  and formula identifiers `first_name`, `last_name` (strings), all reserved as
  variable names.
- New pure helpers `slug(s)` (lower-case letters/digits only) and
  `initials(s)` — e.g. `USERNAME = slug(first_name) + '.' + slug(last_name)`.
- `resolveVariables(variables, seat, { firstName, lastName, captured })`;
  every participant route passes the registered names. Validation evaluates
  formulas for a sample participant. The instructor preview accepts
  `first_name` / `last_name` (defaults "Sample Participant").

### Pattern checkpoints + captured values

- Checkpoints gain `mode: 'exact' | 'pattern'`. Pattern checkpoints carry a
  **mask** instead of answers: `9` digit, `A`/`a` letter (upper/lower on
  output), `X`/`x` letter-or-digit, `?` any visible character, `*` anything
  (max 3), `\c` literal; other letters/digits are required literals;
  punctuation/whitespace are optional separators restored in the canonical
  value. `compileMask` / `matchMask` / `maskExample` live in the shared schema
  so the editor shows a live example. No regex is ever authored or executed.
- Any checkpoint may `capture: NAME`. On success the canonical value (mask
  form for patterns, the resolved authored answer for exact ones) is stored in
  a new `participants.captured_values` JSON column (migration 3) and injected
  as `{{ NAME }}` into every later step, hint, solution, prompt and exact
  answer. Captures never shadow variables/built-ins and are placeholders only
  (not formula identifiers).
- Order-aware validation: `findUnknownPlaceholders` now walks fields in
  reading order and flags a capture used before its checkpoint (`early: true`;
  the editor banner and the save error say so). Capture names must be valid
  identifiers, not reserved/helper names, not declared variables, and unique.
- Rendered checkpoints ship `mode` so the client can phrase a format error;
  the mask, like answers, never leaves the server.
- Monitor: one column per captured variable (`capture_names` on the session
  detail); CSV/JSON export: one `captured` key/column per variable.
- Markdown: `> checkpoint: prompt` (no `::`) + `> pattern: MASK`, and
  `> capture: NAME` on any checkpoint. Lossless round-trip tested.

### Sample lab

The seeded template and the editor's downloadable sample now open with an
info step greeting `{{ FIRST_NAME }}`, ask for the switch serial via a
`XXXX.XXXX.XXXX` pattern checkpoint captured as `SERIAL`, and reference it in
later steps. Existing databases keep their old copy of the sample.

### Tests

`server/tests/templating.test.js` +6 (names, captures, masks, pattern
matching, info steps, validation rules), `server/tests/api.test.js` updated
for the new seed flow plus an end-to-end pattern → capture → later-step test,
`client/tests/templateFormat.test.js` +2.

### Docs

- `docs/TEMPLATE_GUIDE.md` — the complete authoring reference (model,
  Markdown syntax, rules, formulas, masks, captures, delivery behaviour,
  limits, error catalogue, checklist, four validated example templates, JSON
  format). Linked from the README.
- Mask fix found while validating the guide's examples: an **escaped**
  character (`\.`, `\/`) is now a _required_ literal; previously escaping
  only disabled wildcard meaning and the punctuation stayed optional, so
  `*\/pull\/*` accepted `…/pulls/42`.

## 1.4.0 — images, instructor monitor overhaul, completion fix (2026-10-02)

### Image library

- New instance-wide library: `POST /api/images?name=…` (raw body, type
  sniffed from magic bytes — PNG/JPEG/GIF/WebP ≤ 3 MB; HTML/SVG rejected),
  `GET /api/images` (list), `GET /api/images/:id/references`,
  `DELETE /api/images/:id` (409 while a template or active session uses it).
  Served publicly at `GET /api/images/<random id>/<name>`, cacheable;
  replacing a name issues a new id. Blobs live in SQLite (`images` table) so
  backups carry them.
- Markdown references images **by file name**: `![alt](rack.png)` (folders
  ignored, case-insensitive). `injectImages` rewrites references to URLs at
  render time, after placeholders — so `![b](bench-{{ SEAT_ID }}.png)` picks a
  per-seat file. The name → URL map rides on the context under a Symbol.
- Validation refuses to save a template that references an image missing
  from the library (location reported). Editor: **Settings → Images** panel
  (upload/drag-drop, thumbnails, copy-snippet, delete with reference check),
  a missing-images banner after `.md` import with **Upload missing**, and
  import lands on Settings when images are needed.
- Client sanitiser drops `<img>` sources other than `/api/images/…` and
  `data:image/…` (shown as "(unavailable)" instead of a broken icon).

### Instructor monitor

- **Where everyone is**: one card per section (seats here / seats past, step
  and checkpoint counts) plus a Complete card, replacing the bar list.
- Participant table reduced to **# · Participant · Section (with title) ·
  Progress · Time on section · Status**; rows still colour slow (8 min) /
  stuck (15 min) / complete; click (or Enter) opens a **slide-over** with
  totals, time per section (bars), every checkpoint with the accepted answer
  and all wrong attempts as typed, hints opened, solutions revealed and
  captured values. Live-refreshes every 5 s; Esc / scrim closes.
- New `GET /api/sessions/:id/participants/:pid`; session detail gains
  `complete_count`, per-section `checkpoint_count` / `seats_past`; export gains
  `complete`, `completed_at`, `wrong_attempts`, `section_seconds`.

### Tracking + completion fix

- `participants.checkpoint_log` records every attempt (`{k, a, ok, at}`,
  capped at 200; re-submitting a cleared checkpoint is idempotent and not
  logged). `section_times` accumulates seconds per section when the
  participant moves; the open visit is added live.
- **Bug fixed:** a participant who cleared everything but kept reviewing was
  shown as still on the last section. `completed_at` is now set server-side
  the moment the manual is cleared (last checkpoint, or opening a
  checkpoint-free final section); status becomes _Complete_, the clock
  freezes (total time = joined → completed, later visits not accumulated),
  "time on section" shows —. `finished_at` still records pressing Finish.
  `/content` and `/status` expose `completed` alongside `finished`.
- Migration 4 (additive): `images` table; `participants.checkpoint_log`,
  `section_times`, `completed_at` (back-filled from `finished_at`).

### UI consistency + laptop / iPad pass

Reviewed every screen against a laptop (1280–1440) and iPad (1024 landscape,
768–834 portrait) and made the stylesheet responsive and touch-friendly:

- Breakpoints 1024 / 900 / 820 / 640 / 480 replace the single 800 px rule:
  editor preview stacks below 1024; secondary table columns hide in priority
  order (`col--lg` / `col--md` / `col--sm`) and every table sits in a
  horizontally scrolling `.table-wrap`; primary nav drops to its own row on
  tablets; monitor stats become a 2×2 grid with actions below; drawer goes
  full-width with safe-area padding; checkpoint input + Unlock, section nav,
  hint/variable rows and the create-session row stack on narrow widths.
- `@media (pointer: coarse)`: 44 px buttons (40/36 for sm/xs), 44 px icon
  buttons, taller chips/tabs/hint toggles/stepper nodes, 16 px inputs and
  textareas (no iOS focus zoom), hover styles neutralised.
- Base: `-webkit-text-size-adjust`, `touch-action: manipulation`, tap
  highlight off, `overscroll-behavior`, safe-area insets on headers/content,
  `prefers-reduced-motion`, consistent `min-height` on buttons/inputs, a
  real chevron on `<select>`, shared `--panel-pad` so panels/cards/editor
  sections/stat rows line up, fluid `clamp()` headings, banner colours bound
  to the theme's brand variable (they were hard-coded to light-mode blue).
- Drawer locks background scroll (`body.has-drawer`); section cards use a
  quieter accent for "seats here".

### Exports

- JSON export now includes a `sections[]` / `checkpoints[]` index, and per
  participant `section_times[]` (seconds per section with titles),
  `checkpoints[]` (cleared, accepted answer as typed, attempt count, every
  wrong attempt with timestamp), `hints_opened[]`, `solutions_revealed_list[]`,
  plus a flat chronological `attempts[]` log across the class.
- Participant CSV (`<session>-participants.csv`) adds `status`, one
  `time_s<N>_<title>` column per section, and per checkpoint
  `cp_<s.i>_cleared / _answer / _attempts / _wrong`, plus readable
  `hints_opened` and `solutions_revealed_list` columns — built from the
  export's own index so every row has the same shape.
- New **Attempts CSV** button (`<session>-attempts.csv`): one row per
  checkpoint submission, correct and incorrect, in time order.

### Pi: bare-IP access + install guard

- `deploy/pi/render-caddy.sh` renders the Caddyfile for `<hostname>.local`,
  every IPv4 the Pi currently holds and any extras, and reloads Caddy; the
  installer uses it, so `https://<pi-ip>` works on devices without mDNS.
- `install.sh`/`update.sh` refuse to (re)start the unit unless
  `server/node_modules/express` is readable by the `vlabs` user (the
  `ERR_MODULE_NOT_FOUND` restart loop), printing the fix.

- `deploy/pi/uninstall.sh` fully reverses the installer (keeps a final DB
  snapshot in `/root`; `--purge` also removes Caddy + Node). Installer now
  re-owns `/var/log/caddy` and `/var/lib/caddy` explicitly (a rerun after a
  teardown left them root-owned and Caddy could not open its access log).

### Favicon + home-screen polish

- Original app mark (the header's gradient tile + chevron) as
  `client/public/favicon.svg`, `favicon.ico` (16/32/48), `apple-touch-icon.png`
  (180), `icon-192/512.png`, a maskable 512 and `manifest.webmanifest`
  (standalone display, brand theme colour). `index.html` links them, sets
  light/dark `theme-color`, `color-scheme`, `viewport-fit=cover` (safe-area
  insets) and the `apple-mobile-web-app-*` metas so "Add to Home Screen" on a
  classroom iPad opens vLabs full-screen.
- Static cache policy: only content-hashed `/assets/*` are immutable; root
  files (icons, manifest) get a 1-hour TTL.

### Docs

`docs/TEMPLATE_GUIDE.md`: new **Links** and **Images** sections (syntax,
rules, per-seat images, portability), completion semantics, limits, error
catalogue and checklist updated. README: highlights, API, data model,
upgrade notes.

## 1.5.0 — exams, instructor accounts, Template Studio look (2026-10-16)

### Fixes

- **Password changes could be lost on a Pi reboot.** better-sqlite3 is built
  with `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1`, so every start after the first ran
  WAL mode with `synchronous=NORMAL`: commits were not fsynced until the next
  checkpoint (≈1000 pages — days on a quiet Pi). Pulling the power rolled back
  recent writes such as a password change. Now `synchronous=FULL`, plus a WAL
  checkpoint after every instructor-account write. The start-up "default
  password" warning now reads the database (it used to print after every
  restart from the env var alone, which looked like the change had been lost),
  and `must_change_password` means "still on a temporary password"
  (`password_changed_at IS NULL`).
- Seat-number pill in the monitor table was misaligned: `.seat-num`
  (`inline-grid`) sat on the `<td>` itself and took it out of table layout. It
  is now a span inside a centred `.col--seat` cell.
- The lab checkpoint input had no field styling (rendered as a browser
  default box).

### Instructor accounts

- New **Instructors** page: list, add (generated one-time temporary password
  or a chosen one), reset a colleague's password (signs them out everywhere),
  remove (their sessions move to you; you can't remove yourself).
- Unlinked **`/instructor/add`** page, reached by URL or a discreet link under
  the sign-in form: an existing instructor's username + password authorise the
  new account, so the page grants nothing by itself. Rate-limited like login.
- API: `GET/POST /auth/instructors`, `POST /auth/instructors/:id/reset-password`,
  `DELETE /auth/instructors/:id`.

### Labs

- Templates are written in **vLabs Template Studio** and imported (`.zip`
  package with images, `.md`, `.json`). The portal's lab editor is now a
  minimal typo editor: every text field is editable, structure is read-only;
  find-in-steps filter, preview, images and change history kept. The lab
  template format and its parser are unchanged.
- **Progress**: a section counts as done once the participant has moved past
  it, and reviewing it never shows it as in progress again. The monitor places
  seats by their _furthest_ section (time on section = time on that section);
  the exact section being viewed is shown only in the participant drawer.
- **Optional / wrap-up sections** (title contains optional, bonus, extra
  credit, stretch, wrap up…) are excluded from progress and completion
  (`shared/lab-progress.js`); tagged in the stepper and the monitor.
- **Hints**: every hint label is listed in a hints panel with a viewed
  counter; open any, in any order. The solution still needs every hint opened.

### Examination mode (new)

- New template kind `exam` with its own schema (`shared/exam-schema.js`) and
  Markdown format (`shared/exam-format.js`): single choice, select-all,
  true/false, short answer (auto-graded against accepted answers, else by
  hand) and long answer (by hand). Pluggable question-type registry.
- Participant exam page: all questions available, autosave, review page with
  unanswered list, submit lock; correct answers and scores never sent.
- Exam monitor: per-question stats (click to mark every response to a
  question), per-participant scores (provisional while marking is pending),
  participant drawer with options/expected/response/history and
  Correct / Incorrect / Clear marks. Exports: results CSV, answer key CSV,
  answer-log CSV, JSON.
- Exam editor in the portal (sections, questions, options, correct answers,
  points; Markdown/JSON import/export; participant-view preview). A sample
  exam is seeded on fresh installs. Guide: `docs/EXAM_GUIDE.md`.
- Migration 5: `templates.kind`, `sessions.kind`, `participants.answers`,
  `answer_log`, `grades`, `submitted_at`.

### Look and feel

- UI restyled to match vLabs Template Studio: slate neutrals, indigo accent,
  Studio dark surfaces, Inter + JetBrains Mono (self-hosted; Poppins removed),
  tighter radii, slate-900 / indigo primary actions, refreshed favicon and app
  icons. New client dependencies: `@fontsource/inter`,
  `@fontsource/jetbrains-mono`, `jszip` (lazy-loaded, only for `.zip` import).

### Upgrading

`deploy/pi/update.sh` as usual — migration 5 runs on start. Existing labs keep
working unchanged; give optional / wrap-up sections a title that says so if
they should not count towards progress.

## 1.5.1 — production readiness audit (2026-10-16)

Full audit of architecture, security, data safety and operations; report in
[docs/PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md). Fixes:

- **Dependencies**: `npm audit fix` (non-breaking) — server had a critical
  (proxy-addr IP spoofing) and a high (compression DoS) advisory that would
  also have failed CI's audit step.
- **Exam seats are device-bound**: joining an exam hands out a resume key;
  rejoining that name without it is refused (`SEAT_TAKEN`). Instructor **Move
  to another device** releases the seat and signs the old device out
  (`SEAT_RELEASED`, participant `token_version`).
- **Exam answer history** moved from a JSON column rewritten on every
  autosave to an append-only `exam_answer_events` table (SD-card wear;
  migration 6 copies existing history).
- **Instructor seat actions**: remove a participant (labs and exams), reopen a
  submitted exam, move an exam seat to another device.
- **Template saves** carry `expected_version`; a save over a colleague's newer
  version is refused (`VERSION_CONFLICT`) instead of discarding it.
- **Countdowns** correct for device clock skew (`server_time` in status,
  content, exam and session detail).
- **Exam autosave**: typed answers awaiting the debounce are flushed with
  `fetch(keepalive)` when the tab is hidden or closed.
- **Error boundary** around the app (no more blank page on a render error).
- **Ops**: added the missing `vlabs-caddy-refresh.service` (boot-time
  certificate IP refresh) to install/update/uninstall and CI; empty
  `CORS_ORIGINS` now means none; presence writes throttled to one per 10 s per
  seat; mutating participant handlers re-read the row before writing; CI also
  runs on `smarty/**` pushes.
- Docs: deployment runbook (instructor accounts, exam day, troubleshooting),
  exam guide, README API.

## 1.6.0 — time allocated per section, class breaks, gated exams

### Time allocated per section (labs and exams)

- A section may declare the **minutes allocated** to it: `> minutes: N` under
  the `#` heading (lab and exam Markdown), `"minutes": N` in JSON, the minutes
  box in Template Studio's section header, or the field under each section in
  the portal's lab / exam editor. Whole minutes 1–600; optional.
- The allocation decides when a participant is spending too long. The monitor
  judges time on the furthest section against it: amber from 80 %, red over
  100 %. Sections without one keep the old 8 / 15 min thresholds. The time
  column reads _spent / allocated_.
- **Average time per section**: the section cards show the allocation and the
  average time of the participants who completed the section. The average is
  marked final once everyone has moved on. It is in the JSON export too
  (`minutes`, `avg_seconds`, `completed_count`, `avg_final`).
- Backward compatible: the lab Markdown parser is unchanged except for this
  one directive, which sits where text under `#` was always discarded. Older
  vLabs and Studio versions ignore it. Templates without it behave as before.

### Class breaks

- **Start break / End break** on the session monitor
  (`POST /sessions/:id/break`). Break time is excluded from every
  section-time figure, including visits that straddle a break and
  participants who join mid-break. Counters resume for everyone when the
  break ends. Participants see a banner. The session countdown is not
  paused. Ending a session ends a running break. Stored as intervals in
  `sessions.breaks` (**migration 7**).

### Exams

- **Sections unlock like a lab's**: a section opens once every question
  before it is answered. Locked sections are not sent and cannot be answered
  (`403`). Participants navigate freely up to the furthest section reached.
- **No review after submitting**: once handed in, the exam API returns no
  questions and no answers, only the answered count.
- Exams are timed per section like labs (`POST /participant/exam/progress`).
  Submitting stops the clock. The monitor gains _Where everyone got to_,
  per-participant section and time against the allocation, and time per
  section in the drawer. Results CSV adds `furthest_section` and
  `time_s<N>_…` columns.

### Upgrading

`deploy/pi/update.sh` as usual — migration 7 runs on start. Running sessions
continue; add `> minutes:` to templates (or set it in the editor) when you
want allocation-based alerts.

## 1.7.0 — exams in Template Studio, section details in the monitor

### Template Studio writes exams

- **New → New Exam** (and **Examples → E. Network Fundamentals Quiz**) puts
  the Studio in exam mode. You get parts with time allocated, and questions of
  every vLabs type (multiple choice, select all, true/false, short and long
  answer) with points and correct answers. The image library and Markdown
  toolbar work as for labs. Lab-only tools (variables, lineage, tokens) are
  hidden.
- Exam outline, search and validation use vLabs' own wording. The
  **Participant Preview** lets you answer the exam, **Check my answers**
  (graded exactly as the server grades) and **Show answer key**.
- **Export** writes the vLabs exam format: `.zip` package (exam + images),
  `.md` (now with `kind: exam` in the front matter) or `.json`
  (`"kind": "exam"`). **Import** reads exams as well as labs. Lab authoring is
  unchanged.
- The Studio carries its own copy of the exam format (a DOM-free script
  block). `client/tests/studioExamParity.test.js` checks that copy against
  the app's modules, so the two cannot drift apart unnoticed.

### vLabs imports Studio exams

- **Templates → Import** (was _Import lab_) accepts a lab or an exam, as
  `.zip`, `.md` or `.json`. Exams are recognised by `kind: exam` or by their
  question types. A package's images are uploaded, and the exam opens in the
  exam editor ready to save. The exam editor's own Import accepts Studio
  `.zip` packages too. Each editor refuses the other kind with a clear
  message.
- Lab parsing is unchanged. Exam Markdown without the new `kind: exam` line
  still imports.

### Monitor: Sections panel and section details

- _Where everyone got to_ is now **Sections**. The cards show only the basics:
  participants on the section, how many completed it, and whether it is
  optional.
- **Click a section** for its details in a side panel, as for participants:
  - time allocated, plus average (_so far_ or _final_), median, fastest and
    slowest times
  - how many took longer than allocated, and how many still on it are nearing
    or over
  - who is on it, who completed it (with their times) and who has not reached
    it; click anyone to open their details
  - labs: per step, hints opened, solutions revealed, and checkpoint results
    with the most common wrong answers
  - exams: the section's questions with answered, correct and to-mark counts;
    click one to mark it
- New endpoint `GET /api/sessions/:id/sections/:index`.

### Upgrading

`deploy/pi/update.sh` as usual. No migration.

## 1.8.0 — the Pi follows you to any network

- **Plug the Pi into a new network and vLabs adapts on its own**, with no
  reboot and no command. `vlabs-caddy-refresh` used to run once at boot; it
  is now a small watcher (`deploy/pi/watch-network.sh`). Whenever the Pi's
  IPv4 addresses change (new network, Wi-Fi switch, new DHCP lease, cable
  pulled) it re-renders the Caddy site list a few seconds later. New addresses
  get certificates from the internal CA, so trusted devices need nothing, and
  stale addresses are dropped. Caddy reloads only when something changed.
- The session monitor shows **where to join** under the room code, e.g.
  _Join at vlabs.local · 10.0.0.23_. It updates when the Pi moves.
  `render-caddy.sh` writes `/run/vlabs-net/addresses.json`, and the new
  instructor endpoint `GET /api/server/addresses` serves it.
- The name Avahi actually publishes is included. If the name is taken on the
  new network, Avahi renames the Pi (`vlabs-2.local`); that name works, and
  the monitor shows it.
- `render-caddy.sh` serialises concurrent runs (`flock`) and only prints
  Caddy's validation log when validation fails.
- Verified with the real Caddy (2.10) and the vLabs server: an address added
  to the interface was served over HTTPS (verified against Caddy's root
  certificate) a few seconds later, with no restart. Removing it dropped it
  from Caddy and from the portal.

### Upgrading

`deploy/pi/update.sh` installs and restarts the watcher. No migration. Wi-Fi
networks still need their password once (`nmcli device wifi connect …`).
NetworkManager then rejoins any remembered network on its own (DEPLOYMENT.md
§1.2a).

## 1.9.0 — checklist sections, submit section, lab authoring, session lengths

- **Instructions & checklist sections in exams** (`# [info] Title`, JSON
  `"type": "info"`). A section of instructions (Markdown, images) and a
  checklist the participant ticks off before the next section unlocks, for
  practical work such as "cable the bench, then have your instructor check
  it". Completion is the participant's own: nothing for the instructor to
  approve in vLabs (checkoffs stay on your own grading sheet). Ticks are saved
  like answers under `"<section>.t<item>"` keys, show in the answer log, and
  are never graded. Supported in the exam editor, Template Studio (builder,
  outline, preview, validation, export) and the Markdown/JSON formats.
- **The submit step is part of the exam** (`# [submit] Title`, JSON
  `"type": "submit"`): always the last section, exactly once. Rename it, add
  text above the button, and choose **Show a review first** (answered count,
  links to unanswered questions and unfinished checklists) or a plain
  **Submit** button (`> review: false`). Exams without one (older templates
  and imports) get the default _Review and submit_; sessions launched before
  this release show it as before.
- **Participant exam UI.** The selected option of a multiple-choice or
  select-all question keeps its highlighted border while the pointer is
  over it (the hover style used to hide the option just clicked). The
  per-question "Saved ✓" is gone (it read as "correct"); one save indicator
  sits in the header instead, as a cloud: _Saving…_, _Saved_, _Not saved,
  retrying_. The confirmation after submitting now reads _Exam completed:
  your exam is complete and your answers have been recorded_ (no answer
  count, no mention of results).
- **New lab** in the portal (**Templates → New lab**), alongside New exam
  and Import (still the main route). The lab editor now changes structure
  too: add, remove and reorder sections and steps, change step types, add
  and remove hints, solutions, checkpoints (exact or pattern, accepted
  answers, capture) and variables. A checkpoint left without an answer is
  flagged before saving.
- **Session length defaults to 8 hours for labs and 1 hour for exams**
  (server default when the launcher sends none, and the launcher follows the
  chosen template's kind until you change it). Lengths are typed as **hours
  and minutes**: the launcher's **Runs for**, section time allocations in the
  lab and exam editors, and Template Studio's section headers. Storage stays
  in minutes.

### Upgrading

`deploy/pi/update.sh` as usual. No migration: existing exam templates gain
the default submit section the next time they are opened and saved, and
running sessions keep working unchanged.

## 1.10.0 — informational steps, minutes per section, exam UI tidy-up

- **"Instructions & checklist" is now "Informational"** everywhere (exam
  editor, Template Studio, guides), and its **+ Informational** button comes
  before **+ Questions**. `# [informational] Title` works as well as
  `# [info] Title`.
- **Informational sections have steps**, like a lab section. Each step has a
  title, instructions and its own checklist, and participants see one step
  at a time (_Step 2 of 3_): **Next step** opens once the step's items are
  ticked, and the next section once every item is. In Markdown `## Step
title` starts a step inside an `# [info]` section; in JSON a section
  carries `"steps": [{ "title", "body", "tasks" }]`. Checklist keys stay
  `"<section>.t<item>"`, items numbered across the steps, so 1.9.0 sections
  (`body` + `tasks` on the section) read as one step with the same keys, in
  templates, imports and running sessions alike.
- **Fixed: unticking a checklist item no longer lets the participant carry
  on.** Ticking every item opened the next section, but unticking one left
  it open. Now an unticked item locks every section after it again (on the
  page at once, and on the server, which refuses answers there) until it is
  ticked once more. Clearing a question's answer still does not re-lock.
- **Section time allocations are minutes again** in the exam and lab editors
  and Template Studio. Hours and minutes are only for a session's length
  (**Runs for** on the launcher).
- **Submit section:** the participant page shows only the template's text
  (the built-in "Once submitted your answers are final…" paragraph is gone),
  and the button says **Submit**.

### Upgrading

`deploy/pi/update.sh` as usual. No migration.

## 1.11.0 — tokens and saved answers in exams

- **Fixed: an informational section opened on its last step.** A section
  whose first steps have no checklist (e.g. a briefing) counted those steps
  as done and skipped straight to the last one. Sections now open on their
  first step, and **Previous** from the next section returns to the last.
- **Exams have tokens, like labs.** `{{ SEAT_ID }}`, `{{ FIRST_NAME }}`,
  `{{ LAST_NAME }}`, `{{ FULL_NAME }}` and the exam's own per-seat
  **variables** (`STORE = 100 + seat`) resolve in every section title, step,
  checklist item, prompt, option and accepted answer, for each participant.
  Grading uses each seat's own accepted answers. Unknown names are rejected
  on save. Exam editor: a **Variables** panel and a seat number on the
  preview. Markdown: `variables:` in the front matter. JSON: top-level
  `"variables"`.
- **Saved answers.** A short-answer question can save the participant's
  answer as a variable (`> capture: NAME`, JSON `"capture"`) for every later
  section to show or accept, like a lab checkpoint capture. Using it in its
  own section or earlier is an error. Changing the answer updates later
  sections.
- **Template Studio** exams get the Variables view, the Token button and
  picker (with saved answers), per-seat preview with the seat and name
  inputs, and the same validation.

### Upgrading

`deploy/pi/update.sh` as usual. No migration: sessions already store
variables, and exams without any behave as before.

## 1.12.0 — sections of mixed steps and questions; pattern answers

- **Sections mix steps and questions.** A section is no longer either
  informational or questions: it is a list of items, and each item declares
  its type: **Informational**, **Checklist**, **Multiple choice**, **Select
  all that apply**, **True / false**, **Short answer** or **Long answer**.
  Participants see a section a page at a time: every step starts a page and
  the questions after it join that page (_Page 1 of 3_, **Next page**). A
  section unlocks the next once its questions are answered and its
  checklists ticked.
- **Short answers match exactly or by a pattern**, like lab checkpoints:
  accepted answers (case and spacing ignored), or a mask such as
  `XXXX.XXXX.XXXX` that any fitting answer passes. A pattern answer is saved
  in the mask's canonical form when it is captured. Short answers can also
  have a placeholder in their box. The mask, like the answers, is never sent
  to participants.
- **Markdown**: `## [info] Title` and `## [checklist] Title` items go in any
  section beside questions; `> pattern:` and `> placeholder:` on short
  answers. **JSON**: sections hold `"items"`, each with a `"type"`.
- **Old templates keep working.** `# [info]` sections in Markdown, and
  `questions` / `info` sections in JSON, stored templates and sessions
  already running, are read as items with the same answer keys. Saving an
  exam writes the new shape.
- **Exam editor, Template Studio and exam guide** updated to match: an
  **Add:** row with every item type, a type menu on each item, exact /
  pattern answers with a live example, and the Studio preview pages and
  self-check grade patterns like vLabs.
- **Dead code removed**: unused helpers in the exam schema, the image store
  and the countdown hook, and the old section-type styles.

### Upgrading

`deploy/pi/update.sh` as usual. No migration: stored exams and running
sessions are read in either shape.

## 1.13.0 — exam seats from a lab

- **An exam can take its seats from a lab session.** When you launch an
  exam, choose **Seats from:** one of your lab sessions (running or ended).
  Anyone who joins the exam under the same name as in that lab gets their
  lab seat number, and so the same per-seat values (`STORE = 100 + seat`).
  Anyone not in the lab gets the next number above the lab's highest seat,
  so they never take a seat someone from the lab still needs. Leaving it on
  **Join order** works as before.
- **Change seat** in the exam monitor's participant panel gives someone
  another seat number: for a typo in their name, or two students with the
  same name. It is refused when the number is taken. Their exam and marking
  switch to the new seat's values at once, and their page reloads within
  about 15 seconds; answers already given are kept.
- The exam monitor shows which lab the seats come from, and tags anyone
  **not in lab** or on a different seat than in the lab (**lab #N**).

### Upgrading

`deploy/pi/update.sh` as usual. Migration 8 adds one column to sessions
(`seat_source_session_id`); existing sessions keep join-order seats.

## 1.13.1 — exam progress fixes

- **Fixed: sections with nothing to answer showed as done before anyone
  opened them.** The section bar at the top of the participant's exam
  ticked off an informational section as soon as it unlocked. A section is
  now ticked only once the participant has opened it and answered or ticked
  everything in it. The server lists the sections each seat has opened
  (`visited_sections`), so this survives a reload.
- **No confirmation pop-up on Submit.** The submit section already lists
  unanswered questions and unfinished checklists, with the template's own
  submit text, so the browser pop-up asking to confirm was removed.

### Upgrading

`deploy/pi/update.sh` as usual. No migration.

## 1.14.0 — one page per exam section

- **Each exam section is one page.** A section's steps and questions are
  now shown one below the other on a single page, and **Next** moves to the
  next section. Steps no longer start a new page, so there is no more
  _Page 1 of 3_, **Next page** or **Previous page**. Links in the review
  open the section and scroll to the question or the first box left to tick.
- The Template Studio's participant preview and the exam guide match.

### Instructor portal

- **Session monitor controls** sit in one bar under the stats: time left
  with **+30 min**, then **Start break** on its own, and on the right a
  single **Download** menu (Results CSV, Answer key, Answer log, JSON for
  exams; Participants CSV, Attempts CSV, JSON for labs) followed by **End
  session** (or **Delete** once it has ended).
- The exam monitor's **Questions** table only appears when the exam has
  hand-marked questions; otherwise there is nothing to mark there.
- **Clicking a row opens it** in Sessions and Templates; the separate view
  and edit buttons are gone (export, delete and archive stay on the row).
- **Admin** replaces the Account and Instructors pages: your password and
  the instructor accounts on one page. The old addresses redirect to it.
- Password fields (sign in, Admin, adding an instructor) have a **show
  password** toggle.

### Upgrading

`deploy/pi/update.sh` as usual. No migration; templates and running
sessions are unchanged.

## 1.14.1 — instructor portal touch-ups

- **Row lines no longer break** in Templates, Sessions and the Admin
  instructor list. When another cell wrapped (a template description, a
  long date), the actions cell's bottom border stopped short of the row's.
- **Sessions list:** the JSON download is gone. Every export, JSON
  included, is under **Download** on the session's monitor.
- **Admin layout:** **Your password** and **Add an instructor** sit side
  by side at the same height, and the instructor list runs full width below
  them. Its password and added columns now use the same text style.

### Upgrading

`deploy/pi/update.sh` as usual. No migration.

## 1.15.0 — Template Studio is the template editor

- **vLabs Template Studio replaces the portal's lab and exam editors.**
  Opening a template, **New lab** or **New exam** edits it in the Studio
  inside the portal. **Save** (or Ctrl+S) stores a new version, images go to
  the portal's library, **History** lists every version with revert, and an
  archived template can be restored from the banner. Unsaved changes are
  flagged and a leave warns first.
- **The offline Studio stays.** **Templates → Offline Studio** downloads it
  as one file (also `docs/vlabs_template_studio.html`) that now works with no
  network at all: styles, fonts, icons and libraries are inside it, nothing
  is loaded from the web. Import its `.zip`, `.md` or `.json` as before.
- **One Studio, vLabs' own rules.** Both are built from `client/studio/` and
  read, write, check and grade through the same shared modules vLabs saves
  with (`shared/`). The Studio's own copy of the lab rules and formula engine
  is gone (formulas no longer run through `new Function`), and the
  Validation Audit ends with vLabs' save check, so **Ready to save** means
  vLabs will accept it. A `.zip` with both `template.json` and `template.md`
  now reads the JSON, as the portal does.
- **Exams and labs work alike in the Studio.** Exams now have the
  **Lineage Matrix** (where each variable and saved answer is used, and
  answers used before they are saved), a **Preview** beside each item, and
  **Progressive Gating** in the participant preview (a section opens once
  every question before it is answered and every checklist ticked, as
  vLabs does). Exam sections are called sections, as in the portal.
- **Documents in the offline Studio.** It keeps every template you work on
  in the browser, images included, under **Documents**; **New**, an example
  or an import starts a new document and the one you had stays listed.
  **Save to file** (Ctrl+S) writes a `.zip` package to disk (back to the same
  file where the browser allows), **Open file** reads one in. When the
  browser will not store a document the header says **Not saved** and a
  message says so, instead of images silently going missing. A draft from an
  older Studio becomes the first document.
- **Images:** SVG is refused everywhere in the Studio, as vLabs refuses it
  (a package's SVG files are left out with a message). The mock image
  generator, which made SVGs, is gone, as are the blank lab / blank exam
  entries duplicated under **Examples** (they are under **New**).
- In the portal the Studio hides what needs the open internet or its own
  storage: AI Polish (kept in the offline Studio), its theme switch (it
  follows the portal's), **Documents** and **New** (use **New lab** / **New
  exam**).
- **Fixed: the sample exam on a fresh install had no variables,** so its
  `{{ SUBNET }}` step could not be saved unchanged.
- Security: the portal's CSP still allows no inline scripts or `eval`; the
  Studio's buttons run through a small interpreter instead of inline
  handlers. `frame-ancestors` is now `'self'` so the portal can frame it.

### Upgrading

`deploy/pi/update.sh` as usual. No migration. `npm run build` (client) also
builds the Studio; CI checks that the committed offline file is current.
