# vLabs codebase audit — 1.18.1

Audited 2026-10-25 at `1fb66ef` (main). Scope: everything in the repository —
`server/`, `shared/`, `client/` (portal and Template Studio), `deploy/pi/`, CI
and docs. [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) is the
operational go-live view; this document is a code-level audit. It covers
weaknesses and bugs, dead and duplicated code, structural improvements and
future expansion. Every finding marked **verified** was reproduced against the
real modules or a booted server (temporary database), not inferred from
reading alone.

## Baseline

| Check                                   | Result                                                                                                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test` (server 106, client 31)      | 137 / 137 pass                                                                                                                                                                                                |
| `npm run lint`, `npm run format:check`  | Clean                                                                                                                                                                                                         |
| `npm audit --omit=dev` — server         | **1 high**: `body-parser` < 1.20.9 (GHSA-27r3-jxmh-p828). CI's audit step (`--audit-level=high`) **will fail on the next run**; the last green `main` run predates the advisory                                |
| `npm audit --omit=dev` — client         | 2 moderate (react-router, known, item 9 of PRODUCTION_READINESS)                                                                                                                                              |
| `npm audit` incl. dev — client          | Also `vite` ≤ 6.4.3 (high, dev server only) and `postcss-selector-parser` (moderate)                                                                                                                          |
| Exam monitor, 100 seats × 40 questions  | `GET /sessions/:id` 36–105 ms, export 67–97 ms (937 KB), `GET /questions/:key` 16–31 ms on a 2.8 GHz Xeon core. Expect roughly 3–5× that on a Pi 4. All of it is synchronous, so it blocks the event loop   |

### What is already strong

Most of the system is in good shape, and none of the findings below are
architectural failures. Strengths:

- The security model: progressive delivery, answers never leave the server,
  identity-keyed rate limits, split JWT audiences, token versions, a strict
  CSP without `unsafe-inline`, and a hand-written formula sandbox.
- One shared rule set (`shared/`) for the server, the portal and the Studio.
- Ordered, idempotent migrations.
- Push-time remapping of work by stable id.
- The hardened systemd unit and a thorough runbook.
- A test suite that exercises the real HTTP surface.

---

## 1. Weaknesses and bugs

Severity: **High**: fix now. **Medium**: fix before the next class or before a
hosted go-live. **Low**: hardening or tidiness.

### High

**H1. CI will go red: `body-parser` advisory in production dependencies.**
`server/package-lock.json` pins `body-parser@1.20.8` (via `express@4.22.3`).
Fix: run `npm audit fix` in `server/`. It only bumps the lockfile to 1.20.9;
`express` stays on 4.x. Then update
[PRODUCTION_READINESS.md:30](PRODUCTION_READINESS.md), which says
"Server: 0".

**H2. A formula that works for seat 1 but fails for another seat passes
validation, then breaks that seat in class.** _Verified._
`validateTemplatePayload` evaluates the variables for seat 1 only
(`shared/validate-template.js:191`). With `V = 10 / (seat - 2)`:

- the template saves fine;
- in a lab, participant #2 gets **HTTP 500 on every `/participant/content`**
  call, so they cannot see the manual at all;
- the instructor preview for seat 2 also returns 500;
- in an exam, `examContext` (`server/src/lib/examSeat.js`) catches the error
  and silently falls back to _no_ variables. The participant then sees
  `⟨missing:V⟩` in prompts, and accepted answers that use `{{ V }}` can never
  match, so **correct answers are graded wrong without any warning**.

The Studio already checks seats 1, 24 and 100 with its own code
(`client/studio/src/studio.js:2135`), so the two validators disagree.

Fix:

1. Server-side, evaluate the formulas for every seat 1…100 (cheap: about 100
   small evaluations) plus a few name shapes, and report the first failing
   seat.
2. At render time, degrade per variable: show `⟨error:V⟩` and log it, rather
   than failing the whole request (labs) or dropping every variable (exams).
3. Make the Studio use the shared check instead of its own copy.

### Medium

**M1. The admin role follows an environment variable on every request: a
config change hands admin to anyone.** _Verified._ `adminId()`
(`server/src/routes/auth.js:52`) resolves the admin as "the account named
`SEED_INSTRUCTOR_USERNAME`, else the oldest". Any signed-in instructor may
create accounts (`POST /auth/instructors`). If an operator later edits
`SEED_INSTRUCTOR_USERNAME` (the docs say the seed variables are only used on
first start), say to `admin`, then any instructor can create an account named
`admin`, become admin, and reset or remove everyone else. Reproduced end to
end: a non-admin creates `admin`, the new account has `is_admin: true`, and
it resets the original instructor's password (200).

Fix: store the role in the database. Migration 13 adds
`instructors.is_admin`, set once from today's rule. `adminId()` then reads
that column; promoting another account becomes an explicit admin action.

**M2. A `%` in an image reference crashes template saves (500) and can crash
rendering.** _Verified._ `imageRefName()` calls `decodeURIComponent` without
a guard (`shared/template-schema.js:571`). `![chart](50%-done.png)` throws
`URIError`, so:

- the save returns **500** (`"Internal server error"` in production) instead
  of a validation message;
- the Studio's audit shows a bare "URI malformed";
- the same call runs in `injectImages` on every participant render, so a
  `{{ VAR }}` that expands to a `%` value 500s the participant view.

Fix: wrap the decode in `try { … } catch { return normaliseImageName(s) }`.

**M3. Image "still in use" checks are wrong in both directions.**
_Verified._ `imageReferences()` (`server/src/lib/images.js:33-40, 149`) does
a `content LIKE '%name%'` substring match:

- **False positive:** deleting `a.png` is refused with 409 because
  `rack-a.png` is used.
- **False negative:** archived templates and ended sessions are not checked,
  so an image used only by an archived template can be deleted (204). After
  a restore, that template cannot be saved again ("not in the image
  library"), and ended sessions' manuals lose the image.

Fix: compute references with the existing `findImageRefs()` (exact base
names) over all templates, plus sessions that are active or recent. Better
still, keep a `template_images(template_id, name)` table, updated on save.

**M4. No guard against a database newer than the code; `update.sh` rollback
relies on that.** `migrate()` (`server/src/db/index.js:607`) skips anything
`<= user_version` and boots happily on a schema from a newer release. When
`update.sh` rolls the code back after a failed start
(`deploy/pi/update.sh:288-297`), the old code runs against the migrated
schema and only prints a note.

Fix:

- Refuse to start when `user_version` is greater than the last migration,
  with a clear FATAL message.
- Have `update.sh` restore the step-1 backup automatically when it rolls back
  across a migration. It can compare `PRAGMA user_version` before and after.

**M5. Monitor polling cost grows with seats × questions × open tabs.**
Every 5 s, the session monitor (`client/src/pages/SessionMonitor.jsx:416`),
the exam monitor (`client/src/components/ExamMonitor.jsx:238`) and each
open drawer re-fetch, including when the tab is hidden. Several requests can
overlap, because `setInterval` does not wait for the previous one.

On the server, `GET /sessions/:id` for an exam re-renders and re-grades every
seat twice (`examParticipantView`, then `examQuestionStats`).
`examParticipantDetail` renders the seat's exam three times.
`GET /questions/:key` grades every question of every seat to return one.
See the benchmark above. better-sqlite3 and grading are synchronous, so on a
Pi this time directly delays participants' autosaves.

Fix, cheapest first:

1. Grade once per participant per request and pass the result around.
2. Pause polling when `document.hidden`, and skip a tick while a request is
   still in flight.
3. Cache each participant's grades by (row `last_seen_at` / answers hash,
   session `template_version`).
4. Longer term, push changes to the monitor (see §4).

**M6. The template history endpoint returns every full snapshot, and the
history never shrinks.** `GET /templates/:id/audit`
(`server/src/routes/templates.js:175`) returns `snapshot` for every version.
A template saved 200 times at 100 KB means a 20 MB response each time the
editor loads its history. `template_audit` is append-only (triggers), so
there is no way to prune it either.

Fix: list versions without snapshots, and fetch one snapshot on demand
(`/audit/:entryId`). Optionally store snapshots compressed, or as diffs.

**M7. Hosted deployments: public images share the per-IP API limit.** `<img>`
requests carry no token, so `/api/images/:id/:name` is keyed by IP under
`apiLimiter` (300 per minute; `server/src/app.js:100`). On the Pi LAN each
device has its own IP, so this is fine. Behind a NAT, a 100-seat class opening
an image-heavy section in the same minute will get 429s for images.

Fix: mount the image route before `apiLimiter`, with its own generous limit.
The random 128-bit id is already the capability.

**M8. Offline Studio "AI Polish": retired models, a plaintext key and an
unescaped HTML sink.** All in `client/studio/src/studio.js`:

- The model lists are hard-coded (`:214-218`, `:2808-2814`). The Claude
  entries are Claude 3.x models (`claude-3-7-sonnet-latest`,
  `claude-3-5-*`, `claude-3-opus-latest`), which are retired. Choosing
  Anthropic fails out of the box, and the Gemini and OpenAI defaults are
  dated too.
- The provider API key is stored in plaintext `localStorage`
  (`:232`). The offline Studio runs from `file://`, and Chromium shares
  `localStorage` across `file://` pages, so any other local HTML file can
  read the key.
- The Gemini key is sent in the URL query (`:2653`), so it ends up in proxy
  logs and history.
- Model ids from a provider or custom endpoint are written into
  `innerHTML` unescaped (`:2824`, `:3406`). A hostile custom endpoint gets
  script into a page that has no CSP.

Fix:

- Fill the lists from each provider's live models endpoint. Anthropic has
  `GET /v1/models`; the code already does this for OpenAI and custom
  endpoints. Default to a current model, such as `claude-sonnet-5-5`.
- Keep the key in `sessionStorage`, or behind an explicit "remember on this
  device" opt-in.
- Send the Gemini key in the `x-goog-api-key` header.
- Build the `<option>` elements with `textContent`.

### Low

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                      | Fix                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| L1  | **Instructor unlock stores a lower-cased capture value** (_verified_). When an exact checkpoint captures a value, `POST …/checkpoints/:key/unlock` stores `checkpointAnswer()` (`server/src/routes/sessions.js:629`). That returns the normalised (lower-cased, space-collapsed) answer, so `Rack-7-A` becomes `rack-7-a`. A participant passing the same checkpoint stores `Rack-7-A`. Later steps then show the wrong text.          | Use the resolved primary answer: `injectVariables(step.checkpoint.answer, context).trim()`. Then remove `checkpointAnswer` |
| L2  | **No size cap on formula strings** (_verified_). Doubling `A1 = A0 + A0` across 25 formulas yields a 256 MB string in 1 ms, because V8 builds it lazily. Rendering or `JSON.stringify` then forces the full allocation, enough to exhaust memory on a Pi. Only instructors can do this, so it is hardening, not an exploit (`shared/templating.js:204`).                                                                            | Cap each value, e.g. 1 000 characters, in `+` and `pad`                                                                   |
| L3  | **Numeric config is not validated.** `MIN_PASSWORD_LENGTH=abc` parses to `NaN`, `pw.length < NaN` is false, so **any password, even 1 character, is accepted** (`server/src/config.js:121`, `routes/auth.js:88`). A non-numeric `EXPIRED_SESSION_GRACE_MINUTES` crashes the boot sweep with a `RangeError`.                                                                                                                         | Parse with bounds and fall back to the default (or FATAL in production)                                                   |
| L4  | **Names are not Unicode-normalised.** `name_key` (`server/src/routes/participant.js:296`, and seats from a lab) lower-cases only. "José" typed precomposed and decomposed gives two seats, and loses the lab-seat match.                                                                                                                                                                                                             | `.normalize('NFC')` before trimming and lower-casing, on both sides                                                       |
| L5  | **Participant tokens can expire before their session does.** `JWT_PARTICIPANT_TTL` defaults to 12 h (`config.js:97`), but a session can run 24 h plus extensions. The participant is signed out; a lab re-joins by name, an exam by resume key.                                                                                                                                                                                  | Make the token expire at the session's `expires_at`, or refresh it from `/status`                                         |
| L6  | **IPv6 /64 bucketing is wrong for compressed addresses** (`server/src/middleware/rateLimit.js:51`). `2001:db8::1` keeps its whole address as the key.                                                                                                                                                                                                                                                                                  | Expand the address before slicing, or use express-rate-limit 8's `ipKeyGenerator`                                         |
| L7  | **Multi-step writes are not atomic.** A template save and its audit row are separate statements (`server/src/routes/templates.js:243-258`; create, archive and delete likewise). On terminate, the closing break is written outside the transaction (`server/src/routes/sessions.js:953`).                                                                                                                                           | Wrap each in `db.transaction`                                                                                             |
| L8  | **Unguarded `JSON.parse` on participant columns** sits next to the safe helpers: `server/src/routes/sessions.js:268`, `server/src/routes/participant.js:128, 373-374, 585, 611, 615`, `server/src/routes/exam.js:121`. One corrupt row breaks a whole monitor.                                                                                                                                                                      | One shared safe-parse helper (see §2)                                                                                     |
| L9  | **Destructive actions leave no trail.** `DELETE /sessions/:id` erases a session's participants, exam answers and marks on one confirm, and is recorded only as a log line.                                                                                                                                                                                                                                                           | Soft-delete (a `deleted_at` column, purged by the retention job) plus an audit row                                       |
| L10 | **CI sanity checks that cannot fail.** `systemd-analyze verify … \|\| true` (`.github/workflows/ci.yml:104`) never fails the build, and `bash -n` only checks syntax. `format:check` skips the Studio sources: 4 files there are not Prettier-clean. It also skips root `*.md` / `*.json`, which `npm run format` rewrites.                                                                                                       | Drop `\|\| true`; add `shellcheck`; align the `format` and `format:check` globs                                           |
| L11 | **Backups.** No `PRAGMA integrity_check` after a snapshot. No restore script. Snapshots are unencrypted on the USB stick or share, and they hold names and exam results. After first login, the seed password stays in plaintext in `/etc/vlabs/vlabs.env`.                                                                                                                                                                         | Integrity check in `backup.js`; `vlabs-cli.sh restore`; optional `age`/`gpg` encryption; installer clears the seed password |
| L12 | **Supply chain on the Pi.** `install.sh` pipes NodeSource's setup script into bash. `update.sh` deploys the tip of a branch and builds the client on the Pi (slow, and a full dev toolchain lives on the classroom box).                                                                                                                                                                                                              | Install Node from the signed apt repo directly; ship tagged release tarballs with a prebuilt `client/dist` and checksums  |

---

## 2. Dead code, stale text and duplication

### Dead code

Each entry below has no production caller. Several have callers only in
tests.

| Where                                                                 | What                                                                                                                                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `shared/template-schema.js:612`                                       | `countSteps`, a second copy. Both callers import the one in `shared/templating.js`                                                                                |
| `shared/templating.js:521-529`                                        | `checkpointAnswer` (comment: "kept for backwards compatibility"; its only caller is the L1 bug) and `isCorrectAnswer` (tests only)                                |
| `shared/template-format.js:198`, `:401`                               | `parseJsonTemplate` and `SAMPLE_MARKDOWN` are used only by tests. The comment says the sample is "offered as a download in the editor"; nothing does that any more |
| `server/src/config.js:152-153`                                        | `config.usingDefaultSecrets` ("kept for backwards compatibility") is never read                                                                                   |
| `server/src/db/index.js:183-186`                                      | `participants.answer_log`, not written since 1.5.1 and emptied by migration 6. It can stay in the table, but drop it from `SCHEMA` for new databases               |
| `server/src/lib/images.js:7`                                          | `export { sniffImage }` re-export; the tests import `imageSniff.js` directly                                                                                      |
| `server/src/routes/sessions.js`                                       | `export { sessionStatus }` and `export DEFAULT_SESSION_MINUTES`, never imported. `complete_count` equals `submitted_count` in the exam detail (`:864`, `:867`)    |
| `server/src/routes/*.js`                                              | 19 handlers are wrapped in `asyncHandler(async …)` without any `await`; only the bcrypt calls in `auth.js` need it. Harmless but misleading                       |
| `client/src/styles.css:3237-3241`                                     | `@media (max-width: 900px) { .split … }`; `.split` is not used anywhere (left over from the old editor)                                                          |

Two scans came back clean, which reflects well on the 1.18.1 clean-up:

- A scan of the Studio's top-level functions found none unreferenced. Its
  lint runs with `no-unused-vars` off, so this needs re-checking by hand.
- Unused CSS is otherwise limited to class names built at runtime
  (`card--${type}`, `pill--${status}`…), which are not dead.

### Stale comments and docs

- `client/src/App.jsx:40-41`: the comment "Unlinked: reached by URL … An
  existing instructor's credentials authorise the account" now sits above the
  `/instructor` dashboard route. It describes the `/instructor/add` page that
  was removed in `e2999ea`.
- `client/src/api.js:205`: a stale JSDoc line ("mark … correct / incorrect")
  sits above the current one. `:239`: `changeSeat` says "Exams:" but works
  for labs too.
- `server/tests/accounts.test.js:98`: the test title still says "or valid
  authorising credentials". The test now asserts the opposite.
- `deploy/pi/install.sh:216`: "portal → Instructors"; the page is **Admin**.
- `README.md` data model: says "`seat_number` (1–100)", but the Change seat
  limit is 999 (`server/src/lib/seatSource.js:19`), and seats from a lab can
  exceed 100.
- `docs/PRODUCTION_READINESS.md:30`: the audit row (H1).

### Duplication worth folding

- **About 12 hand-written "safe JSON parse" helpers:**
  - `safeObject` / `safeArray` in `sessions.js`;
  - `parseObject` / `parseArray` in `examGrading.js`;
  - another `parseObject` and an inline `variablesOf` in `exam.js`;
  - `parseAnswers` in `examSeat.js`;
  - `capturedOf` / `logOf` / `sectionTimesOf` in `participant.js`;
  - `parseList` in `sectionDetail.js`;
  - `parse` in `contentRemap.js`;
  - inline copies in `sectionTiming.js` and `labProgress.js`.

  One `lib/json.js` (`obj(json)`, `arr(json)`) removes them all and fixes L8.
- **Two different functions named `closeOpenVisit`:**
  `server/src/routes/participant.js:162` takes `(p, times, now, breaks)`;
  `server/src/lib/sectionTiming.js:57` takes `(p, now, breaks)`. Keep the
  library one.
- **Two `visitedSections`:** `server/src/lib/labProgress.js:9` returns a
  `Set`; `server/src/routes/exam.js:101` returns a sorted array.
- **`noStore`, `touch` / `touchSeat` and `TOUCH_EVERY_MS`** are copied in
  `participant.js` and `exam.js`.
- **Smaller copies:**
  - `idParam` in `sessions.js` and `templates.js`;
  - `httpErr` (`server/src/lib/images.js:177`) duplicates `httpError`;
  - `fail()` appears in both validators;
  - `randomPassword` and the username rule appear in both `routes/auth.js`
    and `scripts/instructors.js`;
  - `participantOr404` exists, but two handlers re-implement it inline
    (`sessions.js:524`, `:675`).
- **Lab completion is implemented twice:** `markCompleted` in
  `participant.js`, and inline in the instructor unlock
  (`sessions.js:645-651`).
- **Client and server `parseUtc` have drifted.** The client copy
  (`client/src/lib/datetime.js:9`) does not treat zone-less ISO timestamps
  as UTC. Move it to `shared/`.
- **The Studio has a second copy of the variable rules**
  (`client/studio/src/studio.js:2135`). That contradicts its README ("no
  second copy of any rule") and already disagrees with the server (H2).

---

## 3. Structural improvements

**Code organisation**

- `server/src/routes/sessions.js` (1,292 lines) contains the lab analytics:
  `participantView`, `participantDetail` and both export builders. Move
  those into `lib/labAnalytics.js`, next to `examGrading.js`, so the route
  file only parses, authorises and responds.
- The Studio is about 5,000 lines in one concatenated scope (`studio.js`
  alone is 3,909) with unused-variable linting off. Keep the single-file
  output, but move toward real modules bundled by esbuild (already a
  dependency). Lint them normally and add a check that every `data-on-*`
  name resolves.
- Parse each session's `content` and `variables` once per
  `template_version` (a small LRU cache), instead of `JSON.parse` on every
  participant request.
- Verify the JWT once per request. `apiLimiter`'s `identifyToken`
  verifies it, then `requireParticipant` / `requireInstructor` verify it
  again. Put the claims on `req`.
- Add `// @ts-check` with JSDoc types to `shared/`, which three runtimes
  depend on, or convert it to TypeScript. The shapes are already documented
  in comments, so this is mostly mechanical.

**Data layer**

- Add indexes on `sessions(instructor_id)` and `sessions(template_id)`;
  both appear in correlated subqueries on every list call.
- Paginate `GET /sessions?scope=all` and `GET /templates`. Both grow without
  bound.
- If volumes grow, move `checkpoint_log` and `hints_taken` into append-only
  tables, as was done for `exam_answer_events` in 1.5.1. An autosave
  currently rewrites the whole JSON column.

**Testing**

- There are no UI tests at all. Playwright is the natural fit: two to four
  smoke flows (join → lab → checkpoint; exam → submit → mark; Studio
  save/import).
- No test covers 429s from the rate limiters, the CLI scripts, or
  backup → restore.
- Migration from older schemas is verified by hand (PRODUCTION_READINESS,
  1.14.1 → 1.18.1). Commit small fixture databases (schema 1, 5, 8, 11) and
  migrate them in CI.
- Commit the load test that produced the 1.5.1 numbers and run it on demand
  (`workflow_dispatch`), so regressions like M5 show up.

**Dependencies and runtime**

- Planned majors: Express 5, React 19 + react-router 7 (clears the open
  advisory), Vite 7/8 (clears the dev advisory), better-sqlite3 12/13,
  bcryptjs 3, ESLint 10.
- Node 24 is the active LTS; Node 22 leaves LTS in April 2027.
- Add `"private": true` to `server/package.json` so it can never be
  published by accident.

**Systemd hardening**

`vlabs.service` could add `ProtectClock`, `ProtectHostname`,
`ProtectProc=invisible`, `RestrictNamespaces`,
`SystemCallFilter=@system-service`, `UMask=0077` and a `MemoryMax`, so a
runaway process (L2) is killed and restarted rather than starving the Pi.

---

## 4. Future expansions

Ordered roughly by value to a classroom, then to a hosted partner.

**Classroom experience**

1. **Live updates instead of polling.** Server-Sent Events (one-way,
   proxy-friendly, no dependency) for unlocks, breaks, pushes, session end
   and monitor changes. This removes M5's load and the ~15 s lag
   participants see today.
2. **Help queue.** A participant "raise hand" (optionally tied to the
   current step), shown on the monitor with a resolve button. The data is
   already there: the current section, wrong attempts and hints taken.
3. **Instructor-verified checklist items.** A checklist item can only be
   ticked by the instructor (today "nobody approves it"), for bench
   sign-offs.
4. **Join by QR code or link** (room code in the URL). Optional
   pre-registered rosters or per-participant PINs would close the "lab
   seats resume by name" takeover documented as limitation 6.
5. **Resilient participant devices.** The app already has a manifest. Queue
   answers and progress while Wi-Fi drops, and show a clear offline banner.

**Exams**

6. **Integrity features** (limitation 10): question and option shuffling,
   seeded per seat so marking stays stable; per-participant time limits and
   accommodations; focus-loss logging; question pools and per-seat variants
   built on the existing formula engine.
7. **Marking at scale:** rubrics for long answers, bulk "grade by question",
   moderation (a second marker), and releasing results or feedback to
   participants after the session.
8. **AI-assisted marking suggestions** for long answers, always
   human-confirmed. Run server-side, with the key in `vlabs.env`, so the
   portal works under its CSP. The same proxy would let the in-portal
   Studio offer AI Polish, which is hidden today.

**Authoring and analytics**

9. **Template library:** tags or folders, search, a visual diff between
   versions, and stable ids in Markdown export (removes limitation 11).
10. **Cross-session analytics per template:** which checkpoints trip people
    up, wrong-answer clusters, and real time-on-section to calibrate
    `minutes`.
11. **Accessibility and i18n:** a WCAG 2.1 AA pass on the participant pages
    (a dialog component instead of the 17 `window.confirm` / `alert`
    calls), and translatable participant UI strings.

**Hosted and multi-tenant** (DEPLOYMENT §2.5 already lists retention, roles,
branding and organisations)

12. **Data retention and per-person export/delete**, plus soft-deleted
    sessions (L9).
13. **Roles:** course-level ownership, and co-instructors on a session.
    Today only the launching instructor can mark an exam.
14. **LMS integration:** LTI 1.3 launch, roster import, gradebook
    passback (Moodle / Canvas), and CSV roster upload as a stepping stone.
15. **Observability:** a `/metrics` endpoint (request rates, event-loop lag,
    grading time), structured audit rows for session actions, and an
    external uptime check.
16. **Scale-out path:** a Postgres adapter behind the same queries, a
    shared rate-limit store, and stateless app instances. This is only
    needed beyond one VM (PRODUCTION_READINESS item 12).

---

## Suggested order

| When                    | Items                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| Now (small, contained)  | H1, H2, M2, L1, L3, the dead-code and stale-text lists, the JSON-helper consolidation              |
| Before the next class   | M3, M4, M5 steps 1–2, L7, L8, L10                                                                  |
| Before a hosted go-live | M1, M6, M7, L5, L9, L11, L12, rate-limit / UI / migration tests, then §4 items 12–15               |
| Roadmap                 | M8 (or retire AI Polish offline in favour of a server-side proxy), the rest of §3 and §4           |
