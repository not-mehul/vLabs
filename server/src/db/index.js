import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import config from '../config.js';
import { log } from '../lib/logger.js';
import { flagLegacyOptionalSections } from '../../../shared/lab-progress.js';
import { assignItemIds } from '../../../shared/template-schema.js';

// Ensure the directory holding the SQLite file exists.
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);

// Pragmas: WAL for better read/write concurrency, foreign keys enforced, and a
// busy timeout so a concurrent writer (e.g. a CLI seed) waits instead of failing.
db.pragma('journal_mode = WAL');
// better-sqlite3 is compiled with SQLITE_DEFAULT_WAL_SYNCHRONOUS=1, so every
// open after the first one ran with synchronous=NORMAL: commits sat in the
// WAL without an fsync until the next checkpoint (up to ~1000 pages, which a
// quiet Pi can take days to reach). Pulling the power — the usual way a
// classroom Pi gets "rebooted" — then silently rolled back recent writes such
// as a password change. FULL fsyncs the WAL on every commit; the write volume
// here (progress pings, answers) is far below what an SD card handles.
db.pragma('synchronous = FULL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

/**
 * Fold the WAL back into the main database file. Called after rare but
 * important writes (instructor accounts) so the change also survives someone
 * copying or restoring only `vlabs.sqlite` without its `-wal` sidecar.
 */
export function checkpoint() {
  try {
    db.pragma('wal_checkpoint(PASSIVE)');
  } catch (err) {
    log.warn('db.checkpoint.failed', { err });
  }
}

/* -------------------------------------------------------------------------- */
/*  Schema                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Baseline schema in its CURRENT shape. Idempotent (IF NOT EXISTS) so a fresh
 * database is created directly in the final form; older databases are brought
 * forward by the numbered migrations below.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS instructors (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  username            TEXT NOT NULL UNIQUE,
  password_hash       TEXT NOT NULL,
  -- Bumped on password change; instructor JWTs carry it so old tokens die.
  token_version       INTEGER NOT NULL DEFAULT 0,
  password_changed_at TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Master lab manuals. "content" is a JSON document describing an ordered list
-- of sections, each an ordered list of structured steps (Desk vs Computer)
-- with mustache-style {{PLACEHOLDER}} tokens. "variables" is a JSON array of
-- {name, expression} formulas resolved per-seat by the templating engine.
-- archived_at != NULL hides a template from the default lists and from the
-- "launch session" picker without destroying anything.
CREATE TABLE IF NOT EXISTS templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 'lab' (sections of steps, shared/template-schema.js) or 'exam' (sections
  -- of questions, shared/exam-schema.js). Fixed at creation.
  kind        TEXT NOT NULL DEFAULT 'lab',
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '[]',
  variables   TEXT NOT NULL DEFAULT '[]',
  version     INTEGER NOT NULL DEFAULT 1,
  archived_at TEXT,
  created_by  INTEGER REFERENCES instructors(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Append-only audit trail of template changes. Snapshots the template title,
-- the acting instructor and the action so history survives even if the template
-- or instructor is later deleted (hence no cascading FKs). Immutability is
-- enforced by triggers below — the log can only be INSERTed into.
CREATE TABLE IF NOT EXISTS template_audit (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id         INTEGER,
  template_title      TEXT NOT NULL,
  action              TEXT NOT NULL,           -- created | updated | archived | restored | deleted
  version             INTEGER,
  -- Full JSON snapshot { title, description, content, variables } at this
  -- version, enabling change summaries and revert.
  snapshot            TEXT,
  instructor_id       INTEGER,
  instructor_username TEXT NOT NULL,
  at                  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_template_audit_template ON template_audit(template_id);

-- Enforce append-only: any UPDATE or DELETE on the audit log is rejected.
CREATE TRIGGER IF NOT EXISTS template_audit_no_update
  BEFORE UPDATE ON template_audit
  BEGIN SELECT RAISE(ABORT, 'template_audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS template_audit_no_delete
  BEFORE DELETE ON template_audit
  BEGIN SELECT RAISE(ABORT, 'template_audit is append-only'); END;

-- Live classes. Access is gated by a short-lived 6-digit room_code and an
-- expiry timestamp. Terminating a session flips is_active to 0, which the auth
-- layer treats as immediate invalidation of every participant token.
--
-- A session carries its OWN COPY of the template (title/content/variables at
-- template_version). Participants are rendered from this copy, so editing or
-- even deleting the master template never changes a running class; the
-- instructor can explicitly "push" a newer version into the session.
CREATE TABLE IF NOT EXISTS sessions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  room_code        TEXT NOT NULL,
  title            TEXT NOT NULL DEFAULT '',
  -- Copied from the template at launch: 'lab' | 'exam'.
  kind             TEXT NOT NULL DEFAULT 'lab',
  template_id      INTEGER REFERENCES templates(id) ON DELETE SET NULL,
  instructor_id    INTEGER NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
  template_version INTEGER NOT NULL DEFAULT 1,
  template_title   TEXT NOT NULL DEFAULT '',
  content          TEXT NOT NULL DEFAULT '[]',
  variables        TEXT NOT NULL DEFAULT '[]',
  is_active        INTEGER NOT NULL DEFAULT 1,
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at         TEXT,
  -- Class-wide breaks toggled by the instructor: [{ start, end|null }]. Time
  -- inside a break never counts towards anyone's section time.
  breaks           TEXT NOT NULL DEFAULT '[]',
  -- Exams: the lab session whose seat numbers this exam reuses. A participant
  -- whose name matches someone in that lab gets their lab seat (and so the same
  -- per-seat values). NULL = seats in join order.
  seat_source_session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL
);

-- Only one ACTIVE session may hold a given room_code at a time. Expired /
-- terminated codes are freed for reuse.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_active_code
  ON sessions(room_code) WHERE is_active = 1;

-- A registered participant within a session. Each participant registers with
-- their first + last name and is assigned an ascending seat_number in join
-- order (an exam linked to a lab reuses lab seats instead; see
-- lib/seatSource.js); that number is what the templating engine uses as the
-- seat value.
-- name_key (lowercased "first last") makes rejoin idempotent so a participant
-- who closes their browser can return and resume the same seat and progress.
-- Progress is tracked by SECTION: current_section is the section being viewed,
-- section_entered_at powers time-on-section, joined_at powers total elapsed
-- time, and completed_checkpoints is a JSON array of "<section>.<step>" keys.
CREATE TABLE IF NOT EXISTS participants (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id             INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seat_number            INTEGER NOT NULL,
  first_name             TEXT NOT NULL DEFAULT '',
  last_name              TEXT NOT NULL DEFAULT '',
  name_key               TEXT NOT NULL,
  current_section        INTEGER NOT NULL DEFAULT 0,
  max_section            INTEGER NOT NULL DEFAULT 0,
  completed_checkpoints  TEXT NOT NULL DEFAULT '[]',
  -- JSON object of values captured at pattern checkpoints: { NAME: "canonical" }.
  captured_values        TEXT NOT NULL DEFAULT '{}',
  -- JSON array of checkpoint attempts, newest last, capped:
  --   { k: "section.step", a: "what they typed", ok: 0|1, at: iso }
  checkpoint_log         TEXT NOT NULL DEFAULT '[]',
  -- JSON object of seconds spent per section index (closed visits only; the
  -- open visit is section_entered_at → now): { "0": 412, "1": 90 }
  section_times          TEXT NOT NULL DEFAULT '{}',
  hints_taken            TEXT NOT NULL DEFAULT '[]',
  revealed_solutions     TEXT NOT NULL DEFAULT '[]',
  -- Exam sessions only. answers: { "<section>.<question>": value } (latest
  -- response per question); grades: instructor overrides { key: { correct:
  -- 0|1, by, at } }; submitted_at: when the participant handed the exam in.
  -- (answer_log is the pre-1.5.1 change log, superseded by
  -- exam_answer_events and no longer written.)
  answers                TEXT NOT NULL DEFAULT '{}',
  answer_log             TEXT NOT NULL DEFAULT '[]',
  grades                 TEXT NOT NULL DEFAULT '{}',
  submitted_at           TEXT,
  -- Set by the server the moment every section is cleared (the clock stops);
  -- finished_at is when the participant pressed Finish (may be later/never).
  completed_at           TEXT,
  finished_at            TEXT,
  section_entered_at     TEXT NOT NULL DEFAULT (datetime('now')),
  joined_at              TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at           TEXT NOT NULL DEFAULT (datetime('now')),
  -- Exam seats: SHA-256 of the per-device resume key handed out at join. A
  -- rejoin by name must present the key, so knowing a classmate's name is not
  -- enough to open their exam. NULL = not bound (labs, or released by the
  -- instructor so the next join on any device rebinds the seat).
  resume_hash            TEXT,
  -- Bumped when the instructor releases the seat; participant tokens carry it,
  -- so the previous device is signed out.
  token_version          INTEGER NOT NULL DEFAULT 0,
  UNIQUE (session_id, seat_number),
  UNIQUE (session_id, name_key)
);

-- Exam answer history, one small row per change (append-only). Kept out of the
-- participants row so an autosave writes a few hundred bytes, not the whole
-- history; long answers are logged truncated.
CREATE TABLE IF NOT EXISTS exam_answer_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id  INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  question_key    TEXT NOT NULL,
  response        TEXT NOT NULL DEFAULT '',
  at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exam_answer_events_participant
  ON exam_answer_events(participant_id, question_key);

-- Instance-wide image library for template bodies. Markdown references an
-- image by NAME (![caption](rack.png)); the server rewrites it to
-- /api/images/<id>/<name> at render time, so the random id — not the name —
-- is what participants' browsers fetch. Replacing an image issues a new id.
CREATE TABLE IF NOT EXISTS images (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  width       INTEGER,
  height      INTEGER,
  data        BLOB NOT NULL,
  created_by  INTEGER REFERENCES instructors(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

/* -------------------------------------------------------------------------- */
/*  Migration helpers                                                         */
/* -------------------------------------------------------------------------- */

function tableExists(name) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

function columns(table) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
}

function addColumnIfMissing(table, column, definition) {
  if (!columns(table).includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/** ON DELETE action of a table's FK on `column`, or null when no such FK. */
function fkOnDelete(table, column) {
  const fk = db
    .prepare(`PRAGMA foreign_key_list(${table})`)
    .all()
    .find((f) => f.from === column);
  return fk ? String(fk.on_delete).toUpperCase() : null;
}

/* -------------------------------------------------------------------------- */
/*  Migrations                                                                */
/* -------------------------------------------------------------------------- */
/**
 * Ordered, one-way migrations tracked with `PRAGMA user_version`. Each `up`
 * is written to be safe on BOTH a legacy database and a fresh one created
 * from SCHEMA above (it inspects the current shape and only does work that is
 * needed), so the same path serves every deployment.
 *
 * Adding a migration: append { version: N, name, up } — never edit or reorder
 * past entries once they have shipped.
 */
const MIGRATIONS = [
  {
    version: 1,
    name: 'baseline',
    up() {
      // Pre-migration-framework databases tracked progress per STEP and had a
      // step_events table. Participant rows are ephemeral, session-scoped data,
      // so a table in the old shape is dropped rather than reshaped. This only
      // ever runs once (user_version < 1).
      db.exec('DROP TABLE IF EXISTS step_events;');
      if (tableExists('participants')) {
        const cols = columns('participants');
        if (!cols.includes('current_section') || !cols.includes('max_section')) {
          db.exec('DROP TABLE IF EXISTS participants;');
        }
      }
      db.exec(SCHEMA);
      // Additive columns introduced before the framework existed.
      addColumnIfMissing('participants', 'hints_taken', "TEXT NOT NULL DEFAULT '[]'");
      addColumnIfMissing('participants', 'revealed_solutions', "TEXT NOT NULL DEFAULT '[]'");
      addColumnIfMissing('participants', 'finished_at', 'TEXT');
      addColumnIfMissing('template_audit', 'snapshot', 'TEXT');
    },
  },
  {
    version: 2,
    name: 'template-archive, instructor token_version, session snapshots',
    up() {
      addColumnIfMissing('templates', 'archived_at', 'TEXT');
      addColumnIfMissing('instructors', 'token_version', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing('instructors', 'password_changed_at', 'TEXT');

      // Sessions: template_id used to CASCADE (deleting a template wiped every
      // ended session's analytics) and sessions rendered from the LIVE
      // template. Rebuild the table so template_id is nullable with
      // ON DELETE SET NULL and each session carries its own snapshot.
      const needsRebuild =
        fkOnDelete('sessions', 'template_id') === 'CASCADE' ||
        !columns('sessions').includes('content');
      if (needsRebuild) rebuildSessionsTable();
    },
  },
  {
    version: 3,
    name: 'participant captured_values (pattern checkpoints)',
    up() {
      addColumnIfMissing('participants', 'captured_values', "TEXT NOT NULL DEFAULT '{}'");
    },
  },
  {
    version: 4,
    name: 'image library; participant checkpoint_log, section_times, completed_at',
    up() {
      // The images table itself is created by the SCHEMA re-exec in migrate().
      addColumnIfMissing('participants', 'checkpoint_log', "TEXT NOT NULL DEFAULT '[]'");
      addColumnIfMissing('participants', 'section_times', "TEXT NOT NULL DEFAULT '{}'");
      addColumnIfMissing('participants', 'completed_at', 'TEXT');
      // Participants who already pressed Finish were, by definition, complete.
      db.exec(
        'UPDATE participants SET completed_at = finished_at WHERE completed_at IS NULL AND finished_at IS NOT NULL',
      );
    },
  },
  {
    version: 5,
    name: 'examination mode: template/session kind, participant answers + grades',
    up() {
      addColumnIfMissing('templates', 'kind', "TEXT NOT NULL DEFAULT 'lab'");
      addColumnIfMissing('sessions', 'kind', "TEXT NOT NULL DEFAULT 'lab'");
      addColumnIfMissing('participants', 'answers', "TEXT NOT NULL DEFAULT '{}'");
      addColumnIfMissing('participants', 'answer_log', "TEXT NOT NULL DEFAULT '[]'");
      addColumnIfMissing('participants', 'grades', "TEXT NOT NULL DEFAULT '{}'");
      addColumnIfMissing('participants', 'submitted_at', 'TEXT');
    },
  },
  {
    version: 6,
    name: 'exam answer events table, exam seat resume keys, participant token_version',
    up() {
      addColumnIfMissing('participants', 'resume_hash', 'TEXT');
      addColumnIfMissing('participants', 'token_version', 'INTEGER NOT NULL DEFAULT 0');
      db.exec(`
        CREATE TABLE IF NOT EXISTS exam_answer_events (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          participant_id  INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
          question_key    TEXT NOT NULL,
          response        TEXT NOT NULL DEFAULT '',
          at              TEXT NOT NULL
        );
      `);
      // Carry over any history written by 1.5.0 into the new table.
      const rows = db
        .prepare("SELECT id, answer_log FROM participants WHERE answer_log NOT IN ('', '[]')")
        .all();
      const insert = db.prepare(
        'INSERT INTO exam_answer_events (participant_id, question_key, response, at) VALUES (?, ?, ?, ?)',
      );
      // One transaction: an interrupted upgrade re-runs this cleanly instead of
      // copying the history twice.
      db.transaction(() => {
        for (const r of rows) {
          let entries = [];
          try {
            entries = JSON.parse(r.answer_log);
          } catch {
            entries = [];
          }
          for (const e of Array.isArray(entries) ? entries : []) {
            if (e && e.k) insert.run(r.id, String(e.k), String(e.a ?? ''), String(e.at ?? ''));
          }
        }
        db.exec("UPDATE participants SET answer_log = '[]'");
      })();
    },
  },
  {
    version: 7,
    name: 'session breaks (time-on-section excludes breaks)',
    up() {
      addColumnIfMissing('sessions', 'breaks', "TEXT NOT NULL DEFAULT '[]'");
    },
  },
  {
    version: 8,
    name: 'exam seats from a lab session',
    up() {
      addColumnIfMissing(
        'sessions',
        'seat_source_session_id',
        'INTEGER REFERENCES sessions(id) ON DELETE SET NULL',
      );
    },
  },
  {
    version: 9,
    name: 'exams handed in automatically when the session ends',
    up() {
      addColumnIfMissing('participants', 'auto_submitted', 'INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    version: 10,
    name: 'explicit optional flag on sections (was guessed from the title)',
    up() {
      // Sections whose title marked them optional get `optional: true`, in
      // templates and in session snapshots, so progress stays as it was.
      db.transaction(() => {
        for (const table of ['templates', 'sessions']) {
          const update = db.prepare(`UPDATE ${table} SET content = ? WHERE id = ?`);
          for (const row of db.prepare(`SELECT id, content FROM ${table}`).all()) {
            const next = flagLegacyOptionalSections(row.content);
            if (next) update.run(next, row.id);
          }
        }
      })();
    },
  },
  {
    version: 11,
    name: 'stable ids on sections and items',
    up() {
      // Every template's sections and items get ids; a session still running
      // that template's current version (the same content) gets the same ids,
      // so its next push matches by id. Older sessions match by position.
      const kindOf = (k) => (k === 'exam' ? 'exam' : 'lab');
      const itemsOf = { lab: (sec) => sec.steps, exam: (sec) => sec.items };
      const setTemplate = db.prepare('UPDATE templates SET content = ? WHERE id = ?');
      const sameSessions = db.prepare(
        'SELECT id, content FROM sessions WHERE template_id = ? AND template_version = ?',
      );
      const setSession = db.prepare('UPDATE sessions SET content = ? WHERE id = ?');
      db.transaction(() => {
        for (const t of db.prepare('SELECT id, kind, version, content FROM templates').all()) {
          let content;
          try {
            content = JSON.parse(t.content);
          } catch {
            continue;
          }
          if (!Array.isArray(content)) continue;
          const next = JSON.stringify(
            assignItemIds(content, (sec) => (sec && itemsOf[kindOf(t.kind)](sec)) || []),
          );
          setTemplate.run(next, t.id);
          for (const s of sameSessions.all(t.id, t.version)) {
            if (s.content === t.content) setSession.run(next, s.id);
          }
        }
      })();
    },
  },
];

/**
 * SQLite cannot alter foreign-key actions in place, so this follows the
 * documented 12-step recipe: foreign_keys OFF (outside any transaction),
 * create new table, copy, drop old, rename, foreign_key_check, foreign_keys ON.
 * Dropping (not renaming) the old table matters: a RENAME would rewrite the
 * participants FK to point at the renamed table.
 */
function rebuildSessionsTable() {
  log.info('db.migrate.sessions.rebuild.start');
  db.pragma('foreign_keys = OFF');
  try {
    const run = db.transaction(() => {
      db.exec(`
        CREATE TABLE sessions_new (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          room_code        TEXT NOT NULL,
          title            TEXT NOT NULL DEFAULT '',
          template_id      INTEGER REFERENCES templates(id) ON DELETE SET NULL,
          instructor_id    INTEGER NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
          template_version INTEGER NOT NULL DEFAULT 1,
          template_title   TEXT NOT NULL DEFAULT '',
          content          TEXT NOT NULL DEFAULT '[]',
          variables        TEXT NOT NULL DEFAULT '[]',
          is_active        INTEGER NOT NULL DEFAULT 1,
          expires_at       TEXT NOT NULL,
          created_at       TEXT NOT NULL DEFAULT (datetime('now')),
          ended_at         TEXT
        );
      `);

      const oldCols = new Set(columns('sessions'));
      const rows = db
        .prepare(
          `SELECT s.*, t.title AS t_title, t.content AS t_content, t.variables AS t_variables
             FROM sessions s LEFT JOIN templates t ON t.id = s.template_id`,
        )
        .all();
      const snapshotAt = db.prepare(
        `SELECT snapshot FROM template_audit
          WHERE template_id = ? AND version = ? AND snapshot IS NOT NULL
            AND action IN ('created', 'updated')
          ORDER BY id DESC LIMIT 1`,
      );
      const insert = db.prepare(
        `INSERT INTO sessions_new
           (id, room_code, title, template_id, instructor_id, template_version,
            template_title, content, variables, is_active, expires_at, created_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      for (const r of rows) {
        // Prefer the exact version the session was launched from (audit
        // snapshot); fall back to the live template; finally to empty.
        let title = r.t_title ?? r.title ?? '';
        let content = r.t_content ?? '[]';
        let variables = r.t_variables ?? '[]';
        if (oldCols.has('content') && r.content) content = r.content;
        if (oldCols.has('variables') && r.variables) variables = r.variables;
        if (oldCols.has('template_title') && r.template_title) title = r.template_title;
        const snap = snapshotAt.get(r.template_id, r.template_version ?? 1);
        if (snap && snap.snapshot) {
          try {
            const s = JSON.parse(snap.snapshot);
            if (Array.isArray(s.content)) content = JSON.stringify(s.content);
            if (Array.isArray(s.variables)) variables = JSON.stringify(s.variables);
            if (s.title) title = s.title;
          } catch {
            /* keep the live copy */
          }
        }
        insert.run(
          r.id,
          r.room_code,
          r.title ?? '',
          r.template_id ?? null,
          r.instructor_id,
          r.template_version ?? 1,
          title,
          content,
          variables,
          r.is_active ?? 1,
          r.expires_at,
          r.created_at,
          r.ended_at ?? null,
        );
      }

      db.exec('DROP TABLE sessions;');
      db.exec('ALTER TABLE sessions_new RENAME TO sessions;');
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_active_code ON sessions(room_code) WHERE is_active = 1;',
      );

      const violations = db.pragma('foreign_key_check');
      if (violations.length) {
        throw new Error(
          `foreign_key_check failed after sessions rebuild: ${JSON.stringify(violations)}`,
        );
      }
    });
    run();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  log.info('db.migrate.sessions.rebuild.done');
}

/** Apply every migration newer than the database's user_version. */
export function migrate() {
  const current = db.pragma('user_version', { simple: true });
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    log.info('db.migrate', { version: m.version, name: m.name });
    m.up();
    db.pragma(`user_version = ${m.version}`);
  }
  // Always converge to the baseline shape (no-op when already current); this
  // also creates any brand-new table added to SCHEMA in a later release.
  db.exec(SCHEMA);
}

migrate();

export default db;
