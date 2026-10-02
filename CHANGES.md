# vLabs — change log

Newest entry at the bottom (1.2.0). The first section is the original code
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
